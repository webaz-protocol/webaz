/**
 * RFC-011 §① 目标索引 —— intent → 怎么做:能力 action(②)+ REST endpoint + MCP 工具 + PWA 页。
 *
 * 泛化自 MCP `webaz_info.search_routing`(#1072,zh/搜索/MCP-only)→ 协议级、非 MCP 集成方也能自路由。
 *
 * doc=code 防漂移锁(关键):每条目标的 `action` 要么是 `open`(开放读),要么必须是
 * capability matrix(②)里真实存在的 token —— write_action 或 read_scope。
 * `assertGoalActionsValid()` + tests/test-goal-index.ts 守门:引用不存在的能力 = 测试红。
 * 这样 goal-index 永远和 enforced 边界一致,不会指向幽灵能力。
 */
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'
import { capabilityMatrix } from './endpoint-actions.js'

export interface Goal {
  goal: string            // 意图(EN-first,agent 易 grep)
  when: string            // 何时用 / 边界(避免误路由)
  action: string          // 'open'(开放读) | read_scope | write_action token —— 必须在 ② 里真实存在
  endpoint: string        // 真实 REST 入口
  mcp_tool: string | null // 对应 MCP 工具(无则 null,引导 PWA)
  pwa: string             // PWA 页锚点
  see?: string            // 跨维度引用(契约自洽)
  notes?: string
}

