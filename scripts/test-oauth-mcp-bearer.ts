#!/usr/bin/env tsx
/**
 * RFC-023 PR-4 test — /mcp accepts an OAuth Bearer (introspection → RFC-020 grant principal).
 *
 * Security-critical + adversarial. Drives the REAL verifyGrantToken (not stubbed) against real
 * oauth_access_tokens + agent_delegation_grants rows through the async seam. Confirms an oat_ token
 * resolves ONLY through the tokens table (OAuth grants carry token_hash=NULL), honors aud / expiry /
 * revocation / grant-liveness / scope, and yields the IDENTICAL principal as the equivalent gtk_
 * grant — so an OAuth token can never authorize more than the human approved.
 *
 * Usage: npm run test:oauth-mcp-bearer
 */
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { initOAuthSchema, initAgentDelegationGrantsSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { verifyGrantToken } from '../src/runtime/agent-grant-verifier.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const AUD = 'https://webaz.xyz/mcp'
const NOW = '2026-07-14T00:00:00.000Z'
const future = '2026-07-14T01:00:00.000Z'
const past = '2026-07-13T23:00:00.000Z'

const db = new Database(':memory:')
initOAuthSchema(db); initAgentDelegationGrantsSchema(db)
// Minimal subject tables the verifier's subject-liveness join reads (mirrors auth()'s suspension check).
db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, permanent_code TEXT, region TEXT)')
db.exec('CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER, reason TEXT)')
setSeamDb(db)
db.prepare("INSERT INTO users (id, api_key, permanent_code, region) VALUES ('usr_h','k_h','PC','SG')").run()

let seq = 0
/** Seed a grant (token_hash NULL, like OAuth consent) + an oat_ access token pointing at it. */
function seedOAuth(o: { caps?: string[]; grantStatus?: string; grantExp?: string; tokAud?: string; tokExp?: string; tokRevoked?: string | null; subject?: string } = {}): { oat: string; grantId: string } {
  const grantId = `grt_o${++seq}`
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(grantId, o.subject ?? 'usr_h', 'OAuth: t', JSON.stringify((o.caps ?? ['seller_orders_read_minimal']).map(c => ({ capability: c }))), null, 0, o.grantStatus ?? 'active', o.grantExp ?? future)
  const oat = `oat_${randomBytes(16).toString('hex')}`
  db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?)')
    .run(sha(oat), grantId, 'webaz-dev-client', 'read', o.tokAud ?? AUD, o.tokExp ?? future, o.tokRevoked ?? null)
  return { oat, grantId }
}
/** Seed a classic gtk_ grant (token_hash set) for parity/regression. */
function seedGtk(caps: string[]): { gtk: string; grantId: string } {
  const grantId = `grt_g${++seq}`; const gtk = `gtk_${randomBytes(16).toString('hex')}`
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(grantId, 'usr_h', 'gtk', JSON.stringify(caps.map(c => ({ capability: c }))), sha(gtk), 0, 'active', future)
  return { gtk, grantId }
}

