#!/usr/bin/env tsx
/**
 * RFC-021 PR1 —— 两个 SAFE scope(order_action_request submit-only + seller_orders_read_minimal)+ fulfillment_agent
 *   bundle + 最小化订单读端点。纯 SAFE、无任何执行路径。用法:npm run test:order-action-request-p1
 *
 * 断言(PR1 主要落 I6 / I9 / I10 + scope 门):
 *   A. scope 分类:两新 scope = SAFE 可委托;order_accept/order_ship/order_status/place_order 仍 RISK 硬拒(不动)。
 *   B. fulfillment_agent bundle 独立、仅含两新 scope、all-safe。
 *   C. minimalSellerOrderView ALLOWLIST:喂带 PII 的行,输出恰 6 键、无任何 PII(地址/联系/gift/recipient_code/买家名)。
 *   D. MINIMAL_ORDER_COLUMNS(SELECT 白名单)不含任何 PII 列 —— PII 连取都不取。
 *   E. 路由:GET /api/agent/orders(/:id) 经 grant(seller_orders_read_minimal)→ 最小化、响应无地址;
 *      缺该 scope → 403 PERMISSION_REQUIRED;无执行面。
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'oar1-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const S = await import('../src/runtime/agent-grant-scopes.js')
const { minimalSellerOrderView, MINIMAL_ORDER_COLUMNS } = await import('../src/pwa/agent-order-minimal-view.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const keys = (o: object) => JSON.stringify(Object.keys(o).sort())
const SIX = JSON.stringify(['amount', 'deadline', 'item_ref', 'next_actor', 'order_id', 'status'])

try {
  // ══ A. scope 分类 ══
  ok('A1 order_action_request = SAFE', S.classifyScope('order_action_request') === 'safe')
  ok('A2 seller_orders_read_minimal = SAFE', S.classifyScope('seller_orders_read_minimal') === 'safe')
  ok('A3 两新 scope 一起 validateRequestedCapabilities ok', S.validateRequestedCapabilities([{ capability: 'order_action_request' }, { capability: 'seller_orders_read_minimal' }]).ok === true)
  for (const risk of ['order_accept', 'order_ship', 'order_status', 'place_order']) {
    ok(`A4 ${risk} 仍 RISK 且硬拒`, S.classifyScope(risk) === 'risk' && S.validateRequestedCapabilities([{ capability: risk }]).ok === false)
  }

  // ══ B. fulfillment_agent bundle ══
  const b = S.resolveBundle('fulfillment_agent')!
  ok('B1 fulfillment_agent bundle 存在', !!b)
  ok('B2 独立于 catalog_agent 且仅含两新 scope', keys({ ...Object.fromEntries([...b.scopes].map(s => [s, 1])) }) === JSON.stringify(['order_action_request', 'seller_orders_read_minimal']))
  ok('B3 bundle all-safe', S.bundleNonSafeScopes(b).length === 0)
  ok('B4 catalog_agent 未被污染(不含新 scope)', !S.resolveBundle('catalog_agent')!.scopes.includes('order_action_request' as never))

  // ══ C. minimalSellerOrderView ALLOWLIST ══
  const piiRow = {
    id: 'ord_1', status: 'paid', total_amount: 30, product_id: 'prd_x', logistics_id: null, accept_deadline: '2026-07-10 00:00:00',
    shipping_address: '123 Secret St Apt4', notes: 'buyer note', gift_recipient_name: 'Alice', gift_recipient_phone: '99988', recipient_code: 'PR-ZZZZ', buyer_name: 'Bob',
  }
  const view = minimalSellerOrderView(piiRow)
  ok('C1 输出恰 6 键', keys(view) === SIX)
  ok('C2 六字段值正确(next_actor=seller/deadline/amount/item_ref)', view.order_id === 'ord_1' && view.status === 'paid' && view.next_actor === 'seller' && view.deadline === '2026-07-10 00:00:00' && view.amount === 30 && view.item_ref === 'prd_x')
  ok('C3 输出无任何 PII', !/123 Secret|buyer note|Alice|99988|PR-ZZZZ|Bob|shipping_address|gift_recipient|recipient_code/.test(JSON.stringify(view)))

  // ══ D. SELECT 白名单无 PII 列 ══
  const piiCols = ['shipping_address', 'notes', 'gift_recipient_name', 'gift_recipient_phone', 'gift_message', 'recipient_code', 'buyer_name']
  ok('D1 MINIMAL_ORDER_COLUMNS 不含任何 PII 列', (MINIMAL_ORDER_COLUMNS as readonly string[]).every(c => !piiCols.includes(c)))

  // ══ E. 路由 ══
  const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
  initUserModerationSchema(db); applyWebazRuntimeSchema(db)
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s'),('buyer1','B','buyer','k_b')").run()
  db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,accept_deadline)
    VALUES ('ord_1','buyer1','seller1','prd_x','paid',30,30,30,'escrow','123 Secret St Apt4','2026-07-10 00:00:00')`).run()

  const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth' }); return null }
  const app = express(); app.use(express.json())
  registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => `${p}_1`, rateLimitOk: () => true } as never)
  // 建两个 grant(schema 由 register 内部 init)
  const mkGrant = (bearer: string, caps: string[]) => db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(`grt_${bearer}`, 'seller1', 'FA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
  mkGrant('gtk_ok', ['seller_orders_read_minimal'])
  mkGrant('gtk_noscope', ['read_public'])
  const server = app.listen(0); const port = (server.address() as AddressInfo).port
  const get = async (path: string, bearer?: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: bearer ? { authorization: 'Bearer ' + bearer } : {} }); return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> } }

  const list = await get('/api/agent/orders', 'gtk_ok')
  const orders = list.body.orders as Array<Record<string, unknown>> | undefined
  ok('E1 GET /api/agent/orders 200 + 该卖家 1 单', list.status === 200 && Array.isArray(orders) && orders.length === 1)
  ok('E2 list 项恰 6 字段', !!orders && keys(orders[0]) === SIX)
  ok('E3 list 响应无买家地址(I6)', !JSON.stringify(list.body).includes('Secret'))
  const det = await get('/api/agent/orders/ord_1', 'gtk_ok')
  ok('E4 detail 200 + order_id 对 + 无地址', det.status === 200 && (det.body.order as Record<string, unknown>)?.order_id === 'ord_1' && !JSON.stringify(det.body).includes('Secret'))
  const noscope = await get('/api/agent/orders', 'gtk_noscope')
  ok('E5 缺 seller_orders_read_minimal → 403 PERMISSION_REQUIRED', noscope.status === 403 && noscope.body.error_code === 'PERMISSION_REQUIRED')
  const noauth = await get('/api/agent/orders')
  ok('E6 无 bearer → 非 200(不泄露)', noauth.status !== 200)
  server.close()

  if (fail === 0) console.log(`\n✅ RFC-021 PR1:两 SAFE scope + fulfillment_agent bundle + 最小化订单读(ALLOWLIST 无 PII);RISK 档订单执行 scope 不动、仍硬拒;无执行面\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR1 FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally { try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ } }
