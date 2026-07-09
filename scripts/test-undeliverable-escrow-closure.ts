#!/usr/bin/env tsx
/**
 * PR-B3b:escrow undeliverable 资金收口 —— return_pending 持有 + 三出口(确认/超时默认/货丢仲裁)全钱路回归。
 * 真 express + 真 transition/checkTimeouts/settleUndeliverableEscrow/createDispute + B1 真 param seed。
 * 自检锚:D5(方案 b 成本扣除)· 护栏 A(双锚 clamp)· 护栏 B2(确认→扣除/超时→全款退买家/货丢→仲裁)·
 *   守恒(钱包级:buyer.escrowed 全解,refund+seller≡total)· 没收仅仲裁(settle 层结构性不可达)。
 * Usage: npm run test:undeliverable-escrow-closure
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'undeliv-b3b-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initSystemUser, transition, settleFault, checkTimeouts, settleUndeliverableEscrow } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initReputationSchema, recordViolationReputation } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema, createDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { walletUnits } = await import('../src/ledger.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderChainSchema(db)
for (const c of ["fulfillment_mode TEXT DEFAULT 'shipped'", "source TEXT DEFAULT 'shop'", 'settled_fault_at TEXT', 'has_pending_claim INTEGER DEFAULT 0', 'decline_objective_pending INTEGER DEFAULT 0', 'decline_contested INTEGER DEFAULT 0', 'decline_contest_deadline TEXT', 'stake_backing DECIMAL(18,2) DEFAULT 0', 'bid_stake_held DECIMAL(18,2) DEFAULT 0'])
  { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch {} }
try { db.exec('ALTER TABLE evidence ADD COLUMN flag_reasons TEXT') } catch {}
initReputationSchema(db); initDisputeSchema(db); initSystemUser(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','买家','buyer','kb'),('seller1','卖家','seller','ks')").run()
db.prepare("INSERT INTO wallets (user_id, balance, escrowed, staked) VALUES ('buyer1',0,1000,0),('seller1',0,0,0)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','seller1','P','d',92,100)").run()
db.prepare("UPDATE protocol_params SET value='1' WHERE key='undeliverable_closure_enabled'").run()   // rollout on

const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status?: string } | undefined)?.status
const col = (id: string, c: string) => (db.prepare(`SELECT ${c} AS v FROM orders WHERE id=?`).get(id) as { v?: unknown } | undefined)?.v
const wu = (u: string) => walletUnits(db, u)
let n = 0
// escrow 单:total 100(含去程 8),买家 escrowed 已含
function mkOrder(st: string, extra: Record<string, unknown> = {}): string {
  const id = `oe_${++n}`
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode, shipping_address, shipping_fee, stake_backing, bid_stake_held)
     VALUES (?, 'p1','buyer1','seller1',1,92,100,100,?,'escrow','shipped','快照地址 123 Main St',8,?,?)`).run(id, st, (extra.stake_backing as number) ?? 0, (extra.bid_stake_held as number) ?? 0)
  return id
}
const repCb = (oid: string): void => recordViolationReputation(db, oid, 'fault_buyer')

let counter = 0
const app = express(); app.use(express.json())
registerOrdersActionRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: (req.headers['x-test-role'] as string) || 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++counter}`,
  transition, notifyTransition: () => {}, settleOrder: () => {}, settleFault, detectFraud: () => [],
  createDispute, checkTimeouts: () => ({ details: [] }), recordViolationReputation, broadcastSystemEvent: () => {},
  consumeGateToken: () => true,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
function call(orderId: string, body: Record<string, unknown>, uid?: string, role?: string): Promise<{ status: number; json: { error_code?: string; error?: string } }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (uid) headers['x-test-uid'] = uid; if (role) headers['x-test-role'] = role
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/orders/${orderId}/action`, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}
// 系统级守恒基线:buyer+seller 的 (balance+escrowed+staked) 总和
const sysTotal = (): number => { const b = wu('buyer1'), s = wu('seller1'); return b.balance + b.escrowed + b.staked + s.balance + s.escrowed + s.staked }

// ═══ E1:escrow delivery_failed 争议窗口过期 → return_pending 持有(escrow 不动)+ goods_return_deadline + 声誉一次 ═══
{
  const o = mkOrder('shipped')
  await call(o, { action: 'mark_undeliverable', evidence_description: '退回·快照地址' }, 'seller1', 'seller')
  db.prepare("UPDATE orders SET delivery_failed_deadline = datetime('now','-1 hours') WHERE id=?").run(o)
  const b0 = wu('buyer1'); const t0 = sysTotal()
  const r = checkTimeouts(db, { recordUndeliverableFault: repCb })
  ok('E1. escrow 窗口过期 → return_pending(非 fault_buyer)', status(o) === 'return_pending', `status=${status(o)}`)
  ok('E1b. escrow 仍锁定(买家钱包零变动)', wu('buyer1').escrowed === b0.escrowed && wu('buyer1').balance === b0.balance && sysTotal() === t0)
  const gr = col(o, 'goods_return_deadline') as string | null
  ok('E1c. 置 goods_return_deadline(ISO)', !!gr && gr.includes('T'), `gr=${gr}`)
  const det = r.details.find(d => d.orderId === o)
  ok('E1d. detail 不匹配 cron fault_ 正则(防双记)', !!det && !det.action.match(/→ (fault_\w+)/), JSON.stringify(det))
  const ev = db.prepare("SELECT event_type, points FROM reputation_events WHERE user_id='buyer1' AND order_id=?").all(o) as Array<{ event_type: string; points: number }>
  ok('E1e. 声誉 -20 undeliverable_buyer_fault 恰一条(escrow 单经 delivery_failed_deadline 分流)', ev.length === 1 && ev[0].event_type === 'undeliverable_buyer_fault' && ev[0].points === -20, JSON.stringify(ev))
  // E2:卖家确认收货(申报退程 7 ≤ 去程 8)→ 成本扣除结算(字面值断言)
  const t1 = sysTotal()
  const r2 = await call(o, { action: 'confirm_return_received', evidence_description: '退货单号 SF999 已签收', return_shipping_actual: 7 }, 'seller1', 'seller')
  ok('E2. confirm_return_received → 200 completed', r2.status === 200 && status(o) === 'completed', JSON.stringify(r2))
  ok('E2b. 买家:escrowed −100,balance +75.8(= 100−8−7−9.2,字面值)', wu('buyer1').escrowed === b0.escrowed - toUnits(100) && wu('buyer1').balance === b0.balance + toUnits(75.8), `b=${JSON.stringify(wu('buyer1'))}`)
  ok('E2c. 卖家:+24.2 成本补偿(去程8+退程7+restocking9.2,不牟利)', wu('seller1').balance === toUnits(24.2), `s=${JSON.stringify(wu('seller1'))}`)
  ok('E2d. 系统总额守恒(无 mint)', sysTotal() === t1, `before=${t1} after=${sysTotal()}`)
  ok('E2e. return_shipping_actual 原始申报值落库(审计)', Number(col(o, 'return_shipping_actual')) === 7)
  ok('E2f. settled_fault_at 幂等标记', !!col(o, 'settled_fault_at'))
  // E2g:幂等 —— 直接再调 settle 不再动钱
  const bA = wu('buyer1').balance
  settleUndeliverableEscrow(db, o, 'goods_returned', toUnits(7))
  ok('E2g. settle 幂等(第二次调用零变动)', wu('buyer1').balance === bA)
}
// ═══ E3:申报灌水 → 双锚 clamp(≤去程 8);库存不回补 ═══
{
  const o = mkOrder('return_pending')
  db.prepare("UPDATE orders SET delivery_failed_deadline = datetime('now','-2 hours') WHERE id=?").run(o)   // 模拟已经过落定(列已置)
  const st0 = (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
  const b0 = wu('buyer1')
  const r = await call(o, { action: 'confirm_return_received', evidence_description: '退货已收', return_shipping_actual: 90 }, 'seller1', 'seller')
  // 退程 clamp = min(total×0.20=20, outbound=8) = 8 → refund = 100−8−8−9.2 = 74.8
  ok('E3. 申报 90 → 双锚 clamp 到去程 8:refund=74.8(字面值)', r.status === 200 && wu('buyer1').balance === b0.balance + toUnits(74.8), `b=${wu('buyer1').balance - b0.balance}`)
  ok('E3b. return_shipping_actual 存【原始】申报 90(审计留痕,非 clamp 后值)', Number(col(o, 'return_shipping_actual')) === 90)
  ok('E3c. escrow 收口零库存回补(已出库绝不自动回补)', (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock === st0)
}
// ═══ E4:卖家逾期未确认 → checkTimeouts 默认全款退买家(护栏 B2)+ stake 退还 ═══
{
  const o = mkOrder('return_pending', { bid_stake_held: 5 })
  db.prepare("UPDATE orders SET delivery_failed_deadline = datetime('now','-3 hours'), goods_return_deadline = datetime('now','-1 hours') WHERE id=?").run(o)
  db.prepare("UPDATE wallets SET staked = 5 WHERE user_id='seller1'").run()   // 卖家有 5 staked(bid_stake_held 对应)
  const b0 = wu('buyer1'); const s0 = wu('seller1'); const t0 = sysTotal()
  checkTimeouts(db, { recordUndeliverableFault: repCb })
  ok('E4. 卖家逾期 → completed(默认全款退买家)', status(o) === 'completed', `status=${status(o)}`)
  ok('E4b. 买家全额退回(escrowed −100 → balance +100,零扣除)', wu('buyer1').balance === b0.balance + toUnits(100) && wu('buyer1').escrowed === b0.escrowed - toUnits(100))
  ok('E4c. 卖家 0 成本补偿 + stake 5 退还(staked→balance,无责)', wu('seller1').balance === s0.balance + toUnits(5) && wu('seller1').staked === s0.staked - toUnits(5))
  ok('E4d. 系统总额守恒', sysTotal() === t0)
}
// ═══ E5:出口动作门控 —— 错误状态/非卖家/缺证据 ═══
{
  const o = mkOrder('shipped')
  const r1 = await call(o, { action: 'confirm_return_received', evidence_description: 'x' }, 'seller1', 'seller')
  ok('E5. 非 return_pending → 409 NOT_RETURN_PENDING', r1.status === 409 && r1.json.error_code === 'NOT_RETURN_PENDING', JSON.stringify(r1))
  const o2 = mkOrder('return_pending')
  const r2 = await call(o2, { action: 'confirm_return_received', evidence_description: 'x' }, 'buyer1', 'buyer')
  ok('E5b. 非卖家 → 403 NOT_ORDER_SELLER', r2.status === 403 && r2.json.error_code === 'NOT_ORDER_SELLER', JSON.stringify(r2))
  const r3 = await call(o2, { action: 'confirm_return_received' }, 'seller1', 'seller')
  ok('E5c. 缺退货凭证 → 400 RETURN_EVIDENCE_REQUIRED', r3.status === 400 && r3.json.error_code === 'RETURN_EVIDENCE_REQUIRED', JSON.stringify(r3))
  ok('E5d. 失败不动钱不转移(仍 return_pending)', status(o2) === 'return_pending')
}
// ═══ E6:卖家货丢主张 → disputed(带证据)→ 仲裁(全额没收唯一路径;settle 层结构性拒 forfeit)═══
{
  const o = mkOrder('return_pending')
  const r = await call(o, { action: 'dispute', evidence_description: '承运商遗失证明 LOST-123' }, 'seller1', 'seller')
  ok('E6. 卖家货丢主张 → 200 disputed + dispute 行', r.status === 200 && status(o) === 'disputed' && !!db.prepare("SELECT id FROM disputes WHERE order_id=? AND status IN ('open','in_review')").get(o), JSON.stringify(r))
  // settle 层类型只收两 mode;直付调用防呆:
  const oDp = `odp_${++n}`
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode) VALUES (?, 'p1','buyer1','seller1',1,92,100,0,'return_pending','direct_p2p','shipped')`).run(oDp)
  let threw = false; try { settleUndeliverableEscrow(db, oDp, 'seller_silent_default') } catch { threw = true }
  ok('E6b. settleUndeliverableEscrow 对 direct_p2p fail-loud(escrow-only 硬门)', threw)
}
// ═══ E7:无回调 → escrow 落定分支同样跳过(留 delivery_failed) ═══
{
  const o = mkOrder('shipped')
  await call(o, { action: 'mark_undeliverable', evidence_description: '退回·快照地址' }, 'seller1', 'seller')
  db.prepare("UPDATE orders SET delivery_failed_deadline = datetime('now','-1 hours') WHERE id=?").run(o)
  checkTimeouts(db)
  ok('E7. 无声誉回调 → escrow 单留 delivery_failed(不丢声誉不误转)', status(o) === 'delivery_failed', `status=${status(o)}`)
}

server!.close()
if (fail > 0) { console.error(`\n❌ undeliverable-escrow-closure FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ undeliverable-escrow-closure (PR-B3b): ${pass} pass — return_pending 持有 + 确认扣除(字面值+守恒)+ 超时全款退 + 双锚 clamp + stake 退还 + 门控 + 货丢仲裁 + fail-loud`)
