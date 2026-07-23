#!/usr/bin/env tsx
/**
 * P1-D 判责关单退款握手 + 举证升级(方案 A)—— 行为回归锁。
 *   铁律锁:① 订单状态永远不动(completed 终态,握手/申索/裁决全程零转移零资金);
 *   ② 资格谓词(direct_p2p + fault_seller 来源关单 + 买家曾标记付款);
 *   ③ confirm 走真人 Passkey 门(无凭证 agent 硬拒);④ 申索每单唯一,裁决唯一 resolver,
 *   信誉单点发射(cron 不双记);⑤ 通知全链 templateKey;⑥ 前端接线锚 + i18n parity。
 * 真实引擎/路由/域模块,不桩被测组件。Usage: npm run test:direct-pay-fault-refund
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dfr-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { initReputationSchema } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema, checkDisputeTimeouts } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { initDirectPayFaultRefundSchema, getFaultRefundState, escalateFaultRefund } = await import('../src/direct-pay-fault-refund.js')
const { resolveFaultRefundClaim } = await import('../src/layer3-trust/L3-1-dispute-engine/fault-refund-resolve.js')
const { registerDirectFaultRefundRoutes } = await import('../src/pwa/routes/direct-fault-refund.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
for (const c of ['settled_fault_at TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* 已有 */ } }
initNotificationSchema(db); initReputationSchema(db); initDisputeSchema(db); initDirectPayFaultRefundSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','买家甲','buyer','kb'),('s1','卖家乙','seller','ks'),('sys_protocol','协议','system','ksys')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','s1','测试品','d',50,100)").run()
db.prepare("CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT, counter INTEGER DEFAULT 0)").run()
db.prepare("INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter) VALUES ('c_b1','b1','pk',0)").run()   // 买家有 Passkey;卖家/agent 无

