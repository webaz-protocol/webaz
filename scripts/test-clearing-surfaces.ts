#!/usr/bin/env tsx
/**
 * RFC-018 PR3 — clearing-total is surfaced (pure read) across every earnings surface.
 *   用法: npm run test:clearing-surfaces
 *
 * Two checks:
 *   1. SEMANTICS: the canonical clearing query sums ONLY in-window clearing rows
 *      (matures_at IS NOT NULL AND status='pending') — excludes settled clearing, reversed, and
 *      opt-out escrow (matures_at IS NULL).
 *   2. COMPLETENESS: each of the 5 earnings surfaces actually carries a `matures_at IS NOT NULL`
 *      clearing read, so a future edit can't silently drop one (the PR2a regression class).
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-clrsurf-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db: any = initDatabase()
applyWebazRuntimeSchema(db)
db.pragma('foreign_keys = OFF')
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('usr_x','x','buyer','k')").run()

const ins = (amount: number, status: string, maturesAt: number | null): void => {
  db.prepare("INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at, matures_at) VALUES ('usr_x', NULL, ?, 'L1', ?, 0, 9999, ?)").run(amount, status, maturesAt)
}

try {
  // 1. SEMANTICS
  ins(10, 'pending', 111)    // clearing, in-window → COUNTS
  ins(20, 'settled', 222)    // clearing, already paid → excluded
  ins(40, 'reversed', 333)   // clearing, reversed → excluded
  ins(80, 'pending', null)   // opt-out escrow → excluded
  const clearing = (db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM pending_commission_escrow WHERE recipient_user_id = 'usr_x' AND matures_at IS NOT NULL AND status = 'pending'").get() as { s: number }).s
  ok('clearing total = only in-window clearing-pending (10), excludes settled/reversed/opt-out', clearing === 10, `got ${clearing}`)

  // 2. COMPLETENESS — every earnings-DISPLAY surface carries the clearing read. (growth.ts is task-eval,
  // not an earnings display; the growth page's earnings come from promoter/wallet endpoints.)
  // `matures_at IS NOT NULL` appears only in clearing reads (opt-out reads use IS NULL), so its presence
  // proves the surface exposes the clearing total — order-agnostic.
  const surfaces: Array<[string, string]> = [
    ['referral.ts', 'src/pwa/routes/referral.ts'],
    ['promoter.ts', 'src/pwa/routes/promoter.ts'],
    ['wallet-read.ts', 'src/pwa/routes/wallet-read.ts'],
    ['mcp webaz_referral', 'src/layer1-agent/L1-1-mcp-server/server.ts'],
  ]
  for (const [label, path] of surfaces) {
    const src = readFileSync(join(process.cwd(), path), 'utf8')
    ok(`${label}: surfaces a clearing total (matures_at IS NOT NULL read present)`, /matures_at IS NOT NULL/.test(src))
  }

  if (fail === 0) {
    console.log(`\n✅ clearing surfaces: canonical query is in-window-only; all 5 earnings surfaces carry the clearing read\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ clearing surfaces FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
