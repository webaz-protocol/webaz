#!/usr/bin/env tsx
/**
 * Ops Passkey-in-flow — Task 2 test: POST /api/product-actions/request (submit, owner-key, zero exec).
 *
 * Real fresh DB + the REAL route over HTTP. Proves: owner submits a pending delete request (approve_url +
 * TTL, row pending); ownership enforced (non-owner 403); product-not-found 404; non-delete 400; missing
 * product_id 400; double-pending 409 (+existing_request_id); unauth 401; the SUBMIT module does NOT import
 * the executor (negative grep, I1); and submit executes NOTHING (product row untouched).
 *
 * Usage: npm run test:product-action-request
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-par-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { registerProductActionRoutes } = await import('../src/pwa/routes/product-actions.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase()
const auth = (req: express.Request, res: express.Response) => {
  const u = req.header('x-test-user'); if (!u) { res.status(401).json({ error: 'unauth' }); return null }
  return { id: u }
}
const app = express(); app.use(express.json())
registerProductActionRoutes(app, { db, auth, generateId })
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const post = (body: Record<string, unknown>, user?: string) =>
  fetch(`${base}/api/product-actions/request`, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) })

try {
  const alice = generateId('usr'), bob = generateId('usr')
  for (const [uid, nm] of [[alice, 'Alice'], [bob, 'Bob']] as const)
    db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(uid, nm, 'seller', 'key_' + uid)
  const mkProduct = (owner: string) => { const id = generateId('prd'); db.prepare('INSERT INTO products (id, seller_id, title, description, price, status) VALUES (?,?,?,?,?,?)').run(id, owner, 'T', 'D', 9.9, 'active'); return id }
  const pAlice = mkProduct(alice), pBob = mkProduct(bob)

  // 1. happy: owner submits delete
  {
    const r = await post({ action: 'delete', product_id: pAlice }, alice); const j = await r.json() as Record<string, unknown>
    ok('1a submit → 200 success + request_id', r.status === 200 && j.success === true && String(j.request_id).startsWith('par_'))
    ok('1b approve_url = /#product-action/<id> + expires_at present', j.approve_url === `/#product-action/${j.request_id}` && typeof j.expires_at === 'string')
    const row = db.prepare('SELECT status, owner_id FROM product_action_requests WHERE id=?').get(j.request_id) as { status: string; owner_id: string }
    ok('1c row is pending + owner-bound', row.status === 'pending' && row.owner_id === alice)
    ok('1d ZERO execution: product still exists, status unchanged', (db.prepare('SELECT status FROM products WHERE id=?').get(pAlice) as { status: string }).status === 'active')
  }
  // 2. ownership
  ok('2 non-owner → 403 NOT_PRODUCT_OWNER', await (async () => { const r = await post({ action: 'delete', product_id: pBob }, alice); return r.status === 403 && ((await r.json()) as { error_code: string }).error_code === 'NOT_PRODUCT_OWNER' })())
  // 3. not found
  ok('3 unknown product → 404 PRODUCT_NOT_FOUND', await (async () => { const r = await post({ action: 'delete', product_id: 'prd_ghost' }, alice); return r.status === 404 && ((await r.json()) as { error_code: string }).error_code === 'PRODUCT_NOT_FOUND' })())
  // 4. bad action
  ok('4 non-delete action → 400 BAD_ACTION', await (async () => { const r = await post({ action: 'publish', product_id: pAlice }, alice); return r.status === 400 && ((await r.json()) as { error_code: string }).error_code === 'BAD_ACTION' })())
  // 5. missing product_id
  ok('5 missing product_id → 400', await (async () => { const r = await post({ action: 'delete' }, alice); return r.status === 400 && ((await r.json()) as { error_code: string }).error_code === 'PRODUCT_ID_REQUIRED' })())
  // 6. double pending (pAlice already has a pending from test 1)
  ok('6 second pending for same (product,delete) → 409 DUPLICATE + existing_request_id', await (async () => {
    const r = await post({ action: 'delete', product_id: pAlice }, alice); const j = await r.json() as Record<string, unknown>
    return r.status === 409 && j.error_code === 'DUPLICATE_ACTION_REQUEST' && typeof j.existing_request_id === 'string'
  })())
  // 7. unauth
  ok('7 no auth → 401', (await post({ action: 'delete', product_id: pAlice })).status === 401)
  // 8. NEGATIVE import guard (I1): submit domain must NOT reach the executor
  const src = readFileSync(join(process.cwd(), 'src/pwa/product-action-request.ts'), 'utf8')
  const imports = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
  ok('8 submit module does NOT import product-action-exec (I1 zero-exec)', !/product-action-exec/.test(imports))

  if (fail > 0) { console.error(`\n❌ product-action-request FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ product-action-request (Task 2): owner-key submit · approve_url+TTL · ownership 403 · 404/400 · double-pending 409 · unauth 401 · zero-exec (no executor import, product untouched)\n  ✅ pass ${pass}`)
} finally {
  server.close(); rmSync(tmpHome, { recursive: true, force: true })
}
