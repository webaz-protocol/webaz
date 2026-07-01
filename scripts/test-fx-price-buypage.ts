#!/usr/bin/env tsx
/**
 * Buyer buy/detail page USDC pricing (renderBuyPage) — PR-1c, display-only.
 *
 * The order/detail page ("下单" surface) now shows the product price in USDC (via fmtPrice / data-usdc-local),
 * replacing the old "WAZ ≈ $" (usdHint) with "USDC ≈ <local>", and its JSON-LD Offer.priceCurrency flips to
 * USDC alongside the human display (no human/agent drift). Behavioral fmtPrice/_fxLocal is covered by
 * test-fx-price-display; this asserts the buy-page wiring + the JSON-LD, and that non-price WAZ is untouched.
 *
 * Usage: npm run test:fx-price-buypage
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const start = APP.indexOf('async function renderBuyPage')
const end = APP.indexOf('function renderCommentSection')
const buyPage = start >= 0 && end > start ? APP.slice(start, end) : ''

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

ok('0. renderBuyPage slice found', buyPage.length > 0)

// 1. buy-page product prices route through the USDC helpers
ok('1a. compact + buy-sheet + CTA prices via window.fmtPrice(livePrice)', (buyPage.match(/window\.fmtPrice\(livePrice\)/g) || []).length >= 3)
ok('1b. flash price via window.fmtPrice(state._flashSale.sale_price)', buyPage.includes('window.fmtPrice(state._flashSale.sale_price)'))
ok('1c. main price unit span refreshable via data-usdc-local', buyPage.includes('data-usdc-local="${p.price}"'))
ok('1d. final "确认下单" CTA (btn-doBuy) shows fmtPrice, not raw WAZ', buyPage.includes("${t('确认下单')} · ${window.fmtPrice(livePrice)}"))

// 2. NEGATIVE — old WAZ/usdHint product-price displays gone from the buy page
ok('2a. no ${livePrice} …WAZ span left', !buyPage.includes('${livePrice} <span style="font-size:11px;font-weight:600">WAZ</span>'))
ok('2b. no WAZ${usdHint(p.price)} main-price left', !buyPage.includes('WAZ${usdHint(p.price)}'))
ok('2c. no flash "${state._flashSale.sale_price} WAZ" left', !buyPage.includes('${state._flashSale.sale_price} WAZ'))
ok('2d. no ${livePrice} WAZ anywhere on the buy page (covers the CTA)', !buyPage.includes('${livePrice} WAZ'))

// 3. P2-2 (detail JSON-LD) — machine-readable price flips to USDC with the human display
ok('3a. buy-page JSON-LD Offer.priceCurrency is USDC', buyPage.includes("priceCurrency: 'USDC'"))
ok('3b. buy-page JSON-LD no longer defaults to WAZ', !buyPage.includes("priceCurrency: p.currency || 'WAZ'"))

// 4. PRESERVED — non-product-price WAZ untouched (usdHint stays for order detail = PR-1d; wallet stays WAZ)
ok('4a. order-detail still uses usdHint (deferred to PR-1d, not ripped out)', APP.includes('usdHint(order.total_amount)'))
ok('4b. usdHint/wazToUsd helpers still defined', APP.includes('function usdHint(') && APP.includes('function wazToUsd('))

if (fail > 0) { console.error(`\n❌ fx price buypage FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx price buypage: order/detail price → USDC (fmtPrice / data-usdc-local) + JSON-LD USDC; non-price WAZ untouched\n  ✅ pass ${pass}`)
