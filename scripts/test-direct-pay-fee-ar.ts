#!/usr/bin/env tsx
/**
 * Direct Pay 平台费链下应收(AR)读 helper — unit test (PR-1).
 * 覆盖:outstanding 派生(receivables + adjustments − payments,append-only)、缺表安全、
 *   上限 fail-closed(全局)、override ?? 全局、override 非法归 0、信用门纯函数数学边界。
 */
import Database from 'better-sqlite3'
import { toDecimal } from '../src/money.js'
import {
  getSellerOutstandingFeeArUnits, readGlobalFeeArCeilingUnits,
  readEffectiveFeeArCeilingUnits, withinFeeArCreditCeiling, FEE_AR_CEILING_PARAM,
  feeUnitsForOrder, estimateOpenDirectPayFeeUnits, accrueFeeReceivable,
} from '../src/direct-pay-fee-ar.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const mkParam = (v: unknown) => (<T,>(_k: string, fb: T): T => (v === undefined ? fb : (v as T)))
const U = (usdc: number) => usdc * 1_000_000 // USDC → base-units

// ── 1. withinFeeArCreditCeiling 数学边界 ──
ok('gate: sum == ceiling → ok', withinFeeArCreditCeiling({ outstandingUnits: U(30), openOrdersEstFeeUnits: U(10), newOrderFeeUnits: U(10), ceilingUnits: U(50) }) === true)
ok('gate: sum > ceiling → false', withinFeeArCreditCeiling({ outstandingUnits: U(30), openOrdersEstFeeUnits: U(10), newOrderFeeUnits: U(11), ceilingUnits: U(50) }) === false)
ok('gate: ceiling 0 → false (block)', withinFeeArCreditCeiling({ outstandingUnits: 0, openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(1), ceilingUnits: 0 }) === false)
ok('gate: ceiling 0 + negative outstanding still BLOCKED (fail-closed not bypassed)', withinFeeArCreditCeiling({ outstandingUnits: -U(5), openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(3), ceilingUnits: 0 }) === false)
ok('gate: ceiling <0 → false', withinFeeArCreditCeiling({ outstandingUnits: 0, openOrdersEstFeeUnits: 0, newOrderFeeUnits: 0, ceilingUnits: -1 }) === false)
ok('gate: negative outstanding (credit) offsets only when ceiling>0', withinFeeArCreditCeiling({ outstandingUnits: -U(5), openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(3), ceilingUnits: U(1) }) === true)

// ── DB setup (建子集表;镜像 schema.ts) ──
const db = new Database(':memory:')
// 镜像 schema.ts 关键约束(append-only fact 行无 invoice_id;金额/上限 CHECK ≥ 0)。
db.exec(`
  CREATE TABLE direct_pay_fee_receivables (id TEXT, order_id TEXT, seller_id TEXT, amount REAL NOT NULL CHECK (amount >= 0), currency TEXT, accrued_at TEXT);
  CREATE TABLE direct_pay_fee_adjustments (id TEXT, receivable_id TEXT, seller_id TEXT, delta_amount REAL, currency TEXT, kind TEXT, reason TEXT, created_at TEXT, created_by TEXT);
  CREATE TABLE direct_pay_fee_payments (id TEXT, seller_id TEXT, invoice_id TEXT, amount REAL NOT NULL CHECK (amount >= 0), currency TEXT, method TEXT, received_at TEXT, recorded_by TEXT, evidence_ref TEXT, note TEXT);
  CREATE TABLE direct_pay_fee_ar_seller_overrides (seller_id TEXT PRIMARY KEY, ceiling_units INTEGER NOT NULL CHECK (ceiling_units >= 0), updated_by TEXT, updated_at TEXT);
  -- append-only 硬强制(镜像 schema.ts 触发器)
  CREATE TRIGGER trg_dp_fee_receivables_no_update BEFORE UPDATE ON direct_pay_fee_receivables BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_receivables_no_delete BEFORE DELETE ON direct_pay_fee_receivables BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_payments_no_update BEFORE UPDATE ON direct_pay_fee_payments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_payments_no_delete BEFORE DELETE ON direct_pay_fee_payments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER trg_dp_fee_adjustments_no_delete BEFORE DELETE ON direct_pay_fee_adjustments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`)
