#!/usr/bin/env tsx
/**
 * RFC-018 PR4 — genuineSalePredicate is returns-aware.
 *   用法: npm run test:returns-aware-counts
 *
 * A return happens AFTER confirmed→completed, so the old "reached confirmed" predicate counted a
 * fully-returned order as a genuine sale — inflating eligibility / completion_count / sales_count.
 * This asserts the predicate now ALSO excludes fully-refunded-return orders, while:
 *   - a non-returned confirmed order still counts,
 *   - a PARTIAL refund still counts (it was a real sale),
 *   - an order that never reached confirmed (fault/refund terminal) never counts.
 * Plus: the stored completion_count decrement-on-full-return SQL is correct (MAX(0, n-1)).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-rac-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { genuineSalePredicate } = await import('../src/layer0-foundation/L0-2-state-machine/genuine-sale.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db: any = initDatabase()
applyWebazRuntimeSchema(db)
db.pragma('foreign_keys = OFF')
try { db.exec("ALTER TABLE products ADD COLUMN completion_count INTEGER DEFAULT 0") } catch {}  // server.ts inline ALTER (not in L0/helpers)
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('usr_b','b','buyer','k')").run()

let n = 0
// seed an order; reachedConfirmed = did it pass confirmed; refund = {amount} for a refunded return (optional)
const seedOrder = (total: number, reachedConfirmed: boolean, refund?: number): string => {
  const id = 'ord_' + (++n)
  db.prepare("INSERT INTO orders (id, buyer_id, seller_id, product_id, unit_price, total_amount, escrow_amount, status) VALUES (?,?,?,?,?,?,?,'completed')")
    .run(id, 'usr_b', 'usr_b', 'prod_1', total, total, total)
  if (reachedConfirmed) db.prepare("INSERT INTO order_state_history (id, order_id, from_status, to_status, actor_id, actor_role) VALUES (?,?, 'delivered', 'confirmed', 'usr_b', 'buyer')").run('osh_' + id, id)
  if (refund != null) db.prepare("INSERT INTO return_requests (id, order_id, buyer_id, seller_id, product_id, reason, refund_amount, status) VALUES (?,?,?,?,?,?,?,'refunded')")
    .run('ret_' + id, id, 'usr_b', 'usr_b', 'prod_1', 'quality', refund)
  return id
}

const isGenuine = (id: string): boolean => !!db.prepare(`SELECT 1 FROM orders WHERE id = ? AND ${genuineSalePredicate('orders')}`).get(id)

try {
  const a = seedOrder(100, true)             // confirmed, no return → genuine
  const b = seedOrder(100, true, 100)        // confirmed, FULL refund → not genuine
  const c = seedOrder(100, true, 40)         // confirmed, PARTIAL refund (40<100) → genuine
  const d = seedOrder(100, false)            // never confirmed (fault terminal) → not genuine
  const e = seedOrder(100, true, 100)        // another full refund → not genuine

  ok('A: confirmed, no return → genuine', isGenuine(a))
  ok('B: confirmed, FULL refund → NOT genuine', !isGenuine(b))
  ok('C: confirmed, PARTIAL refund → genuine (still a real sale)', isGenuine(c))
  ok('D: never reached confirmed → NOT genuine', !isGenuine(d))
  ok('E: full refund → NOT genuine', !isGenuine(e))

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${genuineSalePredicate('orders')}`).get() as { n: number }).n
  ok('aggregate COUNT excludes the 2 full-returns + 1 fault (5 orders → 2 genuine: A,C)', total === 2, `got ${total}`)

  // edge: refund_amount EXACTLY == total is a full refund (>= boundary) → excluded
  ok('boundary: refund == total counts as full (excluded)', !isGenuine(b))

  // completion_count decrement-on-full-return SQL (mirrors returns.ts): MAX(0, n-1), floors at 0
  db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status, completion_count) VALUES ('prod_cc','usr_b','t','d',1,1,'active',2)").run()
  db.prepare("UPDATE products SET completion_count = MAX(0, COALESCE(completion_count,0) - 1) WHERE id = 'prod_cc'").run()
  ok('completion_count decrement: 2 → 1', (db.prepare("SELECT completion_count c FROM products WHERE id='prod_cc'").get() as { c: number }).c === 1)
  db.prepare("UPDATE products SET completion_count = MAX(0, COALESCE(completion_count,0) - 1) WHERE id='prod_cc'").run()
  db.prepare("UPDATE products SET completion_count = MAX(0, COALESCE(completion_count,0) - 1) WHERE id='prod_cc'").run()
  ok('completion_count decrement floors at 0 (never negative)', (db.prepare("SELECT completion_count c FROM products WHERE id='prod_cc'").get() as { c: number }).c === 0)

  if (fail === 0) {
    console.log(`\n✅ returns-aware genuine sale: full-return excluded, partial counts, fault excluded; completion_count decrement floors at 0\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ returns-aware counts FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
