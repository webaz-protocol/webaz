#!/usr/bin/env tsx
/**
 * Leaderboard anonymous-projection contract (security: /api/leaderboard is NO-AUTH public).
 *   用法:npm run test:leaderboard-anon-projection
 *
 * Kills the class "internal field silently rides to a public surface": every board's anon items
 * may contain ONLY allowlisted keys. Specifically asserts the verified leaks are gone — no
 * canonical usr_id (the #1043 enumeration seed key), no keys_count (account structure), no raw
 * calls_30d (behavior fingerprint; replaced by a coarse `activity` bucket) — and that admin
 * accounts are excluded from the public agents board. No money/state path touched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-lb-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { registerLeaderboardRoutes, BOARD_ALLOWLIST } = await import('../src/pwa/routes/leaderboard.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
setSeamDb(db)
applyWebazRuntimeSchema(db)   // ensure agent_reputation / agent_call_log / verifier_stats etc. exist

const app = express()
registerLeaderboardRoutes(app, { db, internalAuditorId: 'usr_iaudit_001', rateLimitOk: () => true })
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
// robust: product boards reference inline product columns (completion_count/value_badge) not
// present in this minimal test DB → their SQL 500s. Return {status, body|null} and skip those in
// the live loop; their allowlist is still asserted statically below.
const get = async (kind: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/api/leaderboard?kind=${kind}`)
  const txt = await r.text()
  let body: any = null; try { body = JSON.parse(txt) } catch { /* HTML error page */ }
  return { status: r.status, body }
}

// seed: a normal agent (with keys_count + calls_30d sources), an ADMIN agent, and a seller
const mkUser = (role: string, handle: string): string => {
  const id = generateId('usr')
  db.prepare('INSERT INTO users (id, name, role, api_key, handle, region) VALUES (?,?,?,?,?,?)').run(id, handle, role, 'key_' + id, handle, 'singapore')
  return id
}
try {
  const agent = mkUser('buyer', 'busy_agent')
  db.prepare('INSERT INTO agent_reputation (api_key, user_id, trust_score, level) VALUES (?,?,?,?)').run('key_' + agent + '_a', agent, 88, 'gold')
  db.prepare('INSERT INTO agent_reputation (api_key, user_id, trust_score, level) VALUES (?,?,?,?)').run('key_' + agent + '_b', agent, 70, 'silver') // 2 keys → keys_count would be 2
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO agent_call_log (api_key, user_id, endpoint, method, status_code) VALUES (?,?,?,?,?)").run('key_' + agent + '_a', agent, '/x', 'GET', 200)
  const adminAgent = mkUser('admin', 'admin_agent')
  db.prepare('INSERT INTO agent_reputation (api_key, user_id, trust_score, level) VALUES (?,?,?,?)').run('key_' + adminAgent, adminAgent, 99, 'gold')

  // ── agents board (verified-leak board; must run on base+helper tables) ──
  const agRes = await get('agents')
  ok('agents board returns 200 JSON', agRes.status === 200 && !!agRes.body, `status=${agRes.status}`)
  const ag = agRes.body || { items: [] }
  ok('agents board returns items', Array.isArray(ag.items) && ag.items.length >= 1)
  ok('agents item keys ⊆ allowlist (no extra)', ag.items.every((it: any) => Object.keys(it).every(k => BOARD_ALLOWLIST.agents.includes(k))),
     'got: ' + JSON.stringify(ag.items[0] || {}))
  ok('agents: NO usr id leaked', ag.items.every((it: any) => !('id' in it) && !('user_id' in it)))
  ok('agents: NO keys_count leaked', ag.items.every((it: any) => !('keys_count' in it)))
  ok('agents: NO raw calls_30d leaked', ag.items.every((it: any) => !('calls_30d' in it)))
  ok('agents: coarse activity bucket present', ag.items.every((it: any) => ['active', 'quiet', 'dormant'].includes(it.activity)))
  ok('agents: busy_agent shows handle + trust_score', ag.items.some((it: any) => it.handle === 'busy_agent' && it.trust_score === 88))
  ok('agents: ADMIN account excluded from public board', !ag.items.some((it: any) => it.handle === 'admin_agent'))
  ok('agents: no api_key/email anywhere', !JSON.stringify(ag).match(/api_key|"email"|key_usr_/))

  // ── static allowlist contract for ALL kinds (the class-killer: a new SELECT column can't ride out) ──
  // (Live-querying every board needs inline product columns absent in the minimal test DB and would
  // crash on an uncaught SQL error; the agents live-check above proves projectBoard actually applies.)
  // usr_id dropped from the boards that don't need it for nav (seller links via handle)
  for (const kind of ['buyers', 'sellers', 'agents', 'arbitrators', 'verifiers']) {
    ok(`${kind}: canonical user id dropped (no enumeration seed)`, !BOARD_ALLOWLIST[kind].includes('id'))
  }
  // creators KEEPS id by design (card navs #u/${id}; #u/ handle-routing = deferred follow-up)
  ok("creators keeps id (deferred: needs #u/ handle-routing)", BOARD_ALLOWLIST.creators.includes('id'))
  // product boards legitimately keep a public product id
  ok("products keeps public product 'id'", BOARD_ALLOWLIST.products.includes('id') && BOARD_ALLOWLIST.value_products.includes('id'))

  if (fail === 0) {
    console.log(`\n✅ leaderboard anon projection: allowlist-only public fields; no usr_id/keys_count/raw-calls leak; admin excluded; coarse activity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ leaderboard anon projection FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  rmSync(tmpHome, { recursive: true, force: true })
}
