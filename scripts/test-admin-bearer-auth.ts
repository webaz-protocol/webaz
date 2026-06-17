#!/usr/bin/env tsx
/**
 * resolveBearerProtocolAdmin — strict Bearer→protocol-admin resolver for the money path.
 *   用法:npm run test:admin-bearer-auth
 *
 * 钱路 bearer 决策必须强:仅认 Authorization: Bearer(不认 req.body.api_key)、拒暂停用户、拒已吊销会话、
 * 仍要求 admin 角色 + protocol 权限。任一不满足 → null(→ 路由回落共享 ADMIN_KEY)。绝不返回/泄露 key。
 */
import Database from 'better-sqlite3'
import { resolveBearerProtocolAdmin } from '../src/pwa/admin-bearer-auth.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, roles TEXT, admin_type TEXT, admin_permissions TEXT, api_key TEXT)`)
db.exec(`CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER)`)
db.exec(`CREATE TABLE user_sessions (id TEXT PRIMARY KEY, api_key TEXT, revoked_at TEXT, created_at TEXT DEFAULT (datetime('now')))`)
// root protocol-admin (no session row → not revoked → allowed)
db.prepare("INSERT INTO users (id,role,admin_type,api_key) VALUES ('usr_padmin','admin','root','key_padmin')").run()
// regional admin WITHOUT protocol permission
db.prepare("INSERT INTO users (id,role,admin_type,admin_permissions,api_key) VALUES ('usr_regional','admin','regional','[\"users\"]','key_regional')").run()
// plain buyer
db.prepare("INSERT INTO users (id,role,api_key) VALUES ('usr_buyer','buyer','key_buyer')").run()
// suspended protocol-admin
db.prepare("INSERT INTO users (id,role,admin_type,api_key) VALUES ('usr_susp','admin','root','key_susp')").run()
db.prepare("INSERT INTO user_moderation (user_id,suspended) VALUES ('usr_susp',1)").run()
// protocol-admin with a REVOKED session
db.prepare("INSERT INTO users (id,role,admin_type,api_key) VALUES ('usr_revoked','admin','root','key_revoked')").run()
db.prepare("INSERT INTO user_sessions (id,api_key,revoked_at) VALUES ('ses1','key_revoked',datetime('now'))").run()

// mirrors central hasAdminPermission semantics: root ⇒ all; regional ⇒ admin_permissions includes all|protocol
const isProtocolAdmin = (u: any): boolean => {
  let roles: string[] = []; try { roles = JSON.parse(u.roles || '[]') } catch { roles = [] }
  if (u.role !== 'admin' && !roles.includes('admin')) return false
  if ((u.admin_type || 'root') === 'root') return true
  let perms: string[] = []; try { perms = JSON.parse(u.admin_permissions || '[]') } catch { perms = [] }
  return perms.includes('all') || perms.includes('protocol')
}
const bearer = (key: string) => ({ headers: { authorization: 'Bearer ' + key } })
const resolve = (req: any) => resolveBearerProtocolAdmin(db, req, isProtocolAdmin)

// 1) valid protocol-admin bearer (+ no session row) → resolves to that admin
{ const u = resolve(bearer('key_padmin'))
  ok('valid protocol-admin Bearer (no session row) → resolves', !!u && u.id === 'usr_padmin', JSON.stringify(u)) }

// 2) body api_key only, NO Authorization header → null (never reads req.body.api_key)
{ const u = resolve({ headers: {}, body: { api_key: 'key_padmin' } } as any)
  ok('body api_key only (no Authorization) → null', u === null) }
{ const u = resolve({ headers: { authorization: 'key_padmin' } } as any)   // not "Bearer ..." form
  ok('non-Bearer Authorization → null', u === null) }

// 3) suspended protocol-admin bearer → null
{ const u = resolve(bearer('key_susp'))
  ok('suspended protocol-admin → null', u === null) }

// 4) revoked-session protocol-admin bearer → null
{ const u = resolve(bearer('key_revoked'))
  ok('revoked-session protocol-admin → null', u === null) }

// 5) admin but NO protocol permission → null
{ const u = resolve(bearer('key_regional'))
  ok('regional admin without protocol perm → null', u === null) }

// 6) non-admin → null
{ const u = resolve(bearer('key_buyer'))
  ok('non-admin user → null', u === null) }

// 7) unknown key → null
{ const u = resolve(bearer('key_nope'))
  ok('unknown key → null', u === null) }

if (fail === 0) {
  console.log(`\n✅ resolveBearerProtocolAdmin: Bearer-only(拒 body api_key/非 Bearer)+ 拒暂停 + 拒吊销会话 + 要求 admin+protocol;无 session 行视为未吊销(放行)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ resolveBearerProtocolAdmin FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
