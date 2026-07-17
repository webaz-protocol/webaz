#!/usr/bin/env tsx
/**
 * RFC-025 PR-5b — agent-buy auto_buy 退役(D-1)。用法:npm run test:agent-buy-retired
 *
 * 真实 route 挂载(anthropic 注入固定推荐 —— 外部 LLM 非被测组件;钱路代码已物理删除)。
 * 覆盖:auto_buy=true → 410 AUTO_BUY_RETIRED + 推荐保留 + 零经济变化;auto_buy=false 比价照常
 * (auto_bought 恒 false);源守卫:文件不再含扣款/建单代码。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-ab-'))
const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentBuyRoutes } = await import('../src/pwa/routes/agent-buy.js')
const { initUserModerationSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db)
const { initReputationSchema } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
initReputationSchema(db)
db.exec('CREATE TABLE IF NOT EXISTS price_sessions (token TEXT PRIMARY KEY, product_id TEXT, user_id TEXT, price REAL, quantity INTEGER DEFAULT 1, created_at TEXT, expires_at TEXT, used_at TEXT)')
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('seller1','S','seller','k_s')").run()
db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES ('buyer1',500,0,0,0)").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES ('prd_s','seller1','Simple Stand','d',30,'WAZ',20,'x','active')").run()

const auth = (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; const row = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined : undefined; if (!row) { res.status(401).json({ error: 'login' }); return null } return row }
// 固定推荐(LLM 非被测组件):两跳都返回可解析 JSON
const fakeMsg = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })
let call = 0
let fetchCount = 0
const anthropic = { messages: { create: async () => (++call % 2 === 1
  ? fakeMsg({ title: 'Stand', price_cny: 100, category: 'x', search_terms: ['stand'] })
  : fakeMsg({ recommendation: 'buy_webaz', best_product_id: 'prd_s', reason: 'cheaper', savings_note: null })) } }
const app = express(); app.use(express.json())
registerAgentBuyRoutes(app, {
  db, auth, generateId,
  safeFetch: async () => { fetchCount++; return { text: async () => '<html>fake product page</html>' } },
  rateLimitOk: () => true, anthropic, AnthropicCtor: function () { return anthropic } as never,
  formatProductForAgent: (r: Record<string, unknown>) => ({ agent_summary: String(r.title), specs: {} }),
  checkStockAndMaybeDelist: () => {}, addHours: (d: Date, h: number) => new Date(d.getTime() + h * 3600_000).toISOString(),
  transition: () => ({ success: true }), notifyTransition: () => {}, shouldAutoAccept: () => false,
} as never)
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
const hit = async (body: Record<string, unknown>) => {
  const resp = await fetch(`http://127.0.0.1:${port}/api/agent-buy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-uid': 'buyer1' }, body: JSON.stringify(body) })
  const txt = await resp.text()
  let json: Record<string, unknown>
  try { json = JSON.parse(txt) as Record<string, unknown> } catch { json = { _raw: txt.slice(0, 200), _status: resp.status } }
  return { status: resp.status, json }
}
const econ = () => JSON.stringify({ o: db.prepare('SELECT COUNT(*) c FROM orders').get(), w: db.prepare("SELECT balance,escrowed FROM wallets WHERE user_id='buyer1'").get(), s: db.prepare("SELECT stock FROM products WHERE id='prd_s'").get(), ps: db.prepare('SELECT COUNT(*) c FROM price_sessions').get(), ev: db.prepare('SELECT COUNT(*) c FROM order_state_history').get() })

const before = econ()
try {
  { const llmBefore = call; const fetchBefore = fetchCount
    const r = await hit({ source_url: 'https://example.com/x', shipping_address: 'X addr', auto_buy: true })
    ok('R-1 auto_buy=true → 410 AUTO_BUY_RETIRED (EARLY: before any fetch/LLM call)', r.status === 410 && r.json.error_code === 'AUTO_BUY_RETIRED', JSON.stringify(r.json).slice(0, 250))
    ok('R-2 no fetch NOR LLM call wasted on a retired request', call === llmBefore && fetchCount === fetchBefore)
    ok('R-3 next_steps point to the Passkey chain', JSON.stringify(r.json.next_steps ?? []).includes('webaz_quote_order'))
    ok('R-4 ZERO economic change (no order, no debit, no stock move)', econ() === before, econ()) }
  { const r = await hit({ source_url: 'https://example.com/x', auto_buy: true })   // Codex M:无地址也必须 410(旧地址守卫已删)
    ok('R-4b auto_buy=true WITHOUT address → still 410 (obsolete address guard removed)', r.status === 410 && r.json.error_code === 'AUTO_BUY_RETIRED', JSON.stringify(r.json).slice(0, 150)) }
  { const r = await hit({ source_url: 'https://example.com/x', auto_buy: false })
    ok('R-5 compare path (auto_buy=false) unchanged — 200 + auto_bought:false', r.status === 200 && r.json.auto_bought === false && r.json.order_id === null, JSON.stringify(r.json).slice(0, 250))
    ok('R-6 still zero economic change', econ() === before) }
  const SRC = readFileSync('src/pwa/routes/agent-buy.ts', 'utf8')
  ok('G-1 money-path code physically removed (no wallet debit / order INSERT / stock CAS / price-session write / transition call left)', !/UPDATE wallets SET balance/.test(SRC) && !/INSERT INTO orders/.test(SRC) && !/UPDATE products SET stock/.test(SRC) && !/INSERT INTO price_sessions/.test(SRC) && !/transition\(db/.test(SRC))
  ok('G-2 auto_bought hardwired false in the response', /auto_bought: false/.test(SRC))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ agent-buy-retired FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent-buy-retired: auto_buy 退役 — 410 结构化拒绝 + 推荐保留 + 零经济变化 + 钱路代码物理删除\n  ✅ pass ${pass}`)
