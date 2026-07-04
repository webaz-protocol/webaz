/**
 * 手动接单模式(v16)—— pending_accept 阶段的三个当事方动作(直付轨;escrow 轨不进本状态,
 * 其"接单"仍是付款后的既有 paid→accepted + 超时自动退款语义)。
 *
 *   POST /api/orders/:id/pending-accept/accept        卖家确认接单 → direct_pay_window(此刻起表付款窗、买家方可见收款信息)
 *   POST /api/orders/:id/pending-accept/decline       卖家谢绝(理由可选)→ 无责取消 + 回补库存
 *   POST /api/orders/:id/pending-accept/cancel        买家撤单 → 无责取消 + 回补库存
 *   POST /api/orders/:id/pending-accept/quote         (PR-3)卖家报价:模板外地区 {shipping_fee, est_days?, note?};
 *                                                      受建单快照单笔上限约束(货款+运费 ≤ per_tx_cap 快照);重置响应窗
 *   POST /api/orders/:id/pending-accept/confirm-quote (PR-3)买家确认新总额 → 运费并入 total_amount + 重建 payable
 *                                                      快照 → direct_pay_window。不确认可 /cancel(无责);卖家可 /decline
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
import { toUnits, toDecimal } from '../../money.js'
import { buildPayableSnapshot, type DirectPayAccountSnapshot } from '../../direct-pay-create.js'
import { safeRunDirectPayAmlMonitor } from '../../direct-pay-aml-monitor.js'

export interface DirectPayPendingAcceptDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}

type OrderRow = { id: string; buyer_id: string; seller_id: string; status: string; payment_rail: string; product_id: string; quantity: number; total_amount: number; shipping_quote_required: number | null; shipping_quote_fee: number | null; shipping_quote_est_days: string | null; direct_pay_per_tx_cap_units_snapshot: number | null; direct_pay_account_snapshot: string | null }

export function registerDirectPayPendingAcceptRoutes(app: Application, deps: DirectPayPendingAcceptDeps): void {
  const { db, auth, errorRes, getProtocolParam } = deps

  async function loadPendingOrder(req: Request, res: Response): Promise<OrderRow | null> {
    const order = await dbOne<OrderRow>('SELECT id, buyer_id, seller_id, status, payment_rail, product_id, quantity, total_amount, shipping_quote_required, shipping_quote_fee, shipping_quote_est_days, direct_pay_per_tx_cap_units_snapshot, direct_pay_account_snapshot FROM orders WHERE id = ?', [req.params.id])
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
    // 询价单不可裸接单(会绕过报价 → 无运费进付款窗):必须 quote → 买家 confirm-quote(PR-3)
    if (Number(order.shipping_quote_required) === 1) return void errorRes(res, 409, 'QUOTE_REQUIRED', '本单收货地区在运费模板外,请先报价(运费+时效),买家确认后自动进入付款')
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

  // ── 询价握手(PR-3,模板外地区)──────────────────────────────────────────
  // 卖家报价:运费+预计时效(+备注,买家可见)。只能加"运费"一个科目,不能动货款单价(防坐地起价披运费皮);
  //   货款+运费受【建单快照】单笔上限约束(cap 是买家最大裸损口径,必须含运费;用快照防事后调参绕过)。
  //   可重复报价(买家确认前修正);每次报价重置响应窗(param direct_pay.quote_confirm_hours,默认 48h)。
  app.post('/api/orders/:id/pending-accept/quote', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await loadPendingOrder(req, res); if (!order) return
    if (order.seller_id !== user.id) return void errorRes(res, 403, 'NOT_ORDER_SELLER', '只有订单卖家可报价')
    if (Number(order.shipping_quote_required) !== 1) return void errorRes(res, 409, 'NOT_QUOTE_ORDER', '本单不需询价(模板已覆盖或走普通接单)')
    const fee = Number(req.body?.shipping_fee)
    if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) return void errorRes(res, 400, 'BAD_QUOTE_FEE', '运费必须是 0~1000000 的数字')
    const feeR = Math.round(fee * 100) / 100
    const cap = Number(order.direct_pay_per_tx_cap_units_snapshot)
    if (Number.isFinite(cap) && cap > 0 && toUnits(Number(order.total_amount)) + toUnits(feeR) > cap) {
      return void errorRes(res, 409, 'QUOTE_EXCEEDS_CAP', `货款+运费超出本单单笔上限(${toDecimal(cap)} USDC),不能以运费形式突破小额直付边界`)
    }
    const est = req.body?.est_days == null ? null : String(req.body.est_days).trim().slice(0, 20) || null
    const note = req.body?.note == null ? null : String(req.body.note).trim().slice(0, 200) || null
    const confirmHours = Math.max(1, Number(getProtocolParam<number>('direct_pay.quote_confirm_hours', 48)) || 48)
    await dbRun(`UPDATE orders SET shipping_quote_fee = ?, shipping_quote_est_days = ?, shipping_quote_note = ?, shipping_quote_at = datetime('now'), pending_accept_deadline = ? WHERE id = ? AND status = 'pending_accept'`,
      [feeR, est, note, new Date(Date.now() + confirmHours * 3600_000).toISOString(), order.id])
    notify(order.buyer_id, order.id, 'direct_pay_quote_submitted', '📦 卖家已报价运费,请确认',
      `卖家确认可发货并报价:运费 ${feeR} USDC${est ? `,预计时效 ${est} 天` : ''}${note ? `(${note})` : ''}。新总额 ${Math.round((Number(order.total_amount) + feeR) * 100) / 100} USDC。请在 ${confirmHours} 小时内确认(确认后进入付款环节)或撤单;逾期订单自动取消。`,
      { templateKey: 'dp_quote_submitted', params: { fee: feeR, est: est ?? '', note: note ?? '', total: Math.round((Number(order.total_amount) + feeR) * 100) / 100, hours: confirmHours } })
    return void res.json({ success: true, shipping_quote_fee: feeR, est_days: est, new_total: Math.round((Number(order.total_amount) + feeR) * 100) / 100 })
  })

  // 买家确认报价 → 运费并入 total_amount(整数 units 精确加)+ 快照三列 + 重建 payable 参考换算 → 进付款窗。
  //   CAS:仅 pending_accept 且已报价;总额变更与状态转移同一 db.transaction(要么全生效要么全回滚)。
  app.post('/api/orders/:id/pending-accept/confirm-quote', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await loadPendingOrder(req, res); if (!order) return
    if (order.buyer_id !== user.id) return void errorRes(res, 403, 'NOT_ORDER_BUYER', '只有订单买家可确认报价')
    if (Number(order.shipping_quote_required) !== 1 || order.shipping_quote_fee == null) return void errorRes(res, 409, 'QUOTE_NOT_SUBMITTED', '卖家尚未报价,不可确认')
    const feeR = Number(order.shipping_quote_fee)
    const newTotal = toDecimal(toUnits(Number(order.total_amount)) + toUnits(feeR))
    const windowHours = Math.max(1, Number(getProtocolParam<number>('direct_pay.payment_window_hours', 4)) || 4)
    // payable 参考换算按新总额重建(display-only;账户快照缺失/坏 JSON → 保持原样,零阻断)
    let snapJson: string | null = order.direct_pay_account_snapshot
    try {
      if (snapJson) { const snap = JSON.parse(snapJson) as DirectPayAccountSnapshot; snapJson = JSON.stringify({ ...snap, ...buildPayableSnapshot(newTotal, snap.currency ?? null) }) }
    } catch { snapJson = order.direct_pay_account_snapshot }
    try {
      db.transaction(() => {
        const u = db.prepare(`UPDATE orders SET total_amount = ?, shipping_fee = ?, shipping_est_days = ?, direct_pay_account_snapshot = ?, direct_pay_window_deadline = ? WHERE id = ? AND status = 'pending_accept' AND shipping_quote_fee IS NOT NULL`)
          .run(newTotal, feeR, order.shipping_quote_est_days, snapJson, new Date(Date.now() + windowHours * 3600_000).toISOString(), order.id)
        if (u.changes !== 1) throw new Error('QUOTE_CONFIRM_RACE')
        const t = transition(db, order.id, 'direct_pay_window', 'sys_protocol', [], `买家确认运费报价(${feeR} USDC,新总额 ${newTotal})→ 进入直付付款窗口`)
        if (!t.success) throw new Error(t.error || 'TRANSITION_FAILED')
      })()
    } catch (e) { return void errorRes(res, 409, 'QUOTE_CONFIRM_FAILED', (e as Error).message) }
    // 总额变更后补跑 AML 监控(fail-soft,绝不回流为失败)
    safeRunDirectPayAmlMonitor(db, { sellerId: order.seller_id, orderId: order.id, nowIso: new Date().toISOString(), getProtocolParam })
    notify(order.seller_id, order.id, 'direct_pay_quote_confirmed', '✅ 买家已确认运费报价',
      `买家已确认新总额 ${newTotal} USDC(含运费 ${feeR}),订单进入付款窗口。买家完成场外付款并标记后你会收到发货提醒。`,
      { templateKey: 'dp_quote_confirmed', params: { total: newTotal, fee: feeR } })
    return void res.json({ success: true, status: 'direct_pay_window', total_amount: newTotal })
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
