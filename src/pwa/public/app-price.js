// Buyer price display (DISPLAY-ONLY) — render a product price in USDC with a real-time local-currency hint.
//   fmtPrice(usdc) → a <span data-usdc-price> wrapper whose content is "<amount> USDC" + (when live rates + a
//     non-USD buyer currency are available) a muted "≈ <local>". USDC is the display/pricing unit (money.ts:
//     1 WAZ = 1 USDC = 1e6 base-units, USDC-aligned); this NEVER implies WebAZ holds/settles real USDC —
//     escrow is still simulated WAZ, direct-pay is off-platform.
//   Local currency is derived from the buyer's account region (no manual picker). Rates come from /api/fx/rates
//     (cached + fallback server-side). If rates are unavailable the price simply shows USDC — display never breaks.
//   First-paint race: rates load async; when they arrive, refreshFxPrices() re-renders already-painted price
//     nodes ([data-usdc-price] / [data-usdc-local]) so the "≈ local" hint appears without a full re-render.
window._fxRates = null
window.loadFxRates = async () => {
  try {
    const res = await fetch('/api/fx/rates', { signal: AbortSignal.timeout(6000) })
    if (res.ok) { window._fxRates = await res.json(); window.refreshFxPrices() }
  } catch { /* leave null → prices show USDC-only */ }
}
window.buyerCurrency = () => {
  const map = { china: 'CNY', us: 'USD', eu: 'EUR', india: 'INR', singapore: 'SGD', global_north: 'USD', global: 'USD' }
  const region = (window.state && window.state.user && window.state.user.region) || ''
  return map[String(region).toLowerCase()] || 'USD'
}
// usdc amount → localized "≈ ¥X" string, or '' (USD buyer / no rates / unusable rate → show USDC only).
window._fxLocal = (usdc) => {
  const r = window._fxRates
  const cur = window.buyerCurrency()
  if (!r || !r.rates || cur === 'USD') return ''
  const rate = Number(r.rates[cur])
  const n = Number(usdc)
  if (!(rate > 0) || !Number.isFinite(n)) return ''
  const local = n * rate
  const sym = { CNY: '¥', EUR: '€', INR: '₹', SGD: 'S$', USD: '$' }[cur] || (cur + ' ')
  return sym + (local >= 100 ? String(Math.round(local)) : local.toFixed(2))
}
// visible price content (no wrapper): "<amount> USDC" + optional muted "≈ local".
window._fxPriceInner = (usdc) => {
  const n = Number(usdc)
  const disp = Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : ''
  const base = disp + ' USDC'
  const loc = window._fxLocal(usdc)
  return loc ? base + ` <span style="opacity:.6;font-weight:400;font-size:.85em;white-space:nowrap">≈ ${loc}</span>` : base
}
// price (USDC decimal) → display HTML. data-usdc-price lets refreshFxPrices() update it once live rates arrive.
window.fmtPrice = (usdc) => `<span data-usdc-price="${Number(usdc)}">${window._fxPriceInner(usdc)}</span>`
// re-render already-painted price nodes after rates load (fixes the first-paint race). Safe no-op if no nodes.
window.refreshFxPrices = () => {
  const doc = window.document
  if (!doc || !doc.querySelectorAll) return
  doc.querySelectorAll('[data-usdc-price]').forEach((el) => { el.innerHTML = window._fxPriceInner(el.getAttribute('data-usdc-price')) })
  doc.querySelectorAll('[data-usdc-local]').forEach((el) => {
    const p = el.getAttribute('data-usdc-local'); const loc = window._fxLocal(p)
    el.innerHTML = 'USDC' + (loc ? ' ≈ ' + loc : '')
  })
}
// fire-and-forget at load; rates are global (no auth), so they can load before the user object is known.
window.loadFxRates()
