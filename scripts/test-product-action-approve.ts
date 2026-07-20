#!/usr/bin/env tsx
/**
 * Ops Passkey-in-flow — Task 5 test: product-action approve+execute (real-human Passkey gate).
 *
 * Real fresh DB + real schema. Proves the approve orchestration: requires a one-time purpose-bound WebAuthn
 * gate token (bare api_key never passes), binds the token to request_id + open_window (no cross-request /
 * cross-decision replay), CAS-marks approved, optionally opens a T1 window, then executes the delete via the
 * Task-4 executor. Also checks the route wiring over HTTP and that 'product_action_approve' is whitelisted in
 * webauthn.ts.
 *
 * Usage: npm run test:product-action-approve
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-paa-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initProductActionApprovalSchema, initProductExternalLinksBaseSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { approveProductActionRequest } = await import('../src/pwa/product-action-approve.js')
const { registerProductActionRoutes } = await import('../src/pwa/routes/product-actions.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const noAnchor = (): void => {}

const db = initDatabase()
initProductActionApprovalSchema(db)
initProductExternalLinksBaseSchema(db)

const alice = generateId('usr'), bob = generateId('usr')
for (const [uid, nm] of [[alice, 'Alice'], [bob, 'Bob']] as const)
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(uid, nm, 'seller', 'key_' + uid)
const mkProduct = (owner: string, status = 'deleted') => { const id = generateId('prd'); db.prepare('INSERT INTO products (id, seller_id, title, description, price, status) VALUES (?,?,?,?,?,?)').run(id, owner, 'T', 'D', 9.9, status); return id }
const mkReq = (owner: string, productId: string, status: string, ttlMin = 30) => {
  const id = generateId('par')
  db.prepare("INSERT INTO product_action_requests (id, owner_id, action, product_id, status, expires_at) VALUES (?,?, 'delete', ?, ?, ?)")
    .run(id, owner, productId, status, new Date(Date.now() + ttlMin * 60_000).toISOString())
  return id
}
const exists = (pid: string) => !!db.prepare('SELECT 1 FROM products WHERE id=?').get(pid)
const reqStatus = (rid: string) => (db.prepare('SELECT status FROM product_action_requests WHERE id=?').get(rid) as { status: string } | undefined)?.status

// Fake gate that models the REAL consumeGateToken contract: single-use, purpose-bound, and it drives the
// domain module's validate(purpose_data) closure with a controllable purpose_data — so we exercise the real
// request_id + open_window binding logic that lives in product-action-approve.ts.
const makeGate = (purposeData: unknown, opts: { hasToken?: boolean; userOk?: boolean } = {}) =>
  (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => {
    if (opts.hasToken === false || !token) return { ok: false, reason: '缺少 X-WebAuthn-Token' }
    if (purpose !== 'product_action_approve') return { ok: false, reason: 'purpose 不匹配' }
    if (opts.userOk === false) return { ok: false, reason: 'token 用户不匹配' }
    if (!validate(purposeData)) return { ok: false, reason: 'token 业务参数不匹配' }
    return { ok: true }
  }

try {
  // 1. happy: pending + in recycle bin + valid gate (no window) → executed
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('1a approve → ok, deleted, approved', res.ok === true && res.deleted_product_id === p && res.approved === true)
    ok('1b product gone + request executed + no window', !exists(p) && reqStatus(r) === 'executed' && res.window_opened === false)
  }
  // 2. open_window: mints a T1 window, still executes via approval (window uses stays 0)
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: true, generateId, consumeGateToken: makeGate({ request_id: r, open_window: true }), retireAnchorsByTarget: noAnchor })
    ok('2a approve+open_window → ok, window_opened + expiry', res.ok === true && res.window_opened === true && typeof res.window_expires_at === 'string')
    const w = db.prepare("SELECT uses FROM action_approval_windows WHERE owner_id=? AND tier='T1' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(alice) as { uses: number }
    ok('2b executed via approval, NOT via the fresh window (uses=0)', !exists(p) && w.uses === 0)
    db.prepare("UPDATE action_approval_windows SET revoked_at=datetime('now') WHERE owner_id=?").run(alice)  // cleanup
  }
  // 3. NO gate token → HUMAN_PRESENCE_REQUIRED 403; request stays pending, product intact, NOT approved
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: undefined, openWindow: false, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }, { hasToken: false }), retireAnchorsByTarget: noAnchor })
    ok('3a no token → HUMAN_PRESENCE_REQUIRED 403', res.ok === false && res.error_code === 'HUMAN_PRESENCE_REQUIRED' && res.http === 403)
    ok('3b request still pending (gate BEFORE approve CAS), product intact', reqStatus(r) === 'pending' && exists(p))
  }
  // 4. gate token bound to a DIFFERENT request_id → validate fails → 403 (no cross-request replay)
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: 'par_other', open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('4 token for another request → 403, product intact', res.ok === false && res.error_code === 'HUMAN_PRESENCE_REQUIRED' && exists(p) && reqStatus(r) === 'pending')
  }
  // 5. open_window decision mismatch: token minted for open_window=false, caller asks open_window=true → 403
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: true, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('5 open_window decision mismatch → 403 (token bound to the decision)', res.ok === false && res.error_code === 'HUMAN_PRESENCE_REQUIRED' && exists(p))
  }
  // 6. NOT_REQUEST_OWNER: bob approves alice's request → 403 (checked before gate)
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: bob, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('6 non-owner → NOT_REQUEST_OWNER 403', res.ok === false && res.error_code === 'NOT_REQUEST_OWNER' && res.http === 403 && exists(p))
  }
  // 7. REQUEST_NOT_FOUND
  ok('7 unknown request → REQUEST_NOT_FOUND 404', approveProductActionRequest(db, { requestId: 'par_ghost', ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: 'par_ghost', open_window: false }), retireAnchorsByTarget: noAnchor }).error_code === 'REQUEST_NOT_FOUND')
  // 8. NOT_PENDING: already executed request → 409
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'executed')
    ok('8 already-executed request → NOT_PENDING 409', approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor }).error_code === 'NOT_PENDING')
  }
  // 9. REQUEST_EXPIRED: past ttl → 410 + reaped, gate never consumed
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending', -1)
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('9 expired → REQUEST_EXPIRED 410 + reaped, product intact', res.error_code === 'REQUEST_EXPIRED' && res.http === 410 && reqStatus(r) === 'expired' && exists(p))
  }
  // 10. precondition fail (product NOT in recycle bin): gate ok, approved, but executor → NOT_IN_RECYCLE_BIN 409, approved:true
  {
    const p = mkProduct(alice, 'active'), r = mkReq(alice, p, 'pending')
    const res = approveProductActionRequest(db, { requestId: r, ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('10a active product → NOT_IN_RECYCLE_BIN 409, approved:true', res.ok === false && res.error_code === 'NOT_IN_RECYCLE_BIN' && res.approved === true)
    ok('10b request is approved (audit trail), product intact', reqStatus(r) === 'approved' && exists(p))
  }
  // 11. sanitized failure: missing requests table → APPROVE_FAILED, no raw SQL
  {
    const Database = (await import('better-sqlite3')).default
    const bare = new Database(':memory:')
    const res = approveProductActionRequest(bare as never, { requestId: 'par_x', ownerId: alice, webauthnToken: 'tok', openWindow: false, generateId, consumeGateToken: makeGate({ request_id: 'par_x', open_window: false }), retireAnchorsByTarget: noAnchor })
    ok('11a missing table → APPROVE_FAILED 500', res.ok === false && res.error_code === 'APPROVE_FAILED' && res.http === 500)
    ok('11b sanitized (no SQL/table text)', !/SQLITE|no such table|product_action_requests|constraint/i.test(String(res.error)))
    bare.close()
  }
  // 12. route wiring over HTTP: POST /api/product-actions/:id/approve delegates to the domain + returns success
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const app = express(); app.use(express.json())
    const auth = (req: express.Request, res: express.Response) => { const u = req.header('x-test-user'); if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } }
    registerProductActionRoutes(app, { db, auth, generateId, consumeGateToken: makeGate({ request_id: r, open_window: false }), retireAnchorsByTarget: noAnchor })
    const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const resp = await fetch(`${base}/api/product-actions/${r}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': alice }, body: JSON.stringify({ webauthn_token: 'tok' }) })
      const j = await resp.json() as Record<string, unknown>
      ok('12a route approve → 200 success + deleted_product_id', resp.status === 200 && j.success === true && j.deleted_product_id === p)
      ok('12b product gone via the route', !exists(p))
      const unauth = await fetch(`${base}/api/product-actions/${r}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      ok('12c no auth → 401', unauth.status === 401)
    } finally { server.close() }
  }
  // 13. webauthn.ts whitelists the new purpose (so /webauthn/authenticate/start will issue the challenge)
  {
    const wa = readFileSync(join(process.cwd(), 'src/pwa/routes/webauthn.ts'), 'utf8')
    ok('13 product_action_approve is in the webauthn purpose whitelist', /'product_action_approve'/.test(wa))
  }

  if (fail > 0) { console.error(`\n❌ product-action-approve FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ product-action-approve (Task 5): real-human Passkey gate (purpose-bound, request_id+open_window binding, bare api_key rejected) · CAS approve · optional T1 window · execute via Task-4 · sanitized failure · route wiring · purpose whitelisted\n  ✅ pass ${pass}`)
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