const threw = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

// ── 2. outstanding 派生 ──
ok('outstanding empty → 0', getSellerOutstandingFeeArUnits(db, 's1') === 0)
db.prepare("INSERT INTO direct_pay_fee_receivables (id,order_id,seller_id,amount,currency) VALUES ('r1','o1','s1',?,'usdc')").run(toDecimal(U(10)))
db.prepare("INSERT INTO direct_pay_fee_receivables (id,order_id,seller_id,amount,currency) VALUES ('r2','o2','s1',?,'usdc')").run(toDecimal(U(5)))
ok('outstanding = Σ accrued', getSellerOutstandingFeeArUnits(db, 's1') === U(15))
db.prepare("INSERT INTO direct_pay_fee_adjustments (id,receivable_id,seller_id,delta_amount,currency,kind) VALUES ('a1','r2','s1',?,'usdc','reversal')").run(toDecimal(-U(3)))
ok('outstanding − reversal', getSellerOutstandingFeeArUnits(db, 's1') === U(12))
db.prepare("INSERT INTO direct_pay_fee_payments (id,seller_id,amount,currency,method) VALUES ('p1','s1',?,'usdc','usdc')").run(toDecimal(U(2)))
ok('outstanding − payment', getSellerOutstandingFeeArUnits(db, 's1') === U(10))
ok('outstanding isolates per seller', getSellerOutstandingFeeArUnits(db, 's2') === 0)
ok('outstanding missing-table → 0 (defensive)', getSellerOutstandingFeeArUnits(new Database(':memory:'), 's1') === 0)
ok('DB CHECK rejects negative receivable amount (P3)', threw(() => db.prepare("INSERT INTO direct_pay_fee_receivables (id,order_id,seller_id,amount,currency) VALUES ('rn','on','s1',-1,'usdc')").run()))

// ── 3. 全局上限 fail-closed ──
ok('global missing → 0', readGlobalFeeArCeilingUnits(mkParam(undefined)) === 0)
ok('global "" → 0', readGlobalFeeArCeilingUnits(mkParam('')) === 0)
ok('global non-numeric → 0', readGlobalFeeArCeilingUnits(mkParam('abc')) === 0)
ok('global negative → 0', readGlobalFeeArCeilingUnits(mkParam('-1')) === 0)
ok('global non-integer → 0', readGlobalFeeArCeilingUnits(mkParam('1.5')) === 0)
ok('global "0" → 0 (valid block)', readGlobalFeeArCeilingUnits(mkParam('0')) === 0)
ok('global "50000000" → 50000000', readGlobalFeeArCeilingUnits(mkParam('50000000')) === U(50))
ok('global number 50000000 → 50000000', readGlobalFeeArCeilingUnits(mkParam(50000000)) === U(50))

// ── 4. 生效上限 override ?? global ──
const P = mkParam('50000000')
ok('effective: no override → global', readEffectiveFeeArCeilingUnits(db, 's1', P) === U(50))
db.prepare("INSERT INTO direct_pay_fee_ar_seller_overrides (seller_id, ceiling_units) VALUES ('s1', ?)").run(U(70))
ok('effective: override present → override', readEffectiveFeeArCeilingUnits(db, 's1', P) === U(70))
db.prepare("INSERT INTO direct_pay_fee_ar_seller_overrides (seller_id, ceiling_units) VALUES ('s3', 0)").run()
ok('effective: override 0 → 0 (admin block)', readEffectiveFeeArCeilingUnits(db, 's3', P) === 0)
ok('DB CHECK rejects negative override (P3)', threw(() => db.prepare("INSERT INTO direct_pay_fee_ar_seller_overrides (seller_id, ceiling_units) VALUES ('s4', -5)").run()))
ok('effective: other seller no override → global', readEffectiveFeeArCeilingUnits(db, 's2', P) === U(50))

