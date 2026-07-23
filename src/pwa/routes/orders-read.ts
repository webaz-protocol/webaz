/**
 * Orders 读端点 — 列表 + 详情 + 链上验签 + CSV 导出
 *
 * 由 #1013 Phase 83 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET /api/orders                我作为 buyer/seller/logistics 的订单列表（B2 匿名 mask）
 *   GET /api/orders/export         CSV 导出（5000 上限 + X-Truncated 头 + Excel BOM）
 *   GET /api/orders/:id/chain      订单签名链查询 + verify（当事人/arbitrator/admin 可访问）
 *   GET /api/orders/:id            详情聚合（含 history+evidence+tracking+dispute；B2 anonymous mask）
 *
 * B2 隐私购物：anonymous_recipient=1 且非 buyer 本人 → shipping_address 前缀 PR-代号；
 *              recipient_code 不下放给 seller/logistics
 *
 * 跨域注入：auth + getOrderStatus + getOrderChain + verifyOrderChain + getOrderDispute
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
// RFC-011 §⑥ 事件游标流(纯 db 函数,party-gated)
import { listOrderEventsSince } from '../../layer0-foundation/L0-2-state-machine/order-chain.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { requireBothDisclosuresAcked } from '../../direct-pay-disclosures.js'  // PR-4f-b: direct_p2p 收款说明响应契约门
import { projectDirectPayTargetForViewer } from '../direct-pay-order-redaction.js'  // 收款目标披露门:按查看者一次分派(买家=ack 门/卖家=收款方保留/第三方=剥离),所有 orders reader 必过
import { getMutualCancelState } from '../../layer3-trust/L3-1-dispute-engine/mutual-cancel.js'  // 协商取消(无责合意)可达性 + 当前提议(仅 disputed 计算,UI 便利字段)
import { getCancelRefundState } from '../../direct-pay-cancel-refund.js'  // 直付取消退款握手状态(仅 direct_p2p+accepted 计算,UI 便利字段)
import { getFaultRefundState } from '../../direct-pay-fault-refund.js'  // P1-D 判责关单退款握手状态(仅 direct_p2p+处置关单计算)
import { isEligibleArbitrator } from '../arbitrator-lifecycle.js'  // 白名单仲裁员可查【争议中】订单(裁定所需);不看 legacy role==='arbitrator'
import { getQrImageForOwner } from '../../direct-receive-account-qr.js'  // Rail1 D2:ack 门后按订单快照 qr_ref 取收款码字节((ref,seller_id) 域内)
import { readTradeTermsSnapshot, effectiveReturnDays } from '../../trade-terms.js'  // S0:下单冻结的交易条款(时效/退货/清关/税责),争议书面依据

export interface OrdersReadDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getOrderStatus: (db: Database.Database, orderId: string) => unknown
  getOrderChain: any
  verifyOrderChain: any
  getOrderDispute: any
}

export function registerOrdersReadRoutes(app: Application, deps: OrdersReadDeps): void {
  const { db, auth, getOrderStatus, getOrderChain, verifyOrderChain, getOrderDispute } = deps

  // 仲裁员订单可见性(详情 + 签名链共用同一谓词,防两路漂移):active 白名单(唯一能力源,不看 legacy user.role)
  //   且【该订单存在争议记录】—— 含已裁定/已驳回:裁定后订单离开 disputed,但仲裁员复盘/申诉处理自己的案件仍需可见,
  //   与 disputes-read"任意 active 仲裁员可读任意争议(含已结)"同口径。无争议记录的订单一律不可见 → 不可枚举任意订单。
  const arbitratorCanViewOrder = async (orderId: string, userId: string): Promise<boolean> =>
    isEligibleArbitrator(db, userId).ok && !!(await dbOne('SELECT 1 FROM disputes WHERE order_id = ? LIMIT 1', [orderId]))

  app.get('/api/orders', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    // 可选按支付轨筛选(escrow=托管 / direct_p2p=直接收款);非法值忽略。参与方 OR 必须整体括起,否则 AND 优先级会绑错。
    const rail = req.query.rail === 'direct_p2p' ? 'direct_p2p' : req.query.rail === 'escrow' ? 'escrow' : null
    const railClause = rail ? ' AND o.payment_rail = ?' : ''
    const railParams = rail ? [rail] : []
    const orders = await dbAll<Record<string, unknown>>(`
      SELECT o.*, p.title as product_title, p.images,
        ub.name as buyer_name, us.name as seller_name
      FROM orders o
      JOIN products p ON o.product_id = p.id
      JOIN users ub ON o.buyer_id = ub.id
      JOIN users us ON o.seller_id = us.id
      WHERE (o.buyer_id = ? OR o.seller_id = ? OR o.logistics_id = ?)${railClause}
      ORDER BY o.created_at DESC LIMIT 50
    `, [user.id, user.id, user.id, ...railParams])
    // B2 隐私购物：列表里也做相同 mask（防 seller/logistics 通过列表绕过详情 mask）
    for (const o of orders) {
      if (Number(o.anonymous_recipient) === 1 && o.buyer_id !== user.id) {
        const code = o.recipient_code || 'PR-?????'
        o.shipping_address = `🔒 ${code} · ${o.shipping_address}`
        delete o.recipient_code
        o.buyer_name = '🔒 ' + (typeof code === 'string' ? code : 'PR-?????')
      }
      projectDirectPayTargetForViewer(db, o, user.id as string)   // #179/#218 审计:收款目标按查看者投影(买家=ack 门/卖家保留/第三方剥离),列表不得旁路
      delete o.trade_terms_snapshot   // S0:列表不下放条款快照原始串(详情页解析后下放,列表省流量)
    }
    res.json(orders)
  })

  // Wave D-2: 订单导出 CSV
  app.get('/api/orders/export', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const role = req.query.role === 'seller' ? 'seller' : 'buyer'
    const field = role === 'seller' ? 'o.seller_id' : 'o.buyer_id'
    const from = req.query.from ? String(req.query.from) : null
    const to = req.query.to ? String(req.query.to) : null
    const rail = req.query.rail === 'direct_p2p' ? 'direct_p2p' : req.query.rail === 'escrow' ? 'escrow' : null
    const where = [`${field} = ?`]
    const params: unknown[] = [user.id]
    if (from) { where.push(`o.created_at >= ?`); params.push(from) }
    if (to) { where.push(`o.created_at <= ?`); params.push(to) }
    if (rail) { where.push(`o.payment_rail = ?`); params.push(rail) }   // 按支付轨导出(对账:托管 vs 直接收款分开)
    const EXPORT_LIMIT = 5000
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT o.id, o.created_at, o.status, o.quantity, o.unit_price, o.total_amount,
             o.coupon_discount, o.variant_options_snapshot, o.shipping_address,
             COALESCE(o.payment_rail, 'escrow') as payment_rail,
             p.title as product_title, p.category,
             ub.handle as buyer_handle, ub.name as buyer_name,
             us.handle as seller_handle, us.name as seller_name
      FROM orders o
      JOIN products p ON p.id = o.product_id
      JOIN users ub ON ub.id = o.buyer_id
      JOIN users us ON us.id = o.seller_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC LIMIT ?
    `, [...params, EXPORT_LIMIT + 1])
    // P1-4: 触达上限 → X-Truncated 头
    const truncated = rows.length > EXPORT_LIMIT
    if (truncated) rows.length = EXPORT_LIMIT
    const csvEscape = (val: unknown): string => {
      const s = val == null ? '' : String(val)
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    }
    const headers = ['order_id', 'created_at', 'status', 'payment_rail', 'product', 'category', 'qty', 'unit_price', 'total', 'coupon_discount', 'variant', 'buyer', 'seller', 'address']
    const lines = [headers.join(',')]
    for (const r of rows) {
      let variantStr = ''
      try {
        const v = r.variant_options_snapshot ? JSON.parse(r.variant_options_snapshot as string) : null
        if (v) variantStr = Object.entries(v).map(([k, val]) => `${k}:${val}`).join(';')
      } catch {}
      lines.push([
        r.id, r.created_at, r.status, r.payment_rail, r.product_title, r.category,
        r.quantity, r.unit_price, r.total_amount, r.coupon_discount || 0,
        variantStr, r.buyer_handle, r.seller_handle, r.shipping_address,
      ].map(csvEscape).join(','))
    }
    const filename = `webaz-orders-${role}-${new Date().toISOString().slice(0, 10)}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    if (truncated) {
      res.setHeader('X-Truncated', '1')
      res.setHeader('X-Truncated-Limit', String(EXPORT_LIMIT))
      res.setHeader('Access-Control-Expose-Headers', 'X-Truncated, X-Truncated-Limit')
    }
    // UTF-8 BOM 帮 Excel 识别
    res.send('﻿' + lines.join('\n'))
  })

  // 订单签名链 — 当事人 + 白名单仲裁员(涉争议订单) + admin 可查
  app.get('/api/orders/:id/chain', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<{ buyer_id: string; seller_id: string; logistics_id: string | null }>('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    const uid = user.id as string
    // 仲裁员链访问与订单详情同一谓词(arbitratorCanViewOrder):裁定需验签名链;legacy role==='arbitrator' 旁路已移除
    //   (否则 role-only/已吊销账号可读任意订单链,而真·白名单仲裁员 role=buyer 反被 403,链徽标在裁定页显示"链异常")。
    const isParty = uid === order.buyer_id || uid === order.seller_id || uid === order.logistics_id
    if (!isParty && user.role !== 'admin' && !(await arbitratorCanViewOrder(req.params.id, uid))) {
      return void res.status(403).json({ error: '无权查看此订单链' })
    }
    const chain = await getOrderChain(db, req.params.id)
    const verification = await verifyOrderChain(db, req.params.id)
    res.json({ chain, verification })
  })

  // RFC-011 §⑥:事件游标流 —— 集成方 agent 拉"自 cursor 以来与我相关的订单变化"(agent 拉,非 webhook)。
  //   party-gated(只见自己当事的订单事件,= /chain 同口径,不变量 2:活性 ≤ 读边界);
  //   结构性事件 + 哈希链字段(验链防篡改),完整 payload 仍走 party-gated /chain。
  app.get('/api/agent/events', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const since = typeof req.query.since === 'string' ? req.query.since : undefined
    const limit = Number(req.query.limit) || 50
    const r = await listOrderEventsSince(db, user.id as string, since, limit)
    res.setHeader('Cache-Control', 'no-store')   // 事件流不缓存
    res.json({
      ...r,
      note: 'Cursor stream of order events you are party to. Pass ?since=<next_cursor> to page. Pull, not push. event_hash+prev_event_hash verify chain integrity; full payload via GET /api/orders/:id/chain.',
    })
  })

  app.get('/api/orders/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const statusInfo = getOrderStatus(db, req.params.id) as { order: Record<string, unknown>; history: Record<string, unknown>[] } | undefined
    if (!statusInfo) return void res.status(404).json({ error: '订单不存在' })

    const order = statusInfo.order
    const isLogisticsPickup = (user as Record<string,unknown>).role === 'logistics' &&
      !order.logistics_id && order.status === 'shipped'
    // 白名单仲裁员(role 可能是 buyer,非 legacy 'arbitrator')需查看涉争议订单以裁定/复盘。能力源【唯一】= active
    //   arbitrator_whitelist;legacy role 旁路已移除(否则 role-only/已吊销账号可读任意订单)。谓词= arbitratorCanViewOrder:
    //   订单须【存在争议记录】(含已裁定/已驳回 —— 只放行 disputed 会让仲裁员在裁定落地、订单离开 disputed 的瞬间失去访问,
    //   已结 tab 的"查看订单"全部 403);无争议记录的订单不可见 → 不可枚举。
    const isParty = order.buyer_id === user.id || order.seller_id === user.id || order.logistics_id === user.id
    if (!isParty && !isLogisticsPickup && !(await arbitratorCanViewOrder(req.params.id, user.id as string))) {
      return void res.status(403).json({ error: '无权查看此订单' })
    }

    // M8: 二手订单从 secondhand_items 查；商家订单从 products 查
    const product = order.source === 'secondhand'
      ? await (async () => {
          const si = await dbOne<{ title: string; price: number; images: string }>('SELECT title, price, images FROM secondhand_items WHERE id = ?', [order.product_id as string])
          if (!si) return null
          try { return { title: si.title, price: si.price, images: JSON.parse(si.images || '[]') } } catch { return { title: si.title, price: si.price, images: [] } }
        })()
      : await dbOne('SELECT id, title, price, images, return_days FROM products WHERE id = ?', [order.product_id as string])
    const dispute = await getOrderDispute(db, req.params.id)

    // 为每条历史记录附上证据描述
    const history = await Promise.all(statusInfo.history.map(async h => {
      // P1 fix: 单条脏 evidence_ids 不应封死整个 order 详情
      let ids: string[] = []
      try { const p = JSON.parse((h.evidence_ids as string) || '[]'); if (Array.isArray(p)) ids = p as string[] } catch {}
      const evidenceItems = ids.length
        ? await dbAll(`SELECT description, type FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
        : []
      return { ...h, evidence_items: evidenceItems } as Record<string, unknown> & { evidence_items: unknown[] }
    }))

    // 物流跟踪摘要：从历史中提取所有物流操作的证据
    const LOGISTICS_STEPS = ['shipped', 'picked_up', 'in_transit', 'delivered']
    const trackingInfo = history
      .filter(h => LOGISTICS_STEPS.includes(h.to_status as string))
      .map(h => ({
        status:    h.to_status,
        actor:     h.actor_name,
        time:      h.created_at,
        evidence:  (h.evidence_items as { description: string }[]).map(e => e.description).filter(Boolean),
        notes:     h.notes,
      }))

    // B2 隐私购物：匿名订单 + 非买家本人 → shipping_address 前缀代号；不下放 recipient_code
    if (Number(order.anonymous_recipient) === 1) {
      const isBuyer = order.buyer_id === user.id
      if (!isBuyer) {
        const code = order.recipient_code || 'PR-?????'
        order.shipping_address = `🔒 ${code} · ${order.shipping_address}`
        delete order.recipient_code
      }
    }

    // Direct Pay 响应契约门:收款目标按查看者投影 —— 买家在 D1/D2 both-acked 前不得拿到(非仅 UI 软门);卖家=收款方保留;
    //   非买卖双方第三方(disputed-order 仲裁员、logistics-pickup)一律剥离(#179/#218 审计;仲裁若确需看收款目标,
    //   应另做显式、可审计、受指派/案件/目的约束的 reveal 路径)。与 /api/orders 列表共用同一投影器,防旁路。
    projectDirectPayTargetForViewer(db, order as Record<string, unknown>, user.id as string)

    // Rail1 撤回仲裁可达性(与 orders-action pq_withdraw 权威门同谓词):仅当【当前 disputed + 最近一次进入
    //   disputed 是 from payment_query + 争议未裁定】。前端据此才显示"撤回仲裁"按钮 —— 履约类争议(货损/货不对版
    //   的 delivered→disputed)不给该按钮。UI 便利字段,真正拦截仍在路由。
    const disputedFroms = history.filter(h => h.to_status === 'disputed').map(h => h.from_status as string)
    order.can_withdraw_payment_query_dispute =
      order.status === 'disputed' && disputedFroms[disputedFroms.length - 1] === 'payment_query' && !!dispute

    // 争议协商收口·买家侧(与 orders-action dispute_withdraw_confirm 权威门同谓词):仅当【当前 disputed +
    //   最近一次进入 disputed 是 from delivered(履约争议)+ 争议未裁定 + 查看者=买家=争议发起人】。
    //   前端据此才显示"我已收到货·撤诉并确认收货";UI 便利字段,真正拦截仍在路由。
    order.can_confirm_receipt_close_dispute =
      order.status === 'disputed' && disputedFroms[disputedFroms.length - 1] === 'delivered'
      && !!dispute && (dispute as unknown as Record<string, unknown>).initiator_id === user.id && order.buyer_id === user.id

    // 协商取消(无责·双方合意)握手状态 —— 仅 disputed 单计算,供订单页同步渲染 propose/accept/decline/withdraw。真正边界在 mutual-cancel 路由。
    if (order.status === 'disputed') {
      const mc = getMutualCancelState(db, req.params.id, user.id as string)
      order.mutual_cancel = mc.ok ? { proposal: mc.proposal ?? null, can_propose: !!mc.can_propose, can_accept: !!mc.can_accept, can_decline: !!mc.can_decline, can_withdraw: !!mc.can_withdraw } : null
    }

    // P1-D 判责关单退款握手状态 —— 仅 direct_p2p + 处置关单(completed + settled_fault_at)计算。
    //   party-gated(域内,含 fault_seller 来源/曾付款资格谓词);非当事方拿 null。边界在 direct-fault-refund 路由。
    if (order.payment_rail === 'direct_p2p' && order.status === 'completed' && order.settled_fault_at) {
      const fr = getFaultRefundState(db, req.params.id, user.id as string)
      order.fault_refund = fr.ok ? { eligible: !!fr.eligible, request: fr.request ?? null, claim: fr.claim ?? null, can_request: !!fr.can_request, can_respond: !!fr.can_respond, can_confirm: !!fr.can_confirm, can_withdraw: !!fr.can_withdraw, can_escalate: !!fr.can_escalate } : null
    }

    // 直付取消退款握手状态(审计项 C)—— 仅 direct_p2p + accepted(付款后·发货前)计算,供订单页同步渲染。
    //   party-gated(域内);非当事方(仲裁员等)拿 null。真正边界在 direct-pay-cancel-refund 路由。
    if (order.payment_rail === 'direct_p2p' && order.status === 'accepted') {
      const cr = getCancelRefundState(db, req.params.id, user.id as string)
      order.cancel_refund = cr.ok ? { request: cr.request ?? null, can_request: !!cr.can_request, can_respond: !!cr.can_respond, can_confirm: !!cr.can_confirm, can_withdraw: !!cr.can_withdraw } : null
      // 审计项 F:卖家对账辅助 —— 同买家·同金额其它在途直付单计数(与 mark_paid D2 预警同口径,发货前每次打开订单页都能看到)。
      //   仅卖家视角计算;买家/第三方不下发(无对账用途,少一分敞口)。
      if (order.seller_id === user.id) {
        const dupRow = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND seller_id = ? AND payment_rail = 'direct_p2p' AND total_amount = ? AND id != ? AND status IN ('accepted','shipped','picked_up','in_transit','delivered')`, [order.buyer_id, order.seller_id, order.total_amount, req.params.id])
        order.duplicate_amount_alert = dupRow?.n || 0
      }
    }

    // S0 交易条款快照:parse-don't-validate 后下放(坏 JSON/pre-S0 旧单 → null;原始串不下放)
    // RFC-026:生效退货窗一并下放 —— 冻结快照治理(与 returns 路由/agent 视图同一 effectiveReturnDays,前端不再读活商品行)
    const _rw = effectiveReturnDays(order.trade_terms_snapshot, (product as Record<string, unknown> | null)?.return_days)
    order.effective_return_days = _rw.days; order.effective_return_source = _rw.source
    order.trade_terms = readTradeTermsSnapshot(order.trade_terms_snapshot); delete order.trade_terms_snapshot
    res.json({ ...statusInfo, history, product, dispute, trackingInfo })
  })

  // Rail1 D2:直付订单收款二维码(硬化转发)。仅【订单买家】+ 两次披露 both-acked 后可取;按建单时快照的 (qr_ref, seller_id)
  //   取【当时那一版】图字节。未 ack / 非买家 / 无 QR / 非 direct_p2p → 统一 404(不枚举,不泄露)。图字节不入 order JSON。
  app.get('/api/orders/:id/direct-pay-qr', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const orderId = String(req.params.id)
    const order = await dbOne<{ buyer_id: string; seller_id: string; payment_rail: string; status: string; direct_pay_account_snapshot: string | null }>(
      'SELECT buyer_id, seller_id, payment_rail, status, direct_pay_account_snapshot FROM orders WHERE id = ?', [orderId])
    if (!order || order.payment_rail !== 'direct_p2p' || order.buyer_id !== user.id) return void res.status(404).end()
    if (order.status === 'pending_accept') return void res.status(404).end()              // 手动接单待确认:状态门,接单前不出示收款码(v16)
    if (!requireBothDisclosuresAcked(db, orderId).ok) return void res.status(404).end()   // 未 ack:与"无 QR"同样 404,不泄露存在性
    let snap: { qr_ref?: string | null } = {}
    try { snap = order.direct_pay_account_snapshot ? JSON.parse(order.direct_pay_account_snapshot) : {} } catch { snap = {} }
    if (!snap.qr_ref) return void res.status(404).end()
    const img = getQrImageForOwner(db, snap.qr_ref, order.seller_id)   // (ref, seller_id) 域内取字节;seller_id 取自订单,非用户输入
    if (!img) return void res.status(404).end()
    res.setHeader('Content-Type', img.mime)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(img.buf)
  })
}
