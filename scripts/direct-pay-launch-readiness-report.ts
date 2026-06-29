#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 上线前【就绪报告】(pre-flip go/no-go)。READ-ONLY operator CLI。
 *
 *   node --import tsx scripts/direct-pay-launch-readiness-report.ts
 *   node --import tsx scripts/direct-pay-launch-readiness-report.ts --db=/root/.webaz/webaz.db
 *
 * 在翻 direct_pay.enabled=true 之前跑这个,确认:全局控制面就绪 + 至少一个卖家可上线(ready 且有可直付商品)。
 * 纯读:不写库、不 flip、不碰资金。读 protocol_params 构造 getProtocolParam。
 * Flags: --db=<path>(默认 $WEBAZ_DB_PATH 或 ~/.webaz/webaz.db)·--json(输出 JSON)
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { summarizeDirectPayLaunchReadiness, directPayControlsSnapshot } from '../src/direct-pay-launch-summary.js'
import { format as fmtMoney } from '../src/money.js'

const argv = process.argv.slice(2)
const dbArg = argv.find(a => a.startsWith('--db='))?.slice(5)
const asJson = argv.includes('--json')
const dbPath = dbArg || process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz', 'webaz.db')
if (!existsSync(dbPath)) { console.error(`✗ DB not found: ${dbPath}  (set --db=<path> or $WEBAZ_DB_PATH)`); process.exit(2) }

const db = new Database(dbPath, { readonly: true })
const getProtocolParam = <T,>(key: string, fallback: T): T => {
  try {
    const row = db.prepare('SELECT value, type FROM protocol_params WHERE key = ?').get(key) as { value: string; type: string } | undefined
    if (!row) return fallback
    if (row.type === 'number') return Number(row.value) as unknown as T
    if (row.type === 'boolean') return (row.value === 'true' || row.value === '1') as unknown as T
    return row.value as unknown as T
  } catch { return fallback }   // 诊断 CLI:protocol_params 缺失/异常 → 回退默认(fail-closed:默认 enabled=false 等)
}

const summary = summarizeDirectPayLaunchReadiness(db, getProtocolParam)
const cfg = directPayControlsSnapshot(getProtocolParam)

if (asJson) { console.log(JSON.stringify(summary, null, 2)); process.exit(summary.go ? 0 : 1) }

const yn = (b: boolean) => b ? '✅' : '❌'
console.log('\n══════ Direct Pay — pre-flip launch readiness ══════')
console.log(`\n  GLOBAL ${yn(summary.global.ready)}`)
console.log(`    enabled            : ${cfg.enabled}`)
console.log(`    rail_breaker_trip  : ${cfg.railBreakerTripped}`)
console.log(`    region             : ${cfg.region || '(unset)'}`)
console.log(`    region_allowlist   : ${(cfg.regionAllowlist || []).join(',') || '(empty)'}`)
console.log(`    per_tx_cap_units   : ${cfg.perTxCapUnits}${cfg.perTxCapUnits ? `  (~${fmtMoney(cfg.perTxCapUnits)} WAZ)` : '  (unset → no orders)'}`)
// 区分"只差翻 enabled"与"其它真缺口":NOT_ENABLED 在 pre-flip 下是预期项,单独标注。
const otherGlobalBlockers = summary.global.blockers.filter(b => b !== 'DIRECT_PAY_NOT_ENABLED')
if (summary.pendingEnable) console.log(`    (direct_pay.enabled is OFF — expected pre-flip; flip it last)`)
if (otherGlobalBlockers.length) console.log(`    blockers (besides enable): ${otherGlobalBlockers.join(', ')}`)
console.log(`    rail cleared (diag): ${summary.global.facts.anyRailLegalCleared}  (not a launch blocker)`)

console.log(`\n  SELLERS (${summary.sellers.length} candidate${summary.sellers.length === 1 ? '' : 's'}; ${summary.launchableSellerCount} launchable)`)
if (!summary.sellers.length) console.log('    (no sellers have any direct-pay setup yet)')
for (const s of summary.sellers) {
  console.log(`    ${yn(s.launchable)} ${s.sellerId}  · products ${s.eligibleProductCount}/${s.activeProductCount} eligible${s.storeExempt ? ' (store-exempt)' : ''}`)
  if (!s.ready) console.log(`        blockers: ${s.blockers.join(', ')}`)
  else if (s.eligibleProductCount === 0) console.log(`        seller ready but 0 eligible products (verify a product or grant store exemption)`)
}

// Verdict:
//   LIVE GO        — enabled=true and fully ready (live + serving).
//   READY TO FLIP  — everything except the enable switch is ready (the useful pre-flip state).
//   NO-GO          — a real gap remains besides the enable switch.
let verdict: string
if (summary.go) verdict = '✅ LIVE GO — direct_pay is enabled and ready (≥1 launchable seller).'
else if (summary.preflipGo && summary.pendingEnable) verdict = '✅ READY TO FLIP — everything except the switch is configured. Set direct_pay.enabled=true, then re-run to confirm LIVE GO.'
else verdict = '❌ NO-GO — resolve the ❌ above (besides the enable switch) before flipping direct_pay.enabled=true.'
console.log(`\n  ${verdict}\n`)
// exit 0 when ready-to-flip OR already live (i.e., preflipGo); 1 when a real gap remains.
process.exit(summary.preflipGo ? 0 : 1)
