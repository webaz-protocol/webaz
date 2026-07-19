#!/usr/bin/env tsx
/**
 * P0-A A1 — single-approval-detail endpoint + backend exception isolation + absolute approval_url.
 *
 * The #agent-approvals/:id deep link must load ONE request by id (not the whole list), own-only, zero-PII,
 * with a clear status machine; a single bad row must NEVER hang the response (permanent-loading root cause);
 * and the agent-facing approval_url must be ABSOLUTE so text-only Hosts can open it.
 * Usage: npm run test:approval-detail-endpoint
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'aprdetail-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { absolutizeApprovalUrls } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
const app = express(); app.use(express.json())
const auth = (req: express.Request, res: express.Response) => { const u = req.header('x-test-user'); if (!u) { res.status(401).json({ error: 'unauthorized' }); return null } return { id: u } }
registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => p + '_' + Math.floor(performance.now() * 1000), rateLimitOk: () => true, requireHumanPresence: () => ({ ok: true }) } as never)
const server = app.listen(0); const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`
const j = async (path: string, opts: { user?: string } = {}) => {
  const r = await fetch(base + path, { headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-test-user': opts.user } : {}) } })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

// ── seed: users + product + one VALID draft, plus permission-request rows in several states ──
db.prepare("INSERT INTO users (id,name,role,api_key,handle) VALUES ('alice','alice','buyer','k_a','alice'),('bob','bob','buyer','k_b','bob'),('seller1','seller1','seller','k_s','goodstore')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock) VALUES ('prd1','seller1','悬挂式底部抽纸 5层','desc',19.9,'WAZ',100)").run()
const draftCols = 'id,buyer_id,quote_id,product_id,seller_id,quantity,unit_price_units,item_units,shipping_units,donation_bps,donation_units,total_units,payable_units,currency,payment_rail,anonymous_recipient,dest_region,status,expires_at'
const future = new Date(Date.now() + 24 * 3600_000).toISOString()
const past = new Date(Date.now() - 1000).toISOString()
// one draft per request (agent_permission_requests.order_id is UNIQUE — one draft → one submit request)
const seedDraft = (id: string, buyer: string) => db.prepare(`INSERT INTO order_drafts (${draftCols}) VALUES (?, ?, ?, 'prd1','seller1',1,19900000,19900000,0,0,0,19900000,19900000,'WAZ','escrow',0,'SG','draft',?)`).run(id, buyer, 'q_' + id, future)
for (const [id, buyer] of [['odr_ok', 'alice'], ['odr_exec', 'alice'], ['odr_rej', 'alice'], ['odr_exp', 'alice'], ['odr_bob', 'bob']] as const) seedDraft(id, buyer)
// permission requests
const insReq = db.prepare("INSERT INTO agent_permission_requests (id,human_id,grant_id,agent_label,requested_scopes,risk_level,duration,status,expires_at,kind,order_id,order_action,params_hash,intent_hash,executed_at,execution_result) VALUES (?,?,?,?,'[]','high','once',?,?,?,?,?,?,?,?,?)")
insReq.run('apr_ok', 'alice', 'grt_1', 'agent', 'pending', future, 'order_submit', 'odr_ok', 'order_submit', 'ph1', 'ih1', null, null)
insReq.run('apr_baddraft', 'alice', 'grt_1', 'agent', 'pending', future, 'order_submit', 'odr_MISSING', 'order_submit', 'ph2', 'ih2', null, null)          // draft gone → must NOT hang
insReq.run('apr_exec', 'alice', 'grt_1', 'agent', 'approved', future, 'order_submit', 'odr_exec', 'order_submit', 'ph3', 'ih3', new Date().toISOString(), JSON.stringify({ ok: true, order_id: 'odr_real99' }))
insReq.run('apr_rej', 'alice', 'grt_1', 'agent', 'rejected', future, 'order_submit', 'odr_rej', 'order_submit', 'ph4', 'ih4', null, null)
insReq.run('apr_exp', 'alice', 'grt_1', 'agent', 'pending', past, 'order_submit', 'odr_exp', 'order_submit', 'ph5', 'ih5', null, null)                    // pending + past expiry → expired (lazy)
insReq.run('apr_bobs', 'bob', 'grt_2', 'agent', 'pending', future, 'order_submit', 'odr_bob', 'order_submit', 'ph6', 'ih6', null, null)

try {
  // ── auth ──
  ok('detail without login → 401', (await j('/api/agent-grants/permission-requests/apr_ok')).status === 401)

  // ── valid pending request: full projection + submit_summary + relative deep-link ──
  const good = await j('/api/agent-grants/permission-requests/apr_ok', { user: 'alice' })
  ok('valid pending → 200 status=pending', good.status === 200 && good.body.status === 'pending')
  ok('valid pending carries submit_summary (economic)', !!good.body.submit_summary && (good.body.submit_summary as Record<string, unknown>).product_id === 'prd1')
  ok('valid pending carries an approval_url deep link', typeof good.body.approval_url === 'string' && String(good.body.approval_url).includes('apr_ok'))
  ok('no summary_unavailable flag on the good row', good.body.summary_unavailable !== true)

  // ── EXCEPTION ISOLATION: draft missing → 200 with summary_unavailable, NEVER a hang/500 ──
  const bad = await j('/api/agent-grants/permission-requests/apr_baddraft', { user: 'alice' })
  ok('missing-draft request → 200 (does NOT hang or 500)', bad.status === 200)
  ok('missing-draft request → summary_unavailable=true (fail-visible, economic incomplete)', bad.body.summary_unavailable === true)

  // ── executed → status executed + executed_order_id, no deep link ──
  const exec = await j('/api/agent-grants/permission-requests/apr_exec', { user: 'alice' })
  ok('executed request → status=executed with executed_order_id', exec.body.status === 'executed' && exec.body.executed_order_id === 'odr_real99')

  // ── rejected / expired lazy derivation ──
  ok('rejected request → status=rejected', (await j('/api/agent-grants/permission-requests/apr_rej', { user: 'alice' })).body.status === 'rejected')
  ok('pending+past-expiry → status=expired (lazy, no write)', (await j('/api/agent-grants/permission-requests/apr_exp', { user: 'alice' })).body.status === 'expired')

  // ── own-only: bob's request is 404 for alice (anti-enumeration), and unknown id → 404 ──
  ok("other user's request → 404 (not yours)", (await j('/api/agent-grants/permission-requests/apr_bobs', { user: 'alice' })).status === 404)
  ok('unknown request id → 404', (await j('/api/agent-grants/permission-requests/apr_nope', { user: 'alice' })).status === 404)

  // ── list route exception isolation: bad row does NOT hang the whole list; good+bad both present ──
  const list = await j('/api/agent-grants/permission-requests', { user: 'alice' })
  ok('list → 200 despite a bad-draft row present', list.status === 200)
  const reqs = list.body.requests as Array<Record<string, unknown>>
  const badInList = reqs.find(r => r.id === 'apr_baddraft')
  const goodInList = reqs.find(r => r.id === 'apr_ok')
  ok('list includes the bad-draft row degraded to summary_unavailable (not dropped, not throwing)', !!badInList && badInList.summary_unavailable === true)
  ok('list still includes the good row with submit_summary', !!goodInList && !!goodInList.submit_summary)

  // ── zero-PII: no api_key / handle-as-PII leak (seller_handle is a deliberate public projection) ──
  ok('no api_key leaks in detail body', !/k_a|k_b|k_s/.test(JSON.stringify(good.body)))

  // ── A5: absolutizeApprovalUrls turns relative deep links into absolute (top-level + nested requests[]) ──
  const abs1 = absolutizeApprovalUrls({ approval_url: '/#agent-approvals/apr_x' }) as Record<string, unknown>
  ok('absolutize top-level relative → https://webaz.xyz/#agent-approvals/apr_x', abs1.approval_url === 'https://webaz.xyz/#agent-approvals/apr_x')
  const abs2 = absolutizeApprovalUrls({ approval_url: 'https://webaz.xyz/#agent-approvals/apr_y' }) as Record<string, unknown>
  ok('absolutize leaves already-absolute untouched (no double prefix)', abs2.approval_url === 'https://webaz.xyz/#agent-approvals/apr_y')
  const abs3 = absolutizeApprovalUrls({ approval_url: null }) as Record<string, unknown>
  ok('absolutize leaves null untouched', abs3.approval_url === null)
  const abs4 = absolutizeApprovalUrls({ requests: [{ approval_url: '/#agent-approvals/a' }, { approval_url: null }] }) as { requests: Array<Record<string, unknown>> }
  ok('absolutize walks nested requests[].approval_url', abs4.requests[0].approval_url === 'https://webaz.xyz/#agent-approvals/a' && abs4.requests[1].approval_url === null)
} finally { server.close(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch {} }

if (fail > 0) { console.error(`\n❌ approval-detail-endpoint FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ approval detail endpoint: human-authed single-detail (own-only 404 anti-enum, 401 unauth) + status machine (pending/executed+order_id/rejected/expired-lazy) + EXCEPTION ISOLATION (missing-draft → 200 summary_unavailable, never hang; list degrades bad row not drops) + zero-PII + A5 absolute approval_url (top-level+nested, no double-prefix, null-safe)\n  ✅ pass ${pass}`)
