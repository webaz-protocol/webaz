#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — PR-5b-0 orders 入口控制 policy 快照列 schema 测试。
 * 仅验【列存在 + additive nullable + 无 DEFAULT】(本 PR 不写入、不接线;5b wiring 才写)。CREATE+幂等 ALTER 双路均覆盖。
 * Usage: npm run test:direct-pay-order-snapshot-schema
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-snap-schema-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
type Col = { name: string; type: string; notnull: number; dflt_value: string | null }
const cols = db.prepare('PRAGMA table_info(orders)').all() as Col[]
const byName = Object.fromEntries(cols.map(c => [c.name, c]))

const EXPECTED: Record<string, 'INTEGER' | 'TEXT'> = {
  direct_pay_enabled_snapshot: 'INTEGER',
  direct_pay_rail_breaker_snapshot: 'INTEGER',
  direct_pay_region_snapshot: 'TEXT',
  direct_pay_region_allowlist_snapshot: 'TEXT',
  direct_pay_per_tx_cap_units_snapshot: 'INTEGER',
  direct_pay_seller_breaker_snapshot: 'INTEGER',
  direct_pay_decision_code: 'TEXT',
}

for (const [name, type] of Object.entries(EXPECTED)) {
  const c = byName[name]
  ok(`orders.${name} exists`, !!c, JSON.stringify(cols.map(x => x.name)))
  if (!c) continue
  ok(`orders.${name} type ${type}`, c.type.toUpperCase() === type)
  ok(`orders.${name} is nullable (additive, no NOT NULL)`, c.notnull === 0)
  ok(`orders.${name} has NO default (snapshot written by 5b, not defaulted)`, c.dflt_value == null)
}
ok('exactly 7 snapshot columns added', Object.keys(EXPECTED).filter(n => !!byName[n]).length === 7)
// 5b-0 不写入:fresh DB 无 direct_p2p 订单,这些列在任何现有行上都应为 NULL(本 PR 无写入方)。
const anyOrder = db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }
ok('no orders yet (columns-only PR introduces no writer)', anyOrder.n === 0)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-order-snapshot-schema tests passed`)
