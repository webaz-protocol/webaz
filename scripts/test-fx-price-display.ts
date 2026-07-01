#!/usr/bin/env tsx
/**
 * Buyer USDC price display (app-price.js) — PR-1b, display-only.
 *
 * fmtPrice renders a product price in USDC + a real-time local hint; the browse surfaces (app-shop.js,
 * app-discover.js) route product prices through it. Reward / coupon / commission / escrow WAZ amounts are
 * NOT product prices and must STAY "WAZ" (negative assertions). Local currency is region-derived (no picker).
 *
 * Covers the two review P2s:
 *   P2-1 first-paint race — rates arrive after render → refreshFxPrices() updates painted [data-usdc-price] nodes.
 *   P2-2 machine-readable price — discover JSON-LD Offer.priceCurrency is USDC (not defaulting to WAZ).
 *
 * Usage: npm run test:fx-price-display
 */
import { readFileSync } from 'node:fs'

const PRICE = readFileSync('src/pwa/public/app-price.js', 'utf8')
const SHOP = readFileSync('src/pwa/public/app-shop.js', 'utf8')
const DISC = readFileSync('src/pwa/public/app-discover.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. BEHAVIORAL — eval the real helper with a fake window (loadFxRates fires but its fetch just fails → null)
const w: Record<string, unknown> = { state: { user: { region: 'china' } } }
;(new Function('window', PRICE))(w)
const buyerCurrency = w.buyerCurrency as () => string
const fxLocal = w._fxLocal as (u: unknown) => string
const priceInner = w._fxPriceInner as (u: unknown) => string
const fmtPrice = w.fmtPrice as (u: unknown) => string
const setRegion = (r: string) => { (w.state as { user: { region: string } }).user.region = r }

ok('1a. region china → CNY', buyerCurrency() === 'CNY')
setRegion('singapore'); ok('1b. region singapore → SGD', buyerCurrency() === 'SGD')
setRegion('mars'); ok('1c. unknown region → USD', buyerCurrency() === 'USD')

// no rates yet → USDC only
ok('1d. no rates → USDC only', priceInner(30) === '30 USDC' && fxLocal(30) === '')
ok('1e. fmtPrice wraps with a refreshable data-usdc-price node', fmtPrice(30) === '<span data-usdc-price="30">30 USDC</span>')
// inject rates + a CNY buyer
w._fxRates = { base: 'USD', rates: { USD: 1, CNY: 7.2, SGD: 1.35, EUR: 0.92, INR: 83 } }
setRegion('china')
ok('1f. CNY local hint', fxLocal(30) === '¥216')
ok('1g. inner → "30 USDC ≈ ¥216"', /^30 USDC .*≈ ¥216/.test(priceInner(30)))
ok('1h. decimal keeps 2dp', priceInner(49.99).startsWith('49.99 USDC'))
setRegion('us'); ok('1i. USD buyer → no local hint (USDC≈USD)', fxLocal(30) === '' && priceInner(30) === '30 USDC')
ok('1j. bad input → no throw', typeof fmtPrice(null) === 'string')

// 2. P2-1 — first-paint race: node rendered before rates, refreshFxPrices() updates it once rates arrive
{
  const mkNode = (attr: string, val: string, html: string) => ({
    _h: html, getAttribute: (k: string) => (k === attr ? val : null),
    get innerHTML() { return this._h }, set innerHTML(v: string) { this._h = v },
  })
  const priceNode = mkNode('data-usdc-price', '30', '30 USDC')       // painted before rates → USDC only
  const localNode = mkNode('data-usdc-local', '30', 'USDC')
  w.document = { querySelectorAll: (sel: string) => sel === '[data-usdc-price]' ? [priceNode] : sel === '[data-usdc-local]' ? [localNode] : [] }
  setRegion('china')   // rates already injected above
  ;(w.refreshFxPrices as () => void)()
  ok('2a. refresh updates data-usdc-price node with local hint', /≈ ¥216/.test(priceNode._h) && priceNode._h.includes('USDC'))
  ok('2b. refresh updates data-usdc-local node', localNode._h === 'USDC ≈ ¥216')
  w.document = undefined
  ok('2c. refresh is a safe no-op with no document', (() => { try { (w.refreshFxPrices as () => void)(); return true } catch { return false } })())
  ok('2d. loadFxRates calls refreshFxPrices after setting rates', /window\._fxRates = await res\.json\(\);\s*window\.refreshFxPrices\(\)/.test(PRICE))
}

// 3. wiring — browse surfaces route product prices through fmtPrice (+ the split-span via data-usdc-local)
ok('3a. app-shop routes prices via window.fmtPrice (≥8)', (SHOP.match(/window\.fmtPrice\(/g) || []).length >= 8)
ok('3b. app-discover routes prices via window.fmtPrice (≥8)', (DISC.match(/window\.fmtPrice\(/g) || []).length >= 8)
ok('3c. discover split-span refreshable via data-usdc-local', DISC.includes('data-usdc-local="${p.price}"'))

// 4. NEGATIVE — no product price still renders raw "WAZ" on the browse cards
ok('4a. app-shop: no ${p.price}/${cur}/${it.sale_price} WAZ left', !SHOP.includes('${p.price} WAZ') && !SHOP.includes('${cur} WAZ') && !SHOP.includes('${it.sale_price} WAZ'))
ok('4b. app-discover: no ${p.price}/${it.price}/${e.price} WAZ left', !DISC.includes('${p.price} WAZ') && !DISC.includes('${it.price} WAZ') && !DISC.includes('${e.price} WAZ'))

// 5. PRESERVED — reward/coupon/commission/escrow are NOT product prices → must stay WAZ
ok('5a. shop check-in reward stays WAZ', SHOP.includes('reward} WAZ') || SHOP.includes('每日 +0.5 WAZ'))
ok('5b. shop coupon stays WAZ', SHOP.includes('discount_value} WAZ') || SHOP.includes('min_order_amount} WAZ'))
ok('5c. discover escrow "已从钱包托管" stays WAZ', DISC.includes('已从钱包托管') && DISC.includes('verified_price} WAZ'))
ok('5d. discover L1 commission stays WAZ', DISC.includes('L1 佣金') && DISC.includes('l1} WAZ'))

// 6. P2-2 — machine-readable price matches the human USDC display (no WAZ drift for agents/SEO)
ok('6a. discover JSON-LD Offer.priceCurrency is USDC', DISC.includes("priceCurrency: 'USDC'"))
ok('6b. discover JSON-LD no longer defaults to WAZ', !DISC.includes("priceCurrency: pp.currency || 'WAZ'"))

// 7. HONESTY — the price display must not imply real USDC custody/settlement (Codex P3)
ok('7a. app-price.js documents display-only / never implies real USDC settlement', /DISPLAY-ONLY/.test(PRICE) && /NEVER implies WebAZ holds\/settles real USDC/.test(PRICE))

// 8. wiring: load order + Guard B (check:pwa-syntax + LOC_CEILINGS)
ok('8a. index.html loads app-price.js before app.js', HTML.indexOf('/app-price.js') > 0 && HTML.indexOf('/app-price.js') < HTML.indexOf('/app.js'))
ok('8b. app-price.js in check:pwa-syntax', PKG.includes('node --check src/pwa/public/app-price.js'))
ok('8c. app-price.js has a LOC ceiling', /'src\/pwa\/public\/app-price\.js':/.test(RATCHET))

if (fail > 0) { console.error(`\n❌ fx price display FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx price display: USDC + region local hint (behavioral) · first-paint refresh · JSON-LD USDC · rewards/escrow stay WAZ · display-only\n  ✅ pass ${pass}`)
