#!/usr/bin/env tsx
/**
 * seller self-fulfill ship — accepted -> shipped without a logistics company (behavioral + static).
 *   用法:npm run test:seller-self-fulfill-ship
 *
 * Phase 1 默认 seller self-fulfill:ship 不传 logistics_company_id → logistics_id 留空,卖家自负后续流转。
 * 后端单发 + 批量发都应允许自发货;UI 发货弹窗给「自己发货 / 选物流公司」二选一。
 * 本测试覆盖 accepted->shipped 入口(单 + 批),不只测发货后的 pickup/transit/deliver。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerOrdersActionRoutes } from '../src/pwa/routes/orders-action.js'
import { transition as realTransition } from '../src/layer0-foundation/L0-2-state-machine/engine.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, logistics_id TEXT, status TEXT, fulfillment_mode TEXT DEFAULT 'shipping', total_amount REAL DEFAULT 100, updated_at TEXT, ship_deadline TEXT)`)
db.exec(`CREATE TABLE evidence (id TEXT PRIMARY KEY, order_id TEXT, uploader_id TEXT, type TEXT, description TEXT, file_hash TEXT, flag_reasons TEXT)`)
db.exec(`CREATE TABLE order_state_history (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT, actor_id TEXT, actor_role TEXT, evidence_ids TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('usr_seller','S','seller','k_s'),('usr_buyer','B','buyer','k_b'),('usr_logi','L','logistics','k_l')").run()
setSeamDb(db)

const seedOrder = (id: string) => db.prepare("INSERT INTO orders (id,buyer_id,seller_id,logistics_id,status) VALUES (?, 'usr_buyer','usr_seller',NULL,'accepted')").run(id)

// ⚠️ 用【真实】状态机 transition(不是桩)。accepted→shipped requiresEvidence,这样才能抓到
// "批量自发货无单号 → evIds 空 → 被状态机拒绝" 的真 bug(原桩版假绿)。
const transition = realTransition
const noop = () => {}

let server: Server, port = 0
const call = (method: string, path: string, uid: string, body?: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = body ? JSON.stringify(body) : ''
  const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'x-test-uid': uid, 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); if (p) r.write(p); r.end()
})
const ord = (id: string) => db.prepare("SELECT status, logistics_id FROM orders WHERE id=?").get(id) as any

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerOrdersActionRoutes(app, {
    db,
    auth: ((req: Request) => { const id = req.headers['x-test-uid'] as string; return id ? (db.prepare('SELECT * FROM users WHERE id=?').get(id) as any) : null }) as any,
    isTrustedRole: (() => false) as any,
    generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`,
    transition: transition as any, notifyTransition: noop as any,
    settleOrder: noop as any, settleFault: noop as any, detectFraud: (() => []) as any,
    createDispute: noop as any, checkTimeouts: noop as any, recordViolationReputation: noop as any,
    broadcastSystemEvent: noop as any,
  } as any)
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) 单发:自发货(不传 logistics_company_id)→ shipped + logistics_id 仍为空。
  //    PWA handleAction 始终带 evidence_description(自发货也有文字证据),这里照此发。
  seedOrder('o1')
  { const r = await call('POST', '/api/orders/o1/action', 'usr_seller', { action: 'ship', evidence_description: '卖家自己发货（自提自送）' })
    ok('single ship self-fulfill (no company) → success', !r.json?.error, JSON.stringify(r.json))
    const o = ord('o1')
    ok('single self-fulfill → status shipped', o.status === 'shipped', JSON.stringify(o))
    ok('single self-fulfill → logistics_id stays NULL', o.logistics_id == null, JSON.stringify(o)) }

  // 2) 单发:指定物流公司 → 绑定 logistics_id
  seedOrder('o2')
  { const r = await call('POST', '/api/orders/o2/action', 'usr_seller', { action: 'ship', logistics_company_id: 'usr_logi', evidence_description: '已交付物流公司' })
    const o = ord('o2')
    ok('single ship with company → logistics_id bound', o.status === 'shipped' && o.logistics_id === 'usr_logi', JSON.stringify(o)) }

  // 3) 批量:自发货(无 company,无单号)→ 仍 shipped + logistics_id 空。
  //    这是 P1 回归点:batch route 必须【始终】写文字 evidence,否则真实状态机 requiresEvidence 会拒(shipped:0)。
  seedOrder('b1'); seedOrder('b2')
  { const r = await call('POST', '/api/orders/batch-ship', 'usr_seller', { order_ids: ['b1', 'b2'] })
    ok('batch ship self-fulfill (no company, no tracking) → shipped:2 (real state machine accepts)', r.json?.success === true && r.json?.shipped === 2, JSON.stringify(r.json))
    ok('batch self-fulfill → status shipped', ord('b1').status === 'shipped' && ord('b2').status === 'shipped')
    ok('batch self-fulfill → logistics_id stays NULL', ord('b1').logistics_id == null && ord('b2').logistics_id == null) }

  // 4) 批量:无效 company → 400(只有传了才校验)
  seedOrder('b3')
  { const r = await call('POST', '/api/orders/batch-ship', 'usr_seller', { order_ids: ['b3'], logistics_company_id: 'usr_buyer' })
    ok('batch ship with non-logistics id → 400', r.status === 400, JSON.stringify(r.json)) }

  // 5) 批量:有效 company → 绑定
  seedOrder('b4')
  { const r = await call('POST', '/api/orders/batch-ship', 'usr_seller', { order_ids: ['b4'], logistics_company_id: 'usr_logi' })
    ok('batch ship with valid company → bound + shipped', r.json?.shipped === 1 && ord('b4').logistics_id === 'usr_logi', JSON.stringify(r.json)) }

  server.close()

  // ── static UI contract ──────────────────────────────────────
  const appJs = readFileSync('src/pwa/public/app.js', 'utf8')
  const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('single ship form offers a self-fulfill option', /<option value="self">\$\{t\('📦 我自己发货（自提自送）'\)\}/.test(appJs))
  ok('single ship form no longer hard-requires a logistics company', !/请选择物流公司/.test(appJs))
  ok('handleAction: self choice ships without a company', /const choice = sel\?\.value \|\| 'self'[\s\S]{0,400}choice === 'self'[\s\S]{0,200}logisticsCompanyId = ''/.test(appJs))
  ok('batch ship modal offers self-fulfill + no longer blocks when no companies', /id="bs-logistics"[\s\S]{0,160}<option value="self">/.test(appJs) && !/暂无可用物流公司/.test(appJs))
  ok('submitBatchShip omits logistics_company_id on self', /choice && choice !== 'self'[\s\S]{0,120}order_ids: ids, logistics_company_id: choice[\s\S]{0,40}\{ order_ids: ids \}/.test(appJs))
  ok('honest copy: self-fulfill still seller responsibility', /自己发货：你负责揽收 \/ 运输 \/ 送达,超时或虚假发货仍按卖家责任处理。/.test(appJs))
  for (const k of ['发货方式', '📦 我自己发货（自提自送）']) {
    ok(`i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
  }

  if (fail === 0) {
    console.log(`\n✅ seller self-fulfill ship: 单发+批量都允许不传物流公司(logistics_id 留空 → self-fulfill);传了才校验+绑定;UI 发货「自己发货/选物流公司」二选一 + 诚实责任文案 + i18n;覆盖 accepted->shipped 入口\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ seller self-fulfill ship FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
