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
    if (order.buyer_id !== user.id && order.seller_id !== user.id && order.logistics_id !== user.id && user.role !== 'arbitrator' && !isLogisticsPickup) {
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

    res.json({ ...statusInfo, history, product, dispute, trackingInfo })
  })
}
