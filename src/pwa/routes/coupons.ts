/**
 * 优惠券域 (Wave A-3)
 *
 * 由 #1013 Phase 16 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST   /api/coupons              卖家发券（含 admin 全平台券）
 *   GET    /api/coupons/available    买家可用券（全平台 + 已购卖家店铺券 + 历史）
 *   GET    /api/coupons/mine         卖家发券列表
 *   PATCH  /api/coupons/:id          卖家改券（is_active / expires_at / max_uses）
 *
 * 跨域辅助：
 *   export applyCouponToOrder(db, code, sellerId, productId, totalAmount)
 *     orders 下单流程会用 — 在 server.ts 顶部 wrap 成 (code,...) => applyCouponToOrderRaw(db, code,...)
 *
 * Scope 矩阵：
 *   - 'product'  — 指定单品（scope_id = product_id，需归属 seller）
 *   - 'shop'     — 卖家全店
 *   - 'all'      — 全平台（仅 admin 可创建）
 *
 * 折扣类型：percentage（最高 90）| fixed
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface CouponsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  safeRoles: (user: Record<string, unknown> | undefined | null) => string[]
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

/** 计算 coupon 适用 + 折扣。跨域调用：orders 下单流程会用。 */
export function applyCouponToOrder(
  db: Database.Database,
  couponCode: string,
  sellerId: string,
  productId: string,
  totalAmount: number,
): { ok: boolean; coupon?: Record<string, unknown>; discount?: number; error?: string } {
  const code = couponCode.trim().toUpperCase()
  if (!code) return { ok: false, error: '空优惠码' }
  // scope='all' 平台券由 admin 创建（seller_id = admin id），不能用 product 的 seller_id 匹配
  // 先查 shop/product 范围（属于该 seller），没找到再查 'all' 全局
  let coupon = db.prepare(`SELECT * FROM coupons WHERE seller_id = ? AND code = ? AND is_active = 1 AND scope IN ('shop', 'product')`).get(sellerId, code) as Record<string, unknown> | undefined
  if (!coupon) {
    coupon = db.prepare(`SELECT * FROM coupons WHERE code = ? AND is_active = 1 AND scope = 'all' LIMIT 1`).get(code) as Record<string, unknown> | undefined
  }
  if (!coupon) return { ok: false, error: '优惠码无效或已失效' }
  const now = new Date()
  if (coupon.starts_at && new Date(coupon.starts_at as string) > now) return { ok: false, error: '优惠码未到生效时间' }
  if (coupon.expires_at && new Date(coupon.expires_at as string) < now) return { ok: false, error: '优惠码已过期' }
  const maxUses = Number(coupon.max_uses || 0)
  if (maxUses > 0 && Number(coupon.uses_count || 0) >= maxUses) return { ok: false, error: '优惠码已用完' }
  const minAmount = Number(coupon.min_order_amount || 0)
  if (totalAmount < minAmount) return { ok: false, error: `订单需满 ${minAmount} WAZ 才可用此券` }
  if (coupon.scope === 'product' && coupon.scope_id !== productId) {
    return { ok: false, error: '此优惠码不适用本商品' }
  }
  // shop / all 不需要 scope_id 检查
  let discount = 0
  if (coupon.discount_type === 'percentage') {
    discount = Math.round(totalAmount * Number(coupon.discount_value) / 100 * 100) / 100
  } else if (coupon.discount_type === 'fixed') {
    discount = Math.min(Number(coupon.discount_value), totalAmount)
  }
  return { ok: true, coupon, discount }
}

