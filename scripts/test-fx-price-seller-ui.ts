#!/usr/bin/env tsx
/**
 * Seller ordinary-product pricing UI → USDC (display/label only).
 *
 * Scope: ordinary-product publish/edit form price LABELS + seller-dashboard ordinary-product price/stat
 * DISPLAYS. Label-only / display-only — no amount semantics, no DB, no order/wallet/escrow/settlement change.
 * Deliberately-preserved WAZ buckets (escrow/wallet/order totals/auction/RFQ/stake/reward/commission) must
 * NOT be touched.
 *
 * Usage: npm run test:fx-price-seller-ui
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const SELLER = readFileSync('src/pwa/public/app-seller.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. ordinary-product publish/edit form price LABEL → USDC (import / manual-add / edit share the fullwidth key)
ok('1a. i18n key relabeled 价格（USDC）, old 价格（WAZ） removed', I18N.includes("'价格（USDC）': 'Price (USDC)'") && !I18N.includes("'价格（WAZ）'"))
ok('1b. form label calls use t(价格（USDC）) (≥3: import/manual-add/edit)', (APP.match(/\$\{t\('价格（USDC）'\)\}/g) || []).length >= 3)
ok('1c. no ordinary-form t(价格（WAZ）) left', !APP.includes("${t('价格（WAZ）')}"))

// 2. seller-dashboard ordinary-product price/stat DISPLAYS → USDC
ok('2a. renderSeller product price via fmtPrice', APP.includes('<span><strong style="color:#374151">${window.fmtPrice(p.price)}</strong></span>'))
ok('2b. warehouse card price via fmtPrice', APP.includes('${window.fmtPrice(p.price)} · ${t(\'库存\')} ${p.stock}'))
ok('2c. deleted card price via fmtPrice', APP.includes('color:#d1d5db;margin-top:2px">${window.fmtPrice(p.price)}</div>'))
ok('2d. app-seller top-product price via fmtPrice', SELLER.includes('${window.fmtPrice(p.price)}'))
ok('2e. app-seller revenue / GMV tooltip / GMV label / 客单价 → USDC', SELLER.includes('${fmt2(p.revenue)} USDC') && SELLER.includes('.toFixed(0)} USDC · ${d.orders}') && SELLER.includes('GMV (USDC)') && SELLER.includes("${t('客单价')} (USDC)"))
ok('2f. app-seller.js has NO WAZ left', !SELLER.includes('WAZ'))

// 3. PRESERVED — the explicitly-excluded WAZ buckets are untouched (still WAZ)
ok('3a. escrow "已托管" success stays WAZ', /已托管/.test(APP) && APP.includes('WAZ'))
ok('3b. wallet balance stays WAZ', APP.includes('${fmtWaz(w.balance)} WAZ'))
ok('3c. order total stays WAZ', APP.includes('${order.total_amount} WAZ'))
ok('3d. auction current price stays WAZ', APP.includes('${it.current_price} WAZ'))
ok('3e. cart line stays WAZ (pending order-total decision)', APP.includes('${it.price} WAZ × ${it.qty}'))
ok('3f. buyer product prices still USDC (did not regress #167-169)', APP.includes('window.fmtPrice(livePrice)'))

if (fail > 0) { console.error(`\n❌ fx price seller-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx price seller-ui: ordinary-product form labels + seller-dashboard prices/stats → USDC; excluded WAZ buckets preserved\n  ✅ pass ${pass}`)
