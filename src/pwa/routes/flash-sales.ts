/**
 * 限时促销域 (Wave D-4)
 *
 * 由 #1013 Phase 23 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST   /api/products/:product_id/flash-sale       卖家创建（单次 ≤30 天）
 *   GET    /api/products/:product_id/flash-sale       公开：当前生效的 sale
 *   GET    /api/sellers/me/flash-sales                卖家自己列表（含历史）
 *   DELETE /api/flash-sales/:id                       取消（仅未开始）
 *   GET    /api/flash-sales/live                      全平台正在进行（discovery）
 *
 * 跨域：
 *   - export getActiveFlashSale(db, productId, variantId?) — orders 下单流程会用
 *     server.ts 顶部用 wrapper 把签名贴回 (productId, variantId)
 *
 * 防重叠：同 product + 同 variant 不能同时有 is_active=1 且未结束的促销
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface FlashSalesDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void
}

/** 拿商品（含 variant）当前生效的 flash sale；多重叠时取价最低。orders 下单也会用。 */
export function getActiveFlashSale(
  db: Database.Database,
  productId: string,
  variantId?: string | null,
): { id: string; sale_price: number; ends_at: string; max_qty: number; sold_count: number } | null {
  const variantClause = variantId
    ? `AND (variant_id IS NULL OR variant_id = ?)`
    : `AND variant_id IS NULL`
  const sql = `
    SELECT id, sale_price, ends_at, max_qty, sold_count
    FROM flash_sales
    WHERE product_id = ? AND is_active = 1
      AND starts_at <= datetime('now') AND ends_at > datetime('now')
      AND (max_qty = 0 OR sold_count < max_qty)
      ${variantClause}
    ORDER BY sale_price ASC LIMIT 1
  `
  const args: unknown[] = [productId]
  if (variantId) args.push(variantId)
  return db.prepare(sql).get(...args) as ReturnType<typeof getActiveFlashSale>
}

export function registerFlashSalesRoutes(app: Application, deps: FlashSalesDeps): void {
  // db 仍在 destructure 中——传给同步 getActiveFlashSale(订单金钱路径消费,随 money batch 迁);
  // 本文件的 handler 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun)
  const { db, generateId, auth, broadcastSystemEvent } = deps

  app.post('/api/products/:product_id/flash-sale', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<{ id: string; seller_id: string; price: number; has_variants: number }>('SELECT id, seller_id, price, has_variants FROM products WHERE id = ? AND status = \'active\'', [req.params.product_id])
    if (!product) return void res.status(404).json({ error: '商品不存在或已下架' })
    if (product.seller_id !== user.id) return void res.status(403).json({ error: '仅商品卖家可创建限时促销' })
    const { variant_id, sale_price, starts_at, ends_at, max_qty } = req.body || {}
    const salePrice = Number(sale_price)
    if (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice >= Number(product.price)) {
      return void res.status(400).json({ error: 'sale_price 必须 > 0 且 < 商品原价' })
    }
    if (!starts_at || !ends_at) return void res.status(400).json({ error: 'starts_at / ends_at 必填（ISO 8601）' })
    const startsT = new Date(starts_at).getTime()
    const endsT = new Date(ends_at).getTime()
    const now = Date.now()
    if (!Number.isFinite(startsT) || !Number.isFinite(endsT)) return void res.status(400).json({ error: '时间格式无效' })
    if (endsT <= startsT) return void res.status(400).json({ error: '结束时间必须晚于开始时间' })
    if (endsT - startsT > 30 * 86400 * 1000) return void res.status(400).json({ error: '单次促销最多 30 天' })
    if (endsT < now) return void res.status(400).json({ error: '结束时间已过' })

    let variantId: string | null = null
    if (variant_id) {
      if (!product.has_variants) return void res.status(400).json({ error: '该商品无规格，不可绑定 variant' })
      const v = await dbOne('SELECT id FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1', [variant_id, product.id])
      if (!v) return void res.status(400).json({ error: 'variant 不存在' })
      variantId = String(variant_id)
    } else if (Number(product.has_variants) === 1) {
      return void res.status(400).json({ error: '该商品有规格，请指定 variant_id' })
    }
    const maxQty = Number.isFinite(Number(max_qty)) ? Math.max(0, Number(max_qty)) : 0
    // 防重叠：同 product+variant 不能有进行中的促销
    const conflict = await dbOne<{ id: string }>(`
      SELECT id FROM flash_sales WHERE product_id = ? AND ${variantId ? 'variant_id = ?' : 'variant_id IS NULL'}
        AND is_active = 1 AND ends_at > datetime('now') LIMIT 1
    `, variantId ? [product.id, variantId] : [product.id])
    if (conflict) return void res.status(409).json({ error: '已有进行中的促销，请先结束', existing_id: conflict.id })

    const id = generateId('fls')
    await dbRun(`INSERT INTO flash_sales (id, seller_id, product_id, variant_id, sale_price, original_price, max_qty, starts_at, ends_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, user.id, product.id, variantId, salePrice, Number(product.price), maxQty, new Date(startsT).toISOString(), new Date(endsT).toISOString()])
    try { broadcastSystemEvent('flash_sale', '⚡', `限时促销创建 ${product.id} · ${salePrice}/${product.price} WAZ`, product.id) } catch {}
    res.json({ success: true, id })
  })

  // 公开：商品当前生效的 flash sale
  app.get('/api/products/:product_id/flash-sale', (req, res) => {
    const variantId = req.query.variant_id ? String(req.query.variant_id) : null
    const sale = getActiveFlashSale(db, req.params.product_id, variantId)
    res.json({ sale })
  })

  // seller 自己的 flash sales（全部状态）
  app.get('/api/sellers/me/flash-sales', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT f.*, p.title as product_title
      FROM flash_sales f
      JOIN products p ON p.id = f.product_id
      WHERE f.seller_id = ?
      ORDER BY f.ends_at DESC LIMIT 100
    `, [user.id])
    res.json({ items: rows })
  })

  // 取消（仅 seller 自己，且未开始）
  app.delete('/api/flash-sales/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const f = await dbOne<{ seller_id: string; starts_at: string }>('SELECT seller_id, starts_at FROM flash_sales WHERE id = ?', [req.params.id])
    if (!f) return void res.status(404).json({ error: 'flash sale 不存在' })
    if (f.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可操作' })
    if (new Date(f.starts_at).getTime() <= Date.now()) {
      return void res.status(400).json({ error: '已开始的促销不可取消，请设置 is_active=0 提前结束' })
    }
    await dbRun('DELETE FROM flash_sales WHERE id = ?', [req.params.id])
    res.json({ success: true })
  })

  // buyer 视角：当前全平台正在进行的 flash sales（首屏 discovery）
  app.get('/api/flash-sales/live', async (req, res) => {
    const rows = await dbAll(`
      SELECT f.id, f.product_id, f.variant_id, f.sale_price, f.original_price, f.ends_at, f.max_qty, f.sold_count,
             p.title, p.images, p.category,
             u.handle as seller_handle, u.name as seller_name
      FROM flash_sales f
      JOIN products p ON p.id = f.product_id AND p.status = 'active'
      JOIN users u ON u.id = f.seller_id
      WHERE f.is_active = 1
        AND f.starts_at <= datetime('now') AND f.ends_at > datetime('now')
        AND (f.max_qty = 0 OR f.sold_count < f.max_qty)
      ORDER BY f.ends_at ASC LIMIT 100
    `)
    res.json({ items: rows })
  })
}
