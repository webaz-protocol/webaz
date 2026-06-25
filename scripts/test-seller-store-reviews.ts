#!/usr/bin/env tsx
/**
 * seller store reviews — consolidated view + per-review reply (static source contract).
 *   用法:npm run test:seller-store-reviews
 *
 * 卖家在销售分析页(#analytics)一处看全部店铺评价并逐条回应。读 authed GET /sellers/me/ratings
 * (含 order_id + 未回应计数),回应复用既有 POST /orders/:order_id/rating/reply(卖家一回一限)。
 * 纯只读 + 复用 endpoint,不改评价 / 资金逻辑。
 */
import { readFileSync } from 'node:fs'
// app.js + app-seller.js: renderSellerAnalytics + hydrateSellerReviews moved to
// app-seller.js (classic split, slice K). app.js is concatenated first so the
// submitSellerReviewReply assertion still resolves in the app.js portion.
const app = readFileSync('src/pwa/public/app.js', 'utf8')
  + '\n' + readFileSync('src/pwa/public/app-seller.js', 'utf8')
const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')
const ratings = readFileSync('src/pwa/routes/ratings.ts', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// 1) 后端:authed GET /sellers/me/ratings — 本人评价 + order_id + 未回应计数
ok('backend: GET /api/sellers/me/ratings exists', /app\.get\('\/api\/sellers\/me\/ratings'/.test(ratings))
const meEp = ratings.slice(ratings.indexOf("/api/sellers/me/ratings"), ratings.indexOf("/api/sellers/me/ratings") + 1700)
ok('me-ratings is auth-gated', /const user = auth\(req, res\); if \(!user\) return/.test(meEp))
ok('me-ratings filters to the seller themselves', /WHERE r\.seller_id = \?[\s\S]{0,80}\[user\.id/.test(meEp))
ok('me-ratings returns order_id (needed to reply)', /SELECT r\.order_id/.test(meEp))
ok('me-ratings returns an unreplied count', /unreplied/.test(meEp))

// 2) PWA:销售分析页有店铺评价区 + 水合
ok('analytics page has a store-reviews area', /id="seller-reviews-area"/.test(app))
ok('renderSellerAnalytics hydrates reviews', /hydrateSellerReviews\(\)/.test(app))
const hyd = app.slice(app.indexOf('async function hydrateSellerReviews'), app.indexOf('async function hydrateSellerReviews') + 4200)
ok('hydrate fetches /sellers/me/ratings', /GET\('\/sellers\/me\/ratings/.test(hyd))
ok('reply input only when not yet replied (it.reply ternary → rev-reply box)', /it\.reply \?/.test(hyd) && /rev-reply-\$\{it\.order_id\}/.test(hyd))
ok('replied reviews show the existing reply (read-only)', /你的回应/.test(hyd))
// double-blind: masked rows render without stars/comment + reply box
ok('hydrate has a masked branch (it.masked)', /it\.masked \?/.test(hyd))
ok('masked branch shows the double-blind notice', /评价双盲遮蔽中/.test(hyd))

// 3) 回应复用既有一回一 endpoint,按 order_id
ok('submitSellerReviewReply POSTs to /orders/:order_id/rating/reply', /submitSellerReviewReply = async \(orderId\)[\s\S]{0,500}POST\(`\/orders\/\$\{orderId\}\/rating\/reply`/.test(app))

// 4) i18n parity
for (const k of ['店铺评价', '你的回应', '回应不能为空', '条评价待回应', '回应这条评价（最多 500 字 · 仅一次）']) {
  ok(`i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
}

if (fail === 0) {
  console.log(`\n✅ seller store reviews: #analytics 汇总全部评价 + 逐条回应(未回应才显示输入框);authed /sellers/me/ratings(含 order_id+未回应数);回应复用一回一 endpoint;i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ seller store reviews FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
