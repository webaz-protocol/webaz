#!/usr/bin/env tsx
/**
 * Follow-up C Slice 1 — funds + account-state admin actions must write an audit row.
 *   用法:npm run test:admin-audit-slice1
 *
 * 覆盖(全部"additive audit",不改业务逻辑、不改 schema):
 *   - POST /admin/withdrawals/:id/approve  (admin-wallet-ops)  actor=admin_key(共享 ADMIN_KEY 闸门)
 *   - POST /admin/risk/suspend|unsuspend/:user_id + kyc approve|reject  (admin-moderation)  actor=admin.id
 *   - POST /admin/users/batch-action       (admin-users-query)  actor=admin.id,一条汇总行
 * 断言:每个端点写一条 admin_audit_log(经注入的 logAdminAction),含 admin/actor、target、action、
 * result/reason where available。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerAdminWalletOpsRoutes } from '../src/pwa/routes/admin-wallet-ops.js'
import { registerAdminModerationRoutes } from '../src/pwa/routes/admin-moderation.js'
import { registerAdminUsersQueryRoutes } from '../src/pwa/routes/admin-users-query.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE withdrawal_requests (id TEXT PRIMARY KEY, user_id TEXT, amount REAL, status TEXT)`)
db.exec(`CREATE TABLE kyc_records (user_id TEXT PRIMARY KEY, status TEXT, reviewed_by TEXT, reviewed_at TEXT, reject_reason TEXT)`)
db.exec(`CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER, reason TEXT, suspended_by TEXT, suspended_at TEXT)`)
db.exec(`CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, body TEXT, order_id TEXT)`)
db.prepare("INSERT INTO withdrawal_requests (id,user_id,amount,status) VALUES ('wr1','usr_b',100,'pending')").run()
db.prepare("INSERT INTO kyc_records (user_id,status) VALUES ('usr_b','pending')").run()
setSeamDb(db)

const audit: Array<{ adminId: string; action: string; targetType: string | null; targetId: string | null; detail: any }> = []
const logAdminAction = (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: any) =>
  { audit.push({ adminId, action, targetType, targetId, detail }) }
const adminUser = { id: 'usr_admin', role: 'admin' }
const noop = () => {}

let server: Server, port = 0
const post = (path: string, body?: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = body ? JSON.stringify(body) : ''
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); if (p) r.write(p); r.end()
})
const auditFor = (action: string) => audit.find(a => a.action === action)

async function main(): Promise<void> {
  const app = express(); app.use(express.json())

  registerAdminWalletOpsRoutes(app, {
    db, requireProtocolAdmin: (() => adminUser) as any, adminAuth: (() => true) as any,
    getPublicClient: (() => ({})) as any, getUsdcAddr: (() => '0x') as any, getUsdcAbi: (() => []) as any,
    getHotWalletAddr: (() => '0x') as any, wazToUsdc: ((n: number) => n) as any,
    getIsMainnet: () => false, getNetwork: () => 'base-sepolia',
    executeWithdrawal: (async () => ({ success: true as const, txHash: '0xabc123' })) as any,
    logAdminAction: logAdminAction as any,
    resolveProtocolAdminSoft: (() => null) as any,   // no bearer admin → falls back to x-admin-key (actor 'admin_key')
  })
  registerAdminModerationRoutes(app, {
    db, generateId: (p: string) => `${p}_x`, requireUsersAdmin: (() => adminUser) as any,
    authFailures: new Map(), INTERNAL_AUDITOR_ID: 'usr_iaudit', broadcastSystemEvent: noop as any,
    logAdminAction: logAdminAction as any,
  })
  registerAdminUsersQueryRoutes(app, {
    db, requireUsersAdmin: (() => adminUser) as any,
    adminCanOperateOn: (() => true) as any, isRootAdmin: (() => true) as any, isAllowedSponsor: (() => true) as any,
    maskApiKey: ((k: string) => k) as any, computeLightTags: (() => []) as any, getAdminScope: (() => 'global') as any,
    getSellerDailyLimit: (() => 20) as any, todayStartISO: () => new Date().toISOString().slice(0, 10),
    broadcastSystemEvent: noop as any, INTERNAL_AUDITOR_ID: 'usr_iaudit', logAdminAction: logAdminAction as any,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) withdrawals/approve → audit row (actor admin_key, withdrawal id + user + amount + txHash)
  { const r = await post('/api/admin/withdrawals/wr1/approve')
    ok('approve returns tx_hash', r.json?.tx_hash === '0xabc123', JSON.stringify(r.json))
    const a = auditFor('withdrawal_approve')
    ok('approve writes audit (admin_key + withdrawal target + user/amount/tx)', !!a && a.adminId === 'admin_key' && a.targetId === 'wr1' && a.detail?.user_id === 'usr_b' && a.detail?.amount === 100 && a.detail?.tx_hash === '0xabc123', JSON.stringify(a)) }

  // 2) kyc approve / reject (reject carries reason)
  { await post('/api/admin/kyc/usr_b/approve')
    const a = auditFor('kyc_approve')
    ok('kyc approve writes audit (admin.id + target user)', !!a && a.adminId === 'usr_admin' && a.targetId === 'usr_b', JSON.stringify(a)) }
  { const r = await post('/api/admin/kyc/usr_b/reject', { reason: 'blurry id' })
    const a = auditFor('kyc_reject')
    ok('kyc reject writes audit with reason', !!a && a.adminId === 'usr_admin' && a.targetId === 'usr_b' && a.detail?.reason === 'blurry id', JSON.stringify(a)) }

  // 3) suspend (reason) / unsuspend
  { await post('/api/admin/risk/suspend/usr_b', { reason: 'spam ring' })
    const a = auditFor('risk_suspend')
    ok('suspend writes audit with reason', !!a && a.adminId === 'usr_admin' && a.targetId === 'usr_b' && a.detail?.reason === 'spam ring', JSON.stringify(a)) }
  { await post('/api/admin/risk/unsuspend/usr_b')
    const a = auditFor('risk_unsuspend')
    ok('unsuspend writes audit', !!a && a.adminId === 'usr_admin' && a.targetId === 'usr_b', JSON.stringify(a)) }

  // 4) batch-action → one summary audit row (action + reason + applied + ids)
  { const r = await post('/api/admin/users/batch-action', { user_ids: ['usr_b', 'usr_c'], action: 'suspend', reason: 'bulk wave' })
    ok('batch-action applied 2', r.json?.applied === 2, JSON.stringify(r.json))
    const a = auditFor('users_batch_suspend')
    ok('batch-action writes one summary audit (reason + applied + ids)', !!a && a.adminId === 'usr_admin' && a.detail?.reason === 'bulk wave' && a.detail?.applied === 2 && Array.isArray(a.detail?.user_ids) && a.detail.user_ids.includes('usr_b') && a.detail.user_ids.includes('usr_c'), JSON.stringify(a)) }

  server.close()

  if (fail === 0) {
    console.log(`\n✅ admin audit slice 1: withdrawals/approve + kyc approve/reject + risk suspend/unsuspend + users batch-action 全部写 admin_audit_log(actor + target + action + result/reason where available);additive,无 schema 改动\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin audit slice 1 FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
