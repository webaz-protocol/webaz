#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B4 — 链上事件 watcher 行为回归锁。
 * 注入 fake WatcherChainClient(内存 log 数组,零网络);transition 用真 engine.transition
 * (行为测试不桩被测判定者)。fixture 表全部照 test-usdc-escrow-rail.ts 的建法抄。
 * Proves:
 *   1. 确认深度足够的 Deposited、参数与 intents 全符 → 订单 created→paid、intents→funded、
 *      镜像行存在、游标推进;链上 seller 用 EIP-55 混合大小写而 intent 存小写(钉双向小写比较)、
 *      created→paid 写入 order_state_history 审计行(钉:回退成裸 UPDATE orders 即 CI 红)。
 *   2. safeHead 之上的新事件(< CONFIRMATIONS 确认)本 tick 不可见 → 订单仍 created。
 *   3. 同一事件重扫(游标回拨模拟覆盖同窗口)→ 幂等:不重复告警/转移,orders/intents 不变,
 *      镜像仍 1 行。
 *   4. amount 不符 → 镜像入、订单仍 created、intents 仍 issued、admin 收到告警。
 *   5. 未知 order_key(无 intents)→ 镜像入 + 告警、无转移。
 *   6. 订单已 cancelled 后 Deposited 确认 → 镜像入 + 告警、订单仍 cancelled。
 *   7. 重组(block_hash 变了,同一自洽 getLogs 内)→ orphans 加行、原行未改(append-only)、告警、订单状态未反转;
 *      替换 log(同 tx+logIndex、新 block_hash)经三键 UNIQUE 落成新 canonical 行(老+新并存、新行未被孤儿标记)。
 *   8. 事件消失 + getBlock 佐证 canonical hash 已变(真重组)→ orphan reason='reorg:log_vanished:<hash>'、订单未反转。
 *   8b. 事件消失但 getBlock 返回同一 hash(RPC 抖动,区块仍 canonical)→ 无 orphan、无新告警、订单不动。
 *   8c. 事件消失且 getBlock 抛错(节点滞后)→ 无定论:无 orphan、无告警、tick 不 throw(下 tick 重查)。
 *   9. Released 落在未 delivered 的 paid 单 → 镜像 + 「提前释放」告警、状态不动(B5:Released 现驱动结算,
 *      完整 happy path 在 test-usdc-escrow-settle.ts);Disputed + Resolved 也镜像 + 告警(三条告警)。
 *   10. RPC 异常(fake client throw)→ tick 不 crash、游标不推进。
 *   11. 冷启动:watcher_state 空 → 初始化游标为 safeHead、不处理任何历史事件(零 getLogs 调用)。
 *   11b. 冷启动 + USDC_ESCROW_START_BLOCK(< safeHead)→ 游标初始化为该 env 块(非 safeHead)、仍不扫历史。
 *   12. 追赶:游标落后 > MAX_RANGE → 单 tick 多段推进(≤ MAX_RANGES_PER_TICK),最终 cursor=safeHead。
 *   13. Released E2E:delivered + funded 单,真 bigint log args 经 runWatcherTick → 订单 completed +
 *       fee_ledger.amount_units===Number(feePaid) + intent released(钉 bigint→string→BigInt 经 watcher JSON replacer 往返)。
 * Usage: npm run test:usdc-escrow-watcher
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'uewatch-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
delete process.env.USDC_ESCROW_START_BLOCK

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const {
  runWatcherTick, MAX_RANGE, MAX_RANGES_PER_TICK,
} = await import('../src/pwa/internal/usdc-escrow-watcher.js')
const { settleUsdcEscrowAtCompletion } = await import('../src/usdc-escrow-settle.js')
type WatcherLog = import('../src/pwa/internal/usdc-escrow-watcher.js').WatcherLog
type WatcherChainClient = import('../src/pwa/internal/usdc-escrow-watcher.js').WatcherChainClient
type WatcherDeps = import('../src/pwa/internal/usdc-escrow-watcher.js').WatcherDeps

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── fixture(照 test-usdc-escrow-rail.ts 的建法抄)──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)   // 组合根:usdc 四表 + orders/users/order_state_history 等基础表全建齐
initNotificationSchema(db)    // notifications 表(alertAdmins 消费方;非组合根自动拾取范围,显式建)
for (const col of ['payment_rail TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','buyer1','buyer','k_b1'),('seller1','seller1','seller','k_s1'),('admin1','admin1','admin','k_a1'),('sys_protocol','sys','system','k_sys')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','品','d',10,99,'active')").run()

let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
/* eslint-disable @typescript-eslint/no-explicit-any */
const tr = transition as any

const CONTRACT = ('0x' + '9'.repeat(40))
const SELLER_ADDR = ('0x' + '3'.repeat(40))
// EIP-55 mixed-case on-chain form (as viem returns in logs); the intent stores its LOWERCASE.
// Pins the double-lowercase seller compare in applyDeposited: an all-digit fixture address is
// case-invariant, so a dropped .toLowerCase() would pass CI yet break every real viem deposit.
const SELLER_ADDR_CHECKSUM = ('0x' + 'AbCdEf' + '3'.repeat(34))
const BUYER_ADDR = ('0x' + '1'.repeat(40))

const mkOrder = (id: string, status = 'created'): void => {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail)
    VALUES (?, 'p1', 'buyer1', 'seller1', 1, 10, 10, 0, ?, 'usdc_escrow')`).run(id, status)
}
const mkIntent = (orderId: string, orderKey: string, opts: { amount?: number; feeBps?: number; sellerAddr?: string } = {}): void => {
  db.prepare(`INSERT INTO usdc_escrow_intents
      (order_id, order_key, contract_addr, buyer_id, seller_id, seller_addr, amount_units, fee_bps, auto_release_at, voucher_sig, auth_expires_at, status)
    VALUES (?, ?, ?, 'buyer1', 'seller1', ?, ?, ?, datetime('now'), '0xsig', datetime('now'), 'issued')`)
    .run(orderId, orderKey.toLowerCase(), CONTRACT, (opts.sellerAddr ?? SELLER_ADDR).toLowerCase(), opts.amount ?? 1_000_000, opts.feeBps ?? 500)
}
const orderStatus = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status
const intentStatus = (id: string): string => (db.prepare('SELECT status FROM usdc_escrow_intents WHERE order_id = ?').get(id) as { status: string }).status
// tx_hash is stored lowercase (module lowercases on mirror) — always compare lowercase here too.
const mirrorCount = (tx: string, logIndex = 0): number => (db.prepare('SELECT COUNT(*) n FROM usdc_escrow_chain_events WHERE tx_hash = ? AND log_index = ?').get(tx.toLowerCase(), logIndex) as { n: number }).n
const chainEventRow = (tx: string): { id: string; block_hash: string } | undefined => db.prepare('SELECT id, block_hash FROM usdc_escrow_chain_events WHERE tx_hash = ?').get(tx.toLowerCase()) as { id: string; block_hash: string } | undefined
const notifCountAdmin = (): number => (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'admin1'").get() as { n: number }).n
const setCursor = (block: bigint): void => { db.prepare("INSERT OR REPLACE INTO usdc_escrow_watcher_state (id, last_scanned_block, updated_at) VALUES ('main', ?, datetime('now'))").run(Number(block)) }
const cursorNow = (): bigint => BigInt((db.prepare("SELECT last_scanned_block FROM usdc_escrow_watcher_state WHERE id='main'").get() as { last_scanned_block: number } | undefined)?.last_scanned_block ?? 0)

const depositedLog = (args: { orderKey: string; tx: string; blockNumber: bigint; blockHash: string; amount?: number; feeBps?: number; sellerAddr?: string; logIndex?: number }): WatcherLog => ({
  eventName: 'Deposited',
  args: {
    orderKey: args.orderKey.toLowerCase(), buyer: BUYER_ADDR, seller: (args.sellerAddr ?? SELLER_ADDR),
    amount: BigInt(args.amount ?? 1_000_000), feeBps: BigInt(args.feeBps ?? 500), autoReleaseAt: BigInt(1_900_000_000),
  },
  transactionHash: args.tx, logIndex: args.logIndex ?? 0, blockNumber: args.blockNumber, blockHash: args.blockHash,
})

class FakeClient implements WatcherChainClient {
  latest: bigint
  logs: WatcherLog[]
  throwGetLogs = false
  throwGetBlockNumber = false
  throwGetBlock = false
  getLogsCalls = 0
  getBlockCalls = 0
  // canonical block hash by height — the vanish-corroboration branch reads this via getBlock.
  blockHashByNumber = new Map<bigint, string>()
  constructor(latest: bigint, logs: WatcherLog[] = []) { this.latest = latest; this.logs = logs }
  async getBlockNumber(): Promise<bigint> { if (this.throwGetBlockNumber) throw new Error('rpc down (getBlockNumber)'); return this.latest }
  async getLogs({ fromBlock, toBlock }: { address: `0x${string}`; events: unknown[]; fromBlock: bigint; toBlock: bigint }): Promise<WatcherLog[]> {
    this.getLogsCalls++
    if (this.throwGetLogs) throw new Error('rpc down (getLogs)')
    return this.logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<{ hash: string }> {
    this.getBlockCalls++
    if (this.throwGetBlock) throw new Error('rpc down (getBlock)')
    const hash = this.blockHashByNumber.get(blockNumber)
    if (hash === undefined) throw new Error(`FakeClient.getBlock: no canonical hash set for height ${blockNumber} (test must set blockHashByNumber)`)
    return { hash }
  }
}

// settleOrder isomorphic to server.ts settleOrder's usdc branch (真被测函数 settleUsdcEscrowAtCompletion
// 在内 —— 不桩被测判定者;与 test-usdc-escrow-settle.ts 同款,与生产分支逐字同构)。
const settleOrderIso = (id: string): void => {
  db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as { id: string; payment_rail: string } | undefined
    if (o && o.payment_rail === 'usdc_escrow') { settleUsdcEscrowAtCompletion(db, o, genId); return }
    throw new Error('unexpected rail')
  })()
}

const makeDeps = (client: WatcherChainClient, extra: Partial<WatcherDeps> = {}): WatcherDeps => ({
  db, transition: tr, settleOrder: settleOrderIso, generateId: genId, contractAddress: CONTRACT, client, confirmations: 3n, reorgBuffer: 2n, ...extra,
})

// NOTE on block numbering across groups: reorg detection scans usdc_escrow_chain_events by
// block_number range with no per-scenario scoping (matches production: the mirror is global per
// contract). Each group below therefore gets its own well-separated, non-overlapping block range
// so one scenario's rescans/reorg checks can never see another scenario's rows as "vanished".

// ══════════ Group A [blocks 1000-1013]: cases 1 (visible+processed), 2 (below-confirmation invisible), 3 (idempotent rescan) ══════════
{
  const OID = 'ordA'; const OK = '0x' + 'a'.repeat(64); const TX = '0xtxA'
  // intent stores lowercase seller; on-chain log carries the EIP-55 mixed-case form → pins double-lowercase compare
  mkOrder(OID, 'created'); mkIntent(OID, OK, { sellerAddr: SELLER_ADDR_CHECKSUM })
  setCursor(1000n)
  const client = new FakeClient(1010n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 1009n, blockHash: '0xblockA', sellerAddr: SELLER_ADDR_CHECKSUM })])

  // case 2: confirmations=3n → safeHead=1007n < block 1009 → not yet visible
  const r1 = await runWatcherTick(makeDeps(client))
  ok('case2: below-confirmation event invisible this tick → order stays created', orderStatus(OID) === 'created' && r1.scanned === true)
  ok('case2: cursor advanced to safeHead(1007) without seeing the event', cursorNow() === 1007n)

  // case 1: latest advances → safeHead=1013n ≥ 1009 → event visible & processed
  client.latest = 1016n
  const r2 = await runWatcherTick(makeDeps(client))
  ok('case1: Deposited fully matching → order created→paid', orderStatus(OID) === 'paid', orderStatus(OID))
  ok('case1: intent → funded', intentStatus(OID) === 'funded')
  ok('case1: chain_events mirror row exists', mirrorCount(TX) === 1)
  ok('case1: cursor advanced to new safeHead(1013)', r2.scanned === true && cursorNow() === 1013n)
  // audit trail: created→paid went through deps.transition (not a raw UPDATE orders) → order_state_history row exists
  ok('case1: transition wrote the created→paid audit trail (blocks a regression to raw UPDATE)',
    (db.prepare("SELECT COUNT(*) n FROM order_state_history WHERE order_id = ? AND from_status = 'created' AND to_status = 'paid'").get(OID) as { n: number }).n === 1)

  // case 3: rewind cursor to force the same window to be rescanned → idempotent
  const notifBefore = notifCountAdmin()
  setCursor(1000n)
  const r3 = await runWatcherTick(makeDeps(client))
  ok('case3: rescan same window → order unchanged (still paid)', orderStatus(OID) === 'paid')
  ok('case3: rescan → intent unchanged (still funded)', intentStatus(OID) === 'funded')
  ok('case3: rescan → mirror still exactly 1 row (INSERT OR IGNORE dedup)', mirrorCount(TX) === 1)
  ok('case3: rescan → no new admin alert (silent idempotent completion)', notifCountAdmin() === notifBefore)
  ok('case3: cursor advances again to safeHead(1013)', r3.scanned === true && cursorNow() === 1013n)
}

// ══════════ Group B [blocks 2000/2100/2200, disjoint]: case 4 (amount mismatch), case 5 (unknown order_key), case 6 (order already cancelled) ══════════
{
  // case 4 — block 2001
  const OID = 'ordB4'; const OK = '0x' + 'b'.repeat(64); const TX = '0xtxB4'
  mkOrder(OID, 'created'); mkIntent(OID, OK, { amount: 1_000_000 })
  setCursor(2000n)
  const client = new FakeClient(2004n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 2001n, blockHash: '0xblockB4', amount: 2_000_000 })])
  const notifBefore = notifCountAdmin()
  await runWatcherTick(makeDeps(client))
  ok('case4: amount mismatch → mirrored', mirrorCount(TX) === 1)
  ok('case4: amount mismatch → order stays created', orderStatus(OID) === 'created')
  ok('case4: amount mismatch → intent stays issued', intentStatus(OID) === 'issued')
  ok('case4: amount mismatch → admin alerted', notifCountAdmin() === notifBefore + 1)
  // buyer + seller must ALSO learn (funds on-chain while parties are blind was the finding) — order_id set, type usdc_param_mismatch
  ok('case4: buyer notified of param mismatch', !!db.prepare("SELECT 1 FROM notifications WHERE user_id='buyer1' AND order_id=? AND type='usdc_param_mismatch'").get(OID))
  ok('case4: seller notified of param mismatch', !!db.prepare("SELECT 1 FROM notifications WHERE user_id='seller1' AND order_id=? AND type='usdc_param_mismatch'").get(OID))
}
{
  // case 5 — block 2101 (own window, no overlap with case 4's [1999,2001])
  const OK = '0x' + 'c'.repeat(64); const TX = '0xtxB5'
  setCursor(2100n)
  const client = new FakeClient(2104n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 2101n, blockHash: '0xblockB5' })])
  const notifBefore = notifCountAdmin()
  await runWatcherTick(makeDeps(client))
  ok('case5: unknown order_key → mirrored', mirrorCount(TX) === 1)
  ok('case5: unknown order_key → admin alerted, no transition attempted', notifCountAdmin() === notifBefore + 1)
}
{
  // case 6 — block 2201 (own window)
  const OID = 'ordB6'; const OK = '0x' + 'd'.repeat(64); const TX = '0xtxB6'
  mkOrder(OID, 'cancelled'); mkIntent(OID, OK)
  setCursor(2200n)
  const client = new FakeClient(2204n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 2201n, blockHash: '0xblockB6' })])
  const notifBefore = notifCountAdmin()
  await runWatcherTick(makeDeps(client))
  ok('case6: deposit on already-cancelled order → mirrored', mirrorCount(TX) === 1)
  ok('case6: order stays cancelled (no reversal)', orderStatus(OID) === 'cancelled')
  ok('case6: admin alerted (real money on-chain vs dead order)', notifCountAdmin() === notifBefore + 1)
}

// ══════════ Group C [blocks 3000/3100, disjoint]: case 7 (reorg: block_hash mismatch), case 8 (reorg: log vanished) ══════════
{
  // case 7 — block 3005
  const OID = 'ordC7'; const OK = '0x' + 'e'.repeat(64); const TX = '0xtxC7'
  mkOrder(OID, 'created'); mkIntent(OID, OK)
  setCursor(3000n)
  const client = new FakeClient(3008n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 3005n, blockHash: '0xblockC7-original' })])
  await runWatcherTick(makeDeps(client))
  ok('case7 setup: event applied, order paid', orderStatus(OID) === 'paid')
  const rowBefore = chainEventRow(TX)
  if (!rowBefore) throw new Error(`case7 setup failed: no mirrored row for ${TX}`)

  // simulate a reorg: same (tx,logIndex) now reports a different block_hash
  client.logs[0] = { ...client.logs[0], blockHash: '0xblockC7-REPLACED' }
  client.latest = 3009n   // safeHead advances by 1 so cursor(3005) < safeHead(3006) triggers another scan
  const notifBefore = notifCountAdmin()
  await runWatcherTick(makeDeps(client))
  // original row queried by id (there are now 2 rows for this tx+logIndex; a bare tx lookup is non-deterministic)
  const origRow = db.prepare('SELECT block_hash FROM usdc_escrow_chain_events WHERE id = ?').get(rowBefore.id) as { block_hash: string } | undefined
  ok('case7: original mirrored row untouched (append-only)', !!origRow && origRow.block_hash === rowBefore.block_hash && origRow.block_hash === '0xblockc7-original')
  const orphan = db.prepare('SELECT reason FROM usdc_escrow_event_orphans WHERE event_id = ?').get(rowBefore.id) as { reason: string } | undefined
  ok('case7: orphan marker recorded with block_hash_mismatch reason', !!orphan && orphan.reason.startsWith('reorg:block_hash_mismatch:'), JSON.stringify(orphan))
  ok('case7: admin alerted about the reorg', notifCountAdmin() === notifBefore + 1)
  ok('case7: order status NOT reverted (still paid)', orderStatus(OID) === 'paid')
  // Fix 1 (B4 triple-key UNIQUE): the reorg replacement log (same tx+logIndex, new block_hash) lands as a NEW canonical row.
  ok('case7: old + new canonical rows coexist (triple-key UNIQUE admits the replacement)', mirrorCount(TX) === 2)
  const newCanonical = db.prepare(
    "SELECT ce.id FROM usdc_escrow_chain_events ce LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id WHERE ce.tx_hash = ? AND ce.block_hash = ? AND o.event_id IS NULL",
  ).get(TX.toLowerCase(), '0xblockc7-replaced') as { id: string } | undefined
  ok('case7: new canonical (replacement) row present and NOT orphaned (settlement reconciliation reads it)', !!newCanonical && newCanonical.id !== rowBefore.id)
}
{
  // case 8 — block 3105 (own window, no overlap with case 7's [2999,3006])
  // vanished log CORROBORATED as a true reorg: getBlock reports a DIFFERENT canonical hash at 3105.
  const OID = 'ordC8'; const OK = '0x' + 'f'.repeat(64); const TX = '0xtxC8'
  mkOrder(OID, 'created'); mkIntent(OID, OK)
  setCursor(3100n)
  const client = new FakeClient(3108n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 3105n, blockHash: '0xblockC8' })])
  await runWatcherTick(makeDeps(client))
  ok('case8 setup: event applied, order paid', orderStatus(OID) === 'paid')
  const rowBefore = chainEventRow(TX)
  if (!rowBefore) throw new Error(`case8 setup failed: no mirrored row for ${TX}`)

  // simulate a deeper reorg: the log vanishes AND getBlock confirms the height now holds a different block.
  client.logs = []
  client.blockHashByNumber.set(3105n, '0xblockc8-reorged')   // ≠ mirrored row's 0xblockc8 → true reorg
  client.latest = 3109n
  await runWatcherTick(makeDeps(client))
  const orphan = db.prepare('SELECT reason FROM usdc_escrow_event_orphans WHERE event_id = ?').get(rowBefore.id) as { reason: string } | undefined
  ok('case8: corroborated vanish → orphan reason=reorg:log_vanished:<canonicalHash>', orphan?.reason === 'reorg:log_vanished:0xblockc8-reorged', JSON.stringify(orphan))
  ok('case8: getBlock was consulted before orphaning', client.getBlockCalls >= 1)
  ok('case8: order status NOT reverted (still paid)', orderStatus(OID) === 'paid')
}
{
  // case 8b — block 3205 (own window): logs vanish from refetch but getBlock returns the SAME hash
  // as the mirrored row → RPC flake, NOT a reorg → no orphan, no new alert, order untouched.
  const OID = 'ordC8b'; const OK = '0x' + '1'.repeat(63) + 'b'; const TX = '0xtxC8b'
  mkOrder(OID, 'created'); mkIntent(OID, OK)
  setCursor(3200n)
  const client = new FakeClient(3208n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 3205n, blockHash: '0xblockC8b' })])
  await runWatcherTick(makeDeps(client))
  ok('case8b setup: event applied, order paid', orderStatus(OID) === 'paid')
  const rowBefore = chainEventRow(TX)
  if (!rowBefore) throw new Error(`case8b setup failed: no mirrored row for ${TX}`)

  // logs vanish (flaky getLogs) but the block is still canonical with the SAME hash → RPC flake.
  client.logs = []
  client.blockHashByNumber.set(3205n, '0xblockc8b')   // === mirrored row's 0xblockc8b (lowercased) → still canonical
  client.latest = 3209n
  const notifBefore = notifCountAdmin()
  await runWatcherTick(makeDeps(client))
  const orphan = db.prepare('SELECT reason FROM usdc_escrow_event_orphans WHERE event_id = ?').get(rowBefore.id) as { reason: string } | undefined
  ok('case8b: RPC flake (same canonical hash) → NO orphan row', orphan === undefined, JSON.stringify(orphan))
  ok('case8b: RPC flake → NO new admin notification', notifCountAdmin() === notifBefore)
  ok('case8b: order untouched (still paid)', orderStatus(OID) === 'paid')
}
{
  // case 8c — block 3305 (own window): logs vanish and getBlock THROWS → inconclusive →
  // no orphan, no alert, tick completes without throwing (will re-check next tick).
  const OID = 'ordC8c'; const OK = '0x' + '2'.repeat(63) + 'c'; const TX = '0xtxC8c'
  mkOrder(OID, 'created'); mkIntent(OID, OK)
  setCursor(3300n)
  const client = new FakeClient(3308n, [depositedLog({ orderKey: OK, tx: TX, blockNumber: 3305n, blockHash: '0xblockC8c' })])
  await runWatcherTick(makeDeps(client))
  ok('case8c setup: event applied, order paid', orderStatus(OID) === 'paid')
  const rowBefore = chainEventRow(TX)
  if (!rowBefore) throw new Error(`case8c setup failed: no mirrored row for ${TX}`)

  // logs vanish AND getBlock is unavailable (flaky/lagging node) → inconclusive, must not orphan.
  client.logs = []
  client.throwGetBlock = true
  client.latest = 3309n
  const notifBefore = notifCountAdmin()
  let threw = false
  try { await runWatcherTick(makeDeps(client)) } catch { threw = true }
  const orphan = db.prepare('SELECT reason FROM usdc_escrow_event_orphans WHERE event_id = ?').get(rowBefore.id) as { reason: string } | undefined
  ok('case8c: getBlock throws → tick completes without throwing', !threw)
  ok('case8c: inconclusive → NO orphan row', orphan === undefined, JSON.stringify(orphan))
  ok('case8c: inconclusive → NO new admin notification', notifCountAdmin() === notifBefore)
  ok('case8c: order untouched (still paid)', orderStatus(OID) === 'paid')
}

// ══════════ Group D [blocks 4000-4013]: case 9 — Released on a not-yet-delivered order = early-release alert (no transition); Disputed + Resolved also alert (B5: Released now drives settlement; full happy path lives in test-usdc-escrow-settle.ts) ══════════
{
  const OID = 'ordD9'; const OK = '0x' + '7'.repeat(64)
  mkOrder(OID, 'paid'); mkIntent(OID, OK)
  setCursor(4000n)
  const releasedLog: WatcherLog = { eventName: 'Released', args: { orderKey: OK, auto_: false, sellerPaid: 9_500_000n, feePaid: 500_000n }, transactionHash: '0xtxD9r', logIndex: 0, blockNumber: 4001n, blockHash: '0xblockD9r' }
  const disputedLog: WatcherLog = { eventName: 'Disputed', args: { orderKey: OK, by: BUYER_ADDR }, transactionHash: '0xtxD9d', logIndex: 0, blockNumber: 4002n, blockHash: '0xblockD9d' }
  const resolvedLog: WatcherLog = { eventName: 'Resolved', args: { orderKey: OK, buyerRefund: 0n, sellerPaid: 9_500_000n, feePaid: 500_000n }, transactionHash: '0xtxD9s', logIndex: 0, blockNumber: 4003n, blockHash: '0xblockD9s' }
  const client = new FakeClient(4016n, [releasedLog, disputedLog, resolvedLog])
  const notifBefore = notifCountAdmin()
  await runWatcherTick(makeDeps(client))
  ok('case9: Released mirrored', mirrorCount('0xtxD9r') === 1)
  ok('case9: Disputed mirrored', mirrorCount('0xtxD9d') === 1)
  ok('case9: Resolved mirrored', mirrorCount('0xtxD9s') === 1)
  ok('case9: order status untouched (Released on a paid order = early-release alert, NOT a transition)', orderStatus(OID) === 'paid')
  ok('case9: three admin alerts (Released early-release + Disputed + Resolved arbitration)', notifCountAdmin() === notifBefore + 3, `delta=${notifCountAdmin() - notifBefore}`)
}

// ══════════ Group E [block 5000, disjoint]: case 10 — RPC exception mid-scan: tick doesn't crash, cursor doesn't advance ══════════
{
  setCursor(5000n)
  const client = new FakeClient(5020n)
  client.throwGetLogs = true
  let threw = false
  let result: { scanned: boolean } | undefined
  try { result = await runWatcherTick(makeDeps(client)) } catch { threw = true }
  ok('case10: tick does not throw on RPC failure', !threw)
  ok('case10: scanned=false, cursor unchanged (still 5000)', result?.scanned === false && cursorNow() === 5000n)
}

// ══════════ Group F [block 6000-ish]: case 11 — cold start: watcher_state empty → cursor initialized to safeHead, no history scanned ══════════
{
  db.prepare('DELETE FROM usdc_escrow_watcher_state').run()
  const client = new FakeClient(6000n, [depositedLog({ orderKey: '0x' + '8'.repeat(64), tx: '0xtxF11', blockNumber: 5990n, blockHash: '0xblockF11' })])
  const r = await runWatcherTick(makeDeps(client))
  ok('case11: cold start → scanned=false (no history processed)', r.scanned === false)
  ok('case11: cursor initialized to safeHead (6000-3=5997)', cursorNow() === 5997n)
  ok('case11: zero getLogs calls on cold start', client.getLogsCalls === 0)
  ok('case11: pre-existing event NOT mirrored (deploy-predates events out of scope)', mirrorCount('0xtxF11') === 0)
}

// ══════════ Group F' [block 6100-ish]: case 11b — cold start WITH backfill env: watcher_state empty + USDC_ESCROW_START_BLOCK below safeHead → cursor initialized to the env block (not safeHead), still no history scanned ══════════
{
  db.prepare('DELETE FROM usdc_escrow_watcher_state').run()
  process.env.USDC_ESCROW_START_BLOCK = '6100'   // < safeHead(6200-3=6197) → honored as the backfill floor
  const client = new FakeClient(6200n)   // confirmations=3n → safeHead=6197
  const r = await runWatcherTick(makeDeps(client))
  ok('case11b: cold start with backfill env → scanned=false (cursor seeded, no history processed this tick)', r.scanned === false)
  ok('case11b: cursor initialized to USDC_ESCROW_START_BLOCK, not safeHead', cursorNow() === BigInt(process.env.USDC_ESCROW_START_BLOCK))
  ok('case11b: zero getLogs calls on the seeding tick', client.getLogsCalls === 0)
  delete process.env.USDC_ESCROW_START_BLOCK   // restore: later/earlier cases must not see the backfill floor
}

// ══════════ Group G [blocks 100,000+, far above every other group]: case 12 — catch-up: cursor far behind → multi-range advance within one tick, bounded by MAX_RANGES_PER_TICK ══════════
{
  const cursorInit = 100_000n
  setCursor(cursorInit)
  const safeHead = cursorInit + BigInt(MAX_RANGES_PER_TICK) * MAX_RANGE   // exactly reachable in MAX_RANGES_PER_TICK segments
  const client = new FakeClient(safeHead + 3n, [])   // confirmations=3n
  const r = await runWatcherTick(makeDeps(client))
  ok('case12: catch-up reaches safeHead in a single tick', r.scanned === true && cursorNow() === safeHead, `cursor=${cursorNow()} safeHead=${safeHead}`)
  ok('case12: bounded by MAX_RANGES_PER_TICK getLogs calls', client.getLogsCalls === MAX_RANGES_PER_TICK, `calls=${client.getLogsCalls}`)
}

// ══════════ Group H [blocks 200,000+, far above every other group]: case 13 — Released E2E on a delivered+funded order → the watcher drives the FULL settlement through its own JSON.stringify(bigint→string) replacer ══════════
{
  // Pins the bigint→string→BigInt round-trip: the watcher serializes REAL bigint log args via its
  // replacer into payload_json, then applyUsdcEscrowRelease/settleUsdcEscrowAtCompletion parse it back
  // with BigInt() for the conservation check and Number(feePaid) for the fee mirror.
  const OID = 'ordH'; const OK = '0x' + '9'.repeat(64); const TX = '0xtxH'
  mkOrder(OID, 'delivered'); mkIntent(OID, OK, { amount: 1_000_000 })
  db.prepare("UPDATE usdc_escrow_intents SET status = 'funded' WHERE order_id = ?").run(OID)   // deposit already confirmed
  setCursor(200_000n)
  const releasedLog: WatcherLog = {
    eventName: 'Released',
    args: { orderKey: OK, auto_: false, sellerPaid: 950_000n, feePaid: 50_000n },   // REAL bigint args (950_000+50_000 = 1_000_000)
    transactionHash: TX, logIndex: 0, blockNumber: 200_001n, blockHash: '0xblockH',
  }
  const client = new FakeClient(200_010n, [releasedLog])   // confirmations=3n → safeHead=200_007 ≥ 200_001 visible
  await runWatcherTick(makeDeps(client))
  const fee = db.prepare('SELECT amount_units FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(OID) as { amount_units: number } | undefined
  ok('case13(E2E): watcher Released on delivered+funded → order completed', orderStatus(OID) === 'completed', orderStatus(OID))
  ok('case13(E2E): fee_ledger.amount_units === Number(feePaid) (bigint→string→BigInt round-trip through the replacer)', fee?.amount_units === Number(50_000n), JSON.stringify(fee))
  ok('case13(E2E): intent → released', intentStatus(OID) === 'released')
}

if (fail > 0) { console.error(`\n❌ usdc-escrow-watcher FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow-watcher: mirror=chain-truth + Deposited-driven created→paid + reorg mark-not-reverse + RPC-fail-safe + catch-up bounded\n  ✅ pass ${pass}`)
