#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) base-bond LIFECYCLE 测试 — PR-4b-min(域逻辑层,无真实资金)。
 * 锁住:manual=非生产(永不设 production_receipt_confirmed_at)、usdc/fiat GATED throw、lock 前置、
 *   topUp 回流、expire、slash 仅 provenance(WAZ NOT enabled → penalty.balance 不动)、privilege 状态、
 *   幂等、整数 base-units fail-closed、refund 占位、生产门恒 false。不碰 orders/escrow/settlement/payment。
 * Usage: npm run test:direct-receive-deposits
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-bond-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const {
  requiredBondUnits, openDeposit, confirmDepositReceipt, lockBond, markInsufficient, topUp,
  expireDeposit, slashBond, isProductionBaseBondLocked, refundOnExitBlockedReason, DEFAULT_BASE_BOND_CONFIG,
} = await import('../src/direct-receive-deposits.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
db.prepare("INSERT OR IGNORE INTO penalty_fund (id, balance, total_fee_stake_slash, total_base_bond_slash, updated_at) VALUES ('main',0,0,0,datetime('now'))").run()
db.prepare("INSERT OR IGNORE INTO users (id, name, role, api_key) VALUES ('seller1','卖家','seller','k1')").run()

const REQ = toUnits(500)  // T0 固定 token 数(标签 ≈ S$500,非 FX)
const row = (id: string) => db.prepare('SELECT * FROM direct_receive_deposits WHERE id=?').get(id) as Record<string, unknown> | undefined
const status = (id: string) => row(id)?.status as string | undefined
const prodFlag = (id: string) => row(id)?.production_receipt_confirmed_at as string | null
const priv = (u: string) => (db.prepare('SELECT status FROM direct_receive_privileges WHERE user_id=?').get(u) as { status?: string } | undefined)?.status
const penalty = () => db.prepare("SELECT balance, total_base_bond_slash FROM penalty_fund WHERE id='main'").get() as { balance: number; total_base_bond_slash: number }

// ── 0. requiredBondUnits:T0 ok;T1/T2 未配置 → 抛 ──
ok('requiredBondUnits T0 = config default', requiredBondUnits('T0') === REQ)
ok('requiredBondUnits T1 → throws (4b-min 未支持)', throws(() => requiredBondUnits('T1')))
ok('requiredBondUnits T2 → throws', throws(() => requiredBondUnits('T2')))

// ── 1. manual(非生产)confirm 不设 production_receipt_confirmed_at ──
openDeposit(db, { depositId: 'd1', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
ok('open → pending', status('d1') === 'pending')
const c1 = confirmDepositReceipt(db, { depositId: 'd1', expectedAmountUnits: REQ })
ok('manual confirm → ok confirmed', c1.ok === true && status('d1') === 'confirmed', JSON.stringify(c1))
ok('manual confirm → production_receipt_confirmed_at STAYS NULL (manual = non-production)', prodFlag('d1') === null)
ok('isProductionBaseBondLocked d1 (confirmed) → false', isProductionBaseBondLocked(db, { depositId: 'd1' }) === false)

// ── 2. 生产 rail usdc_onchain / fiat_psp → GATED throw(fail-closed)──
openDeposit(db, { depositId: 'dU', userId: 'seller1', tier: 'T0', currency: 'usdc', depositRail: 'usdc_onchain' })
ok('usdc_onchain confirm → THROWS (GATED)', throws(() => confirmDepositReceipt(db, { depositId: 'dU', expectedAmountUnits: REQ })))
ok('usdc_onchain deposit stays pending (no state change)', status('dU') === 'pending')
openDeposit(db, { depositId: 'dF', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'fiat_psp' })
ok('fiat_psp confirm → THROWS (GATED)', throws(() => confirmDepositReceipt(db, { depositId: 'dF', expectedAmountUnits: REQ })))

// ── 3. lock 前置:without-confirm 失败 ──
openDeposit(db, { depositId: 'd2', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
ok('lock pending (no confirm) → fail', lockBond(db, { depositId: 'd2' }).ok === false && status('d2') === 'pending')

// ── 4. lock-insufficient 失败 ──
openDeposit(db, { depositId: 'd3', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
confirmDepositReceipt(db, { depositId: 'd3', expectedAmountUnits: toUnits(300) })  // < 500
const l3 = lockBond(db, { depositId: 'd3' })
ok('lock insufficient → fail (amount<required)', l3.ok === false, JSON.stringify(l3))
ok('insufficient lock did not flip status to locked', status('d3') === 'confirmed')

// ── 5. sufficient confirmed → locked + privilege active ──
openDeposit(db, { depositId: 'd4', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
confirmDepositReceipt(db, { depositId: 'd4', expectedAmountUnits: REQ })
const l4 = lockBond(db, { depositId: 'd4' })
ok('sufficient → locked', l4.ok === true && status('d4') === 'locked', JSON.stringify(l4))
ok('lock → privilege active', priv('seller1') === 'active')
ok('locked but NON-production (manual) → isProductionBaseBondLocked false', isProductionBaseBondLocked(db, { depositId: 'd4' }) === false)

// ── 6. topUp:insufficient → 可 lock ──
openDeposit(db, { depositId: 'd5', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
confirmDepositReceipt(db, { depositId: 'd5', expectedAmountUnits: toUnits(300) })
markInsufficient(db, { depositId: 'd5' })
ok('markInsufficient → insufficient', status('d5') === 'insufficient')
ok('lock while insufficient → fail', lockBond(db, { depositId: 'd5' }).ok === false)
topUp(db, { depositId: 'd5', addUnits: toUnits(200) })  // 300+200=500
ok('topUp → back to confirmed', status('d5') === 'confirmed')
ok('lock after topUp → locked', lockBond(db, { depositId: 'd5' }).ok === true && status('d5') === 'locked')

// ── 7. expire pending ──
openDeposit(db, { depositId: 'd6', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
db.prepare("UPDATE direct_receive_deposits SET created_at = datetime('now','-30 days') WHERE id='d6'").run()
ok('expire pending past TTL → expired', expireDeposit(db, { depositId: 'd6', nowIso: new Date().toISOString() }).ok === true && status('d6') === 'expired')
openDeposit(db, { depositId: 'd6b', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
ok('expire fresh pending → fail (not past TTL)', expireDeposit(db, { depositId: 'd6b', nowIso: new Date().toISOString() }).ok === false && status('d6b') === 'pending')

// ── 8. slash locked → provenance only;WAZ NOT enabled → penalty.balance 不动;privilege suspended ──
const penBefore = penalty()
const s4 = slashBond(db, { depositId: 'd4', txnId: 't_d4', reason: 'seller default' })
ok('slash locked → slashed', s4.ok === true && status('d4') === 'slashed', JSON.stringify(s4))
ok('slash → total_base_bond_slash += amount (provenance)', toUnits(penalty().total_base_bond_slash) === toUnits(penBefore.total_base_bond_slash) + REQ)
ok('slash → penalty.balance UNCHANGED (no WAZ outflow into penalty balance)', penalty().balance === penBefore.balance)
ok('slash txn source=base_bond', (db.prepare("SELECT source FROM penalty_fund_txns WHERE id='t_d4'").get() as { source?: string } | undefined)?.source === 'base_bond')
ok('slash → privilege suspended', priv('seller1') === 'suspended')

// ── 9. 幂等 / 明确失败 ──
ok('double confirm → already (idempotent)', confirmDepositReceipt(db, { depositId: 'd1', expectedAmountUnits: REQ }).ok === true && (confirmDepositReceipt(db, { depositId: 'd1', expectedAmountUnits: REQ }) as { already?: boolean }).already === true)
ok('double lock → already (idempotent)', (lockBond(db, { depositId: 'd5' }) as { already?: boolean }).already === true)
const beforeDouble = toUnits(penalty().total_base_bond_slash)
const s4b = slashBond(db, { depositId: 'd4', txnId: 't_d4_again' })
ok('double slash → already, no extra provenance', (s4b as { already?: boolean }).already === true && toUnits(penalty().total_base_bond_slash) === beforeDouble)

// ── 10. 整数 base-units fail-closed ──
openDeposit(db, { depositId: 'd7', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
ok('fractional confirm 500.5 → fail (not integer units)', confirmDepositReceipt(db, { depositId: 'd7', expectedAmountUnits: 500.5 }).ok === false)
ok('negative confirm → fail', confirmDepositReceipt(db, { depositId: 'd7', expectedAmountUnits: -1 }).ok === false)
ok('zero confirm → fail (must be > 0)', confirmDepositReceipt(db, { depositId: 'd7', expectedAmountUnits: 0 }).ok === false)
ok('non-safe-integer confirm → fail', confirmDepositReceipt(db, { depositId: 'd7', expectedAmountUnits: Number.MAX_SAFE_INTEGER + 2 }).ok === false)
ok('confirm guard left deposit pending (no partial write)', status('d7') === 'pending')
confirmDepositReceipt(db, { depositId: 'd7', expectedAmountUnits: REQ })
ok('fractional topUp → fail', topUp(db, { depositId: 'd7', addUnits: 0.5 }).ok === false)
ok('negative topUp → fail', topUp(db, { depositId: 'd7', addUnits: -100 }).ok === false)

// ── 11. invalid open inputs fail-closed ──
ok('open invalid currency → fail', openDeposit(db, { depositId: 'dX', userId: 'seller1', tier: 'T0', currency: 'btc', depositRail: 'manual' }).ok === false)
// WAZ NOT enabled:currency='waz' 必须 fail-closed(不让 schema 默认固化成合法路径)
ok("open currency='waz' → fail (WAZ not enabled; only usdc|fiat)", openDeposit(db, { depositId: 'dW', userId: 'seller1', tier: 'T0', currency: 'waz', depositRail: 'manual' }).ok === false)
ok("open currency='waz' created no row", row('dW') === undefined)
ok('open invalid rail → fail', openDeposit(db, { depositId: 'dY', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'paypal' }).ok === false)
ok('open duplicate id → fail', openDeposit(db, { depositId: 'd1', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' }).ok === false)

// ── 12. refund-on-exit 占位(纯判断;本 PR 不执行退款)──
ok('refund blocked: not locked', refundOnExitBlockedReason({ status: 'pending' }) === 'NOT_LOCKED')
ok('refund blocked: open dispute', refundOnExitBlockedReason({ status: 'locked', hasOpenDispute: true }) === 'OPEN_DISPUTE')
ok('refund blocked: cooling window', refundOnExitBlockedReason({ status: 'locked', withinCoolingWindow: true }) === 'COOLING_WINDOW')
ok('refund not-blocked-here → null (still NOT executed in 4b)', refundOnExitBlockedReason({ status: 'locked', hasOpenDispute: false, withinCoolingWindow: false }) === null)

// ── 13. config 默认 ──
ok('DEFAULT_BASE_BOND_CONFIG T0 = toUnits(500)', DEFAULT_BASE_BOND_CONFIG.tierRequiredUnits.T0 === REQ)
ok('DEFAULT pendingTtlDays = 7', DEFAULT_BASE_BOND_CONFIG.pendingTtlDays === 7)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-receive-deposits tests passed`)
