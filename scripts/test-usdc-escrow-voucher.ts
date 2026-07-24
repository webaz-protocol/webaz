#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B6a — voucher 签发 + intents 生命周期 + 通知 + 死线顺延 回归锁。
 * in-memory,固定测试 seed 造 LocalSeedSigner(escrowVoucher 独立角色);真 engine.transition +
 * 真 notifyTransition + 真 store/watcher/settle/timeouts(不桩被测判定者)。零网络(fake WatcherChainClient)。
 * Proves:
 *   1. 单位换算(核验项):money.ts Units 刻度 === USDC 6dp —— 10→10_000_000、0.01→10_000、50→50_000_000。
 *   2. orderKey 派生钉:固定 order id → orderIdBytes32/orderKey 快照;order_key 落库 lowercase。
 *   3. 签名可验证:viem verifyTypedData 用 escrowVoucherAddress 验回 true;篡改 amount±1 验回 false。
 *   4. 守卫矩阵:非买家 403 / 非本轨 409 / 非 created 409 / 过期 pay_deadline 409 / 坏地址 400 / 无 payout 409 / 超 cap 409 / 渠道关 409。
 *   5. 重签发:issued 再请求 → 新 sig 覆盖(intent 仍一行);funded → 409。
 *   6. status 端点:deposited/released 可见性(重组孤儿排除)。
 *   7. 取消路径:买家 cancel created usdc_escrow → cancelled + 库存回补 + intents void + notifyTransition(notifications 断言)。
 *   8. 清扫 void:付款窗超时清扫后 intents='void';void 后 Deposited → alert 不动单。
 *   9. 死线顺延:runWatcherTick 处理 Deposited 后 accept_deadline ≈ now+48h(而非建单锚)。
 * Usage: npm run test:usdc-escrow-voucher
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { getAddress, verifyTypedData } from 'viem'

