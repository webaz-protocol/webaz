#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B3 — 'usdc_escrow' rail 接线回归锁。
 * Proves:
 *   ① flag-off byte-identical:菜单零 usdc 选项、quote 拒、建单 409 RAIL_DISABLED(默认关 fail-closed)。
 *   ② 渠道开但合约未配(env 缺)→ 菜单不出 + 建单 USDC_ESCROW_NOT_CONFIGURED(fail-closed)。
 *   ③ 全就绪(param+env+payout 地址+KYB+制裁清白):菜单出 usdc_escrow 选项;建单成功 —— 订单
 *     payment_rail='usdc_escrow' / escrow_amount=0 / status='created' / 库存 CAS 扣减 /【零 wallets 写】。
 *   ④ 门矩阵:无 payout 地址 / KYB 缺 → SELLER_NOT_READY;超 cap;不支持选项;在途上限 429;库存竞态。
 *   ⑤ exec 透传 + rails 类型(源码锁)。
 * Usage: npm run test:usdc-escrow-rail
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'uerail-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
delete process.env.USDC_ESCROW_CONTRACT

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { sellerSupportedPaymentOptions } = await import('../src/direct-pay-payment-options.js')
const { createUsdcEscrowResponse, usdcEscrowSellerAvailable } = await import('../src/usdc-escrow-create.js')
const { toUnits } = await import('../src/money.js')
const { computeBuyerQuote } = await import('../src/pwa/buyer-quote.js')
const { railOutsideWazCustody } = await import('../src/direct-pay-rails.js')
const { sweepExpiredUsdcEscrowOrders } = await import('../src/usdc-escrow-timeouts.js')
const { PRE_SHIP_RESTOCK_STATUSES } = await import('../src/direct-pay-stock.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
for (const col of ['payment_rail TEXT', 'snapshot_commission_rate REAL', 'buyer_region TEXT', 'draft_id TEXT', 'ship_to_region TEXT', 'shipping_fee REAL', 'shipping_est_days TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
for (const col of ['default_address_text TEXT', 'default_address_region TEXT']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key,region,default_address_text,default_address_region) VALUES ('sU','sU','seller','k_sU','global',NULL,NULL),('bU','bU','buyer','k_bU','global','1 Test St / SG','SG'),('sys_protocol','sys','system','k_sys','global',NULL,NULL)").run()
db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0), (?, 0)').run('sU', 'bU')
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('pU','sU','U品','d',30,5,'active')").run()

const cp: Record<string, unknown> = {}
const gp = <T>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
const deps = { generateId: genId, appendOrderEvent: () => {}, getProtocolParam: gp }
const mkRes = (): { status: (n: number) => { json: (b: Record<string, unknown>) => void }; json: (b: Record<string, unknown>) => void; out: { code: number; body: Record<string, unknown> } } => {
  const out = { code: 200, body: {} as Record<string, unknown> }
  return { out, status: (n: number) => { out.code = n; return { json: (b: Record<string, unknown>) => { out.body = b } } }, json: (b: Record<string, unknown>) => { out.body = b } }
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const create = (opts: Record<string, unknown> = {}, totalAmount = 30): { code: number; body: Record<string, unknown> } => {
  const r = mkRes()
  const product = db.prepare("SELECT p.*, u.id AS seller_uid FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id='pU'").get() as Record<string, unknown>
  createUsdcEscrowResponse(r as any, db, deps, { product, buyerId: 'bU', reqQty: 1, basePrice: 30, totalAmount, totalAmountU: toUnits(totalAmount), shippingAddress: 'addr', opts, shipping: { region: null, fee: 0, estDays: null } } as any)
  return r.out
}
const walletSum = (): number => (db.prepare('SELECT ROUND(SUM(COALESCE(balance,0)+COALESCE(staked,0)+COALESCE(escrowed,0)+COALESCE(earned,0)+COALESCE(fee_staked,0)),6) s FROM wallets').get() as { s: number }).s
const menu = (): string[] => sellerSupportedPaymentOptions(db, { productId: 'pU', sellerId: 'sU', amountUnits: toUnits(30), getProtocolParam: gp }).map(o => o.option_id)

// ── ① flag-off(默认)──
db.prepare("INSERT INTO seller_payout_addresses (id, seller_id, address) VALUES ('spa1','sU','0x8ba1f109551bD432803012645Ac136ddd64DBA72')").run()
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kybU','sU','approved')").run()
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('scU','sU','clear')").run()
ok('off: menu has NO usdc option even with a fully-ready seller', !menu().includes('usdc_escrow'))
ok('off: availability predicate false', usdcEscrowSellerAvailable(db, 'sU', gp) === false)
const offRes = create()
ok('off: create → 409 RAIL_DISABLED, no order, no stock change', offRes.code === 409 && offRes.body.error_code === 'RAIL_DISABLED'
  && (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n === 0
  && (db.prepare("SELECT stock FROM products WHERE id='pU'").get() as { stock: number }).stock === 5)

// ── ② 渠道开但合约未配 ──
cp['payment_rail_usdc_escrow_enabled'] = 1
ok('on/no-env: menu still empty (fail-closed on missing contract addr)', !menu().includes('usdc_escrow'))
ok('on/no-env: create → USDC_ESCROW_NOT_CONFIGURED', create().body.error_code === 'USDC_ESCROW_NOT_CONFIGURED')

// ── ③ 全就绪建单 ──
process.env.USDC_ESCROW_CONTRACT = '0x' + '1'.repeat(40)
ok('ready: menu offers usdc_escrow', menu().includes('usdc_escrow'))
const before = walletSum()
const okRes = create()
const ord = db.prepare("SELECT * FROM orders WHERE payment_rail='usdc_escrow'").get() as Record<string, unknown>
ok('ready: order created (rail/escrow_amount=0/status created)', okRes.code === 200 && okRes.body.success === true && !!ord && ord.status === 'created' && Number(ord.escrow_amount) === 0, JSON.stringify(okRes))
ok('ready: stock CAS decremented', (db.prepare("SELECT stock FROM products WHERE id='pU'").get() as { stock: number }).stock === 4)
ok('ready: ZERO wallets writes (principal never enters the protocol)', walletSum() === before)

// ── ④ 门矩阵 ──
ok('cap: over per-tx cap rejected', create({}, 51).body.error_code === 'USDC_ESCROW_CAP_EXCEEDED')
ok('opts: variants rejected', create({ hasVariants: true }).body.error_code === 'USDC_ESCROW_SIMPLE_PRODUCT_ONLY')
ok('opts: flash sale rejected', create({ flashActive: true }).body.error_code === 'USDC_ESCROW_UNSUPPORTED_OPTION')
ok('opts: donation rejected', create({ donationPct: 0.01 }).body.error_code === 'USDC_ESCROW_UNSUPPORTED_OPTION')
db.prepare("UPDATE seller_payout_addresses SET status='retired' WHERE id='spa1'").run()
ok('gate: payout address retired → SELLER_NOT_READY + menu drops option', create().body.error_code === 'USDC_ESCROW_SELLER_NOT_READY' && !menu().includes('usdc_escrow'))
db.prepare("UPDATE seller_payout_addresses SET status='active' WHERE id='spa1'").run()
db.prepare("UPDATE direct_receive_kyb_reviews SET status='pending' WHERE id='kybU'").run()
ok('gate: KYB not approved → SELLER_NOT_READY (AML invariant holds on-chain rail too)', create().body.error_code === 'USDC_ESCROW_SELLER_NOT_READY')
db.prepare("UPDATE direct_receive_kyb_reviews SET status='approved' WHERE id='kybU'").run()
cp['usdc_escrow.max_open_per_buyer_seller'] = 1
ok('open-cap: second in-flight order 429', create().code === 429 && create().body.error_code === 'USDC_ESCROW_TOO_MANY_OPEN')
delete cp['usdc_escrow.max_open_per_buyer_seller']
db.prepare("UPDATE products SET stock = 0 WHERE id='pU'").run()
ok('stock race: CAS failure → 409 + rollback (no new order row)', (() => { const n0 = (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n; const r = create(); return r.body.error_code === 'PRODUCT_STOCK_RACE' && (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n === n0 })())

// ── ④b 真 quote 行为(Codex #520 R1-4:不再只靠源码断言)──
type QInput = Parameters<typeof computeBuyerQuote>[3]
const quote = (rail: string): { ok: boolean; code?: string } => {
  const r = computeBuyerQuote(db, { generateId: genId, getProtocolParam: gp }, 'bU', { product_id: 'pU', quantity: 1, payment_rail: rail } as QInput)
  return r.ok === true ? { ok: true } : { ok: false, code: (r as { body: { error_code?: string } }).body?.error_code }
}
db.prepare("UPDATE products SET stock = 5 WHERE id='pU'").run()
cp['payment_rail_usdc_escrow_enabled'] = 0
ok('quote: off → PAYMENT_RAIL_DISABLED', quote('usdc_escrow').code === 'PAYMENT_RAIL_DISABLED')
cp['payment_rail_usdc_escrow_enabled'] = 1
ok('quote: ready seller → usdc_escrow quote succeeds', quote('usdc_escrow').ok === true, JSON.stringify(quote('usdc_escrow')))
cp['usdc_escrow.per_tx_cap'] = 10
ok('quote: over cap → PURCHASE_LIMIT_EXCEEDED (same truth as menu/create)', quote('usdc_escrow').code === 'PURCHASE_LIMIT_EXCEEDED')
ok('menu: over cap → option withheld (no offer-then-reject)', !menu().includes('usdc_escrow'))
delete cp['usdc_escrow.per_tx_cap']

// ── ④c 下游钱路隔离(Codex #520 R1 P0):usdc_escrow 绝不落 WAZ escrow 结算/退款数学 ──
ok('predicate: railOutsideWazCustody covers both non-WAZ rails only', railOutsideWazCustody('direct_p2p') && railOutsideWazCustody('usdc_escrow') && !railOutsideWazCustody('escrow') && !railOutsideWazCustody('deferred'))
const SV2 = readFileSync(new URL('../src/pwa/server.ts', import.meta.url), 'utf8')
const iSettleFn2 = SV2.indexOf('function settleOrder(orderId: string)')
const iUsdcGuard = SV2.indexOf("payment_rail === 'usdc_escrow') throw", iSettleFn2)
const iEscrowMath = SV2.indexOf('const total = order.total_amount as number', iSettleFn2)
ok('settleOrder: usdc_escrow fail-closed THROW sits BEFORE any WAZ escrow math', iSettleFn2 > 0 && iUsdcGuard > iSettleFn2 && iEscrowMath > iUsdcGuard, `fn=${iSettleFn2} guard=${iUsdcGuard} math=${iEscrowMath}`)
const OA = readFileSync(new URL('../src/pwa/routes/orders-action.ts', import.meta.url), 'utf8')
ok('orders-action: confirm blocked for usdc_escrow until on-chain release wiring (never fake-completes)', /toStatus === 'confirmed' && order\.payment_rail === 'usdc_escrow'/.test(OA) && /USDC_ESCROW_CONFIRM_NOT_WIRED/.test(OA))
const DE = readFileSync(new URL('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.ts', import.meta.url), 'utf8')
ok('dispute-engine: non-custodial branch keyed on railOutsideWazCustody', /nonCustodial = !!ord0 && railOutsideWazCustody\(ord0\.payment_rail\)/.test(DE))
const MC = readFileSync(new URL('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.ts', import.meta.url), 'utf8')
ok('mutual-cancel: same predicate (zero WAZ movement for on-chain rail)', /nonCustodial = railOutsideWazCustody\(order\.payment_rail\)/.test(MC))
const RT = readFileSync(new URL('../src/pwa/routes/returns.ts', import.meta.url), 'utf8')
ok('returns: both rail forks routed through the shared predicate', (RT.match(/railOutsideWazCustody\(railRow\?\.payment_rail\)/g) || []).length === 2)

// ── ④d 付款窗到期清扫(#520 复审:库存泄漏/griefing)──
db.prepare("UPDATE products SET stock = 5 WHERE id='pU'").run()
const sweepRes0 = create()
ok('sweep fixture order created', sweepRes0.body.success === true && (db.prepare("SELECT stock FROM products WHERE id='pU'").get() as { stock: number }).stock === 4)
const newOrderId = String(sweepRes0.body.order_id)
db.prepare("UPDATE orders SET pay_deadline = datetime('now','-1 hour') WHERE id = ?").run(newOrderId)
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const swept = sweepExpiredUsdcEscrowOrders(db, { transition: transition as any })
ok('sweep: expired created order cancelled + stock RESTORED (atomic, sole restock entry)',
  swept.some(x => x.orderId === newOrderId && x.ok)
  && (db.prepare('SELECT status FROM orders WHERE id = ?').get(newOrderId) as { status: string }).status === 'cancelled'
  && (db.prepare("SELECT stock FROM products WHERE id='pU'").get() as { stock: number }).stock === 5, JSON.stringify(swept))
ok('sweep: idempotent (second run nothing to do)', sweepExpiredUsdcEscrowOrders(db, { transition: transition as any }).length === 0)
ok("restock whitelist: 'created' admitted for the pay-window expiry path", PRE_SHIP_RESTOCK_STATUSES.has('created'))

// ── ④e 假完成三旁路 + 仲裁/协商拒绝(源码锁;settleOrder throw = 兜底安全网)──
const SV3 = readFileSync(new URL('../src/pwa/server.ts', import.meta.url), 'utf8')
ok('settleOrder: usdc → THROW (fail-closed; auto-confirm sweep rolls back, order stays delivered)', /payment_rail === 'usdc_escrow'\) throw new Error\('USDC_ESCROW_SETTLE_NOT_WIRED/.test(SV3))
const OA2 = readFileSync(new URL('../src/pwa/routes/orders-action.ts', import.meta.url), 'utf8')
ok('confirm-in-person + dispute_withdraw_confirm both rail-gated', (OA2.match(/USDC_ESCROW_CONFIRM_NOT_WIRED/g) || []).length >= 3)
const DE2 = readFileSync(new URL('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.ts', import.meta.url), 'utf8')
ok('arbitration: usdc ruling REFUSED (zero-fund resolution would gift autoRelease to the loser)', /usdc_escrow'\) return \{ success: false, error: 'USDC 担保争议经链上仲裁/.test(DE2))
const MC2 = readFileSync(new URL('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.ts', import.meta.url), 'utf8')
ok('mutual-cancel: usdc settle REFUSED until on-chain refund wiring', /USDC_ESCROW_MUTUAL_CANCEL_NOT_WIRED/.test(MC2))
const EG = readFileSync(new URL('../src/layer0-foundation/L0-2-state-machine/engine.ts', import.meta.url), 'utf8')
ok('engine: all four custody forks keyed on railOutsideWazCustody (settleFault mint risk closed)', (EG.match(/railOutsideWazCustody\(order\.payment_rail\)/g) || []).length === 4)

// ── ⑤ 源码锁 ──
const RAILS = readFileSync(new URL('../src/direct-pay-rails.ts', import.meta.url), 'utf8')
ok('rails: usdc_escrow is a real rail; deferred still is not', /'escrow' \| 'direct_p2p' \| 'usdc_escrow' \| 'deferred'/.test(RAILS) && /r === 'escrow' \|\| r === 'direct_p2p' \|\| r === 'usdc_escrow'/.test(RAILS))
const EXEC = readFileSync(new URL('../src/pwa/order-submit-exec.ts', import.meta.url), 'utf8')
ok('exec: usdc_escrow passed through to /api/orders', /body\.payment_rail = 'usdc_escrow'/.test(EXEC))
const OC = readFileSync(new URL('../src/pwa/routes/orders-create.ts', import.meta.url), 'utf8')
const iU = OC.indexOf("=== 'usdc_escrow') return void createUsdcEscrowResponse")
const iW = OC.indexOf('wazEscrowChannelOn(getProtocolParam)) return void res.status(409).json(WAZ_RAIL_DISABLED)')
ok('orders-create: usdc dispatch sits BEFORE the WAZ hard gate (never falls through to the sim rail)', iU > 0 && iW > iU)

if (fail > 0) { console.error(`\n❌ usdc-escrow-rail FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow-rail: flag-off byte-identical → configured+opted-in seller gets the on-chain rail (order created, zero wallets writes, stock CAS) with the full gate matrix\n  ✅ pass ${pass}`)
