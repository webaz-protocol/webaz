#!/usr/bin/env tsx
/**
 * Other product-type LISTING prices → USDC (PR-1d, display-only).
 *
 * Finishes the "prices are USDC" line: secondhand, skill-market, group-buy, p2p, and the full-leaderboard
 * product line now render listing prices via window.fmtPrice (USDC + real-time local hint), matching browse
 * (#167) and buy/detail (#168). Behavioral fmtPrice/_fxLocal is covered by test-fx-price-display.
 *
 * Out of scope (pending decision / by design): order totals, cart, wallet/balance, escrow "已托管" (simulated
 * WAZ), auction bids, group-buy reserve, duty/donation — those stay WAZ here.
 *
 * Usage: npm run test:fx-price-listings
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const LIST = readFileSync('src/pwa/public/app-listings.js', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. secondhand cards + detail
ok('1a. secondhand cards use fmtPrice', APP.includes('<div style="font-size:14px;font-weight:700;color:#dc2626">${window.fmtPrice(it.price)}</div>'))
ok('1b. secondhand detail price uses fmtPrice', APP.includes('<div style="font-size:24px;font-weight:700;color:#dc2626">${window.fmtPrice(it.price)}</div>'))

// 2. skill-market card + billing label
ok('2a. skill card uses fmtPrice', APP.includes('<div style="font-size:13px;font-weight:700;color:#dc2626">${window.fmtPrice(it.price)}</div>'))
ok('2b. skmBillingLabel per_use uses fmtPrice', APP.includes("🔁 ${window.fmtPrice(price)}/${t('次')}"))
ok('2c. skmBillingLabel fixed uses fmtPrice', APP.includes('💰 ${window.fmtPrice(price)}'))

// 3. group-buy (regular + sale) + p2p + full leaderboard
ok('3a. group-buy price uses fmtPrice', APP.includes(';margin-top:4px">${window.fmtPrice(p.price)}</div>'))
ok('3b. group-buy sale price uses fmtPrice', APP.includes('${window.fmtPrice(it.sale_price)} <span style="font-size:11px;color:#9ca3af;text-decoration:line-through'))
ok('3c. p2p listing uses fmtPrice', APP.includes('font-weight:600">${window.fmtPrice(it.price)} <span style="font-size:11px;color:#9ca3af;font-weight:400">· ${stockBadgeHtml(it)}'))
ok('3d. full-leaderboard product line uses fmtPrice', APP.includes('<div style="font-size:14px;font-weight:800;color:#dc2626">${window.fmtPrice(p.price)}</div>'))

// 4. NEGATIVE — the old listing-price WAZ patterns are gone
ok('4a. no ${Number(it.price).toFixed(0)} WAZ (sh/skill cards)', !APP.includes('${Number(it.price).toFixed(0)} WAZ'))
ok('4b. no ${Number(it.price).toFixed(2)} WAZ (sh detail)', !APP.includes('${Number(it.price).toFixed(2)} WAZ'))
ok('4c. no ${Number(price).toFixed(0)} WAZ (skill billing)', !APP.includes('${Number(price).toFixed(0)} WAZ'))
ok('4d. no group-buy "${it.sale_price} WAZ" left', !APP.includes('${it.sale_price} WAZ'))

// 6. review round-2 sites (skill buy/use buttons, secondhand "TA 还在卖", p2p main list, listing identity/offer)
ok('6a. skill buy button → fmtPrice', APP.includes("${t('购买')} · ${window.fmtPrice(l.price)}"))
ok('6b. skill use (per_use) button → fmtPrice', APP.includes("${t('使用')} · ${window.fmtPrice(l.price)}/${t('次')}"))
ok('6c. secondhand "TA 还在卖" card → fmtPrice', APP.includes('<div style="font-size:13px;font-weight:700;color:#dc2626">${window.fmtPrice(o.price)}</div>'))
ok('6d. p2p main list → fmtPrice', APP.includes('<span style="color:#dc2626;font-weight:700;font-size:14px">${window.fmtPrice(it.price)}</span>'))
ok('6e. app-listings min_price → fmtPrice', LIST.includes('${window.fmtPrice(it.min_price)}'))
ok('6f. app-listings offer price → fmtPrice', LIST.includes('font-size:16px">${window.fmtPrice(o.price)}</div>'))
ok('6g. NEG: no round-2 raw WAZ left', !APP.includes("${Number(l.price).toFixed(0)} WAZ") && !APP.includes('${Number(o.price).toFixed(0)} WAZ') && !LIST.includes('${Number(it.min_price).toFixed(2)} <span') && !LIST.includes('${Number(o.price).toFixed(2)} <span'))

// 5. PRESERVED — order totals / escrow / wallet stay WAZ (pending decision / honesty)
ok('5a. order-detail total still WAZ (usdHint, PR-1e pending)', APP.includes('usdHint(order.total_amount)'))
ok('5b. escrow "已托管" still WAZ (simulated, not USDC custody)', /已托管/.test(APP))

if (fail > 0) { console.error(`\n❌ fx price listings FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx price listings: secondhand / skill / group-buy / p2p / leaderboard prices → USDC (fmtPrice); order-totals/escrow stay WAZ\n  ✅ pass ${pass}`)
