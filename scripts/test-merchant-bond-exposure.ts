#!/usr/bin/env tsx
/**
 * §6.5 collateral-backed open-exposure cap — unit test (PR2).
 * 覆盖:fail-closed 参数、休眠安全(collateral=0 → N/A,且不读参数)、数学边界、超限拒、缺表安全。
 */
import Database from 'better-sqlite3'
import { toUnits } from '../src/money.js'
import {
  readExposureFactorBps, getActiveCollateralUnits, computeDirectPayOpenExposureUnits,
  withinExposureCap, enforceCollateralExposureGate, ExposureCapConfigError,
} from '../src/merchant-bond-exposure.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const threw = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

const mkParam = (v: unknown) => (<T,>(_k: string, fb: T): T => (v === undefined ? fb : (v as T)))

// ── 1. readExposureFactorBps fail-closed ──
ok('factor missing → throw', threw(() => readExposureFactorBps(mkParam(undefined))))
ok('factor "" → throw', threw(() => readExposureFactorBps(mkParam(''))))
ok('factor non-numeric → throw', threw(() => readExposureFactorBps(mkParam('abc'))))
ok('factor 0 → throw', threw(() => readExposureFactorBps(mkParam('0'))))
ok('factor >10000 → throw', threw(() => readExposureFactorBps(mkParam('10001'))))
ok('factor 8000 → 8000', readExposureFactorBps(mkParam('8000')) === 8000)
ok('factor 5 → 5', readExposureFactorBps(mkParam(5)) === 5)
ok('throws ExposureCapConfigError type', (() => { try { readExposureFactorBps(mkParam(undefined)); return false } catch (e) { return e instanceof ExposureCapConfigError } })())

// ── 2. withinExposureCap 数学边界 ──
ok('within: open+new == allowed → ok', withinExposureCap({ activeCollateralUnits: 1000n, openExposureUnits: 700n, newOrderUnits: 100n, factorBps: 8000 }) === true) // allowed=800
ok('within: open+new > allowed → false', withinExposureCap({ activeCollateralUnits: 1000n, openExposureUnits: 700n, newOrderUnits: 101n, factorBps: 8000 }) === false)

// ── DB setup ──
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE merchant_bond_deposits (id TEXT, seller_id TEXT, status TEXT, collateral_units TEXT);
  CREATE TABLE orders (id TEXT, seller_id TEXT, payment_rail TEXT, status TEXT, total_amount REAL);
`)

// ── 3. getActiveCollateralUnits ──
ok('collateral 0 when no rows', getActiveCollateralUnits(db, 's1') === 0n)
db.prepare("INSERT INTO merchant_bond_deposits VALUES ('d1','s1','active','400000000')").run()
db.prepare("INSERT INTO merchant_bond_deposits VALUES ('d2','s1','cooling','999')").run() // 非 active 不计
ok('collateral sums active only', getActiveCollateralUnits(db, 's1') === 400000000n)
ok('collateral missing-table → 0n (defensive)', getActiveCollateralUnits(new Database(':memory:'), 's1') === 0n)

// ── 4. computeDirectPayOpenExposureUnits ──
db.prepare("INSERT INTO orders VALUES ('o1','s1','direct_p2p','accepted',100)").run()      // 开放
db.prepare("INSERT INTO orders VALUES ('o2','s1','direct_p2p','completed',50)").run()       // 关闭→不计
db.prepare("INSERT INTO orders VALUES ('o3','s1','direct_p2p','cancelled',50)").run()       // 关闭→不计
db.prepare("INSERT INTO orders VALUES ('o4','s1','escrow','accepted',999)").run()           // 非直付→不计
ok('open exposure sums only open direct_p2p', computeDirectPayOpenExposureUnits(db, 's1') === BigInt(toUnits(100)))

// ── 5. enforceCollateralExposureGate ──
// 5a 休眠:collateral=0 → ok,且【即便参数缺失也不报错】(证明现有直付/缓交卖家零影响)
ok('gate N/A when collateral=0 (dormant, param NOT read)', enforceCollateralExposureGate(db, 's_no_collateral', toUnits(100) as never, mkParam(undefined)).ok === true)
// 5b collateral>0 + 在上限内 → ok。s1: collateral 400e6, factor 8000 → allowed 320e6;open=100e6(o1);new=100 → 200e6 ≤ 320e6
ok('gate ok within cap', enforceCollateralExposureGate(db, 's1', toUnits(100) as never, mkParam('8000')).ok === true)
// 5c collateral>0 + 超限 → EXPOSURE_CAP_EXCEEDED。new=300 → open 100e6 + 300e6 = 400e6 > 320e6
const over = enforceCollateralExposureGate(db, 's1', toUnits(300) as never, mkParam('8000'))
ok('gate reject over cap → EXPOSURE_CAP_EXCEEDED', over.ok === false && over.error_code === 'EXPOSURE_CAP_EXCEEDED')
// 5d collateral>0 + 坏参数 → fail-closed EXPOSURE_CAP_CONFIG
const badcfg = enforceCollateralExposureGate(db, 's1', toUnits(1) as never, mkParam('0'))
ok('gate fail-closed on bad param → EXPOSURE_CAP_CONFIG', badcfg.ok === false && badcfg.error_code === 'EXPOSURE_CAP_CONFIG')

console.log(fails.join('\n'))
console.log(`\n${fail === 0 ? '✅' : '❌'} merchant-bond §6.5 exposure cap (PR2): dormant-safe, fail-closed, math`)
console.log(`  ${fail === 0 ? '✅' : '❌'} pass ${pass}${fail ? ` · fail ${fail}` : ''}`)
if (fail > 0) process.exit(1)
