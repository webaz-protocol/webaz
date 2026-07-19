#!/usr/bin/env tsx
/**
 * RFC-026 PR-2 — webaz_approval_requests(审批状态只读投影)。用法:npm run test:approval-requests-read
 *
 * 真实 route + 真实 grant(含真 oat_)。覆盖:grant/scope/非-grandfathering · 本人隔离(他人行不可见,
 * get 404)· 状态派生(pending/expired/executed+order_id/failed/needs_reconcile)· 深链接 approval_url
 * 只在可操作态 · get 带零 PII 经济摘要 · 全库内容级零写(审计表豁免且必须增长)。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-aprread-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
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

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const PAST = new Date(Date.now() - 3600_000).toISOString()
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer1','B','h_b','buyer','k_b'),('other1','O','h_o','buyer','k_o'),('seller1','S','h_s','seller','k_s')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES ('prd_a','seller1','Widget Clean','d',30,'WAZ',9,'x','active')").run()
// draft 行(submit_summary 数据源;地址只有 hash+region,天然零 PII)
const mkDraft = (id: string): void => {
  db.prepare(`INSERT INTO order_drafts (id, quote_id, buyer_id, product_id, variant_id, seller_id, quantity, unit_price_units, item_units, shipping_units, donation_bps, donation_units, total_units, payable_units, currency, payment_rail, direct_receive_account_id, dest_region, address_summary_hash, anonymous_recipient, status, expires_at)
    VALUES (?, ?, 'buyer1', 'prd_a', NULL, 'seller1', 1, 30000000, 30000000, 0, 0, 0, 30000000, 30000000, 'WAZ', 'escrow', NULL, 'SG', ?, 0, 'draft', ?)`).run(id, 'q_' + id, sha('addr SECRET St 91234567'), FUTURE)
}
for (const d of ['odr_p', 'odr_x', 'odr_e', 'odr_f', 'odr_r', 'odr_t']) mkDraft(d)
const mkApr = (id: string, human: string, draftId: string, status: string, expires: string, executed: string | null, result: string | null, kind = 'order_submit', action = 'order_submit'): void => {
  db.prepare(`INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, intent_hash, action_params, executed_at, execution_result)
    VALUES (?, ?, 'grt_src', 'CA', '[]', 'high', 'once', ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`)
    .run(id, human, status, expires, kind, draftId, action, 'ph_' + id, 'ih_' + id, executed, result)
}
mkApr('apr_pending', 'buyer1', 'odr_p', 'pending', FUTURE, null, null)
mkApr('apr_expired', 'buyer1', 'odr_e', 'pending', PAST, null, null)
mkApr('apr_executed', 'buyer1', 'odr_x', 'approved', FUTURE, new Date().toISOString(), JSON.stringify({ order_id: 'ord_done_1' }))
mkApr('apr_failed', 'buyer1', 'odr_f', 'failed', FUTURE, null, null)
mkApr('apr_frozen', 'buyer1', 'odr_r', 'approved', FUTURE, null, null)
mkApr('apr_theirs', 'other1', 'odr_t', 'pending', FUTURE, null, null)
// RFC-021 order_action 双态(Codex MEDIUM:失败注解 {ok:false} 保持 approved 可重试)
mkApr('apr_act_failed', 'buyer1', 'ord_act1', 'approved', FUTURE, null, JSON.stringify({ ok: false, error_code: 'TRACKING_REQUIRED' }), 'order_action', 'ship')
mkApr('apr_act_mid', 'buyer1', 'ord_act2', 'approved', FUTURE, null, null, 'order_action', 'accept')

const auth = (req: Request, res: Response) => {
  const uid = req.headers['x-test-uid'] as string | undefined
  const row = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined : undefined
  if (!row) { res.status(401).json({ error: 'login' }); return null }
  return row
}
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const useCred = (g: string, b: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [g]: { token: b, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: g, handle: `file:~/.webaz/credentials#${g}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
// #385 教训:OAuth 凭证用真 oat_ + oauth_access_tokens introspection,不用 gtk_ 冒充
const mkOAuth = (gid: string, human: string, oat: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,NULL,'active',?)")
    .run(gid, human, 'OAuth: test', JSON.stringify(caps.map(c => ({ capability: c }))), FUTURE)
  db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
    .run(sha(oat), gid, 'cli_t', 'read', 'https://webaz.xyz/mcp', FUTURE)
}
mkOAuth('grt_ar', 'buyer1', 'oat_ar_full', ['approval_requests_read'])
mkOAuth('grt_old', 'buyer1', 'oat_ar_old', ['read_public', 'buyer_orders_read_minimal', 'buyer_case_prepare'])
const PII = /SECRET|91234567/i
const C = (a: Record<string, unknown>) => (mcp as unknown as { handleApprovalRequests: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleApprovalRequests(a)
const dbSnapshot = (): string => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'agent_grant_auth_log' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
  return sha(JSON.stringify(tables.map(t => [t, sha(JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()))])))
}
const auditCount = (): number => (db.prepare('SELECT COUNT(*) c FROM agent_grant_auth_log').get() as { c: number }).c

const before = dbSnapshot(); const auditBefore = auditCount()
try {
  clearCred()
  ok('A-1 no grant → GRANT_REQUIRED', (await C({ action: 'list' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_old', 'oat_ar_old', ['read_public', 'buyer_orders_read_minimal', 'buyer_case_prepare'])
  ok('A-2 NON-GRANDFATHERING: pre-PR read snapshot lacks approval_requests_read → PERMISSION_REQUIRED + hint',
    await C({ action: 'list' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /approval_requests_read/.test(String(r.hint))))

  useCred('grt_ar', 'oat_ar_full', ['approval_requests_read'])
  const L = await C({ action: 'list' })
  const reqs = L.requests as Array<Record<string, unknown>>
  ok('A-3 list over a REAL oat_ bearer: exactly the 7 OWN requests (the other human\'s row invisible)',
    Array.isArray(reqs) && reqs.length === 7 && !reqs.some(r => r.request_id === 'apr_theirs'), JSON.stringify(L).slice(0, 300))
  const by = Object.fromEntries(reqs.map(r => [String(r.request_id), r]))
  ok('A-4 status derivation: pending / expired(lazy) / executed(+order id) / failed(+note) / needs_reconcile(+note)',
    by.apr_pending?.status === 'pending' && by.apr_expired?.status === 'expired'
    && by.apr_executed?.status === 'executed' && by.apr_executed?.executed_order_id === 'ord_done_1'
    && by.apr_failed?.status === 'failed' && /fresh request/.test(String(by.apr_failed?.note))
    && by.apr_frozen?.status === 'needs_reconcile' && /re-approves with a Passkey/.test(String(by.apr_frozen?.note)), JSON.stringify(by).slice(0, 400))
  // P0-A A5: the MCP surface (handleApprovalRequests) absolutizes approval_url with WEBAZ_API_URL so text-only Hosts can open it.
  const AB = process.env.WEBAZ_API_URL
  ok('A-5 deep-link approval_url ONLY on actionable states (pending/needs_reconcile), ABSOLUTE format (A5)',
    by.apr_pending?.approval_url === `${AB}/#agent-approvals/apr_pending` && by.apr_frozen?.approval_url === `${AB}/#agent-approvals/apr_frozen`
    && by.apr_executed?.approval_url === null && by.apr_failed?.approval_url === null && by.apr_expired?.approval_url === null)
  ok('A-4b order_action honesty: failed execution → execution_failed + failure_reason + actionable url (absolute); mid-flight → approved_retryable + url',
    by.apr_act_failed?.status === 'execution_failed' && by.apr_act_failed?.failure_reason === 'TRACKING_REQUIRED' && by.apr_act_failed?.approval_url === `${AB}/#agent-approvals/apr_act_failed`
    && by.apr_act_mid?.status === 'approved_retryable' && by.apr_act_mid?.approval_url === `${AB}/#agent-approvals/apr_act_mid`, JSON.stringify({ f: by.apr_act_failed, m: by.apr_act_mid }))
  // 人工审批列表:失败的 order_action 必须回列表可重批(不许搁浅);冻结 submit 带 needs_reconcile
  { const hres = await fetch(`${process.env.WEBAZ_API_URL}/api/agent-grants/permission-requests`, { headers: { 'x-test-uid': 'buyer1' } })
    const hj = await hres.json() as { requests: Array<Record<string, unknown>> }
    const hby = Object.fromEntries(hj.requests.map(x => [String(x.id), x]))
    ok('A-4c HUMAN approvals list surfaces the failed order_action for retry (retry_available + last_error code) and the frozen submit (needs_reconcile)',
      hby.apr_act_failed?.retry_available === true && hby.apr_act_failed?.last_error === 'TRACKING_REQUIRED' && hby.apr_frozen?.needs_reconcile === true, JSON.stringify({ f: hby.apr_act_failed, z: hby.apr_frozen }).slice(0, 250)) }
  const G = await C({ action: 'get', request_id: 'apr_pending' })
  ok('A-6 get: full economic summary attached (zero-PII submitRowSummary) + economic_effect honesty',
    (G.submit_summary as Record<string, unknown>)?.payable_units === 30000000 && (G.economic_effect as Record<string, unknown>)?.moves_funds === true, JSON.stringify(G).slice(0, 300))
  ok('A-7 ZERO PII across list+get (address/phone markers absent; dest is a region tag)', !PII.test(JSON.stringify(L)) && !PII.test(JSON.stringify(G)) && (G.submit_summary as Record<string, unknown>)?.dest_region === 'SG')
  ok('A-8 another human\'s request via get → REQUEST_NOT_FOUND', (await C({ action: 'get', request_id: 'apr_theirs' })).error_code === 'REQUEST_NOT_FOUND')
  ok('A-9 unknown request → REQUEST_NOT_FOUND; bad action → BAD_ACTION',
    (await C({ action: 'get', request_id: 'apr_nope' })).error_code === 'REQUEST_NOT_FOUND' && (await C({ action: 'zap' })).error_code === 'BAD_ACTION')
  ok('A-10 whole-DB content unchanged (read-only; sole exemption audit log, which MUST have grown)',
    dbSnapshot() === before && auditCount() > auditBefore, `audit ${auditBefore}→${auditCount()}`)
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ approval-requests-read FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ approval-requests-read: 审批状态只读 — 本人隔离 · 状态派生 · 深链接 · 零 PII · 内容级零写 · 真 oat_ 链\n  ✅ pass ${pass}`)
