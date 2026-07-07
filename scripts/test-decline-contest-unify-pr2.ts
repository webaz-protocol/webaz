#!/usr/bin/env tsx
/**
 * 统一仲裁台 PR2 —— decline_contest 展示 + 待办角标 + 去重通知(裁决仍 fail-closed,PR3 打通)。
 *   用法:npm run test:decline-contest-unify-p2
 *
 * 断言:
 *   A. getOpenDisputes 现在【包含】decline_contest(PR1 的队列过滤已反转),且带出 dispute_type。
 *   B. GET /api/arbitrator/pending-count:仲裁员看到 open+in_review 计数(含 decline_contest);非仲裁员 → 0。
 *   C. notifyDeclineContestCase:扇出到 active 仲裁员 + admin;suspended 仲裁员不发;dedup —— 第二次 0 新增;
 *      backfill 与路由重复调用安全。
 *   D. 前端接线源检查:app.js 走 dcNotice 分支 + dcChip + refreshArbBadge;index.html 载入新文件;新文件挂 3 个 window.* + 通知模板。
 * 不测 PR3 裁决语义。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dcp2-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initDisputeSchema, createDeclineContestDispute, getOpenDisputes } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { notifyDeclineContestCase } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { registerDisputesReadRoutes } = await import('../src/pwa/routes/disputes-read.js')
const { registerAdminReportsRoutes } = await import('../src/pwa/routes/admin-reports.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initDisputeSchema(db); initNotificationSchema(db)
db.exec('CREATE TABLE IF NOT EXISTS arbitrator_whitelist (user_id TEXT PRIMARY KEY, status TEXT)')
for (const c of ['decline_objective_pending INTEGER', 'decline_contested INTEGER', 'decline_reason_code TEXT', 'decline_contest_deadline TEXT', 'declined_at TEXT', 'settled_fault_at TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* */ } }
for (const c of ['admin_type TEXT', 'admin_permissions TEXT']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${c}`) } catch { /* */ } }

// admin 收件人权限维度:adm1=root、admArb=arbitration 权限 → 应收到;admContent=仅 content → 【不】收到。
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s'),('buyer1','B','buyer','k_b'),('arb1','A1','buyer','k_a1'),('arb2','A2','buyer','k_a2'),('arbX','AX','buyer','k_ax'),('adm1','ADM','admin','k_adm'),('admArb','ADMA','admin','k_adma'),('admContent','ADMC','admin','k_admc')").run()
db.prepare("UPDATE users SET admin_type='root' WHERE id='adm1'").run()
db.prepare(`UPDATE users SET admin_permissions='["arbitration"]' WHERE id='admArb'`).run()
db.prepare(`UPDATE users SET admin_permissions='["content"]' WHERE id='admContent'`).run()
db.prepare("INSERT INTO arbitrator_whitelist (user_id,status) VALUES ('arb1','active'),('arb2',NULL),('arbX','suspended')").run()
const seedOrder = (id: string) => db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,decline_objective_pending,decline_contested,settled_fault_at,decline_reason_code,declined_at,decline_contest_deadline)
  VALUES (?,?,?,?,'fault_seller',30,30,30,'escrow',1,1,NULL,'force_majeure','2026-07-05 10:00:00','2026-07-08 10:00:00')`).run(id, 'buyer1', 'seller1', 'prd_x')

