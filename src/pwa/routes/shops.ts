/**
 * 商家店铺主页域 (Wave E-1)
 *
 * 由 #1013 Phase 34 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET   /api/shops/:identifier      公开店铺主页（按 handle 或 user_id）
 *   PATCH /api/shops/me               卖家更新店铺装饰（intro / banner / bio）
 *
 * 公开页内容：
 *   - seller info (id, name, handle, bio, banner, intro)
 *   - 商品列表（active，sales_count 倒序，TOP 50）
 *   - stats: products / followers / completed_orders / rating_avg / rating_count
 *   - 最近 5 条公开评价
 *   - is_following（如有 token）
 *
 * 边界：
 *   - banner URL 必须 http(s)://
 *   - intro ≤ 2000 / bio ≤ 200 字
 *   - 仅 role=seller 可 PATCH /me
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // RFC-018 PR4: 真实成交(排除全额退货)

export interface ShopsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerShopsRoutes(app: Application, deps: ShopsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth } = deps

  app.get('/api/shops/:identifier', async (req, res) => {
    const id = String(req.params.identifier || '').replace(/^@/, '')
    // 先按 handle 查，找不到再按 id
    let seller = await dbOne<Record<string, unknown>>(`
      SELECT id, name, handle, role, bio, shop_banner_url, shop_intro, created_at, region
      FROM users WHERE handle = ? AND role = 'seller'
    `, [id])
    if (!seller) {
      seller = await dbOne<Record<string, unknown>>(`
        SELECT id, name, handle, role, bio, shop_banner_url, shop_intro, created_at, region
        FROM users WHERE id = ? AND role = 'seller'
      `, [id])
    }
    if (!seller) return void res.status(404).json({ error: '店铺不存在' })
    const sellerId = String(seller.id)
    const products = await dbAll(`
      SELECT p.id, p.title, p.price, p.stock, p.category, p.images, p.has_variants, p.commission_rate,
        (SELECT COUNT(1) FROM orders o WHERE o.product_id = p.id AND ${genuineSalePredicate('o')}) as sales_count
      FROM products p
      WHERE p.seller_id = ? AND p.status = 'active'
      ORDER BY sales_count DESC, p.created_at DESC
      LIMIT 50
    `, [sellerId])
    // 双盲铁律(店铺主页公开面):rating agg + 最近评价只算/只展示已揭晓的评价。
    // 揭晓 = 双方都评过(buyer_ratings 存在) OR 无盲评窗口 OR 盲评期已过 —— 与 /products|sellers/:id/ratings 同条件。
    const blindOpen = `(EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id) OR r.hidden_until IS NULL OR datetime(r.hidden_until) <= datetime('now'))`
    const ratingsAgg = (await dbOne<{ cnt: number; avg_stars: number }>(`
      SELECT COUNT(*) as cnt, COALESCE(AVG(stars), 0) as avg_stars FROM order_ratings r WHERE r.seller_id = ? AND ${blindOpen}
    `, [sellerId]))!
    const followers = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM follows WHERE followee_id = ?`, [sellerId]))!.n
    const completedOrders = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE seller_id = ? AND status = 'completed'`, [sellerId]))!.n
    // 当前 viewer 是否关注
    let is_following = false
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (token) {
        const u = await dbOne<{ id: string }>('SELECT id FROM users WHERE api_key = ?', [token])
        if (u) is_following = !!(await dbOne('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', [u.id, sellerId]))
      }
    } catch {}
    const recentRatings = await dbAll(`
      SELECT r.stars, r.comment, r.reply, r.created_at,
        u.handle as buyer_handle, p.title as product_title
      FROM order_ratings r
      JOIN users u ON u.id = r.buyer_id
      JOIN products p ON p.id = r.product_id
      WHERE r.seller_id = ? AND ${blindOpen}
      ORDER BY r.created_at DESC LIMIT 5
    `, [sellerId])
    res.json({
      seller,
      stats: {
        products: products.length,
        followers,
        completed_orders: completedOrders,
        rating_avg: ratingsAgg.cnt > 0 ? Number(ratingsAgg.avg_stars) : null,
        rating_count: ratingsAgg.cnt,
      },
      products,
      recent_ratings: recentRatings,
      is_following,
    })
  })

  // 卖家更新自己店铺装饰
  app.patch('/api/shops/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'seller') return void res.status(403).json({ error: '仅卖家可设置' })
    const { shop_intro, shop_banner_url, bio } = req.body || {}
    const sets: string[] = []
    const args: unknown[] = []
    if (shop_intro !== undefined) { sets.push('shop_intro = ?'); args.push(shop_intro ? String(shop_intro).slice(0, 2000) : null) }
    if (shop_banner_url !== undefined) {
      if (shop_banner_url && !/^https?:\/\//.test(String(shop_banner_url))) {
        return void res.status(400).json({ error: 'banner URL 必须是 http(s)://' })
      }
      sets.push('shop_banner_url = ?'); args.push(shop_banner_url ? String(shop_banner_url).slice(0, 500) : null)
    }
    if (bio !== undefined) { sets.push('bio = ?'); args.push(bio ? String(bio).slice(0, 200) : null) }
    if (sets.length === 0) return void res.status(400).json({ error: '无可更新字段' })
    sets.push(`updated_at = datetime('now')`)
    args.push(user.id)
    await dbRun(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })
}
