/**
 * Profile 身份域 — 角色 + 区域 + 昵称 + handle
 *
 * 由 #1013 Phase 59 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST /api/profile/add-role         自助加角色（仅 buyer/seller；受信角色不可加）
 *   POST /api/profile/switch-role      切换激活角色（防 admin/verifier 切到 buyer/seller）
 *   POST /api/profile/region           区域切换（30 天冷却 + change_log）
 *   POST /api/profile/change-name      改昵称（1-40 字，可重复）
 *   POST /api/profile/change-handle    改 handle（累进冷却：第 N 次需距上次 N×12 月）
 *
 * 边界保留：
 *   - 受信角色（admin/verifier）权责分离：不能 add 任何角色 + 不能切到 buyer/seller
 *   - region 切换冷却 30 天（防规避 MLM 合规 / 薅历史佣金）
 *   - handle 累进冷却：N×12 月（防 anchor prefix 信誉断层）
 *   - handle 统一保留策略：系统/凭证/代理身份 + 推荐口令分隔符
 *
 * 跨域注入：safeRoles, generateId
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { getHandlePolicyIssue, handlePolicyMessage } from '../../handle-policy.js'

const ROLE_LOCKED_ROLES = ['admin', 'verifier']
const VALID_REGIONS = new Set(['china', 'us', 'eu', 'india', 'singapore', 'global_north', 'global'])
const HANDLE_BASE_COOLDOWN_MONTHS = 12

export interface ProfileIdentityDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeRoles: (user: Record<string, unknown> | undefined | null) => string[]
}

export function registerProfileIdentityRoutes(app: Application, deps: ProfileIdentityDeps): void {
  // db 仍保留:用于 add-role 的 db.transaction(re-read+write 防丢更新,better-sqlite3 事务须同步)。
  // 其余站点已走 RFC-016 异步 seam(dbOne/dbRun)。
  const { db, generateId, auth, safeRoles } = deps

  app.post('/api/profile/add-role', (req, res) => {
    const user = auth(req, res); if (!user) return
    const { role } = req.body
    const SELF_SERVE_ROLES = ['buyer', 'seller']
    const currentRoles = safeRoles(user)
    if (currentRoles.some(r => ROLE_LOCKED_ROLES.includes(r))) {
      return void res.json({
        error: '受信角色（admin / verifier）不能自助添加其他角色',
        hint: '权责分离原则：管理员 / 审核员需保持纯净身份，避免利益冲突。如需切换身份，请用其他账号注册。'
      })
    }
    if (!SELF_SERVE_ROLES.includes(role)) {
      return void res.json({
        error: '该角色不能自助添加',
        hint: role === 'verifier' ? '请到「申请审核员」页面提交申请'
            : role === 'admin'    ? '管理员角色仅可由现有管理员授予'
            :                       '请联系管理员申请此角色（logistics / arbitrator）'
      })
    }
    // P2: 事务内 re-read + write 防并发丢失更新
    let finalRoles: string[] = []
    let alreadyHas = false
    try {
      db.transaction(() => {
        const fresh = db.prepare('SELECT roles FROM users WHERE id = ?').get(user.id as string) as { roles: string } | undefined
        const list = safeRoles({ roles: fresh?.roles })
        if (list.includes(role)) { alreadyHas = true; finalRoles = list; return }
        list.push(role)
        db.prepare("UPDATE users SET roles = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(list), user.id as string)
        finalRoles = list
      })()
    } catch (e) {
      return void res.status(500).json({ error: '更新角色失败', detail: (e as Error).message })
    }
    if (alreadyHas) return void res.json({ error: '已拥有该角色' })
    res.json({ success: true, roles: finalRoles })
  })

  app.post('/api/profile/switch-role', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { role } = req.body
    const roles = safeRoles(user)
    if (!roles.includes(role)) return void res.json({ error: '你还没有该角色，请先添加' })
    // 防御：已是 admin/verifier 的用户不能切到 buyer/seller（防遗留多角色账户绕过）。
    //   锁的是【交易面目标】,不是一切切换 —— 此前 `!ROLE_LOCKED_ROLES.includes(role)` 连 verifier→arbitrator/logistics
    //   (同为受信/治理身份,零交易能力)都拦 → 切到审核员后被永久卡死在审核员(梦想者1号案:回不到仲裁员)。
    if (roles.some(r => ROLE_LOCKED_ROLES.includes(r)) && ['buyer', 'seller'].includes(role)) {
      return void res.json({
        error: '受信角色不能切换为 buyer / seller',
        hint: '权责分离原则；如需买卖请用其他账号。'
      })
    }
    await dbRun("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", [role, user.id as string])
    res.json({ success: true, role, roles })
  })

  app.post('/api/profile/region', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const region = String(req.body?.region || '').trim()
    if (!VALID_REGIONS.has(region)) {
      return void res.json({ error: 'region 必须是 china / us / eu / india / singapore / global_north / global 之一' })
    }
    const fromRegion = (user.region as string | null) ?? null
    if (fromRegion === region) {
      return void res.json({ success: true, region, unchanged: true })
    }
    // 30 天冷却（防规避 MLM 合规 + 历史 commission 已按当时 region 快照结算）
    const lastChange = await dbOne<{ created_at: string }>(
      `SELECT created_at FROM region_change_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    , [user.id as string])
    if (lastChange) {
      const sinceMs = Date.now() - new Date(lastChange.created_at + 'Z').getTime()
      const COOLDOWN_MS = 30 * 24 * 3600 * 1000
      if (sinceMs < COOLDOWN_MS) {
        const remainDays = Math.ceil((COOLDOWN_MS - sinceMs) / (24 * 3600_000))
        return void res.status(429).json({
          error: `region 切换 30 天仅 1 次，请 ${remainDays} 天后再试（防止规避区域佣金规则）`,
          retry_after_days: remainDays,
        })
      }
    }
    await dbRun("UPDATE users SET region = ?, updated_at = datetime('now') WHERE id = ?", [region, user.id as string])
    const ip = req.ip || ''
    await dbRun(`INSERT INTO region_change_log (id, user_id, from_region, to_region, ip) VALUES (?,?,?,?,?)`,
      [generateId('rcl'), user.id as string, fromRegion, region, ip || null])
    res.json({ success: true, region })
  })

  app.post('/api/profile/change-name', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { name } = req.body
    if (!name?.trim()) return void res.json({ error: '请填写新昵称' })
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 40) return void res.json({ error: '昵称长度需在 1–40 个字符之间' })
    if (trimmed === user.name) return void res.json({ error: '新昵称与当前相同' })
    // 昵称可重复（唯一标识由 handle / permanent_code 承担）
    await dbRun("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?", [trimmed, user.id as string])
    res.json({ success: true, name: trimmed })
  })

  // 改 handle：累进式冷却 — 第 N 次改需距上次 N × 12 月
  app.post('/api/profile/change-handle', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const raw = String(req.body?.handle ?? '').trim().replace(/^@/, '').toLowerCase()
    if (!raw) return void res.json({ error: '请填写新用户名' })
    const policyIssue = getHandlePolicyIssue(raw)
    if (policyIssue) return void res.json({ error: handlePolicyMessage(policyIssue), error_code: policyIssue })
    if (!/^[a-z0-9._]+$/.test(raw)) return void res.json({ error: '只能用小写字母 / 数字 / . _' })
    if (raw.length < 3 || raw.length > 20) return void res.json({ error: '用户名长度需在 3–20 个字符之间' })
    if (/^[._]|[._]$/.test(raw)) return void res.json({ error: '开头/结尾不能是 . 或 _' })
    if (raw === user.handle) return void res.json({ error: '新用户名与当前相同' })

    // 累进冷却
    let log: { at: string; from: string }[] = []
    try { log = JSON.parse((user.handle_change_log as string) || '[]') } catch {}
    const N = log.length  // 已发生的改名次数
    if (N > 0) {
      const lastChange = log[log.length - 1]
      const lastMs = new Date(lastChange.at.replace(' ', 'T') + (lastChange.at.includes('Z') ? '' : 'Z')).getTime()
      const requiredMonths = N * HANDLE_BASE_COOLDOWN_MONTHS
      const requiredMs = requiredMonths * 30 * 86400_000
      if (Date.now() - lastMs < requiredMs) {
        const remainMs = requiredMs - (Date.now() - lastMs)
        const remainMonths = Math.ceil(remainMs / (30 * 86400_000))
        return void res.json({
          error: `第 ${N + 1} 次改名需距上次至少 ${requiredMonths} 个月，还差约 ${remainMonths} 个月`,
          change_count: N,
          required_months_for_next: requiredMonths,
          remain_months: remainMonths,
        })
      }
    }

    // 唯一性
    const dup = await dbOne("SELECT 1 FROM users WHERE handle = ? AND id != ?", [raw, user.id])
    if (dup) return void res.json({ error: '该用户名已被占用' })

    log.push({ at: new Date().toISOString().slice(0, 19).replace('T', ' '), from: String(user.handle || '') })
    // 全量保留 — 累进式冷却需要完整历史
    await dbRun(`UPDATE users SET handle = ?, handle_last_created_at = datetime('now'), handle_change_log = ?, updated_at = datetime('now') WHERE id = ?`,
      [raw, JSON.stringify(log), user.id as string])
    const nextRequiredMonths = (N + 1) * HANDLE_BASE_COOLDOWN_MONTHS
    res.json({
      success: true,
      handle: raw,
      change_count: N + 1,
      next_change_required_months: nextRequiredMonths,
      hint: `下次改名需距本次至少 ${nextRequiredMonths} 个月`,
    })
  })
}
