/**
 * RFC-028 S1b/S1c1: dormant Agent/API Gateway proof verifiers.
 *
 * The token-endpoint and protected-resource verifiers are independently
 * default-off and require an injected shared replay authority. Token issuance
 * alone does not enable protected-resource access. When its separate resource
 * flag is active, the resource verifier turns a valid, server-resolved,
 * issuance-time key-bound OAuth access token
 * plus a pinned RFC 9449 DPoP proof into a
 * branded context that cannot be manufactured from request JSON or headers.
 * OAuth scopes and object authorization remain enforced by their existing
 * route guards; this context is an additional client-integrity fact, never a
 * replacement authorization.
 */
import type Database from 'better-sqlite3'
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto'
import { dbOne } from '../layer0-foundation/L0-1-database/db.js'
import { verifyDpopBoundGrantIdentity, type GrantVerifyResult } from './agent-grant-verifier.js'
import { classifyScope, storedUtcInstantIsFuture } from './agent-grant-scopes.js'

const OAUTH_ISSUER = 'https://webaz.xyz'
const OAUTH_MCP_AUDIENCE = 'https://webaz.xyz/mcp'
const ACCESS_TOKEN_RE = /^oat_[0-9a-f]{64}$/
const HASH_RE = /^[0-9a-f]{64}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const DPOP_MAX_BYTES = 8_192
const DPOP_MAX_AGE_SECONDS = 300
const DPOP_FUTURE_SKEW_SECONDS = 60

export type AgentGatewayTrustTier = 'user_authorized_agent'

export interface AgentGatewayContext {
  readonly kind: 'webaz.agent_gateway_context.v1'
  readonly trust_tier: AgentGatewayTrustTier
  readonly gateway_client_id: string
  readonly oauth_client_id: string
  readonly grant_id: string
  readonly human_id: string
  readonly oauth_scopes: readonly string[]
  readonly audience: string
  readonly policy_version: string
  readonly proof: Readonly<{
    method: 'dpop'
    profile_id: string
    key_thumbprint: string
    verified_at: string
  }>
}

export type AgentGatewayFailureCode =
  | 'GATEWAY_ACCESS_TOKEN_REQUIRED'
  | 'GATEWAY_ACCESS_TOKEN_INVALID'
  | 'GATEWAY_ACCESS_TOKEN_INACTIVE'
  | 'GATEWAY_TOKEN_WRONG_AUDIENCE'
  | 'GATEWAY_TOKEN_NOT_SENDER_CONSTRAINED'
  | 'GATEWAY_GRANT_INACTIVE'
  | 'GATEWAY_SUBJECT_INACTIVE'
  | 'GATEWAY_CLIENT_NOT_VERIFIED'
  | 'GATEWAY_PROOF_PROFILE_INACTIVE'
  | 'GATEWAY_DPOP_INVALID'
  | 'GATEWAY_DPOP_REPLAYED'
  | 'GATEWAY_REPLAY_STORE_UNAVAILABLE'

type AgentGatewayFailure = { ok: false; status: number; error_code: AgentGatewayFailureCode; error: string }

export type AgentGatewayVerifyResult =
  | { ok: true; context: AgentGatewayContext }
  | AgentGatewayFailure

export interface GatewayReplayClaim {
  proof_kind: 'dpop'
  replay_scope_hash: string
  replay_key_hash: string
  gateway_client_id: string
  grant_id: string
  now_iso: string
  expires_at: string
}

export interface GatewayReplayStore {
  claim(input: GatewayReplayClaim): Promise<'claimed' | 'replayed' | 'unavailable'>
}

const issuedContexts = new WeakSet<object>()

export function isAgentGatewayContext(value: unknown): value is AgentGatewayContext {
  return typeof value === 'object' && value !== null && issuedContexts.has(value)
}

