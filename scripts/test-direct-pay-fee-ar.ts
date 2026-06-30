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
} from '../src/direct-pay-fee-ar.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const mkParam = (v: unknown) => (<T,>(_k: string, fb: T): T => (v === undefined ? fb : (v as T)))
const U = (usdc: number) => usdc * 1_000_000 // USDC → base-units

// ── 1. withinFeeArCreditCeiling 数学边界 ──
ok('gate: sum == ceiling → ok', withinFeeArCreditCeiling({ outstandingUnits: U(30), openOrdersEstFeeUnits: U(10), newOrderFeeUnits: U(10), ceilingUnits: U(50) }) === true)
ok('gate: sum > ceiling → false', withinFeeArCreditCeiling({ outstandingUnits: U(30), openOrdersEstFeeUnits: U(10), newOrderFeeUnits: U(11), ceilingUnits: U(50) }) === false)
ok('gate: ceiling 0 → false (block)', withinFeeArCreditCeiling({ outstandingUnits: 0, openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(1), ceilingUnits: 0 }) === false)
ok('gate: negative outstanding (credit) allows', withinFeeArCreditCeiling({ outstandingUnits: -U(5), openOrdersEstFeeUnits: 0, newOrderFeeUnits: U(3), ceilingUnits: 0 }) === true)

// ── DB setup (建子集表;镜像 schema.ts) ──
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE direct_pay_fee_receivables (id TEXT, order_id TEXT, seller_id TEXT, amount REAL, currency TEXT, accrued_at TEXT, invoice_id TEXT);
  CREATE TABLE direct_pay_fee_adjustments (id TEXT, receivable_id TEXT, seller_id TEXT, delta_amount REAL, currency TEXT, kind TEXT, reason TEXT, created_at TEXT, created_by TEXT);
  CREATE TABLE direct_pay_fee_payments (id TEXT, seller_id TEXT, invoice_id TEXT, amount REAL, currency TEXT, method TEXT, received_at TEXT, recorded_by TEXT, evidence_ref TEXT, note TEXT);
  CREATE TABLE direct_pay_fee_ar_seller_overrides (seller_id TEXT PRIMARY KEY, ceiling_units INTEGER, updated_by TEXT, updated_at TEXT);
`)

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
db.prepare("INSERT INTO direct_pay_fee_ar_seller_overrides (seller_id, ceiling_units) VALUES ('s4', -5)").run()
ok('effective: override negative → 0 (fail-closed)', readEffectiveFeeArCeilingUnits(db, 's4', P) === 0)
ok('effective: other seller no override → global', readEffectiveFeeArCeilingUnits(db, 's2', P) === U(50))

// ── 5. 参数键常量 ──
ok('param key stable', FEE_AR_CEILING_PARAM === 'direct_pay.fee_ar_credit_ceiling_units')

if (fail) { console.error(`\nFAIL ${fail}/${pass + fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✓ direct-pay-fee-ar: ${pass}/${pass} passed`)