async function main() {
  // ── 1. valid oat_ introspection → principal ──
  {
    const { oat, grantId } = seedOAuth({ caps: ['seller_orders_read_minimal'] })
    const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW)
    ok('1a. valid oat_ → ok principal', r.ok === true)
    if (r.ok) ok('1b. principal is the backing grant + scope', r.principal.grant_id === grantId && r.principal.human_id === 'usr_h' && r.principal.capability === 'seller_orders_read_minimal')
  }
  // ── 2. audience binding (I-3 / RFC 8707) ──
  ok('2a. wrong-aud oat_ → TOKEN_WRONG_AUDIENCE 403', await (async () => { const { oat } = seedOAuth({ tokAud: 'https://webaz.xyz/other' }); const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 403 && r.error_code === 'TOKEN_WRONG_AUDIENCE' })())
  // ── 3. token lifecycle ──
  ok('3a. expired oat_ → TOKEN_EXPIRED 401', await (async () => { const { oat } = seedOAuth({ tokExp: past }); const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 401 && r.error_code === 'TOKEN_EXPIRED' })())
  ok('3b. revoked oat_ → TOKEN_REVOKED 401', await (async () => { const { oat } = seedOAuth({ tokRevoked: past }); const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 401 && r.error_code === 'TOKEN_REVOKED' })())
  ok('3c. unknown oat_ → GRANT_NOT_FOUND 401', await (async () => { const r = await verifyGrantToken('oat_' + 'f'.repeat(32), 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 401 && r.error_code === 'GRANT_NOT_FOUND' })())
  // ── 4. underlying grant liveness (mid-flight revocation honored) ──
  ok('4a. oat_ on revoked grant → GRANT_INACTIVE 403', await (async () => { const { oat } = seedOAuth({ grantStatus: 'revoked' }); const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 403 && r.error_code === 'GRANT_INACTIVE' })())
  ok('4b. oat_ on expired grant → GRANT_INACTIVE 403', await (async () => { const { oat } = seedOAuth({ grantExp: past }); const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 403 && r.error_code === 'GRANT_INACTIVE' })())
  ok('4c. oat_ on suspended subject → GRANT_SUBJECT_INACTIVE 403', await (async () => {
    db.prepare("INSERT INTO users (id, api_key, permanent_code, region) VALUES ('usr_sus','k_s','PC2','SG')").run()
    db.prepare("INSERT INTO user_moderation (user_id, suspended, reason) VALUES ('usr_sus', 1, 'x')").run()
    const { oat } = seedOAuth({ subject: 'usr_sus' }); const r = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW)
    return !r.ok && r.status === 403 && r.error_code === 'GRANT_SUBJECT_INACTIVE'
  })())
  // ── 5. scope confinement (T8 / I-6) ──
  ok('5a. scope beyond grant caps → SCOPE_NOT_GRANTED 403', await (async () => { const { oat } = seedOAuth({ caps: ['seller_orders_read_minimal'] }); const r = await verifyGrantToken(oat, 'seller_product_draft', NOW); return !r.ok && r.status === 403 && r.error_code === 'SCOPE_NOT_GRANTED' })())
  ok('5b. RISK required scope → SCOPE_NOT_SAFE 500 (grants never authorize risk)', await (async () => { const { oat } = seedOAuth({ caps: ['order_accept'] }); const r = await verifyGrantToken(oat, 'order_accept', NOW); return !r.ok && r.status === 500 && r.error_code === 'SCOPE_NOT_SAFE' })())
  // ── 6. token-type parity + confinement ──
  ok('6a. gtk_ still works (regression)', await (async () => { const { gtk } = seedGtk(['seller_orders_read_minimal']); const r = await verifyGrantToken(gtk, 'seller_orders_read_minimal', NOW); return r.ok === true })())
  ok('6b. oat_ & gtk_ on the same capability yield the same shape principal', await (async () => {
    const { oat } = seedOAuth({ caps: ['seller_orders_read_minimal'] }); const { gtk } = seedGtk(['seller_orders_read_minimal'])
    const a = await verifyGrantToken(oat, 'seller_orders_read_minimal', NOW); const b = await verifyGrantToken(gtk, 'seller_orders_read_minimal', NOW)
    return a.ok && b.ok && a.principal.capability === b.principal.capability && a.principal.human_id === b.principal.human_id
  })())
  ok('6c. non-grant bearer (api_key) → GRANT_TOKEN_REQUIRED 401', await (async () => { const r = await verifyGrantToken('k_h', 'seller_orders_read_minimal', NOW); return !r.ok && r.status === 401 && r.error_code === 'GRANT_TOKEN_REQUIRED' })())
  ok('6d. OAuth grant is UNREACHABLE via token_hash (only via oat_ introspection)', await (async () => {
    // The oat_'s grant has token_hash NULL; presenting the oat_ as if it were a gtk_ must miss the grant table.
    const { oat } = seedOAuth({ caps: ['seller_orders_read_minimal'] })
    const asGtk = 'gtk_' + oat.slice(4)   // same secret, wrong prefix → token_hash lookup, which is NULL for OAuth grants
    const r = await verifyGrantToken(asGtk, 'seller_orders_read_minimal', NOW)
    return !r.ok && r.error_code === 'GRANT_NOT_FOUND'
  })())

  // ── 7. source-level wiring guards (the /mcp injection path) ──
  const MCP = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
  const SRV = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  const GR = readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')
  ok('7a. /mcp routes Bearer or DPoP grant credentials to grantBearer, not defaultApiKey', MCP.includes("credential.startsWith('gtk_') || credential.startsWith('oat_')") && MCP.includes('grantBearer: credential'))
  ok('7b. buildMcpServer injects __grant_bearer__ per-request (server-forced)', SRV.includes('opts.grantBearer') && SRV.includes('__grant_bearer__ = opts.grantBearer') && SRV.includes("delete (args as Record<string, unknown>).__grant_bearer__"))
  ok('7c. resolveGrantCredential under isolation returns ONLY the injected bearer', SRV.includes('args?.__grant_bearer__') && SRV.includes('token: injected'))
  ok('7d. requireAgentGrantScope audits oat_ presentations too', GR.includes("bearer.startsWith('gtk_') || bearer.startsWith('oat_')"))

  if (fail > 0) { console.error(`\n❌ oauth /mcp bearer FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth /mcp bearer: oat_ introspection (aud/expiry/revoke) → grant principal · grant-liveness + subject + scope confinement · gtk_/oat_ parity · token_hash-unreachable · injection wiring\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
