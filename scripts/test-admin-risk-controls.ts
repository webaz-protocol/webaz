#!/usr/bin/env tsx
/**
 * Admin risk-control boundaries — batch-action authz + root emergency-freeze + admin-revoke cleanup.
 *   用法:npm run test:admin-risk-controls
 *
 * No express / no network listen (avoids tsx EPERM): a fake `app` captures the route handlers, which we
 * invoke directly with mock req/res against a fresh in-memory DB (seam set).
 *
 * Locks: regional users-admin cannot batch suspend/unsuspend another admin (root-only) nor cross-scope
 * users (same-scope OK); root CAN batch suspend/unsuspend admins; emergency-freeze is root-only, can't
 * freeze self or the (only/last) root, and atomically suspends + strips admin_type/scope/permissions +
 * removes the admin role + revokes sessions + audits; DELETE admin clears admin_permissions.
 */
import Database from 'better-sqlite3'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerAdminUsersQueryRoutes } from '../src/pwa/routes/admin-users-query.js'
import { registerAdminAdminsRoutes } from '../src/pwa/routes/admin-admins.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any, idSeq = 0
function freshDb(): void {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, roles TEXT, admin_type TEXT, admin_scope TEXT, admin_permissions TEXT, region TEXT, api_key TEXT, updated_at TEXT)`)
  db.exec(`CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER DEFAULT 0, reason TEXT, suspended_by TEXT, suspended_at TEXT)`)
  db.exec(`CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT, api_key TEXT, revoked_at TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  db.exec(`CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  const u = db.prepare(`INSERT INTO users (id,name,role,roles,admin_type,admin_scope,admin_permissions,region,api_key) VALUES (?,?,?,?,?,?,?,?,?)`)
  u.run('usr_root', 'Root', 'admin', '["admin"]', 'root', 'global', null, null, 'k_root')
  u.run('usr_root2', 'Root2', 'admin', '["admin"]', 'root', 'global', null, null, 'k_root2')
  u.run('usr_reg', 'Reg', 'admin', '["admin"]', 'regional', 'china', '["users"]', 'china', 'k_reg')
  u.run('usr_reg2', 'Reg2', 'admin', '["admin"]', 'regional', 'us', '["users"]', 'us', 'k_reg2')
  u.run('usr_china', 'CnUser', 'buyer', '["buyer"]', null, null, null, 'china', 'k_cn')
  u.run('usr_us', 'UsUser', 'buyer', '["buyer"]', null, null, null, 'us', 'k_us')
  db.prepare(`INSERT INTO user_sessions (id,user_id,api_key) VALUES ('s1','usr_reg2','k_reg2'),('s2','usr_reg2','k_reg2b')`).run()
  setSeamDb(db)
}

// ── fake app: capture handlers by "METHOD path" ──
const routes: Record<string, any> = {}
const app: any = { get: (p: string, h: any) => (routes['GET ' + p] = h), post: (p: string, h: any) => (routes['POST ' + p] = h), delete: (p: string, h: any) => (routes['DELETE ' + p] = h), patch: (p: string, h: any) => (routes['PATCH ' + p] = h) }

const lookup = (req: any) => { const id = req.headers?.['x-actor']; return id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null }
const permsOf = (u: any) => u.admin_type === 'root' ? ['all'] : (() => { try { return JSON.parse(u.admin_permissions || '[]') } catch { return [] } })()
const requireUsersAdmin = (req: Request, res: Response) => { const u: any = lookup(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'not admin' }); return null } const p = permsOf(u); if (!(p.includes('all') || p.includes('users'))) { res.status(403).json({ error: 'no users perm' }); return null } return u }
const requireRootAdmin = (req: Request, res: Response) => { const u: any = lookup(req); if (!u || u.role !== 'admin' || u.admin_type !== 'root') { res.status(403).json({ error: 'root only' }); return null } return u }
const requireAdmin = (req: Request, res: Response) => { const u: any = lookup(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin only' }); return null } return u }
const isRootAdmin = (u: any) => !!u && u.admin_type === 'root'

function register(): void {
  registerAdminUsersQueryRoutes(app, {
    requireUsersAdmin, adminCanOperateOn: () => true, isRootAdmin, isAllowedSponsor: () => false,
    maskApiKey: (k: string) => k, computeLightTags: () => [], getAdminScope: (u: any) => u.admin_scope || 'global',
    getSellerDailyLimit: () => 0, todayStartISO: () => '2026-01-01', broadcastSystemEvent: () => {},
    INTERNAL_AUDITOR_ID: 'sys_auditor',
    logAdminAction: (adminId, action, tt, tid, detail) => db.prepare(`INSERT INTO admin_audit_log (id,admin_id,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?)`).run('aud_' + (idSeq++), adminId, action, tt ?? null, tid ?? null, detail ? JSON.stringify(detail) : null),
  } as any)
  registerAdminAdminsRoutes(app, {
    db, generateId: (p: string) => p + '_' + (idSeq++), requireAdmin, requireRootAdmin, isRootAdmin,
    getAdminPermissions: (u: any) => permsOf(u), ADMIN_PERMISSIONS: ['users', 'content', 'arbitration', 'protocol', 'verifier_mgmt', 'support'],
  } as any)
}

async function call(key: string, actor: string | null, params: any = {}, body: any = {}): Promise<{ status: number; json: any }> {
  const h = routes[key]; if (!h) throw new Error('no route ' + key)
  const req: any = { params, body, query: {}, headers: actor ? { 'x-actor': actor } : {} }
  const res: any = { _s: 200, _j: undefined, status(s: number) { this._s = s; return this }, json(j: any) { this._j = j; return this } }
  await h(req, res)
  return { status: res._s, json: res._j }
}
const suspended = (id: string) => { const m = db.prepare('SELECT suspended FROM user_moderation WHERE user_id = ?').get(id) as any; return !!(m && m.suspended) }
const reasonOf = (r: any, uid: string) => (r.json.results.find((x: any) => x.user_id === uid) || {}).reason

async function main(): Promise<void> {
  const BATCH = 'POST /api/admin/users/batch-action'

  // ── regional users-admin CANNOT batch suspend/unsuspend another admin ──
  { freshDb(); register()
    const r = await call(BATCH, 'usr_reg', {}, { user_ids: ['usr_reg2'], action: 'suspend' })
    ok('regional admin: batch suspend an admin → skipped (root-only)', r.json.results[0].status === 'skipped' && /root/.test(reasonOf(r, 'usr_reg2')) && !suspended('usr_reg2')) }
  { freshDb(); register(); db.prepare(`INSERT INTO user_moderation (user_id,suspended) VALUES ('usr_reg2',1)`).run()
    const r = await call(BATCH, 'usr_reg', {}, { user_ids: ['usr_reg2'], action: 'unsuspend' })
    ok('regional admin: batch unsuspend an admin → skipped (root-only)', r.json.results[0].status === 'skipped' && suspended('usr_reg2')) }

  // ── regional admin: cross-scope user skipped, same-scope user applied ──
  { freshDb(); register()
    const r = await call(BATCH, 'usr_reg', {}, { user_ids: ['usr_us', 'usr_china'], action: 'suspend' })
    ok('regional admin: cross-scope user skipped', r.json.results.find((x: any) => x.user_id === 'usr_us').status === 'skipped' && !suspended('usr_us'))
    ok('regional admin: same-scope user applied (one bad uid does NOT abort the batch)', r.json.results.find((x: any) => x.user_id === 'usr_china').status === 'ok' && suspended('usr_china')) }

  // ── root CAN batch suspend + unsuspend an admin ──
  { freshDb(); register()
    const s = await call(BATCH, 'usr_root', {}, { user_ids: ['usr_reg2'], action: 'suspend' })
    ok('root: batch suspend an admin → ok', s.json.results[0].status === 'ok' && suspended('usr_reg2'))
    const u = await call(BATCH, 'usr_root', {}, { user_ids: ['usr_reg2'], action: 'unsuspend' })
    ok('root: batch unsuspend an admin → ok', u.json.results[0].status === 'ok' && !suspended('usr_reg2'))
    ok('audit only counts applied users', !!db.prepare("SELECT 1 FROM admin_audit_log WHERE action='users_batch_suspend'").get()) }

  // ── emergency-freeze: root-only, not self, not last root, and full strip + revoke ──
  const FREEZE = 'POST /api/admin/admins/:id/emergency-freeze'
  { freshDb(); register()
    const r = await call(FREEZE, 'usr_reg', { id: 'usr_reg2' })
    ok('emergency-freeze: non-root → 403', r.status === 403) }
  { freshDb(); register()
    const r = await call(FREEZE, 'usr_root', { id: 'usr_root' })
    ok('emergency-freeze: cannot freeze self', !!r.json.error && /自己/.test(r.json.error)) }
  { freshDb(); register()
    const r = await call(FREEZE, 'usr_root', { id: 'usr_china' })
    ok('emergency-freeze: target must be admin', !!r.json.error && /admin/.test(r.json.error)) }
  { freshDb(); register()  // only ONE root present → that root can't be frozen (it's self ⇒ last root protected)
    db.prepare("UPDATE users SET admin_type=NULL, admin_scope=NULL WHERE id='usr_root2'").run()
    const r = await call(FREEZE, 'usr_root', { id: 'usr_root' })
    ok('emergency-freeze: the sole/last root is protected (cannot be frozen)', !!r.json.error && db.prepare("SELECT COUNT(1) n FROM users WHERE admin_type='root'").get().n === 1) }
  { freshDb(); register()  // two roots → root A freezes root B (allowed, not last)
    const r = await call(FREEZE, 'usr_root', { id: 'usr_root2' })
    ok('emergency-freeze: ok on a non-last root', r.json.ok === true)
    const t = db.prepare("SELECT role, roles, admin_type, admin_scope, admin_permissions FROM users WHERE id='usr_root2'").get() as any
    ok('  → admin_type/scope/permissions all cleared', t.admin_type === null && t.admin_scope === null && t.admin_permissions === null)
    ok('  → admin role removed (role no longer admin)', t.role !== 'admin' && !JSON.parse(t.roles).includes('admin'))
    ok('  → suspended', suspended('usr_root2'))
    ok('  → has emergency-freeze audit row', !!db.prepare("SELECT 1 FROM admin_audit_log WHERE action='admin_emergency_freeze' AND target_id='usr_root2'").get()) }
  { freshDb(); register()  // sessions revoked
    await call(FREEZE, 'usr_root', { id: 'usr_reg2' })
    const live = db.prepare("SELECT COUNT(1) n FROM user_sessions WHERE user_id='usr_reg2' AND revoked_at IS NULL").get() as any
    ok('emergency-freeze: all active sessions revoked', live.n === 0) }

  // ── DELETE admin clears admin_permissions (+ scope) ──
  { freshDb(); register()
    const r = await call('DELETE /api/admin/admins/:id', 'usr_root', { id: 'usr_reg' })
    ok('DELETE admin → ok', r.json.ok === true)
    const t = db.prepare("SELECT admin_type, admin_scope, admin_permissions FROM users WHERE id='usr_reg'").get() as any
    ok('DELETE admin clears admin_permissions + scope + type', t.admin_type === null && t.admin_scope === null && t.admin_permissions === null) }

  if (fail === 0) {
    console.log(`\n✅ admin risk controls: batch-action per-uid authz (admin target=root-only · cross-scope skipped · same-scope applied · no early abort) · emergency-freeze (root-only · not self · last-root protected · strip admin_type/scope/permissions + role + revoke sessions + audit) · DELETE admin clears admin_permissions\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin risk controls FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