export function registerCouponsRoutes(app: Application, deps: CouponsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun);applyCouponToOrder 仍同步(订单/结算金钱路径,随 money batch 一起迁)
  const { generateId, auth, isTrustedRole, safeRoles, errorRes } = deps

  app.post('/api/coupons', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller' && !safeRoles(user).includes('seller')) {
      return void res.status(403).json({ error: '仅卖家可发券' })
    }
    const { code, scope, scope_id, discount_type, discount_value, min_order_amount, max_uses, starts_at, expires_at } = req.body || {}
    const codeStr = String(code || '').trim().toUpperCase()
    if (codeStr.length < 3 || codeStr.length > 24) return void res.status(400).json({ error: 'code 长度需 3-24（大写字母数字）' })
    if (!/^[A-Z0-9_-]+$/.test(codeStr)) return void res.status(400).json({ error: 'code 仅允许大写字母 / 数字 / _ -' })
    if (!['product', 'shop', 'all'].includes(scope)) return void res.status(400).json({ error: 'scope 须为 product / shop / all' })
    if (scope === 'product' && !scope_id) return void res.status(400).json({ error: 'product scope 需 scope_id' })
    if (!['percentage', 'fixed'].includes(discount_type)) return void res.status(400).json({ error: 'discount_type 须为 percentage / fixed' })
    const dv = Number(discount_value)
    if (!Number.isFinite(dv) || dv <= 0) return void res.status(400).json({ error: 'discount_value 须为正数' })
    if (discount_type === 'percentage' && dv > 90) return void res.status(400).json({ error: 'percentage 最高 90' })

    if (scope === 'product') {
      const p = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [scope_id])
      if (!p) return void res.status(404).json({ error: '商品不存在' })
      if (p.seller_id !== user.id) return void res.status(403).json({ error: '仅能为自己的商品发券' })
    }
    // 'all' scope 仅 admin 可创建
    if (scope === 'all' && user.role !== 'admin' && !safeRoles(user).includes('admin')) {
      return void res.status(403).json({ error: 'all-scope 优惠码仅平台可发' })
    }

    const id = generateId('cpn')
    try {
      await dbRun(`INSERT INTO coupons (id, seller_id, code, scope, scope_id, discount_type, discount_value, min_order_amount, max_uses, starts_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, user.id, codeStr, scope, scope_id || null, discount_type, dv,
             Number(min_order_amount) || 0, Number(max_uses) || 0,
             starts_at || null, expires_at || null])
    } catch {
      return void res.status(409).json({ error: '此 code 已存在（每个卖家 code 唯一）' })
    }
    res.json({ success: true, id, code: codeStr })
  })

  // buyer 视角：全平台 + 已购卖家店铺/单品券 + 历史
  app.get('/api/coupons/available', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const purchasedSellers = await dbAll<{ seller_id: string }>(`SELECT DISTINCT seller_id FROM orders WHERE buyer_id = ?`, [user.id])
    const sellerIds = purchasedSellers.map(r => r.seller_id)
    const placeholders = sellerIds.length > 0 ? sellerIds.map(() => '?').join(',') : ''
    const sellerCondition = sellerIds.length > 0 ? `OR (c.seller_id IN (${placeholders}) AND c.scope IN ('shop','product'))` : ''
    const sql = `
      SELECT c.id, c.code, c.scope, c.scope_id, c.discount_type, c.discount_value,
             c.min_order_amount, c.max_uses, c.uses_count, c.starts_at, c.expires_at,
             u.name as seller_name, u.handle as seller_handle,
             p.title as product_title
      FROM coupons c
      LEFT JOIN users u ON u.id = c.seller_id
      LEFT JOIN products p ON p.id = c.scope_id AND c.scope = 'product'
      WHERE c.is_active = 1
        AND (c.expires_at IS NULL OR c.expires_at > datetime('now'))
        AND (c.starts_at IS NULL OR c.starts_at <= datetime('now'))
        AND (c.max_uses = 0 OR c.uses_count < c.max_uses)
        AND (c.scope = 'all' ${sellerCondition})
      ORDER BY
        CASE c.scope WHEN 'product' THEN 1 WHEN 'shop' THEN 2 ELSE 3 END,
        c.expires_at ASC NULLS LAST,
        c.created_at DESC
      LIMIT 100
    `
    const rows = await dbAll(sql, sellerIds)
    const history = await dbAll(`
      SELECT o.id as order_id, o.created_at, o.coupon_discount,
             c.code, c.scope, c.discount_type, c.discount_value,
             p.title as product_title
      FROM orders o
      JOIN coupons c ON c.id = o.coupon_id
      JOIN products p ON p.id = o.product_id
      WHERE o.buyer_id = ? AND o.coupon_id IS NOT NULL
      ORDER BY o.created_at DESC LIMIT 50
    `, [user.id])
    res.json({ available: rows, history })
  })

  app.get('/api/coupons/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT * FROM coupons WHERE seller_id = ? ORDER BY created_at DESC LIMIT 100
    `, [user.id])
    res.json({ items: rows })
  })

  app.patch('/api/coupons/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const coupon = await dbOne<Record<string, unknown>>('SELECT * FROM coupons WHERE id = ? AND seller_id = ?', [req.params.id, user.id])
    if (!coupon) return void res.status(404).json({ error: '优惠码不存在或无权限' })
    const { is_active, expires_at, max_uses } = req.body || {}
    const sets: string[] = []
    const args: unknown[] = []
    if (is_active !== undefined) { sets.push('is_active = ?'); args.push(is_active ? 1 : 0) }
    if (expires_at !== undefined) { sets.push('expires_at = ?'); args.push(expires_at) }
    if (max_uses !== undefined) { sets.push('max_uses = ?'); args.push(Number(max_uses) || 0) }
    if (sets.length === 0) return void res.status(400).json({ error: '无可更新字段' })
    args.push(req.params.id)
    await dbRun(`UPDATE coupons SET ${sets.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })
}
