/**
 * Direct Pay (Rail 1) 取消退款握手路由(审计项 C)—— 付款后(accepted)·发货前,买家取消+场外退款三步握手。
 *
 * 端点(全部 order 当事方鉴权,域逻辑在 src/direct-pay-cancel-refund.ts):
 *   GET    /api/orders/:id/cancel-refund               状态 + caller 可执行动作(party-gated)
 *   POST   /api/orders/:id/cancel-refund/request       买家发起(reason ≤200;每单 ≤3 次)
 *   POST   /api/orders/:id/cancel-refund/decline       卖家拒绝 → 履约继续
 *   POST   /api/orders/:id/cancel-refund/mark-refunded 卖家声明已场外退款(refund_reference ≤200)
 *   POST   /api/orders/:id/cancel-refund/withdraw      买家撤回(仅卖家未响应前)
 *   POST   /api/orders/:id/cancel-refund/confirm       买家确认收到退款(RISK:真人 Passkey)→ 系统关单
 *
 * 本文件只做接线:auth + 参数 + confirm 的 db.transaction 原子边界 + Passkey 门 + 通知。
 * 状态/库存语义全在域模块;confirm 门=requireDirectPayHumanPasskey(purpose direct_pay_order_action,
 * action cancel_refund_confirm 走 purpose_data validate)—— agent 无 Passkey 永远过不了(RISK 铁律)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  requestCancelRefund, declineCancelRefund, markRefunded, withdrawCancelRefund,
  confirmRefundReceived, getCancelRefundState,
} from '../../direct-pay-cancel-refund.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam(通知收件人读)
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'

export interface DirectPayCancelRefundDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

export function registerDirectPayCancelRefundRoutes(app: Application, deps: DirectPayCancelRefundDeps): void {
  const { db, auth, generateId, errorRes, consumeGateToken } = deps
  const httpFor = (code: string | undefined): number =>
    code === 'ORDER_NOT_FOUND' ? 404
      : code === 'NOT_A_PARTY' || code === 'NOT_ORDER_BUYER' || code === 'NOT_ORDER_SELLER' ? 403
        : code === 'SYS_MISSING' ? 500
          : 409
  const notify = (userId: string, orderId: string, type: string, title: string, body: string): void => {
    try { createNotification(db, userId, orderId, type, title, body) } catch { /* 通知失败不阻断业务 */ }
  }
  const party = async (orderId: string): Promise<{ buyer_id: string; seller_id: string } | undefined> =>
    await dbOne<{ buyer_id: string; seller_id: string }>('SELECT buyer_id, seller_id FROM orders WHERE id = ?', [orderId])

  app.get('/api/orders/:id/cancel-refund', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = getCancelRefundState(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'CANCEL_REFUND_STATE_ERROR', r.error || '读取失败')
    res.json({ success: true, request: r.request ?? null, can_request: !!r.can_request, can_respond: !!r.can_respond, can_confirm: !!r.can_confirm, can_withdraw: !!r.can_withdraw })
  })

  app.post('/api/orders/:id/cancel-refund/request', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null
    const r = requestCancelRefund(db, { orderId: req.params.id, buyerId: user.id as string, reason, requestId: generateId('dpcr') })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'CANCEL_REFUND_REQUEST_ERROR', r.error || '发起失败')
    const p = await party(req.params.id)
    if (p) notify(p.seller_id, req.params.id, 'direct_pay_cancel_requested', '↩️ 买家申请取消订单并退款', `买家已付款但希望取消订单${reason ? `(理由:${String(reason).slice(0, 80)})` : ''}。请在期限内响应:同意则场外退款后点"我已退款",不同意可拒绝(继续发货)。直付非托管,退款在协议外完成。`)
    return void res.json({ success: true, status: r.status, request: r.request ?? null })
  })

  app.post('/api/orders/:id/cancel-refund/decline', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = declineCancelRefund(db, { orderId: req.params.id, sellerId: user.id as string })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'CANCEL_REFUND_DECLINE_ERROR', r.error || '拒绝失败')
    const p = await party(req.params.id)
    if (p) notify(p.buyer_id, req.params.id, 'direct_pay_cancel_declined', '❌ 卖家拒绝了取消退款请求', '卖家选择继续履约发货。如有异议可与卖家沟通,或在有证据时发起争议。')
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/cancel-refund/mark-refunded', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const refundReference = typeof req.body?.refund_reference === 'string' ? req.body.refund_reference : null
    const r = markRefunded(db, { orderId: req.params.id, sellerId: user.id as string, refundReference })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'CANCEL_REFUND_MARK_ERROR', r.error || '声明退款失败')
    const p = await party(req.params.id)
    if (p) notify(p.buyer_id, req.params.id, 'direct_pay_refund_marked', '💸 卖家已声明退款', `卖家声明已在协议外向你退款${refundReference ? `(退款参考:${String(refundReference).slice(0, 80)})` : ''}。请核实到账后在订单页确认(需 Passkey),订单将无责取消;若未收到退款请勿确认,可发起争议。`)
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/cancel-refund/withdraw', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = withdrawCancelRefund(db, { orderId: req.params.id, buyerId: user.id as string })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'CANCEL_REFUND_WITHDRAW_ERROR', r.error || '撤回失败')
    const p = await party(req.params.id)
    if (p) notify(p.seller_id, req.params.id, 'direct_pay_cancel_withdrawn', '↩️ 买家撤回了取消退款请求', '订单继续正常履约,请按流程发货。')
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/cancel-refund/confirm', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const uid = user.id as string
    // 只读预检(不消费 token):必须存在 refund_marked 的请求且订单仍 accepted,否则不浪费一次性 Passkey token
    const pre = getCancelRefundState(db, req.params.id, uid)
    if (!pre.ok) return void errorRes(res, httpFor(pre.error_code), pre.error_code || 'CANCEL_REFUND_STATE_ERROR', pre.error || '读取失败')
    if (!pre.can_confirm) return void errorRes(res, 409, 'REFUND_NOT_MARKED', '当前不可确认(卖家尚未声明退款,或订单已不在待发货阶段)')
    // RISK 门:确认收款并关单 = 终局动作 → 现场真人 Passkey(agent 无 Passkey 硬拒)
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: uid, webauthnToken: req.body?.webauthn_token as string | undefined, purpose: 'direct_pay_order_action',
      validate: (data) => { const d = data as { order_id?: string; action?: string } | null; return !!d && d.order_id === req.params.id && d.action === 'cancel_refund_confirm' },
    })
    if (!gate.ok) return void errorRes(res, 403, gate.error_code || 'HUMAN_PRESENCE_REQUIRED', gate.reason || '需现场真人 Passkey 确认')
    let r
    try {
      // 状态手术:请求行 CAS + accepted→cancelled + 库存恢复,同一原子边界(域内重校验防 ship/争议竞态)
      r = db.transaction(() => confirmRefundReceived(db, { orderId: req.params.id, buyerId: uid }, transition))()
    } catch (e) { return void errorRes(res, 409, 'CANCEL_REFUND_CONFIRM_FAILED', (e as Error).message) }
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'CANCEL_REFUND_CONFIRM_ERROR', r.error || '确认失败')
    const p = await party(req.params.id)
    if (p) notify(p.seller_id, req.params.id, 'direct_pay_cancel_settled', '✅ 取消退款握手完成', '买家已确认收到退款,订单已无责取消,库存已恢复。双方信誉均不受影响。')
    return void res.json({ success: true, status: r.status })
  })
}
