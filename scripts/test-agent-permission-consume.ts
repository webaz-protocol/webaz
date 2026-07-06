#!/usr/bin/env tsx
/**
 * RFC-020 — Agent permission consumption + retry-after-approve loop (PR-3). A real grant-consumed seller
 *   surface (GET /api/agent/seller/products, requires SAFE scope seller_products_read):
 *     agent with a grant that LACKS the scope → structured `permission_required` (not a bare 403) →
 *     agent requests the scope → human approves (Passkey) → agent RETRIES the same call → 200 with the
 *     seller's OWN catalog. Every consumption attempt (allow AND the permission_required deny) is audited.
 *   No money/order path — read-only catalog projection, money fields excluded.
 * Usage: npm run test:agent-permission-consume
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'permconsume-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema } = await import('../src/runtime/webaz-schema-helpers.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db)   // the grant verifier joins user_moderation (created at boot in prod)
const app = express(); app.use(express.json())
const auth = (req: express.Request, res: express.Response) => { const u = req.header('x-test-user'); if (!u) { res.status(401).json({ error: 'unauthorized' }); return null } return { id: u } }
const requireHumanPresence = (_u: string, _p: 'agent_pair_approve' | 'agent_permission_approve', t: string | undefined, _k: string, validate?: (d: unknown) => boolean) => {
  if (typeof t !== 'string' || !t.startsWith('gtk_ok')) return { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: 'no live passkey' }
  const bound = t.includes(':') ? t.split(':')[1] : undefined
  if (validate && !validate({ request_id: bound })) return { ok: false, error_code: 'GATE_BINDING_MISMATCH', reason: 'passkey bound to a different request' }
  return { ok: true }
}
registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => p + '_' + Math.floor(performance.now() * 1000), rateLimitOk: () => true, requireHumanPresence } as never)
const server = app.listen(0); const port = (server.address() as AddressInfo).port

// seed: alice (seller) with a read_public-only grant, bob (another seller) — plus catalogs to prove isolation.
const BEARER = 'gtk_agentbearer_x'
const tokenHash = createHash('sha256').update(BEARER).digest('hex')
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('alice','alice','seller','k_alice'),('bob','bob','seller','k_bob')").run()
db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES ('grt_1','alice','Codex Catalog Agent', ?, ?, 'active', ?)")
  .run(JSON.stringify([{ capability: 'read_public' }]), tokenHash, new Date(Date.now() + 3600_000).toISOString())
const ins = db.prepare("INSERT INTO products (id, seller_id, title, description, price, status) VALUES (?,?,?,?,?,?)")
ins.run('prd_a1', 'alice', 'Alice Widget', 'desc', 10, 'active')
ins.run('prd_a2', 'alice', 'Alice Gadget', 'desc', 20, 'paused')
ins.run('prd_a_del', 'alice', 'Alice Deleted', 'desc', 5, 'deleted')   // soft-deleted → must NOT appear
ins.run('prd_b1', 'bob', 'Bob Thing', 'desc', 30, 'active')            // another seller → must NOT appear

const base = `http://127.0.0.1:${port}`
const j = async (path: string, opts: { method?: string; body?: unknown; user?: string; bearer?: string } = {}) => {
  const r = await fetch(base + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-test-user': opts.user } : {}), ...(opts.bearer ? { authorization: 'Bearer ' + opts.bearer } : {}) }, ...(opts.body != null ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const auditCount = (): number => (db.prepare('SELECT COUNT(*) n FROM agent_grant_auth_log').get() as { n: number }).n

try {
  // ── no grant bearer → PLAIN grant error (NOT permission_required — an unconnected agent must pair first) ──
  const noTok = await j('/api/agent/seller/products')
  ok('no grant bearer → 401 GRANT_TOKEN_REQUIRED (not permission_required)', noTok.status === 401 && noTok.body.error_code === 'GRANT_TOKEN_REQUIRED')

  // ── connected grant that LACKS the scope → structured permission_required (the PR-3 contract) ──
  const auditBeforeDeny = auditCount()
  const denied = await j('/api/agent/seller/products', { bearer: BEARER })
  ok('grant lacks seller_products_read → 403 PERMISSION_REQUIRED', denied.status === 403 && denied.body.error_code === 'PERMISSION_REQUIRED')
  ok('permission_required carries required_scope + approval_url', denied.body.required_scope === 'seller_products_read' && denied.body.approval_url === '/#agent-approvals')
  ok('permission_required carries an actionable request_permission hint', ((denied.body.request_permission as Record<string, unknown>)?.endpoint) === '/api/agent-grants/permission-requests' && Array.isArray(((denied.body.request_permission as Record<string, unknown>)?.body as Record<string, unknown>)?.scopes))
  ok('the permission_required DENY is audited (outcome=deny)', auditCount() === auditBeforeDeny + 1 && (db.prepare("SELECT outcome, error_code FROM agent_grant_auth_log ORDER BY id DESC LIMIT 1").get() as { outcome: string; error_code: string }).outcome === 'deny')
  ok('permission_required leaks NO products (denied before the read)', denied.body.products === undefined)

  // ── agent follows the hint: create the permission request ──
  const create = await j('/api/agent-grants/permission-requests', { method: 'POST', bearer: BEARER, body: { scopes: ['seller_products_read'], reason: 'list my catalog' } })
  ok('create scope request → 201 with approval_id', create.status === 201 && String(create.body.approval_id).startsWith('apr_'))
  const aprId = String(create.body.approval_id)

  // ── still denied until the human approves (idempotent; no premature access) ──
  ok('retry BEFORE approval → still 403 PERMISSION_REQUIRED', (await j('/api/agent/seller/products', { bearer: BEARER })).body.error_code === 'PERMISSION_REQUIRED')

  // ── human approves with a live Passkey bound to the request → grant expands ──
  const approve = await j(`/api/agent-grants/permission-requests/${aprId}/approve`, { method: 'POST', user: 'alice', body: { webauthn_token: `gtk_ok:${aprId}` } })
  ok('approve → 200, grant now carries seller_products_read', approve.status === 200 && (approve.body.scopes as string[]).includes('seller_products_read'))

  // ── RETRY the SAME call → 200 with alice's OWN catalog, isolated + money-field-free ──
  const auditBeforeAllow = auditCount()
  const retry = await j('/api/agent/seller/products', { bearer: BEARER })
  ok('retry AFTER approval → 200', retry.status === 200)
  const products = retry.body.products as Array<Record<string, unknown>>
  ok('returns ONLY alice\'s non-deleted catalog (active+paused), not bob\'s, not deleted', Array.isArray(products) && products.length === 2 && products.every(p => ['prd_a1', 'prd_a2'].includes(String(p.id))))
  ok('response is seller-scoped to the grant human', retry.body.seller_id === 'alice')
  ok('catalog projection excludes money fields (no stake_amount / commission)', !/stake_amount|commission/.test(JSON.stringify(products)))
  ok('the successful consumption is audited (outcome=allow)', auditCount() === auditBeforeAllow + 1 && (db.prepare("SELECT outcome FROM agent_grant_auth_log ORDER BY id DESC LIMIT 1").get() as { outcome: string }).outcome === 'allow')

  // ── a revoked grant → PLAIN grant error, never permission_required (must re-pair, not request more) ──
  db.prepare("UPDATE agent_delegation_grants SET status='revoked', revoked_at=? WHERE grant_id='grt_1'").run(new Date().toISOString())
  const revoked = await j('/api/agent/seller/products', { bearer: BEARER })
  ok('revoked grant → 403 GRANT_INACTIVE (not permission_required)', revoked.status === 403 && revoked.body.error_code === 'GRANT_INACTIVE')

  // ── no raw token / api_key leaks anywhere ──
  ok('no raw token / token_hash / api_key in any response body', !/gtk_agentbearer|token_hash|api_key|k_alice/.test(JSON.stringify([noTok.body, denied.body, create.body, approve.body, retry.body, revoked.body])))
} finally { server.close(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch {} }

if (fail > 0) { console.error(`\n❌ agent-permission-consume FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent permission consume: real seller surface (seller_products_read) → grant-lacks-scope emits structured permission_required (required_scope + approval_url + request hint, deny audited) → request → Passkey approve → RETRY 200 with the grant human's OWN catalog (isolated, non-deleted, no money fields, allow audited); unconnected/revoked grants stay plain (must re-pair) + no raw creds\n  ✅ pass ${pass}`)
