#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B5 — Released 消费 + 结算(状态收敛 + 纯记账镜像)行为回归锁。
 * fixture 照 test-usdc-escrow-watcher.ts:in-memory 库、applyWebazRuntimeSchema、真 engine.transition、
 * initNotificationSchema、sys_protocol role='system'。deps.settleOrder 与 server.ts settleOrder 的
 * usdc 分支【逐字同构】(真被测函数 settleUsdcEscrowAtCompletion 在内 —— 不桩被测判定者)。
 * Proves:
 *   1. happy(delivered + intents funded + 非孤儿 Released, auto_=false, 守恒)→ completed;fee_ledger
 *      1 行(amount=feePaid, auto_release=0);intents='released';买家+卖家 wallets 全字段前后相等(零写);
 *      order_state_history 有 delivered→confirmed(actor=买家)与 confirmed→completed。
 *   2. auto_=true → confirmed 行 actor_id='sys_protocol'。
 *   3. 守恒不符 → 状态不动(delivered)、无 fee 行、admin 告警。
 *   4. 提前释放(shipped)→ alert、不动;快进 delivered → sweepPendingUsdcEscrowReleases → completed。
 *   5. 幂等重放(对已 completed 单再调)→ fee 行仍 1、history 不增、无新告警。
 *   6. 铁律 pin:无 Released 镜像行时 settleUsdcEscrowAtCompletion → throw;外层事务回滚(状态没变)。
 *   7. 未知 order_key Released → alert only。
 *   8. cancelled 单收到 Released → alert、仍 cancelled。
 *   9. stalled(paid 超 accept_deadline)→ sweepStalledUsdcEscrowOrders 后 admin 1 条;再 sweep 不重复。
 *   10. 崩溃恢复(order 'confirmed' + Released 镜像在)→ sweep → completed + 记账齐。
 * Usage: npm run test:usdc-escrow-settle
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'uesettle-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const {
  settleUsdcEscrowAtCompletion, applyUsdcEscrowRelease, sweepPendingUsdcEscrowReleases,
  sweepStalledUsdcEscrowOrders, alertUsdcAdmins,
} = await import('../src/usdc-escrow-settle.js')
type ReleasedEventRow = import('../src/usdc-escrow-settle.js').ReleasedEventRow
type UsdcSettleDeps = import('../src/usdc-escrow-settle.js').UsdcSettleDeps

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── fixture(照 test-usdc-escrow-watcher.ts 的建法抄)──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)   // 组合根:usdc 五表 + orders/users/wallets/order_state_history 等基础表全建齐
initNotificationSchema(db)    // notifications 表(alertUsdcAdmins 消费方)
for (const col of ['payment_rail TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','buyer1','buyer','k_b1'),('seller1','seller1','seller','k_s1'),('admin1','admin1','admin','k_a1'),('sys_protocol','sys','system','k_sys')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','品','d',10,99,'active')").run()
// 钱包:全字段初值,零写断言的前后快照锚
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('buyer1', 123.45, 1, 10, 2, 3)
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('seller1', 500, 7, 0, 4, 5)

let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
/* eslint-disable @typescript-eslint/no-explicit-any */
const tr = transition as any

// settleOrder 与 server.ts settleOrder 的 usdc 分支逐字同构(真被测函数在内)。
const settleOrderIso = (id: string): void => {
  db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as { id: string; payment_rail: string } | undefined
    if (o && o.payment_rail === 'usdc_escrow') { settleUsdcEscrowAtCompletion(db, o, genId); return }
    throw new Error('unexpected rail')
  })()
}
const deps: UsdcSettleDeps = { transition: tr, settleOrder: settleOrderIso, generateId: genId }
const alert = (t: string, b: string): void => alertUsdcAdmins(db, genId, t, b)

