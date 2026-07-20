/**
 * BUG-02 — promised delivery ETA snapshot (domain helper).
 *
 * Three distinct delivery estimates are kept separate (Phase-3A.2A §III):
 *   1. listing_eta          — the product's CURRENT `estimated_days` (mutable; shown on the search/detail card).
 *   2. promised_eta_snapshot — the estimate FROZEN at quote time (what the buyer was shown), inherited draft→order.
 *   3. logistics_eta        — the order-time template estimate (`orders.shipping_est_days`); WebAZ has no live
 *                              carrier feed yet, so this is a snapshot too, surfaced separately and honestly.
 *
 * This module builds ONLY the promised_eta_snapshot (a DISCLOSURE record, never a logistics guarantee). It is
 * region-resolved and reuses the existing shipping-template resolution so quote and order agree by construction.
 * It touches no money, no order status, no deadline.
 */
import type Database from 'better-sqlite3'
import { effectiveShippingTemplate, resolveShipping, normalizeRegion } from './shipping-templates.js'

export const PROMISED_ETA_SCHEMA = 'webaz.promised_eta.v1'

export type PromisedEtaSource = 'template_exact' | 'template_wildcard' | 'product_listing' | 'none'

export interface PromisedEta {
  schema_version: string
  destination_region: string | null    // normalized (trim+UPPER) region actually resolved against; null if none given
  estimated_days_text: string | null    // the frozen human-facing string the buyer saw (e.g. "12", "7-10")
  estimated_min_days: number | null      // parsed lower bound (== max for a single value); null if unparseable
  estimated_max_days: number | null      // parsed upper bound; schema allows a future range even if today min==max
  source: PromisedEtaSource
  captured_at: string                     // ISO 8601 UTC (…Z); '' only for the legacy-missing marker
  unavailable_reason: string | null       // 'no_estimate' | 'region_not_covered' | 'legacy_not_recorded' | null
  legacy_missing: boolean                 // true ONLY for a legacy order that predates snapshots (never backfilled)
}

/** Parse a free-text est_days string ("12" / "7-10" / "2-4天" / "约12") into {min,max} days, or nulls. */
export function parseEtaDays(text: string | null | undefined): { min: number | null; max: number | null } {
  if (text == null) return { min: null, max: null }
  const nums = String(text).match(/\d+/g)
  if (!nums) return { min: null, max: null }
  const vals = nums.map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 3650)   // sane upper bound (~10y)
  if (!vals.length) return { min: null, max: null }
  return { min: Math.min(...vals), max: Math.max(...vals) }
}

/**
 * Build the promised delivery ETA snapshot at QUOTE time from the then-current listing + destination region.
 * Region resolution (§IV): exact template est_days → '*' wildcard template est_days → product-level
 * estimated_days → none. Region is normalized (trim + UPPERCASE) so 'sg'/'SG' agree; no CJK→ISO aliasing
 * (a pre-existing gap kept out of BUG-02 — a name that is not the template key is honestly region_not_covered).
 */
export function buildPromisedEta(
  db: Database.Database,
  product: { estimated_days?: string | null; shipping_template?: string | null },
  sellerId: string,
  rawRegion: unknown,
  capturedAtIso: string,
): PromisedEta {
  const region = normalizeRegion(rawRegion)
  const tpl = effectiveShippingTemplate(db, product, sellerId)
  let text: string | null = null
  let source: PromisedEtaSource = 'none'
  let unavailable: string | null = null
  if (tpl && region) {
    const r = resolveShipping(tpl, region)
    if (r.covered && r.est_days) { text = r.est_days; source = r.matched === 'exact' ? 'template_exact' : 'template_wildcard' }
    else if (!r.covered) { unavailable = 'region_not_covered' }
    // covered but that entry has no est_days → fall through to the product-level listing value
  }
  if (!text) {
    const prodEta = product.estimated_days == null ? null : String(product.estimated_days).trim()
    if (prodEta) { text = prodEta; source = 'product_listing'; unavailable = null }
  }
  const { min, max } = parseEtaDays(text)
  return {
    schema_version: PROMISED_ETA_SCHEMA,
    destination_region: region,
    estimated_days_text: text,
    estimated_min_days: min,
    estimated_max_days: max,
    source: text ? source : 'none',
    captured_at: capturedAtIso,
    unavailable_reason: text ? null : (unavailable ?? 'no_estimate'),
    legacy_missing: false,
  }
}

export function serializePromisedEta(e: PromisedEta): string { return JSON.stringify(e) }

/** Parse a stored snapshot; null on absent/malformed (never throws into a read path). */
export function parsePromisedEta(json: string | null | undefined): PromisedEta | null {
  if (!json) return null
  try { const o = JSON.parse(json) as PromisedEta; return o && typeof o === 'object' && o.schema_version === PROMISED_ETA_SCHEMA ? o : null } catch { return null }
}

/**
 * BUG-02 (adversarial F2) — the promised-ETA JSON to persist at ORDER creation, for BOTH purchase paths:
 *   - draft-linked (quote→draft→submit→Passkey): inherit the draft's already-frozen snapshot (no re-read).
 *   - direct buy-now (webaz_place_order / PWA #buy, no draft): freeze the CURRENT listing (region-resolved)
 *     — that is exactly what the buyer saw at the buy-now moment. `captured_at` = order-creation time (UTC).
 * Returns a JSON string or null (a legacy/absent draft snapshot stays null → legacy_missing at read).
 */
export function promisedEtaForOrder(
  db: Database.Database,
  product: { estimated_days?: string | null; shipping_template?: string | null },
  sellerId: string,
  rawRegion: unknown,
  draftId: string | null | undefined,
  capturedAtIso: string,
): string | null {
  if (draftId) {
    const r = db.prepare('SELECT promised_eta_snapshot FROM order_drafts WHERE id = ?').get(String(draftId)) as { promised_eta_snapshot: string | null } | undefined
    return r?.promised_eta_snapshot ?? null
  }
  return serializePromisedEta(buildPromisedEta(db, product, sellerId, rawRegion, capturedAtIso))
}

/** Stable marker for a legacy order with no snapshot — rendered as "下单时未记录预计配送时间"; NEVER backfilled. */
export function legacyMissingEta(): PromisedEta {
  return { schema_version: PROMISED_ETA_SCHEMA, destination_region: null, estimated_days_text: null, estimated_min_days: null, estimated_max_days: null, source: 'none', captured_at: '', unavailable_reason: 'legacy_not_recorded', legacy_missing: true }
}
