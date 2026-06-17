#!/usr/bin/env tsx
/**
 * withdrawals/:id/approve — dual-accept transition for attribution (NOT final hardening).
 *   用法:npm run test:admin-withdrawal-approve-attribution
 *
 * 登录的 protocol-admin(Bearer)→ 审计记其真实 admin id(auth_method=bearer_admin);
 * 否则回落到共享 ADMIN_KEY(adminAuth)→ actor 中性标记 'admin_key'(auth_method=admin_key)。
 * 非 protocol 的 Bearer 不放行(soft 解析 null)→ 仍需 x-admin-key,不扩大访问面。
 * 审计只在出金成功后写;失败不写。绝不写入任何密钥。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerAdminWalletOpsRoutes } from '../src/pwa/routes/admin-wallet-ops.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE withdrawal_requests (id TEXT PRIMARY KEY, user_id TEXT, amount REAL, status TEXT)`)
db.prepare("INSERT INTO withdrawal_requests (id,user_id,amount,status) VALUES ('wr1','usr_b',100,'pending'),('wrf','usr_c',50,'pending')").run()
setSeamDb(db)

const audit: Array<{ adminId: string; action: string; targetId: string | null; detail: any }> = []
const logAdminAction = (adminId: string, action: string, _tt: string | null, targetId: string | null, detail?: any) => { audit.push({ adminId, action, targetId, detail }) }

// controllable per-scenario
let softAdmin: any = null            // resolveProtocolAdminSoft result
let adminKeyOk = false               // adminAuth result
let withdrawalOk = true              // executeWithdrawal result

let server: Server, port = 0
const post = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': '0' } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.end()
})

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerAdminWalletOpsRoutes(app, {
    db,
    requireProtocolAdmin: (() => ({ id: 'usr_admin' })) as any,
    adminAuth: ((_req: any, res: any) => { if (!adminKeyOk) { res.status(403).json({ error: '认证失败' }); return false } return true }) as any,
    getPublicClient: (() => ({})) as any, getUsdcAddr: (() => '0x') as any, getUsdcAbi: (() => []) as any,
    getHotWalletAddr: (() => '0x') as any, wazToUsdc: ((n: number) => n) as any,
    getIsMainnet: () => false, getNetwork: () => 'base-sepolia',
    executeWithdrawal: (async () => withdrawalOk ? { success: true as const, txHash: '0xfeed' } : { success: false as const, error: 'insufficient', txHash: undefined }) as any,
    logAdminAction: logAdminAction as any,
    resolveProtocolAdminSoft: ((_req: any) => softAdmin) as any,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) Bearer protocol-admin → real admin id + auth_method bearer_admin
  audit.length = 0; softAdmin = { id: 'usr_admin', role: 'admin' }; adminKeyOk = false; withdrawalOk = true
  { const r = await post('/api/admin/withdrawals/wr1/approve')
    ok('bearer admin → 200 + tx', r.json?.tx_hash === '0xfeed', JSON.stringify(r.json))
    const a = audit.find(x => x.action === 'withdrawal_approve')
    ok('bearer admin → audit names real admin id + bearer_admin', !!a && a.adminId === 'usr_admin' && a.detail?.auth_method === 'bearer_admin' && a.targetId === 'wr1' && a.detail?.user_id === 'usr_b' && a.detail?.amount === 100 && a.detail?.tx_hash === '0xfeed', JSON.stringify(a)) }

  // 2) x-admin-key only (no bearer admin) → actor 'admin_key' + auth_method admin_key
  audit.length = 0; softAdmin = null; adminKeyOk = true; withdrawalOk = true
  { const r = await post('/api/admin/withdrawals/wr1/approve')
    ok('x-admin-key → 200', r.json?.tx_hash === '0xfeed', JSON.stringify(r.json))
    const a = audit.find(x => x.action === 'withdrawal_approve')
    ok('x-admin-key → audit actor admin_key + auth_method admin_key', !!a && a.adminId === 'admin_key' && a.detail?.auth_method === 'admin_key', JSON.stringify(a)) }

  // 3) non-protocol bearer (soft null) + no x-admin-key → rejected, NO audit, no bypass
  audit.length = 0; softAdmin = null; adminKeyOk = false; withdrawalOk = true
  { const r = await post('/api/admin/withdrawals/wr1/approve')
    ok('no protocol bearer + no key → 403 rejected', r.status === 403, JSON.stringify(r.json))
    ok('rejected → no audit row written', audit.length === 0, JSON.stringify(audit)) }

  // 4) failed withdrawal → no audit (only on success)
  audit.length = 0; softAdmin = { id: 'usr_admin', role: 'admin' }; adminKeyOk = false; withdrawalOk = false
  { const r = await post('/api/admin/withdrawals/wrf/approve')
    ok('failed withdrawal → error, no tx', !!r.json?.error && !r.json?.tx_hash, JSON.stringify(r.json))
    ok('failed withdrawal → no audit row', audit.find(x => x.action === 'withdrawal_approve') === undefined, JSON.stringify(audit)) }

  // 5) no secret ever in the audit detail (defense): no field equals a key-like value / no ADMIN_KEY token
  audit.length = 0; softAdmin = { id: 'usr_admin' }; adminKeyOk = true; withdrawalOk = true
  { await post('/api/admin/withdrawals/wr1/approve')
    const a = audit.find(x => x.action === 'withdrawal_approve')
    const blob = JSON.stringify(a)
    ok('audit detail carries no secret/credential', !/ADMIN_KEY|x-admin-key|secret|password/i.test(blob), blob) }

  server.close()

  if (fail === 0) {
    console.log(`\n✅ withdrawal approve dual-accept attribution: bearer protocol-admin → real admin id(bearer_admin);x-admin-key → 'admin_key'(admin_key);非 protocol bearer 不放行;仅成功才写审计;审计无密钥\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ withdrawal approve attribution FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
