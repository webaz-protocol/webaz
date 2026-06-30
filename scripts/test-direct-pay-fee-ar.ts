#!/usr/bin/env tsx
/**
 * Direct Pay 平台服务费 —— 首单宽限 + 预充值续用 helper 单测。
 * 覆盖:可用预充值派生(topups[invoice_id NULL] + adjustments − receivables)、首单宽限判定、
 *   建单门纯函数、费率 SSOT、在途预估、accrue(fail-closed+幂等)、append-only DB 硬强制。
 */
import Database from 'better-sqlite3'
import { toDecimal } from '../src/money.js'
import {
  getSellerAccruedFeeUnits, readAvailableFeePrepayUnits, sellerDirectPayGraceEligible,
  feePrepayGateOk, feeUnitsForOrder, estimateOpenDirectPayFeeUnits, accrueFeeReceivable, recordFeePrepayTopup, FEE_AR_CURRENCY,
} from '../src/direct-pay-fee-ar.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const U = (usdc: number) => usdc * 1_000_000 // USDC → base-units
const threw = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

// ── 1. feePrepayGateOk 纯函数 ──
ok('gate: grace → true 即便余额 0', feePrepayGateOk({ graceEligible: true, availablePrepayUnits: 0, openOrdersEstFeeUnits: U(5), newOrderFeeUnits: U(3) }) === true)
ok('gate: 非首单 available == open+new → true', feePrepayGateOk({ graceEligible: false, availablePrepayUnits: U(8), openOrdersEstFeeUnits: U(5), newOrderFeeUnits: U(3) }) === true)
ok('gate: 非首单 available < open+new → false', feePrepayGateOk({ graceEligible: false, availablePrepayUnits: U(7), openOrdersEstFeeUnits: U(5), newOrderFeeUnits: U(3) }) === false)
ok('gate: 非首单 available 0 → false', feePrepayGateOk({ graceEligible: false, availablePrepayUnits: 0, openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(1) }) === false)
ok('gate: 非首单 available 负(欠款)→ false', feePrepayGateOk({ graceEligible: false, availablePrepayUnits: -U(2), openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(1) }) === false)

