#!/usr/bin/env tsx
/**
 * WAZ 退役(2026-07-23)PR-A1 — 模拟托管轨渠道开关(payment_rail_waz_escrow_enabled,默认关)。
 *
 * Proves(fail-closed 三层同真值):
 *  1. 菜单层:sellerSupportedPaymentOptions 渠道关 → 无 escrow 选项(详见 test-payment-options)。
 *  2. 建单层:cart-checkout 渠道关 → 一切都没碰就抛 RAIL_DISABLED 409(行为测试);
 *     orders-create escrow 路径硬闸位于 direct_p2p 分叉之后、钱包预检之前(源码锁)。
 *  3. 报价层:buyer-quote 显式 escrow 在 quote 即拒(不冻结死路草稿);escrow next_steps 建议只在渠道开时给(源码锁)。
 *  4. 双语:RAIL_DISABLED 进 orderErrorLookup + i18n _EN;param 已注册进 DEFAULT_PARAMS(默认 '0')。
 *  5. 垂直建单面(Codex #514 R1):二手下单 409(钱包/物品原封不动);团购创建/加入 409、渠道关时结算
 *     强制全员退款绝不建单(行为测试);RFQ 中标 helper、拍卖结算、MCP local place_order 的闸(源码锁,
 *     server.ts 内部函数不可 import)。存量退款/争议路径一概不门控。
 * Usage: npm run test:waz-escrow-rail-gate
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-wazgate-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { checkoutSelectedCart, CartCheckoutError } = await import('../src/cart-checkout.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)

const cp: Record<string, unknown> = {}
const gp = <T>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
const noTouch = (): never => { throw new Error('must not be reached while channel is off') }

// ── 1. cart-checkout:渠道关(默认)→ 第一动作即抛 RAIL_DISABLED,不 normalize、不进事务 ──
const cartArgs = {
  db, buyerId: 'buyer1', selectedItems: undefined as unknown,   // 故意非法:若 gate 不在最前,会先抛 CART_SELECTION_REQUIRED
  shippingAddress: 'addr', generateId: noTouch, checkStockAndMaybeDelist: noTouch as unknown as (p: string) => void,
  addHours: noTouch as unknown as (d: Date, h: number) => string, getProtocolParam: gp,
}
try { checkoutSelectedCart(cartArgs); ok('cart: off → throws', false) } catch (e) {
  ok('cart: default(off) → RAIL_DISABLED 409 before anything else (even before selection validation)',
    e instanceof CartCheckoutError && e.errorCode === 'RAIL_DISABLED' && e.status === 409, String(e))
}
cp['payment_rail_waz_escrow_enabled'] = 1
try { checkoutSelectedCart(cartArgs); ok('cart: on → proceeds past gate', false) } catch (e) {
  ok('cart: param=1 → gate passes (next validation fires instead)',
    e instanceof CartCheckoutError && e.errorCode === 'CART_SELECTION_REQUIRED', String(e))
}
cp['payment_rail_waz_escrow_enabled'] = 0
try { checkoutSelectedCart(cartArgs); ok('cart: 0 → throws', false) } catch (e) {
  ok('cart: explicit 0 → RAIL_DISABLED (same as absent)', e instanceof CartCheckoutError && e.errorCode === 'RAIL_DISABLED')
}

// ── 2. orders-create:escrow 硬闸源码锁(共享真值 wazEscrowChannelOn;位置 = direct_p2p 分叉之后、钱包预检之前)──
const CHN = readFileSync(new URL('../src/waz-escrow-channel.ts', import.meta.url), 'utf8')
ok('waz-escrow-channel: single truth is fail-closed (=== 1, fallback 0)', /payment_rail_waz_escrow_enabled', 0\)\) === 1/.test(CHN) && /RAIL_DISABLED/.test(CHN))
const OC = readFileSync(new URL('../src/pwa/routes/orders-create.ts', import.meta.url), 'utf8')
const iDirect = OC.indexOf("=== 'direct_p2p') return void createDirectPayResponse")
const iGate = OC.indexOf('if (!wazEscrowChannelOn(getProtocolParam)) return void res.status(409).json(WAZ_RAIL_DISABLED)')
const iWallet = OC.indexOf('SELECT balance FROM wallets WHERE user_id = ?')
ok('orders-create: gate exists (shared truth, 409 WAZ_RAIL_DISABLED)', iGate > 0)
ok('orders-create: gate sits AFTER direct_p2p fork and BEFORE the escrow wallet precheck', iDirect > 0 && iWallet > iGate && iGate > iDirect,
  `direct=${iDirect} gate=${iGate} wallet=${iWallet}`)

// ── 3. buyer-quote:显式 escrow 在 quote 即拒;escrow 建议(next_steps)只在渠道开时给 ──
const BQ = readFileSync(new URL('../src/pwa/buyer-quote.ts', import.meta.url), 'utf8')
ok('buyer-quote: explicit escrow rejected at quote when channel off', /rail === 'escrow' && !wazEscrowOn/.test(BQ) && /PAYMENT_RAIL_DISABLED/.test(BQ))
ok('buyer-quote: wazEscrowOn reads the channel param fail-closed', /payment_rail_waz_escrow_enabled', 0\)\) === 1/.test(BQ))
ok('buyer-quote: escrowAlt suggestion is conditional on the channel', /const escrowAlt = wazEscrowOn \?/.test(BQ))
ok('buyer-quote: no unconditional "use payment_rail=escrow" hint remains', !/next_steps: \[[^\]]*'use payment_rail=escrow'/.test(BQ))

// ── 4. param 注册 + 双语错误码 ──
const SV = readFileSync(new URL('../src/pwa/server.ts', import.meta.url), 'utf8')
ok("server: DEFAULT_PARAMS registers payment_rail_waz_escrow_enabled with default '0', min 0 max 1",
  /key: 'payment_rail_waz_escrow_enabled', value: '0'[^}]*min: 0, max: 1/.test(SV))
const OE = readFileSync(new URL('../src/pwa/public/app-order-errors.js', import.meta.url), 'utf8')
ok('order-errors: RAIL_DISABLED mapped bilingual', /RAIL_DISABLED: t\('WAZ 模拟托管轨已下架/.test(OE))
const I18N = readFileSync(new URL('../src/pwa/public/i18n.js', import.meta.url), 'utf8')
ok('i18n: RAIL_DISABLED zh string has _EN entry', I18N.includes("'WAZ 模拟托管轨已下架,请选择直付方式下单':"))
// 菜单层与选择层同闸:choose-payment 复用 sellerSupportedPaymentOptions(菜单源头即真值)
const CPY = readFileSync(new URL('../src/pwa/order-submit-choose-payment.ts', import.meta.url), 'utf8')
ok('choose-payment: re-validates against sellerSupportedPaymentOptions (menu gate covers the choose path)', /sellerSupportedPaymentOptions\(db, \{/.test(CPY))
const DPO = readFileSync(new URL('../src/direct-pay-payment-options.ts', import.meta.url), 'utf8')
ok('payment-options: escrow push is channel-gated fail-closed', /payment_rail_waz_escrow_enabled', 0\)\) === 1/.test(DPO))

// ── 5. 垂直建单面(Codex #514 R1 BLOCKERs)──────────────────────────────────────────────
const express = (await import('express')).default
const { registerSecondhandRoutes } = await import('../src/pwa/routes/secondhand.js')
const { registerGroupBuysRoutes, settleGroupBuy } = await import('../src/pwa/routes/group-buys.js')

let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
const mkUser = (id: string, bal = 100): void => {
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES (?,?,'buyer',?)").run(id, id, 'k_' + id)
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,?)').run(id, bal)
}
mkUser('shBuyer'); mkUser('shSeller'); mkUser('gbSeller'); mkUser('gbA'); mkUser('gbB')
const testAuth = (req: { headers: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }): Record<string, unknown> | null => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.headers['x-test-user'] || '')) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'login required' }); return null }
  return u
}
const app = express(); app.use(express.json())
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerSecondhandRoutes(app, { db, generateId: genId, auth: testAuth as any, errorRes: () => {}, getProtocolParam: gp })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerGroupBuysRoutes(app, { db, generateId: genId, auth: testAuth as any, isTrustedRole: () => false, errorRes: () => {}, broadcastSystemEvent: () => {}, getProtocolParam: gp })
const srv = app.listen(0)
const port = (srv.address() as { port: number }).port
const post = async (path: string, body: Record<string, unknown>, userId: string): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': userId }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json() as Record<string, unknown> }
}

// 二手:渠道关 → 409;物品仍 available、买家钱包分文未动
delete cp['payment_rail_waz_escrow_enabled']
db.prepare("INSERT INTO secondhand_items (id, seller_id, title, category, condition_grade, price, status, fulfillment) VALUES ('sh1','shSeller','旧键盘','computer','like_new',30,'available','shipping')").run()
const shOff = await post('/api/secondhand/sh1/order', { shipping_address: 'addr', fulfillment_mode: 'shipping' }, 'shBuyer')
const shWallet = db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id = ?').get('shBuyer') as { balance: number; escrowed: number }
ok('secondhand: off → 409 RAIL_DISABLED', shOff.status === 409 && shOff.json.error_code === 'RAIL_DISABLED', JSON.stringify(shOff))
ok('secondhand: off → item untouched + wallet untouched', (db.prepare("SELECT status FROM secondhand_items WHERE id='sh1'").get() as { status: string }).status === 'available' && shWallet.balance === 100 && Number(shWallet.escrowed || 0) === 0)
cp['payment_rail_waz_escrow_enabled'] = 1
for (const col of ['sponsor_id TEXT', 'sponsor_path TEXT']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
// orders 的 server-inline 增量列 + notifications(最小 fixture 手动补齐,与生产同名)
for (const col of ['snapshot_commission_rate REAL', 'buyer_region TEXT', 'source TEXT', 'fulfillment_mode TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
initNotificationSchema(db)
const shOn = await post('/api/secondhand/sh1/order', { shipping_address: 'addr', fulfillment_mode: 'shipping' }, 'shBuyer')
const shOnWallet = db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id = ?').get('shBuyer') as { balance: number; escrowed: number }
ok('secondhand: on → REAL order created through the gate (wallet debited into escrow)', shOn.json.success === true && shOnWallet.balance === 70 && Number(shOnWallet.escrowed) === 30, JSON.stringify({ shOn, shOnWallet }))

// 团购:渠道关 → 创建/加入 409;渠道关时结算 = 即使满员也强制全员退款、绝不建单
// (group_buys 两表建在 server.ts inline,不在 schema helpers → 测试镜像建表)
db.exec(`CREATE TABLE IF NOT EXISTS group_buys (
  id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, product_id TEXT NOT NULL, variant_id TEXT,
  target_count INTEGER NOT NULL, discount_pct REAL NOT NULL, ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), settled_at TEXT)`)
db.exec(`CREATE TABLE IF NOT EXISTS group_buy_participants (
  id TEXT PRIMARY KEY, group_buy_id TEXT NOT NULL, buyer_id TEXT NOT NULL, shipping_address TEXT NOT NULL,
  escrow_amount REAL NOT NULL, order_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), UNIQUE(group_buy_id, buyer_id))`)
delete cp['payment_rail_waz_escrow_enabled']
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('gbP','gbSeller','团品','d',20,50,'active')").run()
const gbCreateOff = await post('/api/group-buys', { product_id: 'gbP', target_count: 2, discount_pct: 0.1 }, 'gbSeller')
ok('group-buy: off → create 409 RAIL_DISABLED', gbCreateOff.status === 409 && gbCreateOff.json.error_code === 'RAIL_DISABLED', JSON.stringify(gbCreateOff))
db.prepare("INSERT INTO group_buys (id, seller_id, product_id, target_count, discount_pct, ends_at, status) VALUES ('gb1','gbSeller','gbP',2,0.1,datetime('now','+1 day'),'active')").run()
const gbJoinOff = await post('/api/group-buys/gb1/join', { shipping_address: 'addr' }, 'gbA')
ok('group-buy: off → join 409 RAIL_DISABLED (no new principal enters escrow)', gbJoinOff.status === 409 && gbJoinOff.json.error_code === 'RAIL_DISABLED', JSON.stringify(gbJoinOff))
// 存量参与者(渠道开时已入 escrow)→ 渠道关时结算:满员也全员退款,不建 escrow 单
for (const [pid, uid] of [['gbp1', 'gbA'], ['gbp2', 'gbB']] as const) {
  db.prepare("INSERT INTO group_buy_participants (id, group_buy_id, buyer_id, shipping_address, escrow_amount, status) VALUES (?,?,?,'addr',20,'pending')").run(pid, 'gb1', uid)
  db.prepare('UPDATE wallets SET balance = balance - 20, escrowed = escrowed + 20 WHERE user_id = ?').run(uid)
}
const ordersBefore = (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n
settleGroupBuy(db, genId, () => {}, 'gb1', gp)
const gbAfter = db.prepare("SELECT status FROM group_buys WHERE id='gb1'").get() as { status: string }
const gbAWallet = db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id = ?').get('gbA') as { balance: number; escrowed: number }
ok('group-buy: off + target met → FORCED full refund, zero orders created', gbAfter.status === 'failed' && (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n === ordersBefore && gbAWallet.balance === 100 && Number(gbAWallet.escrowed) === 0,
  JSON.stringify({ gbAfter, gbAWallet }))

// RFQ 中标 helper / 拍卖结算 / MCP local place_order:server 内部函数不可 import → 源码锁
const iAwardFn = SV.indexOf('function awardBidAndCreateOrder')
const iAwardGate = SV.indexOf('!wazEscrowChannelOn(getProtocolParam)', iAwardFn)
const iAwardInsert = SV.indexOf('INSERT INTO orders', iAwardFn)
ok('server: awardBidAndCreateOrder gated at top, before its orders INSERT', iAwardFn > 0 && iAwardGate > iAwardFn && iAwardInsert > iAwardGate, `fn=${iAwardFn} gate=${iAwardGate} ins=${iAwardInsert}`)
const iSettleFn = SV.indexOf('function settleAuctionInner')
const iSettleGate = SV.indexOf('settleAuctionRailDisabledRefund(db, generateId, aucId, auc, winner)', iSettleFn)
const iSettleInsert = SV.indexOf('INSERT INTO orders', iSettleFn)
ok('server: settleAuctionInner routes to the fund-return terminal BEFORE the settle INSERT', iSettleFn > 0 && iSettleGate > iSettleFn && iSettleInsert > iSettleGate, `fn=${iSettleFn} gate=${iSettleGate} ins=${iSettleInsert}`)
ok('channel module: auction refund terminal keeps the CAS reread (idempotence) + never rescues into an order', /settleAuctionRailDisabledRefund/.test(CHN) && /cur\.status !== 'open'\) throw new Error\('concurrent_settle_skip'\)/.test(CHN) && !/INSERT INTO orders/.test(CHN))
const MCP = readFileSync(new URL('../src/layer1-agent/L1-1-mcp-server/server.ts', import.meta.url), 'utf8')
ok('mcp local place_order: reads protocol_params fail-closed before its orders INSERT',
  /SELECT value FROM protocol_params WHERE key = 'payment_rail_waz_escrow_enabled'/.test(MCP) && /railParam\?\.value \?\? 0\) !== 1\) return \{ error/.test(MCP))
// 团购结算的强制退款语义源码锁(targetMet 与渠道合取)
const GB = readFileSync(new URL('../src/pwa/routes/group-buys.ts', import.meta.url), 'utf8')
ok('group-buys: settle targetMet is conjunctive with the channel switch', /joined >= Number\(gb\.target_count\) && wazEscrowChannelOn\(getProtocolParam\)/.test(GB))

srv.close()

// ── 6. MCP local/sandbox place_order(Codex #514 R2 HIGH):渠道关 → RAIL_DISABLED 且【绝不消费】
//      一次性锁价 token(闸必须先于 price_sessions.used_at 写)。行为 + 源码顺序双锁。──────────
process.env.WEBAZ_MODE = 'sandbox'   // 此前未 import 过 mcp 模块;sandbox 走本地直建路径(被测分支)
const mcpMod = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { handlePlaceOrder: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }
db.exec(`CREATE TABLE IF NOT EXISTS price_sessions (token TEXT PRIMARY KEY, product_id TEXT NOT NULL, user_id TEXT NOT NULL,
  price REAL NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`)
mkUser('mcpBuyer')
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('mcpSeller','mcpSeller','seller','k_mcpSeller')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('mcpP','mcpSeller','MCP品','d',10,5,'active')").run()
db.prepare("INSERT INTO price_sessions (token, product_id, user_id, price, quantity, created_at, expires_at) VALUES ('ps_tok','mcpP','mcpBuyer',10,1,datetime('now'),datetime('now','+10 minutes'))").run()
// protocol_params 本地库无该行 → fail-closed 默认关(这就是 sandbox 现实:server DEFAULT_PARAMS 不在此库)
const mcpOff = await mcpMod.handlePlaceOrder({ api_key: 'k_mcpBuyer', product_id: 'mcpP', quantity: 1, session_token: 'ps_tok', shipping_address: 'addr' })
const psRow = db.prepare("SELECT used_at FROM price_sessions WHERE token='ps_tok'").get() as { used_at: string | null }
const mcpWallet = db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id = ?').get('mcpBuyer') as { balance: number; escrowed: number }
ok('mcp local: off → RAIL_DISABLED', mcpOff.error_code === 'RAIL_DISABLED', JSON.stringify(mcpOff))
ok('mcp local: off → price session NOT consumed (used_at stays NULL)', psRow.used_at === null, JSON.stringify(psRow))
ok('mcp local: off → wallet + orders untouched', mcpWallet.balance === 100 && Number(mcpWallet.escrowed || 0) === 0)
// 源码顺序锁:闸必须位于 session 消费写(UPDATE price_sessions SET used_at)之前
const iMcpFn = MCP.indexOf('export async function handlePlaceOrder')
const iMcpGate = MCP.indexOf("payment_rail_waz_escrow_enabled'", iMcpFn)
const iMcpConsume = MCP.indexOf('UPDATE price_sessions SET used_at', iMcpFn)
ok('mcp local: gate sits BEFORE the one-shot session consumption in source', iMcpFn > 0 && iMcpGate > iMcpFn && iMcpConsume > iMcpGate, `fn=${iMcpFn} gate=${iMcpGate} consume=${iMcpConsume}`)
// 渠道开(本地库写入 param 行)→ 同一 token 仍有效可用,穿闸进入真实路径
db.prepare("INSERT INTO protocol_params (key, value, type, description, category) VALUES ('payment_rail_waz_escrow_enabled','1','number','t','system')").run()
const mcpOn = await mcpMod.handlePlaceOrder({ api_key: 'k_mcpBuyer', product_id: 'mcpP', quantity: 1, session_token: 'ps_tok', shipping_address: 'addr' })
ok('mcp local: on → gate passes and the preserved token is honored (order or non-RAIL error)', mcpOn.error_code !== 'RAIL_DISABLED', JSON.stringify(mcpOn).slice(0, 200))

if (fail > 0) { console.error(`\n❌ waz-escrow-rail-gate FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ waz-escrow-rail-gate: channel switch default OFF — menu delisted + quote rejects + create/cart 409 RAIL_DISABLED, bilingual mapped, param registered\n  ✅ pass ${pass}`)
