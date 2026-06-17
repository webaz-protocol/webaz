#!/usr/bin/env tsx
/**
 * 分享资格门 = 真实收货完成(经过 confirmed),不是裸 status='completed'。  用法:npm run test:share-genuine-receipt
 *
 * 背景(bug):status='completed' 是状态机通用终态,fault_seller / fault_logistics / fault_buyer /
 * declined_nofault / disputed → completed 这些【退款 / 违约 / 争议】处置也落到 completed。
 * 旧分享门 `COUNT(*) WHERE status='completed'` 把「被退款的失败交易」当成有效成交,错误授予分享(分享分润)资格。
 * 修复:真实收货 = 该订单曾进入 confirmed(买家确认 / 送达 72h 自动确认)— 仅 happy path 经过。
 *
 * 本测试用真实 sqlite + 真实 order_state_history 行,跑与 products-meta.ts genuineReceiptCount 完全一致的 SQL。
 */
import { initDatabase, generateId } from '../src/layer0-foundation/L0-1-database/schema.js'
import { initSystemUser } from '../src/layer0-foundation/L0-2-state-machine/engine.js'
import { genuineSalePredicate } from '../src/layer0-foundation/L0-2-state-machine/genuine-sale.js'

const db = initDatabase()
initSystemUser(db)

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

function user(name: string, role: string): string {
  const id = generateId('usr')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(id, name, role, generateId('key'))
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,1000)').run(id)
  return id
}
function product(sellerId: string): string {
  const id = generateId('prd')
  db.prepare(`INSERT INTO products (id, seller_id, title, description, price, stock, stake_amount) VALUES (?,?,?,?,100,10,15)`).run(id, sellerId, 'T', 'T')
  return id
}
function order(buyerId: string, sellerId: string, productId: string, finalStatus: string): string {
  const id = generateId('ord')
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, shipping_address)
    VALUES (?,?,?,?,1,100,100,100,?,'addr')`).run(id, productId, buyerId, sellerId, finalStatus)
  return id
}
function hist(orderId: string, from: string, to: string, actorId: string, role: string): void {
  db.prepare(`INSERT INTO order_state_history (id, order_id, from_status, to_status, actor_id, actor_role) VALUES (?,?,?,?,?,?)`)
    .run(generateId('osh'), orderId, from, to, actorId, role)
}

const sys = (db.prepare("SELECT id FROM users WHERE role='system' LIMIT 1").get() as { id: string }).id
const buyer = user('Buyer', 'buyer')
const seller = user('Seller', 'seller')
const pGenuine = product(seller)
const pFaulted = product(seller)

// 真实成交:经过 confirmed → completed
const og = order(buyer, seller, pGenuine, 'completed')
for (const [f, t, a, r] of [['paid','accepted',seller,'seller'],['accepted','shipped',seller,'seller'],['shipped','delivered',seller,'seller'],['delivered','confirmed',buyer,'buyer'],['confirmed','completed',sys,'system']] as const) hist(og, f, t, a, r)

// 卖家未发货违约:paid → accepted → fault_seller → completed(买家被退款,从未经过 confirmed)
const of = order(buyer, seller, pFaulted, 'completed')
for (const [f, t, a, r] of [['paid','accepted',seller,'seller'],['accepted','fault_seller',sys,'system'],['fault_seller','completed',sys,'system']] as const) hist(of, f, t, a, r)

// 与 products-meta.ts genuineReceiptCount 完全一致的判据
const genuine = (bid: string, pid: string): number =>
  (db.prepare(`SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_state_history h ON h.order_id = o.id
               WHERE o.buyer_id=? AND o.product_id=? AND h.to_status='confirmed'`).get(bid, pid) as { n: number }).n
// 旧(有 bug)判据:裸 status='completed'
const oldGate = (bid: string, pid: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE buyer_id=? AND product_id=? AND status='completed'`).get(bid, pid) as { n: number }).n

ok('genuine receipt → can share (count 1)', genuine(buyer, pGenuine) === 1, `got ${genuine(buyer, pGenuine)}`)
ok('faulted/refunded order → CANNOT share (count 0)', genuine(buyer, pFaulted) === 0, `got ${genuine(buyer, pFaulted)}`)
// 记录被修复的 bug:旧门会把退款订单也算成可分享
ok('regression: OLD status=completed gate wrongly passed the refunded order', oldGate(buyer, pFaulted) === 1, `OLD gate got ${oldGate(buyer, pFaulted)} (should be 1 = the bug)`)
ok('regression: OLD gate also passed genuine (so old gate could not tell them apart)', oldGate(buyer, pGenuine) === 1)

// shared genuineSalePredicate (used by the P1 eligibility gates: rewards opt-in, referral canL1,
// promoter shareable set, like/dispute-speech anti-Sybil) — buyer-level count across all products.
const buyerGenuine = (bid: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`).get(bid) as { n: number }).n
const buyerOldGate = (bid: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND status='completed'`).get(bid) as { n: number }).n
ok('shared predicate: buyer-level genuine count = 1 (genuine), excludes the faulted order', buyerGenuine(buyer) === 1, `got ${buyerGenuine(buyer)} (buyer has 1 genuine + 1 faulted)`)
ok('shared predicate: OLD buyer-level gate counted both (=2) — the eligibility-gaming the fix closes', buyerOldGate(buyer) === 2, `got ${buyerOldGate(buyer)}`)

if (fail === 0) {
  console.log(`\n✅ share genuine-receipt gate: confirmed-path order shares; fault/refund/dispute → completed does NOT; old bare-status gate could not distinguish (now fixed)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ share genuine-receipt gate FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
