#!/usr/bin/env tsx
/**
 * Cart selected-intent checkout contract: real Express route + SQLite transaction tests.
 * Usage: npm run test:cart-checkout
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-cart-checkout-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initAgentAttestationsSchema, initCartItemsSchema, initUserAddressesSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { registerCartRoutes } = await import('../src/pwa/routes/cart.js')

let pass = 0
let fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}${detail ? `\n    ${detail}` : ''}`) }
}

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
initCartItemsSchema(db)
initUserAddressesSchema(db)
initAgentAttestationsSchema(db)
initOrderChainSchema(db)
initNotificationSchema(db)
// `source` is an older server-start migration; route integration uses the same production shape.
try { db.exec('ALTER TABLE orders ADD COLUMN source TEXT') } catch { /* fresh schema already has it */ }
try { db.exec('ALTER TABLE orders ADD COLUMN donation_amount REAL DEFAULT 0') } catch { /* server boot migration */ }

db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer','Buyer','buyer','buyer-key'),('other-buyer','Other buyer','buyer','other-key'),('seller','Seller','seller','seller-key'),('seller-2','Seller 2','seller','seller-2-key')").run()
db.prepare("INSERT INTO wallets (user_id,balance,escrowed) VALUES ('buyer',100,0),('other-buyer',100,0),('seller',0,0),('seller-2',0,0)").run()
db.prepare("INSERT INTO user_addresses (id,user_id,label,recipient,phone,region,detail,is_default) VALUES ('addr-buyer','buyer','Home','Jane','91234567','SG','1 Test St #05-01 123456',1),('addr-other','other-buyer','Other','Bob','81234567','SG','9 Other Rd',1)").run()

