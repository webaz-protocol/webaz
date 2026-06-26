#!/usr/bin/env tsx
/**
 * RFC-020 PR-C1 — webaz_pair pairing + credential delivery (PWA endpoints).
 *   用法:npm run test:agent-pairing
 *
 * Drives the REAL pairing routes (registerAgentGrantsRoutes) on an ephemeral express
 * app with a stub human auth + fresh temp DB. Verifies the security envelope of C1:
 *   · start accepts SAFE scopes; RISK + NEVER_DELEGABLE scopes hard-reject.
 *   · PKCE: retrieve with a wrong verifier → pkce_mismatch.
 *   · one-time: a second retrieve → already_consumed.
 *   · expired pairing cannot be approved or retrieved.
 *   · the raw bearer is returned exactly ONCE (on retrieve) and never appears in the
 *     consent read or the grants list.
 * No payment/order/wallet code is touched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-pairing-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { pkceChallengeS256, generateCodeVerifier, verifyPkceS256 } = await import('../src/runtime/agent-pairing.js')
const { toolAllowedInNetworkMode, NETWORK_TOOLS } = await import('../src/layer1-agent/L1-1-mcp-server/network-mode.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, cond: boolean, d = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
setSeamDb(db)
const app = express()
app.use(express.json())
// stub human auth: any request with x-test-user is "logged in" as that user; else 401.
const auth = (req: express.Request, res: express.Response) => {
  const u = req.header('x-test-user')
  if (!u) { res.status(401).json({ error: 'unauthorized' }); return null }
  return { id: u }
}
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })

// second app with the limiter "exceeded" — to prove pair/start 429s + writes no row
const appLimited = express()
appLimited.use(express.json())
registerAgentGrantsRoutes(appLimited, { db, auth, generateId, rateLimitOk: () => false })
const serverLimited = appLimited.listen(0)
const portLimited = (serverLimited.address() as AddressInfo).port
const countPairings = (): number => (db.prepare('SELECT COUNT(*) n FROM agent_pairing_sessions').get() as { n: number }).n
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`
const j = async (path: string, opts: { method?: string; body?: unknown; user?: string } = {}) => {
  const r = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-test-user': opts.user } : {}) },
    ...(opts.body != null ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as any }
}
const hasTokenField = (o: unknown): boolean => JSON.stringify(o).match(/"token"\s*:|"token_hash"\s*:|gtk_/) != null

try {
  // ── NETWORK-mode gate (P1 regression): webaz_pair must NOT be blocked in network/readonly ──
  ok('webaz_pair allowed through the NETWORK gate', toolAllowedInNetworkMode('webaz_pair') === true)
  ok('webaz_pair is in NETWORK_TOOLS', NETWORK_TOOLS.has('webaz_pair'))
  ok('migrated tool still allowed (webaz_search)', toolAllowedInNetworkMode('webaz_search') === true)
  ok('un-migrated tool still hard-fails the gate', toolAllowedInNetworkMode('webaz_not_a_real_tool') === false)

  // ── pure PKCE ──
  const vv = generateCodeVerifier()
  ok('pkce verify matches', verifyPkceS256(vv, pkceChallengeS256(vv)))
  ok('pkce verify rejects wrong verifier', !verifyPkceS256(vv + 'x', pkceChallengeS256(vv)))

  // ── start: risk + never-delegable hard-reject ──
  const verifier = generateCodeVerifier()
  const challenge = pkceChallengeS256(verifier)
  const riskStart = await j('/api/agent-grants/pair/start', { method: 'POST', body: { code_challenge: challenge, capabilities: [{ capability: 'place_order' }] } })
  ok('start rejects risk scope', riskStart.status === 403 && riskStart.body.rejected?.[0]?.error_code === 'RISK_SCOPE_NOT_ENABLED')
  const neverStart = await j('/api/agent-grants/pair/start', { method: 'POST', body: { code_challenge: challenge, capabilities: [{ capability: 'withdraw' }] } })
  ok('start rejects never-delegable scope', neverStart.status === 403 && neverStart.body.rejected?.[0]?.error_code === 'NEVER_DELEGABLE')
  const noChal = await j('/api/agent-grants/pair/start', { method: 'POST', body: { capabilities: [{ capability: 'search' }] } })
  ok('start requires code_challenge', noChal.status === 400)
  const tooMany = await j('/api/agent-grants/pair/start', { method: 'POST', body: { code_challenge: challenge, capabilities: Array.from({ length: 20 }, () => ({ capability: 'search' })) } })
  ok('start rejects too many capabilities', tooMany.status === 400 && tooMany.body.error === 'too_many_capabilities')

  // rate limit: when the limiter says no, start → 429 and writes NO row
  const before = countPairings()
  const limited = await (async () => {
    const r = await fetch(`http://127.0.0.1:${portLimited}/api/agent-grants/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code_challenge: challenge, capabilities: [{ capability: 'search' }] }) })
    return { status: r.status, body: await r.json().catch(() => ({})) as any }
  })()
  ok('rate-limited start → 429', limited.status === 429 && limited.body.error === 'too_many_pairing_starts')
  ok('rate-limited start writes NO row', countPairings() === before)

  // ── happy path: start (safe) → consent → approve → retrieve ──
  const start = await j('/api/agent-grants/pair/start', { method: 'POST', body: { code_challenge: challenge, capabilities: [{ capability: 'search' }, { capability: 'read_public' }], agent_label: 'TestAgent', reason: 'help me browse' } })
  ok('start (safe) returns pairing_id + user_code', start.status === 201 && !!start.body.pairing_id && !!start.body.user_code)
  ok('start response has NO token', !hasTokenField(start.body))
  const { pairing_id, user_code } = start.body

  const consentNoAuth = await j(`/api/agent-grants/pair/${user_code}`)
  ok('consent read requires human auth', consentNoAuth.status === 401)
  const consent = await j(`/api/agent-grants/pair/${user_code}`, { user: 'usr_alice' })
  ok('consent read returns server-generated consent', consent.status === 200 && Array.isArray(consent.body.consent?.capabilities))
  ok('consent read has NO token', !hasTokenField(consent.body))

  const approveNoAuth = await j(`/api/agent-grants/pair/${user_code}/approve`, { method: 'POST' })
  ok('approve requires human auth', approveNoAuth.status === 401)
  const approve = await j(`/api/agent-grants/pair/${user_code}/approve`, { method: 'POST', user: 'usr_alice' })
  ok('approve issues a grant', approve.status === 200 && !!approve.body.grant_id)
  ok('approve response has NO token', !hasTokenField(approve.body))

  // PKCE mismatch on retrieve
  const badPkce = await j(`/api/agent-grants/pair/${pairing_id}/retrieve`, { method: 'POST', body: { code_verifier: verifier + 'tampered' } })
  ok('retrieve rejects wrong PKCE verifier', badPkce.status === 403 && badPkce.body.error === 'pkce_mismatch')

  // correct retrieve → token once
  const retr = await j(`/api/agent-grants/pair/${pairing_id}/retrieve`, { method: 'POST', body: { code_verifier: verifier } })
  ok('retrieve returns the bearer once', retr.status === 200 && typeof retr.body.token === 'string' && retr.body.token.startsWith('gtk_'))
  ok('retrieve returns grant_id + capabilities', !!retr.body.grant_id && Array.isArray(retr.body.capabilities))

  // reused → consumed
  const retr2 = await j(`/api/agent-grants/pair/${pairing_id}/retrieve`, { method: 'POST', body: { code_verifier: verifier } })
  ok('second retrieve rejected (one-time)', retr2.status === 409 && /consumed/.test(retr2.body.error || ''))

  // raw token never in the grants list (public-ish read)
  const list = await j('/api/agent-grants', { user: 'usr_alice' })
  ok('grants list shows the grant', list.status === 200 && list.body.grants?.length >= 1)
  ok('grants list has NO token / token_hash', !hasTokenField(list.body))

  // ── expired pairing: cannot approve or retrieve ──
  const past = new Date(Date.now() - 1000).toISOString()
  const expPending = generateId('par')
  db.prepare('INSERT INTO agent_pairing_sessions (pairing_id, user_code, code_challenge, capabilities, status, expires_at) VALUES (?,?,?,?,?,?)')
    .run(expPending, 'EXPIREDPEND', challenge, JSON.stringify([{ capability: 'search' }]), 'pending', past)
  const expApprove = await j('/api/agent-grants/pair/EXPIREDPEND/approve', { method: 'POST', user: 'usr_alice' })
  ok('expired pending cannot be approved', expApprove.status === 409)

  const expApproved = generateId('par')
  db.prepare('INSERT INTO agent_pairing_sessions (pairing_id, user_code, code_challenge, capabilities, status, grant_id, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(expApproved, 'EXPIREDAPPR', challenge, JSON.stringify([{ capability: 'search' }]), 'approved', 'grt_x', past)
  const expRetr = await j(`/api/agent-grants/pair/${expApproved}/retrieve`, { method: 'POST', body: { code_verifier: verifier } })
  ok('expired approved cannot be retrieved', expRetr.status === 409)

  if (fail === 0) {
    console.log(`\n✅ agent pairing (PR-C1): safe-only start, risk+never-delegable reject, PKCE-gated one-time retrieval, expired reject, bearer shown once + never in reads\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ agent pairing FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  serverLimited.close()
  rmSync(tmpHome, { recursive: true, force: true })
}
