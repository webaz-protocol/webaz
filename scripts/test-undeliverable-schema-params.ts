#!/usr/bin/env tsx
/**
 * PR-B1(undeliverable/拒收收口 —— 地基):schema 列 + protocol_params 迁移回归。
 * 断言 fresh DB 上:两截止列存在;5 个 param 已 seed 且 min/max 正确;rollout flag 默认 0=关。
 * 无行为改动(flag off、param 未被消费)—— 仅验证地基就位,供 PR-B2/B3 读取。
 * Usage: npm run test:undeliverable-schema-params
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'undeliv-b1-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()

// ── ① 两截止列存在(ISO 存储,与 #299 一致)──
const orderCols = new Set((db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map(c => c.name))
ok('1. orders.delivery_failed_deadline 列存在', orderCols.has('delivery_failed_deadline'))
ok('2. orders.goods_return_deadline 列存在', orderCols.has('goods_return_deadline'))

// ── ② 5 个 param seed + min/max + 默认值 ──
const param = (k: string) => db.prepare('SELECT value, min_value, max_value FROM protocol_params WHERE key=?').get(k) as { value: string; min_value: number | null; max_value: number | null } | undefined
const rollout = param('undeliverable_closure_enabled')
ok('3. rollout flag seed 且默认 0=关', !!rollout && rollout.value === '0', JSON.stringify(rollout))
const restock = param('restocking_fee_rate')
ok('4. restocking_fee_rate seed 且硬上限 15%(Guardrail A)', !!restock && Number(restock.value) === 0.10 && restock.max_value === 0.15, JSON.stringify(restock))
const retCap = param('return_shipping_max_rate')
ok('5. return_shipping_max_rate seed(退程运费灌水上限)', !!retCap && Number(retCap.value) === 0.20 && retCap.min_value === 0 && retCap.max_value === 0.30, JSON.stringify(retCap))
const contestWin = param('undeliverable_contest_window_hours')
ok('6. 争议窗口 X=120h seed(bounds 0..336)', !!contestWin && Number(contestWin.value) === 120 && contestWin.min_value === 0 && contestWin.max_value === 336, JSON.stringify(contestWin))
const returnWin = param('goods_return_confirm_window_hours')
ok('7. 卖家确认收货窗口 120h seed(B2,bounds 0..336)', !!returnWin && Number(returnWin.value) === 120 && returnWin.min_value === 0 && returnWin.max_value === 336, JSON.stringify(returnWin))

// ── ③ 幂等(load-bearing):先把 flag 改成 '1'(模拟 admin 开启),再重跑 init;INSERT OR IGNORE 绝不 clobber。
//    若 seed 误用 INSERT OR REPLACE,重跑会把值打回 '0' → 本断言失败。故此测试真能抓非幂等回归。
db.prepare("UPDATE protocol_params SET value='1' WHERE key='undeliverable_closure_enabled'").run()
const db2 = initDatabase()   // 同一 HOME → 同一 DB 文件,重跑迁移/seed
ok('8. 幂等:重复 init 不覆盖已被改过的值(INSERT OR IGNORE 不 clobber)', (db2.prepare("SELECT value FROM protocol_params WHERE key='undeliverable_closure_enabled'").get() as { value: string }).value === '1')

if (fail > 0) { console.error(`\n❌ undeliverable-schema-params FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ undeliverable-schema-params (PR-B1): ${pass} pass — 两截止列 + 5 param(rollout off / restocking 15% cap / 退程 cap / 窗口 120h)就位`)