const seedProduct = (id: string, price: number, stock: number, hasVariants = 0, sellerId = 'seller'): void => {
  db.prepare('INSERT INTO products (id,seller_id,title,description,price,stock,status,has_variants) VALUES (?,?,?,?,?,?,\'active\',?)')
    .run(id, sellerId, id, 'test product', price, stock, hasVariants)
}
const seedCart = (productId: string, qty = 1): void => {
  db.prepare('INSERT INTO cart_items (user_id,product_id,qty) VALUES (\'buyer\',?,?)').run(productId, qty)
}
const state = (productIds: string[]): string => JSON.stringify({
  wallet: db.prepare("SELECT balance, escrowed FROM wallets WHERE user_id='buyer'").get(),
  cart: productIds.map(id => db.prepare('SELECT product_id, qty FROM cart_items WHERE user_id=\'buyer\' AND product_id=?').get(id)),
  products: productIds.map(id => db.prepare('SELECT id, stock FROM products WHERE id=?').get(id)),
  orderCount: (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count,
  orderEventCount: (db.prepare('SELECT COUNT(*) AS count FROM order_events').get() as { count: number }).count,
  notificationCount: (db.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count,
})
const row = <T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined => db.prepare(sql).get(...params) as T | undefined

let ids = 0
let injectRace = false
const app = express()
app.use(express.json())
registerCartRoutes(app, {
  db,
  generateId: prefix => `${prefix}_${++ids}`,
  auth: (req: Request, res: Response) => {
    const user = row<Record<string, unknown>>('SELECT * FROM users WHERE id=?', String(req.headers['x-test-user'] || ''))
    if (!user) { res.status(401).json({ error: 'login required' }); return null }
    return user
  },
  isTrustedRole: () => false,
  errorRes: (res: Response, status: number, code: string, msg: string) => { res.status(status).json({ error: msg, error_code: code }) },
  // WAZ 退役:本测试验证购物车 escrow 渠道【开着时】的批量下单语义(默认关的行为见 test-waz-escrow-rail-gate)
  getProtocolParam: <T,>(k: string, fb: T): T => (k === 'payment_rail_waz_escrow_enabled' ? 1 as unknown as T : fb),
  broadcastSystemEvent: () => {},
  // This deterministic competing write occurs inside the checkout transaction. The subsequent
  // conditional decrement must fail, and every earlier checkout write must roll back with it.
  checkStockAndMaybeDelist: productId => {
    if (injectRace && productId === 'race-first') db.prepare("UPDATE products SET stock=0 WHERE id='race-second'").run()
  },
  addHours: (date: Date, hours: number) => new Date(date.getTime() + hours * 3_600_000).toISOString(),
})

const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const checkout = async (body: Record<string, unknown>, apiKey?: string, authorization?: string): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${base}/api/cart/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'buyer', ...(authorization ? { authorization } : apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}
const selected = (productIds: string[]) => ({
  shipping_address: '1 Checkout Road',
  items: productIds.map(productId => {
    const item = row<{ qty: number; price: number }>('SELECT c.qty, p.price FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.user_id=\'buyer\' AND c.product_id=?', productId.trim())
    return { product_id: productId, qty: item?.qty ?? 1, unit_price: item?.price ?? 0 }
  }),
})

try {
  const openapi = JSON.parse(readFileSync(new URL('./openapi-schemas.json', import.meta.url), 'utf8'))
  const checkoutSchema = openapi.endpoints?.['POST /api/cart/checkout']?.requestBody
  ok('OpenAPI requires items but allows address_id or shipping_address', !checkoutSchema?.required?.includes('shipping_address') && checkoutSchema?.required?.includes('items') && checkoutSchema?.properties?.address_id?.type === 'string')
  ok('OpenAPI selection bounds match runtime', checkoutSchema?.properties?.items?.minItems === 1 && checkoutSchema.properties.items.maxItems === 500)

  const bodyKey = await checkout({ ...selected(['not-needed']), api_key: 'capped-key' })
  ok('body api_key cannot authenticate checkout', bodyKey.status === 401 && bodyKey.json.error_code === 'AUTH_HEADER_REQUIRED', JSON.stringify(bodyKey))
  const mixedKey = await checkout({ ...selected(['not-needed']), api_key: 'capped-key' }, 'capped-key')
  ok('body api_key is rejected even when a Bearer credential is also present', mixedKey.status === 401 && mixedKey.json.error_code === 'AUTH_HEADER_REQUIRED', JSON.stringify(mixedKey))
  const malformedBodyKey = await checkout({ ...selected(['not-needed']), api_key: { key: 'capped-key' } }, 'capped-key')
  ok('non-string body api_key is also rejected', malformedBodyKey.status === 401 && malformedBodyKey.json.error_code === 'AUTH_HEADER_REQUIRED', JSON.stringify(malformedBodyKey))
  const rawKey = await checkout(selected(['not-needed']), undefined, 'capped-key')
  ok('raw Authorization credential cannot bypass Bearer-only checkout', rawKey.status === 401 && rawKey.json.error_code === 'AUTH_HEADER_REQUIRED', JSON.stringify(rawKey))

  // Partial choice: only explicit IDs are candidates; selected skips retain their historical semantics.
  seedProduct('chosen', 10, 5)
  seedProduct('chosen-other-seller', 15, 5, 0, 'seller-2')
  seedProduct('left-in-cart', 40, 4)
  seedProduct('selected-skip', 25, 3, 1)
  seedCart('chosen')
  seedCart('chosen-other-seller')
  seedCart('left-in-cart', 2)
  seedCart('selected-skip')
  const partial = await checkout(selected(['chosen', 'chosen-other-seller', 'selected-skip']))
  ok('partial selection succeeds', partial.status === 200, JSON.stringify(partial))
  const partialOrders = (partial.json.orders as Array<{ order_id: string; product_id: string }> | undefined) || []
  ok('cross-seller selection creates one order per selected eligible product', partial.json.orders_created === 2
    && new Set(partialOrders.map(order => order.product_id)).size === 2
    && partialOrders.every(order => ['chosen', 'chosen-other-seller'].includes(order.product_id)))
  ok('created orders are paid cart_batch orders with one transition each', partialOrders.every(order => {
    const stored = row<{ status: string; source: string }>('SELECT status, source FROM orders WHERE id=?', order.order_id)
    const events = row<{ count: number }>('SELECT COUNT(*) AS count FROM order_events WHERE order_id=?', order.order_id)?.count
    return stored?.status === 'paid' && stored.source === 'cart_batch' && events === 1
  }))
  ok('selected skipped item is reported and remains in the cart', ((partial.json.skipped as Array<{ product_id: string }> | undefined) || []).some(skip => skip.product_id === 'selected-skip')
    && !!row('SELECT 1 FROM cart_items WHERE user_id=\'buyer\' AND product_id=\'selected-skip\''))
  // 状态文案分流回归锁(2026-07-18 生产误报复盘):购物车内商品必然公开过 → warehouse=被收回,
  // 归"已下架";paused 单独如实说明,绝不含糊
  seedProduct('skip-warehouse', 10, 5)
  seedProduct('skip-paused', 10, 5)
  db.prepare("UPDATE products SET status='warehouse' WHERE id='skip-warehouse'").run()
  db.prepare("UPDATE products SET status='paused' WHERE id='skip-paused'").run()
  seedCart('skip-warehouse'); seedCart('skip-paused')
  const statusSplit = await checkout(selected(['skip-warehouse', 'skip-paused']))
  const splitSkips = (statusSplit.json.skipped as Array<{ product_id: string; reason: string }> | undefined) || []
  ok('retracted (warehouse) cart item skipped as 已下架',
    splitSkips.some(s => s.product_id === 'skip-warehouse' && s.reason === '商品已下架'), JSON.stringify(splitSkips))
  ok('paused cart item skipped with 暂时不可购买 reason (never 已下架)',
    splitSkips.some(s => s.product_id === 'skip-paused' && s.reason === '商品暂时不可购买'), JSON.stringify(splitSkips))
  db.prepare("DELETE FROM cart_items WHERE user_id='buyer' AND product_id IN ('skip-warehouse','skip-paused')").run()

  ok('unselected item remains untouched', !!row('SELECT 1 FROM cart_items WHERE user_id=\'buyer\' AND product_id=\'left-in-cart\' AND qty=2')
    && row<{ stock: number }>('SELECT stock FROM products WHERE id=\'left-in-cart\'')?.stock === 4)
  ok('only selected item changes wallet, inventory, and cart', !row('SELECT 1 FROM cart_items WHERE user_id=\'buyer\' AND product_id=\'chosen\'')
    && row<{ stock: number }>('SELECT stock FROM products WHERE id=\'chosen\'')?.stock === 4
    && !row('SELECT 1 FROM cart_items WHERE user_id=\'buyer\' AND product_id=\'chosen-other-seller\'')
    && row<{ stock: number }>('SELECT stock FROM products WHERE id=\'chosen-other-seller\'')?.stock === 4
    && row<{ balance: number; escrowed: number }>("SELECT balance, escrowed FROM wallets WHERE user_id='buyer'")?.balance === 75
    && row<{ balance: number; escrowed: number }>("SELECT balance, escrowed FROM wallets WHERE user_id='buyer'")?.escrowed === 25)

  seedProduct('address-id-item', 2, 4)
  seedCart('address-id-item')
  const addressIdOrder = await checkout({ ...selected(['address-id-item']), shipping_address: undefined, address_id: 'addr-buyer' })
  const addressIdStored = row<{ shipping_address: string }>("SELECT shipping_address FROM orders WHERE product_id='address-id-item'")
  ok('cart checkout accepts buyer address_id and snapshots the address text', addressIdOrder.status === 200 && /1 Test St/.test(addressIdStored?.shipping_address || ''), JSON.stringify({ addressIdOrder, addressIdStored }))

  seedProduct('foreign-address-item', 2, 4)
  seedCart('foreign-address-item')
  const foreignAddressBefore = state(['foreign-address-item'])
  const foreignAddress = await checkout({ ...selected(['foreign-address-item']), shipping_address: undefined, address_id: 'addr-other' })
  ok('cart checkout rejects another buyer address_id', foreignAddress.status === 404 && foreignAddress.json.error_code === 'ADDRESS_NOT_FOUND', JSON.stringify(foreignAddress))
  ok('foreign address rejection has no side effects', state(['foreign-address-item']) === foreignAddressBefore)

  seedProduct('default-address-item', 2, 4)
  seedCart('default-address-item')
  const defaultAddressOrder = await checkout({ items: selected(['default-address-item']).items })
  const defaultAddressStored = row<{ shipping_address: string }>("SELECT shipping_address FROM orders WHERE product_id='default-address-item'")
  ok('cart checkout falls back to buyer default address when address omitted', defaultAddressOrder.status === 200 && /1 Test St/.test(defaultAddressStored?.shipping_address || ''), JSON.stringify({ defaultAddressOrder, defaultAddressStored }))

  seedProduct('replay-once', 1, 2)
  seedCart('replay-once')
  const replayOrdersBefore = (row<{ count: number }>('SELECT COUNT(*) AS count FROM orders')!).count
  const replayBody = selected(['replay-once'])
  const replayResponses = await Promise.all([checkout(replayBody), checkout(replayBody)])
  const replayStatuses = replayResponses.map(response => response.status).sort()
  const replayOrdersAfter = (row<{ count: number }>('SELECT COUNT(*) AS count FROM orders')!).count
  ok('concurrent selection replay succeeds at most once', replayStatuses[0] === 200 && replayStatuses[1] === 409
    && replayResponses.some(response => response.json.error_code === 'CART_SELECTION_STALE')
    && replayOrdersAfter === replayOrdersBefore + 1, JSON.stringify({ replayResponses, replayOrdersBefore, replayOrdersAfter }))

  // Invalid selection must fail before reads with any commerce side effect.
  seedProduct('validation-item', 5, 8)
  seedCart('validation-item')
  const invalidCases: Array<[string, Record<string, unknown>, string]> = [
    ['missing selection', { shipping_address: '1 Checkout Road' }, 'CART_SELECTION_REQUIRED'],
    ['empty selection', selected([]), 'CART_SELECTION_REQUIRED'],
    ['non-object selection member', { shipping_address: '1 Checkout Road', items: [123] }, 'CART_SELECTION_INVALID'],
    ['invalid quantity', { shipping_address: '1 Checkout Road', items: [{ product_id: 'validation-item', qty: 0, unit_price: 5 }] }, 'CART_SELECTION_INVALID'],
    ['invalid unit price', { shipping_address: '1 Checkout Road', items: [{ product_id: 'validation-item', qty: 1, unit_price: Number.NaN }] }, 'CART_SELECTION_INVALID'],
    ['exact duplicate selection', selected(['validation-item', 'validation-item']), 'CART_SELECTION_INVALID'],
    ['duplicate after trim', selected(['validation-item', ' validation-item ']), 'CART_SELECTION_INVALID'],
    ['selection over 500 items', selected(Array.from({ length: 501 }, (_, i) => `item-${i}`)), 'CART_SELECTION_INVALID'],
  ]
  for (const [name, body, errorCode] of invalidCases) {
    const before = state(['validation-item'])
    const response = await checkout(body)
    ok(`${name} is rejected fail-closed`, response.status === 400 && response.json.error_code === errorCode, JSON.stringify(response))
    ok(`${name} has no side effects`, state(['validation-item']) === before)
  }

  seedProduct('not-in-cart', 7, 6)
  const staleBefore = state(['validation-item', 'not-in-cart'])
  const stale = await checkout(selected(['validation-item', 'not-in-cart']))
  ok('stale cart selection returns 409 CART_SELECTION_STALE', stale.status === 409 && stale.json.error_code === 'CART_SELECTION_STALE', JSON.stringify(stale))
  ok('stale cart selection is all-or-nothing', state(['validation-item', 'not-in-cart']) === staleBefore)

  seedProduct('other-buyer-cart-item', 8, 2)
  db.prepare("INSERT INTO cart_items (user_id,product_id,qty) VALUES ('other-buyer','other-buyer-cart-item',1)").run()
  const crossUserBefore = state(['validation-item', 'other-buyer-cart-item'])
  const crossUser = await checkout(selected(['validation-item', 'other-buyer-cart-item']))
  ok('another buyer cart id is indistinguishable from stale selection', crossUser.status === 409
    && crossUser.json.error_code === 'CART_SELECTION_STALE' && crossUser.json.error === stale.json.error)
  ok('another buyer cart id cannot cause commerce side effects', state(['validation-item', 'other-buyer-cart-item']) === crossUserBefore)

  seedProduct('price-drift', 11, 4)
  seedCart('price-drift', 2)
  const priceIntent = selected(['price-drift'])
  db.prepare("UPDATE products SET price=12 WHERE id='price-drift'").run()
  const priceDriftBefore = state(['price-drift'])
  const priceDrift = await checkout(priceIntent)
  ok('price change after buyer confirmation returns CART_SELECTION_STALE', priceDrift.status === 409 && priceDrift.json.error_code === 'CART_SELECTION_STALE', JSON.stringify(priceDrift))
  ok('price drift rejection has no side effects', state(['price-drift']) === priceDriftBefore)

  seedProduct('qty-drift', 3, 6)
  seedCart('qty-drift', 1)
  const qtyIntent = selected(['qty-drift'])
  db.prepare("UPDATE cart_items SET qty=2 WHERE user_id='buyer' AND product_id='qty-drift'").run()
  const qtyDriftBefore = state(['qty-drift'])
  const qtyDrift = await checkout(qtyIntent)
  ok('quantity change after buyer confirmation returns CART_SELECTION_STALE', qtyDrift.status === 409 && qtyDrift.json.error_code === 'CART_SELECTION_STALE', JSON.stringify(qtyDrift))
  ok('quantity drift rejection has no side effects', state(['qty-drift']) === qtyDriftBefore)

  // Agent spend limits apply to the actual selected, orderable total inside the same transaction.
  db.prepare(`INSERT INTO agent_attestations
    (id,api_key,user_id,approved_scope,spend_cap_per_order,spend_cap_daily)
    VALUES ('cap-attestation','capped-key','buyer','[]',3,NULL)`).run()
  seedProduct('over-agent-cap', 4, 3)
  seedCart('over-agent-cap')
  const capBefore = state(['over-agent-cap'])
  const overCap = await checkout(selected(['over-agent-cap']), 'capped-key')
  ok('agent per-order cap checks the actual selected total', overCap.status === 403
    && overCap.json.error_code === 'AGENT_SPEND_CAP_PER_ORDER' && overCap.json.spend_cap === 3, JSON.stringify(overCap))
  ok('agent per-order cap rejection has no side effects', state(['over-agent-cap']) === capBefore)

  db.prepare("UPDATE agent_attestations SET spend_cap_per_order=5 WHERE id='cap-attestation'").run()
  seedProduct('within-cap-a', 4, 3)
  seedProduct('within-cap-b', 4, 3)
  seedCart('within-cap-a')
  seedCart('within-cap-b')
  const withinCap = await checkout(selected(['within-cap-a', 'within-cap-b']), 'capped-key')
  ok('per-order cap applies to each independent cart order, not the batch sum', withinCap.status === 200
    && withinCap.json.orders_created === 2, JSON.stringify(withinCap))

  db.prepare("UPDATE agent_attestations SET spend_cap_per_order=0.3, spend_cap_daily=NULL WHERE id='cap-attestation'").run()
  seedProduct('decimal-cap-boundary', 0.1, 5)
  seedCart('decimal-cap-boundary', 3)
  const decimalCap = await checkout(selected(['decimal-cap-boundary']), 'capped-key')
  ok('integer money units allow the exact 0.10 x 3 = 0.30 cap boundary', decimalCap.status === 200, JSON.stringify(decimalCap))

  db.prepare("UPDATE orders SET donation_amount=1 WHERE id=(SELECT id FROM orders WHERE buyer_id='buyer' ORDER BY created_at LIMIT 1)").run()
  const spentBefore = row<{ total: number }>("SELECT COALESCE(SUM(total_amount + COALESCE(donation_amount,0)),0) AS total FROM orders WHERE buyer_id='buyer' AND created_at > datetime('now','-24 hours') AND status != 'cancelled'")!.total
  db.prepare('UPDATE agent_attestations SET spend_cap_per_order=10, spend_cap_daily=? WHERE id=\'cap-attestation\'').run(spentBefore + 3.5)
  seedProduct('donation-history-cap', 4, 3)
  seedCart('donation-history-cap')
  const donationHistoryBefore = state(['donation-history-cap'])
  const donationHistoryCap = await checkout(selected(['donation-history-cap']), 'capped-key')
  ok('daily cap includes historical donation debits', donationHistoryCap.status === 403 && donationHistoryCap.json.error_code === 'AGENT_SPEND_CAP_DAILY', JSON.stringify(donationHistoryCap))
  ok('donation-inclusive daily rejection has no side effects', state(['donation-history-cap']) === donationHistoryBefore)
  db.prepare('UPDATE agent_attestations SET spend_cap_per_order=10, spend_cap_daily=? WHERE id=\'cap-attestation\'').run(spentBefore + 4)
  seedProduct('daily-cap-a', 4, 3)
  seedProduct('daily-cap-b', 4, 3)
  seedCart('daily-cap-a')
  seedCart('daily-cap-b')
  const dailyOrdersBefore = row<{ count: number }>('SELECT COUNT(*) AS count FROM orders')!.count
  const walletBefore = row<{ balance: number; escrowed: number }>("SELECT balance,escrowed FROM wallets WHERE user_id='buyer'")!
  const dailyResponses = await Promise.all([
    checkout(selected(['daily-cap-a']), 'capped-key'),
    checkout(selected(['daily-cap-b']), 'capped-key'),
  ])
  const dailyOrdersAfter = row<{ count: number }>('SELECT COUNT(*) AS count FROM orders')!.count
  const walletAfter = row<{ balance: number; escrowed: number }>("SELECT balance,escrowed FROM wallets WHERE user_id='buyer'")!
  const remainingDailyItems = row<{ count: number }>("SELECT COUNT(*) AS count FROM cart_items WHERE user_id='buyer' AND product_id IN ('daily-cap-a','daily-cap-b')")!.count
  ok('concurrent agent checkouts cannot jointly exceed the daily cap', dailyResponses.filter(response => response.status === 200).length === 1
    && dailyResponses.filter(response => response.status === 403 && response.json.error_code === 'AGENT_SPEND_CAP_DAILY').length === 1,
  JSON.stringify(dailyResponses))
  ok('daily-cap serialization commits exactly one checkout', dailyOrdersAfter === dailyOrdersBefore + 1
    && walletAfter.balance === walletBefore.balance - 4 && walletAfter.escrowed === walletBefore.escrowed + 4
    && remainingDailyItems === 1)
  db.prepare("DELETE FROM agent_attestations WHERE id='cap-attestation'").run()

  seedProduct('decimal-total-a', 0.1, 2)
  seedProduct('decimal-total-b', 0.2, 2)
  seedCart('decimal-total-a')
  seedCart('decimal-total-b')
  const decimalTotal = await checkout(selected(['decimal-total-a', 'decimal-total-b']))
  ok('multi-item response reuses the canonical checkout total without float drift', decimalTotal.status === 200 && decimalTotal.json.total_paid === 0.3, JSON.stringify(decimalTotal))

  seedProduct('unit-rounding', 1.0000004, 3)
  seedCart('unit-rounding')
  const roundingWalletBefore = row<{ balance: number }>("SELECT balance FROM wallets WHERE user_id='buyer'")!.balance
  const unitRounding = await checkout(selected(['unit-rounding']))
  const roundingOrder = row<{ unit_price: number; total_amount: number }>("SELECT unit_price,total_amount FROM orders WHERE product_id='unit-rounding'")
  const roundingWalletAfter = row<{ balance: number }>("SELECT balance FROM wallets WHERE user_id='buyer'")!.balance
  ok('cart canonicalizes matched display price to six-decimal money units', unitRounding.status === 200 && roundingOrder?.unit_price === 1 && roundingOrder.total_amount === 1, JSON.stringify({ unitRounding, roundingOrder }))
  ok('cart wallet debit uses the same canonical units as the stored order', roundingWalletBefore - roundingWalletAfter === 1)

  seedProduct('too-expensive', 91, 3)
  seedCart('too-expensive')
  const insufficientBefore = state(['too-expensive'])
  const insufficient = await checkout(selected(['too-expensive']))
  ok('insufficient balance rejects checkout', insufficient.status === 400 && typeof insufficient.json.error === 'string' && insufficient.json.error.includes('余额不足'), JSON.stringify(insufficient))
  ok('insufficient balance leaves wallet, stock, cart, and orders unchanged', state(['too-expensive']) === insufficientBefore)

  seedProduct('race-first', 5, 3)
  seedProduct('race-second', 6, 3)
  seedCart('race-first')
  seedCart('race-second')
  const raceBefore = state(['race-first', 'race-second'])
  injectRace = true
  const race = await checkout(selected(['race-first', 'race-second']))
  injectRace = false
  ok('stock race returns STOCK_DEPLETED', race.status === 409 && race.json.error_code === 'STOCK_DEPLETED', JSON.stringify(race))
  ok('stock race rolls back the whole checkout transaction', state(['race-first', 'race-second']) === raceBefore)

  db.prepare("DELETE FROM cart_items WHERE user_id='buyer'").run()
  seedProduct('empty-replay', 0.5, 2)
  seedCart('empty-replay')
  const emptyReplayBody = selected(['empty-replay'])
  const emptyReplayFirst = await checkout(emptyReplayBody)
  const emptyReplaySecond = await checkout(emptyReplayBody)
  ok('isolated checkout succeeds before an empty-cart replay', emptyReplayFirst.status === 200, JSON.stringify(emptyReplayFirst))
  ok('replay after the cart becomes empty returns CART_SELECTION_STALE', emptyReplaySecond.status === 409 && emptyReplaySecond.json.error_code === 'CART_SELECTION_STALE', JSON.stringify(emptyReplaySecond))
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
}

if (fail > 0) {
  console.error(`\nFAIL cart checkout selected-intent\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`PASS cart checkout selected-intent\n  pass ${pass}`)
