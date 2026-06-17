/**
 * 预售 / waitlist 域 (Wave B-2)
 *
 * 由 #1013 Phase 24 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST   /api/products/:product_id/waitlist           buyer 排队
 *   DELETE /api/products/:product_id/waitlist           移除
 *   GET    /api/waitlist                                我的清单
 *   GET    /api/products/:product_id/waitlist/check     是否已加
 *   GET    /api/products/:product_id/waitlist/count     seller 查 pending 用户数 + total_qty
 *
 * 边界：
 *   - 受信角色（TRUSTED_ROLE_NO_TRADE）拒
 *   - 卖家不可对自己商品排队
 *   - 仅 active 且 stock=0 才允许排队
 *   - INSERT OR REPLACE — 同用户重复排队覆盖
 *   - desired_qty: 1-99
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface WaitlistDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

export function registerWaitlistRoutes(app: Application, deps: WaitlistDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, isTrustedRole, errorRes } = deps

  app.post('/api/products/:product_id/waitlist', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const p = await dbOne<{ id: string; seller_id: string; status: string; stock: number }>('SELECT id, seller_id, status, stock FROM products WHERE id = ?', [req.params.product_id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id === user.id) return void res.status(400).json({ error: '不可对自己商品排队' })
    if (p.status !== 'active') return void res.status(400).json({ error: '商品已下架，无法排队' })
    if (p.stock > 0) return void res.status(400).json({ error: '商品有货，无需排队 — 直接下单即可' })
    const qty = Math.max(1, Math.min(99, Number(req.body?.desired_qty) || 1))
    const note = req.body?.note ? String(req.body.note).slice(0, 200) : null
    await dbRun(`INSERT OR REPLACE INTO product_waitlist (user_id, product_id, desired_qty, note) VALUES (?,?,?,?)`,
      [user.id, req.params.product_id, qty, note])
    res.json({ success: true })
  })

  app.delete('/api/products/:product_id/waitlist', async (req, res) => {
    const user = auth(req, res); if (!user) return
    await dbRun('DELETE FROM product_waitlist WHERE user_id = ? AND product_id = ?', [user.id, req.params.product_id])
    res.json({ success: true })
  })

  app.get('/api/waitlist', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT w.product_id, w.desired_qty, w.note, w.notified_at, w.created_at,
             p.title, p.price, p.stock, p.status as product_status, p.category,
             u.name as seller_name, u.handle as seller_handle
      FROM product_waitlist w
      JOIN products p ON p.id = w.product_id AND p.status != 'deleted'
      JOIN users u ON u.id = p.seller_id
      WHERE w.user_id = ?
      ORDER BY w.created_at DESC LIMIT 200
    `, [user.id])
    res.json({ items: rows })
  })

  app.get('/api/products/:product_id/waitlist/check', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const exists = await dbOne('SELECT 1 FROM product_waitlist WHERE user_id = ? AND product_id = ?', [user.id, req.params.product_id])
    res.json({ in_waitlist: !!exists })
  })

  // seller 查 waitlist count（决定备多少货）
  app.get('/api/products/:product_id/waitlist/count', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [req.params.product_id])
    if (!p || p.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可看' })
    const r = (await dbOne<{ cnt: number; total_qty: number }>(`SELECT COUNT(*) as cnt, COALESCE(SUM(desired_qty), 0) as total_qty FROM product_waitlist WHERE product_id = ? AND notified_at IS NULL`, [req.params.product_id]))!
    res.json({ pending_users: r.cnt, total_desired: r.total_qty })
  })
}
