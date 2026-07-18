/**
 * FX rates (DISPLAY-ONLY) — USDC → buyer-local-currency conversion for price display.
 *
 * Scope (Holden decision 2026-07-01): USDC pricing display + real-time local conversion. This is NOT a
 * settlement path — it NEVER changes the USDC amount owed; it only produces an informational "≈ ¥X" hint.
 * USDC is treated 1:1 with USD (peg deviation ±0.1% is negligible for a display hint). No DB, no money move.
 *
 * Real-time: live rates are fetched from a keyless public FX API and cached briefly; on any failure we serve
 * the last-known snapshot (marked stale) or a hardcoded fallback table, so the price display NEVER breaks.
 */

// users.region (VALID_REGIONS: china/us/eu/india/singapore/global_north/global) → buyer local display currency.
// Anything unknown / broad-region / null → USD.
export const REGION_CURRENCY: Record<string, string> = {
  china: 'CNY', us: 'USD', eu: 'EUR', india: 'INR', singapore: 'SGD',
  global_north: 'USD', global: 'USD',
  // ISO 3166-1 alpha-2(quote/order 的 dest_region 口径;MCP UI PR-5 起消费者法币估算走这里)
  sg: 'SGD', cn: 'CNY', in: 'INR', id: 'IDR', my: 'MYR', ph: 'PHP', vn: 'VND', th: 'THB',
  de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR',
}
export const SUPPORTED_CURRENCIES = ['USD', 'CNY', 'EUR', 'INR', 'SGD', 'IDR', 'MYR', 'PHP', 'VND', 'THB'] as const
export type Currency = typeof SUPPORTED_CURRENCIES[number]
const isSupported = (c: string): c is Currency => (SUPPORTED_CURRENCIES as readonly string[]).includes(c)

export function regionToCurrency(region: string | null | undefined): Currency {
  const c = REGION_CURRENCY[String(region || '').toLowerCase()]
  return c && isSupported(c) ? c : 'USD'
}

// Fallback (per 1 USD) — used ONLY when the live fetch fails AND no prior snapshot exists. Always served
// with stale:true so the UI can show it as approximate. Kept coarse on purpose (a safety net, not a source).
export const FALLBACK_USD_RATES: Record<Currency, number> = { USD: 1, CNY: 7.2, EUR: 0.92, INR: 83, SGD: 1.35, IDR: 16000, MYR: 4.5, PHP: 58, VND: 25000, THB: 34 }

const TTL_MS = 15 * 60 * 1000   // 15-min cache: fiat FX barely moves intraday → "real-time" enough for a display hint, no API hammering
const FX_URL = process.env.FX_RATES_URL || 'https://open.er-api.com/v6/latest/USD'

export interface RatesSnapshot { base: 'USD'; rates: Record<Currency, number>; as_of: string; stale: boolean }
let _cache: { snap: RatesSnapshot; fetchedAt: number } | null = null

/** PURE: external payload → our supported-currency subset. Throws if any supported rate is missing/invalid. */
export function parseUsdRates(payload: unknown): Record<Currency, number> {
  const p = payload as { rates?: Record<string, unknown>; conversion_rates?: Record<string, unknown> } | null
  const r = p?.rates || p?.conversion_rates
  if (!r || typeof r !== 'object') throw new Error('fx: no rates in payload')
  const out = {} as Record<Currency, number>
  for (const c of SUPPORTED_CURRENCIES) {
    const v = Number((r as Record<string, unknown>)[c])
    if (!Number.isFinite(v) || v <= 0) throw new Error(`fx: bad/absent rate for ${c}`)
    out[c] = v
  }
  return out
}

/** Cached live USD rates; on failure serve last-known (stale) or the fallback table. fetchImpl/now injectable for tests. */
export async function getUsdRates(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<RatesSnapshot> {
  if (_cache && now - _cache.fetchedAt < TTL_MS) return _cache.snap
  try {
    const res = await fetchImpl(FX_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error('fx: http ' + res.status)
    const rates = parseUsdRates(await res.json())
    const snap: RatesSnapshot = { base: 'USD', rates, as_of: new Date(now).toISOString(), stale: false }
    _cache = { snap, fetchedAt: now }
    return snap
  } catch {
    if (_cache) return { ...(_cache.snap), stale: true }   // last-known, flagged stale
    return { base: 'USD', rates: { ...FALLBACK_USD_RATES }, as_of: new Date(now).toISOString(), stale: true }
  }
}

/** PURE: USDC decimal amount → local-currency decimal (USDC≈USD). Display-only; returns NaN on bad input. */
export function convertUsdcToLocal(usdcAmount: number, currency: Currency, rates: Record<Currency, number>): number {
  const rate = rates?.[currency]
  if (!Number.isFinite(usdcAmount) || !Number.isFinite(rate) || rate <= 0) return NaN
  return usdcAmount * rate
}

/** SYNC: last-known snapshot(过 TTL 标 stale)或 fallback 表(stale)。给建单时刻的应付参考换算快照用 ——
 *  display-only,零网络零 await,永不阻塞/永不抛;参考价精度要求低,陈旧可接受且必带 stale 标记。 */
export function getUsdRatesSync(now: number = Date.now()): RatesSnapshot {
  if (_cache) return now - _cache.fetchedAt < TTL_MS ? _cache.snap : { ...(_cache.snap), stale: true }
  return { base: 'USD', rates: { ...FALLBACK_USD_RATES }, as_of: new Date(now).toISOString(), stale: true }
}

/** test-only: reset the module cache so tests are deterministic. */
export function __resetFxCacheForTest(): void { _cache = null }
