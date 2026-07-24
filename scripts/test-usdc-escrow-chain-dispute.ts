#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B7b-1 — 链驱动开争议(方案 A,状态机敏感)行为回归锁。
 *
 * 语义:usdc_escrow 订单的 DB `disputed` 由【链上 Disputed 事件】驱动(链是本轨权威;链上 flagDispute 是
 *   密码学可归因的真实争议动作),以链上 tx 作真实证据;唯一生产调用方 = usdc watcher。打通「不合作/丢钱包
 *   买家」→ admin B7a resolve(要求 DB disputed)的端到端缺口。裁决仍唯经 B7a Passkey 路由。
 *
 * fixture 照 test-usdc-escrow-settle.ts:in-memory 库、initDatabase(基础表)+ applyWebazRuntimeSchema(usdc 五表)
 * + initDisputeSchema(disputes 扩展列)+ initNotificationSchema、真 engine.transition、真 createDispute、
 * 真 arbitrateDispute、真 checkDisputeTimeouts、fake watcher client。sys_protocol role='system'。
 *
 * Proves:
 *   1. 买家 flag(by=买家地址)Disputed → 订单 delivered→disputed;disputes 行建(被诉=卖家、initiator=sys_protocol、
 *      status='open');证据 = 链上 tx(file_hash=tx、描述含 tx+by);【全】wallets 表逐行前后字节相等(零 wallets 写)。
 *   2. arbiter flag(by=arbiter 地址)Disputed → 同样进 disputed、被诉=卖家。
 *   3. 端到端缺口闭合:非合作买家 —— admin flag(链上)→ driver → disputed → B7a Resolved(全退 buyerRefund==amount)
 *      → applyUsdcEscrowResolved → disputed→cancelled(收敛终态)。串起来跑通。
 *   4. 幂等:买家已在 App 自开争议(order 已 disputed + 已有 dispute 行)后再来 Disputed 事件 → no-op,
 *      不重复建争议、不新增证据、不报错。重放(连驱两次)同样只建一条。
 *   5. rail-scope 铁律:非 usdc 轨(direct_p2p)的 system 发起方 createDispute 仍拒(此角色不能发起争议);
 *      源码锁:applyUsdcEscrowDisputed 的唯一非测试调用方 = watcher(grep 证明)。
 *   6. 三处拒绝未回归:usdc disputed 单跑 arbitrate() → 仍 success:false(链上仲裁,接线中);
 *      超时 sweep checkDisputeTimeouts 不 error-loop(不抛、不裁决、dispute 仍 open、order 仍 disputed)。
 *   7. 守恒/终态:全退→cancelled(测 3),部分退→completed(disputed→completed,承接 B7a applyUsdcEscrowResolved)。
 *   8. 非 flag 态(如 confirmed)收到 Disputed → 不强转、告警;未知 order_key → 告警 only。
 *   9. watcher 接线:runWatcherTick 注入 fake client 发一条 Disputed log → 订单进 disputed(证明生产接线点)。
 * Usage: npm run test:usdc-escrow-chain-dispute
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const tmpHome = mkdtempSync(join(tmpdir(), 'uecd-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { createDispute, initDisputeSchema, arbitrateDispute, checkDisputeTimeouts } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { applyUsdcEscrowDisputed, applyUsdcEscrowResolved, alertUsdcAdmins } = await import('../src/usdc-escrow-settle.js')
const { runWatcherTick } = await import('../src/pwa/internal/usdc-escrow-watcher.js')
type DisputedEventRow = import('../src/usdc-escrow-settle.js').DisputedEventRow
type ResolvedEventRow = import('../src/usdc-escrow-settle.js').ResolvedEventRow
type UsdcDisputeDeps = import('../src/usdc-escrow-settle.js').UsdcDisputeDeps
type UsdcSettleDeps = import('../src/usdc-escrow-settle.js').UsdcSettleDeps

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── fixture ──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
initDisputeSchema(db)
initNotificationSchema(db)
for (const col of ['payment_rail TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','buyer1','buyer','k_b1'),('seller1','seller1','seller','k_s1'),('admin1','admin1','admin','k_a1'),('sys_protocol','sys','system','k_sys')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','品','d',10,99,'active')").run()
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('buyer1', 123.45, 1, 10, 2, 3)
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('seller1', 500, 7, 0, 4, 5)
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('sys_protocol', 0, 0, 0, 0, 0)

let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
/* eslint-disable @typescript-eslint/no-explicit-any */
const tr = transition as any

// 真被测判定者:真实 transition + 真实 createDispute 注入 driver(不桩)。
const disputeDeps: UsdcDisputeDeps = { transition: tr, createDispute: createDispute as any, generateId: genId }
const settleDeps: UsdcSettleDeps = { transition: tr, settleOrder: () => { throw new Error('settleOrder must NOT be called on dispute/resolve paths') }, generateId: genId }
const alert = (t: string, b: string): void => alertUsdcAdmins(db, genId, t, b)

const BUYER_ADDR = '0x' + 'b'.repeat(40)
const ARBITER_ADDR = '0x' + 'a'.repeat(40)

// ── helpers ──
const mkOrder = (id: string, status = 'delivered', rail = 'usdc_escrow'): void => {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail)
    VALUES (?, 'p1', 'buyer1', 'seller1', 1, 10, 10, 0, ?, ?)`).run(id, status, rail)
}
const mkIntent = (orderId: string, orderKey: string, opts: { amount?: number; status?: string } = {}): void => {
  db.prepare(`INSERT INTO usdc_escrow_intents
      (order_id, order_key, contract_addr, buyer_id, seller_id, seller_addr, amount_units, fee_bps, auto_release_at, voucher_sig, auth_expires_at, status)
    VALUES (?, ?, ?, 'buyer1', 'seller1', ?, ?, 500, datetime('now'), '0xsig', datetime('now'), ?)`)
    .run(orderId, orderKey.toLowerCase(), ('0x' + '9'.repeat(40)), ('0x' + '3'.repeat(40)), opts.amount ?? 10_000_000, opts.status ?? 'funded')
}
const key = (id: string): string => ('0x' + Buffer.from(id).toString('hex').padEnd(64, '0')).slice(0, 66).toLowerCase()
const mkDisputed = (orderKey: string, tx: string, by: string, block = 3000): DisputedEventRow => ({
  order_key: orderKey.toLowerCase(), tx_hash: tx.toLowerCase(), block_number: block,
  payload_json: JSON.stringify({ orderKey: orderKey.toLowerCase(), by: by.toLowerCase() }),
})
const seedResolved = (orderKey: string, tx: string, buyerRefund: bigint, sellerPaid: bigint, feePaid: bigint, block = 4000): ResolvedEventRow => {
  const payload = JSON.stringify({ orderKey: orderKey.toLowerCase(), buyerRefund: String(buyerRefund), sellerPaid: String(sellerPaid), feePaid: String(feePaid) })
  db.prepare(`INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES (?,?,?,?,?,?,?,?)`)
    .run(genId('uce'), orderKey.toLowerCase(), 'Resolved', tx.toLowerCase(), 0, block, '0xblk_' + tx, payload)
  return { order_key: orderKey.toLowerCase(), tx_hash: tx.toLowerCase(), payload_json: payload }
}
const orderStatus = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status
const disputeRows = (id: string): any[] => db.prepare('SELECT * FROM disputes WHERE order_id = ?').all(id)
const evidenceRows = (id: string): any[] => db.prepare('SELECT * FROM evidence WHERE order_id = ?').all(id)
const walletsSnap = (): string => JSON.stringify(db.prepare('SELECT * FROM wallets ORDER BY user_id').all())

// ═══════════ 1. 买家 flag(by=买家)→ delivered→disputed + dispute 行 + 证据 + 零 wallets 写 ═══════════
{
  const OID = 'ord1'; mkOrder(OID, 'delivered'); mkIntent(OID, key(OID))
  const w0 = walletsSnap()
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx1', BUYER_ADDR), alert)
  const drows = disputeRows(OID); const erows = evidenceRows(OID)
  ok('1a: order delivered→disputed', orderStatus(OID) === 'disputed')
  ok('1b: exactly one dispute row, status open', drows.length === 1 && drows[0]?.status === 'open')
  ok('1c: defendant = seller, initiator = sys_protocol', drows[0]?.defendant_id === 'seller1' && drows[0]?.initiator_id === 'sys_protocol')
  ok('1d: evidence recorded from on-chain tx (file_hash=tx, desc has tx+by)',
    erows.length === 1 && erows[0]?.file_hash === '0xtx1' && /0xtx1/.test(erows[0]?.description ?? '') && new RegExp(BUYER_ADDR).test(erows[0]?.description ?? '') && erows[0]?.uploader_id === 'sys_protocol')
  ok('1e: ZERO wallets writes (full table byte-identical)', walletsSnap() === w0)
}

// ═══════════ 2. arbiter flag(by=arbiter)→ 同样进 disputed、被诉=卖家 ═══════════
{
  const OID = 'ord2'; mkOrder(OID, 'paid'); mkIntent(OID, key(OID))
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx2', ARBITER_ADDR), alert)
  const drows = disputeRows(OID)
  ok('2a: paid→disputed via arbiter flag', orderStatus(OID) === 'disputed')
  ok('2b: defendant = seller (arbiter flag)', drows.length === 1 && drows[0]?.defendant_id === 'seller1')
  ok('2c: evidence records arbiter address', new RegExp(ARBITER_ADDR).test(evidenceRows(OID)[0]?.description))
}

// ═══════════ 3. 端到端缺口闭合:admin flag → disputed → B7a Resolved(全退)→ cancelled ═══════════
{
  const OID = 'ord3'; mkOrder(OID, 'delivered'); mkIntent(OID, key(OID), { amount: 10_000_000 })
  // 非合作买家:admin(arbiter)链上 flag → watcher driver 开 DB 争议
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx3a', ARBITER_ADDR), alert)
  ok('3a: admin flag → DB disputed (gap closed: B7a resolve now reachable)', orderStatus(OID) === 'disputed')
  // admin B7a resolve(链上 arbiterResolve 全退)→ Resolved 事件 → applyUsdcEscrowResolved → disputed→cancelled
  const rev = seedResolved(key(OID), '0xtx3b', 10_000_000n, 0n, 0n)
  applyUsdcEscrowResolved(db, settleDeps, rev, alert)
  ok('3b: full-refund Resolved → disputed→cancelled (converged terminal)', orderStatus(OID) === 'cancelled')
  ok('3c: intent → resolved', (db.prepare('SELECT status FROM usdc_escrow_intents WHERE order_id = ?').get(OID) as { status: string }).status === 'resolved')
}

// ═══════════ 4. 幂等:买家已在 App 自开争议后再来 Disputed → no-op ═══════════
{
  const OID = 'ord4'; mkOrder(OID, 'delivered'); mkIntent(OID, key(OID))
  // 买家在 App 走正常路径:先转 disputed(buyer),再 createDispute(buyer)
  const eid = genId('evt')
  db.prepare('INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash) VALUES (?,?,?,?,?,?)').run(eid, OID, 'buyer1', 'document', 'app dispute', 'h')
  tr(db, OID, 'disputed', 'buyer1', [eid], 'buyer app dispute')
  createDispute(db, OID, 'buyer1', 'app-opened', [eid])
  const d0 = disputeRows(OID).length; const e0 = evidenceRows(OID).length
  // 链上 Disputed 事件到达(买家自己 flag)→ 应 no-op
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx4', BUYER_ADDR), alert)
  ok('4a: still disputed, no duplicate dispute row', orderStatus(OID) === 'disputed' && disputeRows(OID).length === d0 && d0 === 1)
  ok('4b: no new evidence row (early no-op before evidence insert)', evidenceRows(OID).length === e0)
  // 重放同一事件两次(双 flag / 重扫)→ 仍一条
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx4', BUYER_ADDR), alert)
  ok('4c: replay idempotent (still one dispute)', disputeRows(OID).length === 1)
}

// ═══════════ 5. rail-scope 铁律 ═══════════
{
  const OID = 'ord5'; mkOrder(OID, 'disputed', 'direct_p2p'); mkIntent(OID, key(OID))
  // system 发起方对非 usdc 轨仍拒
  const r = createDispute(db, OID, 'sys_protocol', 'x', [])
  ok('5a: non-usdc rail — system initiator REFUSED', r.success === false && r.error === '此角色不能发起争议')
  ok('5b: no dispute row created for direct_p2p system attempt', disputeRows(OID).length === 0)
  // 源码锁:applyUsdcEscrowDisputed 唯一非测试调用方 = watcher
  const callers = execSync('grep -rln "applyUsdcEscrowDisputed(" src --include=*.ts', { cwd: process.cwd() }).toString().trim().split('\n').sort()
  ok('5c: only source refs = settle (def) + watcher (sole caller)',
    callers.length === 2 && callers.includes('src/usdc-escrow-settle.ts') && callers.includes('src/pwa/internal/usdc-escrow-watcher.ts'),
    'callers=' + JSON.stringify(callers))
}

// ═══════════ 6. 三处拒绝未回归:arbitrate() 仍拒 + 超时 sweep 不 error-loop ═══════════
{
  const OID = 'ord6'; mkOrder(OID, 'delivered'); mkIntent(OID, key(OID))
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx6', BUYER_ADDR), alert)
  const dsp = disputeRows(OID)[0]
  // arbitrate 对本轨仍 fail-closed(system/自动裁决绝不移动链上资金)
  const ar = dsp ? arbitrateDispute(db, dsp.id, 'sys_protocol', 'refund_buyer', 'x') : { success: false, error: 'no dispute row' }
  ok('6a: arbitrate() on usdc disputed order STILL refuses', ar.success === false && /USDC 担保/.test(ar.error || ''))
  ok('6b: order still disputed, dispute still open (no auto-ruling)', orderStatus(OID) === 'disputed' && disputeRows(OID)[0]?.status === 'open')
  // 超时 sweep:把 respond_deadline / arbitrate_deadline 推到过去,checkDisputeTimeouts 不抛、不裁决、不 error-loop
  db.prepare("UPDATE disputes SET respond_deadline = datetime('now','-1 day'), arbitrate_deadline = datetime('now','-1 day') WHERE id = ?").run(dsp?.id ?? '__none__')
  let threw = false
  try { checkDisputeTimeouts(db); checkDisputeTimeouts(db) } catch { threw = true }
  ok('6c: timeout sweep does NOT throw / error-loop', threw === false)
  ok('6d: after sweep — order still disputed, dispute still open (funds frozen on-chain, awaits B7a)', orderStatus(OID) === 'disputed' && disputeRows(OID)[0]?.status === 'open')
}

// ═══════════ 7. 守恒/终态:部分退 → disputed→completed(承接 B7a applyUsdcEscrowResolved)═══════════
{
  const OID = 'ord7'; mkOrder(OID, 'delivered'); mkIntent(OID, key(OID), { amount: 10_000_000 })
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx7a', ARBITER_ADDR), alert)
  const rev = seedResolved(key(OID), '0xtx7b', 4_000_000n, 5_950_000n, 50_000n)   // 部分退 (sum==amount)
  applyUsdcEscrowResolved(db, settleDeps, rev, alert)
  ok('7a: partial-refund Resolved → disputed→completed', orderStatus(OID) === 'completed')
}

// ═══════════ 8. 非 flag 态 / 未知 key ═══════════
{
  const OID = 'ord8'; mkOrder(OID, 'confirmed'); mkIntent(OID, key(OID))
  const w0 = walletsSnap()
  applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key(OID), '0xtx8', BUYER_ADDR), alert)
  ok('8a: non-flaggable state (confirmed) → NOT forced to disputed', orderStatus(OID) === 'confirmed' && disputeRows(OID).length === 0)
  ok('8b: zero wallets writes on anomalous branch', walletsSnap() === w0)
  // 未知 order_key → 告警 only, no throw
  let threw = false
  try { applyUsdcEscrowDisputed(db, disputeDeps, mkDisputed(key('nope'), '0xtx8b', BUYER_ADDR), alert) } catch { threw = true }
  ok('8c: unknown order_key → alert only, no throw', threw === false)
}

// ═══════════ 9. watcher 接线:runWatcherTick(fake client)发 Disputed → 订单进 disputed ═══════════
{
  const OID = 'ord9'; mkOrder(OID, 'delivered'); mkIntent(OID, key(OID))
  const CONTRACT = '0x' + 'c'.repeat(40)
  db.prepare("INSERT OR REPLACE INTO usdc_escrow_watcher_state (id, last_scanned_block, updated_at) VALUES ('main', ?, datetime('now'))").run(100)
  const fakeLog = {
    eventName: 'Disputed',
    args: { orderKey: key(OID), by: ARBITER_ADDR },
    transactionHash: '0xtx9', logIndex: 0, blockNumber: 150n, blockHash: '0xblk9',
  }
  const fakeClient = {
    getBlockNumber: async () => 200n,
    getLogs: async () => [fakeLog] as any,
    getBlock: async () => ({ hash: '0xblk9' }),
  }
  await runWatcherTick({
    db, transition: tr, settleOrder: () => {}, generateId: genId, contractAddress: CONTRACT,
    client: fakeClient as any, confirmations: 12n, reorgBuffer: 0n,
  })
  ok('9a: watcher tick with Disputed log → order disputed (production wiring)', orderStatus(OID) === 'disputed')
  ok('9b: watcher path built dispute row (defendant seller)', disputeRows(OID).length === 1 && disputeRows(OID)[0]?.defendant_id === 'seller1')
}

// ── 汇总 ──
console.log(`\n${'─'.repeat(60)}`)
if (fail === 0) { console.log(`✅ PR-B7b-1 chain-driven dispute: ${pass}/${pass} assertions pass`) }
else { console.log(`❌ ${fail} FAILED / ${pass} passed:\n` + fails.join('\n')) }
console.log('─'.repeat(60))
process.exit(fail === 0 ? 0 : 1)
