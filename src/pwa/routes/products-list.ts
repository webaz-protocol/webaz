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
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { randomBytes } from 'crypto'
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // RFC-018 PR4: 真实成交(排除全额退货)
import { SCHEMA_PRODUCT_SEARCH, SCHEMA_PRODUCT_DETAIL, projectProductModel, projectProductDetail, sellersIndex } from '../../agent-model-projection.js'  // MCP Token PR-1/2: agent 模式 Model Projection + 按需详情
import { getUsdRates } from '../../fx-rates.js'  // USDC→本地法币显示换算(display-only,绝非结算路径)

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

// result-fetch 每 IP 限流桶(进程内;单实例部署下足够,Codex M-4)
const resultFetchRate = new Map<string, { count: number; resetAt: number }>()

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

    // 调用契约 PR-C — 无约束全目录浏览守卫(agent 模式):审计根因之一是 0 命中被导向"无 query
    //   浏览 limit 50/100/200"。有效约束 = query/精确匹配 · category · 价格 · 退货 · 发货 · 卖家 ·
    //   ship_to · has_sales · product_type · since_days · has_trial(此路由后段真正应用的全部过滤)。
    //   全无约束(纯浏览)时 agent 模式:单页硬顶 8(防一次 200 件的 token 轰炸,即本次事故形态)。
    //   目录本身是公开的(匿名 search 即返回全部在售),守卫目的是防【单次响应】过大 + 引导结构化发现,
    //   【不】隐藏目录 —— 故 cursor 翻页(每页仍 ≤8,token 有界)放行,与 model-projection 锁定的游标
    //   分页完整性契约一致(Codex R2 曾建议连 cursor 一起拒,但那会破该契约且防的是非威胁:公开数据的
    //   逐页枚举无害,真危害是单响应体积 —— 已由 ≤8 限住)。result_handle 非本 GET 路由能力,不豁免。
    const hasQuery = typeof q === 'string' && q.trim().length > 0
    // since_days 只在 SQL 实际生效范围(>0 且 ≤365)内算作有效约束 —— 否则 since_days=366 会被当约束却
    //   不施加任何过滤,重开全目录枚举(Codex R2-1)。守卫判定必须与下方 SQL 生效条件字面一致。
    const sinceDaysValid = typeof sinceDaysRaw === 'string' && Number.isFinite(Number(sinceDaysRaw)) && Number(sinceDaysRaw) > 0 && Number(sinceDaysRaw) <= 365
    const hasFilter = !!category || max_price != null || min_return_days != null || max_handling_hours != null
      || !!seller_id || (typeof ship_to === 'string' && ship_to.trim().length > 0)
      || has_sales === 'true' || has_sales === 'false' || productTypeFilter != null
      || sinceDaysValid || req.query.has_trial === 'true'
    const unbounded = mode === 'agent' && !hasQuery && !hasFilter

    // limit
    const cap = PRODUCT_LIMITS[mode]
    let lim = Math.floor(Number(limitRaw))   // 非整数 limit 直进 SQL LIMIT 会炸 → 取整(Codex round-1 MEDIUM)
    if (!Number.isFinite(lim) || lim <= 0) lim = mode === 'pwa' ? 30 : (mode === 'raw' ? 100 : 50)
    if (unbounded && lim > 8) {
      return void res.status(400).json({
        error: 'unbounded catalog browse — an agent must not pull a large unconstrained page. Give a constraint (category / keywords via webaz_discover, or a filter), or request a small page (limit ≤ 8; you may still paginate with cursor).',
        error_code: 'UNBOUNDED_CATALOG_BROWSE',
        recommended_next_call: { tool: 'webaz_discover', description: 'structured discovery with a category key and/or keywords', category_vocabulary: 'GET https://webaz.xyz/api/agent/categories' },
        sample_browse: { tool: 'webaz_search', arguments: { mode: 'agent', sort: 'newest', limit: 8 }, description: 'small catalog sample (≤8/page)' },
      })
    }
    if (lim > cap) lim = cap
    if (unbounded && lim > 8) lim = 8   // 纯浏览(无约束)硬顶 8,即便 cap 更高

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
    let cursorAnchorRows: Record<string, unknown>[] | null = null
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
        // cursor 锚点只认【原序中真正展示了的头部】(keepHead):注入的新卖家条目分数可能远低于被挤掉的
        // 条目,若锚到它,下一页 score < 注入分 会把被挤掉的商品永久跳过(Codex round-1 HIGH-1)。
        // 锚在 keepHead 最低位 → 被挤掉的条目落到下一页;注入条目在后页重复出现(可重复,绝不丢)。
        cursorAnchorRows = keepHead
        rows = [...keepHead, ...newSellerCandidates]
      }
    }

    rows = rows.slice(0, lim)
    if (!cursorAnchorRows || cursorAnchorRows.length === 0) cursorAnchorRows = rows

    // 下一页 cursor — 基于原序展示集中 raw score 最低位（防 jitter/slot 注入翻页丢候选）
    let nextCursor: string | null = null
    const hasMore = (
      (sort === 'trending' || sort === 'newest')
      && rows.length > 0
      && (candidates.length >= buffer || rows.length === lim)
    )
    if (hasMore) {
      let anchor = cursorAnchorRows[0]
      for (const r of cursorAnchorRows) {
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

    // agent 模式(MCP Token PR-1):Model Projection —— 模型只看决策字段。
    //   此前这里 spread 整个 products 行(~99 列,含 hash/迁移/回填/commission_rate/source_* 等内部字段,
    //   单件 ~3.2KB);现改为 allowlist 投影(单一真相源 src/agent-model-projection.ts,≤ ~350B/件)。
    //   排序公式与 metrics 属服务端内部(排序已在 SQL/上方完成,模型无需复算);完整字段面后续 PR 走
    //   UI Projection / result_handle 按需取。i18n 标题与 agent_summary 仍经 formatProductForAgent 单源生成。
    // MCP Token PR-2:签发 result_handle —— 只存本页 id 选择集(零载荷),10 分钟 TTL。
    //   详情经 /api/products/result-fetch 按 id 活读(重跑 active 可见性谓词),句柄绝不携带数据本身。
    let resultHandle: string | null = null
    if (rows.length) {
      resultHandle = 'res_' + randomBytes(16).toString('hex')
      try {
        await dbRun("INSERT INTO mcp_result_cache (handle_id, subject, tool, item_ids, context, expires_at) VALUES (?,?,?,?,?, datetime('now','+10 minutes'))",
          [resultHandle, null, 'webaz_search', JSON.stringify(rows.map(r => String(r.id))), JSON.stringify({ sort, category: category ?? null, q: q ? 'set' : null }), ])
      } catch (e) { resultHandle = null; console.warn('[result-handle] issue failed:', (e as Error).message) }   // 缓存面故障不阻断搜索本体,但留可观测日志(Codex L-2)
    }
    // USDC 显示换算表(与 /api/fx/rates 同源;fail-soft 省略)—— 模型/组件据此给出"≈ 本地法币"对照
    let fx: Record<string, unknown> | null = null
    try { const snap = await getUsdRates(); fx = { base: snap.base, rates: snap.rates, as_of: snap.as_of, stale: snap.stale, note: 'display-only conversion — never a settlement path' } } catch { fx = null }
    // 调用契约 PR-D:列表响应机器化引导取详情 —— 不再让 agent 从长篇工具描述里自己发现 result_handle 用法
    //   (审计 A6)。detail_required_for_card:渲染完整卡片前必须先取详情;selectable_ids:本页可选 id
    //   全集;detail_fetch_template:填 selected_ids 即可执行的调用骨架;selection_required:最终商品必须
    //   由 agent 选择(Holden:不预填第一条 id,服务端不为任何候选背书)。
    const detailGuidance = resultHandle ? {
      detail_required_for_card: true,
      selection_required: true,
      selectable_ids: rows.map(r => String(r.id)),
      detail_fetch_template: { tool: 'webaz_search', arguments: { result_handle: resultHandle, selected_ids: ['<pick 1-5 ids from selectable_ids>'] } },
      detail_usage: 'Fetch details ONLY for the product(s) the buyer is deciding on (usually 1); never bulk-fetch all results for display.',   // A2.1:防模型为展示批量拉详情(实测 5 全拉=巨量冗余输出)
    } : {}
    res.json({
      schema_version: SCHEMA_PRODUCT_SEARCH,
      mode, sort, limit: lim,
      count: rows.length,
      next_cursor: nextCursor,
      ...(fx ? { fx } : {}),
      ...(resultHandle ? { result_handle: resultHandle, result_handle_expires_in_s: 600 } : {}),
      ...detailGuidance,
      sellers: sellersIndex(rows),
      products: rows.map(r => {
        const f = formatProductForAgent(r, req)
        return projectProductModel({ ...r, title: f.title, estimated_days: f.estimated_days, agent_summary: f.agent_summary }, (typeof ship_to === 'string' && ship_to.trim()) ? ship_to.trim().toUpperCase() : null)
      }),
    })
  })

  // ─── MCP Token PR-2:按需商品详情(result_handle + selected_ids ≤5)────────────────────────
  //   句柄只证明"这些 id 出现在你最近一次搜索结果里";数据一律活读并【重跑与搜索完全相同的公共可见性
  //   谓词】(active + 有库存 + 卖家未暂停 + 无 revoked-未-verified 外链)—— 任一谓词失效的商品诚实
  //   返回 unavailable,绝不吐缓存陈货,也绝无权限绕过面。blocklist 是登录观察者的个性化过滤,句柄
  //   为匿名公共面(subject=NULL),不适用 —— 见 REMOTE-MCP.md 同一措辞。
  //   资源滥用护栏(Codex M-4):无鉴权端点按 IP 限流(默认 60 req/min,WEBAZ_RESULT_FETCH_RPM 可调)。
  app.post('/api/products/result-fetch', async (req, res) => {
    const rpm = Math.max(1, Number(process.env.WEBAZ_RESULT_FETCH_RPM) || 60)
    // 不信任 X-Forwarded-For(可伪造→桶逃逸,Codex round-2 M-2):只认 Cloudflare 权威头,否则退回
    //   socket 地址(代理后=共享桶,只会更严不会更松)。清扫后仍超硬上限 → 整表重置(有界内存优先)。
    const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown')
    const now = Date.now()
    const slot = resultFetchRate.get(ip)
    if (!slot || now >= slot.resetAt) resultFetchRate.set(ip, { count: 1, resetAt: now + 60_000 })
    else if (++slot.count > rpm) {
      return void res.status(429).json({ error: 'rate limited', error_code: 'RATE_LIMITED', retryable: true, retry_after_s: Math.ceil((slot.resetAt - now) / 1000) })
    }
    if (resultFetchRate.size > 10_000) {
      for (const [k, v] of resultFetchRate) if (now >= v.resetAt) resultFetchRate.delete(k)
      if (resultFetchRate.size > 50_000) resultFetchRate.clear()
    }
    const { result_handle, selected_ids, full_terms } = (req.body ?? {}) as { result_handle?: unknown; selected_ids?: unknown; full_terms?: unknown }
    if (typeof result_handle !== 'string' || !/^res_[0-9a-f]{32}$/.test(result_handle)) {
      return void res.status(400).json({ error: 'result_handle required', error_code: 'RESULT_HANDLE_INVALID', retryable: false, next_steps: [{ action: 'search_again', tool: 'webaz_search' }] })
    }
    if (!Array.isArray(selected_ids) || selected_ids.length < 1 || selected_ids.length > 5 || !selected_ids.every(x => typeof x === 'string')) {
      return void res.status(400).json({ error: 'selected_ids must be 1..5 product ids from the handle result', error_code: 'SELECTED_IDS_INVALID', retryable: true })
    }
    const h = await dbOne<{ tool: string; item_ids: string; expires_at: string }>('SELECT tool, item_ids, expires_at FROM mcp_result_cache WHERE handle_id = ?', [result_handle])
    if (!h || h.tool !== 'webaz_search') {
      return void res.status(404).json({ error: 'unknown result_handle', error_code: 'RESULT_HANDLE_INVALID', retryable: false, next_steps: [{ action: 'search_again', tool: 'webaz_search' }] })
    }
    if (String(h.expires_at) <= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      return void res.status(410).json({ error: 'result_handle expired (10-min TTL)', error_code: 'RESULT_HANDLE_EXPIRED', retryable: false, next_steps: [{ action: 'search_again', tool: 'webaz_search' }] })
    }
    // fail-closed 形状校验(Codex L-1):item_ids 非 string[](表被其他写者污染)→ 按无效句柄处理,绝不 500
    let allowed: string[] | null = null
    try { const parsed = JSON.parse(h.item_ids) as unknown; if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) allowed = parsed } catch { allowed = null }
    if (!allowed) {
      return void res.status(404).json({ error: 'result_handle unusable', error_code: 'RESULT_HANDLE_INVALID', retryable: false, next_steps: [{ action: 'search_again', tool: 'webaz_search' }] })
    }
    const outside = (selected_ids as string[]).filter(id => !allowed!.includes(id))
    if (outside.length) {
      return void res.status(400).json({ error: 'selected_ids must come from the SAME search result the handle was issued for', error_code: 'SELECTED_IDS_NOT_IN_HANDLE', retryable: true, hint: 'ids outside the handle set are rejected — search again for other products' })
    }
    const ph = (selected_ids as string[]).map(() => '?').join(',')
    // 与 /api/products 搜索完全同源的公共可见性谓词(Codex H-1):active + stock>0 + 卖家未暂停 + 外链治理
    const liveRows = await dbAll<Record<string, unknown>>(
      `SELECT p.*, u.name as seller_name, u.created_at as seller_created_at,
        COALESCE((SELECT total_points FROM reputation_scores WHERE user_id = p.seller_id), 0) as rep_points,
        COALESCE((SELECT level FROM reputation_scores WHERE user_id = p.seller_id), 'new') as rep_level,
        (SELECT COUNT(1) FROM orders o WHERE o.product_id = p.id AND ${genuineSalePredicate('o')}) as sales_count
       FROM products p JOIN users u ON p.seller_id = u.id
       WHERE p.id IN (${ph}) AND p.status = 'active' AND p.stock > 0
        AND COALESCE(u.listing_paused, 0) = 0
        AND NOT (
          EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.revoked = 1)
          AND NOT EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.verified = 1 AND (pel.revoked IS NULL OR pel.revoked = 0))
        )`,
      selected_ids as string[])
    const liveIds = new Set(liveRows.map(r => String(r.id)))
    let fxD: Record<string, unknown> | null = null
    try { const snap = await getUsdRates(); fxD = { base: snap.base, rates: snap.rates, as_of: snap.as_of, stale: snap.stale, note: 'display-only conversion — never a settlement path' } } catch { fxD = null }
    res.json({
      schema_version: SCHEMA_PRODUCT_DETAIL,
      count: liveRows.length,
      ...(fxD ? { fx: fxD } : {}),
      sellers: sellersIndex(liveRows),
      products: liveRows.map(r => {
        const f = formatProductForAgent(r, req)
        return projectProductDetail({ ...r, title: f.title, description: f.description, specs: f.specs, estimated_days: f.estimated_days, agent_summary: f.agent_summary }, { full: full_terms === true, resultHandle: result_handle })
      }),
      ...(selected_ids.length !== liveRows.length ? { unavailable_ids: (selected_ids as string[]).filter(id => !liveIds.has(id)), unavailable_note: 'no longer active/available — live re-check, cached data is never served' } : {}),
    })
  })
}
