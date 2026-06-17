/**
 * Admin 分级管理域
 *
 * 由 #1013 Phase 61 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET    /api/admin/admins                  全部 admin 列表（含 root + regional）
 *   POST   /api/admin/admins                  创建（仅 root）
 *   PATCH  /api/admin/admins/:id/permissions  改权限 / scope（仅 root）
 *   DELETE /api/admin/admins/:id              撤销（仅 root；不能撤自己；至少保留 1 个 root）
 *
 * 权限模型：
 *   - root: 隐式 'all'，权限不可手动调整
 *   - regional: scope (global/region) + 至少一项 admin_permissions
 *   - 普通 admin 视角下 email 字段脱敏为 '***'
 *
 * 受信角色锁：admin 目标用户不能已有 buyer/seller 角色（冲突）
 *
 * 跨域注入：ADMIN_PERMISSIONS / getAdminPermissions / isRootAdmin / requireAdmin / requireRootAdmin
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminAdminsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  requireAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  isRootAdmin: (user: Record<string, unknown>) => boolean
  getAdminPermissions: (user: Record<string, unknown>) => string[]
  ADMIN_PERMISSIONS: readonly string[]
}

export function registerAdminAdminsRoutes(app: Application, deps: AdminAdminsDeps): void {
  const { db, generateId, requireAdmin, requireRootAdmin, isRootAdmin, getAdminPermissions, ADMIN_PERMISSIONS } = deps

  // GET 全部 admin 列表
  app.get('/api/admin/admins', async (req, res) => {
    const me = requireAdmin(req, res); if (!me) return
    const items = await dbAll<Record<string, unknown>>(`
      SELECT id, name, handle, role, admin_type, admin_scope, admin_permissions, email, created_at,
             (SELECT MAX(created_at) FROM admin_audit_log WHERE admin_id = users.id) AS last_action_at
      FROM users
      WHERE role = 'admin' OR (roles IS NOT NULL AND roles LIKE '%admin%')
      ORDER BY admin_type DESC, created_at ASC
    `, [])
    // 普通 admin 视角下 email 脱敏
    const masked = items.map((u) => {
      const enriched = { ...u, admin_permissions: u.admin_type === 'root' ? ['all'] : (() => { try { return JSON.parse((u.admin_permissions as string) || '[]') } catch { return [] } })() }
      return isRootAdmin(me) ? enriched : ({ ...enriched, email: u.email ? '***' : null })
    })
    res.json({
      items: masked,
      my_type: (me.admin_type as string || 'root'),
      my_scope: (me.admin_scope as string || 'global'),
      my_permissions: getAdminPermissions(me),
      available_permissions: ADMIN_PERMISSIONS,
    })
  })

  // POST 创建 admin（仅 root）
  app.post('/api/admin/admins', async (req, res) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const body = req.body as Record<string, unknown>
    const targetUserId = String(body.user_id || '').trim()
    const adminType = String(body.admin_type || 'regional').trim()
    const adminScope = String(body.admin_scope || 'global').trim()
    let adminPerms: string[] = []
    if (adminType === 'regional') {
      const raw = body.admin_permissions
      if (Array.isArray(raw)) adminPerms = raw.map(String).filter(Boolean)
      else if (typeof raw === 'string') adminPerms = raw.split(',').map(s => s.trim()).filter(Boolean)
      const validPerms = new Set(['all', ...ADMIN_PERMISSIONS])
      for (const p of adminPerms) {
        if (!validPerms.has(p)) return void res.json({ error: `权限 "${p}" 无效；支持: all / ${ADMIN_PERMISSIONS.join(' / ')}` })
      }
      if (adminPerms.length === 0) return void res.json({ error: 'regional admin 必须至少授予一项权限' })
    }
    if (!targetUserId) return void res.json({ error: '必须指定 user_id' })
    if (!['root','regional'].includes(adminType)) return void res.json({ error: 'admin_type 无效' })
    if (!['global','china','us','eu','india','singapore','global_north'].includes(adminScope)) return void res.json({ error: 'admin_scope 无效' })
    const target = await dbOne<Record<string, unknown>>(`SELECT id, role, roles, admin_type FROM users WHERE id = ?`, [targetUserId])
    if (!target) return void res.json({ error: '用户不存在' })
    if (target.admin_type) return void res.json({ error: '该用户已是 admin（' + target.admin_type + '）；如需调整请先撤销再重建' })
    // 受信角色锁：目标用户不能已有 buyer/seller
    const targetRoles: string[] = (() => { try { return JSON.parse(target.roles as string || '[]') } catch { return [target.role as string] } })()
    const conflictRoles = targetRoles.filter(r => ['buyer','seller'].includes(r))
    if (conflictRoles.length > 0) {
      return void res.json({ error: `目标用户已有 ${conflictRoles.join('/')} 角色，与 admin 冲突。请先用脚本剥离或换一个纯净账号。` })
    }
    const permsJson = adminType === 'root' ? null : JSON.stringify(adminPerms)
    db.transaction(() => {
      const newRoles = Array.from(new Set([...targetRoles, 'admin']))
      db.prepare(`UPDATE users SET role = 'admin', roles = ?, admin_type = ?, admin_scope = ?, admin_permissions = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(newRoles), adminType, adminScope, permsJson, targetUserId)
      db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
        .run(generateId('audit'), root.id, 'admin_create', 'user', targetUserId, JSON.stringify({ admin_type: adminType, admin_scope: adminScope, admin_permissions: adminPerms }))
    })()
    res.json({ ok: true, user_id: targetUserId, admin_type: adminType, admin_scope: adminScope, admin_permissions: adminPerms })
  })

  // PATCH 更新权限（root only）
  app.patch('/api/admin/admins/:id/permissions', async (req, res) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const targetId = req.params.id
    const body = req.body as Record<string, unknown>
    const adminScope = body.admin_scope ? String(body.admin_scope) : null
    const raw = body.admin_permissions
    let adminPerms: string[] = []
    if (Array.isArray(raw)) adminPerms = raw.map(String).filter(Boolean)
    const validPerms = new Set(['all', ...ADMIN_PERMISSIONS])
    for (const p of adminPerms) if (!validPerms.has(p)) return void res.json({ error: `权限 "${p}" 无效` })
    const target = await dbOne<{ admin_type: string }>(`SELECT id, admin_type FROM users WHERE id = ?`, [targetId])
    if (!target?.admin_type) return void res.json({ error: '该用户不是 admin' })
    if (target.admin_type === 'root') return void res.json({ error: 'root admin 权限不可手动调整（永远是 all）' })
    if (adminPerms.length === 0) return void res.json({ error: '至少保留一项权限' })
    await dbRun(`UPDATE users SET admin_permissions = ?${adminScope ? ', admin_scope = ?' : ''} WHERE id = ?`,
      [JSON.stringify(adminPerms), ...(adminScope ? [adminScope, targetId] : [targetId])])
    await dbRun(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`,
      [generateId('audit'), root.id, 'admin_update_perms', 'user', targetId, JSON.stringify({ admin_permissions: adminPerms, admin_scope: adminScope })])
    res.json({ ok: true, admin_permissions: adminPerms, admin_scope: adminScope })
  })

  // DELETE 撤销 admin（root only；不能撤自己；至少保留 1 个 root）
  app.delete('/api/admin/admins/:id', async (req, res) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const targetId = req.params.id
    if (targetId === root.id) return void res.json({ error: '不能撤销自己' })
    const target = await dbOne<{ id: string; name: string; admin_type: string }>(`SELECT id, name, admin_type FROM users WHERE id = ?`, [targetId])
    if (!target || !target.admin_type) return void res.json({ error: '该用户不是 admin' })
    // 保护：至少保留 1 个 root
    if (target.admin_type === 'root') {
      const rootCount = (await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM users WHERE admin_type = 'root'`, []))!.n
      if (rootCount <= 1) return void res.json({ error: '至少保留 1 个 root admin，不可撤销最后一个' })
    }
    db.transaction(() => {
      const cur = db.prepare(`SELECT roles FROM users WHERE id = ?`).get(targetId) as { roles: string }
      let rolesArr: string[] = []
      try { rolesArr = JSON.parse(cur.roles || '[]') } catch {}
      rolesArr = rolesArr.filter(r => r !== 'admin')
      const newRole = rolesArr[0] || 'buyer'
      db.prepare(`UPDATE users SET role = ?, roles = ?, admin_type = NULL, admin_scope = NULL, updated_at = datetime('now') WHERE id = ?`)
        .run(newRole, JSON.stringify(rolesArr), targetId)
      db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
        .run(generateId('audit'), root.id, 'admin_revoke', 'user', targetId, JSON.stringify({ revoked_type: target.admin_type, new_role: newRole }))
    })()
    res.json({ ok: true })
  })
}
