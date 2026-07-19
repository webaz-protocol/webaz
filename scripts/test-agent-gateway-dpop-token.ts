#!/usr/bin/env tsx
/** RFC-028 S1c1: dormant RFC 9449 token issuance + refresh-family binding. */
import express from 'express'
import Database from 'better-sqlite3'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { request as httpRequest, type Server as HttpServer } from 'node:http'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import {
  dpopJwkThumbprint,
  dpopJwkThumbprintHex,
  type GatewayReplayClaim,
  type GatewayReplayStore,
} from '../src/runtime/agent-gateway-proof.js'
import { initAgentDelegationGrantsSchema, initAgentGatewaySchema } from '../src/runtime/webaz-schema-helpers.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')

const db = new Database(':memory:')
initAgentDelegationGrantsSchema(db)
initAgentGatewaySchema(db)
setSeamDb(db)

const CLIENT = 'webaz-dev-client'
const REDIRECT = 'http://localhost:8787/callback'
const RESOURCE = 'https://webaz.xyz/mcp'
const TOKEN_ENDPOINT = 'https://webaz.xyz/oauth/token'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicJwk = key.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
const tokenJkt = dpopJwkThumbprint(publicJwk)!
const keyHex = dpopJwkThumbprintHex(publicJwk)!
const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const otherPublicJwk = otherKey.publicKey.export({ format: 'jwk' }) as Record<string, unknown>

db.prepare("INSERT INTO oauth_clients (client_id,name,redirect_uris,status,verified) VALUES (?,?,?,'active',1)")
  .run(CLIENT, 'DPoP test client', JSON.stringify([REDIRECT]))
db.prepare(`INSERT INTO agent_gateway_clients
  (gateway_client_id,oauth_client_id,display_name,registry_status,policy_version,reviewed_by,verified_at)
  VALUES ('agc_dpop',?,'DPoP test','verified','v1','usr_root',?)`)
  .run(CLIENT, new Date().toISOString())
db.prepare(`INSERT INTO agent_gateway_proof_profiles
  (profile_id,gateway_client_id,proof_method,profile_status,proof_config_id,key_thumbprint,verified_at,expires_at)
  VALUES ('agp_dpop','agc_dpop','dpop','active','dpop_rfc9449_v1',?,?,?)`)
  .run(keyHex, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())