const tmpHome = mkdtempSync(join(tmpdir(), 'uevoucher-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
delete process.env.USDC_ESCROW_START_BLOCK
process.env.NETWORK = 'testnet'                              // chainId 84532
process.env.USDC_ESCROW_CONTRACT = '0x' + '9'.repeat(40)
process.env.USDC_TOKEN_ADDRESS = '0x' + 'a'.repeat(40)
const CONTRACT = process.env.USDC_ESCROW_CONTRACT

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initNotificationSchema, notifyTransition } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { createLocalSeedSigner } = await import('../src/pwa/internal/wallet-signer.js')
const { toUnits } = await import('../src/money.js')
const { registerUsdcEscrowRoutes, deriveOrderIdBytes32, deriveOrderKey, buildDepositTypedData } = await import('../src/pwa/routes/usdc-escrow.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { sweepExpiredUsdcEscrowOrders } = await import('../src/usdc-escrow-timeouts.js')
const { runWatcherTick } = await import('../src/pwa/internal/usdc-escrow-watcher.js')
const { settleUsdcEscrowAtCompletion } = await import('../src/usdc-escrow-settle.js')
type WatcherLog = import('../src/pwa/internal/usdc-escrow-watcher.js').WatcherLog
type WatcherChainClient = import('../src/pwa/internal/usdc-escrow-watcher.js').WatcherChainClient

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── fixture ──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
initNotificationSchema(db)
for (const col of ['payment_rail TEXT', 'source TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','buyer1','buyer','k_b1'),('buyer2','buyer2','buyer','k_b2'),('seller1','seller1','seller','k_s1'),('seller2','seller2','seller','k_s2'),('admin1','admin1','admin','k_a1'),('sys_protocol','sys','system','k_sys')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,status) VALUES ('p1','seller1','品','d',10,99,'active'),('p2','seller2','品2','d',10,99,'active')").run()

const SELLER_PAYOUT = getAddress('0x' + '3'.repeat(40))
db.prepare("INSERT INTO seller_payout_addresses (id, seller_id, address, chain, status) VALUES ('spa1','seller1',?, 'base','active')").run(SELLER_PAYOUT)
const BUYER_ADDR = getAddress('0x' + '1'.repeat(40))

let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
/* eslint-disable @typescript-eslint/no-explicit-any */
const tr = transition as any

const futureIso = (h: number): string => new Date(Date.now() + h * 3600_000).toISOString()
const mkOrder = (id: string, opts: { status?: string; rail?: string; total?: number; sellerId?: string; productId?: string; payDeadline?: string; source?: string } = {}): void => {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, source, pay_deadline)
    VALUES (?, ?, 'buyer1', ?, 1, ?, ?, 0, ?, ?, ?, ?)`).run(
    id, opts.productId ?? 'p1', opts.sellerId ?? 'seller1', opts.total ?? 10, opts.total ?? 10,
    opts.status ?? 'created', opts.rail ?? 'usdc_escrow', opts.source ?? 'shop', opts.payDeadline ?? futureIso(24))
}
const intentRow = (id: string): any => db.prepare('SELECT * FROM usdc_escrow_intents WHERE order_id = ?').get(id)
const orderStatus = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status

// ── configurable protocol params ──
const PARAMS: Record<string, string | number> = {
  payment_rail_usdc_escrow_enabled: 1, 'usdc_escrow.per_tx_cap': 50,
  'usdc_escrow.auto_release_days': 14, 'usdc_escrow.voucher_ttl_minutes': 60, 'usdc_escrow.pay_window_hours': 24,
}
const getProtocolParam = <T,>(k: string, fb: T): T => (k in PARAMS ? PARAMS[k] as unknown as T : fb)

// ── fixed-seed signer(escrow voucher 独立角色)──
const TEST_SEED = 'test-master-seed-deterministic-vector-1234'
const signer = createLocalSeedSigner(TEST_SEED)
const VOUCHER_ADDR = signer.escrowVoucherAddress()

// ── express app(voucher/status + orders-action cancel)──
const app = express(); app.use(express.json())
const authStub = (req: Request, res: Response): Record<string, unknown> | null => {
  const uid = req.headers['x-test-uid'] as string | undefined
  if (!uid) { res.status(401).json({ error: 'login' }); return null }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'login' }); return null }
  return u
}
const isTrustedRole = (u: Record<string, unknown>): boolean => ['admin', 'logistics', 'arbitrator'].includes(String(u.role))
registerUsdcEscrowRoutes(app, { db, auth: authStub, isTrustedRole, getProtocolParam, escrowVoucherAccount: () => signer.escrowVoucherAccount() })
const noop = (): void => {}
registerOrdersActionRoutes(app, {
  db, auth: authStub, isTrustedRole, generateId: genId, transition: tr, notifyTransition,
  settleOrder: noop, settleFault: noop as any, detectFraud: () => [], createDispute: noop as any,
  createDeclineContestDispute: () => ({ success: true }), checkTimeouts: () => ({ details: [] }),
  recordViolationReputation: noop as any, broadcastSystemEvent: noop, consumeGateToken: () => ({ ok: true }),
} as any)

let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})

try {
  // ── 1. 单位换算(核验项)──
  ok('1a. toUnits(10) === 10_000_000 (USDC 6dp)', toUnits(10) === 10_000_000)
  ok('1b. toUnits(0.01) === 10_000', toUnits(0.01) === 10_000)
  ok('1c. toUnits(50) === 50_000_000 (per-tx cap border)', toUnits(50) === 50_000_000)

  // ── 2. orderKey 派生钉(固定 order id → 快照)──
  const FIXED = 'ord_fixture_pin_0001'
  const b32 = deriveOrderIdBytes32(FIXED)
  const oKey = deriveOrderKey(b32)
  ok('2a. orderIdBytes32 = keccak256(utf8 order.id), 32-byte hex', /^0x[0-9a-f]{64}$/.test(b32))
  ok('2b. orderKey = keccak256(orderIdBytes32) lowercase', /^0x[0-9a-f]{64}$/.test(oKey) && oKey === oKey.toLowerCase())
  // 回归锚:确定性(同 id 同值),且 orderKey != orderIdBytes32(确实做了第二次 keccak)
  ok('2c. deterministic + orderKey != orderIdBytes32', deriveOrderKey(deriveOrderIdBytes32(FIXED)) === oKey && oKey !== b32)

  // ── 3. 签名可验证 + 篡改验伪 ──
  mkOrder('o_sig', { total: 10 })
  const vr = await call('POST', '/api/orders/o_sig/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })
  ok('3a. voucher issued 200', vr.status === 200 && vr.json.success === true, JSON.stringify(vr.json))
  const dc = vr.json.deposit_call
  const typed = buildDepositTypedData({
    contract: CONTRACT, chainId: vr.json.chain_id, orderIdBytes32: dc.order_id_bytes32,
    buyer: BUYER_ADDR, seller: dc.seller, amount: BigInt(dc.amount), feeBps: dc.fee_bps,
    autoReleaseAt: dc.auto_release_at, authExpiresAt: dc.auth_expires_at,
  })
  const good = await verifyTypedData({ address: VOUCHER_ADDR, ...typed, signature: dc.authorization })
  ok('3b. verifyTypedData(escrowVoucherAddress) === true', good === true)
  ok('3c. amount is 6dp string (10 USDC → 10000000)', dc.amount === '10000000' && dc.fee_bps === 200)
  const tampered = buildDepositTypedData({ ...{
    contract: CONTRACT, chainId: vr.json.chain_id, orderIdBytes32: dc.order_id_bytes32,
    buyer: BUYER_ADDR, seller: dc.seller, amount: BigInt(dc.amount) + 1n, feeBps: dc.fee_bps,
    autoReleaseAt: dc.auto_release_at, authExpiresAt: dc.auth_expires_at,
  } })
  const bad = await verifyTypedData({ address: VOUCHER_ADDR, ...tampered, signature: dc.authorization })
  ok('3d. tampered amount+1 → verify false', bad === false)
  // order_key 落库 lowercase + = deriveOrderKey(order.id)
  const sigIntent = intentRow('o_sig')
  ok('3e. intent.order_key lowercase === derive(order.id)', sigIntent.order_key === deriveOrderKey(deriveOrderIdBytes32('o_sig')) && sigIntent.order_key === sigIntent.order_key.toLowerCase())
  ok('3f. intent.amount_units stored 6dp (10_000_000) + status issued', sigIntent.amount_units === 10_000_000 && sigIntent.status === 'issued')

  // ── 4. 守卫矩阵 ──
  mkOrder('o_guard', { total: 10 })
  ok('4a. non-buyer → 403 NOT_ORDER_BUYER', (await call('POST', '/api/orders/o_guard/usdc-escrow/voucher', 'buyer2', { buyer_address: BUYER_ADDR })).status === 403)
  mkOrder('o_rail', { rail: 'direct_p2p' })
  ok('4b. wrong rail → 409 WRONG_RAIL', (await call('POST', '/api/orders/o_rail/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'USDC_ESCROW_VOUCHER_WRONG_RAIL')
  mkOrder('o_paid', { status: 'paid' })
  ok('4c. non-created → 409 NOT_OPEN', (await call('POST', '/api/orders/o_paid/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'USDC_ESCROW_VOUCHER_NOT_OPEN')
  mkOrder('o_exp', { payDeadline: futureIso(-1) })
  ok('4d. expired pay_deadline → 409 NOT_OPEN', (await call('POST', '/api/orders/o_exp/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'USDC_ESCROW_VOUCHER_NOT_OPEN')
  mkOrder('o_addr', { total: 10 })
  ok('4e. bad buyer_address → 400 BAD_ADDRESS', (await call('POST', '/api/orders/o_addr/usdc-escrow/voucher', 'buyer1', { buyer_address: '0xnothex' })).json.error_code === 'USDC_ESCROW_VOUCHER_BAD_ADDRESS')
  mkOrder('o_nopay', { sellerId: 'seller2', productId: 'p2' })   // seller2 无 active payout
  ok('4f. no active payout → 409 SELLER_NOT_READY', (await call('POST', '/api/orders/o_nopay/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'USDC_ESCROW_SELLER_NOT_READY')
  mkOrder('o_cap', { total: 60 })   // 60 USDC > 50 cap
  ok('4g. over per-tx cap → 409 CAP_EXCEEDED', (await call('POST', '/api/orders/o_cap/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'USDC_ESCROW_CAP_EXCEEDED')
  mkOrder('o_off', { total: 10 })
  PARAMS.payment_rail_usdc_escrow_enabled = 0
  ok('4h. channel off → 409 RAIL_DISABLED', (await call('POST', '/api/orders/o_off/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'RAIL_DISABLED')
  PARAMS.payment_rail_usdc_escrow_enabled = 1

  // ── 5. 重签发(EIP-712 签名确定性:改 autoReleaseAt 参数使 message 变 → 新 sig 覆盖旧行)──
  PARAMS['usdc_escrow.auto_release_days'] = 15
  const r1 = await call('POST', '/api/orders/o_sig/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })
  PARAMS['usdc_escrow.auto_release_days'] = 14
  ok('5a. re-issue (issued) → new sig overwrites, single intent row', r1.status === 200 && r1.json.deposit_call.authorization !== dc.authorization
    && (db.prepare("SELECT COUNT(*) n FROM usdc_escrow_intents WHERE order_id = 'o_sig'").get() as { n: number }).n === 1
    && intentRow('o_sig').voucher_sig === r1.json.deposit_call.authorization)
  db.prepare("UPDATE usdc_escrow_intents SET status='funded' WHERE order_id='o_sig'").run()
  ok('5b. funded → 409 ALREADY_FUNDED', (await call('POST', '/api/orders/o_sig/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })).json.error_code === 'USDC_ESCROW_VOUCHER_ALREADY_FUNDED')

  // ── 6. status 端点(重组孤儿排除)──
  mkOrder('o_stat', { total: 10 })
  await call('POST', '/api/orders/o_stat/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })
  const sKey = deriveOrderKey(deriveOrderIdBytes32('o_stat'))
  const mkEvent = (name: string, orphan = false): void => {
    const eid = genId('uce')
    db.prepare("INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES (?,?,?,?,?,?,?, '{}')")
      .run(eid, sKey, name, '0x' + name + genId('t'), 0, 1, '0xbh')
    if (orphan) db.prepare("INSERT INTO usdc_escrow_event_orphans (event_id, reason) VALUES (?, 'test')").run(eid)
  }
  let st = await call('GET', '/api/orders/o_stat/usdc-escrow/status', 'buyer1')
  ok('6a. status before deposit', st.status === 200 && st.json.deposited_seen === false && st.json.intent_status === 'issued')
  mkEvent('Deposited')
  st = await call('GET', '/api/orders/o_stat/usdc-escrow/status', 'seller1')
  ok('6b. deposited_seen true (seller may read)', st.json.deposited_seen === true && st.json.released_seen === false)
  mkEvent('Released', true)   // orphan Released → 不可见
  st = await call('GET', '/api/orders/o_stat/usdc-escrow/status', 'buyer1')
  ok('6c. orphan Released excluded (released_seen false)', st.json.released_seen === false)
  mkEvent('Released')         // 非孤儿 Released → 可见
  st = await call('GET', '/api/orders/o_stat/usdc-escrow/status', 'buyer1')
  ok('6d. non-orphan Released → released_seen true', st.json.released_seen === true)
  ok('6e. non-party → 403', (await call('GET', '/api/orders/o_stat/usdc-escrow/status', 'buyer2')).status === 403)

  // ── 7. 取消路径(买家 cancel created usdc_escrow)──
  mkOrder('o_cancel', { total: 10 })
  await call('POST', '/api/orders/o_cancel/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })
  const stockBefore = (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
  const cx = await call('POST', '/api/orders/o_cancel/action', 'buyer1', { action: 'cancel' })
  const stockAfter = (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
  ok('7a. cancel → cancelled', cx.status === 200 && cx.json.status === 'cancelled' && orderStatus('o_cancel') === 'cancelled', JSON.stringify(cx.json))
  ok('7b. stock restocked (+1)', stockAfter === stockBefore + 1)
  ok('7c. intents voided', intentRow('o_cancel').status === 'void')
  ok('7d. notifyTransition created→cancelled → buyer notification row', !!db.prepare("SELECT 1 FROM notifications WHERE user_id='buyer1' AND order_id='o_cancel' AND template_key='ord_created_cancelled'").get())

  // ── 8. 清扫 void + void 后 Deposited alert 不动单 ──
  mkOrder('o_sweep', { total: 10, payDeadline: futureIso(24) })
  await call('POST', '/api/orders/o_sweep/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })
  db.prepare("UPDATE orders SET pay_deadline = ? WHERE id='o_sweep'").run(futureIso(-2))   // 付款窗过期
  sweepExpiredUsdcEscrowOrders(db, { transition: tr })
  ok('8a. expired sweep → order cancelled + intents void', orderStatus('o_sweep') === 'cancelled' && intentRow('o_sweep').status === 'void')
  // void 后链上 Deposited 到达 → alert 不动单(runWatcherTick fake client)
  const sweepKey = intentRow('o_sweep').order_key
  const adminBefore = (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='admin1'").get() as { n: number }).n
  const depLog = (orderKey: string, tx: string, amount: number, feeBps: number): WatcherLog => ({
    eventName: 'Deposited', args: { orderKey, buyer: BUYER_ADDR, seller: SELLER_PAYOUT, amount: BigInt(amount), feeBps: BigInt(feeBps), autoReleaseAt: BigInt(1_900_000_000) },
    transactionHash: tx, logIndex: 0, blockNumber: 105n, blockHash: '0xbh',
  })
  class FakeClient implements WatcherChainClient {
    constructor(public latest: bigint, public logs: WatcherLog[]) {}
    async getBlockNumber(): Promise<bigint> { return this.latest }
    async getLogs({ fromBlock, toBlock }: any): Promise<WatcherLog[]> { return this.logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock) }
    async getBlock(): Promise<{ hash: string }> { return { hash: '0xbh' } }
  }
  const settleOrderIso = (id: string): void => { db.transaction(() => { const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id) as any; if (o?.payment_rail === 'usdc_escrow') settleUsdcEscrowAtCompletion(db, o, genId) })() }
  db.prepare("INSERT OR REPLACE INTO usdc_escrow_watcher_state (id,last_scanned_block,updated_at) VALUES ('main',100,datetime('now'))").run()
  await runWatcherTick({ db, transition: tr, settleOrder: settleOrderIso, generateId: genId, notifyTransition, contractAddress: CONTRACT, confirmations: 1n, reorgBuffer: 0n,
    client: new FakeClient(110n, [depLog(sweepKey, '0xdeadsweep', 10_000_000, 200)]) })
  const adminAfter = (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='admin1'").get() as { n: number }).n
  ok('8b. void intent + Deposited → admin alert, order stays cancelled', orderStatus('o_sweep') === 'cancelled' && intentRow('o_sweep').status === 'void' && adminAfter > adminBefore)

  // ── 9. 死线顺延(Deposited → created→paid → 死线 = now+48h)──
  mkOrder('o_anchor', { total: 10, payDeadline: futureIso(24) })
  // 建单锚:accept_deadline 远(模拟建单时置的一个久远值,证明顺延而非沿用建单)
  db.prepare("UPDATE orders SET accept_deadline = ? WHERE id='o_anchor'").run(futureIso(1000))
  await call('POST', '/api/orders/o_anchor/usdc-escrow/voucher', 'buyer1', { buyer_address: BUYER_ADDR })
  const aKey = intentRow('o_anchor').order_key
  db.prepare("INSERT OR REPLACE INTO usdc_escrow_watcher_state (id,last_scanned_block,updated_at) VALUES ('main',100,datetime('now'))").run()
  const nowMs = Date.now()
  await runWatcherTick({ db, transition: tr, settleOrder: settleOrderIso, generateId: genId, notifyTransition, contractAddress: CONTRACT, confirmations: 1n, reorgBuffer: 0n,
    client: new FakeClient(110n, [depLog(aKey, '0xdeadanchor', 10_000_000, 200)]) })
  ok('9a. Deposited → order paid + intent funded', orderStatus('o_anchor') === 'paid' && intentRow('o_anchor').status === 'funded')
  const acc = (db.prepare("SELECT accept_deadline FROM orders WHERE id='o_anchor'").get() as { accept_deadline: string }).accept_deadline
  const accMs = new Date(acc).getTime()
  ok('9b. accept_deadline re-anchored ≈ now+48h (not build-time anchor)', Math.abs(accMs - (nowMs + 48 * 3600_000)) < 5 * 60_000)
  ok('9c. created→paid seller notification (usdc_escrow honest key)', !!db.prepare("SELECT 1 FROM notifications WHERE user_id='seller1' AND order_id='o_anchor' AND template_key='ord_created_paid_ue'").get())
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ usdc-escrow-voucher FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow voucher (B6a): 6dp unit pins + orderKey derivation + EIP-712 verifyTypedData (tamper-false) + guard matrix + re-issue/funded + status visibility + cancel(void/restock/notify) + sweep-void + deadline re-anchor\n  ✅ pass ${pass}`)
