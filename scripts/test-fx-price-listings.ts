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
const PROF = readFileSync('src/pwa/public/app-profile.js', 'utf8')

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

// 7. review round-3 sites (P2P DETAIL page price + buy button; regular products leaderboard branch)
ok('7a. p2p detail main price → fmtPrice', APP.includes('font-size:22px;margin-bottom:6px">${window.fmtPrice(p.price)}</div>'))
ok('7b. p2p detail buy button → fmtPrice', APP.includes("${t('购买')} ${window.fmtPrice(p.price)}</button>"))
ok('7c. leaderboard regular products branch → fmtPrice', APP.includes("|| '?')} · ${window.fmtPrice(p.price)} ·"))
ok('7d. NEG: no p2p "${p.price} WAZ" / products "${p.price} WAZ ·" left', !APP.includes('font-size:22px;margin-bottom:6px">${p.price} <span') && !APP.includes("${t('购买')} ${p.price} WAZ") && !APP.includes('|| \'?\')} · ${p.price} WAZ ·'))

// 8. proactive sweep — remaining buyer-facing PRODUCT prices (agent-buy/智能下单 results, share-gift, group-buy final)
ok('8a. agent-buy 最佳替代 → fmtPrice', APP.includes('· <strong>${window.fmtPrice(res.best_product.price)}</strong></span>'))
ok('8b. agent-buy best product → fmtPrice', APP.includes('margin-bottom:4px">${window.fmtPrice(res.best_product.price)}</div>'))
ok('8c. agent-buy alt product → fmtPrice', APP.includes('margin-left:8px">${window.fmtPrice(p.price)}</div>'))
ok('8d. share-gift target price → fmtPrice', APP.includes('· ${window.fmtPrice(tgt.price)} <span'))
ok('8e. group-buy final price → fmtPrice', APP.includes('color:#16a34a">${window.fmtPrice(final)}</div>'))
ok('8f. NEG: those agent-buy/share/group-buy raw WAZ gone', !APP.includes('${res.best_product.price} WAZ') && !APP.includes('${tgt.price} WAZ') && !APP.includes('color:#16a34a">${final} WAZ'))
ok('8g. group-buy split-span final price → fmtPrice', APP.includes('<span style="color:#16a34a;font-weight:700">${window.fmtPrice(final)}</span>') && !APP.includes('font-weight:700">${final}</span> WAZ'))
// NOTE (explicitly still WAZ — separate buckets, not buyer product prices): cart line + totals (pending
// order-totals decision), seller-dashboard product mgmt, admin views, auction bids, escrow/wallet.

// 9. round-4 sweep — public profile / note / notification / group-buy detail / follow-sell offers
ok('9a. profile secondhand + products + hot + nearby → fmtPrice (≥4)', (PROF.match(/window\.fmtPrice\(/g) || []).length >= 4)
ok('9b. profile no ${s.price}/${p.price} WAZ left in those cards', !PROF.includes('color:#dc2626;margin-top:2px">${s.price} WAZ') && !PROF.includes('color:#1f2937;margin-top:2px">${p.price} WAZ') && !PROF.includes('${p.price} WAZ · 🔥'))
ok('9c. note-linked product CTA → fmtPrice', APP.includes('${window.fmtPrice(product.price || 0)}</div>'))
ok('9d. notification product → fmtPrice', APP.includes('· ${window.fmtPrice(n.product.price)}</div>'))
ok('9e. group-buy detail: final=fmtPrice, strikethrough original=USDC (no WAZ)', APP.includes('text-decoration:line-through">${r.original_price} USDC</div>') && !APP.includes('text-decoration:line-through">${r.original_price} WAZ'))
ok('9f. group-buy join button prepay → fmtPrice', APP.includes("${t('加入团购')} (${window.fmtPrice(r.original_price)} ${t('预付')})"))
ok('9g. auctions-feed secondhand (d.price + condition) → fmtPrice', APP.includes('${window.fmtPrice(d.price)} · ${d.condition_grade'))
ok('9h. follow-sell offers (我的报价 / 全网最低) → fmtPrice', LIST.includes('${window.fmtPrice(myMin)}') && LIST.includes('${window.fmtPrice(globalMin)}'))
// NOTE still WAZ (documented buckets): cart+order totals (pending), seller-dashboard (warehouse/deleted/
// app-seller), admin, auction bids/current, RFQ budgets/bids, wallet/stake/commission/reward/refund/GMV/
// withdraw/deposit/charity/escrow ("已托管" — USDC there would imply real custody).

// 10. round-5 exhaustive sweep — reviews feed, secondhand buy modal, buy price-changed toast, buyer trials, price-history
ok('10a. reviews feed product (s.product_price) → fmtPrice', APP.includes('· ${window.fmtPrice(s.product_price)}</div>'))
ok('10b. secondhand buy modal price → fmtPrice', APP.includes('margin-bottom:14px">${window.fmtPrice(price)}</div>'))
ok('10c. buy "价格已变动" toast → fmtPrice (old + new)', APP.includes('${window.fmtPrice(res.old_price)} → ${window.fmtPrice(res.new_price)}'))
ok('10d. buyer trials product_price → fmtPrice', APP.includes('${window.fmtPrice(c.product_price)} · ${fmtTime(c.claimed_at)}') && APP.includes("${window.fmtPrice(c.product_price)} · ${t('阈值')}"))
ok('10e. price-history widget unit relabeled USDC (not WAZ)', APP.includes('${fmtPrice(data.volume)} USDC') && APP.includes('${fmtPrice(r.category_avg_30d)} USDC'))
ok('10f. NEG: those round-5 raw WAZ patterns gone', !APP.includes('${s.product_price} WAZ') && !APP.includes('margin-bottom:14px">${price.toFixed(2)} WAZ') && !APP.includes('${c.product_price} WAZ') && !APP.includes('${fmtPrice(r.category_avg_30d)} WAZ'))
ok('10g. secondhand-market filter label is USDC, not WAZ', APP.includes("${t('价格区间 (USDC)')}") && !APP.includes("${t('价格区间 (WAZ)')}"))

// 5. order totals → USDC (PR-1d done, orderAmountHtml); escrow / wallet stay WAZ (honesty)
ok('5a. order-detail total → orderAmountHtml (USDC), usdHint gone', APP.includes('${window.orderAmountHtml(order)}') && !APP.includes('usdHint(order.total_amount)'))
ok('5b. escrow "已托管" still WAZ (simulated, not USDC custody)', /已托管/.test(APP))

if (fail > 0) { console.error(`\n❌ fx price listings FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx price listings: secondhand / skill / group-buy / p2p / leaderboard prices → USDC (fmtPrice); order-totals/escrow stay WAZ\n  ✅ pass ${pass}`)
