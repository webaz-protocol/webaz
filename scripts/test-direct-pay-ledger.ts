#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) 资金/科目助手测试 — fee-stake lock/take/release/slash + penalty【只进不出】。
 * 设计稿: docs/modules/DIRECT-PAYMENT-MODULE-DESIGN.INTERNAL.md
 * Usage: npm run test:direct-pay-ledger
 *
 * 隔离: 启动前把 HOME 指向临时目录,再【动态 import】schema(其 DB_PATH 在 import 期算出)→ 用全新 DB,
 *       绝不污染真实 ~/.webaz。
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-ledger-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const ledgerMod = await import('../src/direct-pay-ledger.js')
const { lockFeeStake, takeFeeAtCompletion, releaseFeeStake, slashFeeStakeToPenalty, recordBaseBondSlash } = ledgerMod
const { toUnits } = await import('../src/money.js')
const { walletUnits } = await import('../src/ledger.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF') // 单元测试:跳过 FK fixture,聚焦账本算术
db.exec('CREATE TABLE IF NOT EXISTS protocol_reserve_pool (id INTEGER PRIMARY KEY, balance REAL DEFAULT 0)')
db.prepare('INSERT OR IGNORE INTO protocol_reserve_pool (id, balance) VALUES (1, 0)').run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('sys_protocol', 0)").run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()

const FEE = toUnits(5)
const bal = (u: string) => walletUnits(db, u)
const stakeStatus = (o: string) => (db.prepare('SELECT status FROM direct_pay_fee_stakes WHERE order_id=?').get(o) as { status?: string } | undefined)?.status
const reserve = () => toUnits((db.prepare('SELECT balance FROM protocol_reserve_pool WHERE id=1').get() as { balance: number }).balance)
const penalty = () => db.prepare("SELECT balance, total_fee_stake_slash, total_base_bond_slash FROM penalty_fund WHERE id='main'").get() as { balance: number; total_fee_stake_slash: number; total_base_bond_slash: number }

// 1. lock
ok('lock ok', lockFeeStake(db, { orderId: 'o1', sellerId: 'seller1', feeUnits: FEE, stakeId: 's1' }).ok === true)
ok('lock: balance 95 / fee_staked 5', bal('seller1').balance === toUnits(95) && bal('seller1').fee_staked === FEE, JSON.stringify(bal('seller1')))
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('seller2', 1)").run()
ok('lock insufficient → ok:false', lockFeeStake(db, { orderId: 'oX', sellerId: 'seller2', feeUnits: FEE, stakeId: 'sX' }).ok === false)
ok('lock dup order → ok:false', lockFeeStake(db, { orderId: 'o1', sellerId: 'seller1', feeUnits: FEE, stakeId: 's1b' }).ok === false)

// 2. take fee at completion (整笔 → 协议 reserve 50% + ops 50%)
takeFeeAtCompletion(db, { orderId: 'o1' })
ok('take: fee_staked → 0', bal('seller1').fee_staked === 0)
ok('take: reserve+ops == fee (conservation)', reserve() + bal('sys_protocol').balance === FEE, `reserve=${reserve()} ops=${bal('sys_protocol').balance} fee=${FEE}`)
ok('take: status fee_taken', stakeStatus('o1') === 'fee_taken')
takeFeeAtCompletion(db, { orderId: 'o1' })
ok('take idempotent (reserve+ops unchanged)', reserve() + bal('sys_protocol').balance === FEE)

// 3. release (未付/取消/超时)
lockFeeStake(db, { orderId: 'o2', sellerId: 'seller1', feeUnits: FEE, stakeId: 's2' })
const beforeRel = bal('seller1').balance
releaseFeeStake(db, { orderId: 'o2' })
ok('release: balance restored', bal('seller1').balance === beforeRel + FEE)
ok('release: fee_staked 0 / status released', bal('seller1').fee_staked === 0 && stakeStatus('o2') === 'released')

