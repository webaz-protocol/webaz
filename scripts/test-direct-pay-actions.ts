#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) 买家动作 ROUTE 级回归测试(审计 P1-1 + P2)。
 * 真 express + 真 state-machine transition + 真 releaseFeeStake,验证 /api/orders/:id/action 入口:
 *   - 买家 mark_paid:direct_p2p && direct_pay_window → accepted(契约 v6 广告的转移现在【真实可执行】)。
 *   - 买家 cancel:direct_pay_window → cancelled 且【原子释放】费用质押(P2:已取消单超时 cron 不再扫)。
 *   - 仅 buyer / 仅 direct_p2p / 仅付款窗口(卖家、escrow 单、非窗口状态全部被拦)。
 * Usage: npm run test:direct-pay-actions
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-actions-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { lockFeeStake, takeFeeAtCompletion } = await import('../src/direct-pay-ledger.js')
const { walletUnits } = await import('../src/ledger.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)                 // 路由 handler 用 dbOne/dbAll(seam 单例)读单
initOrderChainSchema(db)      // order_events(transition 的 append-only 事件链)
try { db.exec("ALTER TABLE orders ADD COLUMN fulfillment_mode TEXT DEFAULT 'shipped'") } catch {}  // server-boot ALTER(schema.ts 不含)
initSystemUser(db)
db.exec('CREATE TABLE IF NOT EXISTS protocol_reserve_pool (id INTEGER PRIMARY KEY, balance REAL DEFAULT 0)')
db.prepare('INSERT OR IGNORE INTO protocol_reserve_pool (id, balance) VALUES (1, 0)').run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('sys_protocol', 0)").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('buyer1','买家','buyer','k_b1')").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('seller1','卖家','seller','k_s1')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('buyer1', 0)").run()

const FEE = toUnits(5)
const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string } | undefined)?.status
const stakeStatus = (id: string) => (db.prepare('SELECT status FROM direct_pay_fee_stakes WHERE order_id=?').get(id) as { status?: string } | undefined)?.status

