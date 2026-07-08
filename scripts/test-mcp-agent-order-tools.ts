#!/usr/bin/env tsx
/**
 * RFC-021 PR-A — grant-wired MCP order tools (webaz_get_agent_order + webaz_order_action_request).
 *   用法:npm run test:mcp-agent-order-tools
 *
 * PURE WRAPPERS over already-live endpoints — this test proves the wrapping + auth handling only,
 * against a REAL ephemeral PWA mounting the actual agent-grants routes + a REAL stored grant credential
 * (file fallback, as handlePair complete would plant). No backend/executor/projection change.
 * Covers: GRANT_REQUIRED (no cred) · minimal read (list + single) · PERMISSION_REQUIRED passthrough+hint ·
 *   action-request accept/ship SUBMIT (writes pending, NOT executed) · decline passthrough
 *   (DECLINE_NOT_DELEGATED) · no field reshaped/added · no PII in output.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-oat-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'          // grant tools require network mode (set BEFORE importing MCP)
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s'),('buyer1','B','buyer','k_b')").run()
const FUT = '2099-01-01 00:00:00'
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,accept_deadline,ship_deadline)
  VALUES ('ord_paid','buyer1','seller1','prd_x','paid',30,30,30,'escrow','123 SECRET St · recipient Jane · +6591234567',?,?)`).run(FUT, FUT)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,ship_deadline)
  VALUES ('ord_acc','buyer1','seller1','prd_y','accepted',40,40,40,'escrow','999 SECRET Rd · Bob · +6598887777',?)`).run(FUT)

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

// plant a grant in the DB (token_hash = sha(bearer)) + the local credential file (as handlePair complete would)
const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, 'seller1', 'FA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const reqCount = () => (db.prepare("SELECT COUNT(*) c FROM agent_permission_requests WHERE kind='order_action'").get() as { c: number }).c
const orderStatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const PII = /SECRET|recipient|Jane|Bob|6591234567|6598887777|shipping_address/i

mkGrant('grt_both', 'gtk_both', ['seller_orders_read_minimal', 'order_action_request'])
mkGrant('grt_readonly', 'gtk_ro', ['seller_orders_read_minimal'])
mkGrant('grt_actiononly', 'gtk_ao', ['order_action_request'])

try {
  // ══ webaz_get_agent_order ══
  clearCred()
  ok('GET-1 no grant → GRANT_REQUIRED', (await mcp.handleGetAgentOrder({})).error_code === 'GRANT_REQUIRED')

  useCred('grt_both', 'gtk_both', ['seller_orders_read_minimal', 'order_action_request'])
  { const r = await mcp.handleGetAgentOrder({})   // list
    const orders = r.orders as Array<Record<string, unknown>> | undefined
    ok('GET-2 list → returns minimal orders', Array.isArray(orders) && orders.length === 2, JSON.stringify(r).slice(0, 200))
    const keys = orders ? Object.keys(orders[0]).sort().join(',') : ''
    ok('GET-3 each order = exactly 6 minimal keys (no reshape/extra)', keys === 'amount,deadline,item_ref,next_actor,order_id,status', keys)
    ok('GET-4 list output carries NO PII', !PII.test(JSON.stringify(r))) }
  { const r = await mcp.handleGetAgentOrder({ order_id: 'ord_paid' })   // single
    const o = r.order as Record<string, unknown> | undefined
    ok('GET-5 single → minimal order (order_id/status)', o?.order_id === 'ord_paid' && o?.status === 'paid')
    ok('GET-6 single output carries NO PII', !PII.test(JSON.stringify(r))) }

  useCred('grt_actiononly', 'gtk_ao', ['order_action_request'])
  { const r = await mcp.handleGetAgentOrder({})
    ok('GET-7 missing read scope → PERMISSION_REQUIRED passthrough + hint + retry flag',
      r.error_code === 'PERMISSION_REQUIRED' && r.retry_after_approval === true && /seller_orders_read_minimal/.test(String(r.hint))) }

  // ══ webaz_order_action_request ══
  clearCred()
  ok('ACT-1 no grant → GRANT_REQUIRED', (await mcp.handleOrderActionRequest({ order_id: 'ord_paid', action: 'accept' })).error_code === 'GRANT_REQUIRED')

  useCred('grt_both', 'gtk_both', ['seller_orders_read_minimal', 'order_action_request'])
  ok('ACT-2 missing order_id → ORDER_ID_REQUIRED (no HTTP call)', (await mcp.handleOrderActionRequest({ action: 'accept' })).error_code === 'ORDER_ID_REQUIRED')

  { const before = reqCount()
    const r = await mcp.handleOrderActionRequest({ order_id: 'ord_paid', action: 'accept' })
    ok('ACT-3 accept SUBMIT → request_id + approval_url', typeof r.request_id === 'string' && typeof r.approval_url === 'string', JSON.stringify(r).slice(0, 200))
    ok('ACT-4 wrote exactly one pending request', reqCount() === before + 1)
    ok('ACT-5 order NOT executed (still paid)', orderStatus('ord_paid') === 'paid') }

  { const r = await mcp.handleOrderActionRequest({ order_id: 'ord_acc', action: 'ship', action_params: { tracking: 'SF12345678', evidence_ref: 'ev1' } })
    ok('ACT-6 ship SUBMIT (tracking+evidence) → request_id', typeof r.request_id === 'string', JSON.stringify(r).slice(0, 200))
    ok('ACT-7 order NOT executed (still accepted)', orderStatus('ord_acc') === 'accepted') }

  { const r = await mcp.handleOrderActionRequest({ order_id: 'ord_paid', action: 'decline' })
    ok('ACT-8 decline → passthrough DECLINE_NOT_DELEGATED (tool adds no bypass)', r.error_code === 'DECLINE_NOT_DELEGATED') }

  useCred('grt_readonly', 'gtk_ro', ['seller_orders_read_minimal'])
  { const r = await mcp.handleOrderActionRequest({ order_id: 'ord_paid', action: 'accept' })
    ok('ACT-9 missing action scope → PERMISSION_REQUIRED passthrough + hint',
      r.error_code === 'PERMISSION_REQUIRED' && r.retry_after_approval === true && /order_action_request/.test(String(r.hint))) }

  // ══ 回归/接线 ══
  const nm = await import('../src/layer1-agent/L1-1-mcp-server/network-mode.js')
  ok('WIRE-1 both tools network-allowed', nm.toolAllowedInNetworkMode('webaz_get_agent_order') && nm.toolAllowedInNetworkMode('webaz_order_action_request'))
  ok('WIRE-2 existing tools unaffected (list_product/get_status still network-allowed)', nm.toolAllowedInNetworkMode('webaz_list_product') && nm.toolAllowedInNetworkMode('webaz_get_status'))

  server.close()
  if (fail === 0) console.log(`\n✅ RFC-021 PR-A MCP order tools:纯封装已上线端点(get_agent_order 最小化读 · order_action_request submit-only)· GRANT_REQUIRED/PERMISSION_REQUIRED 透传+hint · 提交写 pending 不执行 · decline 原样透传 · 零 PII · 零 reshape · 现有工具不受影响\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR-A FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally { server.close?.(); try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ } }
