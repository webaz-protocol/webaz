/**
 * Admin: KYC 审核 + 风控告警/暂停（用户域 moderation）
 *
 * 由 #1013 Phase 68 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints:
 *   GET  /api/admin/kyc/pending              待审 KYC 列表
 *   POST /api/admin/kyc/:user_id/approve     批准 + 站内通知
 *   POST /api/admin/kyc/:user_id/reject      拒绝（需 reason） + 站内通知
 *
 *   GET  /api/admin/risk/suspicious          D-1 风控告警（5 类规则）
 *   POST /api/admin/risk/suspend/:user_id    一键暂停（写 user_moderation）
 *   POST /api/admin/risk/unsuspend/:user_id  解除暂停
 *
 * 权限：users（区域 admin 可在 scope 内操作）
 *
 * 跨域注入：requireUsersAdmin + generateId + authFailures（Map）+ INTERNAL_AUDITOR_ID + broadcastSystemEvent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminModerationDeps {
  db: Database.Database
  requireUsersAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  authFailures: Map<string, { count: number; firstFailAt: number }>
  INTERNAL_AUDITOR_ID: string
  broadcastSystemEvent: (type: string, icon: string, msg: string, refId?: string | null) => void
  // 统一审计:kyc / 风控暂停等改用户状态的动作除了写各自领域表外,也记入 admin_audit_log(#admin/audit 可查)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminModerationRoutes(app: Application, deps: AdminModerationDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbAll/dbRun),不再直接用 deps.db
  const { requireUsersAdmin, generateId, authFailures, INTERNAL_AUDITOR_ID, broadcastSystemEvent, logAdminAction } = deps

  // ─── KYC ──────────────────────────────────────────────────────
  app.get('/api/admin/kyc/pending', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const rows = await dbAll(`
      SELECT k.*, u.name, u.handle, u.role
      FROM kyc_records k JOIN users u ON u.id = k.user_id
      WHERE k.status = 'pending' ORDER BY k.submitted_at ASC LIMIT 100
    `)
    res.json({ items: rows })
  })

  app.post('/api/admin/kyc/:user_id/approve', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    await dbRun(`UPDATE kyc_records SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE user_id = ?`,
      [admin.id, req.params.user_id])
    try { logAdminAction(admin.id as string, 'kyc_approve', 'user', req.params.user_id, {}) } catch (e) { console.error('[kyc_approve audit]', e) }
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
        [generateId('ntf'), req.params.user_id, '✓ KYC 认证通过', '你的实名认证已通过', null])
    } catch {}
    res.json({ success: true })
  })

  app.post('/api/admin/kyc/:user_id/reject', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const reason = String(req.body?.reason || '').slice(0, 200)
    if (!reason) return void res.status(400).json({ error: '需填写拒绝原因' })
    await dbRun(`UPDATE kyc_records SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE user_id = ?`,
      [reason, admin.id, req.params.user_id])
    try { logAdminAction(admin.id as string, 'kyc_reject', 'user', req.params.user_id, { reason }) } catch (e) { console.error('[kyc_reject audit]', e) }
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
        [generateId('ntf'), req.params.user_id, '✗ KYC 认证被拒', reason, null])
    } catch {}
    res.json({ success: true })
  })

  // ─── D-1 风控告警 ────────────────────────────────────────────
  app.get('/api/admin/risk/suspicious', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    // 规则 1: 近 24h 失败 auth > 20 次的 IP
    const ipHits: Array<{ ip: string; count: number; first: number }> = []
    for (const [ip, rec] of authFailures) {
      if (rec.count > 20) ipHits.push({ ip, count: rec.count, first: rec.firstFailAt })
    }
    // 规则 2: 单用户近 24h 5+ / 总额 ≥1000 提现
    const heavyWithdraw = await dbAll<{ user_id: string; cnt: number; total: number }>(`
      SELECT user_id, COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
      FROM withdrawal_requests
      WHERE created_at > datetime('now', '-1 day')
      GROUP BY user_id HAVING COUNT(*) >= 5 OR COALESCE(SUM(amount), 0) >= 1000
      ORDER BY total DESC LIMIT 50
    `)
    // 规则 3: 新注册（<7d）+ completed ≥ 10（疑似刷单）— SQLite HAVING without GROUP BY 不允许
    const fastVolume = await dbAll<Record<string, unknown>>(`
      SELECT * FROM (
        SELECT u.id, u.name, u.handle, u.created_at,
          (SELECT COUNT(*) FROM orders WHERE buyer_id = u.id AND status = 'completed') as completed
        FROM users u
        WHERE u.created_at > datetime('now', '-7 days')
          AND u.id NOT IN ('sys_protocol', ?)
      ) WHERE completed >= 10
      ORDER BY completed DESC LIMIT 50
    `, [INTERNAL_AUDITOR_ID])
    // 规则 4: 30d 内负向 reputation events ≥ 3
    const repFlags = await dbAll<Record<string, unknown>>(`
      SELECT u.id, u.name, u.handle, COUNT(*) as violations
      FROM reputation_events re
      JOIN users u ON u.id = re.user_id
      WHERE re.points < 0 AND re.created_at > datetime('now', '-30 days')
      GROUP BY u.id HAVING COUNT(*) >= 3
      ORDER BY violations DESC LIMIT 50
    `)
    // 规则 5: 已暂停账户列表
    const suspended = await dbAll(`
      SELECT m.user_id, m.reason, m.suspended_at, u.name, u.handle, u.role
      FROM user_moderation m JOIN users u ON u.id = m.user_id
      WHERE m.suspended = 1 ORDER BY m.suspended_at DESC LIMIT 50
    `)
    res.json({
      auth_failure_ips: ipHits,
      heavy_withdrawals: heavyWithdraw,
      fast_volume_new_users: fastVolume,
      repeat_violators: repFlags,
      currently_suspended: suspended,
    })
  })

  app.post('/api/admin/risk/suspend/:user_id', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const { reason } = req.body || {}
    const reasonStr = reason ? String(reason).slice(0, 200) : 'admin 风控暂停'
    await dbRun(`INSERT INTO user_moderation (user_id, suspended, reason, suspended_by, suspended_at)
      VALUES (?, 1, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET suspended = 1, reason = excluded.reason, suspended_by = excluded.suspended_by, suspended_at = excluded.suspended_at`,
      [req.params.user_id, reasonStr, admin.id])
    try { logAdminAction(admin.id as string, 'risk_suspend', 'user', req.params.user_id, { reason: reasonStr }) } catch (e) { console.error('[risk_suspend audit]', e) }
    try { broadcastSystemEvent('user_suspended', '⚠', `用户 ${req.params.user_id} 被风控暂停: ${reasonStr}`, req.params.user_id) } catch {}
    res.json({ success: true })
  })

  app.post('/api/admin/risk/unsuspend/:user_id', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    await dbRun(`UPDATE user_moderation SET suspended = 0 WHERE user_id = ?`, [req.params.user_id])
    try { logAdminAction(admin.id as string, 'risk_unsuspend', 'user', req.params.user_id, {}) } catch (e) { console.error('[risk_unsuspend audit]', e) }
    res.json({ success: true })
  })
}
