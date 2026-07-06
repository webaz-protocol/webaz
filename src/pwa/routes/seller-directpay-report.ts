/**
 * 卖家【直接收款(direct_p2p)销售统计 + 对账】只读报表。
 *
 * 背景:直付是【非托管】—— 买家把货款直接付给卖家(链下),平台不碰这笔钱,只记订单 + 计提平台服务费。
 *   所以钱包/收入视图对直付销售完全不显示,商家原本无法统计"直付卖了多少 / 平台费欠多少 / 逐单对账"。
 *   本报表把已存在的数据(orders.payment_rail='direct_p2p' 各列 + direct_pay_fee_receivables 逐单平台费)聚合出来。
 *
 * 纯读:不建单、不碰 wallet/escrow/settlement/refund/bond,不改状态机,无同步 db.prepare(走 dbOne/dbAll seam)。
 *   销售额 = Σ orders.total_amount(下单计价币,买家被告知应付的金额);平台费 = direct_pay_fee_receivables.amount(USDC 小数)。
 *   二者币种不同,分别呈现,不混加。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface SellerDirectPayReportDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

// 直付订单状态桶(与状态机一致):已完成(计提平台费)/ 在途 / 已取消·退款。
const COMPLETED = ['completed', 'confirmed']
const IN_FLIGHT = ['pending_accept', 'direct_pay_window', 'accepted', 'shipped', 'picked_up', 'in_transit', 'delivered', 'payment_query', 'direct_expired_unconfirmed']
const CLOSED_NEG = ['cancelled', 'expired', 'refunded_full', 'refunded_partial', 'dispute_dismissed', 'resolved_for_seller', 'fault_seller', 'fault_buyer', 'fault_logistics']
const inList = (col: string, arr: string[]): string => `${col} IN (${arr.map(() => '?').join(',')})`

export function registerSellerDirectPayReportRoutes(app: Application, deps: SellerDirectPayReportDeps): void {
  const { db, auth } = deps

  function requireSeller(req: Request, res: Response): Record<string, unknown> | null {
    const user = auth(req, res); if (!user) return null
    const roles = (() => { try { return JSON.parse(String(user.roles ?? '[]')) } catch { return [] } })()
    if (user.role !== 'seller' && !(Array.isArray(roles) && roles.includes('seller'))) { res.status(403).json({ error: '仅卖家可查看', error_code: 'SELLER_ONLY' }); return null }
    return user
  }

  // GET /api/sellers/me/direct-pay-report?from=YYYY-MM-DD&to=YYYY-MM-DD
  //   from/to 均可选(闭区间,按日期比较 substr(created_at,1,10));返回汇总 + 按月 + 逐单(含平台费明细)。
  app.get('/api/sellers/me/direct-pay-report', async (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const sellerId = user.id as string
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null
    const range: string[] = []; const rp: string[] = []
    if (from) { range.push('substr(o.created_at,1,10) >= ?'); rp.push(from) }
    if (to) { range.push('substr(o.created_at,1,10) <= ?'); rp.push(to) }
    const rangeClause = range.length ? ' AND ' + range.join(' AND ') : ''

    // ① 汇总(单查:订单数 / 销售额 / 各桶计数与已完成销售额)
    const summary = (await dbOne<Record<string, number>>(`
      SELECT
        COUNT(*) as order_count,
        COALESCE(SUM(o.total_amount), 0) as sales_total,
        SUM(CASE WHEN ${inList('o.status', COMPLETED)} THEN 1 ELSE 0 END) as completed_count,
        COALESCE(SUM(CASE WHEN ${inList('o.status', COMPLETED)} THEN o.total_amount ELSE 0 END), 0) as completed_sales,
        SUM(CASE WHEN ${inList('o.status', IN_FLIGHT)} THEN 1 ELSE 0 END) as in_flight_count,
        SUM(CASE WHEN ${inList('o.status', CLOSED_NEG)} THEN 1 ELSE 0 END) as closed_count
      FROM orders o
      WHERE o.seller_id = ? AND o.payment_rail = 'direct_p2p'${rangeClause}
    `, [...COMPLETED, ...COMPLETED, ...IN_FLIGHT, ...CLOSED_NEG, sellerId, ...rp]))!

    // ② 区间内已计提平台费合计(逐单应收 join 订单,按订单下单日筛)
    const feeAgg = (await dbOne<{ fee_accrued: number; fee_count: number }>(`
      SELECT COALESCE(SUM(r.amount), 0) as fee_accrued, COUNT(*) as fee_count
      FROM direct_pay_fee_receivables r JOIN orders o ON o.id = r.order_id
      WHERE o.seller_id = ? AND o.payment_rail = 'direct_p2p'${rangeClause}
    `, [sellerId, ...rp]))!

    // ③ 按月(最多 24 个月)
    const byMonth = await dbAll<{ month: string; order_count: number; sales_total: number }>(`
      SELECT substr(o.created_at, 1, 7) as month, COUNT(*) as order_count, COALESCE(SUM(o.total_amount), 0) as sales_total
      FROM orders o
      WHERE o.seller_id = ? AND o.payment_rail = 'direct_p2p'${rangeClause}
      GROUP BY month ORDER BY month DESC LIMIT 24
    `, [sellerId, ...rp])

    // ④ 逐单明细(含平台费:LEFT JOIN 应收表 —— 未完成单尚无 fee 行,fee 为 null)。上限 500。
    const LIMIT = 500
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT o.id, o.created_at, o.status, o.total_amount, o.ship_to_region, p.title as product_title,
             r.amount as fee_amount, r.accrued_at as fee_accrued_at
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN direct_pay_fee_receivables r ON r.order_id = o.id
      WHERE o.seller_id = ? AND o.payment_rail = 'direct_p2p'${rangeClause}
      ORDER BY o.created_at DESC LIMIT ?
    `, [sellerId, ...rp, LIMIT + 1])
    const truncated = rows.length > LIMIT
    if (truncated) rows.length = LIMIT

    res.setHeader('Cache-Control', 'no-store')
    res.json({
      range: { from, to },
      currency_note: '销售额=下单计价币(买家应付金额);平台服务费=USDC。两者不同币种,分列展示。',
      summary: {
        order_count: Number(summary.order_count) || 0,
        sales_total: Number(summary.sales_total) || 0,
        completed_count: Number(summary.completed_count) || 0,
        completed_sales: Number(summary.completed_sales) || 0,
        in_flight_count: Number(summary.in_flight_count) || 0,
        closed_count: Number(summary.closed_count) || 0,
        fee_accrued_total: Number(feeAgg.fee_accrued) || 0,   // 区间已计提平台费(USDC)
        fee_order_count: Number(feeAgg.fee_count) || 0,
      },
      by_month: byMonth.map(m => ({ month: m.month, order_count: Number(m.order_count) || 0, sales_total: Number(m.sales_total) || 0 })),
      orders: rows.map(r => ({
        id: r.id, created_at: r.created_at, status: r.status, total_amount: Number(r.total_amount) || 0,
        ship_to_region: r.ship_to_region || null, product_title: r.product_title || null,
        fee_amount: r.fee_amount == null ? null : Number(r.fee_amount),   // null=未完成尚未计提
        fee_accrued_at: r.fee_accrued_at || null,
      })),
      truncated,
    })
  })
}
