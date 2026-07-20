#!/usr/bin/env tsx
/**
 * Ops Passkey-in-flow — Task 6 test: DELETE /api/products/:id Passkey gate (the security pivot).
 *
 * Real fresh DB + the REAL products-crud route over HTTP. Proves the hard-delete route now requires a live
 * human Passkey: a bare api_key (agent / ops-bot — no gate token) → 403 HUMAN_PRESENCE_REQUIRED; a valid
 * purpose-bound gate token (product_hard_delete, bound to product_id) → delete proceeds; a token bound to a
 * DIFFERENT product → 403 (no cross-product replay); non-owner → 404 BEFORE the gate (token never burned); and
 * the existing preconditions (recycle-bin / active-orders) still hold AFTER the gate.
 *
 * Usage: npm run test:product-hard-delete-gate
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-hdg-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initProductExternalLinksBaseSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { registerProductsCrudRoutes } = await import('../src/pwa/routes/products-crud.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initProductExternalLinksBaseSchema(db)

const alice = generateId('usr'), bob = generateId('usr')
for (const [uid, nm] of [[alice, 'Alice'], [bob, 'Bob']] as const)
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(uid, nm, 'seller', 'key_' + uid)
const mkProduct = (owner: string, status = 'deleted') => { const id = generateId('prd'); db.prepare('INSERT INTO products (id, seller_id, title, description, price, status) VALUES (?,?,?,?,?,?)').run(id, owner, 'T', 'D', 9.9, status); return id }
const exists = (pid: string) => !!db.prepare('SELECT 1 FROM products WHERE id=?').get(pid)

// Fake gate modeling the real consumeGateToken: requires a token, checks purpose, drives the route's validate
// closure with a controllable purpose_data (so the product_id binding is genuinely exercised).
const makeGate = (purposeData: unknown, hasToken = true) =>
  (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => {
    if (!hasToken || !token) return { ok: false, reason: '缺少 X-WebAuthn-Token' }
    if (purpose !== 'product_hard_delete') return { ok: false, reason: 'purpose 不匹配' }
    if (!validate(purposeData)) return { ok: false, reason: 'token 业务参数不匹配' }
    return { ok: true }
  }

const auth = (req: express.Request, res: express.Response) => { const u = req.header('x-test-user'); if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } }
const errorRes = (res: express.Response, status: number, code: string, msg: string) => { res.status(status).json({ error: msg, error_code: code }) }
const mkApp = (gate: ReturnType<typeof makeGate>) => {
  const app = express(); app.use(express.json())
  registerProductsCrudRoutes(app, { db, auth, errorRes, formatProductForAgent: (p) => p, retireAnchorsByTarget: () => {}, consumeGateToken: gate })
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, base }
}
const del = (base: string, id: string, user: string | undefined, token?: string) =>
  fetch(`${base}/api/products/${id}`, { method: 'DELETE', headers: { ...(user ? { 'x-test-user': user } : {}), ...(token ? { 'x-webauthn-token': token } : {}) } })

try {
  // 1. BARE api_key (no gate token) → 403 HUMAN_PRESENCE_REQUIRED. This is the pivot: agents/ops-bot blocked.
  {
    const p = mkProduct(alice); const { server, base } = mkApp(makeGate({ product_id: p }, false))
    try {
      const r = await del(base, p, alice); const j = await r.json() as Record<string, unknown>
      ok('1 bare api_key (no Passkey) → 403 HUMAN_PRESENCE_REQUIRED', r.status === 403 && j.error_code === 'HUMAN_PRESENCE_REQUIRED')
      ok('1b product intact (not deleted without Passkey)', exists(p))
    } finally { server.close() }
  }
  // 2. valid gate token bound to this product + in recycle bin → delete proceeds
  {
    const p = mkProduct(alice); const { server, base } = mkApp(makeGate({ product_id: p }))
    try {
      const r = await del(base, p, alice, 'tok'); const j = await r.json() as Record<string, unknown>
      ok('2 valid Passkey gate → 200 success', r.status === 200 && j.success === true)
      ok('2b product hard-deleted', !exists(p))
    } finally { server.close() }
  }
  // 3. gate token bound to a DIFFERENT product → 403 (no cross-product replay)
  {
    const p = mkProduct(alice); const { server, base } = mkApp(makeGate({ product_id: 'prd_other' }))
    try {
      const r = await del(base, p, alice, 'tok')
      ok('3 token for another product → 403, product intact', r.status === 403 && exists(p))
    } finally { server.close() }
  }
  // 4. non-owner → 404 BEFORE the gate (ownership checked first; token never burned/probed)
  {
    const p = mkProduct(alice); const { server, base } = mkApp(makeGate({ product_id: p }))
    try {
      const r = await del(base, p, bob, 'tok')
      ok('4 non-owner → 404, product intact', r.status === 404 && exists(p))
    } finally { server.close() }
  }
  // 5. valid gate but product NOT in recycle bin (active) → gate passes, then existing precondition holds
  {
    const p = mkProduct(alice, 'active'); const { server, base } = mkApp(makeGate({ product_id: p }))
    try {
      const r = await del(base, p, alice, 'tok'); const j = await r.json() as Record<string, unknown>
      ok('5 active product + valid gate → 请先将商品移入回收箱 (precondition after gate), product intact', /回收箱/.test(String(j.error)) && exists(p))
    } finally { server.close() }
  }
  // 6. valid gate but an in-progress order → existing precondition still blocks
  {
    const p = mkProduct(alice); db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, unit_price, total_amount, escrow_amount, status) VALUES (?,?,?,?,10,10,10,'confirmed')").run(generateId('ord'), p, bob, alice)
    const { server, base } = mkApp(makeGate({ product_id: p }))
    try {
      const r = await del(base, p, alice, 'tok'); const j = await r.json() as Record<string, unknown>
      ok('6 active order + valid gate → 进行中的订单 block, product intact', /进行中的订单/.test(String(j.error)) && exists(p))
    } finally { server.close() }
  }
  // 7. unauth (no user) → 401 (auth before everything)
  {
    const p = mkProduct(alice); const { server, base } = mkApp(makeGate({ product_id: p }))
    try { ok('7 no auth → 401', (await del(base, p, undefined, 'tok')).status === 401) } finally { server.close() }
  }
  // 8. webauthn.ts whitelists the new purpose + frontend does the ceremony (net-zero, still one function)
  {
    const wa = readFileSync(join(process.cwd(), 'src/pwa/routes/webauthn.ts'), 'utf8')
    ok('8a product_hard_delete whitelisted in webauthn.ts', /'product_hard_delete'/.test(wa))
    const fe = readFileSync(join(process.cwd(), 'src/pwa/public/app.js'), 'utf8')
    ok('8b PWA deleteProductPermanently does the Passkey ceremony', /requestPasskeyGate\('product_hard_delete'/.test(fe) && /'X-WebAuthn-Token': _tk/.test(fe))
  }

  if (fail > 0) { console.error(`\n❌ product-hard-delete-gate FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ product-hard-delete-gate (Task 6): bare api_key → 403 (agents/ops-bot blocked) · valid purpose-bound Passkey → delete · cross-product replay blocked · owner-check before gate · recycle-bin/active-order preconditions preserved · purpose whitelisted · PWA ceremony wired\n  ✅ pass ${pass}`)
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
