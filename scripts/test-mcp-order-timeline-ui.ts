#!/usr/bin/env tsx
/**
 * MCP UI PR-6 — OrderTimeline:full 视图消费者投影(webaz.order_timeline.model.v1)+ 组件纪律。
 *   用法:npm run test:mcp-order-timeline-ui
 *
 * §六 18 项映射:正常时间线(1)/取消形态(2 拒单同形)/发货事件(3)/退款+escrow 模拟托管措辞(5,7)/
 * 直付责任结果措辞(6)/USDC+法币估算(8)/零 WAZ(9)/联系商家上下文绑定(10)/非参与方 404(11)/
 * available_actions 服务器权威透传(12)/时区=组件端 localTime(13)/up_to_date 增量透传 + 列表 7 键
 * 契约不变(14)/文本降级(15)/Token 预算(16)/CSP+domain(17,18)/零 PII。超时/争议形态由状态标签
 * 单源(ORDER_STATE_MEANINGS)天然覆盖 —— 不逐状态复刻。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-otl-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY
process.env.FX_RATES_URL = 'http://127.0.0.1:1/unreachable'   // 静态兜底(stale:true)

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const PII = /SECRET|Jane|91234567|shipping_address|gift_recipient/i

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('buyer2','B2','buyer','k_b2'),('seller1','S','seller','k_s')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days) VALUES ('prd_t','seller1','Timeline Stand','d',11.5,'WAZ',9,'phone_stand','active',7)").run()
const FUT = '2099-01-01 00:00:00'
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,ship_to_region,shipping_address,ship_deadline,created_at,updated_at)
  VALUES ('ord_t1','buyer1','seller1','prd_t','accepted',1,11.5,11.5,11.5,'escrow','SG','9 SECRET Rd Jane', ?, datetime('now','-2 days'), datetime('now','-1 hours'))`).run(FUT)
db.prepare("INSERT INTO order_state_history (order_id, from_status, to_status, actor_id, actor_role, created_at) VALUES ('ord_t1','created','paid','buyer1','buyer', datetime('now','-2 days'))").run()
db.prepare("INSERT INTO order_state_history (order_id, from_status, to_status, actor_id, actor_role, created_at) VALUES ('ord_t1','paid','accepted','seller1','seller', datetime('now','-1 days'))").run()
// dp 单 + 退款请求(rail-aware 退款措辞)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,ship_to_region,shipping_address,created_at,updated_at)
  VALUES ('ord_dp','buyer1','seller1','prd_t','completed',1,11.5,11.5,0,'direct_p2p','SG','9 SECRET Rd', datetime('now','-5 days'), datetime('now','-1 days'))`).run()
db.prepare(`INSERT INTO return_requests (id, order_id, buyer_id, seller_id, product_id, reason, refund_amount, status, created_at) VALUES ('rr_t1','ord_dp','buyer1','seller1','prd_t','quality',11.5,'refund_marked', datetime('now','-2 hours'))`).run()
// R1-3 fixture:卖家可控超长标题(CJK 混排,UTF-8 字节远超封顶)
const LONG_TITLE = '超长标题注入测试'.repeat(30) + 'X'.repeat(120)
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days) VALUES ('prd_long','seller1',?,'d',3,'WAZ',5,'phone_stand','active',7)").run(LONG_TITLE)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,ship_to_region,shipping_address,created_at,updated_at)
  VALUES ('ord_long','buyer1','seller1','prd_long','paid',1,3,3,3,'escrow','SG','9 SECRET Rd', datetime('now','-1 days'), datetime('now','-1 hours'))`).run()

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true, getProtocolParam: <T,>(k: string, fb: T): T => (k === 'payment_rail_waz_escrow_enabled' ? 1 as unknown as T /* WAZ 退役:验证渠道【开着时】语义 */ : fb) })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { buildMcpServer: () => { connect: (t: unknown) => Promise<void> } }
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const webazDir = join(tmpHome, '.webaz')
const CAPS = ['buyer_orders_read_minimal', 'buyer_orders_read']
const useCred = (grantId: string, humanId: string, bearer: string): void => {
  try { db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'TL', JSON.stringify(CAPS.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString()) } catch { /* */ }
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: CAPS.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
useCred('grt_tl', 'buyer1', 'gtk_tl')

const [ct, st] = InMemoryTransport.createLinkedPair()
await mcp.buildMcpServer().connect(st)
const c = new Client({ name: 'otl-test', version: '0' }, { capabilities: {} })
await c.connect(ct)
const call = async (a: Record<string, unknown>): Promise<{ sc: Record<string, unknown>; text: string }> => {
  const r = await c.callTool({ name: 'webaz_buyer_orders', arguments: a }) as Record<string, unknown>
  return { sc: (r.structuredContent ?? {}) as Record<string, unknown>, text: (r.content as Array<{ text: string }>)[0].text }
}

try {
  // 1/3/7/8/12/16:escrow 单完整时间线
  const { sc: t1, text: t1text } = await call({ order_id: 'ord_t1', full: true })
  const t1j = JSON.stringify(t1)
  ok('1. 时间线投影(BUG-06 v2 schema/type/状态对象单源/正整数 quantity/事件序列)', t1.schema_version === 'webaz.order_timeline.model.v2'
    && t1.type === 'order_timeline' && Number.isInteger(t1.quantity) && (t1.quantity as number) > 0
    && (t1.status as Record<string, unknown>)?.code === 'accepted' && String((t1.status as Record<string, unknown>)?.label).length > 0
    && Array.isArray(t1.timeline) && (t1.timeline as unknown[]).length === 2
    && ((t1.timeline as Array<Record<string, unknown>>)[1].to_status as Record<string, unknown>).code === 'accepted', t1j.slice(0, 200))
  ok('7. 模拟托管徽章(不代表真实 USDC/法币托管)', /模拟托管测试订单/.test(String(t1.rail_badge)) && /不代表真实/.test(String(t1.rail_badge)))
  const p1 = (t1.price ?? {}) as Record<string, unknown>
  ok('8. USDC 主价 + SG 法币估算(≈/estimated/stale)', p1.currency === 'USDC' && p1.display === '11.50 USDC'
    && (t1.fiat_estimate as Record<string, unknown>)?.estimated === true && String((t1.fiat_estimate as Record<string, unknown>)?.display).startsWith('≈ S$'), t1j.slice(0, 160))
  ok('9. 零 WAZ 零 PII', !t1j.includes(' WAZ') && !PII.test(t1j))
  ok('12. available_actions 服务器权威透传(dispute 面在;含 executor)', Array.isArray(t1.available_actions)
    && (t1.available_actions as Array<Record<string, unknown>>).some(a => a.action === 'open_dispute' && a.executor === 'human_order_page'))
  ok('16. 单订单时间线 ≤2000B(≈500 tok)', t1j.length <= 2000, `bytes=${t1j.length}`)
  ok('15. 文本降级带状态标签 + 订单号', /ord_t1/.test(t1text) && String((t1.status as Record<string, unknown>).label).length > 0 && t1text.includes(String((t1.status as Record<string, unknown>).label)), t1text.slice(0, 120))
  ok('13s. deadline 只给 iso(本地时区渲染留给组件)', (t1.deadline as Record<string, unknown>)?.iso !== undefined && !('display_local' in ((t1.deadline ?? {}) as Record<string, unknown>)))
  ok('R1-2. 无退货 → refund 字段缺席(非 null;schema 校验型宿主不拒收)', !('refund' in t1))

  // R1-3:卖家可控标题封顶(UTF-8 字节)
  const { sc: tl } = await call({ order_id: 'ord_long', full: true })
  const tlTitle = String(((tl.product ?? {}) as Record<string, unknown>).title ?? '')
  ok('R1-3. 超长卖家标题被封顶 ≤200B(UTF-8)且非空', Buffer.byteLength(tlTitle, 'utf8') <= 200 && tlTitle.length > 0, `bytes=${Buffer.byteLength(tlTitle, 'utf8')}`)

  // 5/6:dp 单退款 rail-aware 措辞
  const { sc: t2 } = await call({ order_id: 'ord_dp', full: true })
  const rf = (t2.refund ?? {}) as Record<string, unknown>
  ok('5/6. 直付退款措辞(协议记录责任结果/本金未托管/双方完成)+ 请求行 USDC', /协议已记录责任结果/.test(String(rf.note)) && /本金未由 WebAZ 托管/.test(String(rf.note)) && /买卖双方完成/.test(String(rf.note))
    && String(((rf.requests as Array<Record<string, unknown>>)?.[0]?.amount as Record<string, unknown>)?.display).endsWith('USDC'), JSON.stringify(rf).slice(0, 200))
  ok('6b. 直付徽章(WebAZ 不托管本金)', /不托管本金/.test(String(t2.rail_badge)))

  // 14:up_to_date 透传 + 列表 7 键契约不变
  const { sc: u1 } = await call({ order_id: 'ord_t1', full: true, updated_since: new Date(Date.now() + 3600_000).toISOString() })
  ok('14a. up_to_date 增量透传(极小响应,不投影成时间线)', u1.up_to_date === true && u1.timeline === undefined, JSON.stringify(u1).slice(0, 120))
  const { sc: ls } = await call({})
  const EXPECT7 = 'amount,deadline,item_ref,next_actor,order_id,payment_rail,status'
  ok('14b. 列表仍是 order_status.model.v1 + 每单恰 7 键(契约不动)', ls.schema_version === 'webaz.order_status.model.v1'
    && (ls.orders as Array<Record<string, unknown>>).every(o => Object.keys(o).sort().join(',') === EXPECT7))

  // R1-1:minimal 单订单形态(order 键)透传不投影
  const { sc: mo } = await call({ order_id: 'ord_t1' })
  ok('R1-1a. minimal 单订单 = order_status.model.v1 + order 恰 7 键(不投影成时间线)', mo.schema_version === 'webaz.order_status.model.v1'
    && Object.keys((mo.order ?? {}) as Record<string, unknown>).sort().join(',') === EXPECT7 && mo.timeline === undefined, JSON.stringify(mo).slice(0, 160))

  // 11:非参与方 404
  useCred('grt_tl2', 'buyer2', 'gtk_tl2')
  const { sc: nf } = await call({ order_id: 'ord_t1', full: true })
  ok('11. 非订单参与方 → ORDER_NOT_FOUND(无存在性 oracle)', nf.error_code === 'ORDER_NOT_FOUND', JSON.stringify(nf).slice(0, 120))

  // 10/13/17/18:组件纪律
  const res = await c.listResources()
  const wRes = res.resources.find(r => r.mimeType === 'text/html+skybridge' && r.uri.startsWith('ui://widget/webaz-order-timeline.')) as { mimeType?: string; _meta?: Record<string, unknown> } | undefined   // BUG-04: versioned URI, match by base
  ok('17/18. 资源在列 + CSP 空域 + widgetDomain', !!wRes && wRes.mimeType === 'text/html+skybridge'
    && JSON.stringify(((wRes._meta ?? {})['openai/widgetCSP'] as Record<string, unknown>)?.connect_domains) === '[]'
    && (wRes._meta ?? {})['openai/widgetDomain'] === 'https://webaz.xyz')
  const widget = await c.readResource({ uri: 'ui://widget/webaz-order-timeline.html' })
  const html = (widget.contents as Array<{ text: string }>)[0].text
  const REQUEST_TOKENS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|src)\b/
  const SINK_TOKENS = /\b(innerHTML|outerHTML|insertAdjacentHTML|write|writeln|eval|Function)\b/
  ok('W-1. 组件自包含 + 零请求词元 + 零 sink + 零 WAZ + 双形态', html.includes('toolOutput') && !REQUEST_TOKENS.test(html) && !SINK_TOKENS.test(html)
    && !html.includes(' WAZ') && html.includes('order_timeline.model.v1') && html.includes('order_status.model.v1'))
  ok('10. 联系商家 = DIRECT_TOOL 会话 read(list)+ send(结构化直调 webaz_order_chat;组件内会话区;无自由私信;旧 NL 提示已移除)',
    html.includes("callTool('webaz_order_chat',{action:'list'") && html.includes("action:'send'")
    && html.includes('发送给订单对方') && html.includes('idempotency_key:idem')
    && !html.includes("读取订单 '+out.order_id+' 的对话"))
  ok('13. 组件端本地时区渲染(toLocaleString)+ 刷新走 callTool', html.includes('toLocaleString') && html.includes("callTool('webaz_buyer_orders'"))
  ok('E1. BUG-02 订单卡分列 promised(下单时预计配送)+ logistics(当前物流预计)+ legacy 缺失,两 ETA 不合成一标签;范围/约N天不伪造确定日期',
    html.includes('下单时预计配送') && html.includes('当前物流预计') && html.includes('下单时未记录预计配送时间')
    && html.includes('lg.promised_eta') && html.includes("'约'+lo+'天'"))
  // PR-A 起 openExternal 唯一调用点在 openWebaz 内部,且入参必须先过 safeWebazHref(URL 解析
  // origin === 'https://webaz.xyz' 且无 userinfo);deep link 调用点仍是字面 webaz.xyz 前缀构造。
  ok('R1-4. openExternal 单一调用点在 safeWebazHref 守卫后 + deep link 字面前缀', (html.match(/openExternal\(\{href:/g) ?? []).length === 1
    && html.includes('var h=safeWebazHref(href); if(!h) return false')
    && html.includes("openWebaz(oai,'https://webaz.xyz/#order/'"), `sites=${(html.match(/openExternal\(\{href:/g) ?? []).length}`)
  ok('R1-1b. 组件带 minimal 单订单分支(查看完整时间线入口)', html.includes('查看完整时间线') && html.includes('out.order'))
  const tools = (await c.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>
  // A3(B-2 v2):outputTemplate 回版本化(宿主模板缓存击穿);过期 URI 走 allowlist 兜底。
  ok('T-1. webaz_buyer_orders 描述符挂 order-timeline outputTemplate(版本化 A3)', /^ui:\/\/widget\/webaz-order-timeline\.[0-9a-f]{10}\.html$/.test(String(tools.find(t => t.name === 'webaz_buyer_orders')?._meta?.['openai/outputTemplate'] ?? '')))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ mcp-order-timeline-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-order-timeline-ui: 时间线消费者投影(状态标签单源/USDC/退款诚信)+ 组件纪律 — 全绿\n  ✅ pass ${pass}`)
