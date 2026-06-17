/**
 * 商品规格 (variants) CRUD 域
 *
 * 由 #1013 Phase 18 从 src/pwa/server.ts 抽出（Wave B-1 Phase 1）。
 *
 * 4 endpoints:
 *   GET    /api/products/:product_id/variants                    公开列出可选项
 *   POST   /api/products/:product_id/variants                    卖家加 variant
 *   PATCH  /api/products/:product_id/variants/:variant_id        改 variant
 *   DELETE /api/products/:product_id/variants/:variant_id        删 variant
 *
 * 关键不变量（P1-1）:
 *   product.stock = SUM(variant.stock for is_active=1 variants)
 *   首个 variant 重置 product.stock；后续累加；DELETE 扣减；无 variant 时 has_variants=0
 *
 * 防重复（P2-1）:
 *   同 product_id + 同 options_key（canonical sorted）+ is_active=1 唯一
 *   migration 在 server.ts 顶部建索引 + 一次性回填 options_key
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface VariantsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

/** options → canonical key（sort + join）— 防同规格组合两次入库 */
function canonicalOptionsKey(options: Record<string, unknown>): string {
  return Object.keys(options).sort().map(k => `${k}=${String(options[k])}`).join('|')
}

export function registerVariantsRoutes(app: Application, deps: VariantsDeps): void {
  const { db, generateId, auth } = deps

  // 公开列出（含 buyer 下单页查可选项）
  app.get('/api/products/:product_id/variants', async (req, res) => {
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT id, sku, options_json, price_override, stock, images_json, is_active, created_at
      FROM product_variants
      WHERE product_id = ? AND is_active = 1
      ORDER BY created_at ASC LIMIT 100
    `, [req.params.product_id])
    const items = rows.map(r => {
      let options: Record<string, string> = {}
      let images: string[] = []
      try { options = JSON.parse(r.options_json as string) } catch {}
      try { if (r.images_json) images = JSON.parse(r.images_json as string) } catch {}
      return { ...r, options, images, options_json: undefined, images_json: undefined }
    })
    res.json({ items })
  })

  app.post('/api/products/:product_id/variants', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ id: string; seller_id: string }>('SELECT id, seller_id FROM products WHERE id = ?', [req.params.product_id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id !== user.id) return void res.status(403).json({ error: '仅自己商品可加 variant' })
    const { sku, options, price_override, stock, images } = req.body || {}
    if (!options || typeof options !== 'object' || Object.keys(options).length === 0) {
      return void res.status(400).json({ error: 'options 必填 (e.g. {"颜色":"红","尺寸":"L"})' })
    }
    const stockN = Number.isFinite(Number(stock)) ? Math.max(0, Number(stock)) : 0
    const priceN = price_override != null ? Number(price_override) : null
    if (priceN != null && (priceN <= 0 || priceN > 1_000_000)) return void res.status(400).json({ error: 'price_override 无效' })

    const optKey = canonicalOptionsKey(options as Record<string, unknown>)
    const dup = await dbOne<{ id: string }>(`SELECT id FROM product_variants WHERE product_id = ? AND options_key = ? AND is_active = 1`,
      [req.params.product_id, optKey])
    if (dup) return void res.status(409).json({ error: '该规格组合已存在', existing_id: dup.id })

    const id = generateId('pv')
    db.transaction(() => {
      db.prepare(`INSERT INTO product_variants (id, product_id, sku, options_json, options_key, price_override, stock, images_json) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, req.params.product_id, sku || null, JSON.stringify(options), optKey, priceN, stockN, images ? JSON.stringify(images) : null)
      // P1-1: 首次添加 variant 时，把 product.stock 重置为该 variant 的 stock；
      // 后续添加直接累加 — 让 product.stock 等于 sum(variant.stock)
      const isFirst = (db.prepare(`SELECT COUNT(*) as n FROM product_variants WHERE product_id = ?`).get(req.params.product_id) as { n: number }).n === 1
      if (isFirst) {
        db.prepare(`UPDATE products SET has_variants = 1, stock = ?, updated_at = datetime('now') WHERE id = ?`).run(stockN, req.params.product_id)
      } else {
        db.prepare(`UPDATE products SET stock = stock + ?, updated_at = datetime('now') WHERE id = ?`).run(stockN, req.params.product_id)
      }
    })()
    res.json({ success: true, id })
  })

  app.patch('/api/products/:product_id/variants/:variant_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const v = await dbOne<Record<string, unknown>>(`SELECT v.*, p.seller_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND v.product_id = ?`, [req.params.variant_id, req.params.product_id])
    if (!v) return void res.status(404).json({ error: 'variant 不存在' })
    if (v.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    const { sku, options, price_override, stock, images, is_active } = req.body || {}
    const sets: string[] = []
    const args: unknown[] = []
    if (sku !== undefined) { sets.push('sku = ?'); args.push(sku || null) }
    if (options !== undefined) {
      if (!options || typeof options !== 'object' || Object.keys(options).length === 0) {
        return void res.status(400).json({ error: 'options 不能为空' })
      }
      const newKey = canonicalOptionsKey(options as Record<string, unknown>)
      const dup = await dbOne<{ id: string }>(`SELECT id FROM product_variants WHERE product_id = ? AND options_key = ? AND id != ? AND is_active = 1`,
        [req.params.product_id, newKey, req.params.variant_id])
      if (dup) return void res.status(409).json({ error: '该规格组合已存在', existing_id: dup.id })
      sets.push('options_json = ?'); args.push(JSON.stringify(options))
      sets.push('options_key = ?'); args.push(newKey)
    }
    if (price_override !== undefined) { sets.push('price_override = ?'); args.push(price_override == null ? null : Number(price_override)) }
    let stockDelta = 0
    if (stock !== undefined) {
      const newStock = Math.max(0, Number(stock) || 0)
      const oldStock = Number((v as { stock: number }).stock || 0)
      stockDelta = newStock - oldStock
      sets.push('stock = ?'); args.push(newStock)
    }
    if (images !== undefined) { sets.push('images_json = ?'); args.push(images ? JSON.stringify(images) : null) }
    if (is_active !== undefined) { sets.push('is_active = ?'); args.push(is_active ? 1 : 0) }
    if (sets.length === 0) return void res.status(400).json({ error: '无可更新字段' })
    sets.push(`updated_at = datetime('now')`)
    args.push(req.params.variant_id)
    db.transaction(() => {
      db.prepare(`UPDATE product_variants SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      if (stockDelta !== 0) {
        db.prepare(`UPDATE products SET stock = MAX(0, stock + ?), updated_at = datetime('now') WHERE id = ?`)
          .run(stockDelta, req.params.product_id)
      }
    })()
    res.json({ success: true })
  })

  app.delete('/api/products/:product_id/variants/:variant_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const v = await dbOne<{ id: string; stock: number; seller_id: string }>(`SELECT v.id, v.stock, p.seller_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND v.product_id = ?`, [req.params.variant_id, req.params.product_id])
    if (!v) return void res.status(404).json({ error: 'variant 不存在' })
    if (v.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    db.transaction(() => {
      db.prepare('DELETE FROM product_variants WHERE id = ?').run(req.params.variant_id)
      // P1-1: 从 product.stock aggregate 中扣除该 variant 的 stock
      const variantStock = Number(v.stock || 0)
      if (variantStock > 0) {
        db.prepare(`UPDATE products SET stock = MAX(0, stock - ?), updated_at = datetime('now') WHERE id = ?`)
          .run(variantStock, req.params.product_id)
      }
      const remaining = (db.prepare('SELECT COUNT(*) as n FROM product_variants WHERE product_id = ?').get(req.params.product_id) as { n: number }).n
      if (remaining === 0) {
        db.prepare(`UPDATE products SET has_variants = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.product_id)
      }
    })()
    res.json({ success: true })
  })
}
