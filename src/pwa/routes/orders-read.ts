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
import { redactUnackedDirectPayTarget, stripDirectPayPaymentTarget } from '../direct-pay-order-redaction.js'  // 收款目标披露门(共享;所有 orders reader 必过)。strip=非买家/卖家第三方无条件剥离
import { getMutualCancelState } from '../../layer3-trust/L3-1-dispute-engine/mutual-cancel.js'  // 协商取消(无责合意)可达性 + 当前提议(仅 disputed 计算,UI 便利字段)
import { isEligibleArbitrator } from '../arbitrator-lifecycle.js'  // 白名单仲裁员可查【争议中】订单(裁定所需);不看 legacy role==='arbitrator'
import { getQrImageForOwner } from '../../direct-receive-account-qr.js'  // Rail1 D2:ack 门后按订单快照 qr_ref 取收款码字节((ref,seller_id) 域内)

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

  app.get('/api/orders', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const orders = await dbAll<Record<string, unknown>>(`
      SELECT o.*, p.title as product_title, p.images,
        ub.name as buyer_name, us.name as seller_name
      FROM orders o
      JOIN products p ON o.product_id = p.id
      JOIN users ub ON o.buyer_id = ub.id
      JOIN users us ON o.seller_id = us.id
      WHERE o.buyer_id = ? OR o.seller_id = ? OR o.logistics_id = ?
      ORDER BY o.created_at DESC LIMIT 50
    `, [user.id, user.id, user.id])
    // B2 隐私购物：列表里也做相同 mask（防 seller/logistics 通过列表绕过详情 mask）
    for (const o of orders) {
      if (Number(o.anonymous_recipient) === 1 && o.buyer_id !== user.id) {
        const code = o.recipient_code || 'PR-?????'
        o.shipping_address = `🔒 ${code} · ${o.shipping_address}`
        delete o.recipient_code
        o.buyer_name = '🔒 ' + (typeof code === 'string' ? code : 'PR-?????')
      }
      redactUnackedDirectPayTarget(db, o, user.id as string)   // #179 审计 P1:列表也过披露门,不得旁路
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
    const where = [`${field} = ?`]
    const params: unknown[] = [user.id]
    if (from) { where.push(`o.created_at >= ?`); params.push(from) }
    if (to) { where.push(`o.created_at <= ?`); params.push(to) }
    const EXPORT_LIMIT = 5000
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT o.id, o.created_at, o.status, o.quantity, o.unit_price, o.total_amount,
             o.coupon_discount, o.variant_options_snapshot, o.shipping_address,
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
    const headers = ['order_id', 'created_at', 'status', 'product', 'category', 'qty', 'unit_price', 'total', 'coupon_discount', 'variant', 'buyer', 'seller', 'address']
    const lines = [headers.join(',')]
    for (const r of rows) {
      let variantStr = ''
      try {
        const v = r.variant_options_snapshot ? JSON.parse(r.variant_options_snapshot as string) : null
        if (v) variantStr = Object.entries(v).map(([k, val]) => `${k}:${val}`).join(';')
      } catch {}
      lines.push([
        r.id, r.created_at, r.status, r.product_title, r.category,
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

  // 订单签名链 — 当事人 + arbitrator + admin 可查
  app.get('/api/orders/:id/chain', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<{ buyer_id: string; seller_id: string; logistics_id: string | null }>('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    const uid = user.id as string
    const isParty = uid === order.buyer_id || uid === order.seller_id || uid === order.logistics_id || user.role === 'arbitrator' || user.role === 'admin'
    if (!isParty) return void res.status(403).json({ error: '无权查看此订单链' })
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
    // 白名单仲裁员(role 可能是 buyer,非 legacy 'arbitrator')需查看【争议中】订单以裁定。仅 disputed 单放行,非争议单不予枚举。
    //   能力源【唯一】= active arbitrator_whitelist(isEligibleArbitrator);【移除】legacy user.role === 'arbitrator' 旁路
    //   —— 否则 role-only / 已 suspend/revoke 但主 role 未同步的账号仍能读【任意状态】订单,与"active whitelist 是唯一授权源"冲突。
    const isDisputeArbiter = order.status === 'disputed' && isEligibleArbitrator(db, user.id as string).ok
    if (order.buyer_id !== user.id && order.seller_id !== user.id && order.logistics_id !== user.id && !isLogisticsPickup && !isDisputeArbiter) {
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

    // Direct Pay 响应契约门:direct_p2p 收款目标(instruction 快照 + 账号快照 qr_ref),买家在 D1/D2 both-acked 前
    //   【不得】从 API 拿到(非仅 UI 软门)。与 /api/orders 列表共用同一 redact,防旁路(#179 审计 P1)。
    redactUnackedDirectPayTarget(db, order as Record<string, unknown>, user.id as string)
    // P1-1:非买家【且】非卖家的第三方 reader(disputed-order 仲裁员、logistics-pickup)绝不该看到直付收款目标。
    //   redactUnackedDirectPayTarget 只管【买家自视角】,非买家时是 no-op → 仲裁员会拿到 instruction/qr_ref。卖家是收款方,看自己单不剥。
    //   若仲裁确需看收款目标,应另做显式、可审计、受指派/案件/目的约束的 reveal 路径。
    if (user.id !== order.buyer_id && user.id !== order.seller_id) stripDirectPayPaymentTarget(order as Record<string, unknown>)

    // Rail1 撤回仲裁可达性(与 orders-action pq_withdraw 权威门同谓词):仅当【当前 disputed + 最近一次进入
    //   disputed 是 from payment_query + 争议未裁定】。前端据此才显示"撤回仲裁"按钮 —— 履约类争议(货损/货不对版
    //   的 delivered→disputed)不给该按钮。UI 便利字段,真正拦截仍在路由。
    const disputedFroms = history.filter(h => h.to_status === 'disputed').map(h => h.from_status as string)
    order.can_withdraw_payment_query_dispute =
      order.status === 'disputed' && disputedFroms[disputedFroms.length - 1] === 'payment_query' && !!dispute

    // 协商取消(无责·双方合意)握手状态 —— 仅 disputed 单计算,供订单页同步渲染 propose/accept/decline/withdraw。真正边界在 mutual-cancel 路由。
    if (order.status === 'disputed') {
      const mc = getMutualCancelState(db, req.params.id, user.id as string)
      order.mutual_cancel = mc.ok ? { proposal: mc.proposal ?? null, can_propose: !!mc.can_propose, can_accept: !!mc.can_accept, can_decline: !!mc.can_decline, can_withdraw: !!mc.can_withdraw } : null
    }

    res.json({ ...statusInfo, history, product, dispute, trackingInfo })
  })

  // Rail1 D2:直付订单收款二维码(硬化转发)。仅【订单买家】+ 两次披露 both-acked 后可取;按建单时快照的 (qr_ref, seller_id)
  //   取【当时那一版】图字节。未 ack / 非买家 / 无 QR / 非 direct_p2p → 统一 404(不枚举,不泄露)。图字节不入 order JSON。
  app.get('/api/orders/:id/direct-pay-qr', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const orderId = String(req.params.id)
    const order = await dbOne<{ buyer_id: string; seller_id: string; payment_rail: string; direct_pay_account_snapshot: string | null }>(
      'SELECT buyer_id, seller_id, payment_rail, direct_pay_account_snapshot FROM orders WHERE id = ?', [orderId])
    if (!order || order.payment_rail !== 'direct_p2p' || order.buyer_id !== user.id) return void res.status(404).end()
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
