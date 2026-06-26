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
import { classifyScope, grantIsActive } from './agent-grant-scopes.js'

export interface GrantPrincipal {
  grant_id: string
  human_id: string
  agent_label: string | null
  capability: string   // the specific safe scope this authorization is for
}

export type GrantVerifyResult =
  | { ok: true; principal: GrantPrincipal }
  | { ok: false; status: number; error_code: string; error: string; grant_id?: string; human_id?: string }

interface GrantRow {
  grant_id: string
  human_id: string
  agent_label: string | null
  capabilities: string
  status: string
  expires_at: string
  revoked_at: string | null
}

function parseCaps(json: unknown): Array<{ capability?: string }> {
  try { const v = JSON.parse(String(json)); return Array.isArray(v) ? v : [] } catch { return [] }
}

/**
 * Verify a `gtk_*` bearer for an EXPLICIT required SAFE scope. Returns a narrow grant
 * principal on success, or a typed failure. `nowIso` injectable for tests.
 */
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
  if (!bearer || !bearer.startsWith('gtk_')) {
    return { ok: false, status: 401, error_code: 'GRANT_TOKEN_REQUIRED', error: 'a gtk_* delegation grant bearer is required for this scope' }
  }
  const tokenHash = createHash('sha256').update(bearer).digest('hex')
  const row = await dbOne<GrantRow>(
    'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE token_hash = ?',
    [tokenHash],
  )
  if (!row) {
    return { ok: false, status: 401, error_code: 'GRANT_NOT_FOUND', error: 'delegation grant not found for this token' }
  }
  if (!grantIsActive(row, nowIso)) {
    return { ok: false, status: 403, error_code: 'GRANT_INACTIVE', error: 'delegation grant is revoked, expired, or inactive', grant_id: row.grant_id, human_id: row.human_id }
  }
  const caps = parseCaps(row.capabilities)
  const holds = caps.some(c => c?.capability === requiredScope && classifyScope(String(c.capability)) === 'safe')
  if (!holds) {
    return { ok: false, status: 403, error_code: 'SCOPE_NOT_GRANTED', error: `grant does not carry the required safe scope "${requiredScope}"`, grant_id: row.grant_id, human_id: row.human_id }
  }
  return { ok: true, principal: { grant_id: row.grant_id, human_id: row.human_id, agent_label: row.agent_label, capability: requiredScope } }
}
