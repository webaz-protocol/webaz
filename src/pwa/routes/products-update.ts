/**
 * Products 编辑 — PUT /api/products/:id
 *
 * 由 #1013 Phase 93 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint (123 行)：
 *   PUT /api/products/:id  全字段更新（owner only），含 commitment/description/price hash 重算
 *
 * 关键路径：
 *   - 所有字段可选；undefined → 沿用旧值
 *   - origin_claims (S4 溯源)：≤4KB，certs[].sha256 必须 64 位 hex
 *   - i18n_titles/descs (S3)：9 语支持（en/ja/ko/fr/de/es/pt/ru/ar），单值 ≤500 字符
 *   - low_stock 阈值变化时 reset 'low_stock_alerted_at' 让下次下穿能再触发
 *   - 重算三个 hash：commitment / description / price + hashed_at
 *
 * 副作用：
 *   - stock 0 → 正：notifyWaitlist
 *   - stock 减少：checkStockAndMaybeDelist
 *   - price 下降：notifyWishlistPriceDrop
 *
 * 跨域注入：auth + 3 个 hash maker + 3 个 notify/check 函数
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProductsUpdateDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  makeCommitmentHash: (p: Record<string, unknown>) => string
  makeDescriptionHash: (p: Record<string, unknown>) => string
  makePriceHash: (price: number, ts: string) => string
  notifyWaitlist: (productId: string, productTitle: string) => void
  notifyWishlistPriceDrop: (productId: string, productTitle: string, oldPrice: number, newPrice: number) => void
  checkStockAndMaybeDelist: (productId: string) => void
}

export function registerProductsUpdateRoutes(app: Application, deps: ProductsUpdateDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth, makeCommitmentHash, makeDescriptionHash, makePriceHash,
          notifyWaitlist, notifyWishlistPriceDrop, checkStockAndMaybeDelist } = deps

  app.put('/api/products/:id', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<Record<string, unknown>>('SELECT * FROM products WHERE id = ? AND seller_id = ?', [req.params.id, user.id])
    if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })

    const {
      title, description, price, stock,
      specs, brand, model, handling_hours, ship_regions,
      estimated_days, fragile, return_days, return_condition, warranty_days,
      low_stock_threshold, auto_delist_on_zero,
      origin_claims,
      i18n_titles, i18n_descs,
    } = req.body

    const now = new Date().toISOString()
    const specsJson = specs != null ? (typeof specs === 'object' ? JSON.stringify(specs) : specs) : product.specs
    const estJson   = estimated_days != null ? (typeof estimated_days === 'object' ? JSON.stringify(estimated_days) : String(estimated_days)) : product.estimated_days

    const newTitle       = title       ?? product.title
    const newDesc        = description ?? product.description
    const newPrice       = price       != null ? Number(price) : product.price as number
    const newHandling    = handling_hours != null ? Number(handling_hours) : product.handling_hours
    const newShipRegions = ship_regions ?? product.ship_regions
    const newEstDays     = estJson
    const newReturnDays  = return_days != null ? Number(return_days) : product.return_days
    const newReturnCond  = return_condition ?? product.return_condition
    const newWarranty    = warranty_days != null ? Number(warranty_days) : product.warranty_days
    const newFragile     = fragile != null ? (fragile ? 1 : 0) : product.fragile

    const pFields = { ship_regions: newShipRegions, handling_hours: newHandling, estimated_days: newEstDays, return_days: newReturnDays, return_condition: newReturnCond, warranty_days: newWarranty }

    const newStock = stock != null ? Number(stock) : product.stock
    const oldStock = Number(product.stock || 0)
    // 库存预警 / 自动下架配置（默认沿用旧值）
    const newLowThreshold = low_stock_threshold != null
      ? Math.max(0, Math.floor(Number(low_stock_threshold) || 0))
      : (product.low_stock_threshold ?? 3)
    const newAutoDelist = auto_delist_on_zero != null
      ? (auto_delist_on_zero ? 1 : 0)
      : (product.auto_delist_on_zero ?? 1)
    // 库存回归到阈值之上 → 清零 alert 时间戳，让下次下穿能再发
    const resetAlert = Number(newStock) > Number(newLowThreshold) ? 1 : 0
    // S4 商品溯源：origin_claims 必须是 object（可空），最大 4KB
    let newOriginClaims: string | null = product.origin_claims as string | null
    if (origin_claims !== undefined) {
      if (origin_claims === null || (typeof origin_claims === 'object' && Object.keys(origin_claims).length === 0)) {
        newOriginClaims = null
      } else if (typeof origin_claims === 'object') {
        const json = JSON.stringify(origin_claims)
        if (json.length > 4096) return void res.status(400).json({ error: 'origin_claims 超 4KB' })
        // certs sha256 格式校验
        const certs = (origin_claims as Record<string, unknown>).certs
        if (Array.isArray(certs)) {
          for (const c of certs) {
            if (c && typeof c === 'object' && (c as Record<string, unknown>).sha256) {
              const s = String((c as Record<string, unknown>).sha256)
              if (!/^[0-9a-f]{64}$/i.test(s)) return void res.status(400).json({ error: '证书 sha256 必须是 64 位 hex' })
            }
          }
        }
        newOriginClaims = json
      }
    }
    // S3 i18n：zh 默认在 title/description；i18n_titles/descs 存 en/ja/ko 等
    const SUPPORTED_LANGS = new Set(['en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar'])
    const validateI18n = (raw: unknown): string | null | undefined => {
      if (raw === undefined) return undefined  // 不更新
      if (raw === null) return null
      if (typeof raw !== 'object') return undefined
      const obj = raw as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (!SUPPORTED_LANGS.has(k)) continue
        if (typeof v !== 'string' || v.length === 0) continue
        out[k] = v.slice(0, 500)
      }
      return Object.keys(out).length > 0 ? JSON.stringify(out) : null
    }
    const titlesResult = validateI18n(i18n_titles)
    const descsResult = validateI18n(i18n_descs)
    const newI18nTitles = titlesResult === undefined ? product.i18n_titles : titlesResult
    const newI18nDescs = descsResult === undefined ? product.i18n_descs : descsResult

    await dbRun(`UPDATE products SET
      title=?, description=?, price=?, stock=?,
      specs=?, brand=?, model=?, handling_hours=?, ship_regions=?,
      estimated_days=?, fragile=?, return_days=?, return_condition=?, warranty_days=?,
      low_stock_threshold=?, auto_delist_on_zero=?,
      low_stock_alerted_at = CASE WHEN ?=1 THEN NULL ELSE low_stock_alerted_at END,
      origin_claims=?,
      i18n_titles=?, i18n_descs=?,
      commitment_hash=?, description_hash=?, price_hash=?, hashed_at=?,
      updated_at=datetime('now')
      WHERE id=?`, [
      newTitle, newDesc, newPrice, newStock,
      specsJson, brand ?? product.brand, model ?? product.model,
      newHandling, newShipRegions, newEstDays, newFragile,
      newReturnDays, newReturnCond, newWarranty,
      newLowThreshold, newAutoDelist, resetAlert,
      newOriginClaims,
      newI18nTitles, newI18nDescs,
      makeCommitmentHash(pFields),
      makeDescriptionHash({ title: newTitle, description: newDesc, specs: specsJson }),
      makePriceHash(newPrice, now), now,
      req.params.id
    ])

    // Wave B-2: stock 从 0 → 正数时通知 waitlist 用户
    if (oldStock === 0 && Number(newStock) > 0) {
      try { notifyWaitlist(String(req.params.id), String(newTitle)) } catch (e) { console.error('[waitlist notify]', e) }
    }
    // 卖家手动减库存到 ≤ 阈值时也触发检查
    if (Number(newStock) < oldStock) {
      try { checkStockAndMaybeDelist(String(req.params.id)) } catch (e) { console.error('[stock-check]', e) }
    }
    // 2026-05-24 价格下降 → 通知 wishlist 中开启 notify_price_drop 的用户
    const oldPrice = Number(product.price)
    if (newPrice < oldPrice) {
      try { notifyWishlistPriceDrop(String(req.params.id), String(newTitle), oldPrice, newPrice) } catch (e) { console.error('[wishlist price-drop notify]', e) }
    }

    res.json({ success: true })
  })
}
