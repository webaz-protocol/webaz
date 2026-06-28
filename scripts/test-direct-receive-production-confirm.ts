#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — admin 生产保证金 receipt 确认 (PR-4b-3 scaffold) 测试。
 * 锁住 fail-closed:confirmProductionReceipt 对所有现有 rail(manual/usdc_onchain/fiat_psp)都【抛】(assertProductionDepositRail)
 *   → production_receipt_confirmed_at 恒 NULL、sellerHasProductionBaseBondLocked 恒 false;manual-locked 旧/测试行被拒(不冒充生产);
 *   admin endpoint = ROOT + 真人 Passkey(purpose_data 绑全字段),恒返回 409 PRODUCTION_RAIL_NOT_CLEARED 且写 audit log、零行变更。
 * Usage: npm run test:direct-receive-production-confirm
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-prodconf-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')
const { openDeposit, confirmDepositReceipt, lockBond, confirmProductionReceipt, sellerHasProductionBaseBondLocked } = await import('../src/direct-receive-deposits.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime(\'now\')))')
db.prepare("INSERT OR IGNORE INTO penalty_fund (id, balance, total_fee_stake_slash, total_base_bond_slash, updated_at) VALUES ('main',0,0,0,datetime('now'))").run()
for (const u of ['root1', 'rootNoPk', 'seller1']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root1','root1')").run()  // root1 有 Passkey;rootNoPk 没有

const REQ = toUnits(500)
const prodFlag = (id: string) => (db.prepare('SELECT production_receipt_confirmed_at p FROM direct_receive_deposits WHERE id=?').get(id) as { p: string | null } | undefined)?.p
const dstatus = (id: string) => (db.prepare('SELECT status FROM direct_receive_deposits WHERE id=?').get(id) as { status: string } | undefined)?.status
const auditN = () => (db.prepare('SELECT COUNT(*) n FROM admin_audit_log').get() as { n: number }).n
const lastAudit = () => db.prepare('SELECT action, detail FROM admin_audit_log ORDER BY rowid DESC LIMIT 1').get() as { action: string; detail: string } | undefined

// ══════ Part A: helper fail-closed(所有 rail 抛;manual-locked 拒;not-found 拒)══════
openDeposit(db, { depositId: 'dU', userId: 'seller1', tier: 'T0', currency: 'usdc', depositRail: 'usdc_onchain' })
ok('confirmProductionReceipt(usdc_onchain) THROWS (GATED, legalCleared=false)', throws(() => confirmProductionReceipt(db, { depositId: 'dU', railId: 'usdc_onchain', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
ok('dU production_receipt_confirmed_at STAYS NULL', prodFlag('dU') === null)
openDeposit(db, { depositId: 'dM', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
ok('confirmProductionReceipt(manual) THROWS (isProduction=false)', throws(() => confirmProductionReceipt(db, { depositId: 'dM', railId: 'manual', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
openDeposit(db, { depositId: 'dFi', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'fiat_psp' })
ok('confirmProductionReceipt(fiat_psp) THROWS (GATED)', throws(() => confirmProductionReceipt(db, { depositId: 'dFi', railId: 'fiat_psp', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
// manual-locked(无 production receipt)旧/测试行 → 拒(不抛,显式 reason),不得冒充生产
openDeposit(db, { depositId: 'dL', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
confirmDepositReceipt(db, { depositId: 'dL', expectedAmountUnits: REQ })
lockBond(db, { depositId: 'dL' })
// assert-FIRST:manual-locked 旧/测试行 → 经 assert(manual 非生产)即抛(fail-closed),不会到达升级逻辑;production receipt 不写。
ok('manual-locked row → THROWS (assert-first, rail not production)', throws(() => confirmProductionReceipt(db, { depositId: 'dL', railId: 'manual', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
ok('dL production_receipt_confirmed_at STAYS NULL', prodFlag('dL') === null)
// not-found:assert(usdc_onchain) 在 row 读取之前即抛(assert-first)→ fail-closed。
ok('not found + gated rail → THROWS (assert-first)', throws(() => confirmProductionReceipt(db, { depositId: 'nope', railId: 'usdc_onchain', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
ok('seller-level production gate STILL false (non-launchable)', sellerHasProductionBaseBondLocked(db, 'seller1') === false)

// ══════ Part B: admin endpoint(ROOT + Passkey;恒 PRODUCTION_RAIL_NOT_CLEARED;审计;零变更)══════
const { consumeGateToken } = createHumanPresence(db, <T,>(_k: string, fb: T): T => fb)
let ac = 0
const logAdminAction = (adminId: string, action: string, tt: string | null, tid: string | null, detail?: Record<string, unknown>) =>
  db.prepare('INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)').run('au_' + (++ac), adminId, action, tt, tid, detail ? JSON.stringify(detail) : null)

const app = express(); app.use(express.json())
registerAdminDirectReceiveDepositsRoutes(app, {
  db,
  requireRootAdmin: (req: Request, res: Response) => { if (req.headers['x-root'] !== '1') { res.status(403).json({ error: 'root only' }); return null } return { id: req.headers['x-uid'] as string, role: 'admin' } },
  consumeGateToken,
  logAdminAction,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
function call(body: Record<string, unknown> | null, h: Record<string, string> = {}, id = 'dU'): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...h }
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/admin/direct-receive/deposits/${id}/confirm-production`, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } })
    })
    rq.on('error', reject); if (payload) rq.write(payload); rq.end()
  })
}
function seedToken(id: string, user: string, data: Record<string, unknown>, purpose = 'direct_receive_production_confirm'): string {
  db.prepare('INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,?)')
    .run(id, user, purpose, JSON.stringify(data), new Date(Date.now() + 60_000).toISOString())
  return id
}
const fullData = { deposit_id: 'dU', rail_id: 'usdc_onchain', amount_units: REQ, receipt_ref: 'rcpt-1', jurisdiction: 'SG' }
const body = { rail_id: 'usdc_onchain', expected_amount_units: REQ, receipt_ref: 'rcpt-1', jurisdiction: 'SG' }

// 1. non-root → 403,且【不】审计(无可信 admin 身份)
const aNon = auditN()
ok('non-root → 403', (await call(body, {})).status === 403)
ok('non-root → NOT audited (no trusted admin identity)', auditN() === aNon)
// 2. root without Passkey → 403 PASSKEY_REQUIRED + 审计(passkey_required)
const a2 = auditN()
const r2 = await call({ ...body, webauthn_token: seedToken('t_npk', 'rootNoPk', fullData) }, { 'x-root': '1', 'x-uid': 'rootNoPk' })
ok('root without Passkey → 403 PASSKEY_REQUIRED_FOR_DIRECT_PAY', r2.status === 403 && r2.json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', JSON.stringify(r2))
ok('root no-Passkey attempt AUDITED (outcome passkey_required)', auditN() === a2 + 1 && /passkey_required/.test(lastAudit()?.detail || ''), JSON.stringify(lastAudit()))
// 3. root + Passkey, no token → 403 HUMAN_PRESENCE_REQUIRED + 审计
const a3 = auditN()
const r3 = await call(body, { 'x-root': '1', 'x-uid': 'root1' })
ok('root + Passkey, no token → 403 HUMAN_PRESENCE_REQUIRED', r3.status === 403 && r3.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r3))
ok('root no-token attempt AUDITED (outcome human_presence_required)', auditN() === a3 + 1 && /human_presence_required/.test(lastAudit()?.detail || ''), JSON.stringify(lastAudit()))
// 4. purpose_data mismatch (wrong amount) → 403(validate 拒)+ 审计
const a4 = auditN()
const r4 = await call({ ...body, expected_amount_units: REQ + 1, webauthn_token: seedToken('t_mm', 'root1', fullData) }, { 'x-root': '1', 'x-uid': 'root1' })
ok('purpose_data mismatch → 403 (token bound to full action)', r4.status === 403 && r4.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r4))
ok('root purpose_data-mismatch attempt AUDITED', auditN() === a4 + 1 && /human_presence_required/.test(lastAudit()?.detail || ''), JSON.stringify(lastAudit()))
// 5. root + Passkey + valid token → 409 PRODUCTION_RAIL_NOT_CLEARED (assert 抛 → fail-closed)
const a0 = auditN()
const r5 = await call({ ...body, webauthn_token: seedToken('t_ok', 'root1', fullData) }, { 'x-root': '1', 'x-uid': 'root1' })
ok('root + Passkey + valid token → 409 PRODUCTION_RAIL_NOT_CLEARED (fail-closed)', r5.status === 409 && r5.json?.error_code === 'PRODUCTION_RAIL_NOT_CLEARED', JSON.stringify(r5))
ok('dU UNCHANGED: production_receipt_confirmed_at NULL', prodFlag('dU') === null)
ok('dU UNCHANGED: status still pending', dstatus('dU') === 'pending')
ok('ROOT attempt audited (admin_audit_log row written, outcome rail_not_cleared)', auditN() === a0 + 1 && /rail_not_cleared/.test(lastAudit()?.detail || ''), JSON.stringify(lastAudit()))
ok('seller-level production gate STILL false after endpoint (non-launchable)', sellerHasProductionBaseBondLocked(db, 'seller1') === false)

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-receive-production-confirm tests passed`)
