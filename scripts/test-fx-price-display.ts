#!/usr/bin/env tsx
/**
 * Buyer USDC price display (app-price.js) — PR-1b, display-only.
 *
 * fmtPrice renders a product price in USDC + a real-time local hint; the browse surfaces (app-shop.js,
 * app-discover.js) route product prices through it. Reward / coupon / commission / escrow WAZ amounts are
 * NOT product prices and must STAY "WAZ" (negative assertions). Local currency is region-derived (no picker).
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
const fxLocal = w._fxLocal as (u: number) => string
const fmtPrice = w.fmtPrice as (u: unknown) => string

ok('1a. region china → CNY', buyerCurrency() === 'CNY')
;(w.state as { user: { region: string } }).user.region = 'singapore'
ok('1b. region singapore → SGD', buyerCurrency() === 'SGD')
;(w.state as { user: { region: string } }).user.region = 'mars'
ok('1c. unknown region → USD', buyerCurrency() === 'USD')

// no rates yet → USDC only, no local
ok('1d. no rates → USDC only', fmtPrice(30) === '30 USDC' && fxLocal(30) === '')
// inject rates + a CNY buyer
w._fxRates = { base: 'USD', rates: { USD: 1, CNY: 7.2, SGD: 1.35, EUR: 0.92, INR: 83 } }
;(w.state as { user: { region: string } }).user.region = 'china'
ok('1e. CNY local hint', fxLocal(30) === '¥216')
ok('1f. fmtPrice integer → "30 USDC ≈ ¥216"', /^30 USDC .*≈ ¥216/.test(fmtPrice(30)))
ok('1g. fmtPrice decimal keeps 2dp', fmtPrice(49.99).startsWith('49.99 USDC'))
;(w.state as { user: { region: string } }).user.region = 'us'
ok('1h. USD buyer → no local hint (USDC≈USD, redundant)', fxLocal(30) === '' && fmtPrice(30) === '30 USDC')
ok('1i. bad input → empty-ish, no throw', fmtPrice(null) === ' USDC' || typeof fmtPrice(null) === 'string')

// 2. wiring — browse surfaces route product prices through fmtPrice
ok('2a. app-shop routes prices via window.fmtPrice (≥8)', (SHOP.match(/window\.fmtPrice\(/g) || []).length >= 8)
ok('2b. app-discover routes prices via window.fmtPrice (≥8)', (DISC.match(/window\.fmtPrice\(/g) || []).length >= 8)
ok('2c. discover split-span uses window._fxLocal', DISC.includes('window._fxLocal(p.price)'))

// 3. NEGATIVE — no product price still renders raw "WAZ" on the browse cards
ok('3a. app-shop: no ${p.price} WAZ / ${cur} WAZ / ${it.sale_price} WAZ left', !SHOP.includes('${p.price} WAZ') && !SHOP.includes('${cur} WAZ') && !SHOP.includes('${it.sale_price} WAZ'))
ok('3b. app-discover: no ${p.price} WAZ / ${it.price} WAZ / ${e.price} WAZ left', !DISC.includes('${p.price} WAZ') && !DISC.includes('${it.price} WAZ') && !DISC.includes('${e.price} WAZ'))

// 4. PRESERVED — reward/coupon/commission/escrow are NOT product prices → must stay WAZ
ok('4a. shop check-in reward stays WAZ', SHOP.includes('reward} WAZ') || SHOP.includes('每日 +0.5 WAZ'))
ok('4b. shop coupon discount stays WAZ', SHOP.includes('discount_value} WAZ') || SHOP.includes('min_order_amount} WAZ'))
ok('4c. discover escrow "已从钱包托管" stays WAZ', DISC.includes('已从钱包托管') && DISC.includes('verified_price} WAZ'))
ok('4d. discover L1 commission stays WAZ', DISC.includes('L1 佣金') && DISC.includes('l1} WAZ'))

// 5. HONESTY — the price display must not imply real USDC custody/settlement (Codex P3)
ok('5a. app-price.js documents display-only / no real USDC settlement', /DISPLAY-ONLY/.test(PRICE) && /(never|NEVER).*(implies|settle|custody)/i.test(PRICE))

// 6. wiring: load order + Guard B (check:pwa-syntax + LOC_CEILINGS)
ok('6a. index.html loads app-price.js before app.js', HTML.indexOf('/app-price.js') > 0 && HTML.indexOf('/app-price.js') < HTML.indexOf('/app.js'))
ok('6b. app-price.js in check:pwa-syntax', PKG.includes('node --check src/pwa/public/app-price.js'))
ok('6c. app-price.js has a LOC ceiling', /'src\/pwa\/public\/app-price\.js':/.test(RATCHET))

if (fail > 0) { console.error(`\n❌ fx price display FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx price display: USDC + region-derived local hint (behavioral); browse cards routed; rewards/coupons/escrow stay WAZ; display-only\n  ✅ pass ${pass}`)
