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
import { invalidateProductVerification } from '../../product-verification.js'

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
  // db 已走 RFC-016 异步 seam(dbOne/dbRun);deps.db 仅用于 direct-pay 逐品验证作废(sync helper,反作弊生命周期)
  const { db, auth, makeCommitmentHash, makeDescriptionHash, makePriceHash,
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
      image_hashes,   // 商品图片 hash 数组(64hex,≤9);编辑页加图/换图用。与 create 同格式:JSON.stringify 存 images 列
      weight_kg, package_size, origin_country, country_of_origin, customs_description, hs_code,   // S0 跨境清关/物流证据字段(可选;进后续订单条款快照,不影响在途单)
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
    // S0 清关字段(可选;与 create 同校验;null 显式清除,undefined 保留)
    const _cc = (x: unknown): string | null | undefined => x === undefined ? undefined : ((typeof x === 'string' && x.trim()) ? x.trim().toUpperCase().slice(0, 8) : null)
    const _tx = (x: unknown, n: number): string | null | undefined => x === undefined ? undefined : ((typeof x === 'string' && x.trim()) ? x.trim().slice(0, n) : null)
    const _hs = _tx(hs_code, 12)
    if (typeof _hs === 'string' && !/^[0-9.]{4,12}$/.test(_hs)) return void res.status(400).json({ error: 'hs_code 须为 4-12 位数字(可含 .)', error_code: 'INVALID_HS_CODE' })
    const titlesResult = validateI18n(i18n_titles)
    const descsResult = validateI18n(i18n_descs)
    const newI18nTitles = titlesResult === undefined ? product.i18n_titles : titlesResult
    const newI18nDescs = descsResult === undefined ? product.i18n_descs : descsResult

    // 商品图片 hash 数组(编辑页加图/换图):undefined=不更新;[]=清空;否则校验(≤9 张、64hex,与 create 同规则)→ JSON 存 images 列
    let newImages: string | null | undefined = undefined
    if (image_hashes !== undefined) {
      if (!Array.isArray(image_hashes)) return void res.status(400).json({ error: 'image_hashes 必须为数组' })
      if (image_hashes.length > 9) return void res.status(400).json({ error: '图片最多 9 张' })
      for (const h of image_hashes) {
        if (typeof h !== 'string' || !/^[a-f0-9]{64}$/i.test(h)) return void res.status(400).json({ error: 'image_hashes 必须为 64 字符十六进制' })
      }
      newImages = image_hashes.length ? JSON.stringify(image_hashes.map((h: string) => h.toLowerCase())) : null
    }

    await dbRun(`UPDATE products SET
      images=?,
      title=?, description=?, price=?, stock=?,
      specs=?, brand=?, model=?, handling_hours=?, ship_regions=?,
      estimated_days=?, fragile=?, return_days=?, return_condition=?, warranty_days=?,
      low_stock_threshold=?, auto_delist_on_zero=?,
      low_stock_alerted_at = CASE WHEN ?=1 THEN NULL ELSE low_stock_alerted_at END,
      origin_claims=?,
      i18n_titles=?, i18n_descs=?,
      weight_kg=?, package_size=?, origin_country=?, country_of_origin=?, customs_description=?, hs_code=?,
      commitment_hash=?, description_hash=?, price_hash=?, hashed_at=?,
      updated_at=datetime('now')
      WHERE id=?`, [
      newImages === undefined ? product.images : newImages,
      newTitle, newDesc, newPrice, newStock,
      specsJson, brand ?? product.brand, model ?? product.model,
      newHandling, newShipRegions, newEstDays, newFragile,
      newReturnDays, newReturnCond, newWarranty,
      newLowThreshold, newAutoDelist, resetAlert,
      newOriginClaims,
      newI18nTitles, newI18nDescs,
      weight_kg === undefined ? product.weight_kg : (weight_kg === null || weight_kg === '' ? null : Number(weight_kg)),
      _tx(package_size, 40) === undefined ? product.package_size : _tx(package_size, 40),
      _cc(origin_country) === undefined ? product.origin_country : _cc(origin_country),
      _cc(country_of_origin) === undefined ? product.country_of_origin : _cc(country_of_origin),
      _tx(customs_description, 120) === undefined ? product.customs_description : _tx(customs_description, 120),
      _hs === undefined ? product.hs_code : _hs,
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

    // 反作弊(PR-⑥):任何【买家可见的商品身份字段】变更 → 作废该商品的直付逐品验证,强制重新验证,防"先验证商品 A,
    //   再改成商品 B"绕过逐品硬门。external-link 变更在 products-links 路由另行作废。fail-soft,不阻断编辑。
    //   ⚠️ 必须含 i18n_titles/i18n_descs:formatProductForAgent 按 Accept-Language 把 title/description 换成对应语言,
    //      只改 en/ja/ko 标题描述同样是"换货"(非中文买家看到的就变了);并含 brand/model(商品身份)。
    const newBrand = brand ?? product.brand
    const newModel = model ?? product.model
    const eq = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '')
    const materialChanged = !eq(newTitle, product.title) || !eq(newDesc, product.description)
      || Number(newPrice) !== Number(product.price) || !eq(specsJson, product.specs)
      || !eq(newI18nTitles, product.i18n_titles) || !eq(newI18nDescs, product.i18n_descs)
      || !eq(newBrand, product.brand) || !eq(newModel, product.model)
    if (materialChanged) { try { invalidateProductVerification(db, String(req.params.id)) } catch (e) { console.error('[product-verify invalidate]', e) } }

    res.json({ success: true })
  })
}
