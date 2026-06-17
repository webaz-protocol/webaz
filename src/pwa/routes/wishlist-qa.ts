/**
 * 心愿单 + 商品 Q&A 域
 *
 * 由 #1013 Phase 15 从 src/pwa/server.ts 抽出。两个买家侧 product-engagement 域合并：
 *   Wave A-1 心愿单 (wishlist)            4 endpoints
 *   Wave A-2 商品提问 (product Q&A)       5 endpoints
 *
 * 9 endpoints:
 *   POST   /api/wishlist/:product_id              加心愿单
 *   DELETE /api/wishlist/:product_id              移除
 *   GET    /api/wishlist                          我的清单（带 price_delta）
 *   GET    /api/wishlist/:product_id/check        是否已加
 *   POST   /api/products/:product_id/qa           提问
 *   POST   /api/products/:product_id/qa/:qa_id/answer  卖家回答
 *   GET    /api/products/:product_id/qa           公开列表
 *   POST   /api/products/:product_id/qa/:qa_id/helpful 顶有用（防重复）
 *
 * 边界：
 *   - 受信角色 (TRUSTED_ROLE_*) 既不能加心愿单也不能提问
 *   - 卖家不可对自己商品提问 / 收藏
 *   - 仅 active 商品可提问；wishlist 显示时过滤 deleted
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface WishlistQaDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

export function registerWishlistQaRoutes(app: Application, deps: WishlistQaDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { generateId, auth, isTrustedRole, errorRes } = deps

  // ─── Wave A-1: 心愿单 ────────────────────────────────────
  app.post('/api/wishlist/:product_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const p = await dbOne<{ id: string; price: number; status: string; seller_id: string }>('SELECT id, price, status, seller_id FROM products WHERE id = ?', [req.params.product_id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id === user.id) return void res.status(400).json({ error: '不可收藏自己的商品' })
    const note = req.body?.note ? String(req.body.note).slice(0, 200) : null
    await dbRun(`INSERT OR REPLACE INTO user_wishlist (user_id, product_id, note, price_at_add) VALUES (?,?,?,?)`,
      [user.id, req.params.product_id, note, p.price])
    res.json({ success: true })
  })

  app.delete('/api/wishlist/:product_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    await dbRun('DELETE FROM user_wishlist WHERE user_id = ? AND product_id = ?', [user.id, req.params.product_id])
    res.json({ success: true })
  })

  app.get('/api/wishlist', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // 过滤已删除商品（已下架但 status=warehouse 仍显示让买家可见）
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT w.product_id, w.note, w.price_at_add, w.notify_price_drop, w.notify_back_in_stock, w.created_at,
             p.title, p.price as current_price, p.stock, p.status as product_status,
             p.category, p.claim_loss_count,
             u.name as seller_name, u.handle as seller_handle
      FROM user_wishlist w
      JOIN products p ON p.id = w.product_id
      JOIN users u ON u.id = p.seller_id
      WHERE w.user_id = ? AND p.status != 'deleted'
      ORDER BY w.created_at DESC LIMIT 200
    `, [user.id])
    for (const r of rows) {
      const cur = Number(r.current_price)
      const old = Number(r.price_at_add || cur)
      r.price_delta = Math.round((cur - old) * 100) / 100
      r.price_delta_pct = old > 0 ? Math.round((cur - old) / old * 1000) / 10 : 0
    }
    res.json({ items: rows })
  })

  app.get('/api/wishlist/:product_id/check', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const exists = await dbOne('SELECT 1 FROM user_wishlist WHERE user_id = ? AND product_id = ?', [user.id, req.params.product_id])
    res.json({ in_wishlist: !!exists })
  })

  // ─── Wave A-2: 商品 Q&A ─────────────────────────────────
  app.post('/api/products/:product_id/qa', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_QA', '受信角色不参与商品 Q&A')
    const p = await dbOne<{ id: string; seller_id: string; status: string }>('SELECT id, seller_id, status FROM products WHERE id = ?', [req.params.product_id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id === user.id) return void res.status(400).json({ error: '卖家不可对自己商品提问（请用 description 直接说明）' })
    if (p.status !== 'active') return void res.status(400).json({ error: '仅在售商品可提问' })
    const question = String(req.body?.question || '').trim()
    if (question.length < 6 || question.length > 500) return void res.status(400).json({ error: 'question 长度需 6-500 字' })

    const id = generateId('qa')
    await dbRun(`INSERT INTO product_qa (id, product_id, asker_id, seller_id, question) VALUES (?,?,?,?,?)`,
      [id, req.params.product_id, user.id, p.seller_id, question])
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
        [generateId('ntf'), p.seller_id, '收到商品提问', question.slice(0, 80) + (question.length > 80 ? '...' : ''), null])
    } catch {}
    res.json({ success: true, id })
  })

  app.post('/api/products/:product_id/qa/:qa_id/answer', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const qa = await dbOne<{ id: string; seller_id: string; answer: string | null }>('SELECT id, seller_id, answer FROM product_qa WHERE id = ? AND product_id = ?', [req.params.qa_id, req.params.product_id])
    if (!qa) return void res.status(404).json({ error: '提问不存在' })
    if (qa.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可回答' })
    if (qa.answer) return void res.status(409).json({ error: '已回答过 — 编辑请联系 admin' })
    const answer = String(req.body?.answer || '').trim()
    if (answer.length < 2 || answer.length > 1000) return void res.status(400).json({ error: 'answer 长度需 2-1000 字' })
    await dbRun(`UPDATE product_qa SET answer = ?, answered_at = datetime('now') WHERE id = ?`, [answer, req.params.qa_id])
    try {
      const asker = (await dbOne<{ asker_id: string; question: string }>('SELECT asker_id, question FROM product_qa WHERE id = ?', [req.params.qa_id]))!
      await dbRun(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`,
        [generateId('ntf'), asker.asker_id, '卖家回答了你的提问', answer.slice(0, 80) + (answer.length > 80 ? '...' : ''), null])
    } catch {}
    res.json({ success: true })
  })

  app.get('/api/products/:product_id/qa', async (req, res) => {
    // 公开列表（不需要登录，但只返回 is_public=1）
    const rows = await dbAll(`
      SELECT qa.id, qa.question, qa.answer, qa.answered_at, qa.helpful_count, qa.created_at,
             ua.name as asker_name, ua.handle as asker_handle
      FROM product_qa qa JOIN users ua ON ua.id = qa.asker_id
      WHERE qa.product_id = ? AND qa.is_public = 1
      ORDER BY qa.answered_at IS NULL ASC, qa.helpful_count DESC, qa.created_at DESC LIMIT 50
    `, [req.params.product_id])
    res.json({ items: rows })
  })

  app.post('/api/products/:product_id/qa/:qa_id/helpful', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // 防重复 — 每用户每条 QA 仅可 +1
    try {
      await dbRun(`INSERT INTO product_qa_helpful_voters (qa_id, user_id) VALUES (?, ?)`, [req.params.qa_id, user.id])
    } catch {
      const qa = await dbOne<{ helpful_count: number }>(`SELECT helpful_count FROM product_qa WHERE id = ?`, [req.params.qa_id])
      return void res.json({ success: false, already_voted: true, helpful_count: qa?.helpful_count || 0 })
    }
    await dbRun(`UPDATE product_qa SET helpful_count = COALESCE(helpful_count, 0) + 1 WHERE id = ? AND product_id = ?`,
      [req.params.qa_id, req.params.product_id])
    res.json({ success: true })
  })
}
