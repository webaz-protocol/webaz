#!/usr/bin/env tsx
/**
 * 商家履约保证金缴纳闭环(B1)—— 域扩展 + 卖家申报路由 + admin 队列/驳回 + 双锁 fail-closed + UI 静态锚。
 * Usage: npm run test:bond-deposit-flow
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'bondb1-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const D = await import('../src/direct-receive-deposits.js')
const { sellerBaseBondEntrySatisfied } = await import('../src/direct-pay-base-bond-entry.js')
const { registerBondSellerRoutes } = await import('../src/pwa/routes/bond-seller.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initNotificationSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN admin_type TEXT') } catch { /* 已存在(生产为 server.ts 内联 ALTER) */ }
db.prepare("INSERT INTO users (id,name,role,api_key,admin_type) VALUES ('s1','s1','seller','k_s1',NULL),('b1','b1','buyer','k_b1',NULL),('root1','root1','admin','k_r','root')").run()
let n = 0; const generateId = (p: string): string => `${p}_${++n}`

// ── ① 域:openDeposit 带凭据 + rejectDeposit + latest ──
{
  const r = D.openDeposit(db, { depositId: 'd1', userId: 's1', tier: 'T0', currency: 'usdc', depositRail: 'operator_attested', externalRef: 'TXN-BOND-1' })
  ok('1. openDeposit stores evidence at open', r.ok === true && D.getSellerLatestDeposit(db, 's1')?.external_ref === 'TXN-BOND-1')
  const rej = D.rejectDeposit(db, { depositId: 'd1', note: '查无此转账' })
  const row = D.getSellerLatestDeposit(db, 's1')
  ok('2. rejectDeposit → expired + note', rej.ok === true && row?.status === 'expired' && row?.reject_note === '查无此转账')
  ok('3. reject idempotent', (D.rejectDeposit(db, { depositId: 'd1' }) as { already?: boolean }).already === true)
  // locked 不可驳
  D.openDeposit(db, { depositId: 'd2', userId: 's1', tier: 'T0', currency: 'usdc', depositRail: 'manual' })
  D.confirmDepositReceipt(db, { depositId: 'd2', expectedAmountUnits: 500_000_000 })
  D.lockBond(db, { depositId: 'd2' })
  ok('4. locked deposit cannot be rejected', D.rejectDeposit(db, { depositId: 'd2' }).ok === false)
  ok('5. manual lock ≠ production bond (entry gate still closed)', sellerBaseBondEntrySatisfied(db, 's1', new Date().toISOString()) === false)
  db.prepare("UPDATE direct_receive_deposits SET status='expired' WHERE id='d2'").run()
}

// ── ② 双锁 fail-closed:operator_attested 生产确认当前必然被 Lock B 拒 ──
{
  D.openDeposit(db, { depositId: 'd3', userId: 's1', tier: 'T0', currency: 'usdc', depositRail: 'operator_attested', externalRef: 'TXN-2' })
  let threw = false
  try { D.confirmProductionReceipt(db, { depositId: 'd3', railId: 'operator_attested', expectedAmountUnits: 500_000_000, receiptRef: 'TXN-2', jurisdiction: 'SG' }) } catch { threw = true }
  ok('6. confirmProductionReceipt throws while Lock B registry closed (fail-closed)', threw
    && D.getSellerLatestDeposit(db, 's1')?.status === 'pending')
  // 手工模拟"放行后已锁定"的行,验证入场门读法
  db.prepare("UPDATE direct_receive_deposits SET status='locked', production_receipt_confirmed_at=datetime('now') WHERE id='d3'").run()
  ok('7. production-locked row satisfies the entry gate', sellerBaseBondEntrySatisfied(db, 's1', new Date().toISOString()) === true)
  db.prepare("UPDATE direct_receive_deposits SET status='expired', production_receipt_confirmed_at=NULL WHERE id='d3'").run()
}

