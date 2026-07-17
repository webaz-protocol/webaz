#!/usr/bin/env tsx
/**
 * OAuth grant bearer (oat_) vs 全局 agent 问责中间件 — 回归锁(生产实锤 bug)。
 * 用法:npm run test:oat-scope-gate
 *
 * Bug:server.ts 全局写问责门只豁免 gtk_,没豁免 oat_(RFC-023 后加的 grant 凭证),导致 OAuth 下
 *   所有 /api/agent/* POST(quote/draft create/submit/discover)在到达 requireAgentGrantScope 之前
 *   被 403 AGENT_SCOPE_UNDECLARED 拦死;GET(list)恰好放行 → 造成"list 能用,quote 不能"假象。
 *
 * 中间件次序只存在于【真实 server.ts boot】里,ephemeral app 测不到 —— 本套件 spawn 真服务器黑盒打。
 * 同时锁死安全边界不因修复而扩权:oat_ 打非 grant 路由(POST /api/orders)仍 401,api_key 通道的
 *   default-deny 问责门原样保留。
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-oat-'))
const PORT = 3000 + Math.floor(Math.random() * 30000)
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const child = spawn('node_modules/.bin/tsx', ['src/pwa/server.ts'], {
  env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, PORT: String(PORT), WEBAZ_OAUTH: '1' },
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
})
let stderrTail = ''
child.stderr.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-2000) })
const stopChild = async (): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.stderr.destroy()
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      child.stderr.destroy()
      resolve()
    })
  })
}

const ready = async (): Promise<void> => {
  const deadline = Date.now() + 90_000
  for (;;) {
    try { const r = await fetch(`${BASE}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return } catch { /* boot 中 */ }
    if (Date.now() > deadline) throw new Error(`server did not boot in 90s\nstderr tail:\n${stderrTail}`)
    await new Promise(r => setTimeout(r, 500))
  }
}

const call = async (method: string, path: string, bearer: string | null, body?: unknown): Promise<{ status: number; j: Record<string, unknown> }> => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  let j: Record<string, unknown> = {}
  try { j = await r.json() as Record<string, unknown> } catch { /* non-JSON */ }
  return { status: r.status, j }
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const AUD = 'https://webaz.xyz/mcp'
const OAT_FULL = 'oat_test_full_scope_bearer'
const OAT_READ = 'oat_test_read_only_bearer'
const CAPS_FULL = ['buyer_orders_read_minimal', 'buyer_discover', 'price_quote', 'draft_order', 'order_submit_request', 'order_action_request']
const CAPS_READ = ['buyer_orders_read_minimal']

