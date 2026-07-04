/**
 * Direct Pay (Rail 1) 退货·场外退款握手路由 —— 送达后(completed)退货的退款执行环节。
 *
 * 骨架(request/decide/取件/消息/escalate)全在 routes/returns.ts 共用;本文件只加两个握手端点
 * (域逻辑在 src/direct-pay-returns.ts):
 *   POST /api/return-requests/:id/mark-refunded   卖家声明已场外退款(refund_reference ≤200)
 *   POST /api/return-requests/:id/confirm-refund  买家确认收到退款(RISK:真人 Passkey)→ refunded 终态
 *
 * 零资金零库存(不变量见域模块);confirm 门=requireDirectPayHumanPasskey(purpose direct_pay_order_action,
 * action return_refund_confirm 走 purpose_data validate)—— agent 无 Passkey 永远过不了(RISK 铁律)。
 * confirm 后卖家过错原因(quality/wrong_item/damaged)记 claim_upheld_against rep event(与 escrow
 * executeReturnRefund 同口径,tx 外 best-effort)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { markReturnRefunded, confirmReturnRefundReceived } from '../../direct-pay-returns.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'
import { recordRepEvent } from '../../layer4-economics/L4-3-reputation/reputation-engine.js'
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'

export interface DirectPayReturnsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

export function registerDirectPayReturnsRoutes(app: Application, deps: DirectPayReturnsDeps): void {
  const { db, auth, generateId, errorRes, consumeGateToken } = deps
  const httpFor = (code: string | undefined): number =>
    code === 'RETURN_NOT_FOUND' ? 404
      : code === 'NOT_ORDER_BUYER' || code === 'NOT_ORDER_SELLER' ? 403
        : 409
  const notify = (userId: string, orderId: string, type: string, title: string, body: string): void => {
    try { createNotification(db, userId, orderId, type, title, body) } catch { /* 通知失败不阻断业务 */ }
  }

  app.post('/api/return-requests/:id/mark-refunded', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const refundReference = typeof req.body?.refund_reference === 'string' ? req.body.refund_reference : null
    const r = markReturnRefunded(db, { returnId: req.params.id, sellerId: user.id as string, refundReference, messageId: generateId('rmsg') })
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'RETURN_MARK_REFUNDED_ERROR', r.error || '声明退款失败')
    const rr = await dbOne<{ buyer_id: string; order_id: string }>('SELECT buyer_id, order_id FROM return_requests WHERE id = ?', [req.params.id])
    if (rr) notify(rr.buyer_id, rr.order_id, 'direct_pay_return_refund_marked', '💸 卖家已声明退货退款', `卖家声明已在协议外向你退款${refundReference ? `(退款参考:${String(refundReference).slice(0, 80)})` : ''}。请核实到账后在订单页确认(需 Passkey),退货即完成;若未收到退款请勿确认,可发起争议。`)
    return void res.json({ success: true, status: r.status })
  })

  app.post('/api/return-requests/:id/confirm-refund', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const uid = user.id as string
    // 只读预检(不消费一次性 Passkey token):必须是本人 buyer 的 refund_marked 直付退货
    const pre = await dbOne<{ buyer_id: string; status: string; order_id: string; payment_rail: string | null }>(
      'SELECT r.buyer_id, r.status, r.order_id, o.payment_rail FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = ?', [req.params.id])
    if (!pre) return void errorRes(res, 404, 'RETURN_NOT_FOUND', '退货请求不存在')
    if (pre.buyer_id !== uid) return void errorRes(res, 403, 'NOT_ORDER_BUYER', '只有订单买家可确认收到退款')
    if (pre.payment_rail !== 'direct_p2p' || pre.status !== 'refund_marked') {
      return void errorRes(res, 409, 'REFUND_NOT_MARKED', '当前不可确认(卖家尚未声明退款,或非直付退货)')
    }
    // RISK 门:确认收款并终结退货 = 终局动作 → 现场真人 Passkey(agent 无 Passkey 硬拒)
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: uid, webauthnToken: req.body?.webauthn_token as string | undefined, purpose: 'direct_pay_order_action',
      validate: (data) => { const d = data as { order_id?: string; action?: string } | null; return !!d && d.order_id === pre.order_id && d.action === 'return_refund_confirm' },
    })
    if (!gate.ok) return void errorRes(res, 403, gate.error_code || 'HUMAN_PRESENCE_REQUIRED', gate.reason || '需现场真人 Passkey 确认')
    let r
    try {
      // CAS 终态翻转 + 全额退款社交计数 -1,同一原子边界(零资金零库存)
      r = db.transaction(() => confirmReturnRefundReceived(db, { returnId: req.params.id, buyerId: uid, messageId: generateId('rmsg') }))()
    } catch (e) { return void errorRes(res, 409, 'RETURN_CONFIRM_FAILED', (e as Error).message) }
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'RETURN_CONFIRM_ERROR', r.error || '确认失败')
    // 卖家过错原因 → rep event(与 escrow executeReturnRefund 同口径,tx 外 best-effort)
    try {
      if (r.seller_fault_reason && r.seller_id) {
        recordRepEvent(db, r.seller_id, 'claim_upheld_against', `退货接受 (reason=${r.seller_fault_reason}, return=${req.params.id})`, r.order_id || undefined)
      }
    } catch (e) { console.error('[dp return rep event]', e) }
    if (r.seller_id && r.order_id) notify(r.seller_id, r.order_id, 'direct_pay_return_settled', '✅ 退货已完成', '买家已确认收到场外退款,退货流程结束。提示:退回货物须经验收后方可重新上架(库存不会自动恢复)。')
    return void res.json({ success: true, status: r.status })
  })
}
