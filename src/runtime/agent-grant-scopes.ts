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
  // Seller-scoped read/draft surfaces (Catalog Agent role) — read the seller's own catalog + propose
  //   drafts/pricing/publish-REQUESTS. NONE of these publish, accept orders, ship, or move money.
  'seller_profile_read',
  'seller_products_read',
  'seller_inventory_read',
  'seller_product_draft',
  'seller_pricing_suggestion',
  // RFC-021 Fulfillment Agent (order 侧 申请→人工 Passkey 批准). BOTH safe:
  //   seller_orders_read_minimal = 最小化订单读(无买家地址/联系);
  //   order_action_request = SUBMIT-only —— 只能把 {accept|ship} 请求塞进人的审批队列,【绝不执行】;
  //     执行始终由人 Passkey 逐笔批准后服务端跑(RFC-021 §5/§6b)。RISK 档 order_accept/order_ship 不动、仍硬拒。
  'seller_orders_read_minimal',
  'order_action_request',
  // RFC-025 PR-1 — 买家侧最小化订单读(镜像 seller_orders_read_minimal 的 allowlist 纪律):
  //   只读买家【自己的】订单七键投影(order_id/status/next_actor/deadline/amount/item_ref/payment_rail),
  //   无地址/收件人/notes/PII,无任何执行。买家写动作(place_order 等)仍在 RISK 档硬拒不动。
  'buyer_orders_read_minimal',
  // RFC-025 PR-2 — 买家发现(webaz_discover)。读活跃商品 + 【被明确披露的、审计过的内部 append-only 写】:
  //   每次结构化查询落一行 demand_signals(工具 description 里向用户披露)。不是 'search' —— search 授权
  //   不涵盖持久化采集,该效果必须由能力名显式命名。无执行、无资金、无 PII 出口(intent allowlist 化)。
  'buyer_discover',
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
export const GRANT_TTL_MAX_SEC = 24 * 3600       // 24h cap — short-lived only (legacy webaz_pair bearer)
export function clampTtlSeconds(requested: unknown): number {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return GRANT_TTL_DEFAULT_SEC
  return Math.min(Math.floor(n), GRANT_TTL_MAX_SEC)
}

// ─────────────────────────── Permission Bundles (named safe-only scope sets) ───────────────────────────
// A bundle bundles common-job scopes so a merchant approves ONE thing, not N scopes. INVARIANT: a bundle
// may carry ONLY safe scopes — a risk/never-delegable scope can never enter a bundle (asserted at load).
export interface PermissionBundle { key: string; label: string; scopes: readonly string[]; human_summary: string; human_summary_en: string }

export const PERMISSION_BUNDLES: Record<string, PermissionBundle> = {
  catalog_agent: {
    key: 'catalog_agent',
    label: 'Catalog Agent',
    scopes: ['read_public', 'profile_read', 'search', 'seller_profile_read', 'seller_products_read', 'seller_inventory_read', 'seller_product_draft', 'seller_pricing_suggestion', 'product_publish_request'],
    human_summary: '选品、商品草稿、库存字段检查、价格建议、上架请求。它不能发布商品、不能接单、不能发货、不能动用资金。',
    human_summary_en: 'Sourcing, product drafts, inventory-field checks, pricing suggestions, and publish REQUESTS. It cannot publish products, accept orders, ship, or move funds.',
  },
  // RFC-021:独立于 catalog_agent 授予/撤销/TTL(§15.1)。仅含两个 SAFE scope,均不直接执行订单动作。
  fulfillment_agent: {
    key: 'fulfillment_agent',
    label: 'Fulfillment Agent',
    scopes: ['seller_orders_read_minimal', 'order_action_request'],
    human_summary: '读你订单的最小信息(订单号/状态/下一步责任方/截止/金额/商品),再把"接单/发货"请求提交到你的审批队列等你逐笔 Passkey 批准。它【不能】直接接单或发货、看不到买家收货地址与联系方式(接单获批前)、不动任何资金。',
    human_summary_en: 'Reads a minimal view of your orders (id / status / next actor / deadline / amount / item) and SUBMITS "accept / ship" requests into your approval queue for you to approve one-by-one with Passkey. It CANNOT accept or ship directly, cannot see the buyer\'s shipping address or contact (before an accept is approved), and moves no funds.',
  },
}