// ── ③ HTTP:卖家申报路由(Lock B 关 → 申报被 409;状态卡诚实提示)──
const app = express(); app.use(express.json())
registerBondSellerRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined; if (!u) { res.status(401).json({ error: 'login' }); return null } return u },
  generateId,
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
} as never)
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})
try {
  ok('8. buyer has no bond surface (403)', (await call('GET', '/api/direct-receive/bond-status', 'b1')).status === 403)
  const st = await call('GET', '/api/direct-receive/bond-status', 's1')
  ok('9. bond-status: required T0 = 500 USDC + rail NOT cleared + honest note + no payment accounts', st.status === 200
    && (st.json.required as { display: number }).display === 500 && st.json.rail_cleared === false
    && (st.json.rail_blockers as string[]).length > 0 && (st.json.payment_accounts as unknown[]).length === 0
    && String(st.json.note).includes('待平台放行'))
  ok('10. submit while Lock B closed → 409 BOND_RAIL_NOT_CLEARED (fail-closed, no misleading queue)',
    (await call('POST', '/api/direct-receive/bond-deposit', 's1', { evidence_ref: 'TXN-9' })).status === 409)
  // 模拟"已放行"验证申报全链:直接调 openDeposit(绕过 rail 门,与放行后行为一致)后走撤回
  D.openDeposit(db, { depositId: 'd4', userId: 's1', tier: 'T0', currency: 'usdc', depositRail: 'operator_attested', externalRef: 'TXN-10' })
  const cx = await call('POST', '/api/direct-receive/bond-deposit/d4/cancel', 's1')
  ok('11. seller cancels own pending declaration', cx.status === 200 && D.getSellerLatestDeposit(db, 's1')?.status === 'expired')
  ok('12. cancel non-pending → 409', (await call('POST', '/api/direct-receive/bond-deposit/d4/cancel', 's1')).status === 409)
} finally { server.close() }

// ── ④ 静态:UI 接线 + 通知 key 覆盖 + i18n parity + admin 端点存在 ──
{
  const APP = readFileSync('src/pwa/public/app.js', 'utf8')
  const UI = readFileSync('src/pwa/public/app-bond-ui.js', 'utf8')
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  const ADM = readFileSync('src/pwa/routes/admin-direct-receive-deposits.ts', 'utf8')
  const SEL = readFileSync('src/pwa/routes/bond-seller.ts', 'utf8')
  ok('13. seller settings card chained + hydrated', /window\.bondSellerSection \? window\.bondSellerSection\(\)/.test(APP) && /window\.bondHydrateSeller && window\.bondHydrateSeller\(\)/.test(APP))
  ok('14. admin route case wired', /params\[0\] === 'bond-deposits'\) return renderAdminBondDeposits\(app\)/.test(APP))
  ok('15. hub link added', /#admin\/bond-deposits/.test(readFileSync('src/pwa/public/app-direct-pay-fee-ops.js', 'utf8')))
  const emitted = [...new Set([...(SEL + ADM).matchAll(/templateKey: '(bond_[a-z_]+)'/g)].map(m => m[1]))]
  const UIR = UI + readFileSync('src/pwa/public/app-bond-refund-ui.js', 'utf8')   // B2:退还模板注册在姊妹文件
  const registered = new Set([...UIR.matchAll(/^\s{4}(bond_\w+):/gm)].map(m => m[1]))
  ok('16. every server bond_* templateKey registered client-side', emitted.length === 5 && emitted.every(k => registered.has(k)), emitted.join(','))
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
  for (const m of UI.matchAll(/P\('[^']*', '([^']*)', '([^']*)'\)/g)) { keys.add(m[1]); keys.add(m[2]) }
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('17. i18n parity', noEn.length === 0, noEn.slice(0, 3).join(' | '))
  ok('18. admin queue + reject endpoints exist', /app\.get\('\/api\/admin\/direct-receive\/deposits'/.test(ADM) && /deposits\/:id\/reject/.test(ADM))
  ok('19. UI confirm passkey purpose matches whitelist', /requestPasskeyGate\('direct_receive_production_confirm'/.test(UI))
}

if (fail > 0) { console.error(`\n❌ bond-deposit-flow FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bond deposit flow (B1): open-with-evidence + reject + latest + double-lock fail-closed + seller routes (status/submit-gated/cancel) + admin queue/reject + UI anchors + notif/i18n coverage\n  ✅ pass ${pass}`)
