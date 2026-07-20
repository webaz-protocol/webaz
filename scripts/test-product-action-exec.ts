#!/usr/bin/env tsx
/**
 * Ops Passkey-in-flow — Task 4 test: product-action-exec (approval-driven hard delete).
 *
 * Real fresh DB + real schema. Proves the executor is the AUTHORIZED version of DELETE /api/products/:id:
 * executes only when authorized (approved request OR consumed T1 window), replicates the route's delete
 * preconditions (owner-bound / must be in recycle bin / no active orders / deletes external links / DELETE
 * FROM products), CAS-claims the request to prevent double-execute, and is fully ATOMIC — a claim conflict
 * after a window was consumed rolls the window use back (no burned budget on a failed delete). Sanitized
 * failure boundary; anchor GC is best-effort.
 *
 * Usage: npm run test:product-action-exec
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-pae-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initProductActionApprovalSchema, initProductExternalLinksBaseSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { executeProductActionRequest } = await import('../src/pwa/product-action-exec.js')
const { mintWindow } = await import('../src/pwa/approval-window.js')
const Database = (await import('better-sqlite3')).default

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const noAnchor = (): void => {}
const execReq = (d: unknown, requestId: string, retire: (db: any, k: string, id: string) => void = noAnchor) =>
  executeProductActionRequest(d as never, { requestId, retireAnchorsByTarget: retire })

const db = initDatabase()
initProductActionApprovalSchema(db)       // the two ops tables
initProductExternalLinksBaseSchema(db)    // product_external_links (not in the L0 core schema)

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

try {
  // 1. approved request → execute via approval
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved')
    const res = execReq(db, r)
    ok('1a approved → ok, via=approval', res.ok === true && res.authorized_via === 'approval' && res.product_id === p)
    ok('1b product hard-deleted', !exists(p))
    ok('1c request marked executed + execution_result recorded', reqStatus(r) === 'executed' &&
      /deleted_product_id/.test(String((db.prepare('SELECT execution_result FROM product_action_requests WHERE id=?').get(r) as { execution_result: string }).execution_result)))
  }
  // 2. double-execute is refused (idempotency / no double-delete)
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved')
    execReq(db, r)
    const res2 = execReq(db, r)
    ok('2 second execute → ALREADY_EXECUTED 409', res2.ok === false && res2.error_code === 'ALREADY_EXECUTED' && res2.http === 409)
  }
  // 3. pending request + active T1 window → execute via window, consumes exactly one use
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const m = mintWindow(db, { ownerId: alice, tier: 'T1', generateId, maxUses: 3 })
    const res = execReq(db, r)
    ok('3a pending + window → ok, via=window', res.ok === true && res.authorized_via === 'window')
    ok('3b product deleted + request executed', !exists(p) && reqStatus(r) === 'executed')
    ok('3c window consumed exactly one use (uses=1)', (db.prepare('SELECT uses FROM action_approval_windows WHERE id=?').get(m.window_id) as { uses: number }).uses === 1)
  }
  // 4. pending request + NO window → NOT_AUTHORIZED, nothing mutated
  {
    const p = mkProduct(bob), r = mkReq(bob, p, 'pending')   // bob has no window
    const res = execReq(db, r)
    ok('4a pending, no window → NOT_AUTHORIZED 403', res.ok === false && res.error_code === 'NOT_AUTHORIZED' && res.http === 403)
    ok('4b product intact + request still pending', exists(p) && reqStatus(r) === 'pending')
  }
  // 5. NOT_IN_RECYCLE_BIN: product still active → 409, and (approved path) request NOT consumed → retryable
  {
    const p = mkProduct(alice, 'active'), r = mkReq(alice, p, 'approved')
    const res = execReq(db, r)
    ok('5a active product → NOT_IN_RECYCLE_BIN 409', res.ok === false && res.error_code === 'NOT_IN_RECYCLE_BIN' && res.http === 409)
    ok('5b product intact + request still approved (precondition checked BEFORE claim)', exists(p) && reqStatus(r) === 'approved')
  }
  // 6. HAS_ACTIVE_ORDERS: deleted-status product but an in-progress order → 409
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved')
    db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, unit_price, total_amount, escrow_amount, status) VALUES (?,?,?,?, 10, 10, 10, 'confirmed')")
      .run(generateId('ord'), p, bob, alice)
    const res = execReq(db, r)
    ok('6 active order → HAS_ACTIVE_ORDERS 409, product intact', res.ok === false && res.error_code === 'HAS_ACTIVE_ORDERS' && exists(p))
  }
  // 7. NOT_PRODUCT_OWNER: request owner differs from product.seller_id
  {
    const p = mkProduct(alice), r = mkReq(bob, p, 'approved')   // bob requests alice's product
    const res = execReq(db, r)
    ok('7 owner mismatch → NOT_PRODUCT_OWNER 403, product intact', res.ok === false && res.error_code === 'NOT_PRODUCT_OWNER' && exists(p))
  }
  // 8. PRODUCT_NOT_FOUND / REQUEST_NOT_FOUND / REVOKED
  {
    const rGhost = mkReq(alice, 'prd_ghost', 'approved')
    ok('8a product gone → PRODUCT_NOT_FOUND 404', execReq(db, rGhost).error_code === 'PRODUCT_NOT_FOUND')
    ok('8b unknown request → REQUEST_NOT_FOUND 404', execReq(db, 'par_ghost').error_code === 'REQUEST_NOT_FOUND')
    const p = mkProduct(alice), rRev = mkReq(alice, p, 'revoked')
    ok('8c revoked request → REQUEST_REVOKED 409, product intact', execReq(db, rRev).error_code === 'REQUEST_REVOKED' && exists(p))
  }
  // 9. REQUEST_EXPIRED: past TTL → 410, reaped to expired, product intact
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved', -1)   // already expired
    const res = execReq(db, r)
    ok('9a expired → REQUEST_EXPIRED 410', res.ok === false && res.error_code === 'REQUEST_EXPIRED' && res.http === 410)
    ok('9b reaped to status=expired, product intact', reqStatus(r) === 'expired' && exists(p))
  }
  // 10. external links are deleted along with the product
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved')
    db.prepare('INSERT INTO product_external_links (id, product_id, url) VALUES (?,?,?)').run(generateId('lnk'), p, 'https://example.com/x')
    execReq(db, r)
    ok('10 product_external_links removed', !db.prepare('SELECT 1 FROM product_external_links WHERE product_id=?').get(p))
  }
  // 11. anchor GC is BEST-EFFORT: a throwing retireAnchorsByTarget does NOT roll back the delete
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved')
    const res = execReq(db, r, () => { throw new Error('anchor boom') })
    ok('11 anchor GC failure swallowed → delete still succeeds', res.ok === true && !exists(p) && reqStatus(r) === 'executed')
  }
  // 12. ★ATOMIC ROLLBACK: window consumed, then the request CAS-claim conflicts → the WHOLE tx rolls back,
  //   restoring the window use AND leaving the product + request untouched. Proves no budget is burned on a
  //   delete that doesn't happen. Forced via a proxy that makes the claim UPDATE report 0 changes.
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'pending')
    const m = mintWindow(db, { ownerId: alice, tier: 'T1', generateId, maxUses: 2 })
    const proxy = new Proxy(db, {
      get(t: any, prop: string) {
        if (prop === 'transaction') return (fn: () => unknown) => t.transaction(fn)   // real tx envelope
        if (prop === 'prepare') return (sql: string) => {
          if (/UPDATE product_action_requests SET status='executed'/.test(sql)) return { run: () => ({ changes: 0 }) }   // force claim conflict
          return t.prepare(sql)
        }
        const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const res = execReq(proxy as never, r)
    ok('12a claim conflict → CLAIM_CONFLICT 409', res.ok === false && res.error_code === 'CLAIM_CONFLICT' && res.http === 409)
    ok('12b window use ROLLED BACK to 0 (not burned)', (db.prepare('SELECT uses FROM action_approval_windows WHERE id=?').get(m.window_id) as { uses: number }).uses === 0)
    ok('12c product intact + request still pending (full rollback)', exists(p) && reqStatus(r) === 'pending')
  }
  // 13. sanitized failure: a db missing the requests table → EXEC_FAILED, no raw SQL text
  {
    const bare = new Database(':memory:')
    const res = execReq(bare, 'par_x')
    ok('13a missing table → EXEC_FAILED 500 (no throw escapes)', res.ok === false && res.error_code === 'EXEC_FAILED' && res.http === 500)
    ok('13b sanitized (no SQL/table/constraint text)', !/SQLITE|no such table|product_action_requests|constraint/i.test(String(res.error)))
    bare.close()
  }
  // 15. approval path must NOT consume a window even if one is active (no wasted budget on already-approved reqs)
  {
    const p = mkProduct(alice), r = mkReq(alice, p, 'approved')
    const m = mintWindow(db, { ownerId: alice, tier: 'T1', generateId, maxUses: 5 })
    const res = execReq(db, r)
    ok('15a approved req executes via approval (not window)', res.ok === true && res.authorized_via === 'approval')
    ok('15b active window NOT touched (uses still 0)', (db.prepare('SELECT uses FROM action_approval_windows WHERE id=?').get(m.window_id) as { uses: number }).uses === 0)
    db.prepare('UPDATE action_approval_windows SET revoked_at=? WHERE id=?').run(new Date().toISOString(), m.window_id)  // clean up so it doesn't affect later window tests
  }
  // 16. after a request executes and deletes product P, a fresh request for the same P → PRODUCT_NOT_FOUND
  //   (ux_par_active only blocks a SECOND active request while the first is non-terminal; after 'executed' a
  //    new one is allowed, and it correctly finds the product already gone). Locks in the no-resurrection path.
  {
    const p = mkProduct(alice), rA = mkReq(alice, p, 'approved')
    ok('16a first request deletes the product', execReq(db, rA).ok === true && !exists(p))
    const rB = mkReq(alice, p, 'approved')   // allowed now that rA is terminal (executed)
    ok('16b second request for the now-deleted product → PRODUCT_NOT_FOUND', execReq(db, rB).error_code === 'PRODUCT_NOT_FOUND')
  }
  // 14. import shape: executor MAY import approval-window (it consumes windows) but must NOT reach money/order-creation
  {
    const src = readFileSync(join(process.cwd(), 'src/pwa/product-action-exec.ts'), 'utf8')
    const imports = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
    ok('14a imports consumeWindow from approval-window (allowed consumer)', /from '\.\/approval-window\.js'/.test(imports))
    ok('14b no money/order-creation import (ledger/settle/order-create)', !/\bledger\b|settle|order-request|createOrder|order-action/i.test(imports))
  }

  if (fail > 0) { console.error(`\n❌ product-action-exec FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ product-action-exec (Task 4): authorized hard-delete (approval|window) · route-parity preconditions · double-execute guard · atomic rollback (window use restored on claim conflict) · sanitized failure · best-effort anchor GC\n  ✅ pass ${pass}`)
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