function mkOrder(id: string, st: string, rail: string, fulfillment = 'shipped'): void {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode)
     VALUES (?, 'p1','buyer1','seller1',1,50,50,0,?,?,?)`).run(id, st, rail, fulfillment)
}

// ── boot express with real transition + real releaseFeeStake; stub the rest ──
let counter = 0
const app = express(); app.use(express.json())
registerOrdersActionRoutes(app, {
  db,
  auth: (req: Request, res: Response) => {
    const uid = req.headers['x-test-uid'] as string | undefined
    if (!uid) { res.status(401).json({ error: 'login required' }); return null }
    const role = (req.headers['x-test-role'] as string) || 'buyer'
    return { id: uid, role }
  },
  isTrustedRole: () => false,
  generateId: (p: string) => `${p}_${++counter}`,
  transition,
  notifyTransition: () => {},
  // 忠实镜像 server.ts settleOrder 的 direct_p2p 分支(含内层 db.transaction):取费失败即抛 → 验证 orders-action 的原子回滚。
  settleOrder: (orderId: string) => db.transaction(() => {
    const o = db.prepare('SELECT payment_rail FROM orders WHERE id=?').get(orderId) as { payment_rail?: string } | undefined
    if (o?.payment_rail === 'direct_p2p') { takeFeeAtCompletion(db, { orderId }); return }
  })(),
  settleFault: () => {},
  detectFraud: () => [],
  createDispute: () => {},
  checkTimeouts: () => ({ details: [] }),
  recordViolationReputation: () => {},
  broadcastSystemEvent: () => {},
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })

function callPath(path: string, body: Record<string, unknown>, uid?: string, role?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (uid) headers['x-test-uid'] = uid
    if (role) headers['x-test-role'] = role
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null }) } catch { resolve({ status: res.statusCode || 0, json: data }) } })
    })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}
const call = (orderId: string, body: Record<string, unknown>, uid?: string, role?: string) => callPath(`/api/orders/${orderId}/action`, body, uid, role)

// ── 1. buyer mark_paid:direct_pay_window → accepted(契约 v6 转移真实可执行)──
mkOrder('o1', 'direct_pay_window', 'direct_p2p')
lockFeeStake(db, { orderId: 'o1', sellerId: 'seller1', feeUnits: FEE, stakeId: 's1' })
const r1 = await call('o1', { action: 'mark_paid' }, 'buyer1', 'buyer')
ok('buyer mark_paid → 200', r1.status === 200, JSON.stringify(r1))
ok('buyer mark_paid → status accepted', status('o1') === 'accepted', `status=${status('o1')}`)
ok('mark_paid does NOT touch fee-stake (still locked until completion)', stakeStatus('o1') === 'locked')

// ── 2. 卖家不能 mark_paid(仅 buyer)──
mkOrder('o2', 'direct_pay_window', 'direct_p2p')
lockFeeStake(db, { orderId: 'o2', sellerId: 'seller1', feeUnits: FEE, stakeId: 's2' })
const r2 = await call('o2', { action: 'mark_paid' }, 'seller1', 'seller')
ok('seller mark_paid → 403 NOT_ORDER_BUYER', r2.status === 403 && r2.json?.error_code === 'NOT_ORDER_BUYER', JSON.stringify(r2))
ok('seller mark_paid leaves status unchanged', status('o2') === 'direct_pay_window')

// ── 3. buyer cancel:direct_pay_window → cancelled + 原子释放费用质押(P2)──
mkOrder('o3', 'direct_pay_window', 'direct_p2p')
lockFeeStake(db, { orderId: 'o3', sellerId: 'seller1', feeUnits: FEE, stakeId: 's3' })
const feeStakedBefore = walletUnits(db, 'seller1').fee_staked
const balBefore = walletUnits(db, 'seller1').balance
const r3 = await call('o3', { action: 'cancel' }, 'buyer1', 'buyer')
ok('buyer cancel → 200 fee_stake_released', r3.status === 200 && r3.json?.fee_stake_released === true, JSON.stringify(r3))
ok('buyer cancel → status cancelled', status('o3') === 'cancelled', `status=${status('o3')}`)
ok('cancel released fee-stake (status released)', stakeStatus('o3') === 'released')
ok('cancel restored seller balance, fee_staked back down', walletUnits(db, 'seller1').balance === balBefore + FEE && walletUnits(db, 'seller1').fee_staked === feeStakedBefore - FEE)

// ── 4. 非 direct_p2p(escrow)单不能 mark_paid ──
mkOrder('o4', 'created', 'escrow')
const r4 = await call('o4', { action: 'mark_paid' }, 'buyer1', 'buyer')
ok('escrow order mark_paid → 409 NOT_DIRECT_PAY_WINDOW', r4.status === 409 && r4.json?.error_code === 'NOT_DIRECT_PAY_WINDOW', JSON.stringify(r4))
ok('escrow order untouched', status('o4') === 'created')

// ── 5. direct_p2p 但非付款窗口(已 accepted)不能 mark_paid/cancel ──
mkOrder('o5', 'accepted', 'direct_p2p')
const r5 = await call('o5', { action: 'cancel' }, 'buyer1', 'buyer')
ok('cancel outside window → 409 NOT_DIRECT_PAY_WINDOW', r5.status === 409 && r5.json?.error_code === 'NOT_DIRECT_PAY_WINDOW', JSON.stringify(r5))

// ── 6. 未登录 → 401 ──
mkOrder('o6', 'direct_pay_window', 'direct_p2p')
const r6 = await call('o6', { action: 'mark_paid' })
ok('unauthenticated → 401', r6.status === 401, JSON.stringify(r6))

// ── 7. 审计 P1:confirm 路径 fail-closed —— direct_p2p 无 locked fee-stake 不得完成 ──
mkOrder('o7c', 'delivered', 'direct_p2p')   // NO fee-stake
const r7 = await call('o7c', { action: 'confirm' }, 'buyer1', 'buyer')
ok('confirm w/o fee-stake → 409 DIRECT_PAY_NO_FEE_STAKE', r7.status === 409 && r7.json?.error_code === 'DIRECT_PAY_NO_FEE_STAKE', JSON.stringify(r7))
ok('confirm w/o fee-stake → order NOT completed (stays delivered)', status('o7c') === 'delivered', `status=${status('o7c')}`)

// ── 8. confirm 路径 happy:有 locked stake → completed + 取费(同一原子边界)──
mkOrder('o8c', 'delivered', 'direct_p2p')
lockFeeStake(db, { orderId: 'o8c', sellerId: 'seller1', feeUnits: FEE, stakeId: 's8c' })
const r8 = await call('o8c', { action: 'confirm' }, 'buyer1', 'buyer')
ok('confirm w/ fee-stake → 200 completed', r8.status === 200 && status('o8c') === 'completed', JSON.stringify(r8))
ok('confirm w/ fee-stake → fee taken', stakeStatus('o8c') === 'fee_taken')

// ── 9. confirm-in-person 路径 fail-closed —— 缺 stake 不得完成(且不再静默吞异常)──
mkOrder('o9p', 'accepted', 'direct_p2p', 'in_person')   // NO fee-stake
const r9 = await callPath('/api/orders/o9p/confirm-in-person', {}, 'buyer1', 'buyer')
ok('in-person w/o fee-stake → 409', r9.status === 409 && r9.json?.error_code === 'DIRECT_PAY_NO_FEE_STAKE', JSON.stringify(r9))
ok('in-person w/o fee-stake → order NOT completed (stays accepted)', status('o9p') === 'accepted', `status=${status('o9p')}`)

// ── 10. confirm-in-person happy:有 locked stake → completed + 取费 ──
mkOrder('o10p', 'accepted', 'direct_p2p', 'in_person')
lockFeeStake(db, { orderId: 'o10p', sellerId: 'seller1', feeUnits: FEE, stakeId: 's10p' })
const r10 = await callPath('/api/orders/o10p/confirm-in-person', {}, 'buyer1', 'buyer')
ok('in-person w/ fee-stake → 200 completed', r10.status === 200 && status('o10p') === 'completed', JSON.stringify(r10))
ok('in-person w/ fee-stake → fee taken', stakeStatus('o10p') === 'fee_taken')

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-actions route tests passed`)
