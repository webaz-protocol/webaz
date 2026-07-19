/**
 * RFC-020 PR-C2a — delegation grant verifier (server-side consumption foundation).
 *
 * This is the ONLY sanctioned path that turns a `gtk_*` bearer into an authorization,
 * and it is **opt-in per route + per required SAFE scope** — it is NOT global auth.
 * A grant token is never equivalent to a human session or a permanent api_key:
 *   - global auth()/api_key resolution is untouched and never accepts gtk_* tokens;
 *   - this verifier returns a NARROW principal (grant_id, human_id, agent_label,
 *     capability) — not a user/session — and only for an explicitly-required SAFE scope.
 *
 * PR-C2a does NOT enable any risk scope. The required scope MUST be SAFE; the verifier
 * refuses to authorize anything else (defense in depth), and a grant only passes if it
 * actually carries that exact safe capability and is active/unexpired/unrevoked.
 *
 * Reads via the RFC-016 async seam (dbOne) so PWA and (later, PR-C2b) MCP share it.
 * NO money/order/wallet/refund logic.
 */
import { createHash } from 'node:crypto'
import { dbOne } from '../layer0-foundation/L0-1-database/db.js'
import { classifyScope, grantIsActive, storedUtcInstantIsFuture } from './agent-grant-scopes.js'

export interface GrantPrincipal {
  grant_id: string
  human_id: string
  agent_label: string | null
  capability: string   // the specific safe scope this authorization is for
}

export type GrantVerifyResult =
  | { ok: true; principal: GrantPrincipal }
  | { ok: false; status: number; error_code: string; error: string; grant_id?: string; human_id?: string }

export interface VerifiedGrantRow {
  grant_id: string
  human_id: string
  agent_label: string | null
  capabilities: string
  status: string
  expires_at: string
  revoked_at: string | null
}

export interface OAuthCredentialBinding {
  client_id: string
  scope: string
  audience: string
  dpop_jkt: string | null
}

function parseCaps(json: unknown): Array<{ capability?: string }> {
  try { const v = JSON.parse(String(json)); return Array.isArray(v) ? v : [] } catch { return [] }
}

// The audience an OAuth access token must carry to be accepted here (RFC 8707 / RFC-023 I-3).
// An oat_ minted for /mcp must never authorize anything outside that audience.
const OAUTH_MCP_AUDIENCE = 'https://webaz.xyz/mcp'

interface OAuthTokenRow {
  grant_id: string
  client_id: string
  scope: string
  aud: string
  expires_at: string
  revoked_at: string | null
  dpop_jkt: string | null
}

/**
 * Resolve a bearer → the backing delegation GrantRow, dispatching on prefix:
 *   gtk_*  → agent_delegation_grants.token_hash (RFC-020 direct grant bearer)
 *   oat_*  → introspect oauth_access_tokens (RFC-023): the token is hashed, checked for
 *            unrevoked + unexpired + aud==/mcp, then the grant is loaded by grant_id (OAuth-consent
 *            grants carry token_hash=NULL, so they can ONLY be reached through this table).
 * Returns the row, or a typed failure (same shapes verifyGrantToken already emits).
 */
async function resolveGrantRowFromBearer(
  bearer: string,
  nowIso: string,
  allowSenderConstrained: boolean,
): Promise<{ ok: true; row: VerifiedGrantRow; oauth?: OAuthCredentialBinding } | { ok: false; status: number; error_code: string; error: string }> {
  if (bearer.startsWith('oat_')) {
    const tokenHash = createHash('sha256').update(bearer).digest('hex')
    const tok = await dbOne<OAuthTokenRow>(
      'SELECT grant_id,client_id,scope,aud,expires_at,revoked_at,dpop_jkt FROM oauth_access_tokens WHERE token_hash = ?',
      [tokenHash],
    )
    if (!tok) return { ok: false, status: 401, error_code: 'GRANT_NOT_FOUND', error: 'access token not found' }
    if (tok.revoked_at) return { ok: false, status: 401, error_code: 'TOKEN_REVOKED', error: 'access token has been revoked' }
    if (!storedUtcInstantIsFuture(tok.expires_at, nowIso)) return { ok: false, status: 401, error_code: 'TOKEN_EXPIRED', error: 'access token has expired' }
    if (tok.aud !== OAUTH_MCP_AUDIENCE) return { ok: false, status: 403, error_code: 'TOKEN_WRONG_AUDIENCE', error: `access token audience is not ${OAUTH_MCP_AUDIENCE}` }
    if (tok.dpop_jkt && !allowSenderConstrained) {
      return { ok: false, status: 401, error_code: 'DPOP_PROOF_REQUIRED', error: 'sender-constrained token requires a verified DPoP proof' }
    }
    const row = await dbOne<VerifiedGrantRow>(
      'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE grant_id = ?',
      [tok.grant_id],
    )
    if (!row) return { ok: false, status: 401, error_code: 'GRANT_NOT_FOUND', error: 'delegation grant not found for this token' }
    return {
      ok: true,
      row,
      oauth: {
        client_id: tok.client_id,
        scope: tok.scope,
        audience: tok.aud,
        dpop_jkt: tok.dpop_jkt,
      },
    }
  }
  // gtk_* direct grant bearer
  const tokenHash = createHash('sha256').update(bearer).digest('hex')
  const row = await dbOne<VerifiedGrantRow>(
    'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE token_hash = ?',
    [tokenHash],
  )
  if (!row) return { ok: false, status: 401, error_code: 'GRANT_NOT_FOUND', error: 'delegation grant not found for this token' }
  return { ok: true, row }
}