// ── DB setup (镜像 schema.ts:append-only fact 行 + 触发器)──
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE direct_pay_fee_receivables (id TEXT, order_id TEXT, seller_id TEXT, amount REAL NOT NULL CHECK (amount >= 0), currency TEXT, accrued_at TEXT);
  CREATE TABLE direct_pay_fee_adjustments (id TEXT, receivable_id TEXT, seller_id TEXT, delta_amount REAL, currency TEXT, kind TEXT, reason TEXT, created_at TEXT, created_by TEXT);
  CREATE TABLE direct_pay_fee_payments (id TEXT, seller_id TEXT, invoice_id TEXT, amount REAL NOT NULL CHECK (amount >= 0), currency TEXT, method TEXT, received_at TEXT, recorded_by TEXT, evidence_ref TEXT, note TEXT);
  CREATE TABLE orders (id TEXT, seller_id TEXT, payment_rail TEXT, status TEXT, total_amount REAL, source TEXT);
  CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TRIGGER trg_dp_fee_receivables_no_update BEFORE UPDATE ON direct_pay_fee_receivables BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_receivables_no_delete BEFORE DELETE ON direct_pay_fee_receivables BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_payments_no_update BEFORE UPDATE ON direct_pay_fee_payments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_payments_no_delete BEFORE DELETE ON direct_pay_fee_payments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_adjustments_no_delete BEFORE DELETE ON direct_pay_fee_adjustments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`)
const recv = (id: string, seller: string, amt: number) => db.prepare("INSERT INTO direct_pay_fee_receivables (id,order_id,seller_id,amount,currency) VALUES (?,?,?,?,'usdc')").run(id, 'o_' + id, seller, toDecimal(amt))
const topup = (id: string, seller: string, amt: number, invoiceId: string | null = null) => db.prepare("INSERT INTO direct_pay_fee_payments (id,seller_id,invoice_id,amount,currency,method) VALUES (?,?,?,?,'usdc','usdc')").run(id, seller, invoiceId, toDecimal(amt))

// ── 2. readAvailableFeePrepayUnits 派生 ──
ok('available empty → 0', readAvailableFeePrepayUnits(db, 's1') === 0)
topup('p1', 's1', U(20))
ok('available = Σ top-ups', readAvailableFeePrepayUnits(db, 's1') === U(20))
recv('r1', 's1', U(8))
ok('available − accrued receivable', readAvailableFeePrepayUnits(db, 's1') === U(12))
db.prepare("INSERT INTO direct_pay_fee_adjustments (id,seller_id,delta_amount,currency,kind) VALUES ('a1','s1',?,'usdc','correction')").run(toDecimal(U(1)))
ok('available + 正调整(贷记)', readAvailableFeePrepayUnits(db, 's1') === U(13))
topup('p2', 's1', U(99), 'inv_x')  // invoice_id 非空 = 已分配,不计入 available
ok('available 排除 invoice_id 非空的 payment', readAvailableFeePrepayUnits(db, 's1') === U(13))
ok('available isolates per seller', readAvailableFeePrepayUnits(db, 's2') === 0)
ok('available missing-table → 0 (defensive)', readAvailableFeePrepayUnits(new Database(':memory:'), 's1') === 0)
ok('accrued = Σ receivables', getSellerAccruedFeeUnits(db, 's1') === U(8))

// ── 3. sellerDirectPayGraceEligible ──
ok('grace: 无任何 direct_p2p 单 → true', sellerDirectPayGraceEligible(db, 'gNew') === true)
db.prepare("INSERT INTO orders VALUES ('go1','gOpen','direct_p2p','direct_pay_window',50,'shop')").run()
ok('grace: 有在途单 → false', sellerDirectPayGraceEligible(db, 'gOpen') === false)
db.prepare("INSERT INTO orders VALUES ('go2','gDone','direct_p2p','completed',50,'shop')").run()
ok('grace: 有已完成单 → false', sellerDirectPayGraceEligible(db, 'gDone') === false)
db.prepare("INSERT INTO orders VALUES ('go3','gCancel','direct_p2p','cancelled',50,'shop')").run()
ok('grace: 仅终态(cancelled)单 → 仍 true(从未计费)', sellerDirectPayGraceEligible(db, 'gCancel') === true)
db.prepare("INSERT INTO orders VALUES ('go4','gEsc','escrow','confirmed',50,'shop')").run()
ok('grace: 仅 escrow 单 → true(不算 direct_p2p)', sellerDirectPayGraceEligible(db, 'gEsc') === true)
ok('grace: missing orders table → false (fail-closed)', sellerDirectPayGraceEligible(new Database(':memory:'), 'x') === false)

// ── 4. 费率 SSOT + 在途预估 ──
ok('feeUnitsForOrder: shop 2%', feeUnitsForOrder(U(100), 'shop') === U(2))
ok('feeUnitsForOrder: secondhand 1%', feeUnitsForOrder(U(100), 'secondhand') === U(1))
ok('feeUnitsForOrder: null source → 2%', feeUnitsForOrder(U(100), null) === U(2))
db.prepare("INSERT INTO orders VALUES ('eo1','sE','direct_p2p','delivered',100,'shop')").run()        // 在途 → 2
db.prepare("INSERT INTO orders VALUES ('eo2','sE','direct_p2p','direct_pay_window',100,'secondhand')").run()  // 在途 → 1
db.prepare("INSERT INTO orders VALUES ('eo3','sE','direct_p2p','completed',100,'shop')").run()         // 完成 → 不计
db.prepare("INSERT INTO orders VALUES ('eo4','sE','direct_p2p','cancelled',100,'shop')").run()         // 终态 → 不计
db.prepare("INSERT INTO orders VALUES ('eo5','sE','escrow','delivered',100,'shop')").run()             // 非 direct_p2p → 不计
ok('estimate: only open direct_p2p (2+1=3)', estimateOpenDirectPayFeeUnits(db, 'sE') === U(3))
ok('estimate: missing orders table → 0', estimateOpenDirectPayFeeUnits(new Database(':memory:'), 'sE') === 0)

// ── 5. accrue:fail-closed + 幂等 ──
const adb = new Database(':memory:')
adb.exec(`CREATE TABLE direct_pay_fee_receivables (id TEXT PRIMARY KEY, order_id TEXT UNIQUE, seller_id TEXT, amount REAL, currency TEXT, accrued_at TEXT)`)
ok('accrue: first → accrued', accrueFeeReceivable(adb, { orderId: 'o1', sellerId: 's1', feeUnits: U(2), receivableId: 'r1' }).outcome === 'accrued')
ok('accrue: writes receivable amount', getSellerAccruedFeeUnits(adb, 's1') === U(2))
ok('accrue: idempotent (same order → already)', accrueFeeReceivable(adb, { orderId: 'o1', sellerId: 's1', feeUnits: U(2), receivableId: 'r2' }).outcome === 'already' && getSellerAccruedFeeUnits(adb, 's1') === U(2))
ok('accrue: fee<=0 → throw (fail-closed)', threw(() => accrueFeeReceivable(adb, { orderId: 'o2', sellerId: 's1', feeUnits: 0, receivableId: 'r3' })))

// ── 6. append-only DB 硬强制 + CHECK ──
ok('DB CHECK rejects negative receivable amount', threw(() => db.prepare("INSERT INTO direct_pay_fee_receivables (id,order_id,seller_id,amount,currency) VALUES ('rn','on','s1',-1,'usdc')").run()))
ok('receivable UPDATE rejected', threw(() => db.prepare("UPDATE direct_pay_fee_receivables SET amount=? WHERE id='r1'").run(toDecimal(U(99)))))
ok('receivable DELETE rejected', threw(() => db.prepare("DELETE FROM direct_pay_fee_receivables WHERE id='r1'").run()))
ok('payment UPDATE rejected', threw(() => db.prepare("UPDATE direct_pay_fee_payments SET amount=? WHERE id='p1'").run(toDecimal(U(99)))))
ok('payment DELETE rejected', threw(() => db.prepare("DELETE FROM direct_pay_fee_payments WHERE id='p1'").run()))
ok('available unchanged after rejected mutations', readAvailableFeePrepayUnits(db, 's1') === U(13))

// ── 7. recordFeePrepayTopup(预付款录入 helper)──
ok('topup: missing seller → error', recordFeePrepayTopup(db, { sellerId: '', amountUnits: U(10), method: 'usdc', recordedBy: 'admin1' }).ok === false)
ok('topup: amount<=0 → error', recordFeePrepayTopup(db, { sellerId: 'sP', amountUnits: 0, method: 'usdc', recordedBy: 'admin1' }).error === 'AMOUNT_MUST_BE_POSITIVE')
ok('topup: non-integer → error', recordFeePrepayTopup(db, { sellerId: 'sP', amountUnits: 1.5, method: 'usdc', recordedBy: 'admin1' }).error === 'AMOUNT_MUST_BE_POSITIVE')
ok('topup: bad method → error', recordFeePrepayTopup(db, { sellerId: 'sP', amountUnits: U(10), method: 'paypal', recordedBy: 'admin1' }).error === 'BAD_METHOD')
ok('topup: happy → ok + id', (() => { const r = recordFeePrepayTopup(db, { sellerId: 'sP', amountUnits: U(40), method: 'usdc', recordedBy: 'admin1', evidenceRef: 'tx#1' }); return r.ok && !!r.id })())
ok('topup: counts into available (invoice_id NULL)', readAvailableFeePrepayUnits(db, 'sP') === U(40))
ok('topup: fiat method accepted', recordFeePrepayTopup(db, { sellerId: 'sP', amountUnits: U(10), method: 'fiat', recordedBy: 'admin1' }).ok === true && readAvailableFeePrepayUnits(db, 'sP') === U(50))

// ── 8. 币种常量 ──
ok('currency stable', FEE_AR_CURRENCY === 'usdc')

if (fail) { console.error(`\nFAIL ${fail}/${pass + fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✓ direct-pay-fee-ar: ${pass}/${pass} passed`)
