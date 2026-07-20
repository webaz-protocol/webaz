#!/usr/bin/env tsx
/**
 * MCP UI PR-5 — QuoteAndApproval:消费者投影(USDC+法币估算)+ 组件 + 诚信文案 + 重复购买保护。
 *   用法:npm run test:mcp-quote-approval-ui
 *
 * 验收映射(任务书 §四 20 项):USDC 主价(1)/SGD 估算算术(2)/stale 警示(3)/汇率缺失仍 USDC 不伪造法币(4,USD 区省略)/
 * 消费者面零 WAZ(5)/模拟托管标记(6)/直付非托管说明(7)/无默认地址安全失败(8)/报价不扣款不锁库存(9,10)/
 * 草稿不扣款(11)/提交不执行(12)/Passkey 唯一订单+重批同单(13,14 → 委托 test-order-submit-approve 47 项深锁,此处锁投影面)/
 * 相似审批警告(15)/文本降级(16)/CSP(17)/domain(18)/Token 预算(19)/零 PII(20)。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-qa-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY
process.env.FX_RATES_URL = 'http://127.0.0.1:1/unreachable'   // 强制 fx 走静态兜底(stale:true)→ 锁 stale 警示路径

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { FALLBACK_USD_RATES } = await import('../src/fx-rates.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const PII = /SECRET|Jane|91234567|1 Test St|#05-01|default_address|shipping_address/i

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }
const FULL_ADDR = 'Jane SECRET / 1 Test St #05-01 / Singapore SG / +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','holden_b','buyer','k_b',?,'SG')").run(FULL_ADDR)
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer_us','U','us_b','buyer','k_us','9 US Ave','US')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer_noaddr','N','buyer','k_n'),('seller1','S','seller','k_s')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,shipping_template,has_variants,return_days,warranty_days,handling_hours)
  VALUES ('prd_q','seller1','QA Stand','d',11.5,'WAZ',9,'phone_stand','active',?,0,7,90,72)`).run(JSON.stringify([{ region: 'SG', fee: 0, est_days: '10-14' }]))
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,shipping_template,has_variants,return_days,warranty_days,handling_hours)
  VALUES ('prd_us','seller1','US Stand','d',5,'WAZ',9,'phone_stand','active',?,0,7,0,24)`).run(JSON.stringify([{ region: 'US', fee: 0, est_days: '5-9' }]))

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as {
  buildMcpServer: () => { connect: (t: unknown) => Promise<void> }
  handleQuoteOrder: (a: Record<string, unknown>) => Promise<Record<string, unknown>>
  handleOrderDraft: (a: Record<string, unknown>) => Promise<Record<string, unknown>>
  handleSubmitOrderRequest: (a: Record<string, unknown>) => Promise<Record<string, unknown>>
}
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const webazDir = join(tmpHome, '.webaz')
const CAPS = ['price_quote', 'draft_order', 'order_submit_request']
const useCred = (grantId: string, humanId: string, bearer: string): void => {
  try { db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'QA', JSON.stringify(CAPS.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString()) } catch { /* exists */ }
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: CAPS.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
useCred('grt_qa', 'buyer1', 'gtk_qa')

const { Client: C2 } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport: T2 } = await import('@modelcontextprotocol/sdk/inMemory.js')
const [ct0, st0] = T2.createLinkedPair()
await mcp.buildMcpServer().connect(st0)
const wire = new C2({ name: 'qa-wire', version: '0' }, { capabilities: {} })
await wire.connect(ct0)
// 投影在 wrapper 层(structuredContent)—— 所有消费者面断言走 wire;handler 保持协议契约由存量套件锁
const callSC = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await wire.callTool({ name, arguments: args }) as Record<string, unknown>
  return (r.structuredContent ?? {}) as Record<string, unknown>
}

const walletSnap = () => JSON.stringify(db.prepare('SELECT * FROM wallets ORDER BY user_id').all())
const stockOf = () => (db.prepare("SELECT stock FROM products WHERE id='prd_q'").get() as { stock: number }).stock
const before = { wallet: walletSnap(), stock: stockOf() }

