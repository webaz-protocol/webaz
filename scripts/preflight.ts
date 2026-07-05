#!/usr/bin/env tsx
/**
 * Tier-1 launch preflight (#937 A1) — runtime/config readiness the CI gates can't see.
 *
 * CI already enforces the STATIC invariants (build / schema:verify / routes:seam-check /
 * contract:verify / license / meta-rules / params). This script checks the LIVE target's
 * runtime + DB config right before launch — run it against the box you're about to launch:
 *     WEBAZ_DB_PATH=/path/to/prod.db NODE_ENV=production npm run preflight
 *   (on Railway:  railway run npm run preflight)
 *
 * Exit code: 1 if any FAIL, else 0 (WARN doesn't block but is surfaced).
 * Read-only: opens the DB readonly, never writes.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { isFaucetAllowed } from '../src/pwa/routes/wallet-read.js'

type Status = 'PASS' | 'WARN' | 'FAIL'
const results: Array<{ status: Status; name: string; detail?: string }> = []
const check = (status: Status, name: string, detail?: string) => results.push({ status, name, detail })

// ── 1. WALLET_MASTER_SEED (prod-critical: derives deposit/custody keys) ──
const seed = process.env.WALLET_MASTER_SEED
if (!seed) check('WARN', 'WALLET_MASTER_SEED set', 'unset in this shell — MUST be set (≥32 chars) in the launch env')
else if (seed.length < 32) check('FAIL', 'WALLET_MASTER_SEED strength', `only ${seed.length} chars; need ≥32 random chars`)
else check('PASS', 'WALLET_MASTER_SEED strength', `${seed.length} chars`)

// ── 2. Faucet (WAZ mint) posture — must be CLOSED on the launch target (#1128) ──
const nodeEnv = process.env.NODE_ENV
const onDeployPlatform = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID)
const faucetOpen = isFaucetAllowed({ nodeEnv, onDeployPlatform, explicitEnableFlag: process.env.WEBAZ_ENABLE_TEST_FAUCET === '1' })
if (nodeEnv === 'production' || onDeployPlatform) {
  if (faucetOpen) check('FAIL', 'faucet closed on deploy target', `NODE_ENV=${nodeEnv ?? '(unset)'} platform=${onDeployPlatform} flag=${process.env.WEBAZ_ENABLE_TEST_FAUCET ?? '(unset)'} → faucet OPEN`)
  else check('PASS', 'faucet closed on deploy target')
} else {
  check('PASS', 'faucet posture (local — open is expected)', `NODE_ENV=${nodeEnv ?? '(unset)'}`)
}

// ── 3. DB-backed config sanity (readonly) ──
const DB_PATH = process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')
if (!existsSync(DB_PATH)) {
  check('FAIL', 'DB present', `not found at ${DB_PATH} — boot the server once or set WEBAZ_DB_PATH`)
} else {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    // 3a. core tables exist
    for (const t of ['orders', 'wallets', 'protocol_params', 'users']) {
      const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
      check(ok ? 'PASS' : 'FAIL', `table ${t} exists`)
    }
    // 3b. sys_protocol user (settlement/forfeit destination)
    const sys = db.prepare("SELECT id FROM users WHERE id='sys_protocol'").get()
    check(sys ? 'PASS' : 'FAIL', 'sys_protocol user seeded')

    // 3c. iron-rule human-presence params all = 1
    const hp = db.prepare("SELECT key, value FROM protocol_params WHERE key LIKE 'require_human_presence%'").all() as Array<{ key: string; value: string }>
    if (hp.length === 0) check('FAIL', 'iron-rule human-presence params present', 'none found — gates would be off')
    else {
      const off = hp.filter(p => String(p.value) !== '1')
      check(off.length === 0 ? 'PASS' : 'FAIL', `iron-rule human-presence (${hp.length} params = 1)`,
        off.length ? `OFF: ${off.map(p => p.key).join(', ')}` : undefined)
    }

    // 3d. RFC-008 fee caps (max_value) + pre-launch fund_base
    const feeRows = db.prepare("SELECT key, value, max_value FROM protocol_params WHERE key IN ('protocol_fee_rate_shop','protocol_fee_rate_secondhand','fund_base_rate')").all() as Array<{ key: string; value: string; max_value: number | null }>
    const feeCap: Record<string, number> = { protocol_fee_rate_shop: 0.02, protocol_fee_rate_secondhand: 0.02, fund_base_rate: 0.01 }
    // Codex #259 P2:遍历【期望的 key】而非返回行——任一关键经济参数缺失必须 FAIL,不能少打一项就放行。
    const byKey = new Map(feeRows.map(r => [r.key, r]))
    for (const [key, cap] of Object.entries(feeCap)) {
      const r = byKey.get(key)
      if (!r) { check('FAIL', `${key} present`, 'missing from protocol_params'); continue }
      const mv = Number(r.max_value)
      if (!(mv <= cap + 1e-9)) check('FAIL', `${key} cap ≤ ${cap}`, `max_value=${r.max_value}`)
      else if (Number(r.value) > mv + 1e-9) check('FAIL', `${key} value ≤ cap`, `value=${r.value} > max=${r.max_value}`)
      else check('PASS', `${key} (value=${r.value}, cap=${r.max_value})`)
    }
    const fb = byKey.get('fund_base_rate')
    if (fb && Number(fb.value) !== 0) check('WARN', 'fund_base_rate = 0 pre-launch', `value=${fb.value} (intended 0 until real GMV)`)
  } finally {
    db.close()
  }
}

// ── 4. Static-gate reminder (CI enforces these; listed for a manual pre-launch run) ──
const STATIC_GATES = 'npm run build && npm run schema:verify && npm run routes:seam-check && npm run contract:verify && npm run license:check && npm run meta-rules:check && npm run params:check && npm run check:api-docs-fresh && npm run pg:verify && npm run guard:complexity && npm run guard:pr-constraints && npm run check:pwa-syntax'   // 2026-07-05 补全:api-docs 漂移(本 session 漏跑 ×4 全靠 CI 拦)/pg 四层 parity/ratchet/pr-constraints/pwa-syntax —— 推 PR 前跑本命令,不靠工作记忆

// ── report ──
const icon = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌' }
console.log('\nTier-1 launch preflight')
console.log('───────────────────────')
for (const r of results) console.log(`  ${icon[r.status]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
const fails = results.filter(r => r.status === 'FAIL').length
const warns = results.filter(r => r.status === 'WARN').length
console.log(`\n  ${results.filter(r => r.status === 'PASS').length} pass · ${warns} warn · ${fails} fail`)
console.log(`\n  ▶ also run the static gates (CI-enforced):\n    ${STATIC_GATES}`)
if (fails > 0) { console.error('\n❌ preflight FAILED — resolve the ❌ items before launch.'); process.exit(1) }
console.log('\n✅ preflight passed (review any ⚠️  warnings).')
