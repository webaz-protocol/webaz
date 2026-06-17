/**
 * Products 元数据端点 — 价格历史 + 公开预览 + 分享许可 + 创建分享 shareable
 *
 * 由 #1013 Phase 90 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET  /api/products/:id/price-history       价格历史（30/90/lifetime + buckets + sparkline + 同类对照 + 异常 flag）
 *   GET  /api/products/:id/preview             公开预览（未登录可调，最小字段）
 *   GET  /api/products/:id/can-share           分享许可：是否买过且 completed
 *   POST /api/products/:id/get-or-create-share 复用 active shareable / 新建（短链 /s/<id>）
 *
 * price-history 关键设计：
 *   - PH_MIN_SAMPLE 5 单：少于 5 单完成不出统计（隐私 + 数据稀疏）
 *   - LIMIT 5000 防爆 + 真百分位（linear interp）
 *   - daily_avg 单日 sales=1 隐藏 avg（防按日期+价格反查买家身份）
 *   - 同类目均价对照（排除 cat_default）
 *   - 异常 flag: current_below_70pct_median / far_below_category_avg / far_above
 *
 * 跨域注入：auth + generateId + rateLimitOk + flagNewAccountShareable + refreshProductSharerCount
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // 真实成交单一真相源

export interface ProductsMetaDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
  flagNewAccountShareable: (shareableId: string, ownerId: string) => void
  refreshProductSharerCount: (productId: string) => void
}

/**
 * 真实收货完成的订单数(分享资格判据)。
 * 关键:status='completed' 是状态机的通用终态 — 不只「无争议自然完成」(confirmed→completed),
 * 还包括 fault_seller / fault_logistics / fault_buyer / declined_nofault / disputed → completed
 * 这些退款 / 违约 / 争议处置终态。单看 status='completed' 会把「被退款的失败交易」当成有效成交,
 * 错误授予分享(进而分享分润)资格。
 * 真实收货 = 该订单曾进入过 confirmed(买家确认收货,或送达后 72h 自动确认)— 仅 happy path 经过,
 * 所有 fault/争议/退款终态都不经过 confirmed,据此排除。
 */
