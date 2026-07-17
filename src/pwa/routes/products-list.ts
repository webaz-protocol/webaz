/**
 * Products list — 商品列表 GET /api/products
 *
 * 由 #1013 Phase 95 从 src/pwa/server.ts 抽出（单端点 399 行）。
 *
 * 1 endpoint:
 *   GET /api/products
 *
 * 三种 mode：
 *   - pwa (default 30) — 普通买家，返数组
 *   - agent (200 cap) — agent 富信息 + score_breakdown
 *   - raw (500 cap, trust ≥ 30) — 协议原始数据 + HMAC 签名
 *
 * 关键路径：
 *   1. mode 鉴权 + product_type 默认 retail
 *   2. fuzzy 升级版：strict (alias 精确) → 0 命中 fallback fuzzy LIKE（仅 fuzzy=true）
 *   3. 多 filter: category / price / return_days / handling / seller / ship_to / has_sales / since_days / has_trial
 *   4. TRENDING_SCORE_EXPR SQL 评分 + cursor 分页（trending/newest）
 *   5. 7 种 sort：trending/newest/rating/price/random/recommended/seller_win_rate
 *      — 新品页 (has_sales=false) 把 trending/recommended pivot 到卖家维度
 *   6. claim_loss_count ASC 全 sort 最高优先级（被诉商品下沉）
 *   7. 温和 jitter（pwa+trending）
 *   8. 新卖家 slot 保护（trending only，≤90d 卖家强制 2 slot）
 *   9. cursor 用 raw score 最低位（防 jitter 翻页丢候选）
 *
 * 跨域注入：18 个 helper/常量
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHmac } from 'crypto'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // RFC-018 PR4: 真实成交(排除全额退货)

export interface ProductsListDeps {
  db: Database.Database
  getUser: (req: Request) => Record<string, unknown> | null | undefined
  VALID_PRODUCT_TYPES: Set<string>
  RAW_MODE_MIN_TRUST: number
  getAgentTrustCached: (apiKey: string) => { trust_score: number } | null | undefined
  VALID_SORTS: Set<string>
  PRODUCT_LIMITS: { pwa: number; agent: number; raw: number }
  TRENDING_SCORE_EXPR: string
  findProductsByAlias: (userInput: string) => Set<string>
  decodeProductCursor: (c: string) => { score: number; id: string } | null
  encodeProductCursor: (score: number, id: string) => string
  MASTER_SEED: string
  formatProductForAgent: (p: Record<string, unknown>, req?: Request) => Record<string, unknown>
}

export function registerProductsListRoutes(app: Application, deps: ProductsListDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { getUser, VALID_PRODUCT_TYPES, RAW_MODE_MIN_TRUST, getAgentTrustCached,
          VALID_SORTS, PRODUCT_LIMITS, TRENDING_SCORE_EXPR,
          findProductsByAlias, decodeProductCursor, encodeProductCursor,
          MASTER_SEED, formatProductForAgent } = deps

  app.get('/api/products', async (req, res) => {
    const { q = '', category, max_price, min_return_days, max_handling_hours, has_sales, ship_to,
            mode: modeRaw = 'pwa', sort: sortRaw, cursor, limit: limitRaw, seller_id,
            product_type: productTypeRaw, fuzzy: fuzzyRaw, since_days: sinceDaysRaw } = req.query
    let mode: 'pwa' | 'agent' | 'raw' = modeRaw === 'agent' ? 'agent' : (modeRaw === 'raw' ? 'raw' : 'pwa')
    // fuzzy=true → 发现页用，模糊 LIKE；否则用协议级 alias 精确匹配（AI找同款页）
    const isFuzzy = fuzzyRaw === 'true' || fuzzyRaw === '1'

    // product_type 过滤：pwa 默认 retail（不混 B2B/数字/服务）；agent/raw 不默认过滤
    let productTypeFilter: string | null = null
    if (typeof productTypeRaw === 'string' && productTypeRaw && VALID_PRODUCT_TYPES.has(productTypeRaw)) {
      productTypeFilter = productTypeRaw
    } else if (productTypeRaw === 'all') {
      productTypeFilter = null
    } else if (mode === 'pwa') {
      productTypeFilter = 'retail'
    }
    const me = getUser(req)   // 可选 auth — 登录用户应用黑名单过滤

    // raw mode 鉴权（trust_score ≥ RAW_MODE_MIN_TRUST）
    if (mode === 'raw') {
      const key = req.headers.authorization?.replace('Bearer ', '') ?? ''
      if (!key) return void res.status(401).json({ error: 'raw_mode_requires_auth', min_trust: RAW_MODE_MIN_TRUST })
      const t = getAgentTrustCached(key)
      if (!t || t.trust_score < RAW_MODE_MIN_TRUST) {
        return void res.status(403).json({
          error: 'raw_mode_trust_insufficient',
          your_trust: t?.trust_score ?? 0,
          min_trust: RAW_MODE_MIN_TRUST,
          hint: '提升 trust_score 后可使用 raw mode：见 /api/agents/me/reputation',
        })
      }
    }

    // 排序模式
    let sort = (typeof sortRaw === 'string' && VALID_SORTS.has(sortRaw)) ? sortRaw : 'trending'
    // #977：新品发现 (has_sales=false) trending/recommended 转用卖家维度
    const isNewArrivalsCtx = has_sales === 'false'

    // limit
    const cap = PRODUCT_LIMITS[mode]
    let lim = Number(limitRaw)
    if (!Number.isFinite(lim) || lim <= 0) lim = mode === 'pwa' ? 30 : (mode === 'raw' ? 100 : 50)
    if (lim > cap) lim = cap

    // 内层 SELECT：把 score 计算出来，外层用它过滤 + 排序
    // recommend_count = 已购买的买家中 4 星+ 评价的去重数（一个买家只能推荐一次）
    const innerSelect = `SELECT p.*, u.name as seller_name, u.created_at as seller_created_at,
      COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level,
      COALESCE(rs.transactions_done, 0) as seller_tx_count,
      pc.seasonal_months as seasonal_months,
      (SELECT COUNT(1) FROM orders o WHERE o.product_id = p.id AND ${genuineSalePredicate('o')}) as sales_count,
      (SELECT COUNT(DISTINCT buyer_id) FROM order_ratings r WHERE r.product_id = p.id AND r.stars >= 4) as recommend_count,
      (SELECT COUNT(*) FROM dispute_cases dc WHERE dc.seller_id = p.seller_id) as seller_dispute_count,
      -- 卖家仲裁胜率：无案件视为 0.8 中性（未经检验）；有案件按真实比率
      CASE
        WHEN (SELECT COUNT(*) FROM dispute_cases WHERE seller_id = p.seller_id) = 0 THEN 0.8
        ELSE CAST((SELECT COUNT(*) FROM dispute_cases WHERE seller_id = p.seller_id AND winner = 'seller') AS REAL) /
             (SELECT COUNT(*) FROM dispute_cases WHERE seller_id = p.seller_id)
      END as seller_win_rate,
      -- #977：卖家维度聚合 — 新品发现页按卖家排序
      (SELECT COUNT(DISTINCT r2.buyer_id) FROM order_ratings r2
         JOIN products p2 ON p2.id = r2.product_id
         WHERE p2.seller_id = p.seller_id AND r2.stars >= 4) as seller_recommend_count,
      -- #982：测评免单标记
      (SELECT quota_total - quota_claimed FROM product_trial_campaigns
         WHERE product_id = p.id AND status = 'active') as trial_quota_remaining,
      ${TRENDING_SCORE_EXPR} as trending_score`
    let where = `WHERE p.status = 'active' AND p.stock > 0
        AND COALESCE(u.listing_paused, 0) = 0
        AND NOT (
          EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.revoked = 1)
          AND NOT EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.verified = 1 AND (pel.revoked IS NULL OR pel.revoked = 0))
        )`
    const params: unknown[] = []
    if (me?.id) {
      where += ` AND u.id NOT IN (SELECT blocked_id FROM user_blocklist WHERE blocker_id = ?)`
      params.push(me.id)
    }
    // fuzzy=true 含义升级为 strict → fuzzy 自动回退
    let matchMode: 'strict' | 'fuzzy' | 'none' = 'none'
    if (q) {
      const ids = [...findProductsByAlias(String(q))]
      if (ids.length > 0) {
        where += ` AND p.id IN (${ids.map(() => '?').join(',')})`
        params.push(...ids)
        matchMode = 'strict'
      } else if (isFuzzy) {
        // strict 无果 → fallback 模糊匹配
        // P0 fix: 转义用户输入里的 LIKE 通配符 % _ \ 防止 "%abc"/"a_b" 过宽
        const qStr = String(q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')
        where += ` AND (p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\' OR COALESCE(p.brand,'') LIKE ? ESCAPE '\\')`
        params.push(`%${qStr}%`, `%${qStr}%`, `%${qStr}%`, `%${qStr}%`)
        matchMode = 'fuzzy'
      } else {
        // strict 无果 + 不允许 fuzzy → 协议契约 0 命中
        where += ` AND 1 = 0`
      }
    }
    if (category) { where += ` AND p.category = ?`; params.push(category) }
    if (max_price) { where += ` AND p.price <= ?`; params.push(Number(max_price)) }
    if (min_return_days) { where += ` AND p.return_days >= ?`; params.push(Number(min_return_days)) }
    if (max_handling_hours) { where += ` AND p.handling_hours <= ?`; params.push(Number(max_handling_hours)) }
    if (seller_id) { where += ` AND p.seller_id = ?`; params.push(String(seller_id)) }
    if (productTypeFilter) { where += ` AND COALESCE(p.product_type, 'retail') = ?`; params.push(productTypeFilter) }
    if (ship_to && typeof ship_to === 'string' && ship_to.trim()) {
      const target = ship_to.trim()
      where += ` AND (p.ship_regions = '全国' OR p.ship_regions LIKE ? OR p.ship_regions LIKE ? OR p.ship_regions LIKE ? OR p.ship_regions = ?)`
      params.push(`${target},%`, `%,${target},%`, `%,${target}`, target)
      where += ` AND (p.excluded_regions IS NULL OR p.excluded_regions = '' OR (p.excluded_regions NOT LIKE ? AND p.excluded_regions NOT LIKE ? AND p.excluded_regions NOT LIKE ? AND p.excluded_regions != ?))`
      params.push(`${target},%`, `%,${target},%`, `%,${target}`, target)
    }
    // #987：has_trial=true 优先级高于 has_sales=false
    if (has_sales === 'true') {
      where += ` AND EXISTS (SELECT 1 FROM orders WHERE product_id = p.id AND status = 'completed')`
    } else if (has_sales === 'false' && req.query.has_trial !== 'true') {
      where += ` AND NOT EXISTS (SELECT 1 FROM orders WHERE product_id = p.id AND status = 'completed')`
    }
    // P1-4：新品发现时段过滤
    if (sinceDaysRaw && typeof sinceDaysRaw === 'string') {
      const d = Number(sinceDaysRaw)
      if (Number.isFinite(d) && d > 0 && d <= 365) {
        where += ` AND p.created_at >= datetime('now', '-' || ? || ' days')`
        params.push(d)
      }
    }
    // #987：has_trial=true 只返回开了测评免单 + 还有名额的商品
    if (req.query.has_trial === 'true') {
      where += ` AND EXISTS (SELECT 1 FROM product_trial_campaigns ptc WHERE ptc.product_id = p.id AND ptc.status='active' AND ptc.quota_claimed < ptc.quota_total)`
    }

    const baseFrom = `FROM products p JOIN users u ON p.seller_id = u.id LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id LEFT JOIN product_categories pc ON pc.id = p.category_id ${where}`

    // 排序 + cursor
    // Sprint 5-D: claim_loss_count ASC 全 sort 最高优先级
    let orderBy = ''
    let cursorClause = ''
    const cursorParams: unknown[] = []
    if (sort === 'trending') {
      if (isNewArrivalsCtx) {
        // 新品页：按卖家近期交易量降序
        orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, seller_tx_count DESC, created_at DESC, id DESC`
      } else {
        orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, trending_score DESC, id DESC`
        if (typeof cursor === 'string') {
          const c = decodeProductCursor(cursor)
          if (c) { cursorClause = ` AND (trending_score < ? OR (trending_score = ? AND id < ?))`; cursorParams.push(c.score, c.score, c.id) }
        }
      }
    } else if (sort === 'newest') {
      orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, created_at DESC, id DESC`
      if (typeof cursor === 'string') {
        const c = decodeProductCursor(cursor)
        if (c) { cursorClause = ` AND (julianday(created_at) < ? OR (julianday(created_at) = ? AND id < ?))`; cursorParams.push(c.score, c.score, c.id) }
      }
    } else if (sort === 'rating') {
      orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, rep_points DESC, id DESC`
    } else if (sort === 'price_asc') {
      orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, price ASC, id ASC`
    } else if (sort === 'price_desc') {
      orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, price DESC, id DESC`
    } else if (sort === 'random') {
      orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, RANDOM()`
    } else if (sort === 'recommended') {
      if (isNewArrivalsCtx) {
        orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, seller_recommend_count DESC, seller_tx_count DESC, id DESC`
      } else {
        orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, recommend_count DESC, sales_count DESC, id DESC`
      }
    } else if (sort === 'seller_win_rate') {
      orderBy = ` ORDER BY COALESCE(claim_loss_count, 0) ASC, seller_win_rate DESC, seller_dispute_count DESC, id DESC`
    }

    // trending 多取候选用于 jitter 排序；其他排序直接遵守请求 limit
    const buffer = sort === 'trending' ? Math.min(lim * 3, lim + 30) : lim
    const sql = `SELECT * FROM (${innerSelect} ${baseFrom}) WHERE 1=1 ${cursorClause} ${orderBy} LIMIT ?`
    const finalParams = [...params, ...cursorParams, buffer]
    let candidates: Record<string, unknown>[]
    try {
      candidates = await dbAll<Record<string, unknown>>(sql, finalParams)
    } catch (e) {
      console.error('[/api/products] sql error:', e, '\nSQL:', sql)
      return void res.status(500).json({ error: 'query_failed' })
    }

    // 温和 jitter：仅 trending + pwa
    let rows = candidates
    if (sort === 'trending' && mode === 'pwa' && rows.length > 1) {
      const jittered = rows.map(r => ({ r, k: (Number(r.trending_score) || 0) + (Math.random() - 0.5) }))
      jittered.sort((a, b) => b.k - a.k)
      rows = jittered.map(x => x.r)
    }

    // 新卖家 slot 保护（trending only, ≤90d）
    const NEW_SELLER_SLOTS = 2
    const NEW_SELLER_AGE_MS = 90 * 86400_000
    if (sort === 'trending' && !seller_id && rows.length > NEW_SELLER_SLOTS) {
      const headSliceForCheck = rows.slice(0, lim)
      const headSellerSet = new Set(headSliceForCheck.map(r => String(r.seller_id)))
      const newSellerCandidates: Record<string, unknown>[] = []
      for (const r of rows) {
        const sid = String(r.seller_id)
        if (newSellerCandidates.some(x => String(x.seller_id) === sid)) continue
        if (headSellerSet.has(sid)) continue
        const sc = r.seller_created_at as string | null
        if (!sc) continue
        const ageMs = Date.now() - new Date(sc.replace(' ', 'T') + 'Z').getTime()
        if (ageMs <= NEW_SELLER_AGE_MS) {
          newSellerCandidates.push(r)
          if (newSellerCandidates.length >= NEW_SELLER_SLOTS) break
        }
      }
      if (newSellerCandidates.length) {
        const newSet = new Set(newSellerCandidates.map(r => String(r.id)))
        const others = rows.filter(r => !newSet.has(String(r.id)))
        const keepHead = others.slice(0, lim - newSellerCandidates.length)
        rows = [...keepHead, ...newSellerCandidates]
      }
    }

    rows = rows.slice(0, lim)

    // 下一页 cursor — 基于 rows 中 raw score 最低位（防 jitter 翻页丢候选）
    let nextCursor: string | null = null
    const hasMore = (
      (sort === 'trending' || sort === 'newest')
      && rows.length > 0
      && (candidates.length >= buffer || rows.length === lim)
    )
    if (hasMore) {
      let anchor = rows[0]
      for (const r of rows) {
        const aScore = Number(anchor.trending_score) || 0
        const rScore = Number(r.trending_score) || 0
        if (sort === 'trending') {
          if (rScore < aScore || (rScore === aScore && String(r.id) < String(anchor.id))) anchor = r
        } else {
          if (String(r.created_at) < String(anchor.created_at) || (String(r.created_at) === String(anchor.created_at) && String(r.id) < String(anchor.id))) anchor = r
        }
      }
      if (sort === 'trending') {
        nextCursor = encodeProductCursor(Number(anchor.trending_score) || 0, String(anchor.id))
      } else {
        const jd = (await dbOne<{ j: number }>(`SELECT julianday(?) as j`, [anchor.created_at]))!.j
        nextCursor = encodeProductCursor(jd, String(anchor.id))
      }
    }

    if (nextCursor) res.setHeader('X-Next-Cursor', nextCursor)
    res.setHeader('X-Sort', sort)
    res.setHeader('X-Mode', mode)
    if (matchMode !== 'none') res.setHeader('X-Match-Mode', matchMode)
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor, X-Sort, X-Mode, X-Match-Mode')

    if (mode === 'pwa') {
      // 兼容旧前端：返回数组；cursor 走 X-Next-Cursor header
      // 库存稀缺感 — stock ≤3 且 last_sold_at 近 7d 才标 low_stock
      return void res.json(rows.map(r => {
        const stockNum = Number(r.stock) || 0
        const lastSoldRecent = r.last_sold_at
          && (Date.now() - new Date(String(r.last_sold_at).replace(' ', 'T') + 'Z').getTime()) < 7 * 86400_000
        const lowStock = stockNum > 0 && stockNum <= 3 && lastSoldRecent
        return {
          ...formatProductForAgent(r),
          sales_count: Number(r.sales_count) || 0,
          product_type: r.product_type || 'retail',
          low_stock: lowStock ? stockNum : 0,
        }
      }))
    }

    if (mode === 'raw') {
      // 原始数据 + HMAC 签名（trust ≥ 30 已通过）
      const payload = {
        mode, sort, limit: lim, cursor: nextCursor,
        generated_at: new Date().toISOString(),
        count: rows.length,
        products: rows.map(r => ({
          id: r.id,
          title: r.title,
          seller_id: r.seller_id,
          seller_name: r.seller_name,
          price: r.price,
          stock: r.stock,
          category: r.category,
          category_id: r.category_id,
          ship_regions: r.ship_regions,
          commission_rate: r.commission_rate,
          rep_points: Number(r.rep_points) || 0,
          rep_level: r.rep_level || 'new',
          completion_count: Number(r.completion_count) || 0,
          dispute_loss_count: Number(r.dispute_loss_count) || 0,
          unique_sharer_count: Number(r.unique_sharer_count) || 0,
          last_sold_at: r.last_sold_at,
          sales_count: Number(r.sales_count) || 0,
          trending_score: Number(r.trending_score) || 0,
          created_at: r.created_at,
        })),
      }
      const signature = createHmac('sha256', MASTER_SEED).update(JSON.stringify(payload)).digest('hex')
      res.setHeader('X-Signature', signature)
      res.setHeader('X-Signature-Algo', 'HMAC-SHA256')
      return void res.json(payload)
    }

    // agent 模式：富信息 + 元数据
    res.json({
      mode, sort, limit: lim, cursor: nextCursor,
      count: rows.length,
      products: rows.map(r => {
        const formatted = formatProductForAgent(r)
        const completion = Number(r.completion_count) || 0
        const dispute = Number(r.dispute_loss_count) || 0
        const sharer = Number(r.unique_sharer_count) || 0
        const rep = Number(r.rep_points) || 0
        // 与 SQL TRENDING_SCORE_EXPR 阶梯保持一致
        const ageDaysSinceSold = r.last_sold_at
          ? (Date.now() - new Date(String(r.last_sold_at).replace(' ', 'T') + 'Z').getTime()) / 86400_000
          : null
        let freshness = 0
        if (ageDaysSinceSold !== null) {
          if (ageDaysSinceSold < 30)      freshness = 10
          else if (ageDaysSinceSold < 90) freshness = 10 * (1 - (ageDaysSinceSold - 30) / 60)
          else if (ageDaysSinceSold < 180) freshness = -5
          else                             freshness = -15
        }
        const ageDaysSinceFirst = r.first_sold_at
          ? (Date.now() - new Date(String(r.first_sold_at).replace(' ', 'T') + 'Z').getTime()) / 86400_000
          : null
        const firstSaleBoost = ageDaysSinceFirst !== null && ageDaysSinceFirst < 14 ? 5 : 0
        // 季节性：与 SQL CASE 同步
        const seasonalCsv = r.seasonal_months as string | null
        let seasonalPenalty = 0
        if (seasonalCsv) {
          const currentMonth = new Date().getUTCMonth() + 1
          const activeMonths = seasonalCsv.split(',').map(s => Number(s.trim())).filter(n => n >= 1 && n <= 12)
          if (activeMonths.length && !activeMonths.includes(currentMonth)) seasonalPenalty = -10
        }
        const score = Number(r.trending_score) || 0
        return {
          ...formatted,
          sales_count: Number(r.sales_count) || 0,
          metrics: {
            completion_count: completion,
            dispute_loss_count: dispute,
            unique_sharer_count: sharer,
            last_sold_at: r.last_sold_at || null,
            first_sold_at: r.first_sold_at || null,
            rep_points: rep,
            rep_level: r.rep_level || 'new',
          },
          score,
          score_breakdown: {
            completion: Math.round(completion * 0.5 * 100) / 100,
            rep: Math.round(rep * 0.1 * 100) / 100,
            unique_sharer: Math.round(sharer * 2.0 * 100) / 100,
            freshness: Math.round(freshness * 100) / 100,
            first_sale_boost: firstSaleBoost,
            seasonal_penalty: seasonalPenalty,
            dispute_penalty: Math.round(-dispute * 5.0 * 100) / 100,
          },
        }
      }),
    })
  })
}