// ── helpers ──
const mkOrder = (id: string, status = 'delivered', opts: { acceptDeadline?: string; shipDeadline?: string } = {}): void => {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, accept_deadline, ship_deadline)
    VALUES (?, 'p1', 'buyer1', 'seller1', 1, 10, 10, 0, ?, 'usdc_escrow', ?, ?)`).run(id, status, opts.acceptDeadline ?? null, opts.shipDeadline ?? null)
}
const mkIntent = (orderId: string, orderKey: string, opts: { amount?: number; status?: string } = {}): void => {
  db.prepare(`INSERT INTO usdc_escrow_intents
      (order_id, order_key, contract_addr, buyer_id, seller_id, seller_addr, amount_units, fee_bps, auto_release_at, voucher_sig, auth_expires_at, status)
    VALUES (?, ?, ?, 'buyer1', 'seller1', ?, ?, 500, datetime('now'), '0xsig', datetime('now'), ?)`)
    .run(orderId, orderKey.toLowerCase(), ('0x' + '9'.repeat(40)), ('0x' + '3'.repeat(40)), opts.amount ?? 10_000_000, opts.status ?? 'funded')
}
// 镜像一条非孤儿 Released 事件(payload bigint 序列化为字符串,与 watcher 同款)+ 返回驱动器用 ev。
const seedReleased = (orderKey: string, tx: string, sellerPaid: bigint, feePaid: bigint, auto: boolean, block = 1000): ReleasedEventRow => {
  const payload = JSON.stringify({ orderKey: orderKey.toLowerCase(), auto_: auto, sellerPaid: String(sellerPaid), feePaid: String(feePaid) })
  db.prepare(`INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES (?,?,?,?,?,?,?,?)`)
    .run(genId('uce'), orderKey.toLowerCase(), 'Released', tx, 0, block, '0xblk_' + tx, payload)
  return { order_key: orderKey.toLowerCase(), tx_hash: tx, payload_json: payload }
}
const orderStatus = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status
const intentStatus = (id: string): string => (db.prepare('SELECT status FROM usdc_escrow_intents WHERE order_id = ?').get(id) as { status: string }).status
const feeRow = (id: string): { amount_units: number; auto_release: number; tx_hash: string } | undefined =>
  db.prepare('SELECT amount_units, auto_release, tx_hash FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(id) as any
const feeCount = (id: string): number => (db.prepare('SELECT COUNT(*) n FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(id) as { n: number }).n
const notifCountAdmin = (): number => (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'admin1'").get() as { n: number }).n
const histCount = (id: string, from: string, to: string): number =>
  (db.prepare('SELECT COUNT(*) n FROM order_state_history WHERE order_id = ? AND from_status = ? AND to_status = ?').get(id, from, to) as { n: number }).n
const histActor = (id: string, from: string, to: string): string | undefined =>
  (db.prepare('SELECT actor_id FROM order_state_history WHERE order_id = ? AND from_status = ? AND to_status = ? ORDER BY rowid DESC LIMIT 1').get(id, from, to) as { actor_id: string } | undefined)?.actor_id
const walletSnap = (uid: string): string => JSON.stringify(db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(uid))

// ══════════ case 1: happy path (delivered, auto_=false, conservation holds) ══════════
{
  const OID = 'ord1'; const OK = '0x' + '1'.repeat(64); const TX = '0xtx1'
  mkOrder(OID, 'delivered'); mkIntent(OID, OK, { amount: 10_000_000 })
  const ev = seedReleased(OK, TX, 9_500_000n, 500_000n, false)
  const bSnap = walletSnap('buyer1'), sSnap = walletSnap('seller1')
  const notifBefore = notifCountAdmin()
  applyUsdcEscrowRelease(db, deps, ev, alert)
  ok('case1: delivered + Released → completed', orderStatus(OID) === 'completed', orderStatus(OID))
  ok('case1: fee_ledger 1 row (amount=feePaid, auto_release=0)', feeCount(OID) === 1 && feeRow(OID)?.amount_units === 500_000 && feeRow(OID)?.auto_release === 0, JSON.stringify(feeRow(OID)))
  ok('case1: intents → released', intentStatus(OID) === 'released')
  ok('case1: ZERO wallets writes — buyer full-row snapshot identical', walletSnap('buyer1') === bSnap)
  ok('case1: ZERO wallets writes — seller full-row snapshot identical', walletSnap('seller1') === sSnap)
  ok('case1: history delivered→confirmed by the BUYER (not sys)', histCount(OID, 'delivered', 'confirmed') === 1 && histActor(OID, 'delivered', 'confirmed') === 'buyer1')
  ok('case1: history confirmed→completed present', histCount(OID, 'confirmed', 'completed') === 1)
  ok('case1: no admin alert on the happy path', notifCountAdmin() === notifBefore)
}

// ══════════ case 2: auto_=true → confirmed row actor_id='sys_protocol' ══════════
{
  const OID = 'ord2'; const OK = '0x' + '2'.repeat(64); const TX = '0xtx2'
  mkOrder(OID, 'delivered'); mkIntent(OID, OK, { amount: 10_000_000 })
  const ev = seedReleased(OK, TX, 9_000_000n, 1_000_000n, true)
  applyUsdcEscrowRelease(db, deps, ev, alert)
  ok('case2: auto_=true → completed', orderStatus(OID) === 'completed')
  ok('case2: confirmed row actor_id=sys_protocol (autoRelease, buyer did not sign)', histActor(OID, 'delivered', 'confirmed') === 'sys_protocol')
  ok('case2: fee_ledger auto_release=1', feeRow(OID)?.auto_release === 1 && feeRow(OID)?.amount_units === 1_000_000)
}

// ══════════ case 3: conservation mismatch → no state change, no fee row, admin alert ══════════
{
  const OID = 'ord3'; const OK = '0x' + '3'.repeat(64); const TX = '0xtx3'
  mkOrder(OID, 'delivered'); mkIntent(OID, OK, { amount: 10_000_000 })
  const ev = seedReleased(OK, TX, 9_000_000n, 500_000n, false)   // 9_000_000+500_000 = 9_500_000 ≠ 10_000_000
  const notifBefore = notifCountAdmin()
  applyUsdcEscrowRelease(db, deps, ev, alert)
  ok('case3: conservation mismatch → order stays delivered (outer tx rolled back)', orderStatus(OID) === 'delivered', orderStatus(OID))
  ok('case3: no fee_ledger row', feeCount(OID) === 0)
  ok('case3: intents stays funded', intentStatus(OID) === 'funded')
  ok('case3: admin alerted', notifCountAdmin() === notifBefore + 1)
}

// ══════════ case 4: early release (shipped) → alert only; fast-forward to delivered → sweep closes it ══════════
{
  const OID = 'ord4'; const OK = '0x' + '4'.repeat(64); const TX = '0xtx4'
  mkOrder(OID, 'shipped'); mkIntent(OID, OK, { amount: 10_000_000 })
  const ev = seedReleased(OK, TX, 9_500_000n, 500_000n, false)
  const notifBefore = notifCountAdmin()
  applyUsdcEscrowRelease(db, deps, ev, alert)
  ok('case4: early release on shipped → order untouched (still shipped)', orderStatus(OID) === 'shipped')
  ok('case4: early release → admin alerted', notifCountAdmin() === notifBefore + 1)
  ok('case4: no fee row yet (not settled)', feeCount(OID) === 0)
  // fixture 快进:订单实际推进到 delivered(链上钱已在卖家手里,DB 状态随后到位)
  db.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(OID)
  sweepPendingUsdcEscrowReleases(db, deps, alert)
  ok('case4: sweep closes the previously-early-released order → completed', orderStatus(OID) === 'completed', orderStatus(OID))
  ok('case4: fee_ledger 1 row after sweep', feeCount(OID) === 1 && feeRow(OID)?.amount_units === 500_000)
  ok('case4: intents → released after sweep', intentStatus(OID) === 'released')
}

// ══════════ case 5: idempotent replay on an already-completed order ══════════
{
  const OID = 'ord5'; const OK = '0x' + '5'.repeat(64); const TX = '0xtx5'
  mkOrder(OID, 'delivered'); mkIntent(OID, OK, { amount: 10_000_000 })
  const ev = seedReleased(OK, TX, 9_500_000n, 500_000n, false)
  applyUsdcEscrowRelease(db, deps, ev, alert)   // first: → completed
  ok('case5 setup: completed with fee row', orderStatus(OID) === 'completed' && feeCount(OID) === 1)
  const notifBefore = notifCountAdmin()
  const histBefore = histCount(OID, 'confirmed', 'completed') + histCount(OID, 'delivered', 'confirmed')
  applyUsdcEscrowRelease(db, deps, ev, alert)   // replay
  ok('case5: replay → fee_ledger still exactly 1 row', feeCount(OID) === 1)
  ok('case5: replay → no new history rows', (histCount(OID, 'confirmed', 'completed') + histCount(OID, 'delivered', 'confirmed')) === histBefore)
  ok('case5: replay → no new admin alert', notifCountAdmin() === notifBefore)
}

// ══════════ case 6: IRON RULE — no Released mirror → settleUsdcEscrowAtCompletion throws + outer tx rolls back ══════════
{
  const OID = 'ord6'; const OK = '0x' + '6'.repeat(64)
  mkOrder(OID, 'delivered'); mkIntent(OID, OK, { amount: 10_000_000 })   // NO seedReleased → no mirror row
  let threw = false
  try {
    db.transaction(() => {
      tr(db, OID, 'confirmed', 'buyer1', [], 'fixture: pretend some path advanced it')   // mutate within tx
      settleUsdcEscrowAtCompletion(db, { id: OID }, genId)                                 // must throw (no mirror)
    })()
  } catch { threw = true }
  ok('case6: settleUsdcEscrowAtCompletion throws when no non-orphan Released mirror exists', threw)
  ok('case6: outer transaction rolled back — order still delivered (never fake-completed)', orderStatus(OID) === 'delivered', orderStatus(OID))
  ok('case6: no fee row written', feeCount(OID) === 0)
}

// ══════════ case 7: unknown order_key Released → alert only ══════════
{
  const OK = '0x' + '7'.repeat(64); const TX = '0xtx7'
  const ev = seedReleased(OK, TX, 9_500_000n, 500_000n, false)   // no intent/order for this key
  const notifBefore = notifCountAdmin()
  applyUsdcEscrowRelease(db, deps, ev, alert)
  ok('case7: unknown order_key → admin alerted, no crash', notifCountAdmin() === notifBefore + 1)
}

// ══════════ case 8: cancelled order receives Released → alert, stays cancelled ══════════
{
  const OID = 'ord8'; const OK = '0x' + '8'.repeat(64); const TX = '0xtx8'
  mkOrder(OID, 'cancelled'); mkIntent(OID, OK, { amount: 10_000_000 })
  const ev = seedReleased(OK, TX, 9_500_000n, 500_000n, false)
  const notifBefore = notifCountAdmin()
  applyUsdcEscrowRelease(db, deps, ev, alert)
  ok('case8: cancelled order + Released → alert', notifCountAdmin() === notifBefore + 1)
  ok('case8: order stays cancelled (no reversal, no completion)', orderStatus(OID) === 'cancelled')
  ok('case8: no fee row', feeCount(OID) === 0)
}

// ══════════ case 9: stalled paid order → admin notification once, no double-blast ══════════
{
  const OID = 'ord9'; const OK = '0x' + '9'.repeat(64)
  mkOrder(OID, 'paid', { acceptDeadline: new Date(Date.now() - 3600_000).toISOString() }); mkIntent(OID, OK)
  const notifBefore = notifCountAdmin()
  sweepStalledUsdcEscrowOrders(db, genId)
  ok('case9: stalled paid order → exactly 1 admin notification', notifCountAdmin() === notifBefore + 1, `delta=${notifCountAdmin() - notifBefore}`)
  ok('case9: order untouched (rail does not adjudicate — enforcement is on-chain)', orderStatus(OID) === 'paid')
  sweepStalledUsdcEscrowOrders(db, genId)
  ok('case9: second sweep → NO duplicate notification (dedup by user+order+title)', notifCountAdmin() === notifBefore + 1)
}

// ══════════ case 10: crash recovery — order left at 'confirmed' + Released mirror present → sweep closes it ══════════
{
  const OID = 'ord10'; const OK = '0x' + 'a'.repeat(64); const TX = '0xtx10'
  mkOrder(OID, 'confirmed'); mkIntent(OID, OK, { amount: 10_000_000 })
  seedReleased(OK, TX, 9_500_000n, 500_000n, false)
  sweepPendingUsdcEscrowReleases(db, deps, alert)
  ok('case10: crash-recovery confirmed order → completed', orderStatus(OID) === 'completed', orderStatus(OID))
  ok('case10: fee_ledger 1 row + intents released (accounting complete)', feeCount(OID) === 1 && intentStatus(OID) === 'released')
  ok('case10: history confirmed→completed present', histCount(OID, 'confirmed', 'completed') === 1)
}

if (fail > 0) { console.error(`\n❌ usdc-escrow-settle FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow-settle: Released → state convergence (delivered→confirmed→completed) + fee-ledger/intents accounting mirror, ZERO wallets writes, iron-rule fail-closed on missing mirror, idempotent replay/sweep/crash-recovery\n  ✅ pass ${pass}`)
