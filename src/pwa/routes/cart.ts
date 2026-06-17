/**
 * 购物车 (P13 + C-1) 域
 *
 * 由 #1013 Phase 29 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET    /api/cart                    我的购物车（含 product + seller 关联）
 *   POST   /api/cart                    加 / 增量（INSERT OR UPDATE，上限 99）
 *   PATCH  /api/cart/:product_id        改数量
 *   POST   /api/cart/checkout           批量下单（按 seller 自动分订单 + 库存原子扣 + escrow 锁）
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
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { notifyTransition } from '../../layer2-business/L2-6-notifications/notification-engine.js'
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

  // C-1: 购物车批量下单（按 seller 自动分订单）
  app.post('/api/cart/checkout', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    if (user.role !== 'buyer') return void res.status(403).json({ error: '仅买家可下单' })
    const { shipping_address, notes } = req.body || {}
    if (!shipping_address) return void res.status(400).json({ error: '请填写收货地址' })

    const items = await dbAll<{ product_id: string; qty: number; title: string; price: number; stock: number; seller_id: string; has_variants: number; status: string }>(`
      SELECT c.product_id, c.qty, p.title, p.price, p.stock, p.seller_id, p.has_variants, p.status
      FROM cart_items c JOIN products p ON p.id = c.product_id
      WHERE c.user_id = ?
    `, [user.id])
    if (items.length === 0) return void res.status(400).json({ error: '购物车为空' })

    const skipped: Array<{ product_id: string; reason: string }> = []
    const created: Array<{ order_id: string; product_id: string; total: number }> = []
    let totalNeed = 0

    const ok: typeof items = []
    for (const it of items) {
      if (it.status !== 'active') { skipped.push({ product_id: it.product_id, reason: '商品已下架' }); continue }
      if (it.has_variants) { skipped.push({ product_id: it.product_id, reason: '需在商品详情页选规格下单' }); continue }
      if (it.stock < it.qty) { skipped.push({ product_id: it.product_id, reason: `库存不足（${it.stock} < ${it.qty}）` }); continue }
      if (it.seller_id === user.id) { skipped.push({ product_id: it.product_id, reason: '不可购买自己的商品' }); continue }
      ok.push(it)
      totalNeed += Number(it.price) * Number(it.qty)
    }

    if (ok.length === 0) {
      return void res.status(400).json({ error: '购物车中无可下单商品', skipped })
    }

    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet) return void res.status(500).json({ error: '钱包记录缺失' })
    if (wallet.balance < totalNeed) return void res.status(400).json({ error: `余额不足：需 ${totalNeed.toFixed(2)} WAZ，当前 ${wallet.balance.toFixed(2)}` })

    try {
      db.transaction(() => {
        const now = new Date()
        for (const it of ok) {
          const total = Number(it.price) * Number(it.qty)
          const orderId = generateId('ord')
          db.prepare(`INSERT INTO orders (
            id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
            status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
            pickup_deadline, delivery_deadline, confirm_deadline, source
          ) VALUES (?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?, 'cart_batch')`).run(
            orderId, it.product_id, user.id, it.seller_id, it.qty, it.price, total, total,
            shipping_address, notes || `[批量下单]`,
            addHours(now, 24), addHours(now, 48), addHours(now, 120),
            addHours(now, 168), addHours(now, 336), addHours(now, 408),
          )
          db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?').run(total, total, user.id)
          // 扣库存（原子）
          const upd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(it.qty, it.product_id, it.qty)
          if (upd.changes !== 1) throw new Error(`STOCK_RACE:${it.product_id}`)
          checkStockAndMaybeDelist(it.product_id)
          transition(db, orderId, 'paid', user.id as string, [], '购物车批量支付')
          notifyTransition(db, orderId, 'created', 'paid')
          created.push({ order_id: orderId, product_id: it.product_id, total })
        }
        // 清空已下单的 cart items
        const okIds = ok.map(i => i.product_id)
        const ph = okIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM cart_items WHERE user_id = ? AND product_id IN (${ph})`).run(user.id, ...okIds)
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg.startsWith('STOCK_RACE:')) {
        return void res.status(409).json({ error: '库存已被抢光，请重试', error_code: 'STOCK_DEPLETED' })
      }
      console.error('[POST /cart/checkout]', msg)
      return void res.status(500).json({ error: '下单失败，请重试' })
    }

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
