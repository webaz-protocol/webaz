/**
 * 购物车 (P13 + C-1) 域
 *
 * 由 #1013 Phase 29 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET    /api/cart                    我的购物车（含 product + seller 关联）
 *   POST   /api/cart                    加 / 增量（INSERT OR UPDATE，上限 99）
 *   PATCH  /api/cart/:product_id        改数量
 *   POST   /api/cart/checkout           批量下单（每个选中商品独立订单 + 库存原子扣 + escrow 锁）
 *   DELETE /api/cart/:product_id        移除单品
 *
 * 边界：
 *   - 受信角色 → 403 TRUSTED_ROLE_NO_TRADE
 *   - 仅 role=buyer 可 checkout
 *   - has_variants 商品需在详情页选规格（checkout 跳过）
 *   - 库存不足 / 卖家本人 / 已下架 → 加入 skipped
 *   - STOCK_RACE 单品级回滚 → 整 txn 失败 409
 *
 * 跨域：
 *   - transition / notifyTransition（state-machine + L2-6）
 *   - checkStockAndMaybeDelist / addHours / broadcastSystemEvent / isTrustedRole / errorRes（server.ts 注入）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { CartCheckoutError, checkoutSelectedCart } from '../../cart-checkout.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface CartDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void
  checkStockAndMaybeDelist: (productId: string) => void
  addHours: (date: Date, hours: number) => string
}

export function registerCartRoutes(app: Application, deps: CartDeps): void {
  const { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent, checkStockAndMaybeDelist, addHours } = deps

  app.get('/api/cart', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const items = await dbAll(`
      SELECT c.product_id, c.qty, c.added_at,
        p.title, p.price, p.category, p.commission_rate, p.stock, p.status as product_status,
        u.name as seller_name
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      JOIN users u ON u.id = p.seller_id
      WHERE c.user_id = ?
      ORDER BY c.added_at DESC
    `, [user.id])
    res.json({ items })
  })

  app.post('/api/cart', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { product_id, qty } = req.body
    const q = Math.max(1, Math.min(99, Number(qty) || 1))
    if (!product_id) return void res.json({ error: 'product_id 必填' })
    const product = await dbOne<{ id: string; status: string }>("SELECT id, status FROM products WHERE id = ?", [product_id])
    if (!product) return void res.json({ error: '商品不存在' })
    if (product.status !== 'active') return void res.json({ error: '商品已下架' })
    await dbRun(`
      INSERT INTO cart_items (user_id, product_id, qty) VALUES (?, ?, ?)
      ON CONFLICT(user_id, product_id) DO UPDATE SET qty = MIN(99, cart_items.qty + ?)
    `, [user.id, product_id, q, q])
    res.json({ ok: true })
  })

  app.patch('/api/cart/:product_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const q = Math.max(1, Math.min(99, Number(req.body.qty) || 1))
    const r = await dbRun("UPDATE cart_items SET qty = ? WHERE user_id = ? AND product_id = ?", [q, user.id, req.params.product_id])
    if (r.changes === 0) return void res.json({ error: '购物车中没有此商品' })
    res.json({ ok: true, qty: q })
  })

  // C-1: 购物车批量下单（每个选中商品独立订单）
  app.post('/api/cart/checkout', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    if (user.role !== 'buyer') return void res.status(403).json({ error: '仅买家可下单' })
    const agentApiKey = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    if (typeof req.body?.api_key === 'string' && !agentApiKey) return void res.status(401).json({ error: '下单必须使用 Authorization: Bearer <api_key>', error_code: 'AUTH_HEADER_REQUIRED' })
    const { shipping_address, notes, product_ids } = req.body || {}
    if (!shipping_address) return void res.status(400).json({ error: '请填写收货地址' })

    let checkoutResult
    try {
      checkoutResult = checkoutSelectedCart({
        db,
        buyerId: String(user.id),
        selectedIds: product_ids,
        shippingAddress: shipping_address,
        notes,
        generateId,
        checkStockAndMaybeDelist,
        addHours,
        agentApiKey,
      })
    } catch (e) {
      if (e instanceof CartCheckoutError) {
        return void res.status(e.status).json({ error: e.message, ...(e.errorCode ? { error_code: e.errorCode } : {}), ...(e.skipped ? { skipped: e.skipped } : {}), ...(e.details || {}) })
      }
      console.error('[POST /cart/checkout]', e instanceof Error ? e.message : String(e))
      return void res.status(500).json({ error: '下单失败，请重试' })
    }

    const { created, skipped, totalNeed } = checkoutResult
    try { broadcastSystemEvent('cart_checkout', '🧺', `购物车批量下单 ${created.length} 单 · 总 ${totalNeed.toFixed(2)} WAZ`, String(user.id)) } catch {}

    res.json({
      success: true,
      orders_created: created.length,
      orders: created,
      skipped,
      total_paid: created.reduce((s, c) => s + c.total, 0),
    })
  })

  app.delete('/api/cart/:product_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    await dbRun("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?", [user.id, req.params.product_id])
    res.json({ ok: true })
  })
}
