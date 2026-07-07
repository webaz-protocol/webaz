#!/usr/bin/env tsx
/**
 * RFC-020 PR-4 — grant-gated product DRAFT creation. A Catalog Agent (delegation grant, scope
 *   seller_product_draft) creates a product FORCED to status='warehouse' (not public) via the SAME
 *   product-create logic as the human POST /api/products (makeCreateProductHandler — no parallel copy).
 *   Publishing stays human-only. Missing scope → PERMISSION_REQUIRED; non-seller grant owner → NOT_A_SELLER;
 *   a lightweight notification signals the human to review + publish.
 * Usage: npm run test:agent-product-draft
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'agentdraft-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { makeCreateProductHandler } = await import('../src/pwa/routes/products-create.js')
const { initUserModerationSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db)
initNotificationSchema(db)   // notifications table (created at boot in prod; route insert is try/catch-guarded)
applyWebazRuntimeSchema(db)  // full product columns (specs/hashes/product_type/…) — same bridge the MCP uses
try { db.exec('ALTER TABLE products ADD COLUMN commission_rate REAL DEFAULT 0.10') } catch { /* server.ts boot-only migration */ }
let seq = 0; const generateId = (p: string) => `${p}_${++seq}`
const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth here' }); return null }
// The REAL create handler — only the pure/peripheral helpers are stubbed; the insert + status-forcing is real.
const createProductDraftHandler = makeCreateProductHandler({
  db, auth, generateId,
  checkSellerCanList: () => ({ ok: true }),
  getStakeDiscount: async () => 0,
  VALID_PRODUCT_TYPES: new Set(['retail']),
  parsePlatformUrl: () => null,
  makeCommitmentHash: () => 'c'.repeat(64), makeDescriptionHash: () => 'd'.repeat(64), makePriceHash: () => 'p'.repeat(64),
})
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true, createProductDraftHandler } as never)
const server = app.listen(0); const port = (server.address() as AddressInfo).port

