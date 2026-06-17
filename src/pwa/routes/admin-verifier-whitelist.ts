/**
 * Admin: Verifier 白名单 + 升降级 + 暂停 + 撤销
 *
 * 由 #1013 Phase 63 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints:
 *   GET    /api/admin/verifier-whitelist                列表
 *   POST   /api/admin/verifier-whitelist                添加（by user_id 或 name）
 *   DELETE /api/admin/verifier-whitelist/:userId        移除
 *   POST   /api/admin/verifier-whitelist/:userId/promote tier 调级 + 配额
 *   POST   /api/admin/verifier-whitelist/:userId/suspend 暂停 N 天
 *   POST   /api/admin/verifier-whitelist/:userId/revoke  撤销（没收 50% + cooldown）
 *
 * 权限：verifier_mgmt（区域 admin 受 scope 限制 — adminCanOperateOn 内部检查）
 *
 * 系统兜底账户保护：is_system=1 的不能 promote / revoke / DELETE
 *
 * 跨域注入：requireAdminPermission ('verifier_mgmt') + adminCanOperateOn + logAdminAction
 *           + INTERNAL_AUDITOR_ID + TIER_QUOTAS + REVOKE_COOLDOWN_DAYS
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminVerifierWhitelistDeps {
  db: Database.Database
  requireVerifierMgmtAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  adminCanOperateOn: (admin: Record<string, unknown>, targetId: string, res: Response) => boolean
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  INTERNAL_AUDITOR_ID: string
  TIER_QUOTAS: Record<string, number>
  REVOKE_COOLDOWN_DAYS: number
}

export function registerAdminVerifierWhitelistRoutes(app: Application, deps: AdminVerifierWhitelistDeps): void {
  // 单写白名单管理站点走 RFC-016 异步 seam;db 保留:revoke 是没收/退质押 + 白名单重写的
  // 多写资金路径,必须原子(db.transaction + 防重复没收 guard),Phase 3 迁 pg 行锁。
  const { db, requireVerifierMgmtAdmin, adminCanOperateOn, logAdminAction, INTERNAL_AUDITOR_ID, TIER_QUOTAS, REVOKE_COOLDOWN_DAYS } = deps

  app.get('/api/admin/verifier-whitelist', async (req, res) => {
    const user = requireVerifierMgmtAdmin(req, res); if (!user) return
    const list = await dbAll(`
      SELECT vw.user_id, vw.added_at, vw.note, u.name, u.role
      FROM verifier_whitelist vw
      JOIN users u ON u.id = vw.user_id
      ORDER BY vw.added_at ASC
    `)
    res.json(list)
  })

  app.post('/api/admin/verifier-whitelist', async (req: Request, res: Response) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const { user_id, name, note } = req.body as { user_id?: string; name?: string; note?: string }
    let targetId = user_id
    if (!targetId && name) {
      const found = await dbOne<{ id: string }>('SELECT id FROM users WHERE name = ?', [name])
      if (!found) return void res.json({ error: `用户「${name}」不存在` })
      targetId = found.id
    }
    if (!targetId) return void res.json({ error: '请提供 user_id 或 name' })
    const target = await dbOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ?', [targetId])
    if (!target) return void res.json({ error: '用户不存在' })
    if (!adminCanOperateOn(admin, targetId, res)) return
    await dbRun('INSERT OR IGNORE INTO verifier_whitelist (user_id, note) VALUES (?, ?)', [targetId, note ?? null])
    res.json({ success: true, user_id: targetId, name: target.name })
  })

  app.delete('/api/admin/verifier-whitelist/:userId', async (req: Request, res: Response) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const targetId = String(req.params.userId)
    if (targetId === INTERNAL_AUDITOR_ID) return void res.json({ error: '内部审核员不可移除' })
    if (!adminCanOperateOn(admin, targetId, res)) return
    await dbRun('DELETE FROM verifier_whitelist WHERE user_id = ?', [targetId])
    res.json({ success: true })
  })

  app.post('/api/admin/verifier-whitelist/:userId/promote', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.userId, res)) return
    const { tier } = req.body
    if (!TIER_QUOTAS[tier]) return void res.json({ error: 'tier 无效' })
    const targetId = req.params.userId
    const wl = await dbOne<{ is_system: number }>("SELECT is_system FROM verifier_whitelist WHERE user_id = ?", [targetId])
    if (!wl) return void res.json({ error: '该用户不在白名单' })
    if (wl.is_system) return void res.json({ error: '系统兜底账户不可手动 promote' })
    await dbRun("UPDATE verifier_whitelist SET tier = ?, daily_quota = ? WHERE user_id = ?",
      [tier, TIER_QUOTAS[tier], targetId])
    logAdminAction(admin.id as string, 'promote_verifier', 'user', targetId, { tier })
    res.json({ success: true })
  })

  app.post('/api/admin/verifier-whitelist/:userId/suspend', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.userId, res)) return
    const { days, reason } = req.body
    const targetId = req.params.userId
    const n = Number(days) > 0 ? Number(days) : 7
    const until = new Date(Date.now() + n * 86400_000).toISOString()
    await dbRun("INSERT OR IGNORE INTO verifier_stats (user_id) VALUES (?)", [targetId])
    await dbRun("UPDATE verifier_stats SET suspended_until = ? WHERE user_id = ?", [until, targetId])
    logAdminAction(admin.id as string, 'suspend_verifier', 'user', targetId, { days: n, reason: reason || null, until })
    res.json({ success: true, suspended_until: until })
  })

  app.post('/api/admin/verifier-whitelist/:userId/revoke', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.userId, res)) return
    const { reason } = req.body
    const targetId = req.params.userId
    // 友好预检查(读);真正的守恒 + 防重复没收门在事务内(重读 active 行 + cooldown guard)。
    const wl = await dbOne<{ is_system: number; stake_amount: number }>("SELECT is_system, stake_amount FROM verifier_whitelist WHERE user_id = ?", [targetId])
    if (!wl) return void res.json({ error: '该用户不在白名单' })
    if (wl.is_system) return void res.json({ error: '系统兜底账户不可撤销' })
    const cooldownUntil = new Date(Date.now() + REVOKE_COOLDOWN_DAYS * 86400_000).toISOString()

    // 原子段:重读 active 行 → 没收 50% + 退还另一半 + DELETE active + INSERT cooldown 一起落。
    // cooldown guard 防并发两次 revoke 重复没收/退款。
    let forfeit = 0
    try {
      forfeit = db.transaction(() => {
        const cur = db.prepare("SELECT is_system, stake_amount, cooldown_until FROM verifier_whitelist WHERE user_id = ?")
          .get(targetId) as { is_system: number; stake_amount: number; cooldown_until: string | null } | undefined
        if (!cur) throw new Error('REVOKE_GONE')
        if (cur.is_system) throw new Error('REVOKE_SYSTEM')
        if (cur.cooldown_until) throw new Error('REVOKE_ALREADY')  // 已在撤销冷却,不再没收一次
        const stakeAmt = cur.stake_amount || 0
        const f = Math.round(stakeAmt * 0.5 * 100) / 100
        db.prepare("UPDATE wallets SET staked = staked - ? WHERE user_id = ?").run(stakeAmt, targetId)
        if (stakeAmt > f) db.prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = ?").run(stakeAmt - f, targetId)
        db.prepare("DELETE FROM verifier_whitelist WHERE user_id = ?").run(targetId)
        db.prepare(`INSERT INTO verifier_whitelist (user_id, note, tier, daily_quota, cooldown_until, is_system) VALUES (?,?,?,?,?,0)`)
          .run(targetId, `撤销冷却中: ${reason || ''}`, 'trial-1', 0, cooldownUntil)
        return f
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'REVOKE_GONE') return void res.json({ error: '该用户不在白名单' })
      if (msg === 'REVOKE_SYSTEM') return void res.json({ error: '系统兜底账户不可撤销' })
      if (msg === 'REVOKE_ALREADY') return void res.json({ error: '该用户已在撤销冷却中' })
      console.error('[verifier revoke tx]', msg)
      return void res.status(500).json({ error: '撤销失败,请重试' })
    }
    logAdminAction(admin.id as string, 'revoke_verifier', 'user', targetId, { reason: reason || null, forfeit, cooldown_until: cooldownUntil })
    res.json({ success: true, cooldown_until: cooldownUntil, forfeit })
  })
}
