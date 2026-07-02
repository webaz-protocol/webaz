/**
 * 多商家跟卖 (Listings) 域 — P1 listing × product 共享身份
 *
 * 由 #1013 Phase 52 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET  /api/listings                     列表搜索（公开）
 *   GET  /api/listings/mine                我的跟卖（seller）
 *   GET  /api/listings/:id                 详情 + offers 加权排序
 *   POST /api/listings                     创建（首创者，stake = 1.5 × 基础 × 类目倍数）
 *   POST /api/listings/:id/offers          跟卖（一卖家 × 一 listing = 一 offer）
 *
 * Smart 排序：urgency=now/today/flex 加权（price/eta/trust/region/fresh）+
 *   now 模式 eta>4h 直接 -1（最末）
 *
 * 跨域注入（cross-domain users）：
 *   - LISTING_CATEGORIES / isListingCategoryKey / BASE_LISTING_STAKE — RFQ/auction 也用
 *   - VALID_FULFILLMENT_TYPES — RFQ/offers 也用
 *
 * 模块内私有：
 *   - URGENCY_WEIGHTS / VALID_OFFER_SORTS / computeOfferScore / isUrgencyKey
 *   - sellerCompletedSales（仅 listings）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const URGENCY_WEIGHTS = {
  now:   { price: 0.10, eta: 0.50, trust: 0.20, region: 0.10, fresh: 0.10, eta_hard_max: 4 },
  today: { price: 0.25, eta: 0.35, trust: 0.15, region: 0.15, fresh: 0.10, eta_hard_max: 24 },
  flex:  { price: 0.45, eta: 0.10, trust: 0.20, region: 0.10, fresh: 0.15, eta_hard_max: null as number | null },
} as const
type UrgencyKey = keyof typeof URGENCY_WEIGHTS

function isUrgencyKey(s: string): s is UrgencyKey {
  return s === 'now' || s === 'today' || s === 'flex'
}
const VALID_OFFER_SORTS = new Set(['smart', 'cheapest', 'fastest', 'trusted', 'nearest', 'clearance'])

function computeOfferScore(o: Record<string, unknown>, urgency: UrgencyKey, ctx: { minPrice: number; maxPrice: number; buyerRegion: string | null; nowIso: string }): number {
  const w = URGENCY_WEIGHTS[urgency]
  const price = Number(o.price)
  const eta = o.eta_hours != null ? Number(o.eta_hours) : null

  if (w.eta_hard_max != null && eta != null && eta > w.eta_hard_max) return -1

  const pSpread = ctx.maxPrice - ctx.minPrice
  const priceNorm = pSpread > 0 ? (ctx.maxPrice - price) / pSpread : 1
  const etaScore = eta != null ? Math.max(0, 1 - eta / 72) : Math.max(0, 1 - 48 / 72)
  const trustNorm = Math.min(1, Number(o.seller_sales || 0) / 100)
  const regionMatch = ctx.buyerRegion && o.seller_region === ctx.buyerRegion ? 1 : 0.3
  const freshTs = o.freshness_ts ? String(o.freshness_ts) : (o.updated_at as string)
  const ageH = freshTs ? (Date.parse(ctx.nowIso) - Date.parse(freshTs)) / 3600_000 : 0
  const freshScore = ageH < 24 ? 1 : ageH < 168 ? 0.85 : 0.5

  let score = w.price * priceNorm + w.eta * etaScore + w.trust * trustNorm + w.region * regionMatch + w.fresh * freshScore
  if (Number(o.cold_start_remaining || 0) > 0) score *= 0.7
  return Math.round(score * 10000) / 10000
}

type ListingCategoryCfg = { name: string; stake_mult: number; cold_start: number; min_sales: number; requires_kyc: boolean }

export interface ListingsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  LISTING_CATEGORIES: Record<string, ListingCategoryCfg>
  BASE_LISTING_STAKE: number
  VALID_FULFILLMENT_TYPES: Set<string>
  isListingCategoryKey: (s: string) => boolean
}

export function registerListingsRoutes(app: Application, deps: ListingsDeps): void {
  const { db, generateId, auth, LISTING_CATEGORIES, BASE_LISTING_STAKE, VALID_FULFILLMENT_TYPES, isListingCategoryKey } = deps

  async function sellerCompletedSales(uid: string): Promise<number> {
    const r = await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM orders WHERE seller_id = ? AND status = 'completed'`, [uid])
    return Number(r?.n ?? 0)
  }

  // 列表搜索（公开）
  app.get('/api/listings', async (req, res) => {
    const q = String(req.query.q || '').trim()
    const category = String(req.query.category || '').trim()
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30))
    const sort = String(req.query.sort || 'newest')

    const where: string[] = ["l.status = 'active'"]
    const args: unknown[] = []
    if (q) {
      const qE = String(q).replace(/[\\%_]/g, '\\$&')
      where.push("(l.title LIKE ? ESCAPE '\\' OR l.spec LIKE ? ESCAPE '\\' OR l.category_path LIKE ? ESCAPE '\\')")
      args.push(`%${qE}%`, `%${qE}%`, `%${qE}%`)
    }
    if (category && isListingCategoryKey(category)) { where.push("l.category = ?"); args.push(category) }
    const orderBy = sort === 'popular' ? 'l.total_sales DESC, l.created_at DESC' : 'l.created_at DESC'
    const rows = await dbAll(`
      SELECT l.*,
        (SELECT MIN(p.price) FROM products p WHERE p.listing_id = l.id AND p.status = 'active') as min_price,
        (SELECT COUNT(1)     FROM products p WHERE p.listing_id = l.id AND p.status = 'active') as offer_count
      FROM listings l
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `, [...args, limit])
    res.json({ items: rows, categories: LISTING_CATEGORIES })
  })

  // 我的跟卖
  app.get('/api/listings/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.status(403).json({ error: '仅卖家可用', error_code: 'SELLER_ONLY' })
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT l.id, l.title, l.category, l.category_path, l.external_id, l.created_at,
        (SELECT COUNT(*) FROM products WHERE listing_id = l.id AND seller_id = ? AND status = 'active') as my_offer_count,
        (SELECT MIN(price) FROM products WHERE listing_id = l.id AND seller_id = ? AND status = 'active') as my_min_price,
        (SELECT COUNT(*) FROM products WHERE listing_id = l.id AND status = 'active') as total_offer_count,
        (SELECT MIN(price) FROM products WHERE listing_id = l.id AND status = 'active') as global_min_price,
        (l.created_by = ?) as is_creator
      FROM listings l
      WHERE l.status = 'active' AND EXISTS (
        SELECT 1 FROM products WHERE listing_id = l.id AND seller_id = ? AND status = 'active'
      )
      ORDER BY l.created_at DESC
      LIMIT 100
    `, [user.id, user.id, user.id, user.id])
    res.json({ items: rows })
  })

  // 详情 + offers 加权排序
  app.get('/api/listings/:id', async (req, res) => {
    const listing = await dbOne<Record<string, unknown>>("SELECT * FROM listings WHERE id = ? AND status != 'blocked'", [req.params.id])
    if (!listing) return void res.status(404).json({ error: 'listing 不存在' })

    const urgency: UrgencyKey = isUrgencyKey(String(req.query.urgency || '')) ? (String(req.query.urgency) as UrgencyKey) : 'flex'
    const sortParam = String(req.query.sort || 'smart')
    const sortMode = VALID_OFFER_SORTS.has(sortParam) ? sortParam : 'smart'

    const offers = await dbAll<Record<string, unknown>>(`
      SELECT p.id, p.seller_id, p.title, p.price, p.stock, p.status,
        p.fulfillment_type, p.eta_hours, p.freshness_ts, p.is_clearance, p.clearance_until,
        p.cold_start_remaining, p.listing_stake_locked, p.ship_regions, p.commission_rate,
        p.created_at, p.updated_at,
        u.handle as seller_handle,
        u.region as seller_region,
        (SELECT COUNT(1) FROM orders WHERE seller_id = p.seller_id AND status = 'completed') as seller_sales
      FROM products p
      LEFT JOIN users u ON u.id = p.seller_id
      WHERE p.listing_id = ? AND p.status = 'active'
    `, [req.params.id])

    const buyerRegion = req.query.buyer_region ? String(req.query.buyer_region) : null
    const nowIso = new Date().toISOString()

    if (offers.length) {
      const prices = offers.map(o => Number(o.price))
      const minPrice = Math.min(...prices)
      const maxPrice = Math.max(...prices)
      const etas = offers.filter(o => o.eta_hours != null).map(o => Number(o.eta_hours))
      const minEta = etas.length ? Math.min(...etas) : null

      offers.forEach(o => {
        const tags: string[] = []
        if (Number(o.price) === minPrice) tags.push('cheapest')
        if (minEta != null && o.eta_hours != null && Number(o.eta_hours) === minEta) tags.push('fastest')
        if (buyerRegion && o.seller_region === buyerRegion) tags.push('nearest')
        if (Number(o.seller_sales) >= 50) tags.push('trusted')
        if (o.is_clearance && (!o.clearance_until || String(o.clearance_until) > nowIso)) tags.push('clearance')
        const freshTs = o.freshness_ts ? String(o.freshness_ts) : (o.updated_at as string)
        const ageH = freshTs ? (Date.parse(nowIso) - Date.parse(freshTs)) / 3600_000 : 0
        if (ageH >= 168) tags.push('stale')
        o.tags = tags
        o.score = computeOfferScore(o, urgency, { minPrice, maxPrice, buyerRegion, nowIso })
      })

      if (sortMode === 'smart') {
        offers.sort((a, b) => Number(b.score) - Number(a.score))
      } else if (sortMode === 'cheapest') {
        offers.sort((a, b) => Number(a.price) - Number(b.price))
      } else if (sortMode === 'fastest') {
        offers.sort((a, b) => (Number(a.eta_hours ?? Infinity) - Number(b.eta_hours ?? Infinity)))
      } else if (sortMode === 'trusted') {
        offers.sort((a, b) => Number(b.seller_sales || 0) - Number(a.seller_sales || 0))
      } else if (sortMode === 'nearest') {
        offers.sort((a, b) => {
          const am = buyerRegion && a.seller_region === buyerRegion ? 0 : 1
          const bm = buyerRegion && b.seller_region === buyerRegion ? 0 : 1
          if (am !== bm) return am - bm
          return Number(a.price) - Number(b.price)
        })
      } else if (sortMode === 'clearance') {
        offers.sort((a, b) => {
          const ac = a.is_clearance ? 0 : 1
          const bc = b.is_clearance ? 0 : 1
          if (ac !== bc) return ac - bc
          return Number(a.price) - Number(b.price)
        })
      }
    }

    res.json({ listing, offers, urgency, sort: sortMode, categories: LISTING_CATEGORIES })
  })

  // 创建 listing（首创者）
  app.post('/api/listings', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const body = req.body as Record<string, unknown>
    const title = String(body.title || '').trim()
    if (title.length < 2) return void res.json({ error: 'title 至少 2 字' })
    const cat = String(body.category || 'general')
    if (!isListingCategoryKey(cat)) return void res.json({ error: '类目无效' })
    const catCfg = LISTING_CATEGORIES[cat]

    if (catCfg.requires_kyc) {
      const k = await dbOne<{ status: string }>("SELECT status FROM kyc_records WHERE user_id = ?", [user.id])
      if (!k || k.status !== 'approved') {
        return void res.json({ error: `${catCfg.name} 类目需先完成实名认证（KYC）`, error_code: 'KYC_REQUIRED' })
      }
    }
    if (catCfg.min_sales > 0) {
      const sales = await sellerCompletedSales(user.id as string)
      if (sales < catCfg.min_sales) {
        return void res.json({ error: `${catCfg.name} 类目需至少 ${catCfg.min_sales} 单成功历史（当前 ${sales}）` })
      }
    }

    // 首创者 stake = 1.5 × 基础 × 类目倍数
    const stakeRequired = Math.round(BASE_LISTING_STAKE * catCfg.stake_mult * 1.5 * 100) / 100
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || Number(wallet.balance) < stakeRequired) {
      return void res.json({ error: `余额不足，创建 ${catCfg.name} listing 需 ${stakeRequired} WAZ` })
    }

    const externalId = body.external_id ? String(body.external_id).trim() : null
    if (externalId) {
      const existing = await dbOne<{ id: string }>("SELECT id FROM listings WHERE external_id = ? AND status = 'active'", [externalId])
      if (existing) return void res.json({ error: '该型号已存在 listing，请改为跟卖', listing_id: existing.id, suggestion: 'follow' })
    }

    const id = generateId('l')
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO listings (id, external_id, category, category_path, title, spec, cover_image, description, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        id, externalId, cat,
        body.category_path ? String(body.category_path) : null,
        title,
        body.spec ? JSON.stringify(body.spec) : null,
        body.cover_image ? String(body.cover_image) : null,
        body.description ? String(body.description) : null,
        user.id
      )
      db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?`).run(stakeRequired, stakeRequired, user.id)
    })
    try { tx() } catch (e) { return void res.status(500).json({ error: String((e as Error).message) }) }
    res.json({ id, stake_locked: stakeRequired, category: cat })
  })

  // 跟卖：为已有 listing 创建本卖家的 product（即一个 offer）
  app.post('/api/listings/:id/offers', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可跟卖' })

    const listing = await dbOne<Record<string, unknown>>("SELECT id, category, title, cover_image, description FROM listings WHERE id = ? AND status = 'active'", [req.params.id])
    if (!listing) return void res.status(404).json({ error: 'listing 不存在或已下架' })
    const cat = String(listing.category)
    const catCfg = isListingCategoryKey(cat) ? LISTING_CATEGORIES[cat] : LISTING_CATEGORIES.general

    if (catCfg.min_sales > 0) {
      const sales = await sellerCompletedSales(user.id as string)
      if (sales < catCfg.min_sales) {
        return void res.json({ error: `${catCfg.name} 类目跟卖需至少 ${catCfg.min_sales} 单成功历史（当前 ${sales}）` })
      }
    }

    const body = req.body as Record<string, unknown>
    const priceNum = Number(body.price)
    if (!Number.isFinite(priceNum) || priceNum <= 0) return void res.json({ error: 'price 必须 > 0' })
    const stockNum = Math.max(0, Math.floor(Number(body.stock) || 0))
    if (stockNum < 1) return void res.json({ error: 'stock 至少 1' })
    const fulfillmentType = String(body.fulfillment_type || 'standard')
    if (!VALID_FULFILLMENT_TYPES.has(fulfillmentType)) return void res.json({ error: 'fulfillment_type 无效' })
    const shipRegions = body.ship_regions ? String(body.ship_regions).trim() : '全国'

    const stakeRequired = Math.round(BASE_LISTING_STAKE * catCfg.stake_mult * 100) / 100
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || Number(wallet.balance) < stakeRequired) {
      return void res.json({ error: `余额不足，跟卖 ${catCfg.name} 需 ${stakeRequired} WAZ` })
    }

    // 一卖家 × 一 listing = 一 offer
    const existing = await dbOne<{ id: string; status: string }>("SELECT id, status FROM products WHERE listing_id = ? AND seller_id = ? AND status != 'deleted'", [req.params.id, user.id])
    if (existing) return void res.json({ error: '已存在该商品的 offer，请修改而非新建', offer_id: existing.id })

    const id = generateId('p')
    const coverImg = body.cover_image ? String(body.cover_image) : (listing.cover_image as string | null)
    const imagesJson = coverImg ? JSON.stringify([coverImg]) : '[]'
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO products (
          id, seller_id, title, description, price, stock, status, images,
          ship_regions, handling_hours, commission_rate, category_id, stake_amount,
          listing_id, fulfillment_type, eta_hours, freshness_ts,
          is_clearance, clearance_until, cold_start_remaining, listing_stake_locked, currency
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?,?,?,'WAZ')
      `).run(
        id, user.id,
        listing.title as string,
        (body.description ? String(body.description) : listing.description || '') as string,
        priceNum, stockNum, 'active',
        imagesJson,
        shipRegions, 24, 0.10, 'cat_default', 0,
        req.params.id, fulfillmentType,
        body.eta_hours != null ? Number(body.eta_hours) : null,
        body.is_clearance ? 1 : 0,
        body.clearance_until ? String(body.clearance_until) : null,
        catCfg.cold_start, stakeRequired
      )
      db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?`).run(stakeRequired, stakeRequired, user.id)
      db.prepare(`UPDATE listings SET total_offers = total_offers + 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id)
    })
    try { tx() } catch (e) { return void res.status(500).json({ error: String((e as Error).message) }) }
    res.json({ id, stake_locked: stakeRequired })
  })
}
