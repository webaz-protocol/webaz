#!/usr/bin/env tsx
/** RFC-028 S1b: proof verification, replay consumption, and branded context. */
import Database from 'better-sqlite3'
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import {
  createSqliteGatewayReplayStore,
  dpopJwkThumbprint,
  dpopJwkThumbprintHex,
  isAgentGatewayContext,
  requireAgentGatewayContext,
  verifyAgentGatewayDpopRequest,
  verifyAgentGatewayGrantToken,
} from '../src/runtime/agent-gateway-proof.js'
import {
  initAgentDelegationGrantsSchema,
  initAgentGatewaySchema,
  initUserModerationSchema,
} from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { verifyGrantIdentity } from '../src/runtime/agent-grant-verifier.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => {
  if (condition) pass++
  else { fail++; failures.push(`FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }
const sha256hex = (value: string): string => createHash('sha256').update(value).digest('hex')
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

interface Fixture {
  db: Database.Database
  token: string
  privateKey: KeyObject
  publicJwk: Record<string, unknown>
  nowMs: number
}

function fixture(suffix = '1'): Fixture {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  initUserModerationSchema(db)
  initAgentDelegationGrantsSchema(db)
  initAgentGatewaySchema(db)
  const nowMs = Date.parse('2026-07-20T00:00:00.000Z')
  const humanId = `usr_${suffix}`
  const grantId = `grt_${suffix}`
  const clientId = `oauth_${suffix}`
  const gatewayId = `agc_${suffix}`
  const token = `oat_${suffix.padStart(64, 'a').slice(-64)}`
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const thumbprint = dpopJwkThumbprintHex(publicJwk)!
  const tokenJkt = dpopJwkThumbprint(publicJwk)!
  db.prepare('INSERT INTO users (id) VALUES (?)').run(humanId)
  db.prepare(`INSERT INTO agent_delegation_grants
    (grant_id,human_id,capabilities,status,expires_at) VALUES (?,?,?,'active',?)`)
    .run(grantId, humanId, '[{"capability":"read_public"}]', '2026-07-21T00:00:00.000Z')
  db.prepare(`INSERT INTO oauth_clients
    (client_id,name,redirect_uris,status,verified) VALUES (?,?,'[]','active',0)`)
    .run(clientId, `Client ${suffix}`)
  db.prepare(`INSERT INTO oauth_access_tokens
    (token_hash,grant_id,client_id,scope,aud,expires_at,dpop_jkt) VALUES (?,?,?,?,?,?,?)`)
    .run(sha256hex(token), grantId, clientId, 'read', 'https://webaz.xyz/mcp', '2026-07-20T01:00:00.000Z', tokenJkt)
  db.prepare(`INSERT INTO agent_gateway_clients
    (gateway_client_id,oauth_client_id,display_name,registry_status,policy_version,reviewed_by,verified_at)
    VALUES (?,?,?,'verified','gw-v1','root','2026-07-19T00:00:00.000Z')`)
    .run(gatewayId, clientId, `Gateway ${suffix}`)
  db.prepare(`INSERT INTO agent_gateway_proof_profiles
    (profile_id,gateway_client_id,proof_method,profile_status,proof_config_id,key_thumbprint,verified_at,expires_at)
    VALUES (?,?, 'dpop','active','dpop_rfc9449_v1',?,'2026-07-19T00:00:00.000Z','2026-07-21T00:00:00.000Z')`)
    .run(`agp_${suffix}`, gatewayId, thumbprint)
  return { db, token, privateKey, publicJwk, nowMs }
}

function proof(f: Fixture, overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: f.publicJwk, ...headerOverrides }
  const payload = {
    jti: `jti_${'x'.repeat(20)}_${Math.random().toString(16).slice(2)}`,
    htm: 'POST',
    htu: 'https://webaz.xyz/mcp',
    iat: Math.floor(f.nowMs / 1000),
    ath: createHash('sha256').update(f.token, 'ascii').digest('base64url'),
    ...overrides,
  }
  const input = `${b64(header)}.${b64(payload)}`
  const signature = sign('sha256', Buffer.from(input, 'ascii'), { key: f.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${signature.toString('base64url')}`
}

async function verify(f: Fixture, dpop = proof(f), extras: { expected_nonce?: string } = {}) {
  setSeamDb(f.db)
  return verifyAgentGatewayDpopRequest({
    access_token: f.token,
    dpop_proof: dpop,
    http_method: 'POST',
    target_uri: 'https://webaz.xyz/mcp',
    now_ms: f.nowMs,
    ...extras,
  }, createSqliteGatewayReplayStore(f.db, { runtime: 'test' }))
}

function tamperSignature(jwt: string): string {
  const parts = jwt.split('.')
  const signature = Buffer.from(parts[2], 'base64url')
  signature[0] ^= 1
  return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`
}

{
  const f = fixture('1')
  // SQLite datetime('now') values omit the timezone suffix; those are UTC and
  // must compare as instants, not lexicographically against ISO T...Z strings.
  f.db.prepare("UPDATE oauth_access_tokens SET expires_at='2026-07-20 01:00:00'").run()
  f.db.prepare("UPDATE agent_delegation_grants SET expires_at='2026-07-21 00:00:00'").run()
  f.db.prepare("UPDATE agent_gateway_proof_profiles SET expires_at='2026-07-21 00:00:00'").run()
  const result = await verify(f)
  ok('1. valid pinned DPoP + OAuth grant mints a context', result.ok)
  ok('2. context is module-branded', result.ok && isAgentGatewayContext(result.context))
  ok('3. context is frozen and identifies the server-resolved principal', result.ok
    && Object.isFrozen(result.context) && Object.isFrozen(result.context.oauth_scopes)
    && result.context.gateway_client_id === 'agc_1' && result.context.human_id === 'usr_1')
  ok('4. context contains no bearer/proof/JTI/nonce', result.ok
    && !/oat_|jti_|nonce|dpop_proof|access_token/.test(JSON.stringify(result.context)))
  const forged = { ...(result.ok ? result.context : {}) }
  ok('5. a structurally identical object is not trusted', !isAgentGatewayContext(forged)
    && throws(() => requireAgentGatewayContext(forged)))
  setSeamDb(f.db)
  const bearerBypass = await verifyGrantIdentity(f.token, new Date(f.nowMs).toISOString())
  ok('5b. a DPoP-bound token is rejected by the ordinary Bearer identity path', !bearerBypass.ok
    && bearerBypass.error_code === 'DPOP_PROOF_REQUIRED')
  f.db.close()
}

{
  const f = fixture('2')
  const p = proof(f, { jti: 'same-proof-jti-1234567890' })
  const first = await verify(f, p)
  const second = await verify(f, p)
  ok('6. first proof consumes its replay claim', first.ok)
  ok('7. same proof is rejected on replay', !second.ok && second.error_code === 'GATEWAY_DPOP_REPLAYED')
  const stored = f.db.prepare('SELECT replay_scope_hash,replay_key_hash FROM agent_gateway_replay_claims').get() as Record<string, string>
  ok('8. replay row stores only canonical hashes', /^[0-9a-f]{64}$/.test(stored.replay_scope_hash)
    && /^[0-9a-f]{64}$/.test(stored.replay_key_hash)
    && !JSON.stringify(stored).includes('same-proof-jti'))
  f.db.close()
}

{
  const f = fixture('3')
  const wrongKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const wrongJwk = wrongKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const originalPrivate = f.privateKey
  const originalPublic = f.publicJwk
  f.privateKey = wrongKey.privateKey
  f.publicJwk = wrongJwk
  f.db.prepare('UPDATE oauth_access_tokens SET dpop_jkt=?').run(dpopJwkThumbprint(wrongJwk))
  const unpinned = await verify(f)
  ok('9. a token-bound but unpinned key is rejected by the profile gate', !unpinned.ok
    && unpinned.error_code === 'GATEWAY_PROOF_PROFILE_INACTIVE')
  f.privateKey = originalPrivate
  f.publicJwk = originalPublic
  f.db.prepare('UPDATE oauth_access_tokens SET dpop_jkt=?').run(dpopJwkThumbprint(originalPublic))
  ok('10. restored control proof reaches the success path', (await verify(f)).ok)
  ok('11. signature tampering is rejected', !(await verify(f, tamperSignature(proof(f)))).ok)
  ok('12. alg none is rejected before signature trust', !(await verify(f, proof(f, {}, { alg: 'none' }))).ok)
  ok('13. a private JWK in the JOSE header is rejected', !(await verify(f, proof(f, {}, { jwk: { ...f.publicJwk, d: 'secret' } }))).ok)
  ok('14. wrong HTTP method is rejected', !(await verify(f, proof(f, { htm: 'GET' }))).ok)
  setSeamDb(f.db)
  const lowercaseMethod = await verifyAgentGatewayDpopRequest({
    access_token: f.token, dpop_proof: proof(f), http_method: 'post',
    target_uri: 'https://webaz.xyz/mcp', now_ms: f.nowMs,
  }, createSqliteGatewayReplayStore(f.db, { runtime: 'test' }))
  ok('15. method comparison is exact and case-sensitive', !lowercaseMethod.ok)
  ok('16. wrong target URI is rejected', !(await verify(f, proof(f, { htu: 'https://webaz.xyz/oauth/token' }))).ok)
  ok('17. query-bearing htu is rejected', !(await verify(f, proof(f, { htu: 'https://webaz.xyz/mcp?x=1' }))).ok)
  ok('17a. empty query or fragment delimiters are still rejected',
    !(await verify(f, proof(f, { htu: 'https://webaz.xyz/mcp?' }))).ok
      && !(await verify(f, proof(f, { htu: 'https://webaz.xyz/mcp#' }))).ok)
  ok('17b. RFC 3986 unreserved percent-encoding normalizes before htu comparison',
    (await verify(f, proof(f, { htu: 'https://webaz.xyz/%6Dcp' }))).ok)
  ok('17c. raw backslash and ASCII controls cannot normalize into the target',
    !(await verify(f, proof(f, { htu: 'https://webaz.xyz\\mcp' }))).ok
      && !(await verify(f, proof(f, { htu: 'https://webaz.xyz/\tmcp' }))).ok)
  ok('17d. encoded path separators remain distinct from literal separators',
    !(await verify(f, proof(f, { htu: 'https://webaz.xyz/%2Fmcp' }))).ok)
  ok('18. stale iat is rejected', !(await verify(f, proof(f, { iat: Math.floor(f.nowMs / 1000) - 301 }))).ok)
  ok('19. far-future iat is rejected', !(await verify(f, proof(f, { iat: Math.floor(f.nowMs / 1000) + 61 }))).ok)
  ok('20. wrong access-token hash is rejected', !(await verify(f, proof(f, { ath: 'wrong' }))).ok)
  ok('21. required server nonce is enforced', !(await verify(f, proof(f, { nonce: 'n1' }), { expected_nonce: 'n2' })).ok)
  f.db.close()
}

{
  const f = fixture('4')
  f.db.prepare("UPDATE agent_gateway_clients SET registry_status='unverified' WHERE gateway_client_id='agc_4'").run()
  const r = await verify(f)
  ok('22. OAuth client registration alone grants no Gateway trust', !r.ok && r.error_code === 'GATEWAY_CLIENT_NOT_VERIFIED')
  f.db.prepare("UPDATE agent_gateway_clients SET registry_status='verified' WHERE gateway_client_id='agc_4'").run()
  f.db.prepare("UPDATE agent_gateway_proof_profiles SET profile_status='pending' WHERE profile_id='agp_4'").run()
  const p = await verify(f)
  ok('23. pending proof profile is fail-closed', !p.ok && p.error_code === 'GATEWAY_PROOF_PROFILE_INACTIVE')
  f.db.close()
}

{
  const f = fixture('5')
  f.db.prepare("UPDATE oauth_access_tokens SET aud='https://evil.example/mcp'").run()
  const aud = await verify(f)
  ok('24. wrong OAuth audience is rejected before proof trust', !aud.ok && aud.error_code === 'GATEWAY_TOKEN_WRONG_AUDIENCE')
  f.db.prepare("UPDATE oauth_access_tokens SET aud='https://webaz.xyz/mcp',revoked_at='2026-07-19T00:00:00Z'").run()
  const revoked = await verify(f)
  ok('25. revoked OAuth token is rejected', !revoked.ok && revoked.error_code === 'GATEWAY_ACCESS_TOKEN_INACTIVE')
  f.db.close()
}

{
  const f = fixture('6')
  f.db.prepare("UPDATE agent_delegation_grants SET status='revoked',revoked_at='2026-07-19T00:00:00Z'").run()
  const deadGrant = await verify(f)
  ok('26. dead delegation grant is rejected', !deadGrant.ok && deadGrant.error_code === 'GATEWAY_GRANT_INACTIVE')
  f.db.prepare("UPDATE agent_delegation_grants SET status='active',revoked_at=NULL").run()
  f.db.prepare("INSERT INTO user_moderation (user_id,suspended) VALUES ('usr_6',1)").run()
  const suspended = await verify(f)
  ok('27. suspended subject is rejected', !suspended.ok && suspended.error_code === 'GATEWAY_SUBJECT_INACTIVE')
  f.db.close()
}

{
  const f = fixture('7')
  const prior = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  ok('28. SQLite replay adapter cannot activate in production',
    throws(() => createSqliteGatewayReplayStore(f.db, { runtime: 'test' })))
  if (prior === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prior
  f.db.close()
}

{
  const f = fixture('a')
  f.db.prepare('UPDATE oauth_access_tokens SET dpop_jkt=NULL').run()
  const unbound = await verify(f)
  ok('29. a bearer token without an issuance-time key binding is rejected', !unbound.ok
    && unbound.error_code === 'GATEWAY_TOKEN_NOT_SENDER_CONSTRAINED')
  ok('30. schema rejects a non-canonical SHA-256 base64url tail', throws(() =>
    f.db.prepare('UPDATE oauth_access_tokens SET dpop_jkt=?').run(`${'A'.repeat(42)}B`)))
  f.db.prepare("UPDATE oauth_access_tokens SET dpop_jkt=?").run('A'.repeat(43))
  const wrongBinding = await verify(f)
  ok('31. a token bound to another key is rejected', !wrongBinding.ok
    && wrongBinding.error_code === 'GATEWAY_TOKEN_NOT_SENDER_CONSTRAINED')
  f.db.close()
}

{
  const f = fixture('b')
  f.db.prepare("UPDATE agent_gateway_clients SET revoked_at='2026-07-19T00:00:00Z'").run()
  const revokedClient = await verify(f)
  ok('32. revoked_at vetoes a contradictory verified registry status', !revokedClient.ok
    && revokedClient.error_code === 'GATEWAY_CLIENT_NOT_VERIFIED')
  f.db.prepare("UPDATE agent_gateway_clients SET revoked_at=NULL,suspended_at='2026-07-19T00:00:00Z'").run()
  const suspendedClient = await verify(f)
  ok('33. suspended_at vetoes a contradictory verified registry status', !suspendedClient.ok
    && suspendedClient.error_code === 'GATEWAY_CLIENT_NOT_VERIFIED')
  f.db.close()
}

{
  const a = fixture('8')
  const b = fixture('9')
  const sharedJti = 'same-jti-across-clients-1234'
  const store = createSqliteGatewayReplayStore(a.db, { runtime: 'test' })
  setSeamDb(a.db)
  const aResult = await verifyAgentGatewayDpopRequest({
    access_token: a.token, dpop_proof: proof(a, { jti: sharedJti }), http_method: 'POST',
    target_uri: 'https://webaz.xyz/mcp', now_ms: a.nowMs,
  }, store)
  // Copy B's independent identity into A's shared replay DB to exercise scope separation.
  a.db.prepare('INSERT INTO users (id) VALUES (?)').run('usr_9')
  a.db.prepare(`INSERT INTO agent_delegation_grants
    (grant_id,human_id,capabilities,status,expires_at) VALUES ('grt_9','usr_9','[]','active','2026-07-21T00:00:00Z')`).run()
  const bClient = b.db.prepare("SELECT * FROM oauth_clients WHERE client_id='oauth_9'").get() as Record<string, unknown>
  a.db.prepare('INSERT INTO oauth_clients (client_id,name,redirect_uris,status,verified) VALUES (?,?,?,?,?)')
    .run(bClient.client_id, bClient.name, bClient.redirect_uris, bClient.status, bClient.verified)
  a.db.prepare(`INSERT INTO oauth_access_tokens
    (token_hash,grant_id,client_id,scope,aud,expires_at,dpop_jkt) VALUES (?,?,?,?,?,?,?)`)
    .run(sha256hex(b.token), 'grt_9', 'oauth_9', 'read', 'https://webaz.xyz/mcp',
      '2026-07-20T01:00:00Z', dpopJwkThumbprint(b.publicJwk))
  a.db.prepare(`INSERT INTO agent_gateway_clients
    (gateway_client_id,oauth_client_id,display_name,registry_status,policy_version,reviewed_by,verified_at)
    VALUES ('agc_9','oauth_9','Gateway 9','verified','gw-v1','root','2026-07-19T00:00:00Z')`).run()
  a.db.prepare(`INSERT INTO agent_gateway_proof_profiles
    (profile_id,gateway_client_id,proof_method,profile_status,proof_config_id,key_thumbprint,verified_at,expires_at)
    VALUES ('agp_9','agc_9','dpop','active','dpop_rfc9449_v1',?,'2026-07-19T00:00:00Z','2026-07-21T00:00:00Z')`)
    .run(dpopJwkThumbprintHex(b.publicJwk))
  setSeamDb(a.db)
  const bResult = await verifyAgentGatewayDpopRequest({
    access_token: b.token, dpop_proof: proof(b, { jti: sharedJti }), http_method: 'POST',
    target_uri: 'https://webaz.xyz/mcp', now_ms: b.nowMs,
  }, store)
  ok('34. equal JTI under a different verified client scope does not collide', aResult.ok && bResult.ok)
  a.db.close(); b.db.close()
}

{
  const f = fixture('c')
  setSeamDb(f.db)
  const result = await verifyAgentGatewayDpopRequest({
    access_token: f.token, dpop_proof: proof(f), http_method: 'POST',
    target_uri: 'https://webaz.xyz/mcp', now_ms: f.nowMs,
  }, {
    claim: async () => {
      f.db.prepare("UPDATE agent_gateway_proof_profiles SET profile_status='pending' WHERE profile_id='agp_c'").run()
      return 'claimed'
    },
  })
  ok('34a. profile revocation during the replay-store await prevents context minting', !result.ok
    && result.error_code === 'GATEWAY_PROOF_PROFILE_INACTIVE')
  f.db.close()
}

{
  const f = fixture('d')
  const verified = await verify(f)
  setSeamDb(f.db)
  const scoped = verified.ok
    ? await verifyAgentGatewayGrantToken(verified.context, f.token, 'read_public', new Date(f.nowMs).toISOString())
    : null
  ok('34b. branded context still re-checks the exact SAFE grant capability', !!scoped?.ok
    && scoped.principal.capability === 'read_public')
  const forged = verified.ok ? { ...verified.context } : {}
  const forgedResult = await verifyAgentGatewayGrantToken(forged, f.token, 'read_public', new Date(f.nowMs).toISOString())
  ok('34c. structurally identical context cannot authorize a resource scope', !forgedResult.ok
    && forgedResult.error_code === 'GATEWAY_CONTEXT_REQUIRED')
  f.db.prepare("UPDATE oauth_access_tokens SET revoked_at='2026-07-19T00:00:00Z'").run()
  const revoked = verified.ok
    ? await verifyAgentGatewayGrantToken(verified.context, f.token, 'read_public', new Date(f.nowMs).toISOString())
    : null
  ok('34d. resource scope re-check rejects a token revoked after MCP proof verification', !!revoked && !revoked.ok)
  f.db.close()
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`
    return entry.isDirectory() ? tsFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}
const resourceVerifierRefs = tsFiles('src')
  .filter(path => path !== 'src/runtime/agent-gateway-proof.ts')
  .filter(path => /\bverifyAgentGatewayDpopRequest\b/.test(readFileSync(path, 'utf8')))
const tokenRouteSource = readFileSync('src/pwa/routes/oauth-token.ts', 'utf8')
const mcpRouteSource = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
const replayStoreSource = readFileSync('src/runtime/agent-gateway-replay-pg.ts', 'utf8')
ok('35. S1c3 mounts the resource verifier only at the Remote MCP boundary',
  resourceVerifierRefs.length === 1
    && resourceVerifierRefs[0] === 'src/pwa/routes/mcp-remote.ts'
    && tokenRouteSource.includes('verifyAgentGatewayDpopTokenRequest')
    && !tokenRouteSource.includes('verifyAgentGatewayDpopRequest')
    && !replayStoreSource.includes('verifyAgentGatewayDpopRequest')
    && mcpRouteSource.includes('verifyAgentGatewayDpopRequest'),
  resourceVerifierRefs.join(','))
const boundIdentityRefs = tsFiles('src')
  .filter(path => path !== 'src/runtime/agent-grant-verifier.ts')
  .filter(path => /\bverifyDpopBoundGrantIdentity\b/.test(readFileSync(path, 'utf8')))
ok('35a. proof-less bound-token identity helper is confined to the proof module',
  boundIdentityRefs.length === 1 && boundIdentityRefs[0] === 'src/runtime/agent-gateway-proof.ts',
  boundIdentityRefs.join(','))
const source = readFileSync('src/runtime/agent-gateway-proof.ts', 'utf8')
const verifierInput = source.match(/verifyAgentGatewayDpopRequest\([\s\S]*?input:\s*\{([\s\S]*?)\n\s*\},\n\s*replayStore/)
ok('36. verifier has no request-supplied client identity field', Boolean(verifierInput)
  && !/\b(client_id|gateway_client_id)\s*:/.test(verifierInput![1])
  && !/headers\[['"]x-agent/i.test(source))
const pg = readFileSync('db/schema.pg.sql', 'utf8')
ok('37. PostgreSQL artifact upgrades an existing OAuth token table idempotently',
  /ALTER TABLE oauth_access_tokens ADD COLUMN IF NOT EXISTS dpop_jkt TEXT/.test(pg)
  && pg.indexOf('CREATE TABLE IF NOT EXISTS oauth_access_tokens')
    < pg.indexOf('ALTER TABLE oauth_access_tokens ADD COLUMN IF NOT EXISTS dpop_jkt TEXT'))

if (fail) {
  console.error(`agent gateway S1b proof: ${pass} pass / ${fail} fail\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`agent gateway S1b proof: ${pass} pass`)