try {
  // ── Quote 投影(1,2,3,5,6,9,10,19,20)──
  const q = await callSC('webaz_quote_order', { product_id: 'prd_q', quantity: 1 })
  const qj = JSON.stringify(q)
  const price = (q.price ?? {}) as Record<string, unknown>
  const fe = (q.fiat_estimate ?? {}) as Record<string, unknown>
  ok('1. USDC 主价 (11.50 USDC, amount_minor 整数)', price.currency === 'USDC' && price.amount_minor === 11_500_000 && price.display === '11.50 USDC', qj.slice(0, 160))
  const expSgd = (11_500_000 / 1_000_000 * FALLBACK_USD_RATES.SGD).toFixed(2)
  ok('2. SGD 估算算术正确 (dest SG → S$, ≈ 前缀, estimated:true)', fe.currency === 'SGD' && fe.display === `≈ S$${expSgd}` && fe.estimated === true, JSON.stringify(fe))
  ok('3. stale FX 明显警示(强制兜底汇率 → stale:true + 近似文案)', fe.stale === true && /近似/.test(String(fe.note)), JSON.stringify(fe).slice(0, 150))
  ok('5. 消费者投影零 WAZ', !qj.includes(' WAZ') && !qj.includes('"WAZ"'))
  ok('6. 模拟托管诚信标记(不代表真实 USDC/法币结算)', /模拟托管测试/.test(String(q.rail_note)) && /不代表真实/.test(String(q.rail_note)))
  ok('9/10. 报价不扣款不锁库存(标志 + DB 零变化)', q.stock_reserved === false && q.economic_action_executed === false && walletSnap() === before.wallet && stockOf() === before.stock)
  ok('19a. Quote 投影 ≤1400B(≈350 tok)', qj.length <= 1400, `bytes=${qj.length}`)
  ok('20a. Quote 零 PII', !PII.test(qj))
  const am = (q.amounts ?? {}) as Record<string, number>
  ok('Q-line. amounts 对账(item=11.5M/shipping=0/other=payable-item-shipping)+ 配送/条款面齐备',
    am.item === 11_500_000 && am.shipping === 0 && am.other === Number((q.price as Record<string, unknown>).amount_minor) - am.item - am.shipping
    && !!(q.destination as Record<string, unknown>)?.summary && !!q.shipping && q.return_days === 7 && !!q.expires_at, JSON.stringify(am))

  // ── H-1 锁:handler 契约纯净(直连拿到协议全量形状,无 __fx 私字段;投影只在 wire 层)──
  const hq = await mcp.handleQuoteOrder({ product_id: 'prd_q', quantity: 1 })
  ok('H-pure. handler 返回协议全量形状(line_items/total 在;__fx 与消费者投影字段不在)',
    !('__fx' in hq) && Array.isArray(hq.line_items) && !!hq.total && hq.amounts === undefined && hq.fiat_estimate === undefined, Object.keys(hq).sort().join(',').slice(0, 200))

  // ── 4. 法币不可得(USD 区)→ 省略估算,仍 USDC,绝不伪造 ──
  useCred('grt_us', 'buyer_us', 'gtk_us')
  const qUs = await callSC('webaz_quote_order', { product_id: 'prd_us', quantity: 1 })
  ok('4. USD 区成功报价 → fiat_estimate 省略(绝不伪造法币),USDC 照常', qUs.error === undefined && !!qUs.quote_id && qUs.fiat_estimate === undefined && (qUs.price as Record<string, unknown>)?.currency === 'USDC', JSON.stringify(qUs).slice(0, 160))

  // ── H-2 锁:幂等 replay 无 token → 空动作面 + 具体恢复指引(诚实动作面)──
  useCred('grt_qa', 'buyer1', 'gtk_qa')
  const qr1 = await callSC('webaz_quote_order', { product_id: 'prd_q', quantity: 1, idempotency_key: 'replaykey1' })
  const qr2 = await callSC('webaz_quote_order', { product_id: 'prd_q', quantity: 1, idempotency_key: 'replaykey1' })
  ok('R-1 replay:无 quote_token 时 available_actions 为空 + replay 标记 + 恢复指引(原 token/过期重报)',
    // stripEmpty:wire 上空动作面 = 字段缺席
    !!qr1.quote_token && qr2.quote_token === undefined && qr2.replay === true && qr2.available_actions === undefined && /original quote_token/.test(String(qr2.quote_token_note)), JSON.stringify(qr2).slice(0, 180))

  // ── 8. 无默认地址 → 安全失败 ──
  useCred('grt_na', 'buyer_noaddr', 'gtk_na')
  const qNa = await callSC('webaz_quote_order', { product_id: 'prd_q', quantity: 1 })
  ok('8. 无默认地址 → DEFAULT_ADDRESS_REQUIRED 安全失败(引导 PWA,不收地址入聊天)', qNa.error_code === 'DEFAULT_ADDRESS_REQUIRED')

  // ── Draft 投影(11,19b)──
  useCred('grt_qa', 'buyer1', 'gtk_qa')
  const q2 = await callSC('webaz_quote_order', { product_id: 'prd_q', quantity: 1 })
  const d = await callSC('webaz_order_draft', { action: 'create', quote_token: q2.quote_token })
  const dj = JSON.stringify(d)
  ok('D-1 draft 消费者投影(schema/USDC/法币估算/轨道诚信/available submit)', d.schema_version === 'webaz.order_draft.model.v1' && (d.price as Record<string, unknown>)?.currency === 'USDC' && !!d.fiat_estimate && /模拟托管/.test(String(d.rail_note)) && JSON.stringify(d.available_actions) === '["submit_request"]', dj.slice(0, 200))
  ok('11. draft 不扣款不占库存(DB 零变化)', walletSnap() === before.wallet && stockOf() === before.stock)
  ok('19b. Draft 投影 ≤1200B(≈300 tok)', dj.length <= 1200, `bytes=${dj.length}`)
  ok('D-2 draft 零 WAZ 零 PII', !dj.includes(' WAZ') && !PII.test(dj))

  // ── Submit/Approval 投影(12,15,19c)──
  const s1 = await callSC('webaz_submit_order_request', { draft_id: d.draft_id })
  const sj = JSON.stringify(s1)
  ok('A-1 approval 投影(request_id/passkey_required/rail-aware on_approval 中性措辞/approval_url/pending)', s1.schema_version === 'webaz.order_approval.model.v1' && !!s1.request_id && s1.passkey_required === true && /follows the disclosed rail/.test(String(s1.on_approval)) && /holds no principal/.test(String(s1.on_approval)) && String(s1.approval_url).includes('agent-approvals') && s1.status === 'pending', sj.slice(0, 200))
  ok('12. 提交不执行(orders 表零行,资金库存零变化)', (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n === 0 && walletSnap() === before.wallet && stockOf() === before.stock)
  ok('19c. Approval 投影 ≤1000B(≈250 tok)', sj.length <= 1000, `bytes=${sj.length}`)
  const s2 = await callSC('webaz_submit_order_request', { draft_id: d.draft_id })
  ok('15. 相似审批 → 显式重复警告(复用同 request_id,绝不静默二次创建)', s2.duplicate === true && !!(s2.duplicate_warning as Record<string, unknown>)?.note && s2.request_id === s1.request_id, JSON.stringify(s2.duplicate_warning ?? null))
  ok('A-2 审批请求全库仅 1 条(order_submit 幂等唯一索引)', (db.prepare("SELECT COUNT(*) n FROM agent_permission_requests WHERE kind='order_submit'").get() as { n: number }).n === 1)

  // ── 16. 文本降级(wire 摘要含可行动最小集)──
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer().connect(st)
  const c = new Client({ name: 'qa-ui', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const q3 = await c.callTool({ name: 'webaz_quote_order', arguments: { product_id: 'prd_q', quantity: 2 } }) as Record<string, unknown>
  const q3text = (q3.content as Array<{ text: string }>)[0].text
  ok('16a. quote 降级摘要:USDC + quote_token + 不扣款,非 JSON', /USDC/.test(q3text) && /qtk_/.test(q3text) && /不扣款|nothing charged/i.test(q3text) && !q3text.trimStart().startsWith('{'), q3text.slice(0, 140))
  const q3sc = q3.structuredContent as Record<string, unknown>
  const d3 = await c.callTool({ name: 'webaz_order_draft', arguments: { action: 'create', quote_token: q3sc.quote_token } }) as Record<string, unknown>
  const d3text = (d3.content as Array<{ text: string }>)[0].text
  ok('16b. draft 降级摘要:draft_id + 不扣款提示 + 下一步', /odr_/.test(d3text) && /Not charged|不扣款/i.test(d3text) && /submit_order_request/.test(d3text), d3text.slice(0, 140))
  const s3 = await c.callTool({ name: 'webaz_submit_order_request', arguments: { draft_id: (d3.structuredContent as Record<string, unknown>).draft_id } }) as Record<string, unknown>
  const s3text = (s3.content as Array<{ text: string }>)[0].text
  ok('16c. submit 降级摘要:request_id + approval_url + 不执行说明', /apr_/.test(s3text) && /agent-approvals/.test(s3text) && /Passkey/.test(s3text), s3text.slice(0, 160))

  // ── 17/18. 组件资源 + CSP + domain;组件三形态 + 安全纪律 ──
  const res = await c.listResources()
  const qaRes = res.resources.find(r => r.mimeType === 'text/html+skybridge' && r.uri.startsWith('ui://widget/webaz-quote-approval.')) as { mimeType?: string; _meta?: Record<string, unknown> } | undefined   // BUG-04: versioned URI, match by base
  ok('17/18a. quote-approval 资源在列(独立稳定 URI + CSP 空域 + widgetDomain)', !!qaRes && qaRes.mimeType === 'text/html+skybridge'
    && JSON.stringify(((qaRes._meta ?? {})['openai/widgetCSP'] as Record<string, unknown>)?.connect_domains) === '[]'
    && (qaRes._meta ?? {})['openai/widgetDomain'] === 'https://webaz.xyz')
  const widget = await c.readResource({ uri: 'ui://widget/webaz-quote-approval.html' })
  const html = (widget.contents as Array<{ text: string }>)[0].text
  // href 豁免:openExternal({href}) 是宿主 API 参数(非 DOM 属性/外链能力);src 仍禁
  const REQUEST_TOKENS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|src)\b/
  const SINK_TOKENS = /\b(innerHTML|outerHTML|insertAdjacentHTML|write|writeln|eval|Function)\b/
  ok('17/18b. 组件自包含 + 零请求能力词元 + 零可执行 sink + 零 WAZ', html.includes('toolOutput') && !REQUEST_TOKENS.test(html) && !SINK_TOKENS.test(html) && !html.includes(' WAZ'))
  ok('W-3s. 组件覆盖三形态 + 重复警告 + Passkey 边界 + openExternal 锁死 webaz.xyz 前缀', html.includes('order_quote.model.v1') && html.includes('order_draft.model.v1') && html.includes('order_approval.model.v1') && html.includes('duplicate_warning') && html.includes('Passkey') && html.includes('不会直接执行') && html.includes("'https://webaz.xyz/'"))
  const tools = (await c.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>
  ok('W-4s. 三工具描述符都挂 quote-approval outputTemplate(版本化 URI)', ['webaz_quote_order', 'webaz_order_draft', 'webaz_submit_order_request'].every(n => { const ot = String(tools.find(t => t.name === n)?._meta?.['openai/outputTemplate'] ?? ''); return ot.startsWith('ui://widget/webaz-quote-approval.') && /\.[0-9a-f]{8,}\.html$/.test(ot) }))

  // ── H-4 锁:投影器失败(敌意 getter)→ PROJECTION_FAILED 降级,原始协议对象零外泄 ──
  {
    const { projectForTool } = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { projectForTool: (n: string, r: unknown) => Promise<unknown> }
    const hostile = { quote_id: 'qte_x', get line_items(): never { throw new Error('boom') }, secret_protocol_field: 'WAZ_INTERNAL' }
    const out = await projectForTool('webaz_quote_order', hostile) as Record<string, unknown>
    const oj = JSON.stringify(out)
    ok('H-4 projector failure → structured PROJECTION_FAILED degrade (retryable + verify-first hint), raw protocol object NEVER leaked',
      out.error_code === 'PROJECTION_FAILED' && out.retryable === true && /verify with the corresponding read tool/.test(String(out.hint))
      && !oj.includes('WAZ_INTERNAL') && !oj.includes('line_items'), oj.slice(0, 180))
  }

  // ── 7. 直付非托管说明(rail_note 分支)──
  const { railHonesty } = await import('../src/agent-model-projection.js')
  ok('7. Direct Pay 非托管说明(不托管本金 + 以确认页为准)', /不托管本金/.test(railHonesty('direct_p2p')) && /确认页面为准/.test(railHonesty('direct_p2p')))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ mcp-quote-approval-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-quote-approval-ui: 消费者投影(USDC+法币估算)+ 诚信文案 + 重复保护 + 组件纪律 — 全绿\n  ✅ pass ${pass}`)
