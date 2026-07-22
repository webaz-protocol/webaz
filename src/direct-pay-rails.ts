/**
 * RFC-029 Design A — payment-rail states (choose-at-confirm).
 *
 * Today a quote/draft freezes its `payment_rail` at quote time (escrow | direct_p2p).
 * Design A lets the BUYER choose the rail on the confirm page instead of the agent at quote time.
 * The "not yet chosen" state is represented by a `'deferred'` SENTINEL — NOT a nullable column:
 * production is SQLite and cannot drop `NOT NULL` without a table rebuild, so `payment_rail`
 * stays `TEXT NOT NULL` and simply gains a third allowed value. Fully backward-compatible — nothing
 * writes `'deferred'` unless the feature flag is on, so flag-off production is byte-identical.
 *
 * Hard safety invariant (enforced in order-submit-exec + orders-create): a `'deferred'` rail can
 * NEVER create an order. Execution refuses it until the buyer's confirm-stage choice replaces it
 * with a real rail. This module is pure constants/predicates — no DB, no side effects.
 */
export type PaymentRail = 'escrow' | 'direct_p2p' | 'deferred'

/** Sentinel: the buyer has not chosen a payment rail yet (Design A confirm-stage choice pending). */
export const RAIL_DEFERRED = 'deferred'

/** The two rails that can actually create/execute an order. `deferred` is NOT one of them. */
export function isRealRail(r: unknown): r is 'escrow' | 'direct_p2p' {
  return r === 'escrow' || r === 'direct_p2p'
}

/** True for the not-yet-chosen sentinel. */
export function isDeferredRail(r: unknown): boolean {
  return String(r) === RAIL_DEFERRED
}

/**
 * Feature flag for RFC-029 Design A (buyer-chosen rail). Default OFF — when off, the quote flow
 * behaves exactly as before (omitted rail → escrow) and `'deferred'` is rejected as an input.
 * When on, an omitted rail defers to the confirm-stage choice instead of silently picking escrow.
 */
export function railChoiceEnabled(): boolean {
  return process.env.WEBAZ_RAIL_CHOICE === '1'
}
