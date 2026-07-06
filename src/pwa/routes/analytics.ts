/**
 * 分析仪表盘域 (Wave B-4 物流绩效 + Wave C-5 卖家销售分析 + return-stats)
 *
 * 由 #1013 Phase 26 从 src/pwa/server.ts 抽出。3 个 role-aware 分析端点合并：
 *
 * 3 endpoints:
 *   GET /api/logistics/me/performance      物流方核心 KPI（揽收/投递准点 + 争议败诉率）
 *   GET /api/sellers/me/analytics          卖家销售分析（GMV/AOV/top 商品/复购/转化漏斗）
 *   GET /api/sellers/me/return-stats       卖家退货统计（总数/状态分布/原因 breakdown）
 *
 * 窗口参数（min 7 / max 365 / default 30）
 *
 * 仅 role=logistics / seller 可访问对应端点。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AnalyticsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function registerAnalyticsRoutes(app: Application, deps: AnalyticsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { auth } = deps

  // 物流绩效卡 (Wave B-4)
  app.get('/api/logistics/me/performance', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'logistics') {
      return void res.status(403).json({ error: '仅物流角色可访问' })
    }
    const windowDays = Math.max(7, Math.min(365, Number(req.query.window) || 30))

    const orders = await dbAll<{
      id: string; status: string; created_at: string; updated_at: string;
      pickup_deadline: string | null; delivery_deadline: string | null;
    }>(`
      SELECT id, status, created_at, updated_at,
             pickup_deadline, delivery_deadline
      FROM orders
      WHERE logistics_id = ? AND created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays])

    const orderIds = orders.map(o => o.id)
    let history: Array<{ order_id: string; from_status: string; to_status: string; created_at: string }> = []
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',')
      history = await dbAll<{ order_id: string; from_status: string; to_status: string; created_at: string }>(`
        SELECT order_id, from_status, to_status, created_at
        FROM order_state_history
        WHERE order_id IN (${placeholders})
        ORDER BY created_at ASC
      `, orderIds)
    }

    const histByOrder = new Map<string, typeof history>()
    for (const h of history) {
      if (!histByOrder.has(h.order_id)) histByOrder.set(h.order_id, [])
      histByOrder.get(h.order_id)!.push(h)
    }

    let pickupOnTime = 0, pickupOverdue = 0
    let deliveryOnTime = 0, deliveryOverdue = 0
    let totalDelivered = 0, totalInTransit = 0, totalCompleted = 0
    const pickupDurationsHr: number[] = []
    const transitDurationsHr: number[] = []

    for (const o of orders) {
      const h = histByOrder.get(o.id) || []
      const shipped     = h.find(x => x.to_status === 'shipped')
      const pickedUp    = h.find(x => x.to_status === 'picked_up')
      const delivered   = h.find(x => x.to_status === 'delivered')

      if (o.status === 'completed') totalCompleted++
      if (o.status === 'in_transit' || o.status === 'picked_up') totalInTransit++
      if (delivered) totalDelivered++

      if (shipped && pickedUp) {
        const hrs = (new Date(pickedUp.created_at).getTime() - new Date(shipped.created_at).getTime()) / 3600000
        if (hrs >= 0) pickupDurationsHr.push(hrs)
        if (o.pickup_deadline) {
          if (new Date(pickedUp.created_at) <= new Date(o.pickup_deadline)) pickupOnTime++
          else pickupOverdue++
        }
      }
      if (pickedUp && delivered) {
        const hrs = (new Date(delivered.created_at).getTime() - new Date(pickedUp.created_at).getTime()) / 3600000
        if (hrs >= 0) transitDurationsHr.push(hrs)
        if (o.delivery_deadline) {
          if (new Date(delivered.created_at) <= new Date(o.delivery_deadline)) deliveryOnTime++
          else deliveryOverdue++
        }
      }
    }

    const disputes = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM disputes d
      JOIN orders o ON o.id = d.order_id
      WHERE o.logistics_id = ? AND d.created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!.n
    // 败诉两路：auto-fault 判物流 + 仲裁裁定物流为被告且退款
    const autoFaultLost = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM orders
      WHERE logistics_id = ? AND status = 'fault_logistics'
        AND updated_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!.n
    const arbitratedLost = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM disputes d
      JOIN orders o ON o.id = d.order_id
      WHERE o.logistics_id = ? AND d.defendant_id = ?
        AND d.ruling_type IN ('refund_buyer','partial_refund')
        AND d.created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, user.id, windowDays]))!.n
    const disputeLoss = autoFaultLost + arbitratedLost

    const pickupTotalEvaluated = pickupOnTime + pickupOverdue
    const deliveryTotalEvaluated = deliveryOnTime + deliveryOverdue

    res.json({
      window_days: windowDays,
      total_orders: orders.length,
      in_progress: totalInTransit,
      delivered: totalDelivered,
      completed: totalCompleted,
      pickup: {
        on_time: pickupOnTime,
        overdue: pickupOverdue,
        on_time_rate: pickupTotalEvaluated > 0 ? pickupOnTime / pickupTotalEvaluated : null,
        median_hours: median(pickupDurationsHr),
      },
      delivery: {
        on_time: deliveryOnTime,
        overdue: deliveryOverdue,
        on_time_rate: deliveryTotalEvaluated > 0 ? deliveryOnTime / deliveryTotalEvaluated : null,
        median_hours: median(transitDurationsHr),
      },
      disputes: {
        total: disputes,
        lost: disputeLoss,
        loss_rate: disputes > 0 ? disputeLoss / disputes : null,
      },
    })
  })

  // 卖家销售分析 (Wave C-5)
  app.get('/api/sellers/me/analytics', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'seller') return void res.status(403).json({ error: '仅卖家可访问' })
    const windowDays = Math.max(7, Math.min(365, Number(req.query.window) || 30))

    const ordersAgg = (await dbOne<Record<string, number>>(`
      SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN status IN ('paid','accepted','shipped','picked_up','in_transit','delivered','confirmed') THEN 1 ELSE 0 END) as in_progress_orders,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) as gmv,
        COALESCE(SUM(CASE WHEN status = 'completed' AND COALESCE(payment_rail,'escrow') = 'escrow' THEN total_amount ELSE 0 END), 0) as gmv_escrow,
        COALESCE(SUM(CASE WHEN status = 'completed' AND payment_rail = 'direct_p2p' THEN total_amount ELSE 0 END), 0) as gmv_direct_pay,
        COALESCE(AVG(CASE WHEN status = 'completed' THEN total_amount END), 0) as aov
      FROM orders WHERE seller_id = ? AND created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!

    const topProducts = await dbAll(`
      SELECT p.id, p.title, p.price, COUNT(o.id) as sales,
             COALESCE(SUM(o.total_amount), 0) as revenue
      FROM products p
      LEFT JOIN orders o ON o.product_id = p.id AND o.seller_id = p.seller_id
        AND o.status = 'completed'
        AND o.created_at > datetime('now', '-' || ? || ' days')
      WHERE p.seller_id = ? AND p.status != 'deleted'
      GROUP BY p.id
      HAVING sales > 0
      ORDER BY sales DESC LIMIT 10
    `, [windowDays, user.id])

    const buyerStats = (await dbOne<{ unique_buyers: number; orders_count: number }>(`
      SELECT
        COUNT(DISTINCT buyer_id) as unique_buyers,
        COUNT(*) as orders_count
      FROM orders WHERE seller_id = ? AND status = 'completed'
        AND created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!
    const repeatBuyers = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM (
        SELECT buyer_id FROM orders WHERE seller_id = ? AND status = 'completed'
          AND created_at > datetime('now', '-' || ? || ' days')
        GROUP BY buyer_id HAVING COUNT(*) > 1
      )
    `, [user.id, windowDays]))!.n

    const wishlistAdds = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM user_wishlist w
      JOIN products p ON p.id = w.product_id
      WHERE p.seller_id = ? AND w.created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!.n

    const dailyTrend = await dbAll(`
      SELECT DATE(created_at) as date,
             COUNT(*) as orders,
             COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) as gmv
      FROM orders
      WHERE seller_id = ? AND created_at > datetime('now', '-' || ? || ' days')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [user.id, Math.min(windowDays, 30)])

    const ratingsAgg = await dbOne(`
      SELECT COUNT(*) as cnt, COALESCE(AVG(stars), 0) as avg_stars
      FROM order_ratings WHERE seller_id = ?
        AND created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays])
    const refundsCount = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM return_requests
      WHERE seller_id = ? AND status = 'refunded'
        AND created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!.n

    // S1: 平均备货时长（paid → shipped 中位 hours）
    const handlingRow = (await dbOne<{ avg_handling_hours: number; sample_n: number }>(`
      SELECT COALESCE(AVG((julianday(h_ship.created_at) - julianday(h_paid.created_at)) * 24), 0) as avg_handling_hours,
             COUNT(*) as sample_n
      FROM orders o
      JOIN order_state_history h_paid ON h_paid.order_id = o.id AND h_paid.to_status = 'paid'
      JOIN order_state_history h_ship ON h_ship.order_id = o.id AND h_ship.to_status = 'shipped'
      WHERE o.seller_id = ? AND o.created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!

    const completedN = Number(ordersAgg.completed_orders) || 0
    const returnRate = completedN > 0 ? refundsCount / completedN : 0

    // S1: 上一窗口对比
    const prevAgg = (await dbOne<{ total_orders: number; completed_orders: number; gmv: number }>(`
      SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) as gmv
      FROM orders WHERE seller_id = ?
        AND created_at > datetime('now', '-' || ? || ' days')
        AND created_at <= datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays * 2, windowDays]))!

    res.json({
      window_days: windowDays,
      orders: ordersAgg,
      top_products: topProducts,
      buyers: {
        unique: buyerStats.unique_buyers,
        repeat: repeatBuyers,
        repeat_rate: buyerStats.unique_buyers > 0 ? repeatBuyers / buyerStats.unique_buyers : 0,
      },
      funnel: {
        wishlist_adds: wishlistAdds,
        orders: Number(ordersAgg.total_orders),
        completed: Number(ordersAgg.completed_orders),
      },
      daily_trend: dailyTrend,
      ratings: ratingsAgg,
      refunds: refundsCount,
      fulfillment: {
        avg_handling_hours: Math.round(Number(handlingRow.avg_handling_hours) * 10) / 10,
        sample_n: Number(handlingRow.sample_n),
      },
      quality: {
        return_rate: Math.round(returnRate * 10000) / 10000,
        refunds: refundsCount,
        completed: completedN,
      },
      prev_window: {
        total_orders: Number(prevAgg.total_orders),
        completed_orders: Number(prevAgg.completed_orders),
        gmv: Number(prevAgg.gmv),
      },
    })
  })

  // 卖家退货仪表盘
  app.get('/api/sellers/me/return-stats', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const totalReturns = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM return_requests WHERE seller_id = ?`, [user.id]))!.n
    const refunded = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM return_requests WHERE seller_id = ? AND status = 'refunded'`, [user.id]))!.n
    const rejected = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM return_requests WHERE seller_id = ? AND status = 'rejected'`, [user.id]))!.n
    const pending = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM return_requests WHERE seller_id = ? AND status = 'pending'`, [user.id]))!.n
    const totalOrders = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE seller_id = ? AND status IN ('delivered','completed','refunded')`, [user.id]))!.n
    const reasonBreakdown = await dbAll(`
      SELECT reason, COUNT(*) as cnt FROM return_requests
      WHERE seller_id = ? GROUP BY reason ORDER BY cnt DESC
    `, [user.id])
    const returnRate = totalOrders > 0 ? (refunded / totalOrders) : 0
    res.json({
      total_returns: totalReturns,
      refunded, rejected, pending,
      total_orders: totalOrders,
      return_rate: returnRate,
      reason_breakdown: reasonBreakdown,
    })
  })
}