/**
 * Verify a delegation bearer (`gtk_*` direct grant OR `oat_*` OAuth access token) for an EXPLICIT
 * required SAFE scope. Returns a narrow grant principal on success, or a typed failure. Both token
 * types resolve to the same RFC-020 grant and pass the IDENTICAL active/subject/scope checks, so an
 * OAuth token can never authorize more than the grant the human approved. `nowIso` injectable for tests.
 */
// The token/grant IDENTITY check, scope-agnostic: valid bearer prefix + token resolves (unrevoked,
// unexpired, aud==/mcp) + grant active + accountable human exists and is not suspended. This is the
// "is this a usable credential at all" gate — used both by verifyGrantToken (which then adds a scope
// check) and by the /mcp transport edge (which must reject a PRESENTED-but-invalid oat_ with 401 even on
// a tool that needs no scope, so a bad credential is never silently downgraded to anonymous).
export type GrantIdentityResult =
  | { ok: true; row: VerifiedGrantRow; oauth?: OAuthCredentialBinding }
  | { ok: false; status: number; error_code: string; error: string; grant_id?: string; human_id?: string }

export async function verifyGrantIdentity(
  bearer: string | undefined,
  nowIso: string = new Date().toISOString(),
): Promise<GrantIdentityResult> {
  return verifyGrantIdentityInternal(bearer, nowIso, false)
}

/** Internal Gateway entry: permits a bound token only so the DPoP verifier can validate its proof. */
export async function verifyDpopBoundGrantIdentity(
  bearer: string | undefined,
  nowIso: string = new Date().toISOString(),
): Promise<GrantIdentityResult> {
  return verifyGrantIdentityInternal(bearer, nowIso, true)
}

async function verifyGrantIdentityInternal(
  bearer: string | undefined,
  nowIso: string,
  allowSenderConstrained: boolean,
): Promise<GrantIdentityResult> {
  if (!bearer || !(bearer.startsWith('gtk_') || bearer.startsWith('oat_'))) {
    return { ok: false, status: 401, error_code: 'GRANT_TOKEN_REQUIRED', error: 'a gtk_* delegation grant or oat_* access token bearer is required' }
  }
  const resolved = await resolveGrantRowFromBearer(bearer, nowIso, allowSenderConstrained)
  if (!resolved.ok) return resolved
  const row = resolved.row
  if (!grantIsActive(row, nowIso)) {
    return { ok: false, status: 403, error_code: 'GRANT_INACTIVE', error: 'delegation grant is revoked, expired, or inactive', grant_id: row.grant_id, human_id: row.human_id }
  }
  // The grant is only as valid as its accountable human. Mirror auth(): the subject must still exist and
  // not be suspended (user_moderation.suspended) — else a grant minted before an admin suspension would
  // outlive it. Fail closed.
  const subject = await dbOne<{ id: string; suspended: number | null }>(
    'SELECT u.id AS id, m.suspended AS suspended FROM users u LEFT JOIN user_moderation m ON m.user_id = u.id WHERE u.id = ?',
    [row.human_id],
  )
  if (!subject) {
    return { ok: false, status: 403, error_code: 'GRANT_SUBJECT_INACTIVE', error: 'grant subject (human) no longer exists', grant_id: row.grant_id, human_id: row.human_id }
  }
  if (subject.suspended) {
    return { ok: false, status: 403, error_code: 'GRANT_SUBJECT_INACTIVE', error: 'grant subject (human) is suspended', grant_id: row.grant_id, human_id: row.human_id }
  }
  return { ok: true, row, ...(resolved.oauth ? { oauth: resolved.oauth } : {}) }
}

export async function verifyGrantToken(
  bearer: string | undefined,
  requiredScope: string,
  nowIso: string = new Date().toISOString(),
): Promise<GrantVerifyResult> {
  // Programming guard: an opt-in route must require a SAFE scope. Risk / never-delegable /
  // unknown can NEVER be satisfied by a grant — fail closed regardless of the token.
  if (classifyScope(requiredScope) !== 'safe') {
    return { ok: false, status: 500, error_code: 'SCOPE_NOT_SAFE', error: `requiredScope "${requiredScope}" is not a safe scope; grants can only ever authorize safe scopes` }
  }
  const identity = await verifyGrantIdentity(bearer, nowIso)
  if (!identity.ok) return identity
  const row = identity.row
  const caps = parseCaps(row.capabilities)
  const holds = caps.some(c => c?.capability === requiredScope && classifyScope(String(c.capability)) === 'safe')
  if (!holds) {
    return { ok: false, status: 403, error_code: 'SCOPE_NOT_GRANTED', error: `grant does not carry the required safe scope "${requiredScope}"`, grant_id: row.grant_id, human_id: row.human_id }
  }
  return { ok: true, principal: { grant_id: row.grant_id, human_id: row.human_id, agent_label: row.agent_label, capability: requiredScope } }
}
