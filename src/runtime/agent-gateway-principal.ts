/**
 * Agent/API Security Gateway — principal classification (RFC threat-model §3.1 / §6 step 5).
 *
 * Pure, DB-free mapping from three verified facts to one agent principal tier. The §3.1 taxonomy's
 * "verifiable basis" column is the whole contract; nothing here trusts self-reported identity (§3.2 —
 * User-Agent / model name / Origin / an unverified DCR client_id all prove NOTHING).
 *
 * Agent principals only (the gateway context always represents an AGENT). The human_browser_guest /
 * human_session / legacy_api_key_client classes in §3.1 live on other surfaces, never in this context.
 *
 * Fail-closed ladder — an unverified registry client is `anonymous_agent` no matter what else it presents:
 *   registry_status !== 'verified'                                   → anonymous_agent   (§3.2)
 *   verified + no active user OAuth grant                            → registered_agent  (higher public-read quota, no user authority)
 *   verified + active grant + token NOT sender-constrained          → user_authorized_agent
 *   verified + active grant + sender-constrained (DPoP/sig) token   → verified_partner_agent
 *
 * There is no path where a non-verified registry status yields any authority above anonymous.
 */

export type AgentGatewayPrincipalType =
  | 'anonymous_agent'
  | 'registered_agent'
  | 'user_authorized_agent'
  | 'verified_partner_agent'

/** Back-compat alias for the context field name `trust_tier` (was a single literal). */
export type AgentGatewayTrustTier = AgentGatewayPrincipalType

export interface GatewayPrincipalFacts {
  /** agent_gateway_clients.registry_status as read at verification time. Only 'verified' grants any tier above anonymous. */
  registry_status: string
  /** an active OAuth delegation grant with a live subject is bound to this request. */
  has_active_user_grant: boolean
  /** the presented access token is sender-constrained (a valid DPoP/request-signature proof bound its key). */
  sender_constrained: boolean
}

/**
 * Classify the agent principal from verified facts. Pure and total. Callers MUST pass facts they have
 * already verified (registry row, grant/subject check, proof result) — this function trusts nothing itself.
 */
export function classifyGatewayPrincipal(facts: GatewayPrincipalFacts): AgentGatewayPrincipalType {
  if (facts.registry_status !== 'verified') return 'anonymous_agent'
  if (!facts.has_active_user_grant) return 'registered_agent'
  return facts.sender_constrained ? 'verified_partner_agent' : 'user_authorized_agent'
}