// ── 5. append-only DB 硬强制(P2 round 2)──
ok('receivable UPDATE rejected', threw(() => db.prepare("UPDATE direct_pay_fee_receivables SET amount = ? WHERE id = 'r1'").run(toDecimal(U(99)))))
ok('receivable DELETE rejected', threw(() => db.prepare("DELETE FROM direct_pay_fee_receivables WHERE id = 'r1'").run()))
ok('payment UPDATE rejected', threw(() => db.prepare("UPDATE direct_pay_fee_payments SET amount = ? WHERE id = 'p1'").run(toDecimal(U(99)))))
ok('payment DELETE rejected', threw(() => db.prepare("DELETE FROM direct_pay_fee_payments WHERE id = 'p1'").run()))
ok('adjustment DELETE rejected', threw(() => db.prepare("DELETE FROM direct_pay_fee_adjustments WHERE id = 'a1'").run()))
// outstanding 未被失败的变更影响(仍 10 USDC)
ok('outstanding unchanged after rejected mutations', getSellerOutstandingFeeArUnits(db, 's1') === U(10))

// ── 6. 费率 SSOT + 在途预估 + accrue(PR-2 cutover)──
ok('feeUnitsForOrder: shop 2%', feeUnitsForOrder(U(100), 'shop') === U(2))
ok('feeUnitsForOrder: secondhand 1%', feeUnitsForOrder(U(100), 'secondhand') === U(1))
ok('feeUnitsForOrder: null source → 2%', feeUnitsForOrder(U(100), null) === U(2))
db.exec(`CREATE TABLE orders (id TEXT, seller_id TEXT, payment_rail TEXT, status TEXT, total_amount REAL, source TEXT)`)
ok('estimate: no open orders → 0', estimateOpenDirectPayFeeUnits(db, 's1') === 0)
db.prepare("INSERT INTO orders VALUES ('eo1','s1','direct_p2p','delivered',100,'shop')").run()   // 在途 → 2% = 2
db.prepare("INSERT INTO orders VALUES ('eo2','s1','direct_p2p','direct_pay_window',100,'secondhand')").run()  // 在途 → 1% = 1
db.prepare("INSERT INTO orders VALUES ('eo3','s1','direct_p2p','completed',100,'shop')").run()    // 完成 → 不计(已在 receivables)
db.prepare("INSERT INTO orders VALUES ('eo4','s1','direct_p2p','cancelled',100,'shop')").run()    // 终态 → 不计
db.prepare("INSERT INTO orders VALUES ('eo5','s1','escrow','delivered',100,'shop')").run()        // 非 direct_p2p → 不计
db.prepare("INSERT INTO orders VALUES ('eo6','s2','direct_p2p','delivered',100,'shop')").run()    // 别的卖家 → 不计
ok('estimate: only open direct_p2p of this seller (2+1=3)', estimateOpenDirectPayFeeUnits(db, 's1') === U(3))
ok('estimate: missing orders table → 0 (defensive)', estimateOpenDirectPayFeeUnits(new Database(':memory:'), 's1') === 0)

// accrue:幂等 + fail-closed(此处用一个干净库,带 receivables 表)
const adb = new Database(':memory:')
adb.exec(`CREATE TABLE direct_pay_fee_receivables (id TEXT PRIMARY KEY, order_id TEXT UNIQUE, seller_id TEXT, amount REAL, currency TEXT, accrued_at TEXT)`)
ok('accrue: first → accrued', accrueFeeReceivable(adb, { orderId: 'o1', sellerId: 's1', feeUnits: U(2), receivableId: 'r1' }).outcome === 'accrued')
ok('accrue: writes receivable amount', getSellerOutstandingFeeArUnits(adb, 's1') === U(2))
ok('accrue: idempotent (same order → already, no double)', accrueFeeReceivable(adb, { orderId: 'o1', sellerId: 's1', feeUnits: U(2), receivableId: 'r2' }).outcome === 'already' && getSellerOutstandingFeeArUnits(adb, 's1') === U(2))
ok('accrue: fee<=0 → throw (fail-closed)', threw(() => accrueFeeReceivable(adb, { orderId: 'o2', sellerId: 's1', feeUnits: 0, receivableId: 'r3' })))

// ── 7. 参数键常量 ──
ok('param key stable', FEE_AR_CEILING_PARAM === 'direct_pay.fee_ar_credit_ceiling_units')

if (fail) { console.error(`\nFAIL ${fail}/${pass + fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✓ direct-pay-fee-ar: ${pass}/${pass} passed`)