/** Resolve a bundle key → its safe scopes + human summary, or null if unknown. */
export function resolveBundle(key: unknown): PermissionBundle | null {
  return (typeof key === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_BUNDLES, key)) ? PERMISSION_BUNDLES[key] : null
}

/** INVARIANT check (acceptance #7): a bundle must be all-safe. Returns the offending non-safe scopes. */
export function bundleNonSafeScopes(bundle: PermissionBundle): string[] {
  return bundle.scopes.filter(s => classifyScope(s) !== 'safe')
}

// Load-time assertion: no bundle may ship with a risk/never/unknown scope (fail LOUD at import, not runtime).
for (const b of Object.values(PERMISSION_BUNDLES)) {
  const bad = bundleNonSafeScopes(b)
  if (bad.length) throw new Error(`Permission bundle '${b.key}' contains non-safe scope(s): ${bad.join(', ')} — bundles are safe-only (RFC-020)`)
}

// ─────────────────────────── Duration policy (risk tier → allowed grant lifetimes) ───────────────────────────
export type GrantDuration = 'once' | '1h' | '24h' | '7d' | '30d'
export const DURATION_SECONDS: Record<Exclude<GrantDuration, 'once'>, number> = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 }

/**
 * Which durations a set of scopes may be granted for, capped by the HIGHEST risk tier present:
 *   - never-delegable / unknown  → []                  (cannot be granted at all)
 *   - risk (high)                → []                  (not delegable to a persistent grant)
 *   - safe (low/medium)          → 1h / 24h / 7d / 30d  (long-term ok)
 * NOTE: 'once' is intentionally NOT offered. It's a real single-use concept, but no single-use grant
 *   CONSUMPTION mechanism exists yet — durationToSeconds('once') would fall back to a 1h *reusable* bearer,
 *   which misleads. Until a true single-use grant is built, 'once' stays out of the allowed set / UI / i18n.
 */
export function allowedDurationsForScopes(scopes: readonly string[]): GrantDuration[] {
  const tiers = scopes.map(classifyScope)
  if (tiers.some(t => t === 'never_delegable' || t === 'unknown')) return []
  if (tiers.some(t => t === 'risk')) return []
  return ['1h', '24h', '7d', '30d']
}

export function durationAllowedForScopes(scopes: readonly string[], duration: unknown): boolean {
  return typeof duration === 'string' && (allowedDurationsForScopes(scopes) as string[]).includes(duration)
}

/** Suggested default: 7d for long-term-eligible safe scopes; else the safest available. */
export function suggestedDurationForScopes(scopes: readonly string[]): GrantDuration {
  const a = allowedDurationsForScopes(scopes)
  return a.includes('7d') ? '7d' : (a[0] ?? '7d')
}

/** Grant lifetime in seconds. 'once' is RESERVED for a future single-use grant (no consumption path yet) and
 *  is never offered; if it somehow arrives it maps to 0 → callers fall back to a short window. */
export function durationToSeconds(duration: GrantDuration): number {
  return duration === 'once' ? 0 : DURATION_SECONDS[duration]
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'blocked'
/** Coarse risk label for the human-facing request card. */
export function riskLevelForScopes(scopes: readonly string[]): RiskLevel {
  const tiers = scopes.map(classifyScope)
  if (tiers.some(t => t === 'never_delegable' || t === 'unknown')) return 'blocked'
  if (tiers.some(t => t === 'risk')) return 'high'
  if (scopes.includes('product_publish_request')) return 'medium'   // request-only (still human-gated to publish), flag as medium
  return 'low'
}
