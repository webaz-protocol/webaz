// RFC-011 §② — endpoint-action classifier 行为等价 + 规约测试。
// 核心:把【重构前的 legacy if-chain 原样复制】与【新的 data-driven endpointToAction】在大批量路径上逐一 diff,
//       证明边界脊梁零行为变化(auth boundary 重构的金标准)。再加正向规约点。
import { readFileSync } from 'node:fs'
import { endpointToAction, endpointToReadAction, capabilityMatrix } from '../src/pwa/endpoint-actions.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++ } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ── legacy 原样复制(server.ts 重构前的 endpointToAction)──────────────────────
function legacy(method: string, path: string): string | null {
  if (method === 'GET') return null
  if (method === 'POST' && path === '/api/orders') return 'place_order'
  if (method === 'POST' && path === '/api/cart/checkout') return 'place_order'
  if (method === 'POST' && /^\/api\/orders\/[^/]+\/pending-accept\/confirm-quote$/.test(path)) return 'place_order'
  if ((method === 'POST' || method === 'PUT') && /^\/api\/products(\/[^/]+)?$/.test(path)) return 'list_product'
  if (method === 'POST' && /^\/api\/orders\/[^/]+\/(accept|ship|deliver|pickup|transit)/.test(path)) return 'fulfill'
  if (method === 'POST' && /^\/api\/orders\/[^/]+\/confirm/.test(path)) return 'confirm_order'
  if (method === 'POST' && /^\/api\/claim-tasks\/[^/]+\/vote/.test(path)) return 'vote'
  if (method === 'POST' && /^\/api\/disputes\/[^/]+\/arbitrate/.test(path)) return 'arbitrate'
  if (method === 'POST' && /^\/api\/disputes\/[^/]+\/respond/.test(path)) return 'dispute_respond'
  if (method === 'POST' && /^\/api\/charity\/fund\/donate/.test(path)) return 'donate'
  if (method === 'POST' && /^\/api\/(wishes|charity)/.test(path)) return 'charity'
  if (method === 'POST' && /^\/api\/shareables/.test(path)) return 'share'
  if (method === 'POST' && /^\/api\/conversations/.test(path)) return 'chat'
  if (method === 'POST' && path === '/api/skills') return 'list_skill'
  if (method === 'POST' && /^\/api\/rfqs/.test(path)) return 'rfq'
  if (method === 'POST' && /^\/api\/auctions\/[^/]+\/bid/.test(path)) return 'bid'
  if (method === 'POST' && /^\/api\/skill-market\/[^/]+\/purchase/.test(path)) return 'purchase'
  if (method === 'POST' && /^\/api\/secondhand\/[^/]+\/order/.test(path)) return 'buy_secondhand'
  if (method === 'POST' && /^\/api\/group-buys\/[^/]+\/join/.test(path)) return 'group_buy_join'
  if (method !== 'GET' && /^\/api\/direct-pay\//.test(path)) return 'direct_pay'   // Direct Pay (Rail 1) RISK scope
  if (method === 'POST' && /^\/api\/reviews\/[^/]+\/[^/]+\/claim$/.test(path)) return 'review_claim'   // Codex #98:质押资金写,上提出 SAFE
  if (method !== 'GET' && (/^\/api\/addresses(\/|$)/.test(path) || path === '/api/profile/default-address')) return 'set_address'
  if (method !== 'GET' && /^\/api\/wallet\//.test(path)) return 'wallet'
  if (method !== 'GET' && /^\/api\/profile\/(bind-email|confirm-email|change-handle|change-name|set-location|clear-location)$/.test(path)) return 'set_profile'
  const SAFE = [
    /^\/api\/(login|register)$/, /^\/api\/recover-key/, /^\/api\/webauthn\//,
    /^\/api\/me\/agents\//,
    /^\/api\/profile\/(switch-role|add-role|region|placement-pref|bind-placement|feed-visible|verify-password|set-password|remove-password)$/,
    /^\/api\/build-feedback/, /^\/api\/build-tasks/, /^\/api\/admin\//,
    /^\/api\/(public-ideas|error-report|mcp-telemetry|email-subscriptions|search-by-link|feedback)(\/|$)/,
    /^\/api\/cart$/, /^\/api\/cart\/(?!checkout)[^/]+$/,
    /^\/api\/wishlist/, /^\/api\/products\/[^/]+\/waitlist$/,
    /^\/api\/notifications\/read$/, /^\/api\/announcements\/[^/]+\/read$/,
    /^\/api\/follows\//, /^\/api\/blocklist\//,
    /^\/api\/checkin$/, /^\/api\/growth\/tasks\//, /^\/api\/tasks\/[^/]+\/claim$/,
    /^\/api\/push\//, /^\/api\/auth\//,
    /^\/api\/me\/(delete-cancel|notify-claim-tasks)/,
    /^\/api\/peers\//, /^\/api\/signaling\//,
    /^\/api\/product-share\/touch$/, /^\/api\/anchor\/[^/]+\/touch$/,
    // Codex #98:reviews 不再整段 SAFE(claim 已上提 review_claim);GET reviews 仍 null(GET 早退)。
  ]
  if (SAFE.some(r => r.test(path))) return null
  return 'write'
}

// ── 大批量路径 × 方法 全 diff ─────────────────────────────────
const paths = [
  // 命名写动作代表路径
  '/api/orders', '/api/products', '/api/products/p1', '/api/orders/o1/accept', '/api/orders/o1/ship',
  '/api/orders/o1/pending-accept/confirm-quote',
  '/api/orders/o1/deliver', '/api/orders/o1/pickup', '/api/orders/o1/transit', '/api/orders/o1/confirm',
  '/api/orders/o1/action', '/api/claim-tasks/c1/vote', '/api/disputes/d1/arbitrate', '/api/disputes/d1/respond',
  '/api/charity/fund/donate', '/api/wishes', '/api/wishes/w1/proof', '/api/charity/x', '/api/shareables',
  '/api/conversations', '/api/conversations/c1/messages', '/api/skills', '/api/skills/s1', '/api/rfqs',
  '/api/rfqs/r1/bids', '/api/auctions/a1/bid', '/api/skill-market/s1/purchase', '/api/secondhand/x1/order',
  '/api/group-buys/g1/join', '/api/direct-pay/orders', '/api/direct-pay/receive/enable',
  // PII / wallet / profile 子集(WRITE 多方法)
  '/api/addresses', '/api/addresses/a1', '/api/profile/default-address', '/api/wallet/withdraw',
  '/api/wallet/connect', '/api/profile/bind-email', '/api/profile/confirm-email', '/api/profile/change-handle',
  '/api/profile/change-name', '/api/profile/set-location', '/api/profile/clear-location',
  // SAFE 代表
  '/api/login', '/api/register', '/api/recover-key/x', '/api/webauthn/begin', '/api/me/agents/k1/scope',
  '/api/profile/switch-role', '/api/profile/region', '/api/profile/set-password', '/api/profile/verify-password',
  '/api/build-feedback', '/api/build-tasks/t1/claim', '/api/admin/disputes', '/api/public-ideas', '/api/feedback',
  '/api/cart', '/api/cart/item1', '/api/cart/checkout', '/api/wishlist/x', '/api/products/p1/waitlist',
  '/api/notifications/read', '/api/announcements/a1/read', '/api/follows/u1', '/api/blocklist/u1', '/api/checkin',
  '/api/growth/tasks/t1', '/api/tasks/t1/claim', '/api/push/subscribe', '/api/auth/x', '/api/me/delete-cancel',
  '/api/peers/p1', '/api/signaling/s1', '/api/product-share/touch', '/api/anchor/c1/touch',
  // Codex #98:reviews — claim 是 review_claim(质押),其余 reviews 写落 'write',GET 一律 null
  '/api/reviews/r1', '/api/reviews/shareable/x/claim', '/api/reviews/recent', '/api/reviews/shareable/x/claims',
  // 默认 'write' 兜底(未映射写)
  '/api/some-new-sensitive-write', '/api/orders/o1/some-future-action', '/api/skill-market/s1/refund',
  '/api/wallet', '/api/profile/avatar', '/api/profile', '/api/products',
  // GET / 边界
  '/api/orders', '/api/search?q=x', '/api/nearby', '/api/users/u1/profile',
]
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
let cmp = 0
for (const p of paths) for (const m of methods) {
  const a = endpointToAction(m, p), b = legacy(m, p)
  expect(`equiv ${m} ${p}`, a === b, { new: a, legacy: b })
  cmp++
}
console.log(`等价 diff:${cmp} (path×method) 组合`)

// ── 正向规约点(防 legacy 本身被误读)──────────────────────────
expect('GET 一律 null', endpointToAction('GET', '/api/wallet/withdraw') === null)
expect('place_order', endpointToAction('POST', '/api/orders') === 'place_order')
expect('products POST→list_product', endpointToAction('POST', '/api/products/p1') === 'list_product')
expect('products PUT→list_product', endpointToAction('PUT', '/api/products/p1') === 'list_product')
expect('wallet DELETE→wallet(WRITE 多方法)', endpointToAction('DELETE', '/api/wallet/x') === 'wallet')
expect('addresses PATCH→set_address', endpointToAction('PATCH', '/api/addresses/a1') === 'set_address')
expect('default-address→set_address(非 set_profile)', endpointToAction('POST', '/api/profile/default-address') === 'set_address')
expect('cart/checkout→place_order', endpointToAction('POST', '/api/cart/checkout') === 'place_order')
expect('confirm shipping quote→place_order', endpointToAction('POST', '/api/orders/o1/pending-accept/confirm-quote') === 'place_order')
expect('未映射写→write(default-deny)', endpointToAction('POST', '/api/some-new-sensitive-write') === 'write')
expect('SAFE login→null', endpointToAction('POST', '/api/login') === null)
// Direct Pay (Rail 1) RISK scope:全部写 → direct_pay(WRITE 多方法);GET 不锁
expect('POST /api/direct-pay/orders → direct_pay', endpointToAction('POST', '/api/direct-pay/orders') === 'direct_pay')
expect('PATCH /api/direct-pay/receive/enable → direct_pay', endpointToAction('PATCH', '/api/direct-pay/receive/enable') === 'direct_pay')
expect('GET /api/direct-pay/orders → null(读不锁)', endpointToAction('GET', '/api/direct-pay/orders') === null)
// Codex #98 P1:review claim(5 WAZ 质押)绝不能落 SAFE —— 必须命中 review_claim;非 claim reviews 写落 default-deny 'write';GET reviews 仍开放。
expect('POST reviews/:type/:id/claim → review_claim(非 null)', endpointToAction('POST', '/api/reviews/shareable/x/claim') === 'review_claim')
expect('POST reviews/:type/:id/claim ≠ null(资金写不放行)', endpointToAction('POST', '/api/reviews/shareable/x/claim') !== null)
expect('POST 其余 reviews 写 → write(default-deny)', endpointToAction('POST', '/api/reviews/r1') === 'write')
expect('GET reviews/recent → null(读开放)', endpointToAction('GET', '/api/reviews/recent') === null)
expect('GET reviews/:type/:id/claims → null(读开放)', endpointToAction('GET', '/api/reviews/shareable/x/claims') === null)
expect('GET reviews/:type/:id/claim → null(GET 早退,不锁 scope)', endpointToAction('GET', '/api/reviews/shareable/x/claim') === null)

// ── 读 scope ──
expect('read nearby→search', endpointToReadAction('/api/nearby') === 'search')
expect('read users/x→profile', endpointToReadAction('/api/users/u1/feed') === 'profile')
expect('read 普通→null', endpointToReadAction('/api/products') === null)

// ── capabilityMatrix 自洽 ──
const cm = capabilityMatrix()
expect('matrix 含全部命名 action', cm.write_actions.length === 25, cm.write_actions.length)
expect('matrix 含 direct_pay', cm.write_actions.some(w => w.action === 'direct_pay'))
expect('matrix 含 review_claim', cm.write_actions.some(w => w.action === 'review_claim'))
expect('matrix 有 read_scopes', cm.read_scopes.length === 3)
expect('matrix 带版本双轴', typeof cm.software_version === 'string' && typeof cm.contract_version === 'number')
expect('matrix 每个 write action 的 match 可回放(=exact 或 regex source)', cm.write_actions.every(w => typeof w.match === 'string' && w.match.length > 0))

// 分类器不是孤立文档:生产 middleware 必须消费同一结果并保留未声明/错 scope/通配/真人四个分支。
const serverSource = readFileSync(new URL('../src/pwa/server.ts', import.meta.url), 'utf8')
expect('production middleware consumes endpointToAction', /const action = endpointToAction\(req\.method, req\.path\)/.test(serverSource))
expect('undeclared agent write is denied', /action && declaredActions === null && !riskInfo\.hasPasskey[\s\S]{0,300}AGENT_SCOPE_UNDECLARED/.test(serverSource))
expect('wrong declared scope denied while wildcard remains explicit', /!declaredActions\.includes\('\*'\) && !declaredActions\.includes\(scopeToken\)[\s\S]{0,300}AGENT_SCOPE_DENIED/.test(serverSource))
expect('Passkey human exception remains explicit', /!riskInfo\.hasPasskey/.test(serverSource))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