try {
  await ready()
  // 服务器同一 DB 文件直插 fixture(与生产同构:OAuth 铸的 grant 经 oauth_access_tokens.grant_id 解析)
  const db = new Database(join(tmpHome, '.webaz', 'webaz.db'))
  db.pragma('busy_timeout = 5000')
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('u_oat','Tina2','buyer','k_undeclared_probe')").run()
  const mk = (gid: string, caps: string[], oat: string): void => {
    db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
      .run(gid, 'u_oat', 'OAuth: test', JSON.stringify(caps.map(c => ({ capability: c }))), sha('unused_direct_' + gid), FUTURE)
    db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
      .run(sha(oat), gid, 'cli_test', 'read order:draft list:draft', AUD, FUTURE)
  }
  mk('grt_oat_full', CAPS_FULL, OAT_FULL)
  mk('grt_oat_read', CAPS_READ, OAT_READ)
  const ordersCount = (): number => (db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c
  const ordersBefore = ordersCount()

  // G-1 核心回归:oat_ + price_quote → 穿过中间件 + scope 门,到达业务层(假商品=业务 404)
  const g1 = await call('POST', '/api/agent/quote', OAT_FULL, { product_id: 'prd_nope', quantity: 1 })
  ok('G-1 oat_ with price_quote reaches quote BUSINESS layer (PRODUCT_NOT_FOUND, not AGENT_SCOPE_UNDECLARED)',
    g1.j.error_code === 'PRODUCT_NOT_FOUND', JSON.stringify(g1))
  // G-2 scope 门原样工作:缺 price_quote → 结构化 PERMISSION_REQUIRED
  const g2 = await call('POST', '/api/agent/quote', OAT_READ, { product_id: 'prd_nope', quantity: 1 })
  ok('G-2 oat_ WITHOUT price_quote → PERMISSION_REQUIRED (scope gate intact)', g2.j.error_code === 'PERMISSION_REQUIRED', JSON.stringify(g2))
  // G-3 submit 到达 draft 业务校验(不存在草稿=业务 404)
  const g3 = await call('POST', '/api/agent/order-drafts/odr_nonexistent/submit', OAT_FULL, {})
  ok('G-3 oat_ with order_submit_request reaches draft validation (DRAFT_NOT_FOUND)', g3.j.error_code === 'DRAFT_NOT_FOUND', JSON.stringify(g3))
  // G-4 list 继续正常
  const g4 = await call('GET', '/api/agent/order-drafts', OAT_FULL)
  ok('G-4 draft list keeps working (200 + drafts array)', g4.status === 200 && Array.isArray(g4.j.drafts), JSON.stringify(g4).slice(0, 200))
  // G-5 零扩权:oat_ 打真实下单路由(非 grant 路由)→ auth() 401,绝无订单产生
  const g5 = await call('POST', '/api/orders', OAT_FULL, { product_id: 'prd_nope', quantity: 1 })
  ok('G-5 oat_ on POST /api/orders (real money path) → 401, NOT an order (grant token is not an api_key)',
    g5.status === 401 && g5.j.error_code !== 'AGENT_SCOPE_UNDECLARED', JSON.stringify(g5))
  // G-6 无效 oat_ 到达 grant 层被拒(而不是被中间件吃掉)
  const g6 = await call('POST', '/api/agent/quote', 'oat_unknown_bearer', { product_id: 'prd_nope', quantity: 1 })
  ok('G-6 invalid oat_ → GRANT_NOT_FOUND at the grant layer', g6.j.error_code === 'GRANT_NOT_FOUND', JSON.stringify(g6))
  // G-7 api_key 通道 default-deny 问责门原样保留(无声明+无 Passkey 的 api_key 写仍被拦)
  const g7 = await call('POST', '/api/agent/quote', 'k_undeclared_probe', { product_id: 'prd_nope', quantity: 1 })
  ok('G-7 undeclared api_key (no Passkey) still gets AGENT_SCOPE_UNDECLARED (accountability gate intact)',
    g7.status === 403 && g7.j.error_code === 'AGENT_SCOPE_UNDECLARED', JSON.stringify(g7))
  // G-8 submit 无能力 → scope 门结构化拒绝
  const g8 = await call('POST', '/api/agent/order-drafts/odr_nonexistent/submit', OAT_READ, {})
  ok('G-8 oat_ WITHOUT order_submit_request → PERMISSION_REQUIRED', g8.j.error_code === 'PERMISSION_REQUIRED', JSON.stringify(g8))
  // G-9/G-10 discover:有能力达业务层(诚实 no_candidates/candidates),无能力 scope 门拒
  const g9 = await call('POST', '/api/agent/discover', OAT_FULL, { keywords: ['widget'], category: 'x' })
  ok('G-9 oat_ with buyer_discover reaches discover BUSINESS layer (candidates/no_candidates)',
    g9.status === 200 && (g9.j.no_candidates !== undefined || g9.j.candidates !== undefined), JSON.stringify(g9).slice(0, 200))
  const g10 = await call('POST', '/api/agent/discover', OAT_READ, { keywords: ['widget'] })
  ok('G-10 oat_ WITHOUT buyer_discover → PERMISSION_REQUIRED', g10.j.error_code === 'PERMISSION_REQUIRED', JSON.stringify(g10))
  // G-11/G-12 order_action_request(RFC-021,同样被本 bug 波及):有能力达业务层,无能力 scope 门拒
  const g11 = await call('POST', '/api/agent/orders/ord_nonexistent/action-request', OAT_FULL, { action: 'accept' })
  ok('G-11 oat_ with order_action_request reaches business validation (ORDER_NOT_FOUND)', g11.j.error_code === 'ORDER_NOT_FOUND', JSON.stringify(g11))
  const g12 = await call('POST', '/api/agent/orders/ord_nonexistent/action-request', OAT_READ, { action: 'accept' })
  ok('G-12 oat_ WITHOUT order_action_request → PERMISSION_REQUIRED', g12.j.error_code === 'PERMISSION_REQUIRED', JSON.stringify(g12))
  // G-13 零扩权(资金面):oat_ 打钱包写路由 → 401,非 grant-aware 路由绝不认 grant 凭证
  const g13 = await call('POST', '/api/wallet/withdraw', OAT_FULL, { amount: 1 })
  ok('G-13 oat_ on POST /api/wallet/withdraw → 401 (funds surface unreachable via OAuth)',
    g13.status === 401 && g13.j.error_code !== 'AGENT_SCOPE_UNDECLARED', JSON.stringify(g13))
  // G-14 整个套件零经济写
  ok('G-14 zero orders created across the whole suite', ordersCount() === ordersBefore)
  db.close()
} finally { await stopChild() }

if (fail > 0) { console.error(`\n❌ oat-scope-gate FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ oat-scope-gate: oat_ 委托凭证通道豁免 — quote/submit 达业务层 · scope 门/问责门原样 · 钱路零扩权\n  ✅ pass ${pass}`)
