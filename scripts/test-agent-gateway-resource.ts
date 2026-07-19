#!/usr/bin/env tsx
/** RFC-028 S1c3: DPoP protected-resource edge + one-use local handoff. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-gateway-resource-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
process.env.WEBAZ_REMOTE_MCP = '1'
process.env.WEBAZ_OAUTH = '1'
process.env.WEBAZ_AGENT_GATEWAY_DPOP_RESOURCE = '1'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { initUserModerationSchema, initAgentGatewaySchema } = await import('../src/runtime/webaz-schema-helpers.js')
const {
  createSqliteGatewayReplayStore,
  dpopJwkThumbprint,
  dpopJwkThumbprintHex,
  verifyAgentGatewayDpopRequest,
} = await import('../src/runtime/agent-gateway-proof.js')
const { verifyGrantIdentity } = await import('../src/runtime/agent-grant-verifier.js')
const {
  consumeAgentGatewayHandoff,
  issueAgentGatewayHandoff,
  runWithAgentGatewayContext,
} = await import('../src/runtime/agent-gateway-handoff.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { registerRemoteMcpRoutes } = await import('../src/pwa/routes/mcp-remote.js')

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => {
  if (condition) pass++
  else { fail++; failures.push(`FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
applyWebazRuntimeSchema(db)
initUserModerationSchema(db)
initAgentGatewaySchema(db)

const humanId = 'usr_gateway_resource'
const grantId = 'grt_gateway_resource'
const clientId = 'oauth_gateway_resource'
const gatewayId = 'agc_gateway_resource'
const profileId = 'agp_gateway_resource'
const token = `oat_${'a'.repeat(64)}`
const nowMs = Date.now()
const future = new Date(nowMs + 60 * 60_000).toISOString()
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>

db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(humanId, 'Gateway Seller', 'seller', 'k_gateway_human')
db.prepare(`INSERT INTO agent_delegation_grants
  (grant_id,human_id,agent_label,capabilities,status,expires_at)
  VALUES (?,?,?,?,'active',?)`).run(grantId, humanId, 'Gateway Agent', '[{"capability":"read_public"},{"capability":"buyer_discover"}]', future)
db.prepare(`INSERT INTO oauth_clients (client_id,name,redirect_uris,status,verified)
  VALUES (?,?,'[]','active',0)`).run(clientId, 'Gateway OAuth Client')
db.prepare(`INSERT INTO oauth_access_tokens
  (token_hash,grant_id,client_id,scope,aud,expires_at,dpop_jkt)
  VALUES (?,?,?,?,?,?,?)`).run(sha(token), grantId, clientId, 'read', 'https://webaz.xyz/mcp', future, dpopJwkThumbprint(publicJwk))
db.prepare(`INSERT INTO agent_gateway_clients
  (gateway_client_id,oauth_client_id,display_name,registry_status,policy_version,reviewed_by,verified_at)
  VALUES (?,?,?,'verified','gw-v1','root',?)`).run(gatewayId, clientId, 'Gateway Client', new Date(nowMs - 60_000).toISOString())
db.prepare(`INSERT INTO agent_gateway_proof_profiles
  (profile_id,gateway_client_id,proof_method,profile_status,proof_config_id,key_thumbprint,verified_at,expires_at)
  VALUES (?,?,'dpop','active','dpop_rfc9449_v1',?,?,?)`)
  .run(profileId, gatewayId, dpopJwkThumbprintHex(publicJwk), new Date(nowMs - 60_000).toISOString(), future)

let proofSeq = 0
function proof(overrides: Record<string, unknown> = {}): string {
  const input = `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk })}.${b64({
    jti: `gateway-resource-jti-${++proofSeq}-${'x'.repeat(16)}`,
    htm: 'POST', htu: 'https://webaz.xyz/mcp', iat: Math.floor(Date.now() / 1000),
    ath: createHash('sha256').update(token, 'ascii').digest('base64url'),
    ...overrides,
  })}`
  const signature = sign('sha256', Buffer.from(input, 'ascii'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${signature.toString('base64url')}`
}

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'human auth disabled in test' }); return null }
const app = express()
app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true } as never)
const replayStore = createSqliteGatewayReplayStore(db, { runtime: 'test' })
let port = 0
registerRemoteMcpRoutes(app, {
  rateLimitOk: () => true,
  gatewayReplayStore: replayStore,
  gatewayLoopbackBaseUrl: () => `http://127.0.0.1:${port}`,
})
const server = app.listen(0)
port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'webaz_connection_status', arguments: {} } }

async function post(authz: string, dpop?: string, rpcBody: unknown = call): Promise<{ status: number; body: Record<string, unknown>; challenge: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: authz,
  }
  if (dpop !== undefined) headers.dpop = dpop
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(rpcBody) })
  return {
    status: response.status,
    body: await response.json().catch(() => ({})) as Record<string, unknown>,
    challenge: response.headers.get('www-authenticate') || '',
  }
}

async function postDuplicateDpop(first: string, second: string): Promise<number> {
  const payload = JSON.stringify(call)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: [
        'Content-Type', 'application/json', 'Accept', 'application/json, text/event-stream',
        'Authorization', `DPoP ${token}`, 'DPoP', first, 'DPoP', second,
        'Content-Length', String(Buffer.byteLength(payload)),
      ],
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)) })
    req.on('error', reject)
    req.end(payload)
  })
}

try {
  const goodProof = proof()
  const success = await post(`DPoP ${token}`, goodProof)
  const allowAudit = db.prepare("SELECT COUNT(*) AS n FROM agent_grant_auth_log WHERE grant_id=? AND capability='read_public' AND outcome='allow'").get(grantId) as { n: number }
  ok('1. valid DPoP request traverses /mcp → tool → local resource route', success.status === 200, JSON.stringify(success.body).slice(0, 180))
  ok('2. downstream exact-scope authorization remains audited', allowAudit.n === 1)

  const discoverCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'webaz_discover', arguments: { query: 'gateway-test', destination_region: 'SG', limit: 1 },
  } }
  const postSuccess = await post(`dpop ${token}`, proof(), discoverCall)
  const discoverAudit = db.prepare("SELECT COUNT(*) AS n FROM agent_grant_auth_log WHERE grant_id=? AND capability='buyer_discover' AND outcome='allow'").get(grantId) as { n: number }
  ok('2a. lowercase DPoP scheme and POST body survive exact local handoff binding', postSuccess.status === 200 && discoverAudit.n === 1)

  const replay = await post(`DPoP ${token}`, goodProof)
  ok('3. identical proof is rejected before a second resource dispatch', replay.status === 409 && /DPoP/.test(replay.challenge))
  const afterReplay = db.prepare("SELECT COUNT(*) AS n FROM agent_grant_auth_log WHERE grant_id=? AND capability='read_public' AND outcome='allow'").get(grantId) as { n: number }
  ok('4. proof replay creates no second allow audit', afterReplay.n === 1)

  const missing = await post(`DPoP ${token}`)
  ok('5. DPoP scheme requires exactly one proof', missing.status === 401 && missing.challenge.includes('invalid_dpop_proof'))
  const duplicateDpopStatus = await postDuplicateDpop(proof(), proof())
  ok('5a. duplicate DPoP proof headers are rejected before verification', [400, 401].includes(duplicateDpopStatus), `status=${duplicateDpopStatus}`)

  const bearer = await post(`Bearer ${token}`)
  const bearerMeta = ((bearer.body.result as { _meta?: Record<string, unknown> } | undefined)?._meta?.['mcp/www_authenticate'])
  ok('6. bound token presented as ordinary Bearer stays rejected', bearer.status === 200 && Array.isArray(bearerMeta))

  const direct = await fetch(`${base}/api/agent-grants/connection`, { headers: { authorization: `Bearer ${token}` } })
  const directBody = await direct.json() as { error_code?: string }
  ok('7. direct resource request cannot use a bound token without trusted handoff', direct.status === 401 && directBody.error_code === 'DPOP_PROOF_REQUIRED')
  const forged = await fetch(`${base}/api/agent-grants/connection`, { headers: {
    authorization: `Bearer ${token}`, 'x-webaz-agent-gateway-handoff': `agh_${'A'.repeat(43)}`,
  } })
  const forgedBody = await forged.json() as { error_code?: string }
  ok('8. caller-forged handoff header has no authority', forged.status === 401 && forgedBody.error_code === 'DPOP_PROOF_REQUIRED')

  const contextResult = await verifyAgentGatewayDpopRequest({
    access_token: token, dpop_proof: proof(), http_method: 'POST', target_uri: 'https://webaz.xyz/mcp',
  }, replayStore)
  if (!contextResult.ok) throw new Error('control context did not verify')
  const context = contextResult.context
  const loopback = `http://127.0.0.1:${port}`
  const issue = async (input: { method?: string; path?: string; body?: string; bearer?: string; now?: number } = {}) => {
    let issued: ReturnType<typeof issueAgentGatewayHandoff> = null
    await runWithAgentGatewayContext(context, loopback, async () => {
      issued = issueAgentGatewayHandoff({
        bearer: input.bearer ?? token,
        method: input.method ?? 'POST',
        path: input.path ?? '/api/agent/test',
        serialized_body: input.body ?? '{"x":1}',
        ...(input.now === undefined ? {} : { now_ms: input.now }),
      })
    })
    return issued
  }
  const consume = (ticket: string | undefined, input: { method?: string; path?: string; body?: string; bearer?: string; loopback?: boolean; now?: number } = {}) =>
    consumeAgentGatewayHandoff({
      ticket, bearer: input.bearer ?? token, method: input.method ?? 'POST',
      path: input.path ?? '/api/agent/test', serialized_body: input.body ?? '{"x":1}',
      is_loopback: input.loopback ?? true, ...(input.now === undefined ? {} : { now_ms: input.now }),
    })

  const oneUse = await issue()
  ok('9. exact one-use ticket returns the branded context', !!oneUse && consume(oneUse.ticket) === context)
  ok('10. consumed ticket cannot be replayed', !!oneUse && consume(oneUse.ticket) === null)
  for (const [name, mismatch] of [
    ['bearer', { bearer: `${token}x` }], ['method', { method: 'GET' }], ['path', { path: '/api/agent/other' }],
    ['body', { body: '{"x":2}' }],
  ] as const) {
    const issued = await issue()
    ok(`11.${name} mismatch burns and rejects the ticket`, !!issued && consume(issued.ticket, mismatch) === null
      && consume(issued.ticket) === null)
  }
  const remoteAttempt = await issue()
  ok('11.non-loopback presentation is rejected without consuming the local ticket', !!remoteAttempt
    && consume(remoteAttempt.ticket, { loopback: false }) === null
    && consume(remoteAttempt.ticket) === context)
  const expiring = await issue({ now: 1_000 })
  ok('12. expired ticket is rejected', !!expiring && consume(expiring.ticket, { now: 16_001 }) === null)
  let inherited: (() => ReturnType<typeof issueAgentGatewayHandoff>) | undefined
  await runWithAgentGatewayContext(context, loopback, async () => {
    inherited = () => issueAgentGatewayHandoff({ bearer: token, method: 'GET', path: '/api/agent/test', serialized_body: '' })
  })
  ok('13. inherited async context cannot issue after the request lease closes', inherited?.() === null)
  let forgedRejected = false
  try { await runWithAgentGatewayContext({ ...context } as never, loopback, async () => undefined) } catch { forgedRejected = true }
  ok('14. structurally cloned context cannot start a trusted lease', forgedRejected)

  const ordinaryIdentity = await verifyGrantIdentity(token)
  ok('15. ordinary verifier remains fail-closed for sender-constrained token', !ordinaryIdentity.ok
    && ordinaryIdentity.error_code === 'DPOP_PROOF_REQUIRED')

  process.env.WEBAZ_AGENT_GATEWAY_DPOP_RESOURCE = '0'
  const disabled = await post(`DPoP ${token}`, proof())
  ok('16. resource feature flag independently defaults the DPoP path closed', disabled.status === 401)
} finally {
  server.close()
  db.close()
  rmSync(tmpHome, { recursive: true, force: true })
}

if (fail) {
  console.error(`agent gateway S1c3 resource: ${pass} pass / ${fail} fail\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`agent gateway S1c3 resource: ${pass} pass`)
