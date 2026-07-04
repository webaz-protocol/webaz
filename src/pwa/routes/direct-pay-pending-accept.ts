/**
 * 手动接单模式(v16)—— pending_accept 阶段的三个当事方动作(直付轨;escrow 轨不进本状态,
 * 其"接单"仍是付款后的既有 paid→accepted + 超时自动退款语义)。
 *
 *   POST /api/orders/:id/pending-accept/accept   卖家确认接单 → direct_pay_window(此刻起表付款窗、买家方可见收款信息)
 *   POST /api/orders/:id/pending-accept/decline  卖家谢绝(理由可选)→ 无责取消 + 回补库存
 *   POST /api/orders/:id/pending-accept/cancel   买家撤单 → 无责取消 + 回补库存
 *
 * 边界:
 *  - 零资金:此阶段没人付过钱(时序门的意义所在),取消无任何资金处理。
 *  - 全部动作 CAS 于 status='pending_accept'(transition 状态机守卫),并发双击/竞态只成功一次。
 *  - 回补库存走唯一入口 restorePreShipDirectPayStock(fromStatus='pending_accept',A 类必然未出库)。
 *  - 不 Passkey:接单/谢绝/撤单均非资金/终局动作(与 ship 同级);付款环节的既有门(D1/D2+Passkey)不变。
 *  - 超时未接单由 direct-pay-timeouts.ts 专属 cron 关单(同样无责+回补),本文件不做定时。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { restorePreShipDirectPayStock } from '../../direct-pay-stock.js'
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export interface DirectPayPendingAcceptDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}

type OrderRow = { id: string; buyer_id: string; seller_id: string; status: string; payment_rail: string; product_id: string; quantity: number; total_amount: number }

export function registerDirectPayPendingAcceptRoutes(app: Application, deps: DirectPayPendingAcceptDeps): void {
  const { db, auth, errorRes, getProtocolParam } = deps

  async function loadPendingOrder(req: Request, res: Response): Promise<OrderRow | null> {
    const order = await dbOne<OrderRow>('SELECT id, buyer_id, seller_id, status, payment_rail, product_id, quantity, total_amount FROM orders WHERE id = ?', [req.params.id])
    if (!order) { errorRes(res, 404, 'ORDER_NOT_FOUND', '订单不存在'); return null }
    if (order.payment_rail !== 'direct_p2p') { errorRes(res, 409, 'NOT_DIRECT_PAY', '仅直付订单有待接单阶段'); return null }
    if (order.status !== 'pending_accept') { errorRes(res, 409, 'NOT_PENDING_ACCEPT', `当前状态 ${order.status},不在待接单阶段`); return null }
    return order
  }
  const notify = (userId: string, orderId: string, type: string, title: string, body: string, tpl?: { templateKey: string; params: Record<string, unknown> }): void => {
    try { createNotification(db, userId, orderId, type, title, body, tpl) } catch { /* 通知失败不阻断 */ }
  }

  // ── 接单模式设置(卖家):店铺默认 + 单品覆盖。值 ∈ {'auto','manual',null=清除(单品回落店铺默认/店铺回落 auto)}。
  //   只影响【之后】的新订单(下单时快照);对两轨生效(escrow 'auto'=付款后系统自动接单;dp 'manual'=先进 pending_accept)。
  const MODE_OK = (v: unknown): v is string | null => v === null || v === 'auto' || v === 'manual'
  app.post('/api/seller/accept-mode', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void errorRes(res, 403, 'SELLER_ONLY', '仅卖家可设置接单模式')
    const b = req.body || {}
    const touched: Record<string, unknown> = {}
    if ('store_accept_mode' in b) {
      if (!MODE_OK(b.store_accept_mode)) return void errorRes(res, 400, 'BAD_ACCEPT_MODE', "store_accept_mode 只允许 'auto'|'manual'|null")
      await dbRun('UPDATE users SET store_accept_mode = ? WHERE id = ?', [b.store_accept_mode, user.id])
      touched.store_accept_mode = b.store_accept_mode
    }
    if ('product_id' in b || 'accept_mode' in b) {
      if (!b.product_id) return void errorRes(res, 400, 'MISSING_PRODUCT_ID', '设置单品接单模式须带 product_id')
      if (!MODE_OK(b.accept_mode)) return void errorRes(res, 400, 'BAD_ACCEPT_MODE', "accept_mode 只允许 'auto'|'manual'|null")
      const p = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!p) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (p.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品的接单模式')
      await dbRun('UPDATE products SET accept_mode = ? WHERE id = ?', [b.accept_mode, b.product_id])
      touched.product_accept_mode = b.accept_mode
    }
    if (Object.keys(touched).length === 0) return void errorRes(res, 400, 'NOTHING_TO_SET', '未提供任何设置项')
    return void res.json({ success: true, ...touched })
  })

  // 卖家确认接单 → 开付款窗口(deadline 此刻起表;收款信息此刻起买家可见 —— orders-read 状态门放行)
  app.post('/api/orders/:id/pending-accept/accept', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await loadPendingOrder(req, res); if (!order) return
    if (order.seller_id !== user.id) return void errorRes(res, 403, 'NOT_ORDER_SELLER', '只有订单卖家可接单')
    const windowHours = Math.max(1, Number(getProtocolParam<number>('direct_pay.payment_window_hours', 4)) || 4)
    try {
      db.transaction(() => {
        const t = transition(db, order.id, 'direct_pay_window', user.id as string, [], '卖家确认接单 → 进入直付付款窗口')
        if (!t.success) throw new Error(t.error || 'TRANSITION_FAILED')
        db.prepare('UPDATE orders SET direct_pay_window_deadline = ? WHERE id = ?')
          .run(new Date(Date.now() + windowHours * 3600_000).toISOString(), order.id)
      })()
    } catch (e) { return void errorRes(res, 409, 'ACCEPT_FAILED', (e as Error).message) }
    notify(order.buyer_id, order.id, 'direct_pay_accepted_by_seller', '✅ 卖家已确认接单,请付款',
      `卖家已确认可发货并接单。请在 ${windowHours} 小时内完成风险确认后查看收款方式并付款;逾期未付订单将进入超时流程。`,
      { templateKey: 'dp_pending_accept_accepted', params: { hours: windowHours } })
    return void res.json({ success: true, status: 'direct_pay_window' })
  })

  // 卖家谢绝(无法发货/物流不可达等;理由可选,买家可见)→ 无责取消 + 回补库存
  app.post('/api/orders/:id/pending-accept/decline', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await loadPendingOrder(req, res); if (!order) return
    if (order.seller_id !== user.id) return void errorRes(res, 403, 'NOT_ORDER_SELLER', '只有订单卖家可谢绝')
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : ''
    try {
      db.transaction(() => {
        const t = transition(db, order.id, 'cancelled', user.id as string, [], `卖家谢绝接单(付款前,无责取消)${reason ? `:${reason}` : ''}`)
        if (!t.success) throw new Error(t.error || 'TRANSITION_FAILED')
        restorePreShipDirectPayStock(db, { fromStatus: 'pending_accept', productId: order.product_id, quantity: Number(order.quantity) || 1 })
      })()
    } catch (e) { return void errorRes(res, 409, 'DECLINE_FAILED', (e as Error).message) }
    notify(order.buyer_id, order.id, 'direct_pay_accept_declined', '❌ 卖家未能接单,订单已取消',
      `卖家未能确认发货${reason ? `(${reason})` : ''}。订单已无责取消 —— 你尚未付款,无需任何操作;双方信誉均不受影响。`,
      { templateKey: 'dp_pending_accept_declined', params: { reason } })
    return void res.json({ success: true, status: 'cancelled' })
  })

  // 买家撤单(接单前反悔)→ 无责取消 + 回补库存
  app.post('/api/orders/:id/pending-accept/cancel', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await loadPendingOrder(req, res); if (!order) return
    if (order.buyer_id !== user.id) return void errorRes(res, 403, 'NOT_ORDER_BUYER', '只有订单买家可撤单')
    try {
      db.transaction(() => {
        const t = transition(db, order.id, 'cancelled', user.id as string, [], '买家在卖家接单前撤单(付款前,无责取消)')
        if (!t.success) throw new Error(t.error || 'TRANSITION_FAILED')
        restorePreShipDirectPayStock(db, { fromStatus: 'pending_accept', productId: order.product_id, quantity: Number(order.quantity) || 1 })
      })()
    } catch (e) { return void errorRes(res, 409, 'CANCEL_FAILED', (e as Error).message) }
    notify(order.seller_id, order.id, 'direct_pay_accept_cancelled', '↩️ 买家已撤单',
      '买家在你确认接单前撤回了订单。订单已无责取消,库存已恢复。',
      { templateKey: 'dp_pending_accept_cancelled', params: {} })
    return void res.json({ success: true, status: 'cancelled' })
  })
}