// seed: seller alice (grant w/ seller_product_draft), buyer bob (grant w/ seller_product_draft), carol (grant read_public only)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('alice','alice','seller','k_a'),('bob','bob','buyer','k_b'),('carol','carol','seller','k_c')").run()
const mkGrant = (gid: string, human: string, bearer: string, scopes: string[]) =>
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(gid, human, 'Catalog Agent', JSON.stringify(scopes.map(s => ({ capability: s }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
mkGrant('g_a', 'alice', 'gtk_alice', ['read_public', 'seller_product_draft'])
mkGrant('g_b', 'bob', 'gtk_bob', ['read_public', 'seller_product_draft'])
mkGrant('g_c', 'carol', 'gtk_carol', ['read_public'])   // lacks seller_product_draft

const base = `http://127.0.0.1:${port}`
const j = async (path: string, opts: { method?: string; body?: unknown; bearer?: string } = {}) => {
  const r = await fetch(base + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', ...(opts.bearer ? { authorization: 'Bearer ' + opts.bearer } : {}) }, ...(opts.body != null ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const draftBody = { title: 'Widget', description: 'A nice widget', price: 12, product_type: 'retail' }

try {
  // ── grant lacks seller_product_draft → PERMISSION_REQUIRED (not created) ──
  const denied = await j('/api/agent/seller/products', { method: 'POST', bearer: 'gtk_carol', body: draftBody })
  ok('grant without seller_product_draft → 403 PERMISSION_REQUIRED', denied.status === 403 && denied.body.error_code === 'PERMISSION_REQUIRED' && (denied.body.missing_scopes as string[]).includes('seller_product_draft'))

  // ── non-seller grant owner (buyer) → NOT_A_SELLER ──
  const notSeller = await j('/api/agent/seller/products', { method: 'POST', bearer: 'gtk_bob', body: draftBody })
  ok('grant owner is a buyer → 403 NOT_A_SELLER', notSeller.status === 403 && notSeller.body.error_code === 'NOT_A_SELLER')

  // ── seller grant w/ scope → creates a DRAFT forced to warehouse ──
  const created = await j('/api/agent/seller/products', { method: 'POST', bearer: 'gtk_alice', body: draftBody })
  ok('seller grant → 200 success + product_id', created.body.success === true && String(created.body.product_id).startsWith('prd_'))
  ok('draft is FORCED to status=warehouse (not public)', created.body.status === 'warehouse')
  const pid = String(created.body.product_id)
  const row = db.prepare('SELECT seller_id, status FROM products WHERE id=?').get(pid) as { seller_id: string; status: string } | undefined
  ok('product row: owned by the grant human, status=warehouse in DB', row?.seller_id === 'alice' && row?.status === 'warehouse')

  // ── publish stays human: the draft is NOT active ──
  ok('draft is NOT active (publishing is never delegated to a grant)', row?.status !== 'active')

  // ── lightweight signal: a notification was sent to the human ──
  const notif = db.prepare("SELECT type, title, user_id FROM notifications WHERE user_id='alice' AND type='agent_product_draft' ORDER BY rowid DESC LIMIT 1").get() as { type: string; title: string; user_id: string } | undefined
  ok('lightweight signal: notification queued for the human to review + publish', !!notif && notif.user_id === 'alice')

  // ── (audit P1) a SAFE draft grant must NOT trigger money/reputation side-effects via a colliding source_url ──
  //   Another seller (dave) has a VERIFIED external link; alice has wallet balance. Drafting with that same
  //   source_url must NOT debit alice, must NOT create a verify_task, must NOT claim the link — just a warehouse draft.
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('dave','dave','seller','k_d')").run()
  db.prepare("INSERT INTO products (id,seller_id,title,description,price,status) VALUES ('prd_dave','dave','D','d',9,'active')").run()
  db.prepare("INSERT INTO product_external_links (id,product_id,url,source,verified,verified_at) VALUES ('lnk_d','prd_dave','http://conflict.example/x','import',1,datetime('now'))").run()
  db.prepare("INSERT INTO wallets (user_id,balance) VALUES ('alice',5) ON CONFLICT(user_id) DO UPDATE SET balance=5").run()
  const balBefore = (db.prepare("SELECT balance FROM wallets WHERE user_id='alice'").get() as { balance: number }).balance
  const conflict = await j('/api/agent/seller/products', { method: 'POST', bearer: 'gtk_alice', body: { title: 'Conflicted', description: 'd', price: 20, product_type: 'retail', source_url: 'http://conflict.example/x' } })
  ok('grant draft with a CONFLICTING source_url still succeeds as a warehouse draft', conflict.body.success === true && conflict.body.status === 'warehouse')
  const cpid = String(conflict.body.product_id)
  ok('SAFE draft did NOT debit the seller wallet (no 0.1 WAZ verify fee)', (db.prepare("SELECT balance FROM wallets WHERE user_id='alice'").get() as { balance: number }).balance === balBefore)
  ok('SAFE draft created NO verify_task', (db.prepare('SELECT COUNT(*) n FROM verify_tasks WHERE product_id=?').get(cpid) as { n: number }).n === 0)
  ok('SAFE draft did NOT claim/verify the external link (no product_external_links row)', (db.prepare('SELECT COUNT(*) n FROM product_external_links WHERE product_id=?').get(cpid) as { n: number }).n === 0)
  ok('source_url is kept as inert product metadata; product stays warehouse', (db.prepare('SELECT source_url, status FROM products WHERE id=?').get(cpid) as { source_url: string; status: string }).source_url === 'http://conflict.example/x')

  // ── even a valid draft carries no raw token in the response ──
  ok('no raw grant token leaked in any response', !/gtk_alice|gtk_bob|gtk_carol|token_hash/.test(JSON.stringify([denied.body, notSeller.body, created.body])))
} finally { server.close(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch {} }

if (fail > 0) { console.error(`\n❌ agent-product-draft FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent product draft: grant (seller_product_draft) creates a DRAFT via the SAME create logic, FORCED to status=warehouse (not public); publishing stays human; missing scope→PERMISSION_REQUIRED; non-seller→NOT_A_SELLER; human notified; no raw token\n  ✅ pass ${pass}`)
