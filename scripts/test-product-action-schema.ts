#!/usr/bin/env tsx
/**
 * Ops Passkey-in-flow approval — Task 1 schema test (product_action_requests + action_approval_windows).
 *
 * Real fresh in-memory DB (CHECK constraints are only enforced by a real engine — fake DBs miss them).
 * Proves: tables + columns exist; CHECK on action/status/tier; anti-double-pending unique index; window
 * CAS-consume semantics (uses<max_uses AND unexpired AND not revoked); and that the runtime composition
 * root (applyWebazRuntimeSchema) auto-creates both tables (so MCP/PWA fresh DBs get them).
 *
 * Usage: npm run test:product-action-schema
 */
import Database from 'better-sqlite3'
import { initProductActionApprovalSchema } from '../src/runtime/webaz-schema-helpers.js'
import { applyWebazRuntimeSchema } from '../src/runtime/apply-webaz-runtime-schema.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const throws = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }

const db = new Database(':memory:')
initProductActionApprovalSchema(db)

// ── tables + columns ──
const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(r => r.name))
const parCols = cols('product_action_requests')
ok('T1-1 product_action_requests has the full column set', ['id', 'owner_id', 'action', 'product_id', 'status', 'approve_url', 'approved_at', 'executed_at', 'execution_result', 'created_at', 'expires_at'].every(c => parCols.has(c)))
const awCols = cols('action_approval_windows')
ok('T1-2 action_approval_windows has the full column set', ['id', 'owner_id', 'tier', 'uses', 'max_uses', 'created_at', 'expires_at', 'revoked_at'].every(c => awCols.has(c)))

const future = new Date(Date.now() + 3600_000).toISOString()
const insReq = (id: string, action: string, status: string, product = 'prd_1') =>
  db.prepare('INSERT INTO product_action_requests (id, owner_id, action, product_id, status, expires_at) VALUES (?,?,?,?,?,?)').run(id, 'usr_1', action, product, status, future)

// ── CHECK constraints (real engine) ──
ok('T1-3 action CHECK rejects a non-delete action (this slice is delete-only)', throws(() => insReq('par_x', 'publish', 'pending')))
ok('T1-4 status CHECK rejects an unknown status', throws(() => insReq('par_y', 'delete', 'bogus')))
ok('T1-5 valid delete/pending row inserts', (() => { try { insReq('par_1', 'delete', 'pending'); return true } catch { return false } })())

// ── anti double-pending unique index ──
ok('T1-6 second pending request for same (product,action) is rejected', throws(() => insReq('par_2', 'delete', 'pending', 'prd_1')))
db.prepare("UPDATE product_action_requests SET status='executed', executed_at=? WHERE id='par_1'").run(new Date().toISOString())
ok('T1-7 after the first goes terminal (executed), a re-submit is allowed', (() => { try { insReq('par_3', 'delete', 'pending', 'prd_1'); return true } catch { return false } })())

// ── window tier CHECK + CAS-consume semantics ──
ok('T1-8 tier CHECK rejects T3 (order/funds never opens a window)', throws(() =>
  db.prepare('INSERT INTO action_approval_windows (id, owner_id, tier, max_uses, expires_at) VALUES (?,?,?,?,?)').run('aw_bad', 'usr_1', 'T3', 20, future)))
db.prepare('INSERT INTO action_approval_windows (id, owner_id, tier, uses, max_uses, expires_at) VALUES (?,?,?,?,?,?)').run('aw_1', 'usr_1', 'T1', 0, 2, future)
const cas = (id: string) => db.prepare("UPDATE action_approval_windows SET uses = uses + 1 WHERE id=? AND uses < max_uses AND expires_at > ? AND revoked_at IS NULL").run(id, new Date().toISOString()).changes
ok('T1-9 window CAS-consume increments while under max_uses', cas('aw_1') === 1 && cas('aw_1') === 1)
ok('T1-10 window CAS refuses once max_uses reached', cas('aw_1') === 0)
db.prepare('INSERT INTO action_approval_windows (id, owner_id, tier, uses, max_uses, expires_at) VALUES (?,?,?,?,?,?)').run('aw_exp', 'usr_1', 'T1', 0, 5, new Date(Date.now() - 1000).toISOString())
ok('T1-11 window CAS refuses an expired window', cas('aw_exp') === 0)
db.prepare('INSERT INTO action_approval_windows (id, owner_id, tier, uses, max_uses, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?)').run('aw_rev', 'usr_1', 'T1', 0, 5, future, new Date().toISOString())
ok('T1-12 window CAS refuses a revoked window', cas('aw_rev') === 0)

// ── composition-root wiring (MCP/PWA fresh DB) ──
const db2 = new Database(':memory:')
applyWebazRuntimeSchema(db2)
const hasT = (t: string) => !!db2.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
ok('T1-13 applyWebazRuntimeSchema auto-creates both tables (fresh-DB wiring)', hasT('product_action_requests') && hasT('action_approval_windows'))

if (fail > 0) { console.error(`\n❌ product-action-schema FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product-action-schema: 2 tables + CHECK(action/status/tier) + anti-double-pending + window CAS(限次/过期/作废) + composition-root wiring\n  ✅ pass ${pass}`)
