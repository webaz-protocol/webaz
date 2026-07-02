#!/usr/bin/env tsx
/**
 * 平台服务费预充值申请 —— 卖家侧端点。真 express + 真 helper + 真 schema。
 * 验:seller 门、看 active 平台收款方式、提交申请(凭据必填/金额>0/平台账户须 active)、看自己申请、撤销 pending;
 *   申请【不动钱】(不写 fee 余额 / direct_pay_fee_payments)。
 * Usage: npm run test:fee-prepay-request
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'fpr-'))

import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { registerFeePrepayRequestRoutes } = await import('../src/pwa/routes/fee-prepay-requests.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
let _n = 0; const generateId = (p: string): string => `${p}_${++_n}`

const db = initDatabase()
db.pragma('foreign_keys = OFF')
for (const [u, role] of [['s1', 'seller'], ['b1', 'buyer']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)
// active + inactive platform receive accounts
db.prepare("INSERT INTO platform_receive_accounts (id,label,method,currency,instruction,status) VALUES ('pra_ok','PayNow','PayNow','SGD','UEN 123','active')").run()
db.prepare("INSERT INTO platform_receive_accounts (id,method,instruction,status) VALUES ('pra_off','Bank','old','inactive')").run()

const auth = (req: Request, res: Response): Record<string, unknown> | null => {
  const uid = String(req.headers['x-user'] || ''); const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'unauth' }); return null }
  return u
}
const app = express(); app.use(express.json())
registerFeePrepayRequestRoutes(app, { db, auth, generateId })
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const call = async (method: string, path: string, user?: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j: any = null; try { j = await r.json() } catch {}
  return { status: r.status, json: j }
}
const feeRows = (): number => (db.prepare('SELECT COUNT(*) n FROM direct_pay_fee_payments').get() as { n: number }).n

try {
  // 1. role gate
  ok('1a. unauth → 401', (await call('GET', '/api/direct-receive/fee-prepay-requests')).status === 401)
  ok('1b. buyer → 403', (await call('GET', '/api/direct-receive/fee-prepay-requests', 'b1')).status === 403)

  // 2. seller sees only ACTIVE platform accounts (with instruction to pay)
  const acc = await call('GET', '/api/direct-receive/platform-receive-accounts', 's1')
  ok('2. seller sees active platform account only (with instruction)', acc.json.accounts.length === 1 && acc.json.accounts[0].id === 'pra_ok' && acc.json.accounts[0].instruction === 'UEN 123')

  // 3. submit request — evidence required, amount>0, platform account active
  ok('3a. no evidence → 400 (不能无据)', (await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 50000000, platform_account_id: 'pra_ok' })).status === 400)
  ok('3b. amount 0 → 400', (await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 0, platform_account_id: 'pra_ok', evidence_ref: 'tx1' })).status === 400)
  ok('3c. inactive platform account → 400', (await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 50000000, platform_account_id: 'pra_off', evidence_ref: 'tx1' })).status === 400)
  ok('3c2. MISSING platform_account_id → 400 (must target a WebAZ account)', (await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 50000000, evidence_ref: 'tx1' })).status === 400)
  ok('3c3. non-integer amount_units → 400 (strict, no silent truncation)', (await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 50000000.7, platform_account_id: 'pra_ok', evidence_ref: 'tx1' })).status === 400)
  const sub = await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 50000000, currency: 'sgd', platform_account_id: 'pra_ok', evidence_ref: 'BANK-REF-9', evidence_note: 'paid via app' })
  ok('3d. valid submit → pending request', sub.status === 200 && sub.json?.request?.status === 'pending' && sub.json?.request?.amount_units === 50000000)
  const reqId = sub.json.request.id
  ok('3e. currency uppercased, evidence stored', sub.json.request.currency === 'SGD' && sub.json.request.evidence_ref === 'BANK-REF-9')
  ok('3f. request moved NO money (no fee_payments row)', feeRows() === 0)

  // 4. list own
  ok('4a. seller lists own request', (await call('GET', '/api/direct-receive/fee-prepay-requests', 's1')).json.requests.some((r: any) => r.id === reqId))
  ok('4b. buyer cannot list (403)', (await call('GET', '/api/direct-receive/fee-prepay-requests', 'b1')).status === 403)

  // 5. cancel own pending
  ok('5a. cancel pending → changed', (await call('POST', `/api/direct-receive/fee-prepay-request/${reqId}/cancel`, 's1')).json?.changed === true)
  ok('5b. status now cancelled', (db.prepare('SELECT status FROM direct_pay_fee_prepay_requests WHERE id=?').get(reqId) as { status: string }).status === 'cancelled')
  ok('5c. cancel again → no change (not pending)', (await call('POST', `/api/direct-receive/fee-prepay-request/${reqId}/cancel`, 's1')).json?.changed === false)
  // other seller cannot cancel s1's request
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s2','s2','seller','k_s2')").run()
  const sub2 = await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 10000000, platform_account_id: 'pra_ok', evidence_ref: 'tx2' })
  ok('5d. non-owner cancel → no change', (await call('POST', `/api/direct-receive/fee-prepay-request/${sub2.json.request.id}/cancel`, 's2')).json?.changed === false)

  if (fail > 0) { console.error(`\n❌ fee prepay request FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ fee prepay request (seller): role-gated · sees active platform methods · evidence-required submit (no evidence/0-amount/inactive-account rejected) · lists own · cancels own pending · moves NO money\n  ✅ pass ${pass}`)
} finally {
  server.close()
}
