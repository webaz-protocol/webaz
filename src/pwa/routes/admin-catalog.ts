/**
 * Admin: 商品 + 类目 catalog 域
 *
 * 由 #1013 Phase 70 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   POST   /api/admin/categories/:id/seasonal     设应季月份（CSV）
 *   DELETE /api/admin/categories/:id/seasonal     清除应季 → 全季
 *   GET    /api/admin/products                    商品列表（可按 status 过滤）
 *   POST   /api/admin/products/:id/force-delist   强制下架
 *
 * 权限：content
 *
 * 跨域注入：requireContentAdmin + logAdminAction
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminCatalogDeps {
  db: Database.Database
  requireContentAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminCatalogRoutes(app: Application, deps: AdminCatalogDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { requireContentAdmin, logAdminAction } = deps

  // ─── 类目 季节性配置 ─────────────────────────────────────
  app.post('/api/admin/categories/:id/seasonal', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const { months } = req.body as { months?: number[] }
    if (!Array.isArray(months) || months.length === 0) {
      return void res.json({ error: 'months 必须是非空数组（1-12 的整数）' })
    }
    const valid = months.filter(m => Number.isInteger(m) && m >= 1 && m <= 12)
    if (valid.length === 0) return void res.json({ error: '没有有效的月份（1-12）' })
    const cat = await dbOne<{ id: string; name: string }>('SELECT id, name FROM product_categories WHERE id = ?', [req.params.id])
    if (!cat) return void res.status(404).json({ error: 'category 不存在' })
    const csv = [...new Set(valid)].sort((a, b) => a - b).join(',')
    await dbRun('UPDATE product_categories SET seasonal_months = ? WHERE id = ?', [csv, req.params.id])
    res.json({ success: true, category: cat.name, seasonal_months: csv })
  })

  app.delete('/api/admin/categories/:id/seasonal', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    await dbRun('UPDATE product_categories SET seasonal_months = NULL WHERE id = ?', [req.params.id])
    res.json({ success: true })
  })

  // ─── 商品 列表 + 强制下架 ───────────────────────────────
  app.get('/api/admin/products', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const status = req.query.status as string | undefined
    let sql = `SELECT p.id, p.title, p.price, p.stock, p.status, p.category, p.seller_id, p.created_at,
                      u.name as seller_name
               FROM products p JOIN users u ON p.seller_id = u.id`
    const params: unknown[] = []
    if (status && status.trim()) { sql += ` WHERE p.status = ?`; params.push(status) }
    sql += ` ORDER BY p.created_at DESC LIMIT 100`
    res.json({ products: await dbAll(sql, params) })
  })

  app.post('/api/admin/products/:id/force-delist', async (req, res) => {
    // P0.5: 需 content 权限（之前仅 requireAdmin）
    const admin = requireContentAdmin(req, res); if (!admin) return
    const { reason } = req.body
    const productId = req.params.id
    const product = await dbOne<{ id: string; status: string; title: string }>("SELECT id, status, title FROM products WHERE id = ?", [productId])
    if (!product) return void res.json({ error: '商品不存在' })
    if (product.status === 'deleted') return void res.json({ error: '商品已删除' })
    if (product.status === 'paused')  return void res.json({ error: '商品已是下架状态' })
    await dbRun("UPDATE products SET status = 'paused', updated_at = datetime('now') WHERE id = ?", [productId])
    logAdminAction(admin.id as string, 'force_delist', 'product', productId, { reason: reason || null, title: product.title })
    res.json({ success: true })
  })
}
