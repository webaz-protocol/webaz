#!/usr/bin/env tsx
/**
 * 仲裁员"已结"历史裁决修复 —— /api/disputes 现在同时返回 open+in_review + 近期 resolved/dismissed,
 *   前端"已结"sub-tab(closedList)与 todayDone KPI 才有数据(此前 getOpenDisputes 只返 open → 恒空)。
 *   用法:npm run test:arb-resolved-history
 *
 * 断言:
 *   A. getRecentResolvedDisputes 只返 resolved/dismissed(不含 open/in_review),DTO 带 join 字段,LIMIT 生效,resolved_at 倒序。
 *   B. GET /api/disputes(仲裁员)= open+in_review + 近期已结(前端 closed tab 拿得到已结行)。
 *   C. getOpenDisputes 语义不变(仍只 open+in_review)—— MCP 复用不受影响。
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arbhist-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initDisputeSchema, getOpenDisputes, getRecentResolvedDisputes } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { registerDisputesReadRoutes } = await import('../src/pwa/routes/disputes-read.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initDisputeSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('seller1','S','seller','k_s'),('arb1','A','buyer','k_a')").run()
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail) VALUES ('ord1','buyer1','seller1','prd_x','disputed',10,10,10,'escrow')").run()
// 5 争议:open / in_review / 2×resolved / dismissed
const mk = (id: string, status: string, resolvedAt: string | null) =>
  db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status,resolved_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, 'ord1', 'buyer1', 'seller1', 'reason ' + id, status, resolvedAt)
mk('dsp_open', 'open', null)
mk('dsp_review', 'in_review', null)
mk('dsp_res1', 'resolved', '2026-07-06 10:00:00')
mk('dsp_res2', 'resolved', '2026-07-07 10:00:00')
mk('dsp_dismiss', 'dismissed', '2026-07-05 10:00:00')

try {
  // ══ A. getRecentResolvedDisputes ══
  const resolved = await getRecentResolvedDisputes(db, 50) as Array<Record<string, unknown>>
  const rids = resolved.map(d => d.id)
  ok('A1 只含 resolved/dismissed(3 条)', rids.length === 3 && rids.includes('dsp_res1') && rids.includes('dsp_res2') && rids.includes('dsp_dismiss'))
  ok('A2 不含 open/in_review', !rids.includes('dsp_open') && !rids.includes('dsp_review'))
  ok('A3 DTO 带 join 字段(initiator_name/total_amount)', resolved.every(d => d.initiator_name === 'B' && d.total_amount === 10))
  ok('A4 按 resolved_at 倒序(res2 最新在前)', rids[0] === 'dsp_res2')
  const limited = await getRecentResolvedDisputes(db, 1) as Array<Record<string, unknown>>
  ok('A5 LIMIT 生效', limited.length === 1)

  // ══ C. getOpenDisputes 语义不变 ══
  const open = await getOpenDisputes(db) as Array<Record<string, unknown>>
  const oids = open.map(d => d.id)
  ok('C1 getOpenDisputes 仍只 open+in_review(MCP 复用不受影响)', oids.length === 2 && oids.includes('dsp_open') && oids.includes('dsp_review') && !oids.includes('dsp_res1'))

  // ══ B. GET /api/disputes = 待裁 + 已结 ══
  const errorRes = (res: express.Response, s: number, code: string, msg: string) => { res.status(s).json({ error: msg, error_code: code }) }
  const app = express(); app.use(express.json())
  registerDisputesReadRoutes(app, {
    db, auth: () => ({ id: 'arb1' }), errorRes, getOpenDisputes,
    getDisputeDetails: async () => null, getEvidenceRequests: async () => [], listEvidenceFiles: async () => [],
    isEligibleArbitrator: () => ({ ok: true }), isArbitrationAdmin: () => false,
  } as never)
  const server = app.listen(0); const port = (server.address() as AddressInfo).port
  const board = (await (await fetch(`http://127.0.0.1:${port}/api/disputes`)).json()) as Array<Record<string, unknown>>
  server.close()
  const bids = board.map(d => d.id)
  ok('B1 /api/disputes 含待裁(open+in_review)', bids.includes('dsp_open') && bids.includes('dsp_review'))
  ok('B2 /api/disputes 含已结(resolved/dismissed)—— 前端"已结"tab 有数据了', bids.includes('dsp_res1') && bids.includes('dsp_res2') && bids.includes('dsp_dismiss'))
  ok('B3 closedList(非 open/in_review)非空 = 5 总 - 2 待裁 = 3', board.filter(d => !['open', 'in_review'].includes(d.status as string)).length === 3)

  if (fail === 0) console.log(`\n✅ 仲裁员历史裁决修复:/api/disputes 带近期已结 → "已结"tab + todayDone KPI 有数据;getOpenDisputes 语义不变\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally { try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ } }
