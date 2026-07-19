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
const { submitProductActionRequest } = await import('../src/pwa/product-action-request.js')
const Database = (await import('better-sqlite3')).default

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

  // 9. an EXPIRED pending must NOT permanently block resubmit — it is lazily reaped, new request succeeds (Codex R1)
  {
    const pExp = mkProduct(alice)
    db.prepare("INSERT INTO product_action_requests (id, owner_id, action, product_id, status, expires_at) VALUES (?,?,?,?, 'pending', ?)")
      .run('par_stale', alice, 'delete', pExp, new Date(Date.now() - 60_000).toISOString())   // already expired
    const r = await post({ action: 'delete', product_id: pExp }, alice)
    ok('9a resubmit over an EXPIRED pending → 200 (stale reaped)', r.status === 200 && ((await r.json()) as { success: boolean }).success === true)
    ok('9b the stale pending was reaped to status=expired', (db.prepare("SELECT status FROM product_action_requests WHERE id='par_stale'").get() as { status: string }).status === 'expired')
  }
  // 10. REAL db failure → sanitized REQUEST_FAILED, NO raw SQL text escapes (Codex R2: exercise an actual failure)
  {
    const bare = new Database(':memory:')   // products exists but product_action_requests deliberately absent → insert throws
    bare.exec("CREATE TABLE products (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT, description TEXT, price REAL, status TEXT)")
    bare.prepare("INSERT INTO products (id, seller_id, title, description, price, status) VALUES ('prd_bare','u','T','D',1,'active')").run()
    const r = submitProductActionRequest(bare, { ownerId: 'u', action: 'delete', productId: 'prd_bare', generateId })
    ok('10a real db failure → REQUEST_FAILED (no throw escapes)', r.ok === false && r.error_code === 'REQUEST_FAILED' && r.http === 500)
    ok('10b sanitized error carries NO raw SQL/constraint/table text', !/SQLITE|no such table|constraint|product_action_requests/i.test(String(r.error)))
    bare.close()
  }
  // 11. a NON-unique transient (SQLITE_BUSY) on INSERT must NOT be masked as 409 even though a dup exists (Codex R3).
  //   A real (product,action) dup always trips ux_par_active (UNIQUE) first, so the mis-report only bites on a
  //   non-constraint error; force it deterministically via a db proxy that throws SQLITE_BUSY on the INSERT while
  //   a discoverable dup row exists. Old code would 409; the code-gated fix must return REQUEST_FAILED.
  {
    const pB = mkProduct(alice)
    db.prepare("INSERT INTO product_action_requests (id, owner_id, action, product_id, status, expires_at) VALUES ('par_busy_dup', ?, 'delete', ?, 'pending', ?)")
      .run(alice, pB, new Date(Date.now() + 60_000).toISOString())   // discoverable active dup for (pB, delete)
    const proxy = new Proxy(db, {
      get(t: any, p: string) {
        if (p === 'prepare') return (sql: string) => {
          if (/INSERT INTO product_action_requests/.test(sql)) return { run: () => { const e: any = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e } }
          return t.prepare(sql)
        }
        if (p === 'transaction') return (fn: () => unknown) => t.transaction(fn)
        const v = t[p]; return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const r = submitProductActionRequest(proxy as never, { ownerId: alice, action: 'delete', productId: pB, generateId: () => 'par_new' })
    ok('11 non-UNIQUE transient (SQLITE_BUSY) while a dup exists → REQUEST_FAILED, NOT masked as 409', r.error_code === 'REQUEST_FAILED')
    // sanity: a GENUINE unique dup still returns 409 (the code-gate lets the real dup through)
    ok('11b genuine unique dup still → 409', (await post({ action: 'delete', product_id: pB }, alice)).status === 409)
  }

  if (fail > 0) { console.error(`\n❌ product-action-request FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ product-action-request (Task 2): owner-key submit · approve_url+TTL · ownership 403 · 404/400 · double-pending 409 · unauth 401 · zero-exec (no executor import, product untouched)\n  ✅ pass ${pass}`)
} finally {
  server.close(); rmSync(tmpHome, { recursive: true, force: true })
}