async function genuineReceiptCount(buyerId: string, productId: string): Promise<number> {
  return (await dbOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND product_id = ? AND ${genuineSalePredicate('orders')}`,
    [buyerId, productId],
  ))!.n
}

export function registerProductsMetaRoutes(app: Application, deps: ProductsMetaDeps): void {
  const { db, auth, generateId, rateLimitOk, flagNewAccountShareable, refreshProductSharerCount } = deps
  void db  // RFC-016: 本文件已全量走异步 seam;db 仍在 deps 由调用方注入,此处不直接使用

  const PH_RATE = 60   // 每 IP/分钟 60 次
  const PH_MIN_SAMPLE = 5

  app.get('/api/products/:id/price-history', async (req, res) => {
    const ip = req.ip || 'unknown'
    if (!rateLimitOk(`ph:${ip}`, PH_RATE, 60_000)) return void res.status(429).json({ error: 'rate-limited' })

    const p = await dbOne<{ id: string; current_price: number; category: string | null; category_id: string | null }>("SELECT id, price as current_price, category, category_id FROM products WHERE id = ?", [req.params.id])
    if (!p) return void res.status(404).json({ error: 'not_found' })

    const lifetimeCount = (await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM orders WHERE product_id = ? AND status = 'completed'`, [req.params.id]))!.n
    if (lifetimeCount < PH_MIN_SAMPLE) {
      return void res.json({ product_id: req.params.id, current_price: p.current_price, insufficient_data: true, lifetime_sales: lifetimeCount, min_sample: PH_MIN_SAMPLE })
    }

    async function aggregateWindow(days: number | null) {
      const where = days != null
        ? `product_id = ? AND status = 'completed' AND created_at > datetime('now', '-' || ? || ' days')`
        : `product_id = ? AND status = 'completed'`
      const args = days != null ? [req.params.id, days] : [req.params.id]
      const row = (await dbOne<{ sales: number; volume: number; avg: number }>(`
        SELECT COUNT(1) as sales, COALESCE(SUM(total_amount), 0) as volume,
          COALESCE(AVG(unit_price), 0) as avg
        FROM orders WHERE ${where}
      `, args))!
      if (row.sales === 0) return { sales: 0, volume: 0, avg: 0, median: 0, p25: 0, p75: 0 }
      // SQLite 无 percentile 函数；P1 fix #1: LIMIT 5000 防爆
      const prices = (await dbAll<{ unit_price: number }>(`SELECT unit_price FROM orders WHERE ${where} ORDER BY unit_price ASC LIMIT 5000`, args)).map(r => Number(r.unit_price))
      // P1 fix #2: 真百分位（linear interp）
      const pct = (frac: number) => {
        if (!prices.length) return 0
        const idx = (prices.length - 1) * frac
        const lo = Math.floor(idx)
        const hi = Math.ceil(idx)
        if (lo === hi) return prices[lo]
        const w = idx - lo
        return Math.round((prices[lo] * (1 - w) + prices[hi] * w) * 100) / 100
      }
      return {
        sales: row.sales,
        volume: Math.round(row.volume * 100) / 100,
        avg: Math.round(row.avg * 100) / 100,
        median: pct(0.5),
        p25: pct(0.25),
        p75: pct(0.75),
      }
    }

    const d30 = await aggregateWindow(30)
    const d90 = await aggregateWindow(90)
    const lifetime = await aggregateWindow(null)

    // 价位分布（90 天内，最多 20 个 bucket）
    const buckets = await dbAll<{ price: number; count: number; qty: number }>(`
      SELECT unit_price as price, COUNT(1) as count, COALESCE(SUM(quantity), COUNT(1)) as qty
      FROM orders WHERE product_id = ? AND status = 'completed' AND created_at > datetime('now', '-90 days')
      GROUP BY unit_price ORDER BY unit_price ASC LIMIT 20
    `, [req.params.id])
    const totalBucketSales = buckets.reduce((s, b) => s + b.count, 0) || 1
    const priceBuckets = buckets.map(b => ({
      price: Number(b.price),
      count: b.count,
      qty: b.qty,
      pct: Math.round((b.count / totalBucketSales) * 10000) / 100,
    }))

    // 30 日日均价 sparkline — P1 fix #4: 单日 sales=1 不返回 avg（防反查买家身份）
    const daily = await dbAll<{ date: string; sales: number; avg: number }>(`
      SELECT substr(created_at, 1, 10) as date, COUNT(1) as sales, AVG(unit_price) as avg
      FROM orders WHERE product_id = ? AND status = 'completed' AND created_at > datetime('now', '-30 days')
      GROUP BY date ORDER BY date ASC
    `, [req.params.id])
    const dailyAvg = daily.map(d => ({
      date: d.date,
      sales: d.sales,
      avg: d.sales >= 2 ? Math.round(Number(d.avg) * 100) / 100 : null,
    }))

    // 同类目近 30 天均价对照（cat_default 不算 meaningful）
    let categoryAvg30d: number | null = null
    if (p.category_id && p.category_id !== 'cat_default') {
      const row = (await dbOne<{ avg: number | null }>(`
        SELECT AVG(o.unit_price) as avg FROM orders o JOIN products p ON p.id = o.product_id
        WHERE p.category_id = ? AND o.status = 'completed' AND o.created_at > datetime('now', '-30 days')
      `, [p.category_id]))!
      categoryAvg30d = row.avg != null ? Math.round(Number(row.avg) * 100) / 100 : null
    }

    // 异常预警
    const flags: string[] = []
    if (d30.median > 0 && p.current_price < d30.median * 0.7) flags.push('current_below_70pct_median')
    if (categoryAvg30d != null && p.current_price < categoryAvg30d * 0.5) flags.push('far_below_category_avg')
    if (categoryAvg30d != null && p.current_price > categoryAvg30d * 3) flags.push('far_above_category_avg')

    res.json({
      product_id: req.params.id,
      current_price: p.current_price,
      insufficient_data: false,
      windows: { d30, d90, lifetime },
      price_buckets: priceBuckets,
      daily_avg: dailyAvg,
      category_avg_30d: categoryAvg30d,
      anomaly_flags: flags,
    })
  })

  // 公开预览：未登录可调，返回最小公开信息（分享 banner 用）
  app.get('/api/products/:id/preview', async (req, res) => {
    const row = await dbOne<Record<string, unknown>>(`
      SELECT p.id, p.title, p.price, p.category, u.name as seller_name
      FROM products p
      JOIN users u ON p.seller_id = u.id
      WHERE p.id = ? AND p.status = 'active'
    `, [req.params.id])
    if (!row) return void res.status(404).json({ error: 'not_found' })
    res.json(row)
  })

  // 分享许可：是否真实收货完成该商品(经过 confirmed,排除退款/违约/争议终态)
  app.get('/api/products/:id/can-share', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const completed = await genuineReceiptCount(user.id as string, req.params.id)
    res.json({
      can_share:        completed > 0,
      completed_orders: completed,
      reason: completed > 0 ? 'genuine_receipt_of_product' : 'need_genuine_receipt_of_this_product',
    })
  })

  // 获取或创建商品 shareable（被 sharePromoLink 用，走 /s/<id> 短链）
  app.post('/api/products/:id/get-or-create-share', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const productId = req.params.id

    // RFC-002 §3.5 valuation-layer gate — share_link generation requires opt-in
    const optIn = (await dbOne<{ rewards_opted_in: number }>("SELECT rewards_opted_in FROM users WHERE id = ?", [user.id]))?.rewards_opted_in ?? 0
    if (optIn !== 1) {
      const getParam = async (key: string, def: number): Promise<number> => {
        const r = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = ?", [key])
        return r ? Number(r.value) : def
      }
      const minOrders = await getParam('rewards_opt_in.min_completed_orders', 1)
      const requirePasskey = await getParam('rewards_opt_in.require_passkey', 1)
      const totalCompleted = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [user.id]))!.n  // 真实成交,排除退款/违约
      const passkeyCount = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?", [user.id]))!.n
      const missing: string[] = []
      if (totalCompleted < minOrders) missing.push(`completed_orders ${totalCompleted}/${minOrders}`)
      if (requirePasskey === 1 && passkeyCount === 0) missing.push('passkey_not_registered')
      if (missing.length === 0) missing.push('application_not_submitted')
      return void res.status(403).json({
        error: 'rewards_opt_in_required',
        message_zh: '生成分享链接属于估值层操作 — 需先开通分享分润 / share-commission opt-in(RFC-002)',
        message_en: 'Share-link generation is a valuation-layer (rewards / share-link) action, NOT a contribution gate — requires rewards / share-commission opt-in (RFC-002)',
        missing_requirements: missing,
        next_steps: [
          'Open PWA #me → tap "申请分享分润 / Enable share-commission opt-in"',
          'Read the 8-second disclosure (cannot skip)',
          'Submit application — pre-checks run server-side',
        ],
      })
    }

    const completed = await genuineReceiptCount(user.id as string, productId)
    if (completed === 0) return void res.json({ error: '需先真实收货完成该商品的购买才能分享(退款 / 违约 / 争议订单不算)', completed_orders: 0 })
    // 优先复用现有 active shareable
    const existing = await dbOne<{ id: string; owner_code: string | null }>(`SELECT id, owner_code FROM shareables WHERE owner_id = ? AND related_product_id = ? AND status = 'active' LIMIT 1`, [user.id, productId])
    if (existing) {
      return void res.json({ ok: true, shareable_id: existing.id, owner_code: existing.owner_code, short_url: `/s/${existing.id}`, reused: true })
    }
    // 创建新 shareable（纯商品分享：无外链，无 native，仅绑 product_id）
    const id = generateId('shr')
    const ownerCode = (await dbOne<{ permanent_code: string | null }>("SELECT permanent_code FROM users WHERE id = ?", [user.id]))?.permanent_code || null
    const product = await dbOne<{ title: string }>("SELECT title FROM products WHERE id = ?", [productId])
    await dbRun(`INSERT INTO shareables (id, owner_id, type, title, related_product_id, owner_code)
                VALUES (?,?,?,?,?,?)`,
      [id, user.id, 'product_promo', product?.title || null, productId, ownerCode])
    flagNewAccountShareable(id, user.id as string)
    refreshProductSharerCount(productId)
    res.json({ ok: true, shareable_id: id, owner_code: ownerCode, short_url: `/s/${id}`, reused: false })
  })
}
