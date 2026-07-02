#!/usr/bin/env tsx
/**
 * 平台服务费预充值申请 —— admin 审核(确认入账 / 驳回)。真 express + 真 admin 路由 + 真 helper。
 * 验:ROOT 门、approve 的 Passkey 绑定 {request_id, seller_id, amount_units, method}(改金额/换单 → 403)、
 *   approve 原子入账(记 direct_pay_fee_payments + 余额增 + 回填 resulting_payment_id + 状态 approved)、
 *   双重 approve 不二次入账、reject pending→rejected、reject 非 pending 拒。approve 前不动钱。
 * Usage: npm run test:fee-prepay-review
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'fprv-'))

import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')
const { createFeePrepayRequest } = await import('../src/direct-pay-fee-prepay-request.js')
const { getDirectPayFeeAccount } = await import('../src/direct-pay-fee-ar.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
let _n = 0; const generateId = (p: string): string => `${p}_${++_n}`

const db = initDatabase()
db.pragma('foreign_keys = OFF')
db.prepare('CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT, counter INTEGER DEFAULT 0)').run()
db.prepare('INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_root', 'root1', 'pk')
db.prepare("CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))").run()   // runtime-helper table recordFeePrepay writes to
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k1')").run()
db.prepare("INSERT INTO platform_receive_accounts (id,method,currency,instruction,status) VALUES ('pra1','PayNow','SGD','UEN 1','active')").run()
// seed a pending request (50 USDC = 50e6 units)
const req = createFeePrepayRequest(db, 's1', { amountUnits: 50_000_000, currency: 'SGD', platformAccountId: 'pra1', evidenceRef: 'BANK-9' }, generateId)
if (!req.ok) throw new Error('seed failed: ' + req.reason)
const reqId = req.request.id

const requireRootAdmin = (req: Request, res: Response): Record<string, unknown> | null => {
  if (req.headers['x-role'] !== 'root') { res.status(403).json({ error: 'root only' }); return null }
  return { id: 'root1', admin_type: 'root' }
}
const consumeGateToken = (_u: string, token: string | undefined, _p: string, validate: (d: unknown) => boolean): { ok: boolean; reason?: string } => {
  if (!token) return { ok: false, reason: 'missing gate token' }
  let d: unknown; try { d = JSON.parse(token) } catch { return { ok: false, reason: 'bad token' } }
  return validate(d) ? { ok: true } : { ok: false, reason: 'purpose_data mismatch' }
}
const app = express(); app.use(express.json())
registerAdminDirectReceiveDepositsRoutes(app, { db, requireRootAdmin, consumeGateToken, logAdminAction: () => {}, getProtocolParam: <T,>(_k: string, fb: T): T => fb } as any)
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const call = async (method: string, path: string, root: boolean, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(root ? { 'x-role': 'root' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j: any = null; try { j = await r.json() } catch {}
  return { status: r.status, json: j }
}
const tok = (o: object): string => JSON.stringify(o)
const feeRows = (): number => (db.prepare('SELECT COUNT(*) n FROM direct_pay_fee_payments').get() as { n: number }).n
const avail = (): number => Number(getDirectPayFeeAccount(db, 's1').availableUnits)
const APPROVE = `/api/admin/direct-receive/fee-prepay-requests/${reqId}/approve`

try {
  ok('0. before approve: no money moved', feeRows() === 0 && avail() === 0)

  // 1. queue + root gate
  ok('1a. non-root queue → 403', (await call('GET', '/api/admin/direct-receive/fee-prepay-requests?status=pending', false)).status === 403)
  ok('1b. root sees pending in queue', (await call('GET', '/api/admin/direct-receive/fee-prepay-requests?status=pending', true)).json.requests.some((r: any) => r.id === reqId))

  // 2. approve Passkey binding
  ok('2a. approve without token → 403', (await call('POST', APPROVE, true, { method: 'usdc' })).status === 403)
  ok('2b. token bound to WRONG amount → 403', (await call('POST', APPROVE, true, { method: 'usdc', webauthn_token: tok({ request_id: reqId, seller_id: 's1', amount_units: 999, method: 'usdc' }) })).status === 403)
  ok('2c. token method != body method → 403', (await call('POST', APPROVE, true, { method: 'usdc', webauthn_token: tok({ request_id: reqId, seller_id: 's1', amount_units: 50_000_000, method: 'fiat' }) })).status === 403)
  ok('2d. approve still moved NO money after failed gates', feeRows() === 0 && avail() === 0)

  // 3. correct approve → atomic credit
  const goodTok = tok({ request_id: reqId, seller_id: 's1', amount_units: 50_000_000, method: 'usdc' })
  const appr = await call('POST', APPROVE, true, { method: 'usdc', webauthn_token: goodTok })
  ok('3a. approve → 200 + payment id', appr.status === 200 && appr.json?.ok === true && !!appr.json?.id)
  ok('3b. request status=approved + resulting_payment_id linked', (() => { const r = db.prepare('SELECT status, resulting_payment_id p FROM direct_pay_fee_prepay_requests WHERE id=?').get(reqId) as any; return r.status === 'approved' && r.p === appr.json.id })())
  ok('3c. exactly one fee payment recorded (50 USDC, evidence carried)', feeRows() === 1 && (db.prepare('SELECT amount, evidence_ref FROM direct_pay_fee_payments WHERE id=?').get(appr.json.id) as any).evidence_ref === 'BANK-9')
  ok('3d. available prepay balance now 50', avail() === 50_000_000)

  // 4. double-approve → NOT_PENDING, no second payment
  const dbl = await call('POST', APPROVE, true, { method: 'usdc', webauthn_token: goodTok })
  ok('4a. re-approve → 400 (not pending)', dbl.status === 400)
  ok('4b. no second payment, balance unchanged', feeRows() === 1 && avail() === 50_000_000)

  // 5. reject a fresh pending
  const req2 = createFeePrepayRequest(db, 's1', { amountUnits: 10_000_000, platformAccountId: 'pra1', evidenceRef: 'BANK-10' }, generateId)
  const rid2 = (req2 as any).request.id
  const REJECT = `/api/admin/direct-receive/fee-prepay-requests/${rid2}/reject`
  ok('5a. reject without token → 403', (await call('POST', REJECT, true, {})).status === 403)
  ok('5b. reject with token → 200', (await call('POST', REJECT, true, { webauthn_token: tok({ request_id: rid2 }) })).status === 200)
  ok('5c. status=rejected, no money moved by reject', (db.prepare('SELECT status FROM direct_pay_fee_prepay_requests WHERE id=?').get(rid2) as any).status === 'rejected' && feeRows() === 1)
  ok('5d. reject non-pending → 400', (await call('POST', REJECT, true, { webauthn_token: tok({ request_id: rid2 }) })).status === 400)

  if (fail > 0) { console.error(`\n❌ fee prepay review FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ fee prepay review (admin): ROOT + Passkey bound to {request,seller,amount,method} (wrong amount/method → 403) · approve atomic-credits once (payment + balance + linked) · double-approve no-op · reject pending only · no money before approve\n  ✅ pass ${pass}`)
} finally {
  server.close()
}
