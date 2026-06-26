/**
 * RFC-020 PR-B — agent delegation grant scope taxonomy (pure, no I/O).
 *
 * Source of truth: docs/rfcs/RFC-020-agent-delegation-grants.md §3.1/§3.2 and the
 * companion docs/rfcs/RFC-020-implementation-plan.md §3. Importable by the PWA
 * grant routes, the (future) MCP `webaz_pair` consumer, and tests — no DB, no env.
 *
 * THREE tiers. In PR-B a grant may carry ONLY safe scopes:
 *   - SAFE: grantable now (server-enforced constraints, no per-action Passkey).
 *   - RISK: **default hard-reject** in PR-B. They are NOT yet Passkey-gated at the
 *     route level (place_order / order actions / refunds / wallet ops are plain
 *     auth() paths today), so a grant must never carry them until each money/state
 *     route adds a real Passkey gate in its own dedicated, money-path-aware PR.
 *   - NEVER_DELEGABLE: server hard-reject forever — no grant may EVER carry these
 *     (funds movement, key/Passkey changes, grant self-escalation, admin/governance,
 *     account creation/deletion, access-control). "Do it at webaz.xyz with a live
 *     Passkey."
 *
 * PR-B touches NO payment/wallet/order/refund/escrow/commission/fund/tokenomics
 * code; it only classifies scope strings and gates what a grant may be issued for.
 */

export type ScopeTier = 'safe' | 'risk' | 'never_delegable' | 'unknown'

/** Grantable now — read/draft surfaces; benign or constraint-bounded. */
export const SAFE_SCOPES = [
  'read_public',
  'profile_read',
  'search',
  'list_product_draft',
  'product_publish_request',
  'draft_order',
] as const

/**
 * Real actions that WILL require a live Passkey each time — but are NOT yet gated
 * at the route level. Default hard-reject in PR-B (see module header).
 */
export const RISK_SCOPES = [
  'place_order',
  'order_accept',
  'order_ship',
  'order_status',
  'wallet',
  'payout',
  'refund',
  'arbitrate',
  'vote',
  'claim_verify',
] as const

/** Never carried by any grant — server hard-reject, independent of UI. */
export const NEVER_DELEGABLE_SCOPES = [
  'withdraw',
  'transfer',
  'convert',
  'deposit',
  'fund_move',
  'api_key_create',
  'api_key_rotate',
  'api_key_reveal',
  'passkey_change',
  'grant_escalate',
  'account_delete',
  'access_control_change',
  'admin',
  'protocol_param',
  'create_live_account',
] as const

const SAFE = new Set<string>(SAFE_SCOPES)
const RISK = new Set<string>(RISK_SCOPES)
const NEVER = new Set<string>(NEVER_DELEGABLE_SCOPES)

export function classifyScope(capability: string): ScopeTier {
  if (NEVER.has(capability)) return 'never_delegable'
  if (RISK.has(capability)) return 'risk'
  if (SAFE.has(capability)) return 'safe'
  return 'unknown'
}

export interface RequestedCapability { capability: string; constraints?: Record<string, unknown> }
export interface RejectedCapability { capability: string; tier: ScopeTier; error_code: string; reason: string }
export interface CapabilityValidation { ok: boolean; safe: string[]; rejected: RejectedCapability[] }

/**
 * Validate the capabilities requested for a grant. PR-B policy: a grant is issuable
 * ONLY if every requested capability is SAFE. Any risk / never-delegable / unknown
 * scope rejects the whole request (fail-closed). The error_code distinguishes the
 * permanent never-delegable wall from the "not enabled yet" risk wall.
 */
export function validateRequestedCapabilities(caps: readonly RequestedCapability[]): CapabilityValidation {
  const safe: string[] = []
  const rejected: RejectedCapability[] = []
  if (!Array.isArray(caps) || caps.length === 0) {
    return { ok: false, safe, rejected: [{ capability: '(none)', tier: 'unknown', error_code: 'NO_CAPABILITIES', reason: 'at least one capability is required' }] }
  }
  for (const c of caps) {
    const cap = c?.capability
    const tier = typeof cap === 'string' ? classifyScope(cap) : 'unknown'
    switch (tier) {
      case 'safe':
        safe.push(cap)
        break
      case 'risk':
        rejected.push({ capability: String(cap), tier, error_code: 'RISK_SCOPE_NOT_ENABLED', reason: 'risk scope is not delegable yet — the owning money/state route must add a live-Passkey gate first (RFC-020 §3.1)' })
        break
      case 'never_delegable':
        rejected.push({ capability: String(cap), tier, error_code: 'NEVER_DELEGABLE', reason: 'never-delegable iron-rule action — must be done by the human at webaz.xyz with a live Passkey (RFC-020 §3.2)' })
        break
      default:
        rejected.push({ capability: String(cap ?? '(missing)'), tier: 'unknown', error_code: 'UNKNOWN_SCOPE', reason: 'unknown capability — not in the safe scope set' })
    }
  }
  return { ok: rejected.length === 0, safe, rejected }
}

export interface GrantRow { status?: string; expires_at?: string; revoked_at?: string | null }

/** A grant authorizes nothing unless it is active and unexpired. `nowIso` for testability. */
export function grantIsActive(grant: GrantRow, nowIso: string): boolean {
  if (!grant) return false
  if (grant.status !== 'active') return false
  if (grant.revoked_at) return false
  if (!grant.expires_at) return false
  return grant.expires_at > nowIso
}

/** Short-lived bearer policy for SAFE scopes (RFC-020 bearer-first; PoP before risk/longer). */
export const GRANT_TTL_DEFAULT_SEC = 3600        // 1h
export const GRANT_TTL_MAX_SEC = 24 * 3600       // 24h cap — short-lived only
export function clampTtlSeconds(requested: unknown): number {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return GRANT_TTL_DEFAULT_SEC
  return Math.min(Math.floor(n), GRANT_TTL_MAX_SEC)
}
