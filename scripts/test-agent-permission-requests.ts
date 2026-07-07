#!/usr/bin/env tsx
/**
 * RFC-020 — Agent Permission Requests lifecycle (PR-2). An already-connected agent (holds a grant) requests
 *   MORE scope / a bundle → human lists + approves/rejects → approval EXPANDS the agent's existing grant
 *   (safe-only, duration-capped) → verify returns the FULL grant. Audited. No money/order path.
 * Usage: npm run test:agent-permission-requests
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'permreq-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
const app = express(); app.use(express.json())
const auth = (req: express.Request, res: express.Response) => { const u = req.header('x-test-user'); if (!u) { res.status(401).json({ error: 'unauthorized' }); return null } return { id: u } }
// Stub Passkey gate: a token 'gtk_ok:<request_id>' carries the request it was minted for (mirrors the real
//   purpose_data binding). No token → fail-closed. validate() must accept the bound request_id or we reject.
const requireHumanPresence = (_u: string, _p: 'agent_pair_approve' | 'agent_permission_approve', t: string | undefined, _k: string, validate?: (d: unknown) => boolean) => {
  if (typeof t !== 'string' || !t.startsWith('gtk_ok')) return { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: 'no live passkey' }
  const bound = t.includes(':') ? t.split(':')[1] : undefined
  if (validate && !validate({ request_id: bound })) return { ok: false, error_code: 'GATE_BINDING_MISMATCH', reason: 'passkey bound to a different request' }
  return { ok: true }
}
registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => p + '_' + Math.floor(performance.now() * 1000), rateLimitOk: () => true, requireHumanPresence } as never)
const server = app.listen(0); const port = (server.address() as AddressInfo).port

// seed a human + an ACTIVE grant with a known bearer (token_hash = sha256(bearer)), scope read_public only.
const BEARER = 'gtk_agentbearer_x'
const tokenHash = createHash('sha256').update(BEARER).digest('hex')
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('alice','alice','seller','k_alice'),('bob','bob','seller','k_bob')").run()
db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES ('grt_1','alice','Codex Catalog Agent', ?, ?, 'active', ?)")
  .run(JSON.stringify([{ capability: 'read_public' }]), tokenHash, new Date(Date.now() + 3600_000).toISOString())

const base = `http://127.0.0.1:${port}`
const j = async (path: string, opts: { method?: string; body?: unknown; user?: string; bearer?: string } = {}) => {
  const r = await fetch(base + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-test-user': opts.user } : {}), ...(opts.bearer ? { authorization: 'Bearer ' + opts.bearer } : {}) }, ...(opts.body != null ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const auditCount = (): number => (db.prepare('SELECT COUNT(*) n FROM agent_grant_auth_log').get() as { n: number }).n

try {
  // ── create requires an active grant bearer ──
  ok('create without grant bearer → 401 GRANT_REQUIRED', (await j('/api/agent-grants/permission-requests', { method: 'POST', body: { bundle: 'catalog_agent' } })).body.error_code === 'GRANT_REQUIRED')

  // ── safe-only: risk / never-delegable are NOT grantable via a persistent request ──
  const riskReq = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { scopes: ['seller_products_read', 'order_accept'] } })
  ok('request with a RISK scope → 403 PERMISSION_NOT_GRANTABLE', riskReq.status === 403 && riskReq.body.error_code === 'PERMISSION_NOT_GRANTABLE')
  const neverReq = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { scopes: ['withdraw'] } })
  ok('request with a never-delegable scope → 403', neverReq.status === 403 && neverReq.body.error_code === 'PERMISSION_NOT_GRANTABLE')
  ok('unknown bundle → 400', (await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { bundle: 'nope' } })).body.error_code === 'UNKNOWN_BUNDLE')

  // ── create the Catalog Agent bundle request (acceptance #1/#3) ──
  const create = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { bundle: 'catalog_agent', reason: 'check titles/inventory', duration: '30d' } })
  ok('create catalog bundle request → 201 with approval_id + approval_url', create.status === 201 && String(create.body.approval_id).startsWith('apr_') && create.body.approval_url === '/#agent-approvals')
  ok('create returns risk_level + human_summary + suggested_duration (30d allowed for safe)', create.body.risk_level === 'medium' && typeof create.body.human_summary === 'string' && create.body.suggested_duration === '30d')
  const aprId = String(create.body.approval_id)

  // ── list (human) shows the pending request ──
  ok('list requires human auth', (await j('/api/agent-grants/permission-requests')).status === 401)
  const list = await j('/api/agent-grants/permission-requests', { user: 'alice' })
  const reqs = list.body.requests as Array<Record<string, unknown>>
  ok('alice sees her pending request with scopes + bundle + summary', reqs.length === 1 && reqs[0].permission_bundle === 'catalog_agent' && (reqs[0].requested_scopes as string[]).includes('seller_products_read'))
  ok('bob does NOT see alice\'s request (human-scoped)', ((await j('/api/agent-grants/permission-requests', { user: 'bob' })).body.requests as unknown[]).length === 0)

  // ── grant-authed self-list (agent polls its OWN requests via the grant bearer, for webaz_pair action=requests) ──
  ok('my-permission-requests requires a grant bearer', (await j('/api/agent-grants/my-permission-requests')).body.error_code === 'GRANT_REQUIRED')
  const mine = await j('/api/agent-grants/my-permission-requests', { bearer: BEARER })
  ok('grant sees its OWN request (bound to grant_id) with status + bundle', (mine.body.requests as Array<Record<string, unknown>>).some(r => r.id === aprId && r.status === 'pending' && r.permission_bundle === 'catalog_agent' && (r.requested_scopes as string[]).includes('seller_products_read')))

  // ── verify BEFORE approval: full grant = only read_public ──
  const v0 = await j('/api/agent-grants/verify', { bearer: BEARER })
  ok('verify returns FULL grant (human_id/scopes/bundle/expiry/status), not just read_public', v0.status === 200 && (v0.body.grant as Record<string, unknown>).human_id === 'alice' && Array.isArray((v0.body.grant as Record<string, unknown>).scopes) && ((v0.body.grant as Record<string, string[]>).scopes).join() === 'read_public')

  // ── wrong human can\'t approve ──
  ok('non-owner cannot approve', (await j(`/api/agent-grants/permission-requests/${aprId}/approve`, { method: 'POST', user: 'bob' })).status === 403)

  // ── approve requires a LIVE Passkey (RFC-020: expansion = privilege escalation), bound to THIS request ──
  ok('approve WITHOUT a passkey token → 412 (fail-closed)', (await j(`/api/agent-grants/permission-requests/${aprId}/approve`, { method: 'POST', user: 'alice' })).status === 412)
  const wrongTok = await j(`/api/agent-grants/permission-requests/${aprId}/approve`, { method: 'POST', user: 'alice', body: { webauthn_token: 'gtk_ok:apr_someoneelse' } })
  ok('approve with a passkey bound to a DIFFERENT request → 412 GATE_BINDING_MISMATCH', wrongTok.status === 412 && wrongTok.body.error_code === 'GATE_BINDING_MISMATCH')
  const vStill = await j('/api/agent-grants/verify', { bearer: BEARER })
  ok('after rejected passkey attempts the grant is UNCHANGED (still read_public, request still pending)', ((vStill.body.grant as Record<string, string[]>).scopes).join() === 'read_public')

  const auditBefore = auditCount()
  // ── approve with the correctly-bound Passkey → expands the grant ──
  const approve = await j(`/api/agent-grants/permission-requests/${aprId}/approve`, { method: 'POST', user: 'alice', body: { webauthn_token: `gtk_ok:${aprId}` } })
  ok('approve → 200, grant expanded with the 9 catalog scopes', approve.status === 200 && (approve.body.scopes as string[]).includes('seller_products_read') && (approve.body.scopes as string[]).includes('read_public') && approve.body.permission_bundle === 'catalog_agent')
  ok('approve writes an audit log row', auditCount() > auditBefore)

  // ── verify AFTER approval: grant now carries the bundle scopes + bundle key ──
  const v1 = await j('/api/agent-grants/verify', { bearer: BEARER })
  const gv = v1.body.grant as Record<string, unknown>
  ok('post-approve verify: scopes include seller_products_read + bundle set', (gv.scopes as string[]).includes('seller_products_read') && gv.permission_bundle === 'catalog_agent')

  // ── re-approve → 409 (already approved) ──
  ok('re-approve → 409 (not pending)', (await j(`/api/agent-grants/permission-requests/${aprId}/approve`, { method: 'POST', user: 'alice' })).status === 409)

  // ── single-scope request (acceptance #3) + reject path ──
  const single = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { scopes: ['seller_inventory_read'] } })
  ok('single-scope request → 201, risk low, suggested 7d', single.status === 201 && single.body.risk_level === 'low' && single.body.suggested_duration === '7d')
  const singleId = String(single.body.approval_id)
  ok('reject a pending request → rejected', (await j(`/api/agent-grants/permission-requests/${singleId}/reject`, { method: 'POST', user: 'alice' })).body.status === 'rejected')
  ok('approve a rejected request → 409', (await j(`/api/agent-grants/permission-requests/${singleId}/approve`, { method: 'POST', user: 'alice' })).status === 409)

  // ── (P2') audit sink unavailable → grant read/expansion FAIL CLOSED (never proceed unaudited, invariant) ──
  const p3 = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { scopes: ['draft_order'] } })  // draft_order is NOT yet in grt_1's grant
  const p3Id = String(p3.body.approval_id)
  const capsBefore = (db.prepare("SELECT capabilities FROM agent_delegation_grants WHERE grant_id='grt_1'").get() as { capabilities: string }).capabilities
  db.exec('ALTER TABLE agent_grant_auth_log RENAME TO agent_grant_auth_log__bak')  // simulate the audit sink being down
  const vAudit = await j('/api/agent-grants/verify', { bearer: BEARER })
  ok('verify with audit sink down → 503 GRANT_AUDIT_FAILED (no unaudited grant read)', vAudit.status === 503 && vAudit.body.error_code === 'GRANT_AUDIT_FAILED')
  const p3Approve = await j(`/api/agent-grants/permission-requests/${p3Id}/approve`, { method: 'POST', user: 'alice', body: { webauthn_token: `gtk_ok:${p3Id}` } })
  ok('approve with audit sink down → 503 GRANT_AUDIT_FAILED', p3Approve.status === 503 && p3Approve.body.error_code === 'GRANT_AUDIT_FAILED')
  const capsAfter = (db.prepare("SELECT capabilities FROM agent_delegation_grants WHERE grant_id='grt_1'").get() as { capabilities: string }).capabilities
  ok('grant NOT expanded when the audit write failed (whole tx rolled back; draft_order absent)', capsAfter === capsBefore && !capsAfter.includes('draft_order'))
  ok('request stays PENDING when the audit write failed (no phantom approved)', (db.prepare('SELECT status FROM agent_permission_requests WHERE id=?').get(p3Id) as { status: string }).status === 'pending')
  db.exec('ALTER TABLE agent_grant_auth_log__bak RENAME TO agent_grant_auth_log')  // restore the audit sink

  // ── (P2) grant goes inactive BEFORE approval → 409, and the request MUST stay pending (no phantom approved) ──
  const p2 = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { scopes: ['seller_inventory_read'] } })
  const p2Id = String(p2.body.approval_id)
  db.prepare("UPDATE agent_delegation_grants SET status='revoked', revoked_at=? WHERE grant_id='grt_1'").run(new Date().toISOString())
  const p2Approve = await j(`/api/agent-grants/permission-requests/${p2Id}/approve`, { method: 'POST', user: 'alice', body: { webauthn_token: `gtk_ok:${p2Id}` } })
  ok('approve when grant is revoked → 409 GRANT_INACTIVE', p2Approve.status === 409 && p2Approve.body.error_code === 'GRANT_INACTIVE')
  ok('the request stays PENDING after a failed approve (no phantom approved)', (db.prepare('SELECT status FROM agent_permission_requests WHERE id=?').get(p2Id) as { status: string }).status === 'pending')

  // ── no raw token/api_key leaks in any response ──
  ok('no raw token / token_hash / api_key in create/verify/approve bodies', !/gtk_agentbearer|token_hash|api_key|k_alice/.test(JSON.stringify([create.body, v1.body, approve.body])))
} finally { server.close(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch {} }

if (fail > 0) { console.error(`\n❌ agent-permission-requests FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent permission requests: grant-bound create (safe-only; risk/never rejected) + bundle/single-scope + human list (scoped) + live-Passkey approve (bound to request; no-token/wrong-request→412) EXPANDS grant (union scopes + bundle + extend expiry) + grant-active-before-CAS (revoked grant→409, request stays pending) + atomic claim+expand+audit (audit sink down → verify/approve 503, grant unchanged, request pending) + full verify + reject + audit + no raw creds\n  ✅ pass ${pass}`)
