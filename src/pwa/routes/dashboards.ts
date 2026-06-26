/**
 * 公开 dashboard 类端点 — Tokenomics 状态 + 分享中心聚合
 *
 * 由 #1013 Phase 110 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/tokenomics/status   公开协议池子健康度 + R11 distributionCap + 7d 硬停
 *   GET /api/shares/dashboard    分享中心聚合（已购 + 高佣推广 + 我的创作）
 *
 * 跨域注入：auth
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // RFC-018 PR4: 真实成交(排除全额退货)

export interface DashboardsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerDashboardsRoutes(app: Application, deps: DashboardsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { auth } = deps

  app.get('/api/tokenomics/status', async (_req, res) => {
    const gf = await dbOne<{ pool_balance: number }>("SELECT pool_balance FROM global_fund WHERE id = 1")
    const poolBalance = Number(gf?.pool_balance ?? 0)
    const histRow = (await dbOne<{ avg_dep: number | null }>(`
      SELECT AVG(deposited_this_period) as avg_dep
      FROM settlement_periods
      WHERE status = 'completed' AND started_at > datetime('now', '-28 days')
    `))!
    const historyAverage = Math.round(Number(histRow?.avg_dep ?? 0) * 100) / 100
    let healthLevel: 'healthy' | 'normal' | 'strained' | 'critical' | 'cold_start' = 'cold_start'
    let distributionCap = 1.0
    if (historyAverage > 0) {
      const healthRatio = poolBalance / historyAverage
      distributionCap = Math.max(1.0, Math.min(1.6, healthRatio))
      if      (healthRatio >= 2.0) healthLevel = 'healthy'
      else if (healthRatio >= 0.5) healthLevel = 'normal'
      else if (healthRatio >= 0.2) healthLevel = 'strained'
      else                          healthLevel = 'critical'
    }
    const lastSettled = await dbOne<{ effective_unit_cash: number; payout_rate: number; started_at: string }>(`
      SELECT effective_unit_cash, payout_rate, started_at FROM settlement_periods
      WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1
    `)
    const recentPaused = await dbOne<{ period_id: string; started_at: string; note: string }>(`
      SELECT period_id, started_at, note FROM settlement_periods
      WHERE status = 'paused_low_water' AND started_at > datetime('now', '-7 days')
      ORDER BY started_at DESC LIMIT 1
    `)
    res.json({
      pool_balance:      poolBalance,
      history_average:   historyAverage,
      health_ratio:      historyAverage > 0 ? Math.round(poolBalance / historyAverage * 100) / 100 : null,
      paused_recent:     recentPaused || null,
      health_level:      healthLevel,
      distribution_cap:  Math.round(distributionCap * 100) / 100,
      last_settlement:   lastSettled || null,
    })
  })

  app.get('/api/shares/dashboard', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string

    const bought = await dbAll(`
      SELECT
        o.id as order_id,
        o.updated_at as completed_at,
        p.id, p.title, p.price, p.commission_rate, p.images, p.category,
        (SELECT COUNT(*) FROM shareables s WHERE s.owner_id = ? AND s.related_order_id = o.id AND s.type = 'note' AND s.status = 'active') as note_count,
        (SELECT id FROM shareables s WHERE s.owner_id = ? AND s.related_order_id = o.id AND s.type = 'note' AND s.status = 'active' LIMIT 1) as first_note_id,
        (SELECT COUNT(*) FROM shareables s WHERE s.owner_id = ? AND s.related_product_id = p.id AND s.status = 'active') as product_share_count,
        (SELECT COUNT(*) FROM anchor_registry ar WHERE ar.owner_id = ? AND ar.target_kind = 'product' AND ar.target_id = p.id AND ar.status = 'active') as anchor_count,
        (SELECT COUNT(DISTINCT o2.id) FROM orders o2
           JOIN product_share_attribution psa ON psa.recipient_id = o2.buyer_id AND psa.product_id = o2.product_id
           JOIN shareables s2 ON s2.id = psa.shareable_id
           WHERE s2.owner_id = ? AND s2.related_product_id = p.id AND o2.status = 'completed') as induced_orders
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE o.buyer_id = ? AND o.status = 'completed'
      ORDER BY o.updated_at DESC
      LIMIT 50
    `, [userId, userId, userId, userId, userId, userId])

    const highComm = await dbAll(`
      SELECT p.id, p.title, p.price, p.commission_rate, p.images, p.category,
        (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND ${genuineSalePredicate('o')}) as sales_count
      FROM products p
      WHERE p.status = 'active'
        AND p.commission_rate > 0
        AND p.seller_id != ?
        AND p.id NOT IN (SELECT product_id FROM orders WHERE buyer_id = ? AND status = 'completed')
      ORDER BY p.commission_rate DESC, sales_count DESC
      LIMIT 10
    `, [userId, userId])

    const myCreations = await dbAll(`
      SELECT s.id, s.type, s.title, s.external_platform, s.external_url,
        s.related_product_id, s.related_order_id, s.related_anchor, p.title as product_title,
        s.click_count, s.like_count, s.created_at,
        (SELECT COUNT(DISTINCT o.id) FROM orders o
           JOIN product_share_attribution psa ON psa.recipient_id = o.buyer_id AND psa.product_id = o.product_id
           WHERE psa.shareable_id = s.id AND o.status = 'completed') as induced_orders
      FROM shareables s
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE s.owner_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 30
    `, [userId])

    res.json({
      bought_products: bought,
      high_commission_products: highComm,
      my_creations: myCreations,
    })
  })
}
