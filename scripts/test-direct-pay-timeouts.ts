#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) 超时 + 宽限窗口测试。
 * 设计稿 §4/§5。验收点(Holden req #1/#2):
 *   - 付款窗口超时 → direct_expired_unconfirmed(非静默关单)+ 费用质押退卖家 + 设宽限期。
 *   - ★ 宽限期内:系统 sweep【绝不】关单;买家 →disputed 全程可用。
 *   - 宽限期满:系统 sweep → cancelled。
 *   - direct_p2p 结算只取 fee-stake,【绝不】碰 escrow(buyer.escrowed 不变)。
 * Usage: npm run test:direct-pay-timeouts
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-timeout-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { lockFeeStake } = await import('../src/direct-pay-ledger.js')
const { settleDirectPayFeeAtCompletion, getSellerAccruedFeeUnits, feeUnitsForOrder } = await import('../src/direct-pay-fee-ar.js')
const { runDirectPayTimeoutSweep } = await import('../src/pwa/routes/direct-pay-timeouts.js')
const { toUnits } = await import('../src/money.js')
const { walletUnits } = await import('../src/ledger.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
initSystemUser(db)  // sys_protocol (role=system)
db.exec('CREATE TABLE IF NOT EXISTS protocol_reserve_pool (id INTEGER PRIMARY KEY, balance REAL DEFAULT 0)')
db.prepare('INSERT OR IGNORE INTO protocol_reserve_pool (id, balance) VALUES (1, 0)').run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('sys_protocol', 0)").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('buyer1','买家','buyer','k_buyer1')").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('seller1','卖家','seller','k_seller1')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()

const FEE = toUnits(5)
const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const graceDeadline = (id: string) => (db.prepare('SELECT direct_grace_deadline d FROM orders WHERE id=?').get(id) as { d: string | null }).d
const stakeStatus = (id: string) => (db.prepare('SELECT status FROM direct_pay_fee_stakes WHERE order_id=?').get(id) as { status?: string } | undefined)?.status

function mkOrder(id: string, st: string, opts: { windowPast?: boolean; gracePast?: boolean; graceFuture?: boolean } = {}): void {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail,
     direct_pay_window_deadline, direct_grace_deadline)
     VALUES (?, 'p1','buyer1','seller1',1,50,50,0,?, 'direct_p2p',
       ${opts.windowPast ? "datetime('now','-1 hour')" : 'NULL'},
       ${opts.gracePast ? "datetime('now','-1 hour')" : opts.graceFuture ? "datetime('now','+48 hours')" : 'NULL'})`).run(id, st)
}

// ── Scenario 1: 付款窗口超时 → expired_unconfirmed + 退质押 + 设宽限期 ──
mkOrder('o1', 'direct_pay_window', { windowPast: true })
lockFeeStake(db, { orderId: 'o1', sellerId: 'seller1', feeUnits: FEE, stakeId: 's1' })
ok('setup: seller fee-staked', walletUnits(db, 'seller1').fee_staked === FEE)
const r1 = runDirectPayTimeoutSweep({ db })
ok('window-expiry: o1 in windowExpired', r1.windowExpired.includes('o1'))
ok('window-expiry: o1 → direct_expired_unconfirmed (no silent close)', status('o1') === 'direct_expired_unconfirmed')
ok('window-expiry: fee-stake released to seller', walletUnits(db, 'seller1').fee_staked === 0 && walletUnits(db, 'seller1').balance === toUnits(100) && stakeStatus('o1') === 'released')
ok('window-expiry: grace deadline set (future)', !!graceDeadline('o1'))

// ── Scenario 2: 宽限期内 — 系统绝不关单 + 买家 →disputed 可用 ──
const r2 = runDirectPayTimeoutSweep({ db })  // o1 grace is +48h (future)
ok('★ before grace: system does NOT cancel', !r2.graceCancelled.includes('o1') && status('o1') === 'direct_expired_unconfirmed')
const disp = transition(db, 'o1', 'disputed', 'buyer1', ['ev1'], '我确实付了')
ok('★ before grace: buyer →disputed IS available', disp.success === true && status('o1') === 'disputed', JSON.stringify(disp))

// ── Scenario 3: 宽限期满 → 系统关单 ──
mkOrder('o2', 'direct_expired_unconfirmed', { gracePast: true })
const r3 = runDirectPayTimeoutSweep({ db })
ok('after grace: o2 in graceCancelled', r3.graceCancelled.includes('o2'))
ok('after grace: o2 → cancelled', status('o2') === 'cancelled')

// ── Scenario 3b: 控制组 — 宽限期未到的 expired_unconfirmed 不被关 ──
mkOrder('o3', 'direct_expired_unconfirmed', { graceFuture: true })
runDirectPayTimeoutSweep({ db })
ok('control: future-grace order NOT cancelled', status('o3') === 'direct_expired_unconfirmed')

// ── req #2: direct_p2p 完成结算 = 释放任何遗留模拟 stake + 记链下应收(AR),绝不碰 escrow ──
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('buyer4','买家4','buyer','k_b4')").run()
db.prepare("INSERT INTO wallets (user_id, balance, escrowed) VALUES ('buyer4', 0, 100)").run()  // 模拟买家有 escrow 余额
mkOrder('o4', 'confirmed')
db.prepare("UPDATE orders SET buyer_id='buyer4' WHERE id='o4'").run()
lockFeeStake(db, { orderId: 'o4', sellerId: 'seller1', feeUnits: FEE, stakeId: 's4' })  // 遗留模拟 stake(cutover 前建单)
const buyerEscrowBefore = walletUnits(db, 'buyer4').escrowed
settleDirectPayFeeAtCompletion(db, { id: 'o4', seller_id: 'seller1', total_amount: 50, source: 'shop' }, 'dpfr_o4')  // = settleOrder 的 direct_p2p 分支
ok('direct_p2p settle: buyer.escrowed UNTOUCHED (no escrow path)', walletUnits(db, 'buyer4').escrowed === buyerEscrowBefore && buyerEscrowBefore === toUnits(100))
ok('direct_p2p settle: 遗留模拟 stake 释放(不取、退卖家;非 fee_taken)', stakeStatus('o4') === 'released')
ok('direct_p2p settle: 记一笔平台费应收(2% of 50 = 1 USDC)', getSellerAccruedFeeUnits(db, 'seller1') === feeUnitsForOrder(toUnits(50), 'shop'))

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-timeouts tests passed`)
