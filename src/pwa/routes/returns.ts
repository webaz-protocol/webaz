/**
 * 退货请求域 (Wave B-3 + W2 售后协商时间线 + L3 物流取件)
 *
 * 由 #1013 Phase 25 从 src/pwa/server.ts 抽出。
 *
 * 11 endpoints:
 *   POST   /api/orders/:order_id/return-request        buyer 发起（含上门取件请求）
 *   GET    /api/orders/:order_id/return-request        订单级直查
 *   GET    /api/return-requests                        我的列表 (buyer/seller 自动切换)
 *   POST   /api/return-requests/:id/decide             seller accept/reject
 *   DELETE /api/return-requests/:id                    buyer cancel（仅 pending）
 *   GET    /api/return-requests/:id                    单条 + W2 timeline
 *   POST   /api/return-requests/:id/picked-up          logistics 揽收确认（accepted_pickup_pending → picked_up）
 *   POST   /api/return-requests/:id/received           seller 确认收到（picked_up → refunded）
 *   GET    /api/logistics/return-pickups               物流端取件任务列表
 *   POST   /api/return-requests/:id/messages           多轮协商消息
 *   POST   /api/return-requests/:id/escalate           升级争议（rejected 后 / pending ≥7 天）
 *
 * 不变量：
 *   - 仅 completed 订单可退（escrow 已结清;直付同口径=确认收货后）
 *   - return_days 窗口校验 + 一笔在途请求不重复（含直付握手态 await_refund/refund_marked）
 *   - 上门取件需 pickup_address ≥ 4 字
 *   - executeReturnRefund: 校验 seller 余额 + 划账 + 恢复 stock/variant.stock + 通知 + L3 上诉路径 claim_upheld_against rep event
 *   - 直付(direct_p2p)绝不走 executeReturnRefund：退款环节=场外握手（accept→await_refund→refund_marked→
 *     买家 Passkey confirm→refunded，src/direct-pay-returns.ts）；零资金、零库存回补（已出库=退货验收上架）
 *
 * 跨域 helpers:
 *   - recordRepEvent (L4-3 reputation-engine) — module 内 import
 *   - detectFraud (routes/chat.ts) / broadcastSystemEvent (server.ts) — deps
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { recordRepEvent } from '../../layer4-economics/L4-3-reputation/reputation-engine.js'
import { effectiveReturnDays } from '../../trade-terms.js'
// RFC-016 Phase 1 — 端点校验读/列表读 + 状态翻转/消息/通知单写 → async seam;
//   executeReturnRefund 退款 db.transaction(钱+库存)与 escalate 建争议 tx 保持同步(Phase 3 迁 pg)。
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'
// 直付(direct_p2p)退货:物流/协商骨架共用,退款执行环节换成场外握手(零资金零库存回补)。
//   mark-refunded / confirm-refund 端点在 routes/direct-pay-returns.ts。
import { enterAwaitRefund, directPayReturnEscalatable, returnRefundRespondDays } from '../../direct-pay-returns.js'

const VALID_RETURN_REASONS = new Set(['quality', 'wrong_item', 'damaged', 'no_longer_needed', 'other'])

const RETURN_REASON_DEFAULT_LABEL: Record<string, string> = {
  quality: '质量问题',
  wrong_item: '收到错款',
  damaged: '运输破损',
  no_longer_needed: '不再需要',
  other: '其他',
}

export interface ReturnsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void
  detectFraud: (text: string) => string[]
}

export function registerReturnsRoutes(app: Application, deps: ReturnsDeps): void {
  const { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent, detectFraud } = deps

  // L3 Phase 2 抽出：accept(无 pickup) 和 received(有 pickup) 共享退款 + 库存 + 通知
  // fromStatus = 调用方允许的源状态(accept-no-pickup='pending' / received='picked_up')。
  // Codex #235 P1:两个端点都 await 预读 rr.status 后才进入这个同步 tx,await 间隔内
  // 并发请求可都看到 pending/picked_up → 双双退款。故 tx 内先用 fromStatus CAS 抢占,
  // 先于任何钱/库存写;changes!==1 即并发已结算 → 抛回滚。
  function executeReturnRefund(rr: Record<string, unknown>, response: string | null, fromStatus: string): void {
    db.transaction(() => {
      const refundAmt = Number(rr.refund_amount)
      // 1. CAS 抢占 return 行(fromStatus→refunded),先于任何写
      const claimed = db.prepare(`UPDATE return_requests SET status = 'refunded', seller_response = COALESCE(?, seller_response), resolved_at = datetime('now') WHERE id = ? AND status = ?`)
        .run(response, rr.id, fromStatus)
      if (claimed.changes !== 1) throw new Error('RETURN_ALREADY_SETTLED')
      // 2. 卖家扣款带余额守卫;changes!==1 = 余额不足 → 抛回滚,买家不入账
      const debited = db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?').run(refundAmt, rr.seller_id, refundAmt)
      if (debited.changes !== 1) throw new Error('INSUFFICIENT_SELLER_BALANCE')
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(refundAmt, rr.buyer_id)
      // RFC-018: reverse this order's in-window clearing commission, proportional to the refund.
      // These pending rows were never paid (maturation is gated on matures_at), so this is a pure
      // reversal — no clawback. matures_at IS NOT NULL targets clearing rows only; opt-out escrow
      // rows (matures_at IS NULL) are untouched. Atomic with the refund.
      const ordTotal = Number((db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(rr.order_id) as { total_amount: number } | undefined)?.total_amount ?? 0)
      const refundFrac = ordTotal > 0 ? Math.min(1, refundAmt / ordTotal) : 1
      if (refundFrac >= 1) {
        db.prepare(`UPDATE pending_commission_escrow SET status='reversed' WHERE order_id = ? AND status='pending' AND matures_at IS NOT NULL`).run(rr.order_id)
        // RFC-018 PR4: a single FULL return is no longer a genuine sale — decrement the stored product
        // completion_count (incremented at settleOrder). Idempotent: the return CAS'd to 'refunded'
        // exactly once above, so this runs once. Partial refund stays a genuine sale (no decrement).
        // Edge: multiple partial refunds cumulatively reaching full aren't caught here (each refundFrac<1),
        // so the stored counter may transiently over-count by 1 — but the AUTHORITATIVE genuine count
        // (genuineSalePredicate, cumulative SUM) is correct everywhere on-read, and the completion_count
        // backfill (genuine-aware) self-heals the stored counter. completion_count is best-effort social proof.
        db.prepare(`UPDATE products SET completion_count = MAX(0, COALESCE(completion_count,0) - 1) WHERE id = ?`).run(rr.product_id)
      } else {
        db.prepare(`UPDATE pending_commission_escrow SET amount = amount * ? WHERE order_id = ? AND status='pending' AND matures_at IS NOT NULL`).run(1 - refundFrac, rr.order_id)
      }
      // 3. 恢复库存(CAS + 扣款成功后)
      const ord = db.prepare('SELECT quantity, source, variant_id FROM orders WHERE id = ?').get(rr.order_id) as { quantity: number; source: string; variant_id: string | null } | undefined
      if (ord && ord.source !== 'secondhand') {
        const qty = Math.max(1, Number(ord.quantity) || 1)
        db.prepare('UPDATE products SET stock = stock + ?, updated_at = datetime(\'now\') WHERE id = ?').run(qty, rr.product_id)
        if (ord.variant_id) {
          db.prepare('UPDATE product_variants SET stock = stock + ?, updated_at = datetime(\'now\') WHERE id = ?').run(qty, ord.variant_id)
        }
      }
      try {
        db.prepare(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`)
          .run(generateId('rmsg'), rr.id, rr.seller_id, 'seller', `[✓ 已退款] ${response || ''}`)
      } catch {}
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
          .run(generateId('ntf'), rr.buyer_id, '✓ 退款已到账', `${refundAmt} WAZ 已退回至你的钱包`, rr.order_id)
      } catch {}
    })()
    try {
      const SELLER_FAULT_REASONS = new Set(['quality', 'wrong_item', 'damaged'])
      if (SELLER_FAULT_REASONS.has(String(rr.reason))) {
        recordRepEvent(db, String(rr.seller_id), 'claim_upheld_against', `退货接受 (reason=${rr.reason}, return=${rr.id})`, String(rr.order_id))
      }
    } catch (e) { console.error('[return rep event]', e) }
  }

  // buyer 发起退货
  app.post('/api/orders/:order_id/return-request', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const order = await dbOne<{
      id: string; buyer_id: string; seller_id: string; product_id: string;
      status: string; total_amount: number; created_at: string; updated_at: string;
      return_days: number; product_title: string; payment_rail: string | null; trade_terms_snapshot: string | null;
    }>(`
      SELECT o.id, o.buyer_id, o.seller_id, o.product_id, o.status, o.total_amount, o.created_at, o.updated_at,
             o.payment_rail, o.trade_terms_snapshot, p.return_days, p.title as product_title
      FROM orders o JOIN products p ON p.id = o.product_id
      WHERE o.id = ?
    `, [req.params.order_id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家可申请退货' })
    // 直付(Rail1)= 非托管:退货【物流/协商骨架照用】,但退款执行环节换成场外握手(src/direct-pay-returns.ts,
    //   accept → await_refund → 卖家 mark_refunded → 买家 Passkey confirm → refunded)。零资金零库存回补
    //   (已出库=B 类,退货验收上架);平台费应收的冲销仍由治理/admin 调整处理(非此路径)。
    // P0-1: 只允许 completed 退货 — escrow 已结算(直付同口径:确认收货后)
    if (order.status !== 'completed') {
      return void res.status(400).json({ error: '仅订单完成后可申请退货（确认收货后）' })
    }
    // RFC-026:退货窗按【下单时刻冻结的条款快照】治理(S0 不变量:商家事后改设置不影响旧订单,
    //   既不收紧也不放宽);pre-S0 订单回退现商品行。单一真相源 = effectiveReturnDays(agent 订单视图同函数)。
    const eff = effectiveReturnDays(order.trade_terms_snapshot, order.return_days)
    const returnDays = eff.days
    if (returnDays <= 0) return void res.status(400).json({ error: eff.source === 'order_snapshot' ? '该订单成交时商品未提供退货(按下单时冻结条款)' : '该商品不支持退货' })
    const baseTime = order.updated_at || order.created_at
    const deadlineMs = new Date(baseTime).getTime() + returnDays * 86400 * 1000
    if (Date.now() > deadlineMs) {
      return void res.status(400).json({ error: `已超过 ${returnDays} 天退货窗口` })
    }
    const existing = await dbOne<{ id: string; status: string }>(`
      SELECT id, status FROM return_requests WHERE order_id = ? AND status IN ('pending', 'accepted', 'accepted_pickup_pending', 'picked_up', 'await_refund', 'refund_marked') LIMIT 1
    `, [order.id])
    if (existing) return void res.status(400).json({ error: `已存在退货请求 (${existing.status})` })
    const reason = String(req.body?.reason || '')
    if (!VALID_RETURN_REASONS.has(reason)) return void res.status(400).json({ error: '无效的退货原因' })
    const reasonText = req.body?.reason_text ? String(req.body.reason_text).slice(0, 500) : null
    const refundAmount = req.body?.refund_amount != null ? Number(req.body.refund_amount) : Number(order.total_amount)
    if (refundAmount <= 0 || refundAmount > Number(order.total_amount)) {
      return void res.status(400).json({ error: '退款金额必须在 0 ~ 订单金额之间' })
    }
    // L3+B3：上门取件请求
    const pickupRequested = req.body?.pickup_requested ? 1 : 0
    const pickupAddress = pickupRequested && req.body?.pickup_address
      ? String(req.body.pickup_address).slice(0, 300).trim()
      : null
    if (pickupRequested && (!pickupAddress || pickupAddress.length < 4)) {
      return void res.status(400).json({ error: '请求上门取件时必须提供取件地址（≥ 4 字）' })
    }
    const reqId = generateId('ret')
    await dbRun(`
      INSERT INTO return_requests (id, order_id, buyer_id, seller_id, product_id, reason, reason_text, refund_amount, status, pickup_requested, pickup_address)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?)
    `, [reqId, order.id, order.buyer_id, order.seller_id, order.product_id, reason, reasonText, refundAmount, pickupRequested, pickupAddress])
    try {
      const actions = JSON.stringify([{ kind: 'navigate', label: '处理退货', href: `#order/${order.id}`, style: 'primary' }])
      const pickupNote = pickupRequested ? '（含上门取件请求）' : ''
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
        [generateId('ntf'), order.seller_id, 'return_request', '⚠ 收到退货请求' + pickupNote, `订单 ${order.product_title} 申请退货 — 原因：${reason}${pickupRequested ? '\n📍 上门取件：' + pickupAddress : ''}`, order.id, actions])
    } catch (e) { console.error('[return notify]', e) }
    try { broadcastSystemEvent('return', '↩', `退货申请 ${reqId} · ${refundAmount} WAZ`, order.id) } catch {}
    res.json({ success: true, id: reqId, pickup_requested: !!pickupRequested })
  })

  // P1-5: 订单级直查
  app.get('/api/orders/:order_id/return-request', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<{ buyer_id: string; seller_id: string }>('SELECT buyer_id, seller_id FROM orders WHERE id = ?', [req.params.order_id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.buyer_id !== user.id && order.seller_id !== user.id) {
      return void res.status(403).json({ error: '无权查看' })
    }
    const row = await dbOne(`
      SELECT id, order_id, product_id, reason, reason_text, refund_amount,
             status, seller_response, escalated_dispute_id, created_at, resolved_at
      FROM return_requests
      WHERE order_id = ?
      ORDER BY created_at DESC LIMIT 1
    `, [req.params.order_id])
    res.json({ item: row || null })
  })

  app.get('/api/return-requests', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const status = req.query.status ? String(req.query.status) : null
    const role = req.query.role === 'seller' ? 'seller' : 'buyer'
    const field = role === 'seller' ? 'seller_id' : 'buyer_id'
    const where = [`r.${field} = ?`]
    const params: unknown[] = [user.id]
    if (status) { where.push('r.status = ?'); params.push(status) }
    const rows = await dbAll(`
      SELECT r.id, r.order_id, r.product_id, r.reason, r.reason_text, r.refund_amount,
             r.status, r.seller_response, r.escalated_dispute_id, r.created_at, r.resolved_at,
             p.title as product_title, p.category,
             o.total_amount as order_total,
             ub.name as buyer_name, ub.handle as buyer_handle,
             us.name as seller_name, us.handle as seller_handle
      FROM return_requests r
      JOIN products p ON p.id = r.product_id
      JOIN orders o ON o.id = r.order_id
      JOIN users ub ON ub.id = r.buyer_id
      JOIN users us ON us.id = r.seller_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC LIMIT 200
    `, params)
    res.json({ items: rows })
  })

  app.post('/api/return-requests/:id/decide', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rr = await dbOne<Record<string, unknown>>(`SELECT * FROM return_requests WHERE id = ?`, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '退货请求不存在' })
    if (rr.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可决策' })
    if (rr.status !== 'pending') return void res.status(400).json({ error: `当前状态 ${rr.status}，不可决策` })
    const decision = String(req.body?.decision || '')
    if (!['accept', 'reject'].includes(decision)) return void res.status(400).json({ error: '无效决策' })
    const response = req.body?.response ? String(req.body.response).slice(0, 500) : null
    if (decision === 'reject' && !response) return void res.status(400).json({ error: '拒绝时必须填写说明' })

    // 直付(direct_p2p):同意退货后不走 escrow 钱包退款,进入场外退款握手(await_refund)。取件流照用
    //   (accepted_pickup_pending → picked_up → received 时再进 await_refund)。
    const railRow = await dbOne<{ payment_rail: string | null }>('SELECT payment_rail FROM orders WHERE id = ?', [rr.order_id])
    const isDirectPay = railRow?.payment_rail === 'direct_p2p'

    if (decision === 'accept') {
      if (Number(rr.pickup_requested) === 1) {
        await dbRun(`UPDATE return_requests SET status = 'accepted_pickup_pending', seller_response = ? WHERE id = ?`, [response, rr.id])
        try {
          await dbRun(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`,
            [generateId('rmsg'), rr.id, rr.seller_id, 'seller', `[✓ 同意 · 等待上门取件] ${response || ''}`])
        } catch {}
        try {
          await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
            [generateId('ntf'), rr.buyer_id, '✓ 退货已接受 · 等待上门取件', `卖家将安排物流到 ${rr.pickup_address || '指定地址'} 上门取件`, rr.order_id])
        } catch {}
        return void res.json({ success: true, status: 'accepted_pickup_pending' })
      }
      if (isDirectPay) {
        const r = enterAwaitRefund(db, { returnId: String(rr.id), fromStatus: 'pending', sellerResponse: response, messageId: generateId('rmsg') })
        if (!r.ok) return void res.status(409).json({ error: r.error, error_code: r.error_code })
        try {
          await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`,
            [generateId('ntf'), rr.buyer_id, 'direct_pay_return_await_refund', '✓ 退货已同意 · 等待卖家场外退款', '直付订单非托管:卖家将在协议外向你退款并声明,请核实到账后在订单页确认(需 Passkey)。卖家超期未退款可升级争议。', rr.order_id])
        } catch {}
        return void res.json({ success: true, status: 'await_refund' })
      }
      try {
        executeReturnRefund(rr as Record<string, unknown>, response, 'pending')
      } catch (e) {
        const m = (e as Error).message
        if (m === 'RETURN_ALREADY_SETTLED') return void res.status(409).json({ error: '该退货已处理（请刷新后查看）' })
        const msg = m === 'INSUFFICIENT_SELLER_BALANCE' ? '卖家余额不足以退款' : '退款失败'
        return void res.status(400).json({ error: msg })
      }
      return void res.json({ success: true, status: 'refunded' })
    } else {
      await dbRun(`UPDATE return_requests SET status = 'rejected', seller_response = ?, resolved_at = datetime('now') WHERE id = ?`, [response, rr.id])
      try {
        await dbRun(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`,
          [generateId('rmsg'), rr.id, rr.seller_id, 'seller', `[✗ 拒绝退款] ${response}`])
      } catch {}
      try {
        await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
          [generateId('ntf'), rr.buyer_id, '⚠ 退货请求被拒绝', `卖家说明：${response} — 如有异议可发起争议`, rr.order_id])
      } catch {}
      return void res.json({ success: true, status: 'rejected' })
    }
  })

  app.delete('/api/return-requests/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rr = await dbOne<{ id: string; buyer_id: string; status: string }>(`SELECT id, buyer_id, status FROM return_requests WHERE id = ?`, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '不存在' })
    if (rr.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家可取消' })
    if (rr.status !== 'pending') return void res.status(400).json({ error: `当前状态 ${rr.status}，不可取消` })
    await dbRun(`UPDATE return_requests SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?`, [rr.id])
    res.json({ success: true })
  })

  // ─── W2 售后协商时间线 ───────────────────────────────
  app.get('/api/return-requests/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rr = await dbOne<Record<string, unknown>>(`
      SELECT r.*, p.title as product_title, p.category,
             o.total_amount as order_total,
             ub.name as buyer_name, ub.handle as buyer_handle,
             us.name as seller_name, us.handle as seller_handle
      FROM return_requests r
      JOIN products p ON p.id = r.product_id
      JOIN orders o ON o.id = r.order_id
      JOIN users ub ON ub.id = r.buyer_id
      JOIN users us ON us.id = r.seller_id
      WHERE r.id = ?
    `, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '不存在' })
    if (rr.buyer_id !== user.id && rr.seller_id !== user.id) {
      return void res.status(403).json({ error: '无权查看' })
    }

    const messages = await dbAll<Record<string, unknown>>(`
      SELECT m.*, u.name as sender_name, u.handle as sender_handle
      FROM return_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.return_id = ? ORDER BY m.created_at ASC
    `, [rr.id])

    type TLEvent = {
      id: string
      type: 'created' | 'message' | 'accepted' | 'rejected' | 'refunded' | 'escalated' | 'cancelled'
      flagged?: number
      flag_reasons?: string[]
      ts: string
      actor_id: string | null
      actor_role: 'buyer' | 'seller' | 'system'
      body: string
      meta?: Record<string, unknown>
    }
    const events: TLEvent[] = []

    events.push({
      id: `create-${rr.id}`,
      type: 'created',
      ts: String(rr.created_at || ''),
      actor_id: String(rr.buyer_id),
      actor_role: 'buyer',
      body: String(rr.reason_text || ''),
      meta: { reason: rr.reason, refund_amount: rr.refund_amount },
    })

    for (const m of messages) {
      let fr: string[] = []
      try { fr = m.flag_reasons ? JSON.parse(String(m.flag_reasons)) : [] } catch {}
      events.push({
        id: `msg-${m.id}`,
        type: 'message',
        ts: String(m.created_at || ''),
        actor_id: m.sender_id ? String(m.sender_id) : null,
        actor_role: (m.sender_role || 'buyer') as 'buyer' | 'seller' | 'system',
        body: String(m.body || ''),
        flagged: Number(m.flagged || 0),
        flag_reasons: fr,
      })
    }

    if (rr.resolved_at) {
      const status = String(rr.status)
      let type: TLEvent['type'] | null = null
      let role: TLEvent['actor_role'] = 'system'
      let actorId: string | null = null
      if (status === 'refunded') { type = 'refunded'; role = 'seller'; actorId = String(rr.seller_id) }
      else if (status === 'cancelled') { type = 'cancelled'; role = 'buyer'; actorId = String(rr.buyer_id) }
      else if (status === 'escalated') { type = 'escalated'; role = 'buyer'; actorId = String(rr.buyer_id) }
      if (type) {
        events.push({
          id: `done-${rr.id}`,
          type,
          ts: String(rr.resolved_at),
          actor_id: actorId,
          actor_role: role,
          body: '',
          meta: type === 'escalated' ? { dispute_id: rr.escalated_dispute_id } : undefined,
        })
      }
    }

    events.sort((a, b) => a.ts.localeCompare(b.ts))
    res.json({ item: rr, timeline: events })
  })

  // L3 Phase 2: 物流揽收
  app.post('/api/return-requests/:id/picked-up', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'logistics') return void res.status(403).json({ error: '仅物流角色可确认揽收' })
    const rr = await dbOne<Record<string, unknown>>(`SELECT * FROM return_requests WHERE id = ?`, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '退货请求不存在' })
    if (rr.status !== 'accepted_pickup_pending') return void res.status(400).json({ error: `当前状态 ${rr.status}，不可揽收` })
    const evidence = String(req.body?.evidence || '').trim().slice(0, 500)
    if (evidence.length < 4) return void res.status(400).json({ error: '请提供揽收证据（快递单号 / GPS / 照片描述）≥ 4 字' })

    await dbRun(`UPDATE return_requests SET status = 'picked_up' WHERE id = ?`, [rr.id])
    try {
      await dbRun(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`,
        [generateId('rmsg'), rr.id, user.id, 'logistics', `[📦 已揽收] ${evidence}`])
    } catch {}
    try {
      const actions = JSON.stringify([{ kind: 'navigate', label: '处理退货', href: `#returns`, style: 'primary' }])
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
        [generateId('ntf'), rr.seller_id, 'return_pickup', '📦 退货已揽收 · 等待你确认收到', `物流已揽收：${evidence.slice(0, 80)}`, rr.order_id, actions])
    } catch {}
    res.json({ success: true, status: 'picked_up' })
  })

  // L3 Phase 2: 卖家确认收到 → refunded
  app.post('/api/return-requests/:id/received', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rr = await dbOne<Record<string, unknown>>(`SELECT * FROM return_requests WHERE id = ?`, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '退货请求不存在' })
    if (rr.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可确认收到' })
    if (rr.status !== 'picked_up') return void res.status(400).json({ error: `当前状态 ${rr.status}，不可确认（应在 picked_up 状态）` })
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : null
    // 直付:收到退货后进入场外退款握手(不走 escrow 钱包退款)
    const railRow = await dbOne<{ payment_rail: string | null }>('SELECT payment_rail FROM orders WHERE id = ?', [rr.order_id])
    if (railRow?.payment_rail === 'direct_p2p') {
      const r = enterAwaitRefund(db, { returnId: String(rr.id), fromStatus: 'picked_up', sellerResponse: note, messageId: generateId('rmsg') })
      if (!r.ok) return void res.status(409).json({ error: r.error, error_code: r.error_code })
      try {
        await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`,
          [generateId('ntf'), rr.buyer_id, 'direct_pay_return_await_refund', '✓ 卖家已收到退货 · 等待场外退款', '直付订单非托管:卖家将在协议外向你退款并声明,请核实到账后在订单页确认(需 Passkey)。卖家超期未退款可升级争议。', rr.order_id])
      } catch {}
      return void res.json({ success: true, status: 'await_refund' })
    }
    try {
      executeReturnRefund(rr, note, 'picked_up')
    } catch (e) {
      const m = (e as Error).message
      if (m === 'RETURN_ALREADY_SETTLED') return void res.status(409).json({ error: '该退货已处理（请刷新后查看）' })
      const msg = m === 'INSUFFICIENT_SELLER_BALANCE' ? '卖家余额不足以退款' : '退款失败'
      return void res.status(400).json({ error: msg })
    }
    res.json({ success: true, status: 'refunded' })
  })

  app.get('/api/logistics/return-pickups', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'logistics') return void res.status(403).json({ error: '仅物流角色' })
    const rows = await dbAll(`
      SELECT rr.id, rr.order_id, rr.product_id, rr.refund_amount, rr.pickup_address,
             rr.reason, rr.created_at, p.title as product_title,
             ub.handle as buyer_handle, us.name as seller_name
      FROM return_requests rr
      JOIN products p ON p.id = rr.product_id
      JOIN users ub ON ub.id = rr.buyer_id
      JOIN users us ON us.id = rr.seller_id
      WHERE rr.status = 'accepted_pickup_pending' AND rr.pickup_requested = 1
      ORDER BY rr.created_at ASC LIMIT 50
    `)
    res.json({ items: rows })
  })

  app.post('/api/return-requests/:id/messages', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rr = await dbOne<{ id: string; buyer_id: string; seller_id: string; status: string }>(`SELECT id, buyer_id, seller_id, status FROM return_requests WHERE id = ?`, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '不存在' })
    const isBuyer = rr.buyer_id === user.id
    const isSeller = rr.seller_id === user.id
    if (!isBuyer && !isSeller) return void res.status(403).json({ error: '仅买卖双方可发消息' })
    if (['refunded', 'cancelled', 'escalated'].includes(rr.status)) {
      return void res.status(400).json({ error: `当前状态 ${rr.status}，协商已结束` })
    }
    const body = String(req.body?.body || '').trim()
    if (body.length < 1 || body.length > 1000) return void res.status(400).json({ error: '消息长度 1-1000 字' })

    const reasons = detectFraud(body)
    const mid = generateId('rmsg')
    await dbRun(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body, flagged, flag_reasons) VALUES (?,?,?,?,?,?,?)`,
      [mid, rr.id, user.id, isBuyer ? 'buyer' : 'seller', body, reasons.length ? 1 : 0, reasons.length ? JSON.stringify(reasons) : null])

    try {
      const otherId = isBuyer ? rr.seller_id : rr.buyer_id
      const orderId = (rr as Record<string, unknown>).order_id as string
      const actions = JSON.stringify([{ kind: 'navigate', label: '查看协商', href: `#order/${orderId}`, style: 'primary' }])
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
        [generateId('ntf'), otherId, 'return_msg', '💬 退货协商新消息', body.slice(0, 80), orderId, actions])
    } catch (e) { console.warn('[notif return_msg]', (e as Error).message) }

    res.json({ success: true, id: mid, flagged: reasons.length > 0, flag_reasons: reasons })
  })

  // buyer 升级到争议（仅 rejected 后或 pending ≥ 7 天）
  app.post('/api/return-requests/:id/escalate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rr = await dbOne<Record<string, unknown>>(`SELECT * FROM return_requests WHERE id = ?`, [req.params.id])
    if (!rr) return void res.status(404).json({ error: '不存在' })
    if (rr.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家可升级' })
    // 直付握手状态可升级:refund_marked 随时(声明≠到账);await_refund 超 respond 窗(卖家同意却不退款)
    const isDpEsc = ['await_refund', 'refund_marked'].includes(String(rr.status)) && directPayReturnEscalatable(db, rr)
    if (rr.status !== 'rejected' && rr.status !== 'pending' && !isDpEsc) {
      if (rr.status === 'await_refund') return void res.status(400).json({ error: `卖家有 ${returnRefundRespondDays(db)} 天场外退款窗口，超期后可升级` })
      return void res.status(400).json({ error: `当前状态 ${rr.status}，无法升级` })
    }
    if (rr.status === 'pending') {
      const ageMs = Date.now() - new Date(String(rr.created_at)).getTime()
      if (ageMs < 7 * 86400 * 1000) {
        return void res.status(400).json({ error: '卖家有 7 天回应窗口，超期后可升级' })
      }
    }
    if (rr.escalated_dispute_id) return void res.status(400).json({ error: '已升级' })

    const order = await dbOne<{ id: string; total_amount: number }>('SELECT id, total_amount FROM orders WHERE id = ?', [rr.order_id])
    if (!order) return void res.status(500).json({ error: '订单数据缺失' })

    const reason = `退货协商失败：${RETURN_REASON_DEFAULT_LABEL[String(rr.reason)] || rr.reason}${rr.reason_text ? ' — ' + rr.reason_text : ''}`
    const disputeId = generateId('dsp')
    const now = new Date()
    const respondDeadline = new Date(now.getTime() + 48 * 3600 * 1000).toISOString()
    const arbitrateDeadline = new Date(now.getTime() + 120 * 3600 * 1000).toISOString()

    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO disputes (
            id, order_id, initiator_id, defendant_id, reason, status,
            defendant_evidence_ids, respond_deadline, arbitrate_deadline, assigned_arbitrators
          ) VALUES (?, ?, ?, ?, ?, 'open', '[]', ?, ?, '[]')
        `).run(disputeId, order.id, rr.buyer_id, rr.seller_id, reason, respondDeadline, arbitrateDeadline)
        db.prepare(`UPDATE return_requests SET status = 'escalated', escalated_dispute_id = ?, resolved_at = datetime('now') WHERE id = ?`)
          .run(disputeId, rr.id)
      })()
    } catch (e) {
      return void res.status(500).json({ error: '升级失败：' + (e as Error).message })
    }

    try {
      await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
        [generateId('ntf'), rr.seller_id, '⚖️ 退货已升级为争议', `争议 ${disputeId} 已创建，请在 48h 内提交反驳`, rr.order_id])
    } catch {}
    try { broadcastSystemEvent('dispute_open', '⚖', `退货升级 (订单 ${order.id})`, order.id) } catch {}

    res.json({ success: true, dispute_id: disputeId })
  })
}
