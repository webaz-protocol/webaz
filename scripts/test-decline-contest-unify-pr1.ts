#!/usr/bin/env tsx
/**
 * 统一仲裁台 PR1 —— decline_contest 并入 disputes 的数据模型 + 建行 + fail-closed 过滤 + backfill。
 *   用法:npm run test:decline-contest-unify-p1
 *
 * 断言(PR1 只做"能进、别错结",不做展示/裁决):
 *   A. createDeclineContestDispute:正确字段(type/initiator=seller/defendant=buyer/status=open);
 *      幂等——重复调用 existing=true 且只有一行;部分唯一索引挡手工重复 INSERT;非合格订单被拒。
 *   B. getOpenDisputes 过滤掉 decline_contest(仲裁员队列在 PR2 前看不到)。
 *   C. checkDisputeTimeouts 跳过 decline_contest(PR3 前绝不自动结算)。
 *   D. arbitrate 路由对 decline_contest 硬拒 409(在 arbitrateDispute/结算之前拦截 —— spy 证明未被调用)。
 *   E. backfill 机制:候选查询命中卡住单 → createDeclineContestDispute 建行;重跑 0 新增(幂等)。
 * 不碰钱路结算函数;不测 PR3 的裁决语义。
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'declctst-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initDisputeSchema, createDeclineContestDispute, getOpenDisputes, getDisputeDetails } =
  await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { registerDisputesWriteRoutes } = await import('../src/pwa/routes/disputes-write.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initDisputeSchema(db)
// 订单上 PR1 用到的拒单标志列(防 fresh DB 缺列;幂等)。
for (const c of [
  'decline_objective_pending INTEGER', 'decline_contested INTEGER', 'decline_reason_code TEXT',
  'decline_contest_deadline TEXT', 'declined_at TEXT', 'settled_fault_at TEXT',
]) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* 已存在 */ } }

// ── 种子:卖家/买家 + 一条已举证的客观拒单单 ──
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('sys_protocol','sys','admin','k_sys'),('seller1','S','seller','k_s'),('buyer1','B','buyer','k_b'),('arb1','A','buyer','k_a')").run()
const seedOrder = (id: string, over: Record<string, unknown> = {}) => {
  const o = { status: 'fault_seller', decline_objective_pending: 1, decline_contested: 1, settled_fault_at: null,
    decline_reason_code: 'force_majeure', declined_at: '2026-07-05 10:00:00', decline_contest_deadline: '2026-07-08 10:00:00', ...over }
  db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,
      decline_objective_pending,decline_contested,settled_fault_at,decline_reason_code,declined_at,decline_contest_deadline)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'buyer1', 'seller1', 'prd_x', o.status, 30, 30, 30, 'escrow',
      o.decline_objective_pending, o.decline_contested, o.settled_fault_at, o.decline_reason_code, o.declined_at, o.decline_contest_deadline)
}