// 4. slash (违约 → penalty,卖家不退)
lockFeeStake(db, { orderId: 'o3', sellerId: 'seller1', feeUnits: FEE, stakeId: 's3' })
const beforeSlash = bal('seller1').balance
slashFeeStakeToPenalty(db, { orderId: 'o3', txnId: 't3', reason: 'fault' })
ok('slash: seller balance NOT restored', bal('seller1').balance === beforeSlash)
ok('slash: fee_staked 0 / status slashed', bal('seller1').fee_staked === 0 && stakeStatus('o3') === 'slashed')
ok('slash: penalty.balance += fee', toUnits(penalty().balance) === FEE)
ok('slash: total_fee_stake_slash += fee', toUnits(penalty().total_fee_stake_slash) === FEE)
ok('slash: txn source=fee_stake', (db.prepare("SELECT source FROM penalty_fund_txns WHERE id='t3'").get() as { source?: string } | undefined)?.source === 'fee_stake')

// 5. base-bond slash (外部资产:仅 provenance,不进 WAZ balance)
const penBalBefore = toUnits(penalty().balance)
recordBaseBondSlash(db, { userId: 'seller1', amountUnits: toUnits(50), txnId: 'tb1', reason: 'deferral-violation' })
ok('base-bond slash: WAZ balance UNCHANGED (external gated)', toUnits(penalty().balance) === penBalBefore)
ok('base-bond slash: total_base_bond_slash += 50', toUnits(penalty().total_base_bond_slash) === toUnits(50))
ok('base-bond slash: txn source=base_bond', (db.prepare("SELECT source FROM penalty_fund_txns WHERE id='tb1'").get() as { source?: string } | undefined)?.source === 'base_bond')

// 6. APPEND-ONLY 不变量: 模块不导出任何 penalty 出账函数
const exported = Object.keys(ledgerMod)
const outflowish = exported.filter(n => /debit|disburse|withdraw|payout|outflow|refundPenalty|drainPenalty|spendPenalty/i.test(n))
ok('penalty append-only: no outflow function exported', outflowish.length === 0, `found: ${outflowish.join(',')}`)
ok('exports exactly the 5 intended helpers', exported.slice().sort().join(',') === ['lockFeeStake', 'takeFeeAtCompletion', 'releaseFeeStake', 'slashFeeStakeToPenalty', 'recordBaseBondSlash'].sort().join(','), exported.join(','))

// 7. FAIL-CLOSED(审计 P1-2):direct_p2p 完成必须有可取的 locked fee-stake,否则平台费会被静默落空。
//    takeFeeAtCompletion 缺 stake / 非-locked 时必须【抛】(settleOrder 在 db.transaction 内 → 回滚),
//    绝不静默 return(那正是 fail-open 漏洞);已 fee_taken 则幂等返回 already_taken。
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }
ok('take: NO stake row → THROWS (fail-closed, no silent fee-skip)', throws(() => takeFeeAtCompletion(db, { orderId: 'no_such_order' })))
lockFeeStake(db, { orderId: 'o7', sellerId: 'seller1', feeUnits: FEE, stakeId: 's7' })
releaseFeeStake(db, { orderId: 'o7' })
ok('take: released(non-locked) stake → THROWS', throws(() => takeFeeAtCompletion(db, { orderId: 'o7' })))
ok('take: failed take moved NO funds (o7 stays released, fee_staked 0)', stakeStatus('o7') === 'released' && bal('seller1').fee_staked === 0)
lockFeeStake(db, { orderId: 'o8', sellerId: 'seller1', feeUnits: FEE, stakeId: 's8' })
ok('take: locked → outcome=taken', takeFeeAtCompletion(db, { orderId: 'o8' }).outcome === 'taken')
ok('take: re-call → outcome=already_taken (idempotent, no throw)', takeFeeAtCompletion(db, { orderId: 'o8' }).outcome === 'already_taken')

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-ledger tests passed`)