export function requireAgentGatewayContext(value: unknown): AgentGatewayContext {
  if (!isAgentGatewayContext(value)) throw new Error('trusted Agent Gateway context required')
  return value
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Base64url(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  if (!BASE64URL_RE.test(segment)) return null
  try {
    const raw = Buffer.from(segment, 'base64url')
    if (raw.toString('base64url') !== segment) return null
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function decodeBase64urlExact(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : null
  } catch {
    return null
  }
}

interface DpopPublicJwk extends Record<string, unknown> {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

function parseDpopPublicJwk(value: unknown): DpopPublicJwk | null {
  if (!isRecord(value)) return null
  if (value.kty !== 'EC' || value.crv !== 'P-256') return null
  if (!decodeBase64urlExact(value.x, 32) || !decodeBase64urlExact(value.y, 32)) return null
  for (const privateName of ['d', 'k', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
    if (Object.hasOwn(value, privateName)) return null
  }
  if (value.alg !== undefined && value.alg !== 'ES256') return null
  if (value.use !== undefined && value.use !== 'sig') return null
  if (value.key_ops !== undefined
    && (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== 'verify')) return null
  return value as DpopPublicJwk
}

function canonicalJwkThumbprintInput(value: unknown): string | null {
  const jwk = parseDpopPublicJwk(value)
  if (!jwk) return null
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
}

/** RFC 7638 representation used by RFC 9449's cnf.jkt token binding. */
export function dpopJwkThumbprint(value: unknown): string | null {
  const canonical = canonicalJwkThumbprintInput(value)
  return canonical ? createHash('sha256').update(canonical, 'utf8').digest('base64url') : null
}

/** Internal registry representation retained by the RFC-028 S1a hex schema. */
export function dpopJwkThumbprintHex(value: unknown): string | null {
  const canonical = canonicalJwkThumbprintInput(value)
  return canonical ? sha256Hex(canonical) : null
}

function canonicalTargetUri(raw: string, proofClaim: boolean): string | null {
  try {
    if (/[^\x21-\x7e]|\\/.test(raw)) return null
    if (proofClaim && (raw.includes('?') || raw.includes('#'))) return null
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    const pathname = url.pathname.replace(/%[0-9a-fA-F]{2}/g, encoded => {
      const byte = Number.parseInt(encoded.slice(1), 16)
      const char = String.fromCharCode(byte)
      return /^[A-Za-z0-9\-._~]$/.test(char) ? char : encoded.toUpperCase()
    })
    return `${url.origin}${pathname}`
  } catch {
    return null
  }
}

interface VerifiedDpop {
  jti: string
  iat: number
  key_thumbprint: string
  token_jkt: string
}

function verifyDpopJwtProof(input: {
  proof: string
  mode: 'token_endpoint' | 'resource'
  access_token?: string
  http_method: string
  target_uri: string
  expected_nonce?: string
  now_ms: number
}): VerifiedDpop | null {
  if (!input.proof || Buffer.byteLength(input.proof, 'utf8') > DPOP_MAX_BYTES) return null
  const parts = input.proof.split('.')
  if (parts.length !== 3 || parts.some(p => !p)) return null
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = decodeJsonSegment(encodedHeader)
  const payload = decodeJsonSegment(encodedPayload)
  if (!header || !payload || header.typ !== 'dpop+jwt' || header.alg !== 'ES256') return null
  if (header.crit !== undefined) return null
  const jwk = parseDpopPublicJwk(header.jwk)
  const thumbprint = dpopJwkThumbprintHex(jwk)
  const tokenJkt = dpopJwkThumbprint(jwk)
  if (!jwk || !thumbprint || !tokenJkt) return null

  const signature = decodeBase64urlExact(encodedSignature, 64)
  if (!signature) return null
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    const valid = verifySignature(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    )
    if (!valid) return null
  } catch {
    return null
  }

  if (typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 200
    || /[\u0000-\u001f\u007f]/.test(payload.jti)) return null
  if (!Number.isInteger(payload.iat)) return null
  const iat = payload.iat as number
  const nowSeconds = Math.floor(input.now_ms / 1000)
  if (iat > nowSeconds + DPOP_FUTURE_SKEW_SECONDS || iat < nowSeconds - DPOP_MAX_AGE_SECONDS) return null
  if (payload.htm !== input.http_method) return null
  const actualTarget = canonicalTargetUri(input.target_uri, false)
  const proofTarget = typeof payload.htu === 'string' ? canonicalTargetUri(payload.htu, true) : null
  if (!actualTarget || !proofTarget || actualTarget !== proofTarget) return null
  if (input.mode === 'resource') {
    if (!input.access_token || payload.ath !== sha256Base64url(input.access_token)) return null
  } else if (payload.ath !== undefined) {
    // The token endpoint proof establishes the key before an access token
    // exists. Rejecting ath here prevents a resource proof being replayed as
    // an issuance proof under a different verification path.
    return null
  }
  if (input.expected_nonce !== undefined && payload.nonce !== input.expected_nonce) return null
  return { jti: payload.jti, iat, key_thumbprint: thumbprint, token_jkt: tokenJkt }
}

export function verifyDpopTokenEndpointProof(input: {
  proof: string
  http_method: string
  target_uri: string
  expected_nonce?: string
  now_ms?: number
}): VerifiedDpop | null {
  return verifyDpopJwtProof({ ...input, mode: 'token_endpoint', now_ms: input.now_ms ?? Date.now() })
}

function verifyDpopResourceProof(input: {
  proof: string
  access_token: string
  http_method: string
  target_uri: string
  expected_nonce?: string
  now_ms: number
}): VerifiedDpop | null {
  return verifyDpopJwtProof({ ...input, mode: 'resource' })
}

/**
 * SQLite replay persistence is test/dev-only. Production activation requires a
 * shared, atomic store across every application replica; callers cannot opt in
 * with a vague boolean that might accidentally ship.
 */
export function createSqliteGatewayReplayStore(
  db: Database.Database,
  options: { runtime: 'test' | 'single_instance_dev' },
): GatewayReplayStore {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SQLite Agent Gateway replay store is forbidden in production')
  }
  if (options.runtime !== 'test' && options.runtime !== 'single_instance_dev') {
    throw new Error('explicit test or single_instance_dev replay mode required')
  }
  return {
    async claim(replayInput): Promise<'claimed' | 'replayed' | 'unavailable'> {
      if (!HASH_RE.test(replayInput.replay_scope_hash) || !HASH_RE.test(replayInput.replay_key_hash)) return 'unavailable'
      try {
        return db.transaction(() => {
          db.prepare('DELETE FROM agent_gateway_replay_claims WHERE datetime(expires_at) <= datetime(?)')
            .run(replayInput.now_iso)
          const inserted = db.prepare(`
            INSERT OR IGNORE INTO agent_gateway_replay_claims
              (proof_kind,replay_scope_hash,replay_key_hash,gateway_client_id,grant_id,first_seen_at,expires_at)
            VALUES (?,?,?,?,?,?,?)
          `).run(
            replayInput.proof_kind,
            replayInput.replay_scope_hash,
            replayInput.replay_key_hash,
            replayInput.gateway_client_id,
            replayInput.grant_id,
            replayInput.now_iso,
            replayInput.expires_at,
          )
          return inserted.changes === 1 ? 'claimed' : 'replayed'
        }).immediate()
      } catch {
        return 'unavailable'
      }
    },
  }
}

interface GatewayClientRow {
  gateway_client_id: string
  oauth_client_id: string
  registry_status: string
  policy_version: string
  verified_at: string | null
  suspended_at: string | null
  revoked_at: string | null
  oauth_client_status: string
}

interface ProofProfileRow {
  profile_id: string
  proof_config_id: string
  key_thumbprint: string | null
  verified_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

function fail(status: number, error_code: AgentGatewayFailureCode, error: string): AgentGatewayFailure {
  return { ok: false, status, error_code, error }
}

export interface AgentGatewayDpopTokenBinding {
  readonly gateway_client_id: string
  readonly oauth_client_id: string
  readonly profile_id: string
  readonly key_thumbprint: string
  readonly dpop_jkt: string
}

export type AgentGatewayDpopTokenVerifyResult =
  | { ok: true; binding: AgentGatewayDpopTokenBinding }
  | (AgentGatewayFailure & { binding?: AgentGatewayDpopTokenBinding })

/**
 * Validate an RFC 9449 proof at the token endpoint. This is a dormant,
 * dependency-injected seam: it creates no token and grants no scope. The
 * caller must re-check the returned registry/profile binding inside the
 * synchronous mint transaction before persisting dpop_jkt.
 */
export async function verifyAgentGatewayDpopTokenRequest(
  input: {
    oauth_client_id: string
    grant_id: string
    dpop_proof: string
    http_method: string
    target_uri: string
    expected_nonce?: string
    now_ms?: number
  },
  replayStore: GatewayReplayStore,
): Promise<AgentGatewayDpopTokenVerifyResult> {
  const nowMs = input.now_ms ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const verifiedProof = verifyDpopTokenEndpointProof({
    proof: input.dpop_proof,
    http_method: input.http_method,
    target_uri: input.target_uri,
    expected_nonce: input.expected_nonce,
    now_ms: nowMs,
  })
  if (!verifiedProof) return fail(401, 'GATEWAY_DPOP_INVALID', 'DPoP token-endpoint proof is invalid')

  const client = await dbOne<GatewayClientRow>(`
    SELECT g.gateway_client_id,g.oauth_client_id,g.registry_status,g.policy_version,g.verified_at,
           g.suspended_at,g.revoked_at,o.status AS oauth_client_status
      FROM agent_gateway_clients g JOIN oauth_clients o ON o.client_id=g.oauth_client_id
     WHERE g.oauth_client_id=?
  `, [input.oauth_client_id])
  if (!client || client.registry_status !== 'verified' || !client.verified_at
    || client.suspended_at || client.revoked_at || client.oauth_client_status !== 'active') {
    return fail(403, 'GATEWAY_CLIENT_NOT_VERIFIED', 'OAuth client has no verified Gateway identity')
  }

  const profile = await dbOne<ProofProfileRow>(`
    SELECT profile_id,proof_config_id,key_thumbprint,verified_at,expires_at,revoked_at
      FROM agent_gateway_proof_profiles
     WHERE gateway_client_id=? AND proof_method='dpop' AND profile_status='active' AND key_thumbprint=?
  `, [client.gateway_client_id, verifiedProof.key_thumbprint])
  if (!profile || profile.proof_config_id !== 'dpop_rfc9449_v1' || !profile.verified_at
    || profile.revoked_at || (profile.expires_at !== null && !storedUtcInstantIsFuture(profile.expires_at, nowIso))) {
    return fail(403, 'GATEWAY_PROOF_PROFILE_INACTIVE', 'no active pinned DPoP profile matches this proof')
  }

  const target = canonicalTargetUri(input.target_uri, false)
  if (!target) return fail(401, 'GATEWAY_DPOP_INVALID', 'DPoP token-endpoint target is invalid')
  const replayScopeHash = sha256Hex([
    'dpop-token-endpoint', OAUTH_ISSUER, target, client.gateway_client_id, input.oauth_client_id,
    verifiedProof.key_thumbprint,
  ].join('\u0000'))
  const binding = Object.freeze({
    gateway_client_id: client.gateway_client_id,
    oauth_client_id: input.oauth_client_id,
    profile_id: profile.profile_id,
    key_thumbprint: verifiedProof.key_thumbprint,
    dpop_jkt: verifiedProof.token_jkt,
  })
  const replay = await replayStore.claim({
    proof_kind: 'dpop',
    replay_scope_hash: replayScopeHash,
    replay_key_hash: sha256Hex(verifiedProof.jti),
    gateway_client_id: client.gateway_client_id,
    grant_id: input.grant_id,
    now_iso: nowIso,
    expires_at: new Date((verifiedProof.iat + DPOP_MAX_AGE_SECONDS + DPOP_FUTURE_SKEW_SECONDS) * 1000).toISOString(),
  })
  if (replay === 'replayed') {
    return { ...fail(409, 'GATEWAY_DPOP_REPLAYED', 'DPoP proof was already used'), binding }
  }
  if (replay !== 'claimed') return fail(503, 'GATEWAY_REPLAY_STORE_UNAVAILABLE', 'replay protection is unavailable')

  return {
    ok: true,
    binding,
  }
}

/** Re-check the trust facts atomically with access/refresh token persistence. */
export function agentGatewayDpopBindingIsActive(
  db: Database.Database,
  binding: AgentGatewayDpopTokenBinding,
  nowIso: string,
): boolean {
  const row = db.prepare(`
    SELECT p.expires_at
      FROM agent_gateway_clients g
      JOIN oauth_clients o ON o.client_id=g.oauth_client_id
      JOIN agent_gateway_proof_profiles p ON p.gateway_client_id=g.gateway_client_id
     WHERE g.gateway_client_id=? AND g.oauth_client_id=? AND g.registry_status='verified'
       AND g.verified_at IS NOT NULL AND g.suspended_at IS NULL AND g.revoked_at IS NULL
       AND o.status='active' AND p.profile_id=? AND p.proof_method='dpop'
       AND p.profile_status='active' AND p.proof_config_id='dpop_rfc9449_v1'
       AND p.key_thumbprint=? AND p.verified_at IS NOT NULL AND p.revoked_at IS NULL
  `).get(binding.gateway_client_id, binding.oauth_client_id, binding.profile_id, binding.key_thumbprint) as
    { expires_at: string | null } | undefined
  return !!row && (row.expires_at === null || storedUtcInstantIsFuture(row.expires_at, nowIso))
}

export async function verifyAgentGatewayDpopRequest(
  input: {
    access_token: string
    dpop_proof: string
    http_method: string
    target_uri: string
    expected_nonce?: string
    now_ms?: number
  },
  replayStore: GatewayReplayStore,
): Promise<AgentGatewayVerifyResult> {
  if (!ACCESS_TOKEN_RE.test(input.access_token)) {
    return fail(401, 'GATEWAY_ACCESS_TOKEN_REQUIRED', 'a well-formed OAuth access token is required')
  }
  const nowMs = input.now_ms ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const identity = await verifyDpopBoundGrantIdentity(input.access_token, nowIso)
  if (!identity.ok) {
    if (identity.error_code === 'TOKEN_WRONG_AUDIENCE') {
      return fail(403, 'GATEWAY_TOKEN_WRONG_AUDIENCE', 'OAuth access token has the wrong audience')
    }
    if (identity.error_code === 'GRANT_INACTIVE') {
      return fail(403, 'GATEWAY_GRANT_INACTIVE', 'delegation grant is inactive')
    }
    if (identity.error_code === 'GRANT_SUBJECT_INACTIVE') {
      return fail(403, 'GATEWAY_SUBJECT_INACTIVE', 'delegation subject is inactive')
    }
    if (identity.error_code === 'TOKEN_REVOKED' || identity.error_code === 'TOKEN_EXPIRED') {
      return fail(401, 'GATEWAY_ACCESS_TOKEN_INACTIVE', 'OAuth access token or client is inactive')
    }
    return fail(401, 'GATEWAY_ACCESS_TOKEN_INVALID', 'OAuth access token is not recognized')
  }
  const oauth = identity.oauth
  if (!oauth || oauth.audience !== OAUTH_MCP_AUDIENCE) {
    return fail(403, 'GATEWAY_TOKEN_WRONG_AUDIENCE', 'OAuth access token has the wrong audience')
  }
  const client = await dbOne<GatewayClientRow>(`
    SELECT g.gateway_client_id,g.oauth_client_id,g.registry_status,g.policy_version,g.verified_at,
           g.suspended_at,g.revoked_at,o.status AS oauth_client_status
      FROM agent_gateway_clients g JOIN oauth_clients o ON o.client_id=g.oauth_client_id
     WHERE g.oauth_client_id=?
  `, [oauth.client_id])
  if (!client || client.registry_status !== 'verified' || !client.verified_at
    || client.suspended_at || client.revoked_at || client.oauth_client_status !== 'active') {
    return fail(403, 'GATEWAY_CLIENT_NOT_VERIFIED', 'OAuth client has no verified Gateway identity')
  }

  const verifiedProof = verifyDpopResourceProof({
    proof: input.dpop_proof,
    access_token: input.access_token,
    http_method: input.http_method,
    target_uri: input.target_uri,
    expected_nonce: input.expected_nonce,
    now_ms: nowMs,
  })
  if (!verifiedProof) return fail(401, 'GATEWAY_DPOP_INVALID', 'DPoP proof is invalid')
  if (!oauth.dpop_jkt || oauth.dpop_jkt !== verifiedProof.token_jkt) {
    return fail(401, 'GATEWAY_TOKEN_NOT_SENDER_CONSTRAINED', 'OAuth access token is not bound to this DPoP key')
  }

  const profile = await dbOne<ProofProfileRow>(`
    SELECT profile_id,proof_config_id,key_thumbprint,verified_at,expires_at,revoked_at
      FROM agent_gateway_proof_profiles
     WHERE gateway_client_id=? AND proof_method='dpop' AND profile_status='active' AND key_thumbprint=?
  `, [client.gateway_client_id, verifiedProof.key_thumbprint])
  if (!profile || profile.proof_config_id !== 'dpop_rfc9449_v1' || !profile.verified_at
    || profile.revoked_at || (profile.expires_at !== null && !storedUtcInstantIsFuture(profile.expires_at, nowIso))) {
    return fail(403, 'GATEWAY_PROOF_PROFILE_INACTIVE', 'no active pinned DPoP profile matches this proof')
  }

  const replayScopeHash = sha256Hex([
    'dpop', OAUTH_ISSUER, oauth.audience, client.gateway_client_id, oauth.client_id, verifiedProof.key_thumbprint,
  ].join('\u0000'))
  const replayKeyHash = sha256Hex(verifiedProof.jti)
  const replay = await replayStore.claim({
    proof_kind: 'dpop',
    replay_scope_hash: replayScopeHash,
    replay_key_hash: replayKeyHash,
    gateway_client_id: client.gateway_client_id,
    grant_id: identity.row.grant_id,
    now_iso: nowIso,
    expires_at: new Date((verifiedProof.iat + DPOP_MAX_AGE_SECONDS + DPOP_FUTURE_SKEW_SECONDS) * 1000).toISOString(),
  })
  if (replay === 'replayed') return fail(409, 'GATEWAY_DPOP_REPLAYED', 'DPoP proof was already used')
  if (replay !== 'claimed') return fail(503, 'GATEWAY_REPLAY_STORE_UNAVAILABLE', 'replay protection is unavailable')

  // The shared replay claim is an awaited external operation. Re-read every
  // revocable trust fact after it returns so token/grant/subject/client/profile
  // revocation in that window cannot mint a stale context.
  const finalIdentity = await verifyDpopBoundGrantIdentity(input.access_token, nowIso)
  if (!finalIdentity.ok || !finalIdentity.oauth
    || finalIdentity.row.grant_id !== identity.row.grant_id
    || finalIdentity.row.human_id !== identity.row.human_id
    || finalIdentity.oauth.client_id !== oauth.client_id
    || finalIdentity.oauth.audience !== oauth.audience
    || finalIdentity.oauth.dpop_jkt !== oauth.dpop_jkt) {
    return fail(401, 'GATEWAY_ACCESS_TOKEN_INACTIVE', 'OAuth access token, grant, or subject changed during proof verification')
  }
  const finalTrust = await dbOne<{ active: number }>(`
    SELECT 1 AS active
      FROM agent_gateway_clients g
      JOIN oauth_clients o ON o.client_id=g.oauth_client_id
      JOIN agent_gateway_proof_profiles p ON p.gateway_client_id=g.gateway_client_id
     WHERE g.gateway_client_id=? AND g.oauth_client_id=? AND g.registry_status='verified'
       AND g.verified_at IS NOT NULL AND g.suspended_at IS NULL AND g.revoked_at IS NULL
       AND o.status='active' AND p.profile_id=? AND p.proof_method='dpop'
       AND p.profile_status='active' AND p.proof_config_id='dpop_rfc9449_v1'
       AND p.key_thumbprint=? AND p.verified_at IS NOT NULL AND p.revoked_at IS NULL
       AND (p.expires_at IS NULL OR datetime(p.expires_at) > datetime(?))
  `, [client.gateway_client_id, oauth.client_id, profile.profile_id, verifiedProof.key_thumbprint, nowIso])
  if (!finalTrust) return fail(403, 'GATEWAY_PROOF_PROFILE_INACTIVE', 'Gateway client or proof profile changed during proof verification')

  const proof = Object.freeze({
    method: 'dpop' as const,
    profile_id: profile.profile_id,
    key_thumbprint: verifiedProof.key_thumbprint,
    verified_at: nowIso,
  })
  const context = Object.freeze({
    kind: 'webaz.agent_gateway_context.v1' as const,
    trust_tier: 'user_authorized_agent' as const,
    gateway_client_id: client.gateway_client_id,
    oauth_client_id: oauth.client_id,
    grant_id: identity.row.grant_id,
    human_id: identity.row.human_id,
    oauth_scopes: Object.freeze(finalIdentity.oauth.scope.split(/\s+/).filter(Boolean)),
    audience: finalIdentity.oauth.audience,
    policy_version: client.policy_version,
    proof,
  })
  issuedContexts.add(context)
  return { ok: true, context }
}

/**
 * Resource-side grant check for a server-issued Gateway context. This is the
 * only path that may consume a sender-constrained oat_ after its DPoP proof was
 * verified at /mcp. It re-checks token/grant/subject, client/profile lifecycle
 * and the exact SAFE capability; the branded context never replaces them.
 */
export async function verifyAgentGatewayGrantToken(
  value: unknown,
  bearer: string | undefined,
  requiredScope: string,
  nowIso: string = new Date().toISOString(),
): Promise<GrantVerifyResult> {
  let context: AgentGatewayContext
  try { context = requireAgentGatewayContext(value) } catch {
    return { ok: false, status: 401, error_code: 'GATEWAY_CONTEXT_REQUIRED', error: 'trusted Agent Gateway context required' }
  }
  if (classifyScope(requiredScope) !== 'safe') {
    return { ok: false, status: 500, error_code: 'SCOPE_NOT_SAFE', error: `requiredScope "${requiredScope}" is not a safe scope; grants can only ever authorize safe scopes` }
  }
  const identity = await verifyDpopBoundGrantIdentity(bearer, nowIso)
  if (!identity.ok) return identity
  const oauth = identity.oauth
  const tokenScopes = oauth?.scope.split(/\s+/).filter(Boolean).sort() ?? []
  const contextScopes = [...context.oauth_scopes].sort()
  if (!oauth || !oauth.dpop_jkt || oauth.client_id !== context.oauth_client_id
    || oauth.audience !== context.audience || identity.row.grant_id !== context.grant_id
    || identity.row.human_id !== context.human_id
    || JSON.stringify(tokenScopes) !== JSON.stringify(contextScopes)) {
    return { ok: false, status: 401, error_code: 'GATEWAY_CONTEXT_MISMATCH', error: 'Gateway context does not match this OAuth token and grant' }
  }

  const active = await dbOne<{ active: number }>(`
    SELECT 1 AS active
      FROM agent_gateway_clients g
      JOIN oauth_clients o ON o.client_id=g.oauth_client_id
      JOIN agent_gateway_proof_profiles p ON p.gateway_client_id=g.gateway_client_id
     WHERE g.gateway_client_id=? AND g.oauth_client_id=? AND g.registry_status='verified'
       AND g.verified_at IS NOT NULL AND g.suspended_at IS NULL AND g.revoked_at IS NULL
       AND o.status='active' AND p.profile_id=? AND p.proof_method='dpop'
       AND p.profile_status='active' AND p.proof_config_id='dpop_rfc9449_v1'
       AND p.key_thumbprint=? AND p.verified_at IS NOT NULL AND p.revoked_at IS NULL
       AND (p.expires_at IS NULL OR datetime(p.expires_at) > datetime(?))
  `, [context.gateway_client_id, context.oauth_client_id, context.proof.profile_id,
    context.proof.key_thumbprint, nowIso])
  if (!active) {
    return { ok: false, status: 403, error_code: 'GATEWAY_PROOF_PROFILE_INACTIVE', error: 'Gateway client or proof profile is no longer active' }
  }

  let capabilities: Array<{ capability?: string }> = []
  try {
    const parsed: unknown = JSON.parse(String(identity.row.capabilities))
    if (Array.isArray(parsed)) capabilities = parsed as Array<{ capability?: string }>
  } catch { capabilities = [] }
  const holds = capabilities.some(c => c?.capability === requiredScope
    && classifyScope(String(c.capability)) === 'safe')
  if (!holds) {
    return { ok: false, status: 403, error_code: 'SCOPE_NOT_GRANTED', error: `grant does not carry the required safe scope "${requiredScope}"`, grant_id: identity.row.grant_id, human_id: identity.row.human_id }
  }
  return {
    ok: true,
    principal: {
      grant_id: identity.row.grant_id,
      human_id: identity.row.human_id,
      agent_label: identity.row.agent_label,
      capability: requiredScope,
    },
  }
}
