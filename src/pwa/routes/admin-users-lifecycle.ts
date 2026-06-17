/**
 * Admin: 用户生命周期 + 角色 + 权益操作（共 12 endpoints）
 *
 * 由 #1013 Phase 78 从 src/pwa/server.ts 抽出。
 *
 * 11 endpoints:
 *   POST /api/admin/users/:id/l1-share-override     [protocol] L1 分润 0/1/-1
 *   POST /api/admin/users/:id/reset-failed-attempts [users]    清零登录失败
 *   POST /api/admin/users/:id/force-delist-all      [content]  下架该用户全部商品
 *   POST /api/admin/users/:id/suspend               [users/root] 暂停（admin 目标 → root only）
 *   POST /api/admin/users/:id/unsuspend             [users/root] 解封
 *   POST /api/admin/users/:id/grant-role            [users/root] 加角色（admin → root only）
 *   POST /api/admin/users/:id/set-roles             [users/root] 整套设置 + diff audit
 *   POST /api/admin/users/:id/revoke-role           [users/root] 撤销角色（admin → root only）
 *   POST /api/admin/users/:id/set-product-quota     [users]    设置 max_products
 *   POST /api/admin/users/:id/pause-listing         [users]    暂停发新品
 *   POST /api/admin/users/:id/resume-listing        [users]    恢复发新品
 *
 * 权限分层：
 *   - protocol：经济参数（L1 分润）
 *   - users：用户/角色操作（不含 admin 自身的提权）
 *   - root：涉及 admin 角色 grant/revoke/set/suspend → 仅 root
 *   - content：商品强制下架
 *
 * 防自杀：不能撤销自己的 admin / 不能暂停自己
 *
 * 跨域注入：requireAdminPermission 工厂 + requireRootAdmin + adminCanOperateOn + isRootAdmin + safeRoles + logAdminAction + QUOTA_TIERS
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminUsersLifecycleDeps {
  db: Database.Database
  requireUsersAdmin:    (req: Request, res: Response) => Record<string, unknown> | null
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireContentAdmin:  (req: Request, res: Response) => Record<string, unknown> | null
  requireRootAdmin:     (req: Request, res: Response) => Record<string, unknown> | null
  adminCanOperateOn:    (admin: Record<string, unknown>, targetId: string, res: Response) => boolean
  isRootAdmin:          (user: Record<string, unknown>) => boolean
  safeRoles:            (user: Record<string, unknown>) => string[]
  logAdminAction:       (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  QUOTA_TIERS:          number[]
}

export function registerAdminUsersLifecycleRoutes(app: Application, deps: AdminUsersLifecycleDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { requireUsersAdmin, requireProtocolAdmin, requireContentAdmin, requireRootAdmin,
          adminCanOperateOn, isRootAdmin, safeRoles, logAdminAction, QUOTA_TIERS } = deps

  // L1 分享权限 override：0 auto / 1 强允 / -1 强禁
  app.post('/api/admin/users/:id/l1-share-override', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    const { value, note } = req.body
    const v = Number(value)
    if (![0, 1, -1].includes(v)) return void res.json({ error: 'value 必须是 0 / 1 / -1' })
    const target = await dbOne("SELECT id FROM users WHERE id = ?", [req.params.id])
    if (!target) return void res.json({ error: '用户不存在' })
    await dbRun("UPDATE users SET l1_share_override = ?, updated_at = datetime('now') WHERE id = ?", [v, req.params.id])
    logAdminAction(admin.id as string, 'l1_share_override', 'user', req.params.id, { value: v, note: note || null })
    res.json({ success: true, value: v })
  })

  // 解除账号登录锁定：清零失败次数 + 解锁
  app.post('/api/admin/users/:id/reset-failed-attempts', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    await dbRun("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?", [req.params.id])
    logAdminAction(admin.id as string, 'reset_failed_attempts', 'user', req.params.id, {})
    res.json({ success: true })
  })

  app.post('/api/admin/users/:id/force-delist-all', async (req, res) => {
    // P0.5: content 权限 + scope
    const admin = requireContentAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    const { reason } = req.body
    const seller = await dbOne<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = ?", [req.params.id])
    if (!seller) return void res.json({ error: '用户不存在' })
    const result = await dbRun("UPDATE products SET status = 'paused', updated_at = datetime('now') WHERE seller_id = ? AND status = 'active'", [req.params.id])
    logAdminAction(admin.id as string, 'force_delist_all', 'user', req.params.id, { reason: reason || null, count: result.changes })
    res.json({ success: true, count: result.changes })
  })

  // P0.4: users + scope；suspend admin → root only
  app.post('/api/admin/users/:id/suspend', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const targetId = req.params.id
    const { reason } = req.body
    if (targetId === admin.id) return void res.json({ error: '不能暂停自己' })
    const target = await dbOne<{ id: string; role: string; region: string }>("SELECT id, role, region FROM users WHERE id = ?", [targetId])
    if (!target) return void res.json({ error: '用户不存在' })
    if (target.role === 'admin') {
      if (!isRootAdmin(admin)) return void res.status(403).json({ error: '仅 root 可暂停其他 admin（或先撤销其 admin 角色）' })
    }
    if (target.role !== 'admin' && !adminCanOperateOn(admin, targetId, res)) return
    await dbRun(`INSERT INTO user_moderation (user_id, suspended, reason, suspended_by, suspended_at)
                VALUES (?, 1, ?, ?, datetime('now'))
                ON CONFLICT(user_id) DO UPDATE SET
                  suspended    = 1,
                  reason       = excluded.reason,
                  suspended_by = excluded.suspended_by,
                  suspended_at = datetime('now')`,
      [targetId, reason || null, admin.id])
    logAdminAction(admin.id as string, 'suspend_user', 'user', targetId, { reason: reason || null })
    res.json({ success: true })
  })

  app.post('/api/admin/users/:id/unsuspend', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const targetId = req.params.id
    const target = await dbOne<{ id: string; role: string }>("SELECT id, role FROM users WHERE id = ?", [targetId])
    if (!target) return void res.json({ error: '用户不存在' })
    if (target.role === 'admin' && !isRootAdmin(admin)) return void res.status(403).json({ error: '仅 root 可恢复其他 admin' })
    if (target.role !== 'admin' && !adminCanOperateOn(admin, targetId, res)) return
    await dbRun("UPDATE user_moderation SET suspended = 0, suspended_at = NULL WHERE user_id = ?", [targetId])
    logAdminAction(admin.id as string, 'unsuspend_user', 'user', targetId, {})
    res.json({ success: true })
  })

  // P0.1: admin 角色提权必须 root；其他角色需 users + scope
  app.post('/api/admin/users/:id/grant-role', async (req, res) => {
    const { role } = req.body
    const allowed = ['admin', 'verifier', 'arbitrator', 'logistics', 'seller', 'buyer']
    if (!allowed.includes(role)) return void res.json({ error: '角色无效' })
    const admin = role === 'admin' ? requireRootAdmin(req, res) : requireUsersAdmin(req, res)
    if (!admin) return
    const targetId = req.params.id
    if (!adminCanOperateOn(admin, targetId, res)) return
    const target = await dbOne<{ id: string; roles: string }>("SELECT id, roles FROM users WHERE id = ?", [targetId])
    if (!target) return void res.json({ error: '用户不存在' })
    const roles = safeRoles(target as Record<string, unknown>)
    if (roles.includes(role)) return void res.json({ error: '该用户已拥有此角色' })
    roles.push(role)
    await dbRun("UPDATE users SET roles = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify(roles), targetId])
    logAdminAction(admin.id as string, 'grant_role', 'user', targetId, { role })
    res.json({ success: true, roles })
  })

  // P0.2: preview diff，含 admin 变更 → root only
  app.post('/api/admin/users/:id/set-roles', async (req, res) => {
    const { roles } = req.body
    const allowed = ['buyer', 'seller', 'logistics', 'arbitrator', 'verifier', 'admin']
    if (!Array.isArray(roles) || roles.length === 0) return void res.json({ error: '至少保留一个角色' })
    for (const r of roles) {
      if (!allowed.includes(r)) return void res.json({ error: `角色 ${r} 无效` })
    }
    const dedup = Array.from(new Set(roles as string[]))

    const targetId = req.params.id
    const target = await dbOne<{ id: string; role: string; roles: string }>("SELECT id, role, roles FROM users WHERE id = ?", [targetId])
    if (!target) return void res.json({ error: '用户不存在' })

    const oldRoles: string[] = (() => { try { return JSON.parse(target.roles || '[]') } catch { return [] } })()
    const added   = dedup.filter(r => !oldRoles.includes(r))
    const removed = oldRoles.filter(r => !dedup.includes(r))
    const involvesAdmin = added.includes('admin') || removed.includes('admin')

    const admin = involvesAdmin ? requireRootAdmin(req, res) : requireUsersAdmin(req, res)
    if (!admin) return
    if (!adminCanOperateOn(admin, targetId, res)) return

    if (targetId === admin.id && removed.includes('admin')) {
      return void res.json({ error: '不能撤销自己的管理员角色' })
    }
    if (added.length === 0 && removed.length === 0) {
      return void res.json({ error: '角色无变更' })
    }

    const newActiveRole = dedup.includes(target.role) ? target.role : dedup[0]
    await dbRun("UPDATE users SET role = ?, roles = ?, updated_at = datetime('now') WHERE id = ?",
      [newActiveRole, JSON.stringify(dedup), targetId])

    if (added.length)   logAdminAction(admin.id as string, 'grant_role_batch',  'user', targetId, { roles: added })
    if (removed.length) logAdminAction(admin.id as string, 'revoke_role_batch', 'user', targetId, { roles: removed })

    res.json({ success: true, roles: dedup, added, removed })
  })

  // P0.3: revoke admin → root only
  app.post('/api/admin/users/:id/revoke-role', async (req, res) => {
    const { role } = req.body
    const admin = role === 'admin' ? requireRootAdmin(req, res) : requireUsersAdmin(req, res)
    if (!admin) return
    const targetId = req.params.id
    if (!adminCanOperateOn(admin, targetId, res)) return
    if (targetId === admin.id && role === 'admin') return void res.json({ error: '不能撤销自己的管理员角色（防自杀）' })
    const target = await dbOne<{ id: string; role: string; roles: string }>("SELECT id, role, roles FROM users WHERE id = ?", [targetId])
    if (!target) return void res.json({ error: '用户不存在' })
    const roles = safeRoles(target as Record<string, unknown>).filter(r => r !== role)
    if (roles.length === 0) return void res.json({ error: '用户至少保留一个角色' })
    const newActiveRole = target.role === role ? roles[0] : target.role
    await dbRun("UPDATE users SET role = ?, roles = ?, updated_at = datetime('now') WHERE id = ?",
      [newActiveRole, JSON.stringify(roles), targetId])
    logAdminAction(admin.id as string, 'revoke_role', 'user', targetId, { role })
    res.json({ success: true, roles })
  })

  app.post('/api/admin/users/:id/set-product-quota', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    const { max_products } = req.body
    const n = Number(max_products)
    if (!QUOTA_TIERS.includes(n)) return void res.json({ error: `配额应为 ${QUOTA_TIERS.join(' / ')} 之一` })
    const target = await dbOne("SELECT id FROM users WHERE id = ?", [req.params.id])
    if (!target) return void res.json({ error: '用户不存在' })
    await dbRun("UPDATE users SET max_products = ?, updated_at = datetime('now') WHERE id = ?", [n, req.params.id])
    logAdminAction(admin.id as string, 'set_product_quota', 'user', req.params.id, { quota: n })
    res.json({ success: true, max_products: n })
  })

  app.post('/api/admin/users/:id/pause-listing', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    const { reason } = req.body
    if (!reason?.trim()) return void res.json({ error: '请填写暂停原因' })
    await dbRun(`UPDATE users SET listing_paused = 1, listing_paused_reason = ?, listing_paused_by = ?, listing_paused_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [reason.trim(), admin.id, req.params.id])
    logAdminAction(admin.id as string, 'pause_listing', 'user', req.params.id, { reason: reason.trim() })
    res.json({ success: true })
  })

  app.post('/api/admin/users/:id/resume-listing', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    await dbRun(`UPDATE users SET listing_paused = 0, listing_paused_reason = NULL, updated_at = datetime('now') WHERE id = ?`, [req.params.id])
    logAdminAction(admin.id as string, 'resume_listing', 'user', req.params.id, {})
    res.json({ success: true })
  })
}