const GOALS: Goal[] = [
  // ── discover / buy ──
  { goal: 'Find a specific product by title/SKU/exact desc', when: 'buyer knows what they want (strict match)', action: 'open', endpoint: 'GET /api/products?q=...', mcp_tool: 'webaz_search', pwa: '#buy', see: '② read scope "search"', notes: 'protocol-level STRICT alias match (mode=agent), no fuzzy fallback; 0 hits → guide user to #discover (fuzzy is a human action, not agent-automated).' },
  { goal: 'Match a pasted external link (taobao/douyin/xhs/jd/...)', when: 'buyer pastes an off-site product URL or share text', action: 'open', endpoint: 'POST /api/search-by-link', mcp_tool: 'webaz_search', pwa: '#buy', notes: 'body: { text } (raw paste of share text/URL) OR { external_link: { platform, external_id, external_title, canonical_url } }. Matches the anchor registry product fingerprint.' },
  { goal: "Browse what's popular near me / same city", when: 'geo discovery, no keyword', action: 'search', endpoint: 'GET /api/nearby', mcp_tool: 'webaz_nearby', pwa: '#nearby', see: '② read scope "search"', notes: 'k-anonymity ≥3.' },
  { goal: 'Find used / pre-owned / secondhand items', when: 'pre-owned, separate space from new catalog', action: 'open', endpoint: 'GET /api/secondhand', mcp_tool: 'webaz_secondhand', pwa: '#secondhand', notes: 'webaz_search does NOT return secondhand.' },
  { goal: 'Verify a price before buying', when: 'BEFORE every purchase', action: 'open', endpoint: 'GET /api/products/:id (+ verify)', mcp_tool: 'webaz_verify_price', pwa: '#buy', notes: 'defeats flash-sale/hidden-fee race; protocol only liable for the verified T0 price.' },
  { goal: 'Place an order (buy a catalog product)', when: 'buyer commits to purchase', action: 'place_order', endpoint: 'POST /api/orders', mcp_tool: 'webaz_place_order', pwa: '#buy', see: '① entity order · ⑧ value flow', notes: 'pass expected_price (T0 guard, 409 on drift).' },
  { goal: 'Buy a secondhand item', when: 'order a pre-owned listing', action: 'buy_secondhand', endpoint: 'POST /api/secondhand/:id/order', mcp_tool: 'webaz_secondhand', pwa: '#secondhand' },
  { goal: 'Buy a knowledge skill', when: 'purchase a prompt/template/checklist', action: 'purchase', endpoint: 'POST /api/skill-market/:id/purchase', mcp_tool: 'webaz_skill_market', pwa: '#skill-market', notes: 'content market — distinct from webaz_skill behavior plugins.' },
  { goal: 'Bid in an auction', when: 'time-windowed price discovery on listed item', action: 'bid', endpoint: 'POST /api/auctions/:id/bids', mcp_tool: 'webaz_bid', pwa: '#auctions', notes: 'anti-snipe time extension.' },
  { goal: 'Post a buy request (RFQ) for sellers to quote', when: 'no good match / bulk / custom / wants competing quotes', action: 'rfq', endpoint: 'POST /api/rfqs', mcp_tool: 'webaz_rfq', pwa: '#rfqs', notes: 'reverse match — buyer posts need + 1% stake.' },
  // ── sell / fulfill ──
  { goal: 'List / update a product', when: 'seller publishes, edits, delists own listing', action: 'list_product', endpoint: 'POST /api/products · PUT /api/products/:id', mcp_tool: 'webaz_list_product', pwa: '#me', see: '① entity product', notes: 'POST creates, PUT /:id edits/delists. System suggests stake ~15% of price (buyer protection).' },
  { goal: 'Fulfill an order (accept / ship / deliver / pickup)', when: 'seller or logistics advances fulfilment', action: 'fulfill', endpoint: 'POST /api/orders/:id/action', mcp_tool: 'webaz_update_order', pwa: '#me', see: '① order lifecycle · ⑦ liability', notes: 'single state-machine endpoint; body { action } ∈ {accept|ship|pickup|transit|deliver|confirm|dispute}. Missing a deadline → auto fault.' },
  { goal: 'Confirm receipt (buyer closes the order)', when: 'buyer received the goods', action: 'confirm_order', endpoint: 'POST /api/orders/:id/action', mcp_tool: 'webaz_update_order', pwa: '#me', notes: 'body { action: "confirm" }. Auto-confirm on confirm_deadline timeout.' },
  // ── dispute / verify ──
  { goal: 'Respond to a dispute as a party', when: 'a counterparty opened a dispute on your order', action: 'dispute_respond', endpoint: 'POST /api/disputes/:id/respond', mcp_tool: 'webaz_dispute', pwa: '#me', see: '① entity dispute · ⑦ liability' },
  { goal: 'Look up public dispute precedents', when: 'assess a seller / understand likely ruling', action: 'open', endpoint: 'GET /api/disputes/cases (+ /by-product/:id)', mcp_tool: 'webaz_dispute', pwa: '#disputes', see: '① entity dispute', notes: 'redacted post-ruling cases; amount is bucketed.' },
  { goal: 'Verify an agent passport / external anchor / AP2 mandate', when: 'check a counterparty/data is genuine', action: 'open', endpoint: 'GET /.well-known/webaz-verifiability.json', mcp_tool: null, pwa: '(n/a)', see: '⑤ verifiability index', notes: 'offline-verifiable where signed; order-chain is integrity-only.' },
  // ── participate / social ──
  { goal: 'Become a value participant (earn/pay/stake)', when: 'integrate as seller/logistics/verifier/insurer/etc.', action: 'open', endpoint: 'GET /.well-known/webaz-economic.json', mcp_tool: null, pwa: '(n/a)', see: '⑧ economic participation', notes: 'roles + live rates + collateral + conserved liability.' },
  { goal: 'Communicate with a trade counterparty', when: 'ask seller a question / coordinate an order', action: 'chat', endpoint: 'POST /api/conversations/start', mcp_tool: 'webaz_chat', pwa: '#messages', notes: 'start a thread; then POST /api/conversations/:id/messages. Every message attaches to a trade context — not general LLM chat.' },
  { goal: 'Share / refer a product for commission', when: 'promote a listing; attributed sales pay commission', action: 'share', endpoint: 'POST /api/shareables', mcp_tool: 'webaz_shareables', pwa: '#me', see: '⑧ promoter role' },
  { goal: 'Publish or fund a charity wish / community fund', when: 'community mutual-aid', action: 'charity', endpoint: 'POST /api/wishes', mcp_tool: 'webaz_charity', pwa: '#charity', notes: 'publish a wish; fund the shared pool via POST /api/charity/fund/donate. Distinct from place_order donation_pct.' },
  { goal: 'Donate to the community fund', when: 'contribute to the shared fund', action: 'donate', endpoint: 'POST /api/charity/fund/donate', mcp_tool: 'webaz_charity', pwa: '#charity' },
  // ── self state ──
  { goal: 'Set a shipping address (PII write)', when: 'before a shipped order', action: 'set_address', endpoint: 'POST /api/addresses', mcp_tool: 'webaz_default_address', pwa: '#me', see: '② write_action set_address (元规则#3 PII gate)' },
]

/** doc=code 锁:返回非法引用(action 既非 'open' 也不在 ② capability matrix token 集)的目标,空数组=自洽。 */
export function invalidGoalActions(): Array<{ goal: string; action: string }> {
  const m = capabilityMatrix()
  const valid = new Set<string>(['open'])
  for (const w of m.write_actions) valid.add(w.action)
  for (const r of m.read_scopes) valid.add(r.scope)
  return GOALS.filter(g => !valid.has(g.action)).map(g => ({ goal: g.goal, action: g.action }))
}

export function buildGoalIndex() {
  return {
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    note: 'RFC-011 §① goal index — maps an integrator agent\'s INTENT to the capability action (§②), the REST endpoint, the MCP tool, and the PWA page, so a (non-MCP) agent can self-route from goal to action. Each goal.action is "open" (public read) or a real token from the capability matrix (§② /.well-known/webaz-capabilities.json) — validated by tests/test-goal-index.ts (doc=code, no phantom capabilities). To exercise a write action, declare its scope per docs/INTEGRATOR.md (§③).',
    capability_matrix: 'https://webaz.xyz/.well-known/webaz-capabilities.json',
    goals: GOALS,
  }
}