let seq = 0
function seedCode(): { code: string; grantId: string } {
  const grantId = `grt_dpop_${++seq}`
  db.prepare(`INSERT INTO agent_delegation_grants
    (grant_id,human_id,agent_label,capabilities,token_hash,human_confirm_required,status,expires_at)
    VALUES (?,?,'DPoP test',?,NULL,0,'active',?)`)
    .run(grantId, 'usr_1', JSON.stringify([{ capability: 'read_public' }]), new Date(Date.now() + 3_600_000).toISOString())
  const code = `oac_${randomBytes(32).toString('hex')}`
  db.prepare(`INSERT INTO oauth_auth_codes
    (code_hash,client_id,user_id,grant_id,scope,code_challenge,redirect_uri,resource,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sha(code), CLIENT, 'usr_1', grantId, 'read', CHALLENGE, REDIRECT, RESOURCE, new Date(Date.now() + 60_000).toISOString())
  return { code, grantId }
}

function signProof(
  privateKey: typeof key.privateKey,
  jwk: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  const header = b64({ typ: 'dpop+jwt', alg: 'ES256', jwk })
  const payload = b64({
    jti: `jti_${randomBytes(16).toString('hex')}`,
    htm: 'POST',
    htu: TOKEN_ENDPOINT,
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  })
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return `${header}.${payload}.${signature}`
}
const makeProof = (overrides: Record<string, unknown> = {}): string => signProof(key.privateKey, publicJwk, overrides)
const makeOtherProof = (overrides: Record<string, unknown> = {}): string => signProof(otherKey.privateKey, otherPublicJwk, overrides)

class TestReplayStore implements GatewayReplayStore {
  private readonly seen = new Set<string>()
  private releaseHeldClaim?: () => void
  unavailable = false
  coordinateNextReplay = false
  onClaim?: () => void
  async claim(input: GatewayReplayClaim): Promise<'claimed' | 'replayed' | 'unavailable'> {
    this.onClaim?.()
    if (this.unavailable) return 'unavailable'
    const key = `${input.proof_kind}:${input.replay_scope_hash}:${input.replay_key_hash}`
    if (this.seen.has(key)) {
      this.releaseHeldClaim?.()
      this.releaseHeldClaim = undefined
      return 'replayed'
    }
    this.seen.add(key)
    if (this.coordinateNextReplay) {
      this.coordinateNextReplay = false
      await new Promise<void>(resolve => { this.releaseHeldClaim = resolve })
    }
    return 'claimed'
  }
}

const replayStore = new TestReplayStore()
const goodCodeBody = (code: string): Record<string, string> => ({
  grant_type: 'authorization_code', code, code_verifier: VERIFIER,
  redirect_uri: REDIRECT, client_id: CLIENT, resource: RESOURCE,
})
const refreshBody = (refresh: string): Record<string, string> => ({
  grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT,
})

async function start(withStore: boolean): Promise<{ base: string; server: HttpServer }> {
  const { registerOAuthTokenRoutes } = await import('../src/pwa/routes/oauth-token.js')
  const app = express()
  app.use(express.json())
  registerOAuthTokenRoutes(app, { db, rateLimitOk: () => true, ...(withStore ? { gatewayReplayStore: replayStore } : {}) })
  const server = await new Promise<HttpServer>(resolve => { const s = app.listen(0, () => resolve(s)) })
  const addr = server.address()
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, server }
}

async function post(base: string, body: Record<string, string>, dpop?: string): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(dpop ? { DPoP: dpop } : {}) },
    body: new URLSearchParams(body).toString(),
  })
}

async function postDuplicateDpop(base: string, body: Record<string, string>): Promise<{ status: number; body: { error?: string } }> {
  return new Promise((resolve, reject) => {
    const encoded = new URLSearchParams(body).toString()
    const req = httpRequest(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(encoded),
        DPoP: [makeProof(), makeProof()],
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string } }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(encoded)
  })
}

async function main(): Promise<void> {
  process.env.WEBAZ_OAUTH = '1'
  process.env.WEBAZ_OAUTH_DEV_CLIENT = '1'
  delete process.env.WEBAZ_MODE

  // Flag-off and missing-store fail closed without affecting ordinary OAuth.
  delete process.env.WEBAZ_AGENT_GATEWAY_DPOP_TOKEN
  const off = await start(false)
  const offCode = seedCode()
  const offResult = await post(off.base, goodCodeBody(offCode.code), makeProof())
  ok('1. DPoP header is rejected while the independent flag is off', offResult.status === 400
    && ((await offResult.json()) as { error: string }).error === 'invalid_dpop_proof')
  ok('2. flag-off rejection mints no token and does not consume the code',
    !(db.prepare('SELECT 1 FROM oauth_access_tokens WHERE grant_id=?').get(offCode.grantId))
    && (db.prepare('SELECT consumed_at FROM oauth_auth_codes WHERE grant_id=?').get(offCode.grantId) as { consumed_at: string | null }).consumed_at === null)
  off.server.close()

  process.env.WEBAZ_AGENT_GATEWAY_DPOP_TOKEN = '1'
  const { registerOAuthTokenRoutes } = await import('../src/pwa/routes/oauth-token.js')
  ok('3. enabled flag without a replay store refuses route registration', (() => {
    try { registerOAuthTokenRoutes(express(), { db, rateLimitOk: () => true }); return false } catch { return true }
  })())

  const live = await start(true)

  // Ordinary ChatGPT/public-client OAuth remains byte-semantically Bearer/NULL.
  const ordinary = seedCode()
  const ordinaryResult = await post(live.base, goodCodeBody(ordinary.code))
  const ordinaryJson = await ordinaryResult.json() as Record<string, unknown>
  const ordinaryRefresh = String(ordinaryJson.refresh_token)
  const ordinaryRows = db.prepare(`
    SELECT a.dpop_jkt access_jkt,r.dpop_jkt refresh_jkt
      FROM oauth_access_tokens a JOIN oauth_refresh_tokens r ON r.grant_id=a.grant_id
     WHERE a.grant_id=?`).get(ordinary.grantId) as { access_jkt: string | null; refresh_jkt: string | null }
  ok('4. no DPoP header still returns ordinary Bearer', ordinaryResult.status === 200 && ordinaryJson.token_type === 'Bearer')
  ok('5. ordinary access and refresh rows remain unbound NULL', ordinaryRows.access_jkt === null && ordinaryRows.refresh_jkt === null)

  // Valid authorization-code exchange binds both credentials to one key.
  const bound = seedCode()
  const boundResult = await post(live.base, goodCodeBody(bound.code), makeProof())
  const boundJson = await boundResult.json() as Record<string, unknown>
  const boundRefresh = String(boundJson.refresh_token)
  const boundRows = db.prepare(`
    SELECT a.dpop_jkt access_jkt,r.dpop_jkt refresh_jkt
      FROM oauth_access_tokens a JOIN oauth_refresh_tokens r ON r.grant_id=a.grant_id
     WHERE a.grant_id=?`).get(bound.grantId) as { access_jkt: string | null; refresh_jkt: string | null }
  ok('6. valid token-endpoint proof returns token_type=DPoP', boundResult.status === 200 && boundJson.token_type === 'DPoP')
  ok('7. access and refresh are bound to the same RFC 7638 thumbprint', boundRows.access_jkt === tokenJkt && boundRows.refresh_jkt === tokenJkt)

  const withAth = seedCode()
  const athResult = await post(live.base, goodCodeBody(withAth.code), makeProof({ ath: 'not-valid-at-token-endpoint' }))
  ok('8. resource-style ath is rejected at the token endpoint', athResult.status === 400
    && ((await athResult.json()) as { error: string }).error === 'invalid_dpop_proof')
  ok('9. proof failure before mint leaves the authorization code usable',
    (db.prepare('SELECT consumed_at FROM oauth_auth_codes WHERE grant_id=?').get(withAth.grantId) as { consumed_at: string | null }).consumed_at === null)

  const duplicate = seedCode()
  const duplicateResult = await postDuplicateDpop(live.base, goodCodeBody(duplicate.code))
  ok('10. duplicate DPoP headers are rejected before verification', duplicateResult.status === 400 && duplicateResult.body.error === 'invalid_dpop_proof')
  ok('11. duplicate-header rejection mints nothing and leaves the code unconsumed',
    !db.prepare('SELECT 1 FROM oauth_access_tokens WHERE grant_id=?').get(duplicate.grantId)
    && (db.prepare('SELECT consumed_at FROM oauth_auth_codes WHERE grant_id=?').get(duplicate.grantId) as { consumed_at: string | null }).consumed_at === null)

  const replayProof = makeProof({ jti: 'jti_replay_0123456789abcdef' })
  const replayA = seedCode(), replayB = seedCode()
  ok('12. first use of a token proof succeeds', (await post(live.base, goodCodeBody(replayA.code), replayProof)).status === 200)
  const replayResult = await post(live.base, goodCodeBody(replayB.code), replayProof)
  ok('13. same token proof cannot mint for a second grant', replayResult.status === 400
    && ((await replayResult.json()) as { error: string }).error === 'invalid_dpop_proof')
  ok('14. replay rejection creates no credential for the second grant',
    !db.prepare('SELECT 1 FROM oauth_access_tokens WHERE grant_id=?').get(replayB.grantId))

  // Bound refresh requires the same key and preserves the family binding.
  const noProofRefresh = await post(live.base, refreshBody(boundRefresh))
  ok('15. bound refresh without DPoP proof is rejected without rotation', noProofRefresh.status === 400
    && ((await noProofRefresh.json()) as { error: string }).error === 'invalid_dpop_proof'
    && !(db.prepare('SELECT rotated_at FROM oauth_refresh_tokens WHERE token_hash=?').get(sha(boundRefresh)) as { rotated_at: string | null }).rotated_at)
  db.prepare(`INSERT INTO agent_gateway_proof_profiles
    (profile_id,gateway_client_id,proof_method,profile_status,proof_config_id,key_thumbprint,verified_at,expires_at)
    VALUES ('agp_dpop_2','agc_dpop','dpop','active','dpop_rfc9449_v1',?,?,?)`)
    .run(dpopJwkThumbprintHex(otherPublicJwk), new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
  const wrongKeyRefresh = await post(live.base, refreshBody(boundRefresh), makeOtherProof())
  ok('16. another active key for the same client cannot rotate this bound family', wrongKeyRefresh.status === 400
    && ((await wrongKeyRefresh.json()) as { error: string }).error === 'invalid_dpop_proof'
    && !(db.prepare('SELECT rotated_at FROM oauth_refresh_tokens WHERE token_hash=?').get(sha(boundRefresh)) as { rotated_at: string | null }).rotated_at)
  const rotatedResult = await post(live.base, refreshBody(boundRefresh), makeProof())
  const rotatedJson = await rotatedResult.json() as Record<string, unknown>
  const rotatedRefresh = String(rotatedJson.refresh_token)
  const rotatedRow = db.prepare('SELECT dpop_jkt FROM oauth_refresh_tokens WHERE token_hash=?').get(sha(rotatedRefresh)) as { dpop_jkt: string | null }
  ok('17. valid bound refresh rotates and remains token_type=DPoP', rotatedResult.status === 200 && rotatedJson.token_type === 'DPoP')
  ok('18. refresh successor preserves the original key binding', rotatedRow.dpop_jkt === tokenJkt)

  const concurrent = seedCode()
  const concurrentIssue = await post(live.base, goodCodeBody(concurrent.code), makeProof())
  const concurrentJson = await concurrentIssue.json() as Record<string, unknown>
  const concurrentRefresh = String(concurrentJson.refresh_token)
  const concurrentFamily = (db.prepare('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash=?')
    .get(sha(concurrentRefresh)) as { family_id: string }).family_id
  const sameRefreshProof = makeProof({ jti: 'jti_refresh_concurrent_1234567890' })
  replayStore.coordinateNextReplay = true
  const concurrentResults = await Promise.all([
    post(live.base, refreshBody(concurrentRefresh), sameRefreshProof),
    post(live.base, refreshBody(concurrentRefresh), sameRefreshProof),
  ])
  const concurrentBodies = await Promise.all(concurrentResults.map(async result => result.json() as Promise<{ error?: string }>))
  ok('19. replay observed before mint prevents both concurrent refresh attempts', concurrentResults.every(result => result.status === 400)
    && concurrentBodies.some(body => body.error === 'invalid_dpop_proof'))
  ok('20. DPoP replay revokes every refresh token in the compromised family',
    (db.prepare('SELECT COUNT(*) n FROM oauth_refresh_tokens WHERE family_id=? AND revoked_at IS NULL')
      .get(concurrentFamily) as { n: number }).n === 0)
  ok('21. DPoP replay also revokes every access token on the compromised grant',
    (db.prepare('SELECT COUNT(*) n FROM oauth_access_tokens WHERE grant_id=? AND revoked_at IS NULL')
      .get(concurrent.grantId) as { n: number }).n === 0)

  // RFC 9700 rotation also permits one request to complete before later reuse
  // is detected. The response cannot be recalled; detection must revoke every
  // credential it produced so the family is dead after both requests finish.
  const claimantFirst = seedCode()
  const claimantIssue = await post(live.base, goodCodeBody(claimantFirst.code), makeProof())
  const claimantJson = await claimantIssue.json() as Record<string, unknown>
  const claimantRefresh = String(claimantJson.refresh_token)
  const claimantFamily = (db.prepare('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash=?')
    .get(sha(claimantRefresh)) as { family_id: string }).family_id
  const claimantProof = makeProof({ jti: 'jti_refresh_claimant_first_12345' })
  const claimantWinner = await post(live.base, refreshBody(claimantRefresh), claimantProof)
  const claimantReplay = await post(live.base, refreshBody(claimantRefresh), claimantProof)
  ok('22. claimant-first ordering allows at most one refresh response', claimantWinner.status === 200 && claimantReplay.status === 400)
  ok('23. later reuse revokes the winner refresh successor',
    (db.prepare('SELECT COUNT(*) n FROM oauth_refresh_tokens WHERE family_id=? AND revoked_at IS NULL')
      .get(claimantFamily) as { n: number }).n === 0)
  ok('24. later reuse revokes the winner access token',
    (db.prepare('SELECT COUNT(*) n FROM oauth_access_tokens WHERE grant_id=? AND revoked_at IS NULL')
      .get(claimantFirst.grantId) as { n: number }).n === 0)

  const upgradeResult = await post(live.base, refreshBody(ordinaryRefresh), makeProof())
  ok('25. ordinary bearer family cannot be upgraded during refresh', upgradeResult.status === 400
    && ((await upgradeResult.json()) as { error: string }).error === 'invalid_dpop_proof')
  const ordinaryRotate = await post(live.base, refreshBody(ordinaryRefresh))
  const ordinaryRotateJson = await ordinaryRotate.json() as Record<string, unknown>
  ok('26. rejected upgrade leaves ordinary refresh usable as Bearer', ordinaryRotate.status === 200 && ordinaryRotateJson.token_type === 'Bearer')

  // Registry/profile changes are re-checked inside the mint transaction.
  const race = seedCode()
  replayStore.onClaim = () => db.prepare("UPDATE agent_gateway_proof_profiles SET profile_status='pending' WHERE profile_id='agp_dpop'").run()
  const raceResult = await post(live.base, goodCodeBody(race.code), makeProof())
  replayStore.onClaim = undefined
  db.prepare("UPDATE agent_gateway_proof_profiles SET profile_status='active' WHERE profile_id='agp_dpop'").run()
  ok('27. profile revocation between proof check and mint is caught in-transaction', raceResult.status === 400
    && ((await raceResult.json()) as { error: string }).error === 'invalid_dpop_proof'
    && !db.prepare('SELECT 1 FROM oauth_access_tokens WHERE grant_id=?').get(race.grantId)
    && (db.prepare('SELECT consumed_at FROM oauth_auth_codes WHERE grant_id=?').get(race.grantId) as { consumed_at: string | null }).consumed_at !== null)

  const unavailable = seedCode()
  replayStore.unavailable = true
  const unavailableResult = await post(live.base, goodCodeBody(unavailable.code), makeProof())
  replayStore.unavailable = false
  ok('28. unavailable shared replay authority fails closed with 503', unavailableResult.status === 503
    && ((await unavailableResult.json()) as { error: string }).error === 'temporarily_unavailable')
  ok('29. replay-store outage mints nothing and does not consume the code',
    !db.prepare('SELECT 1 FROM oauth_access_tokens WHERE grant_id=?').get(unavailable.grantId)
    && (db.prepare('SELECT consumed_at FROM oauth_auth_codes WHERE grant_id=?').get(unavailable.grantId) as { consumed_at: string | null }).consumed_at === null)

  const refreshOutage = seedCode()
  const refreshOutageIssue = await post(live.base, goodCodeBody(refreshOutage.code), makeProof())
  const refreshOutageJson = await refreshOutageIssue.json() as Record<string, unknown>
  const refreshOutageToken = String(refreshOutageJson.refresh_token)
  replayStore.unavailable = true
  const refreshOutageResult = await post(live.base, refreshBody(refreshOutageToken), makeProof())
  replayStore.unavailable = false
  ok('30. refresh proof also fails closed when replay authority is unavailable', refreshOutageResult.status === 503
    && ((await refreshOutageResult.json()) as { error: string }).error === 'temporarily_unavailable')
  ok('31. refresh replay-store outage leaves the family unrotated and usable later',
    !(db.prepare('SELECT rotated_at FROM oauth_refresh_tokens WHERE token_hash=?')
      .get(sha(refreshOutageToken)) as { rotated_at: string | null }).rotated_at)

  live.server.close()
  db.close()
  delete process.env.WEBAZ_AGENT_GATEWAY_DPOP_TOKEN

  if (fail) {
    console.error(`agent gateway S1c1 DPoP token: ${pass} pass / ${fail} fail\n${failures.join('\n')}`)
    process.exit(1)
  }
  console.log(`agent gateway S1c1 DPoP token: ${pass} pass`)
}

main().catch(error => { console.error(error); process.exit(1) })
