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

// ── ② 双锁(2026-07-05 放行后):operator_attested/SG 真实可确认;非 SG 与自动收款轨仍 fail-closed ──
{
  D.openDeposit(db, { depositId: 'd3', userId: 's1', tier: 'T0', currency: 'usdc', depositRail: 'operator_attested', externalRef: 'TXN-2' })
  let threwUS = false
  try { D.confirmProductionReceipt(db, { depositId: 'd3', railId: 'operator_attested', expectedAmountUnits: 500_000_000, receiptRef: 'TXN-2', jurisdiction: 'US' }) } catch { threwUS = true }
  ok('6a. non-allowlisted jurisdiction still throws (SG-only)', threwUS && D.getSellerLatestDeposit(db, 's1')?.status === 'pending')
  const conf = D.confirmProductionReceipt(db, { depositId: 'd3', railId: 'operator_attested', expectedAmountUnits: 500_000_000, receiptRef: 'TXN-2', jurisdiction: 'SG' })
  const d3 = D.getSellerLatestDeposit(db, 's1')
  ok('6b. GOLDEN PATH: operator_attested/SG production-confirm → locked + receipt + terms-tied policy version', conf.ok === true
    && d3?.status === 'locked' && d3?.production_receipt_confirmed_at != null
    && (db.prepare("SELECT production_policy_version v FROM direct_receive_deposits WHERE id='d3'").get() as { v: string }).v === 'bond-terms.v1.2026-07-05')
  ok('7. production-locked row satisfies the entry gate', sellerBaseBondEntrySatisfied(db, 's1', new Date().toISOString()) === true)
  let threwAuto = false
  try { D.confirmProductionReceipt(db, { depositId: 'd3', railId: 'usdc_onchain', expectedAmountUnits: 500_000_000, receiptRef: 'x', jurisdiction: 'SG' }) } catch { threwAuto = true }
  ok('6c. automated rails (usdc_onchain) still hard-gated', threwAuto)
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
  db.prepare("INSERT INTO platform_receive_accounts (id,method,currency,instruction,status) VALUES ('pacc_usdc','USDC','USDC','base:0xABC','active'),('pacc_sgd','PayNow','SGD','UEN 123','active')").run()
  const st = await call('GET', '/api/direct-receive/bond-status', 's1')
  ok('9. bond-status(放行后): required 500 + rail cleared + 多币种账户 + 条款载荷', st.status === 200
    && (st.json.required as { display: number }).display === 500 && st.json.rail_cleared === true
    && (st.json.payment_accounts as unknown[]).length === 2
    && (st.json.terms as { version: string }).version === 'bond-terms.v1.2026-07-05')
  ok('10a. submit without terms agreement → 428 TERMS_NOT_AGREED (terms payload returned)', (await (async () => {
    const r = await call('POST', '/api/direct-receive/bond-deposit', 's1', { evidence_ref: 'TXN-9', platform_account_id: 'pacc_usdc' })
    return r.status === 428 && !!(r.json.terms as { zh: string })?.zh
  })()))
  ok('10b. submit without account → 400 PLATFORM_ACCOUNT_REQUIRED', (await call('POST', '/api/direct-receive/bond-deposit', 's1', { evidence_ref: 'TXN-9', agree_terms_version: 'bond-terms.v1.2026-07-05' })).status === 400)
  ok('10c. stale terms version rejected', (await call('POST', '/api/direct-receive/bond-deposit', 's1', { evidence_ref: 'TXN-9', platform_account_id: 'pacc_sgd', agree_terms_version: 'bond-terms.v0' })).status === 428)
  const okSub = await call('POST', '/api/direct-receive/bond-deposit', 's1', { evidence_ref: 'TXN-9', platform_account_id: 'pacc_sgd', agree_terms_version: 'bond-terms.v1.2026-07-05' })
  const subRow = D.getSellerLatestDeposit(db, 's1')
  ok('10d. full submit → pending + terms/account/currency(fiat from SGD account)snapshotted + admin notified', okSub.status === 200
    && subRow?.status === 'pending' && (subRow as unknown as { terms_version?: string }).terms_version === 'bond-terms.v1.2026-07-05'
    && subRow?.currency === 'fiat'
    && (db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id='root1' AND type='bond_deposit_submitted'").get() as { c: number }).c === 1,
    JSON.stringify({ st: okSub.status, j: okSub.json, row: subRow && { s: subRow.status, tv: (subRow as never as { terms_version?: string }).terms_version, c: subRow.currency }, n: (db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id='root1'").get() as { c: number }).c }))
  db.prepare("UPDATE direct_receive_deposits SET status='expired' WHERE id=?").run(subRow!.id)
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
  const UIR = UI + readFileSync('src/pwa/public/app-bond-refund-ui.js', 'utf8') + readFileSync('src/pwa/public/app-bond-slash-ui.js', 'utf8')   // B2/B3:姊妹文件注册
  const registered = new Set([...UIR.matchAll(/^\s{4}(bond_\w+):/gm)].map(m => m[1]))
  const missingKeys = emitted.filter(k => !registered.has(k))
  ok('16. every server bond_* templateKey registered client-side', emitted.length >= 5 && missingKeys.length === 0, missingKeys.join(','))
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