try {
  // ══ A. createDeclineContestDispute ══
  seedOrder('ord_A')
  const r1 = createDeclineContestDispute(db, 'ord_A')
  ok('A1 建行成功 + 返回 disputeId', r1.success === true && !!r1.disputeId && !r1.existing)
  const row = db.prepare('SELECT * FROM disputes WHERE id=?').get(r1.disputeId) as Record<string, unknown>
  ok('A2 dispute_type=decline_contest', row.dispute_type === 'decline_contest')
  ok('A3 initiator=卖家, defendant=买家', row.initiator_id === 'seller1' && row.defendant_id === 'buyer1')
  ok('A4 status=open', row.status === 'open')
  ok('A5 不改 order.status(仍 fault_seller)', (db.prepare('SELECT status FROM orders WHERE id=?').get('ord_A') as { status: string }).status === 'fault_seller')

  const r2 = createDeclineContestDispute(db, 'ord_A')
  ok('A6 幂等:重复调用 existing=true 且同一 disputeId', r2.success === true && r2.existing === true && r2.disputeId === r1.disputeId)
  ok('A7 幂等:订单只有一行 decline_contest dispute', (db.prepare("SELECT COUNT(*) n FROM disputes WHERE order_id='ord_A' AND dispute_type='decline_contest'").get() as { n: number }).n === 1)

  let dupBlocked = false
  try { db.prepare("INSERT INTO disputes (id,order_id,initiator_id,reason,status,dispute_type) VALUES ('dsp_dup','ord_A','seller1','x','open','decline_contest')").run() }
  catch { dupBlocked = true }
  ok('A8 部分唯一索引挡手工重复 INSERT', dupBlocked === true)

  seedOrder('ord_notcontested', { decline_contested: 0 })
  const r3 = createDeclineContestDispute(db, 'ord_notcontested')
  ok('A9 非【已举证】订单被拒(未 contested)', r3.success === false)
  ok('A10 未知订单被拒', createDeclineContestDispute(db, 'ord_missing').success === false)

  // ══ B. getOpenDisputes 队列 ══(PR2 已反转 PR1 的队列过滤 → decline_contest 现在可见;裁决仍 fail-closed,见 C/D)
  db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status,dispute_type) VALUES ('dsp_norm','ord_A','buyer1','seller1','普通买家争议','open','buyer_dispute')").run()
  const openList = await getOpenDisputes(db)
  const ids = openList.map(d => (d as Record<string, unknown>).id)
  ok('B1 普通争议在仲裁员队列里', ids.includes('dsp_norm'))
  ok('B2 decline_contest 现已在仲裁员队列(PR2 反转了 PR1 的队列过滤;可见但裁决仍 409)', ids.includes(r1.disputeId))

  // ══ C. arbitrate 路由:decline_contest 只收专用两选,通用枚举(refund_buyer)被拒(PR3 ruling-order)══
  //   裁决语义 / 单事务防双结算 / 四段式超时 见 PR3 专测(test-decline-contest-unify-pr3.ts)。
  let arbitrateCalled = false
  const errorRes = (res: express.Response, status: number, code: string, msg: string) => { res.status(status).json({ error: msg, error_code: code }) }
  const app = express(); app.use(express.json())
  registerDisputesWriteRoutes(app, {
    db,
    auth: () => ({ id: 'arb1' }),
    generateId: (p: string) => `${p}_t`,
    detectFraud: () => [], errorRes,
    isEligibleArbitrator: () => ({ ok: true }),
    requireHumanPresence: () => ({ ok: true }),
    getDisputeDetails,
    arbitrateDispute: () => { arbitrateCalled = true; return { success: true } },  // spy:一旦被调用即视为越过了 fail-closed
    logAdminAction: () => {},
  } as never)
  const server = app.listen(0); const port = (server.address() as AddressInfo).port
  const rr = await fetch(`http://127.0.0.1:${port}/api/disputes/${r1.disputeId}/arbitrate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruling: 'refund_buyer', reason: '试图用通用裁决', webauthn_token: 'x' }),
  })
  const rb = await rr.json().catch(() => ({})) as Record<string, unknown>
  server.close()
  ok('C1 decline_contest + 通用 ruling(refund_buyer) → 400 BAD_DECISION(按 dispute_type 选 allowlist)', rr.status === 400 && rb.error_code === 'BAD_DECISION')
  ok('C2 通用 arbitrateDispute 从未被调用(decline_contest 不走通用路径)', arbitrateCalled === false)

  // ══ E. backfill 机制(候选查询 + 幂等) ══
  const backfillCandidates = () => db.prepare(`
    SELECT o.id FROM orders o
    WHERE o.status='fault_seller' AND COALESCE(o.decline_objective_pending,0)=1 AND COALESCE(o.decline_contested,0)=1
      AND o.settled_fault_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id=o.id AND d.dispute_type='decline_contest')`).all() as Array<{ id: string }>
  seedOrder('ord_stuck')   // 卡住的历史单,尚无 dispute 行
  const before = backfillCandidates().map(c => c.id)
  ok('E1 backfill 候选命中卡住单', before.includes('ord_stuck'))
  ok('E2 backfill 候选不含已建行单', !before.includes('ord_A') && !before.includes('ord_C'))
  for (const c of before) createDeclineContestDispute(db, c)
  ok('E3 apply 后卡住单已建行', (db.prepare("SELECT COUNT(*) n FROM disputes WHERE order_id='ord_stuck' AND dispute_type='decline_contest'").get() as { n: number }).n === 1)
  ok('E4 重跑候选为空(幂等,0 新增)', backfillCandidates().length === 0)

  if (fail === 0) {
    console.log(`\n✅ decline_contest 并入 disputes(PR1 + PR2 队列反转):建行幂等 + 裁决 fail-closed(自动裁决 skip + arbitrate 409)+ backfill 幂等\n  ✅ pass ${pass}\n  ❌ fail ${fail}`)
  } else {
    console.error(`\n❌ PR1 FAILED\n  ✅ pass ${pass}\n  ❌ fail ${fail}\n${fails.join('\n')}`); process.exitCode = 1
  }
} finally {
  try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ }
}