let n = 0
function mkOrder(opts: { rail?: string; status?: string; faultClosed?: boolean; paidMark?: boolean } = {}): string {
  const id = `o_${++n}`
  const rail = opts.rail ?? 'direct_p2p'; const status = opts.status ?? 'completed'
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, shipping_address)
     VALUES (?,'p1','b1','s1',1,50,50,0,?,?,'地址')`).run(id, status, rail)
  if (opts.faultClosed !== false) db.prepare("UPDATE orders SET settled_fault_at = datetime('now') WHERE id = ?").run(id)
  // history:direct 轨真实事件序(含买家标记付款 accepted 行)+ fault_seller→completed 关单
  let seq = 0
  const hist = (from: string | null, to: string): void => {
    db.prepare(`INSERT INTO order_state_history (id, order_id, from_status, to_status, actor_id, actor_role, evidence_ids, notes, created_at)
       VALUES (?, ?, ?, ?, 'sys_protocol', 'system', '[]', NULL, datetime('now', '-' || ? || ' seconds'))`).run(`h_${id}_${++seq}`, id, from, to, 100 - seq)
  }
  hist('created', 'pending_accept'); hist('pending_accept', 'direct_pay_window')   // from_status NOT NULL:略过 open 行(资格谓词不依赖)
  if (opts.paidMark !== false) hist('direct_pay_window', 'accepted')
  if (opts.faultClosed !== false) { hist('accepted', 'fault_seller'); hist('fault_seller', 'completed') }
  else if (status === 'completed') { hist('delivered', 'confirmed'); hist('confirmed', 'completed') }
  return id
}
const notifKeys = (uid: string, orderId: string): string[] =>
  (db.prepare('SELECT template_key FROM notifications WHERE user_id = ? AND order_id = ? ORDER BY rowid').all(uid, orderId) as Array<{ template_key: string | null }>).map(r => String(r.template_key))
const orderStatus = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status

// ── HTTP 装置 ──
let c = 0
const app = express(); app.use(express.json())
registerDirectFaultRefundRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid } },
  generateId: (p: string) => `${p}_${++c}`,
  errorRes: (res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, error_code: code }),
  // gate token 桩:token 'GOOD' 且 purpose_data 校验交给 validate(真实守卫仍先查 webauthn_credentials → agent 硬拒真实生效)
  consumeGateToken: (_u: string, token: string | undefined, _purpose: string, validate: (d: unknown) => boolean) => {
    if (!token) return { ok: false, reason: 'no token' }
    try { const d = JSON.parse(token); return validate(d) ? { ok: true } : { ok: false, reason: 'mismatch' } } catch { return { ok: false, reason: 'bad token' } }
  },
})
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : ''
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-test-uid': uid }
  if (payload) headers['content-length'] = String(Buffer.byteLength(payload))
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', ch => d += ch); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (payload) rq.write(payload); rq.end()
})

try {
  // ═══ ① 资格谓词 ═══
  {
    const esc0 = mkOrder({ rail: 'escrow' })
    const r1 = await call('POST', `/api/orders/${esc0}/fault-refund/request`, 'b1', { reason: 'x' })
    ok('1a. escrow 单拒(NOT_DIRECT_PAY)', r1.status === 409 && r1.json.error_code === 'NOT_DIRECT_PAY', JSON.stringify(r1.json))
    const normal = mkOrder({ faultClosed: false })
    const r2 = await call('POST', `/api/orders/${normal}/fault-refund/request`, 'b1', {})
    ok('1b. 正常成交 completed 拒(NOT_FAULT_CLOSED)', r2.status === 409 && r2.json.error_code === 'NOT_FAULT_CLOSED', JSON.stringify(r2.json))
    const unpaid = mkOrder({ paidMark: false })
    const r3 = await call('POST', `/api/orders/${unpaid}/fault-refund/request`, 'b1', {})
    ok('1c. 买家从未标记付款拒(BUYER_NEVER_MARKED_PAID)', r3.status === 409 && r3.json.error_code === 'BUYER_NEVER_MARKED_PAID', JSON.stringify(r3.json))
    const o = mkOrder({})
    const r4 = await call('POST', `/api/orders/${o}/fault-refund/request`, 's1', {})
    ok('1d. 卖家不能替买家发起(403)', r4.status === 403, JSON.stringify(r4.json))
    const r5 = await call('GET', `/api/orders/${o}/fault-refund`, 'b1')
    ok('1e. 状态读 party-gated + eligible', r5.status === 200 && r5.json.eligible === true && r5.json.can_request === true)
  }

  // ═══ ② 握手全链:request → mark → confirm(Passkey)═══
  {
    const o = mkOrder({})
    const rq = await call('POST', `/api/orders/${o}/fault-refund/request`, 'b1', { reason: 'PayNow 17 USDC 已付' })
    ok('2a. request 成功 + 卖家收 frc_requested', rq.status === 200 && notifKeys('s1', o).includes('frc_requested'), JSON.stringify(rq.json))
    const dup = await call('POST', `/api/orders/${o}/fault-refund/request`, 'b1', {})
    ok('2b. 重复 request 拒(REQUEST_ALREADY_OPEN)', dup.status === 409 && dup.json.error_code === 'REQUEST_ALREADY_OPEN')
    const early = await call('POST', `/api/orders/${o}/fault-refund/confirm`, 'b1', { webauthn_token: JSON.stringify({ order_id: o, action: 'fault_refund_confirm' }) })
    ok('2c. 卖家未声明前 confirm 拒(不耗 token)', early.status === 409 && early.json.error_code === 'REFUND_NOT_MARKED')
    const mk = await call('POST', `/api/orders/${o}/fault-refund/mark-refunded`, 's1', { refund_reference: 'PAYNOW-TX-1' })
    ok('2d. mark-refunded 成功 + 买家收 frc_marked', mk.status === 200 && notifKeys('b1', o).includes('frc_marked'))
    const noTok = await call('POST', `/api/orders/${o}/fault-refund/confirm`, 'b1', {})
    ok('2e. 无 Passkey token confirm 拒 403', noTok.status === 403, JSON.stringify(noTok.json))
    const wrongBind = await call('POST', `/api/orders/${o}/fault-refund/confirm`, 'b1', { webauthn_token: JSON.stringify({ order_id: 'other', action: 'fault_refund_confirm' }) })
    ok('2f. token 绑错订单拒 403', wrongBind.status === 403)
    const cf = await call('POST', `/api/orders/${o}/fault-refund/confirm`, 'b1', { webauthn_token: JSON.stringify({ order_id: o, action: 'fault_refund_confirm' }) })
    ok('2g. confirm 成功 → settled + 双方 frc_settled', cf.status === 200 && cf.json.status === 'settled' && notifKeys('s1', o).includes('frc_settled') && notifKeys('b1', o).includes('frc_settled'), JSON.stringify(cf.json))
    ok('2h. ★订单状态全程不动(completed)', orderStatus(o) === 'completed')
    const again = await call('POST', `/api/orders/${o}/fault-refund/request`, 'b1', {})
    ok('2i. settled 后不可再发起', again.status === 409 && again.json.error_code === 'ALREADY_SETTLED')
  }

  // ═══ ③ 无 Passkey 凭证(agent)硬拒 ═══
  {
    db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b2','无键买家','buyer','kb2')").run()
    const o = mkOrder({})
    db.prepare("UPDATE orders SET buyer_id = 'b2' WHERE id = ?").run(o)
    db.prepare("UPDATE order_state_history SET order_id = order_id WHERE order_id = ?").run(o)
    await call('POST', `/api/orders/${o}/fault-refund/request`, 'b2', {})
    await call('POST', `/api/orders/${o}/fault-refund/mark-refunded`, 's1', {})
    const r = await call('POST', `/api/orders/${o}/fault-refund/confirm`, 'b2', { webauthn_token: JSON.stringify({ order_id: o, action: 'fault_refund_confirm' }) })
    ok('3. 无 webauthn 凭证账号 confirm 硬拒(PASSKEY_REQUIRED_FOR_DIRECT_PAY)', r.status === 403 && r.json.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', JSON.stringify(r.json))
  }

  // ═══ ④ decline → 举证升级 → 唯一申索 ═══
  {
    const o = mkOrder({})
    await call('POST', `/api/orders/${o}/fault-refund/request`, 'b1', {})
    const dc = await call('POST', `/api/orders/${o}/fault-refund/decline`, 's1', {})
    ok('4a. decline 成功 + 买家收 frc_declined', dc.status === 200 && notifKeys('b1', o).includes('frc_declined'))
    const shortNotes = await call('POST', `/api/orders/${o}/fault-refund/escalate`, 'b1', { notes: '太短' })
    ok('4b. 陈述过短拒(NOTES_TOO_SHORT)', shortNotes.status === 409 && shortNotes.json.error_code === 'NOTES_TOO_SHORT')
    const es = await call('POST', `/api/orders/${o}/fault-refund/escalate`, 'b1', { notes: 'PayNow 于 7/17 支付 17 USDC,参考 WAZ-XX,卖家拒绝退款' })
    ok('4c. 举证升级成功 → fault_refund_claim 争议 + 双方通知', es.status === 200 && !!es.json.dispute_id && notifKeys('s1', o).includes('frc_escalated') && notifKeys('b1', o).includes('frc_escalated'), JSON.stringify(es.json))
    const d = db.prepare("SELECT id, status, dispute_type, initiator_id, defendant_id FROM disputes WHERE order_id = ?").get(o) as Record<string, unknown>
    ok('4d. 争议行:类型/发起/被诉正确', d?.dispute_type === 'fault_refund_claim' && d?.initiator_id === 'b1' && d?.defendant_id === 's1' && d?.status === 'open')
    const es2 = await call('POST', `/api/orders/${o}/fault-refund/escalate`, 'b1', { notes: '第二次升级应被唯一约束拒绝掉' })
    ok('4e. 申索每单唯一(CLAIM_ALREADY_EXISTS)', es2.status === 409 && es2.json.error_code === 'CLAIM_ALREADY_EXISTS')
    // 裁决:仲裁员判 refund_failed_confirmed → 信誉 + 订单不动
    const repBefore = (db.prepare("SELECT COUNT(*) n FROM reputation_events WHERE order_id = ?").get(o) as { n: number }).n
    db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('arb1','仲裁员','buyer','ka')").run()
    const r = resolveFaultRefundClaim(db, String(d.id), 'arb1', 'refund_failed_confirmed', '卖家无退款凭证', 'arbitrator')
    ok('4f. 裁决成功(买家申索成立)', r.decision === 'refund_failed_confirmed' && r.orderId === o)
    const repRows = db.prepare("SELECT user_id, event_type, points FROM reputation_events WHERE order_id = ? ORDER BY rowid").all(o) as Array<{ user_id: string; event_type: string; points: number }>
    ok('4g. 信誉:卖家 dispute_lost(-25)+ 买家 dispute_won(+8)', repRows.length - repBefore === 2 && repRows.some(x => x.user_id === 's1' && x.event_type === 'dispute_lost') && repRows.some(x => x.user_id === 'b1' && x.event_type === 'dispute_won'), JSON.stringify(repRows))
    ok('4h. ★裁决后订单仍 completed(终态不动)', orderStatus(o) === 'completed')
    let dbl = ''
    try { resolveFaultRefundClaim(db, String(d.id), 'arb1', 'refund_confirmed', '重复', 'arbitrator') } catch (e) { dbl = (e as { code?: string }).code || '' }
    ok('4i. 重复裁决拒(ALREADY_RULED)', dbl === 'ALREADY_RULED')
  }

  // ═══ ⑤ 超时自动裁定(checkDisputeTimeouts 专用分支,信誉单点不双记)═══
  {
    const o = mkOrder({})
    await call('POST', `/api/orders/${o}/fault-refund/request`, 'b1', {})
    await call('POST', `/api/orders/${o}/fault-refund/decline`, 's1', {})
    const es = await call('POST', `/api/orders/${o}/fault-refund/escalate`, 'b1', { notes: '卖家拒绝退款且拒不回应,升级仲裁请求裁定' })
    const did = String(es.json.dispute_id)
    db.prepare("UPDATE disputes SET respond_deadline = datetime('now','-1 hour'), arbitrate_deadline = datetime('now','-1 minute') WHERE id = ?").run(did)
    const before = (db.prepare("SELECT COUNT(*) n FROM reputation_events WHERE order_id = ?").get(o) as { n: number }).n
    const tr = checkDisputeTimeouts(db)
    const mine = tr.details.find(x => x.disputeId === did)
    ok('5a. 超时分支命中(details 无 winner/loser → cron 不双记)', !!mine && mine.winnerId === undefined && mine.loserId === undefined, JSON.stringify(mine))
    const drow = db.prepare('SELECT status, ruling_type FROM disputes WHERE id = ?').get(did) as { status: string; ruling_type: string }
    ok('5b. 自动裁定买家申索成立', drow.status === 'resolved' && drow.ruling_type === 'refund_failed_confirmed')
    const after = (db.prepare("SELECT COUNT(*) n FROM reputation_events WHERE order_id = ?").get(o) as { n: number }).n
    ok('5c. 信誉恰好 +2 条(resolver 单点,零双记)', after - before === 2)
    ok('5d. 双方收 frc_ruled_refund_failed', notifKeys('b1', o).includes('frc_ruled_refund_failed') && notifKeys('s1', o).includes('frc_ruled_refund_failed'))
    ok('5e. ★订单仍 completed', orderStatus(o) === 'completed')
    const tr2 = checkDisputeTimeouts(db)
    ok('5f. 已裁决案不再被扫(幂等)', !tr2.details.find(x => x.disputeId === did))
  }

  // ═══ ⑥ 接线锚 + i18n parity ═══
  {
    const APPJS = readFileSync('src/pwa/public/app.js', 'utf8')
    const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
    const UI = readFileSync('src/pwa/public/app-direct-pay-fault-refund.js', 'utf8')
    const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
    const DW = readFileSync('src/pwa/routes/disputes-write.ts', 'utf8')
    ok('6a. app.js 挂 dpFaultRefundCard(与 cancelRefundCard 同链)', APPJS.includes("window.dpFaultRefundCard ? window.dpFaultRefundCard(order, isBuyer, isSeller) : ''"))
    ok('6b. index.html 引入且在 app.js 之前', HTML.indexOf('app-direct-pay-fault-refund.js') > 0 && HTML.indexOf('app-direct-pay-fault-refund.js') < HTML.indexOf('"/app.js"'))
    ok('6c. arbitrate 路由有 fault_refund_claim 专用分支(绝不落通用裁决)', DW.includes("dispute_type === 'fault_refund_claim'") && DW.includes('resolveFaultRefundClaim'))
    const tStrings = [...UI.matchAll(/(?<![A-Za-z_$])t\('([^']+)'\)/g)].map(m => m[1])
    const missing = [...new Set(tStrings)].filter(zh => !I18N.includes(`'${zh.replace(/'/g, "\\'")}':`) && !I18N.includes(`'${zh}':`))
    ok('6d. UI 每个 t() 串有 _EN 对', tStrings.length >= 25 && missing.length === 0, `missing: ${missing.slice(0, 3).join(' | ')}`)
    const frcKeys = [...UI.matchAll(/(frc_\w+): P\(/g)].map(m => m[1])
    ok('6e. frc_* 模板域内聚注册(≥8 键,含两枚裁定键)', frcKeys.length >= 8 && frcKeys.includes('frc_ruled_refund_failed') && frcKeys.includes('frc_ruled_refund_confirmed'))
  }
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ direct-pay-fault-refund FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay fault-refund(P1-D 方案A):资格谓词 + 握手全链(Passkey 门/agent 硬拒)+ 举证升级唯一申索 + 唯一裁决器(信誉单点/订单终态不动)+ 超时兜底 + 接线/i18n 锚\n  ✅ pass ${pass}`)