try {
  // ══ A. 队列过滤已反转 ══
  seedOrder('ord_A')
  const dc = createDeclineContestDispute(db, 'ord_A')
  db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status,dispute_type) VALUES ('dsp_norm','ord_A','buyer1','seller1','普通争议','open','buyer_dispute')").run()
  const list = await getOpenDisputes(db) as Array<Record<string, unknown>>
  const ids = list.map(d => d.id)
  ok('A1 普通争议在队列', ids.includes('dsp_norm'))
  ok('A2 decline_contest 现在也在队列(过滤已反转)', ids.includes(dc.disputeId))
  ok('A3 队列带出 dispute_type 字段', list.some(d => d.id === dc.disputeId && d.dispute_type === 'decline_contest'))

  // ══ B. pending-count 端点 ══
  const errorRes = (res: express.Response, s: number, code: string, msg: string) => { res.status(s).json({ error: msg, error_code: code }) }
  const app = express(); app.use(express.json())
  let who = 'arb1'
  registerDisputesReadRoutes(app, {
    db, auth: () => ({ id: who }), errorRes,
    getOpenDisputes, getDisputeDetails: async () => null, getEvidenceRequests: async () => [],
    listEvidenceFiles: async () => [], isEligibleArbitrator: (uid: string) => ({ ok: uid === 'arb1' || uid === 'arb2' }),
    isArbitrationAdmin: () => false,
  } as never)
  const server = app.listen(0); const port = (server.address() as AddressInfo).port
  const getJSON = async (p: string) => (await fetch(`http://127.0.0.1:${port}${p}`)).json() as Promise<Record<string, unknown>>
  who = 'arb1'; const cArb = await getJSON('/api/arbitrator/pending-count')
  ok('B1 仲裁员 pending-count = 2(普通 + decline_contest,均 open)', cArb.count === 2)
  who = 'buyer1'; const cBuyer = await getJSON('/api/arbitrator/pending-count')
  ok('B2 非仲裁员 pending-count = 0(不报错)', cBuyer.count === 0)
  server.close()

  // ══ C. 去重通知 + admin 权限收敛 ══
  const n1 = notifyDeclineContestCase(db, 'ord_A', dc.disputeId!)
  ok('C1 首次通知 active 仲裁员(arb1+arb2)+ 仲裁 admin(root adm1 + arbitration admArb)= 4', n1.notified === 4 && n1.skipped === 0)
  ok('C2 suspended 仲裁员 arbX 未收到', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='arbX'").get() as { n: number }).n === 0)
  ok('C2b content-only admin(admContent)未收到 —— 与 arbitration 读写权限边界一致', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='admContent'").get() as { n: number }).n === 0)
  ok('C2c root(adm1)+ arbitration(admArb)admin 均收到', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id IN ('adm1','admArb')").get() as { n: number }).n === 2)
  ok('C3 通知 type + order_id 正确 = 4', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id='ord_A' AND type='arb:decline_contest_new'").get() as { n: number }).n === 4)
  const n2 = notifyDeclineContestCase(db, 'ord_A', dc.disputeId!)
  ok('C4 第二次调用全部去重(0 新增,4 skipped)', n2.notified === 0 && n2.skipped === 4)
  ok('C5 通知总数仍为 4(无重复轰炸)', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id='ord_A' AND type='arb:decline_contest_new'").get() as { n: number }).n === 4)

  // ══ D. 前端接线源检查 ══
  const appSrc = readFileSync('src/pwa/public/app.js', 'utf8')
  ok('D1 app.js 详情走 dcNotice 分支', /dispute\.dispute_type === 'decline_contest' \? \(window\.dcNotice/.test(appSrc))
  ok('D2 app.js 列表调 dcChip', appSrc.includes('window.dcChip ? window.dcChip(d)'))
  ok('D3 app.js boot 调 refreshArbBadge', appSrc.includes('if (window.refreshArbBadge) refreshArbBadge()'))
  ok('D4 app.js ⚖️ tab 带 arbBadge + 渲染 arb-badge span', appSrc.includes("label: t('仲裁台'), arbBadge: true") && appSrc.includes('class="arb-badge"'))
  const idx = readFileSync('src/pwa/public/index.html', 'utf8')
  ok('D5 index.html 载入 app-decline-contest-ui.js', idx.includes('/app-decline-contest-ui.js'))
  const ui = readFileSync('src/pwa/public/app-decline-contest-ui.js', 'utf8')
  ok('D6 新文件挂 dcChip/dcNotice/refreshArbBadge + 通知模板', /window\.dcChip/.test(ui) && /window\.dcNotice/.test(ui) && /window\.refreshArbBadge/.test(ui) && /arb_decline_contest_new/.test(ui))

  // ══ E. admin 监督台 DTO 含 dispute_type(前端 window.dcChip(d) 依赖它才能打"拒单举证仲裁"标签)══
  const adminApp = express(); adminApp.use(express.json())
  registerAdminReportsRoutes(adminApp, { db, requireContentAdmin: () => null, requireArbitrationAdmin: () => ({ id: 'adm1' }), requireProtocolAdmin: () => null } as never)
  const aserver = adminApp.listen(0); const aport = (aserver.address() as AddressInfo).port
  const adminDisputes = (await (await fetch(`http://127.0.0.1:${aport}/api/admin/disputes`)).json()) as { disputes: Array<Record<string, unknown>> }
  aserver.close()
  const dcRow = (adminDisputes.disputes || []).find(d => d.id === dc.disputeId)
  ok('E1 admin 监督台返回该 decline_contest 行', !!dcRow)
  ok('E2 admin DTO 带 dispute_type=decline_contest(否则前端标签打不出)', dcRow?.dispute_type === 'decline_contest')

  if (fail === 0) console.log(`\n✅ decline_contest 统一台展示(PR2):队列/监督台可见 + 待办角标端点 + 去重通知(active 仲裁员+admin,suspended 排除,幂等)\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR2 FAILED\n  ✅ pass ${pass}  ❌ fail ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally {
  try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ }
}
