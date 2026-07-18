/**
 * Checkout 辅助 — 跨境税费预览 + 价格锁定（10 分钟 session）
 *
 * 由 #1013 Phase 109 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET  /api/checkout/tax-preview  跨境关税估算（不代收，仅心理预期）
 *   POST /api/verify-price          锁价 10min · 返回 session_token
 *
 * 跨域注入：auth + generateId + formatProductForAgent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { buildIntentMandate, signMandate } from './ap2-mandate.js'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface CheckoutHelpersDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  formatProductForAgent: (row: Record<string, unknown>) => Record<string, unknown>
  signPassport: (message: string) => Promise<string>
  issuerAddress: () => string
}

export function registerCheckoutHelpersRoutes(app: Application, deps: CheckoutHelpersDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth, generateId, formatProductForAgent, signPassport, issuerAddress } = deps

  app.get('/api/checkout/tax-preview', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const productId = String(req.query.product_id || '')
    const qtyN = Math.max(1, Math.floor(Number(req.query.quantity) || 1))
    if (!productId) return void res.status(400).json({ error: 'product_id required' })
    const product = await dbOne<{ id: string; price: number; title: string; seller_region: string | null }>(`SELECT p.id, p.price, p.title, u.region as seller_region
                                FROM products p JOIN users u ON u.id = p.seller_id
                                WHERE p.id = ?`, [productId])
    if (!product) return void res.status(404).json({ error: '商品不存在' })
    const buyerRegion = ((user as Record<string, unknown>).region as string) || 'global'
    const sellerRegion = product.seller_region || 'global'
    const isCrossBorder = buyerRegion !== sellerRegion
    if (!isCrossBorder) {
      return void res.json({
        is_cross_border: false, buyer_region: buyerRegion, seller_region: sellerRegion,
        estimated_duty_waz: 0, duty_pct: 0, threshold_waz: 0, below_threshold: true,
        disclaimer: '同地区订单，无跨境关税',
      })
    }
    const cfg = await dbOne<{ est_import_duty_pct: number; est_import_threshold_waz: number }>(`SELECT est_import_duty_pct, est_import_threshold_waz
                            FROM region_config WHERE region = ?`, [buyerRegion])
    const pct = Number(cfg?.est_import_duty_pct || 0)
    const threshold = Number(cfg?.est_import_threshold_waz || 0)
    const orderTotal = Number(product.price) * qtyN
    const belowThreshold = orderTotal < threshold
    const dutyWaz = belowThreshold ? 0 : Math.round(orderTotal * pct * 100) / 100
    res.json({
      is_cross_border: true,
      buyer_region: buyerRegion, seller_region: sellerRegion,
      order_total_waz: orderTotal,
      duty_pct: pct, threshold_waz: threshold,
      below_threshold: belowThreshold,
      estimated_duty_waz: dutyWaz,
      total_with_duty: Math.round((orderTotal + dutyWaz) * 100) / 100,
      disclaimer: pct > 0
        ? `跨境订单可能产生约 ${(pct * 100).toFixed(1)}% 关税/进口税（具体由海关认定 · 协议不代收）`
        : '跨境订单 — 协议无该地区税费数据，请咨询当地海关',
    })
  })

  app.post('/api/verify-price', async (req, res) => {
    const user = auth(req, res); if (!user) return

    const { product_id, quantity = 1 } = req.body
    if (!product_id) return void res.json({ error: '请提供 product_id' })

    const product = await dbOne<Record<string, unknown>>(`
      SELECT p.*, u.name as seller_name,
        COALESCE(rs.level, 'new') as rep_level
      FROM products p
      JOIN users u ON p.seller_id = u.id
      LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
      WHERE p.id = ?
    `, [product_id])
    if (!product) return void res.json({ error: '商品不存在' })
    // 状态门与老行为等价(非 active 一律拒),但文案分状态如实,不再把草稿说成"已下架"
    if (product.status !== 'active') {
      const msg = product.status === 'warehouse' ? '商品尚未上架' : product.status === 'paused' ? '商品暂时不可购买' : '商品已下架'
      return void res.json({ error: msg })
    }

    const qty = Number(quantity)
    if ((product.stock as number) < qty) {
      return void res.json({ error: `库存不足：当前库存 ${product.stock}，请求数量 ${qty}` })
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 10 * 60_000)
    const token = generateId('pst')

    await dbRun(`
      INSERT INTO price_sessions (token, product_id, user_id, price, quantity, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [token, product_id, user.id, product.price, qty, now.toISOString(), expiresAt.toISOString()])

    // AP2 (B.4 b) — Intent Mandate 并存输出;不破坏现有 session_token
    let ap2_intent_mandate: Record<string, unknown> | null = null
    try {
      const out = buildIntentMandate({
        issuerDid: 'did:web:webaz.xyz',
        issuerAddress: issuerAddress(),
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        principal: { role: 'user', id: user.id as string },
        productId: product_id,
        productName: typeof product.title === 'string' ? product.title : undefined,
        quantity: qty,
        maxUnitPrice: product.price as number,
        currency: 'WAZ',
        sessionToken: token,
      })
      ap2_intent_mandate = await signMandate(out, signPassport)
    } catch { /* AP2 副输出失败不阻断主流程 */ }

    res.json({
      session_token: token,
      verified_price: product.price,
      quantity: qty,
      total: (product.price as number) * qty,
      product: formatProductForAgent(product),
      expires_at: expiresAt.toISOString(),
      expires_in_seconds: 600,
      note: '此价格在10分钟内有效。下单时传入 session_token 可保证此价格不变。',
      ap2_intent_mandate,
    })
  })
}
