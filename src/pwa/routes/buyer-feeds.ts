/**
 * Buyer 推荐 / 活动流 / 雷达扫描
 *
 * 由 #1013 Phase 112 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET /api/recommendations/me  Wave E-3: 4 桶聚合（关注 / 同类 / 已购卖家 / 热门）
 *   GET /api/feed                公开活动流 UNION（订单 / 参与 / 分享归因事件）
 *   GET /api/nearby              P15 QVOD k-anonymity 雷达扫描
 *
 * 跨域注入：auth + isTrustedRole + errorRes + getNearbyCellPrecision + getProtocolParam
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // RFC-018 PR4: 真实成交(排除全额退货)

export interface BuyerFeedsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  getNearbyCellPrecision: () => { precision_deg: number; approx_km: number }
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerBuyerFeedsRoutes(app: Application, deps: BuyerFeedsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { auth, isTrustedRole, errorRes, getNearbyCellPrecision, getProtocolParam } = deps

  app.get('/api/recommendations/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const limit = Math.min(30, Math.max(5, Number(req.query.limit) || 20))

    const wishlistRows = await dbAll<{ product_id: string; category: string | null; seller_id: string }>(`
      SELECT w.product_id, p.category, p.seller_id FROM user_wishlist w
      JOIN products p ON p.id = w.product_id
      WHERE w.user_id = ? AND p.status = 'active' LIMIT 50
    `, [user.id])
    const purchasedRows = await dbAll<{ product_id: string; seller_id: string }>(`
      SELECT DISTINCT product_id, seller_id FROM orders WHERE buyer_id = ? AND status = 'completed' LIMIT 200
    `, [user.id])
    const followedRows = await dbAll<{ followee_id: string }>(`SELECT followee_id FROM follows WHERE follower_id = ?`, [user.id])

    const wishCats = new Set(wishlistRows.map(r => r.category).filter(Boolean) as string[])
    const knownProductIds = new Set([...wishlistRows.map(r => r.product_id), ...purchasedRows.map(r => r.product_id)])
    const knownSellerIds = new Set([...wishlistRows.map(r => r.seller_id), ...purchasedRows.map(r => r.seller_id)])
    const followedSellerIds = followedRows.map(r => r.followee_id)

    const EXCL_LIMIT = 500
    const exclArgs = [...knownProductIds].slice(0, EXCL_LIMIT)
    const exclSql = exclArgs.length > 0
      ? `AND p.id NOT IN (${exclArgs.map(() => '?').join(',')})`
      : ''

    const baseCols = `p.id, p.title, p.price, p.stock, p.category, p.images, p.has_variants, p.seller_id,
      (SELECT COUNT(1) FROM orders o WHERE o.product_id = p.id AND ${genuineSalePredicate('o')}) as sales_count,
      u.name as seller_name, u.handle as seller_handle`

    let followedProducts: Array<Record<string, unknown>> = []
    if (followedSellerIds.length > 0) {
      const ph = followedSellerIds.map(() => '?').join(',')
      followedProducts = await dbAll<Record<string, unknown>>(`
        SELECT ${baseCols}
        FROM products p JOIN users u ON u.id = p.seller_id
        WHERE p.seller_id IN (${ph}) AND p.status = 'active' AND p.stock > 0 ${exclSql}
        ORDER BY p.created_at DESC LIMIT 10
      `, [...followedSellerIds, ...exclArgs])
    }

    let categoryProducts: Array<Record<string, unknown>> = []
    if (wishCats.size > 0) {
      const ph = [...wishCats].map(() => '?').join(',')
      categoryProducts = await dbAll<Record<string, unknown>>(`
        SELECT ${baseCols}
        FROM products p JOIN users u ON u.id = p.seller_id
        WHERE p.category IN (${ph}) AND p.status = 'active' AND p.stock > 0 ${exclSql}
        ORDER BY sales_count DESC LIMIT 10
      `, [...wishCats, ...exclArgs])
    }

    let pastSellerProducts: Array<Record<string, unknown>> = []
    const pastSellers = [...knownSellerIds].filter(s => !followedSellerIds.includes(s))
    if (pastSellers.length > 0) {
      const ph = pastSellers.map(() => '?').join(',')
      pastSellerProducts = await dbAll<Record<string, unknown>>(`
        SELECT ${baseCols}
        FROM products p JOIN users u ON u.id = p.seller_id
        WHERE p.seller_id IN (${ph}) AND p.status = 'active' AND p.stock > 0 ${exclSql}
        ORDER BY p.created_at DESC LIMIT 10
      `, [...pastSellers, ...exclArgs])
    }

    const fallback = await dbAll<Record<string, unknown>>(`
      SELECT ${baseCols}
      FROM products p JOIN users u ON u.id = p.seller_id
      WHERE p.status = 'active' AND p.stock > 0 ${exclSql}
      ORDER BY sales_count DESC, p.created_at DESC LIMIT 10
    `, exclArgs)

    const seen = new Set<string>()
    const labeled = (bucket: string, arr: Array<Record<string, unknown>>) =>
      arr.filter(it => {
        const id = String(it.id)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      }).map(it => ({ ...it, _bucket: bucket }))

    const all = [
      ...labeled('followed', followedProducts),
      ...labeled('category', categoryProducts),
      ...labeled('past_seller', pastSellerProducts),
      ...labeled('trending', fallback),
    ].slice(0, limit)

    res.json({
      items: all,
      signals: {
        wishlist_categories: [...wishCats],
        followed_sellers: followedSellerIds.length,
        past_purchases: purchasedRows.length,
      },
    })
  })

  app.get('/api/feed', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const scope = String(req.query.scope || 'all')
    const params: unknown[] = []
    if (scope === 'following') {
      params.push(user.id, user.id, user.id)
    }

    const sql = `
      SELECT * FROM (
        SELECT 'purchase' as kind, o.id as ref_id, o.buyer_id as actor_id, ub.name as actor_name,
               o.product_id, p.title as product_title, p.category, p.price, o.updated_at as ts,
               NULL as extra
        FROM orders o
        JOIN products p ON p.id = o.product_id
        JOIN users ub ON ub.id = o.buyer_id
        WHERE o.status = 'completed'
          AND COALESCE(ub.feed_visible, 1) = 1
          ${scope === 'following' ? `AND o.buyer_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)` : ''}

        UNION ALL

        SELECT 'join_binary' as kind, u.id as ref_id, u.id as actor_id, u.name as actor_name,
               NULL as product_id, NULL as product_title, NULL as category, NULL as price,
               u.created_at as ts,
               json_object('placement_side', u.placement_side, 'placement_name', up.name) as extra
        FROM users u
        LEFT JOIN users up ON up.id = u.placement_id
        WHERE u.placement_id IS NOT NULL
          AND COALESCE(u.feed_visible, 1) = 1
          ${scope === 'following' ? `AND u.id IN (SELECT followee_id FROM follows WHERE follower_id = ?)` : ''}

        UNION ALL

        SELECT 'commission' as kind, cr.id as ref_id, cr.beneficiary_id as actor_id, ub.name as actor_name,
               o.product_id, p.title as product_title, p.category, p.price, cr.created_at as ts,
               json_object('level', cr.level, 'amount', cr.amount) as extra
        FROM commission_records cr
        JOIN orders o ON o.id = cr.order_id
        JOIN products p ON p.id = o.product_id
        JOIN users ub ON ub.id = cr.beneficiary_id
        WHERE cr.beneficiary_id != 'sys_protocol'
          AND COALESCE(ub.feed_visible, 1) = 1
          ${scope === 'following' ? `AND cr.beneficiary_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)` : ''}
      )
      WHERE ts IS NOT NULL
      ORDER BY ts DESC LIMIT 50
    `
    const events = await dbAll(sql, params)
    res.json({ events, scope })
  })

  // 雷达扫描 MVP (2026-05-29)：scope 范围档 + window 时间窗，k≥3 守护贯穿
  //   scope: cell(本格) / neighbors(周边 3×3) / region(同城) / global(全网)
  //   window: 24h / 7d / 30d
  app.get('/api/nearby', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const VALID_SCOPES = ['cell', 'neighbors', 'region', 'global']
    const scope = VALID_SCOPES.includes(String(req.query.scope)) ? String(req.query.scope) : 'neighbors'
    const windowKey = ['24h', '7d', '30d'].includes(String(req.query.window)) ? String(req.query.window) : '7d'
    const days = windowKey === '24h' ? 1 : windowKey === '30d' ? 30 : 7

    const { precision_deg, approx_km } = getNearbyCellPrecision()
    const K = getProtocolParam<number>('nearby_k_anonymity', 3)
    const u = (await dbOne<{ geo_lat: number | null; geo_lng: number | null; geo_updated_at: string | null; region: string | null }>("SELECT geo_lat, geo_lng, geo_updated_at, region FROM users WHERE id = ?", [user.id]))!

    const needsGeo = scope === 'cell' || scope === 'neighbors'
    if (needsGeo && (u?.geo_lat == null || u?.geo_lng == null)) {
      // 本格/周边需定位；同城/全网不需 → 前端可引导切到更大范围
      return void res.json({ has_location: false, scope, window: windowKey, k_threshold: K })
    }

    // 按 scope 构造 WHERE + 标签
    let where: string, args: unknown[], scopeLabel: string
    let cell: Record<string, unknown> | null = null
    if (scope === 'cell') {
      where = 'u.geo_lat = ? AND u.geo_lng = ?'; args = [u.geo_lat, u.geo_lng]
      scopeLabel = `本格 ${approx_km}km`
      cell = { lat: u.geo_lat, lng: u.geo_lng, precision_deg, approx_km }
    } else if (scope === 'neighbors') {
      const eps = precision_deg * 1.5
      where = 'u.geo_lat BETWEEN ? AND ? AND u.geo_lng BETWEEN ? AND ?'
      args = [Number(u.geo_lat) - eps, Number(u.geo_lat) + eps, Number(u.geo_lng) - eps, Number(u.geo_lng) + eps]
      scopeLabel = `周边 ~${Math.round(approx_km * 3)}km`
      cell = { lat: u.geo_lat, lng: u.geo_lng, precision_deg, approx_km }
    } else if (scope === 'region') {
      where = 'u.region = ?'; args = [u.region || 'global']
      scopeLabel = `同城 · ${u.region || '区域'}`
    } else { // global
      where = '1=1'; args = []
      scopeLabel = '全网'
    }

    const dayClause = `o.updated_at > datetime('now', '-${days} day')`
    const totals = (await dbOne<{ au: number; orders: number }>(`
      SELECT COUNT(DISTINCT o.buyer_id) as au, COUNT(*) as orders
      FROM orders o JOIN users u ON u.id = o.buyer_id
      WHERE ${where} AND o.status = 'completed' AND ${dayClause}
    `, args))!

    const sufficient = Number(totals.au) >= K
    const topProducts = sufficient ? await dbAll(`
      SELECT p.id, p.title, p.price, p.category, p.images, COUNT(DISTINCT o.buyer_id) as buyers
      FROM orders o JOIN users u ON u.id = o.buyer_id JOIN products p ON p.id = o.product_id
      WHERE ${where} AND o.status = 'completed' AND ${dayClause}
      GROUP BY p.id HAVING buyers >= ? ORDER BY buyers DESC LIMIT 10
    `, [...args, K]) : []
    const topCategories = sufficient ? await dbAll(`
      SELECT p.category, COUNT(*) as orders, COUNT(DISTINCT o.buyer_id) as buyers
      FROM orders o JOIN users u ON u.id = o.buyer_id JOIN products p ON p.id = o.product_id
      WHERE ${where} AND o.status = 'completed' AND ${dayClause} AND p.category IS NOT NULL
      GROUP BY p.category HAVING buyers >= ? ORDER BY orders DESC LIMIT 6
    `, [...args, K]) : []

    const staleDays = u?.geo_updated_at
      ? Math.floor((Date.now() - new Date(u.geo_updated_at.replace(' ', 'T') + 'Z').getTime()) / 86400_000)
      : null

    res.json({
      has_location: true,
      scope, scope_label: scopeLabel, window: windowKey, k_threshold: K,
      cell,
      location_stale_days: staleDays,
      sufficient,
      aggregate: {
        active_users: sufficient ? Number(totals.au) : -1,
        orders:       sufficient ? Number(totals.orders) : -1,
      },
      top_products: topProducts,
      top_categories: topCategories,
    })
  })
}
