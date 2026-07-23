/**
 * Direct Pay (Rail 1) 判责关单退款握手路由(P1-D 买家事后救济·方案 A)。
 *
 * 端点(全部 order 当事方鉴权,域逻辑在 src/direct-pay-fault-refund.ts):
 *   GET    /api/orders/:id/fault-refund               状态 + caller 可执行动作(party-gated)
 *   POST   /api/orders/:id/fault-refund/request       买家发起(reason ≤200;每单 ≤3 次)
 *   POST   /api/orders/:id/fault-refund/decline       卖家拒绝(主张已退款/不认可)
 *   POST   /api/orders/:id/fault-refund/mark-refunded 卖家声明已场外退款(refund_reference ≤200)
 *   POST   /api/orders/:id/fault-refund/withdraw      买家撤回(仅卖家未响应前)
 *   POST   /api/orders/:id/fault-refund/confirm       买家确认收到退款(RISK:真人 Passkey)→ settled 纯记录
 *   POST   /api/orders/:id/fault-refund/escalate      买家举证升级 → fault_refund_claim 争议(统一仲裁台)
 *
 * 本文件只做接线:auth + 参数 + Passkey 门 + 通知(templateKey 双语)。订单状态永远不动(completed 终态)。
 * confirm 门=requireDirectPayHumanPasskey(purpose direct_pay_order_action,action fault_refund_confirm
 * 走 purpose_data validate)—— agent 无 Passkey 永远过不了(RISK 铁律)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  requestFaultRefund, declineFaultRefund, markFaultRefunded, withdrawFaultRefund,
  confirmFaultRefundReceived, escalateFaultRefund, getFaultRefundState,
} from '../../direct-pay-fault-refund.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam(通知收件人读)
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'

export interface DirectFaultRefundDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

export function registerDirectFaultRefundRoutes(app: Application, deps: DirectFaultRefundDeps): void {
  const { db, auth, generateId, errorRes, consumeGateToken } = deps
  const httpFor = (code: string | undefined): number =>
    code === 'ORDER_NOT_FOUND' ? 404
      : code === 'NOT_A_PARTY' || code === 'NOT_ORDER_BUYER' || code === 'NOT_ORDER_SELLER' ? 403
        : 409
  const party = async (orderId: string): Promise<{ buyer_id: string; seller_id: string; product: string } | undefined> =>
    await dbOne<{ buyer_id: string; seller_id: string; product: string }>(
      "SELECT o.buyer_id, o.seller_id, COALESCE(p.title,'') AS product FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.id = ?", [orderId])
  const notify = (userId: string, orderId: string, type: string, title: string, body: string, templateKey: string, product: string): void => {
    try { createNotification(db, userId, orderId, type, title, body, { templateKey, params: { product } }) } catch { /* 通知失败不阻断业务 */ }
  }

  app.get('/api/orders/:id/fault-refund', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = getFaultRefundState(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_STATE_ERROR', r.error || '读取失败')
    res.json({ success: true, eligible: !!r.eligible, request: r.request ?? null, claim: r.claim ?? null, can_request: !!r.can_request, can_respond: !!r.can_respond, can_confirm: !!r.can_confirm, can_withdraw: !!r.can_withdraw, can_escalate: !!r.can_escalate })
  })

  app.post('/api/orders/:id/fault-refund/request', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null
    const r = requestFaultRefund(db, { orderId: req.params.id, buyerId: user.id as string, reason, requestId: generateId('dfrr') })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_REQUEST_ERROR', r.error || '发起失败')
    const p = await party(req.params.id)
    if (p) notify(p.seller_id, req.params.id, 'fault_refund_requested', '💸 买家申请违约关单退款', `订单「${p.product}」因你违约被系统关闭,买家已场外付款并申请退款。请在期限内响应:已退款请点"我已退款"并附参考;未退款请尽快场外退款。持续不响应买家可举证仲裁,将追加信誉处罚。`, 'frc_requested', p.product)
    return void res.json({ success: true, status: r.status, request: r.request ?? null })
  })

  app.post('/api/orders/:id/fault-refund/decline', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = declineFaultRefund(db, { orderId: req.params.id, sellerId: user.id as string })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_DECLINE_ERROR', r.error || '拒绝失败')
    const p = await party(req.params.id)
    if (p) notify(p.buyer_id, req.params.id, 'fault_refund_declined', '❌ 卖家拒绝了退款握手', `订单「${p.product}」:卖家拒绝了退款握手请求。你可以举证升级仲裁(提供付款凭证,信誉裁决)。`, 'frc_declined', p.product)
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/fault-refund/mark-refunded', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const refundReference = typeof req.body?.refund_reference === 'string' ? req.body.refund_reference : null
    const r = markFaultRefunded(db, { orderId: req.params.id, sellerId: user.id as string, refundReference })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_MARK_ERROR', r.error || '声明退款失败')
    const p = await party(req.params.id)
    if (p) notify(p.buyer_id, req.params.id, 'fault_refund_marked', '💸 卖家已声明退款', `订单「${p.product}」:卖家声明已在协议外向你退款${refundReference ? `(参考:${String(refundReference).slice(0, 80)})` : ''}。请核实到账后确认(需 Passkey);未收到请勿确认,可举证升级仲裁。`, 'frc_marked', p.product)
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/fault-refund/withdraw', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = withdrawFaultRefund(db, { orderId: req.params.id, buyerId: user.id as string })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_WITHDRAW_ERROR', r.error || '撤回失败')
    const p = await party(req.params.id)
    if (p) notify(p.seller_id, req.params.id, 'fault_refund_withdrawn', '↩️ 买家撤回了退款握手请求', `订单「${p.product}」的退款握手请求已被买家撤回。`, 'frc_withdrawn', p.product)
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/fault-refund/confirm', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const uid = user.id as string
    // 只读预检(不消费 token):必须 refund_marked,否则不浪费一次性 Passkey token
    const pre = getFaultRefundState(db, req.params.id, uid)
    if (!pre.ok) return void errorRes(res, httpFor(pre.error_code), pre.error_code || 'FAULT_REFUND_STATE_ERROR', pre.error || '读取失败')
    if (!pre.can_confirm) return void errorRes(res, 409, 'REFUND_NOT_MARKED', '当前不可确认(卖家尚未声明退款)')
    // RISK 门:确认收款 = 终局记录动作 → 现场真人 Passkey(agent 无 Passkey 硬拒)
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: uid, webauthnToken: req.body?.webauthn_token as string | undefined, purpose: 'direct_pay_order_action',
      validate: (data) => { const d = data as { order_id?: string; action?: string } | null; return !!d && d.order_id === req.params.id && d.action === 'fault_refund_confirm' },
    })
    if (!gate.ok) return void errorRes(res, 403, gate.error_code || 'HUMAN_PRESENCE_REQUIRED', gate.reason || '需现场真人 Passkey 确认')
    const r = confirmFaultRefundReceived(db, { orderId: req.params.id, buyerId: uid })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_CONFIRM_ERROR', r.error || '确认失败')
    const p = await party(req.params.id)
    if (p) { notify(p.seller_id, req.params.id, 'fault_refund_settled', '✅ 退款握手完成', `订单「${p.product}」:买家已确认收到场外退款,退款握手闭环留档。`, 'frc_settled', p.product); notify(p.buyer_id, req.params.id, 'fault_refund_settled', '✅ 退款握手完成', `订单「${p.product}」:你已确认收到卖家场外退款,握手闭环留档。`, 'frc_settled', p.product) }
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/fault-refund/escalate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : ''
    const r = escalateFaultRefund(db, { orderId: req.params.id, buyerId: user.id as string, notes, disputeId: generateId('dsp') })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'FAULT_REFUND_ESCALATE_ERROR', r.error || '升级失败')
    const p = await party(req.params.id)
    if (p) { notify(p.seller_id, req.params.id, 'fault_refund_escalated', '⚖️ 买家发起退款申索仲裁', `订单「${p.product}」:买家举证主张你在违约关单后未场外退款,已进入仲裁(信誉裁决)。请在 48h 内提交退款凭证反驳,超时将自动判买家申索成立。`, 'frc_escalated', p.product); notify(p.buyer_id, req.params.id, 'fault_refund_escalated', '⚖️ 退款申索已提交仲裁', `订单「${p.product}」的退款申索已进入统一仲裁台(信誉裁决,非托管不涉资金)。可在争议页补充付款凭证。`, 'frc_escalated', p.product) }
    return void res.json({ success: true, status: r.status, dispute_id: r.dispute_id })
  })
}
