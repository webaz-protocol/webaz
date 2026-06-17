/**
 * P2P 商品 — 卖家节点存详情，服务端只存锚点
 *
 * 由 #1013 Phase 96 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST   /api/p2p-products       发布 / 重发（验签 + 24h 防重放 + 30/天）
 *   PATCH  /api/p2p-products/:id   更新（重发 hash 必须重签；旧 hash 在订单里保留）
 *   DELETE /api/p2p-products/:id   下架（status='warehouse'，在途订单的 hash 仍可证）
 *   GET    /api/p2p-products       公开列表（active + stock > 0 + p2p_mode = 1）
 *   GET    /api/p2p-products/:id   公开详情（含 hash + peer_endpoint，买家凭此到对端拉详情后校验）
 *
 * 安全设计：
 *   - content_hash 64 hex sha256
 *   - content_signed_at 必须 24h 内（防重放）
 *   - content_signature 用调用者 api_key 验签（防伪造）
 *   - peer_endpoint 必须 http/https
 *   - thumbnail ≤16KB base64
 *   - 每天每卖家 ≤30 个
 *
 * 跨域注入：auth + generateId + verifyP2pSig + isValidPeerEndpoint + isFreshSignedAt
 *           + P2P_TITLE_MAX/THUMB_MAX/DAILY_CAP + RFQ_MAX_PRICE/QTY
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface P2pProductsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  verifyP2pSig: (contentHash: string, signedAt: string, apiKey: string, signature: string) => boolean
  isValidPeerEndpoint: (url: string) => boolean
  isFreshSignedAt: (signedAt: string) => boolean
  P2P_TITLE_MAX: number
  P2P_THUMB_MAX: number
  P2P_DAILY_CAP: number
  RFQ_MAX_PRICE: number
  RFQ_MAX_QTY: number
}

export function registerP2pProductsRoutes(app: Application, deps: P2pProductsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, generateId, verifyP2pSig, isValidPeerEndpoint, isFreshSignedAt,
          P2P_TITLE_MAX, P2P_THUMB_MAX, P2P_DAILY_CAP, RFQ_MAX_PRICE, RFQ_MAX_QTY } = deps

  // 发布 / 重发 P2P 商品
  app.post('/api/p2p-products', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可上架' })

    const body = req.body as Record<string, unknown>
    const title = String(body.title || '').trim()
    if (title.length < 2 || title.length > P2P_TITLE_MAX) return void res.json({ error: `title 需 2-${P2P_TITLE_MAX} 字` })
    const price = Number(body.price)
    if (!Number.isFinite(price) || price <= 0) return void res.json({ error: 'price 必须 > 0' })
    if (price > RFQ_MAX_PRICE) return void res.json({ error: `price 超出上限 ${RFQ_MAX_PRICE} WAZ` })
    const stock = Math.max(1, Math.floor(Number(body.stock) || 1))
    if (stock > RFQ_MAX_QTY) return void res.json({ error: `stock 超出上限 ${RFQ_MAX_QTY}` })

    const contentHash = String(body.content_hash || '')
    if (!/^[a-f0-9]{64}$/.test(contentHash)) return void res.json({ error: 'content_hash 必须为 64 字符十六进制（sha256）' })
    const signedAt = String(body.content_signed_at || '')
    if (!signedAt) return void res.json({ error: 'content_signed_at 必填' })
    if (!isFreshSignedAt(signedAt)) return void res.json({ error: 'content_signed_at 必须在最近 24h 内（防重放）' })
    const signature = String(body.content_signature || '')
    // 用调用者 api_key 验签（防伪造）
    const apiKey = req.headers.authorization?.replace('Bearer ', '') ?? ''
    if (!verifyP2pSig(contentHash, signedAt, apiKey, signature)) return void res.json({ error: 'content_signature 签名无效' })

    const peerEndpoint = String(body.peer_endpoint || '').trim()
    if (!isValidPeerEndpoint(peerEndpoint)) return void res.json({ error: 'peer_endpoint 必须是 http:// 或 https:// 协议' })
    // peer_endpoint 可空（manifest_uri 模式留 P2 阶段扩展），但 thumbnail 必须有以供预览
    const thumbnail = body.thumbnail_uri ? String(body.thumbnail_uri) : null
    if (thumbnail && thumbnail.length > P2P_THUMB_MAX) return void res.json({ error: `thumbnail 超过 ${P2P_THUMB_MAX} 字节` })

    // 频率限制
    const today = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM products WHERE seller_id = ? AND p2p_mode = 1 AND created_at > datetime('now','-1 day')", [user.id]))!.n
    if (today >= P2P_DAILY_CAP) return void res.json({ error: `今日 P2P 上架已达上限 ${P2P_DAILY_CAP}` })

    const category = String(body.category || 'general')
    const region = String(body.region || (user.region as string) || '全国')

    const id = generateId('p')
    await dbRun(`
      INSERT INTO products (id, seller_id, title, description, price, stock, status, images, ship_regions,
        handling_hours, commission_rate, category_id, stake_amount, p2p_mode, content_hash, peer_endpoint,
        content_signature, content_signed_at)
      VALUES (?,?,?,?,?,?,'active',?,?,24,0.10,'cat_default',0,1,?,?,?,?)
    `, [
      id, user.id, title,
      `[P2P] ${title}（完整详情见卖家节点）`,
      price, stock,
      thumbnail ? JSON.stringify([thumbnail]) : '[]',
      region,
      contentHash,
      peerEndpoint || null,
      signature,
      signedAt,
    ])
    res.json({ id, content_hash: contentHash })
  })

  // 更新（重发 hash + signature，价格/库存/标题可改；旧 hash 给在途订单保留）
  app.patch('/api/p2p-products/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<Record<string, unknown>>("SELECT * FROM products WHERE id = ? AND p2p_mode = 1", [req.params.id])
    if (!product) return void res.status(404).json({ error: 'P2P 商品不存在' })
    if (product.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家本人可修改' })
    if (product.status === 'deleted') return void res.json({ error: '已删除商品不可修改' })

    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const args: unknown[] = []

    if (body.title != null) {
      const ttl = String(body.title).trim()
      if (ttl.length < 2 || ttl.length > P2P_TITLE_MAX) return void res.json({ error: 'title 长度无效' })
      updates.push('title = ?'); args.push(ttl)
    }
    if (body.price != null) {
      const p = Number(body.price)
      if (!Number.isFinite(p) || p <= 0) return void res.json({ error: 'price 无效' })
      if (p > RFQ_MAX_PRICE) return void res.json({ error: `price 超上限 ${RFQ_MAX_PRICE}` })
      updates.push('price = ?'); args.push(p)
    }
    if (body.stock != null) {
      const s = Math.max(0, Math.floor(Number(body.stock) || 0))
      updates.push('stock = ?'); args.push(s)
    }
    if (body.peer_endpoint !== undefined) {
      const ep = body.peer_endpoint ? String(body.peer_endpoint).trim() : ''
      if (ep && !isValidPeerEndpoint(ep)) return void res.json({ error: 'peer_endpoint 必须是 http:// 或 https://' })
      updates.push('peer_endpoint = ?'); args.push(ep || null)
    }
    if (body.status != null) {
      const st = String(body.status)
      if (!['active','paused','warehouse'].includes(st)) return void res.json({ error: 'status 无效（active/paused/warehouse）' })
      updates.push('status = ?'); args.push(st)
    }

    // 富内容变了 → 必须重签 hash
    if (body.content_hash != null || body.content_signature != null) {
      const newHash = String(body.content_hash || '')
      if (!/^[a-f0-9]{64}$/.test(newHash)) return void res.json({ error: 'content_hash 必须为 sha256 hex' })
      const newSignedAt = String(body.content_signed_at || '')
      if (!isFreshSignedAt(newSignedAt)) return void res.json({ error: 'content_signed_at 必须在最近 24h 内' })
      const newSig = String(body.content_signature || '')
      const apiKey = req.headers.authorization?.replace('Bearer ', '') ?? ''
      if (!verifyP2pSig(newHash, newSignedAt, apiKey, newSig)) return void res.json({ error: '新 signature 无效' })
      updates.push('content_hash = ?'); args.push(newHash)
      updates.push('content_signature = ?'); args.push(newSig)
      updates.push('content_signed_at = ?'); args.push(newSignedAt)
      // 旧 hash 自动保留在 orders.content_hash_at_order（争议时凭买家所见 hash 判定）
    }

    if (!updates.length) return void res.json({ error: '无任何修改' })
    updates.push("updated_at = datetime('now')")
    args.push(req.params.id)
    await dbRun(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })

  // 下架（保留行 + status='warehouse'，在途订单 hash 仍可证）
  app.delete('/api/p2p-products/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<{ seller_id: string; status: string }>("SELECT seller_id, status FROM products WHERE id = ? AND p2p_mode = 1", [req.params.id])
    if (!product) return void res.status(404).json({ error: 'P2P 商品不存在' })
    if (product.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家本人可下架' })
    const pendingOrders = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM orders WHERE product_id = ? AND status NOT IN ('completed','cancelled','refunded','expired')", [req.params.id]))!.n
    if (pendingOrders > 0) return void res.json({ error: `该商品有 ${pendingOrders} 个进行中订单，无法下架` })
    await dbRun("UPDATE products SET status = 'warehouse', updated_at = datetime('now') WHERE id = ?", [req.params.id])
    res.json({ success: true })
  })

  // 公开：列表
  app.get('/api/p2p-products', async (_req, res) => {
    const rows = await dbAll(`
      SELECT p.id, p.seller_id, p.title, p.price, p.stock, p.images as thumbnail_json,
        p.ship_regions as region, p.content_hash, p.peer_endpoint, p.content_signed_at,
        u.handle as seller_handle, u.region as seller_region
      FROM products p
      LEFT JOIN users u ON u.id = p.seller_id
      WHERE p.status = 'active' AND p.stock > 0 AND p.p2p_mode = 1
      ORDER BY p.created_at DESC
      LIMIT 50
    `)
    res.json({ items: rows })
  })

  // 公开：详情（含 hash + peer_endpoint）
  app.get('/api/p2p-products/:id', async (req, res) => {
    const row = await dbOne<Record<string, unknown>>(`
      SELECT p.id, p.seller_id, p.title, p.price, p.stock, p.images as thumbnail_json,
        p.ship_regions as region, p.content_hash, p.peer_endpoint, p.content_signature, p.content_signed_at,
        u.handle as seller_handle, u.region as seller_region, u.permanent_code as seller_code
      FROM products p
      LEFT JOIN users u ON u.id = p.seller_id
      WHERE p.id = ? AND p.p2p_mode = 1
    `, [req.params.id])
    if (!row) return void res.status(404).json({ error: 'P2P 商品不存在' })
    res.json({ product: row })
  })
}
