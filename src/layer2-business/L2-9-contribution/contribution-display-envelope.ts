/**
 * PR-5A — Contribution display: the uncommitted-value boundary (RFC-017 I-12 / §7).
 *
 * This is the SAFETY CONTRACT that must wrap every contribution metering/display surface BEFORE any
 * valuation/scoring is ever built. RFC-017 separates three layers — fact · valuation · redemption — and
 * locks the boundary: today the protocol grants NO economic value. So any surface that shows facts /
 * attribution must carry an explicit, machine-readable boundary saying so, so the act of *measuring and
 * displaying* contribution can never read as a payout promise (the legal/trust firewall, RFC-017 §7 R1).
 *
 * This module is PURELY a display contract: it computes/scores NOTHING, stores NOTHING, and imports NO
 * reward / KYC / wallet / valuation module (enforced by the §8 iron-rule guard, rule5). It only stamps a
 * constant boundary onto a payload:
 *   - value_state      = 'uncommitted'   (RFC-017 I-12 — the whole-protocol stance)
 *   - valuation_state  = 'not_defined'   (the valuation layer is deferred to a future DAO + team)
 *   - redemption_state = 'not_defined'   (the redemption layer is explicitly uncommitted in full)
 *   - economic_rights  = false           (grants no security / equity / debt / redemption right)
 * and NO amount / currency / yield / payout field is ever added (the notice deliberately does not even
 * name those words, so a display can carry the boundary without listing a "value").
 *
 * spec: docs/rfcs/RFC-017-contribution-protocol-v1.md §I-12/§7 · docs/IDENTITY-CLAIM-DESIGN.md §8.8.
 */

export interface UncommittedValueBoundary {
  value_state: 'uncommitted'
  valuation_state: 'not_defined'
  redemption_state: 'not_defined'
  economic_rights: false
  boundary_ref: 'RFC-017 I-12'
  notice_en: string
  notice_zh: string
}

// Frozen constant — there is exactly ONE boundary stance pre-launch; callers must not vary it. The notice
// is an informational disclaimer ONLY; it intentionally avoids the words amount/currency/yield/payout/
// reward so a display never restates a "value", and it promises nothing.
export const UNCOMMITTED_VALUE_BOUNDARY: UncommittedValueBoundary = Object.freeze({
  value_state: 'uncommitted',
  valuation_state: 'not_defined',
  redemption_state: 'not_defined',
  economic_rights: false,
  boundary_ref: 'RFC-017 I-12',
  notice_en: 'Informational record of contribution facts and attribution only. It is not a financial instrument and confers no economic or redemption right; nothing here is promised or guaranteed (RFC-017 I-12 / §7).',
  notice_zh: '仅为贡献事实与归属的信息性记录,不是金融工具,不授予任何经济或兑现权利,此处不作任何承诺或保证(RFC-017 I-12 / §7)。',
})

/**
 * Stamp the uncommitted-value boundary onto a contribution display payload, under a single top-level
 * `value_boundary` key. Pure: returns a new object, never mutates the input, adds no economic field.
 */
export function withUncommittedValueBoundary<T extends object>(
  payload: T,
): T & { value_boundary: UncommittedValueBoundary } {
  return { ...payload, value_boundary: UNCOMMITTED_VALUE_BOUNDARY }
}
