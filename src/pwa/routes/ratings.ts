/**
 * 买家评价 / 评分域 (Wave C-3)
 *
 * 由 #1013 Phase 20 从 src/pwa/server.ts 抽出。
 *
 * 8 endpoints:
 *   POST  /api/orders/:order_id/rating              buyer 给 seller 评（一单一评）
 *   POST  /api/orders/:order_id/buyer-rating        seller 给 buyer 反向评
 *   GET   /api/orders/:order_id/rating              查 buyer→seller 评（双盲遮蔽）
 *   GET   /api/orders/:order_id/buyer-rating        查 seller→buyer 评（双盲遮蔽）
 *   POST  /api/orders/:order_id/rating/reply        seller 回复（每条一次）
 *   POST  /api/orders/:order_id/rating/followup     buyer 追问（每条一次，要 seller 已 reply）
 *   GET   /api/products/:product_id/ratings         公开：商品评价 + 聚合（双盲已揭晓）
 *   GET   /api/sellers/:seller_id/ratings           公开：卖家评价聚合
 *
 * 双盲规则（L2-5 / RATING_BLIND_DAYS=14）：
 *   - 评价隐藏直到 双方都评 OR 14 天到期
 *   - 一单一评 + 一回一追问（reply 1 次 / followup 1 次）
 *   - L2-5 反哺 reputation_events（recordRatingReputation）
 *
 * 跨域：
 *   - recordRatingReputation 从 layer 2 import（在 server.ts 顶部已有，本模块也 import）
 *   - broadcastSystemEvent 在 server.ts 内（注入到 deps，buyer→seller 评价时广播）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { recordRatingReputation } from '../../layer4-economics/L4-3-reputation/reputation-engine.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const RATING_BLIND_DAYS = 14

function parseDim(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
}

export interface RatingsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void
}

export function registerRatingsRoutes(app: Application, deps: RatingsDeps): void {
  const { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent } = deps

  // buyer → seller 评价（一单一评，仅 completed 订单可评）
  app.post('/api/orders/:order_id/rating', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const order = await dbOne<{ id: string; buyer_id: string; seller_id: string; product_id: string; status: string; settled_fault_at: string | null }>('SELECT id, buyer_id, seller_id, product_id, status, settled_fault_at FROM orders WHERE id = ?', [req.params.order_id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家可评价' })
    if (order.status !== 'completed') return void res.status(400).json({ error: '订单完成后才能评价' })
    // completed 被重载:判责/无责拒单/退货收口等处置也终于 completed(settled_fault_at 非空)——
    // 无真实成交,不产生可评价对象(镜像 genuineSalePredicate 语义;否则违约关单可刷评价进声誉)。
    if (order.settled_fault_at) return void res.status(400).json({ error: '该订单为处置关单(非正常成交),不可评价' })
    const existing = await dbOne('SELECT order_id FROM order_ratings WHERE order_id = ?', [order.id])
    if (existing) return void res.status(400).json({ error: '已评价过，每单仅可评一次' })
    const stars = Number(req.body?.stars)
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return void res.status(400).json({ error: '评分需在 1-5 之间' })
    const comment = req.body?.comment ? String(req.body.comment).slice(0, 1000) : null
    const dimQuality = parseDim(req.body?.dim_quality)
    const dimSpeed   = parseDim(req.body?.dim_speed)
    const dimService = parseDim(req.body?.dim_service)
    const hiddenUntil = new Date(Date.now() + RATING_BLIND_DAYS * 24 * 3600 * 1000).toISOString()
    db.transaction(() => {
      db.prepare(`INSERT INTO order_ratings (order_id, buyer_id, seller_id, product_id, stars, comment, dim_quality, dim_speed, dim_service, hidden_until)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(order.id, order.buyer_id, order.seller_id, order.product_id, stars, comment, dimQuality, dimSpeed, dimService, hiddenUntil)
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
          .run(generateId('ntf'), order.seller_id, `⭐ 收到 ${stars} 星评价`, comment ? String(comment).slice(0, 100) : '买家未留言', order.id)
      } catch {}
      // L2-5 反哺声誉
      try { recordRatingReputation(db, { orderId: order.id, revieweeId: order.seller_id, revieweeRole: 'seller', stars }) }
      catch (e) { console.warn('[rating→rep] seller delta failed:', (e as Error).message) }
    })()
    try { broadcastSystemEvent('rating', '⭐', `${stars} 星评价 (订单 ${order.id})`, order.id) } catch {}
    res.json({ success: true })
  })

  // seller → buyer 反向评价
  app.post('/api/orders/:order_id/buyer-rating', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<{ id: string; buyer_id: string; seller_id: string; status: string }>('SELECT id, buyer_id, seller_id, status FROM orders WHERE id = ?', [req.params.order_id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可评价买家' })
    if (order.status !== 'completed') return void res.status(400).json({ error: '订单完成后才能评价' })
    const existing = await dbOne('SELECT order_id FROM buyer_ratings WHERE order_id = ?', [order.id])
    if (existing) return void res.status(400).json({ error: '已评价过，每单仅可评一次' })
    const stars = Number(req.body?.stars)
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return void res.status(400).json({ error: '评分需在 1-5 之间' })
    const comment = req.body?.comment ? String(req.body.comment).slice(0, 1000) : null
    const dimPay = parseDim(req.body?.dim_payment_speed)
    const dimCom = parseDim(req.body?.dim_communication)
    const dimRsp = parseDim(req.body?.dim_responsiveness)
    const hiddenUntil = new Date(Date.now() + RATING_BLIND_DAYS * 24 * 3600 * 1000).toISOString()
    db.transaction(() => {
      db.prepare(`INSERT INTO buyer_ratings (order_id, seller_id, buyer_id, stars, comment, dim_payment_speed, dim_communication, dim_responsiveness, hidden_until)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(order.id, order.seller_id, order.buyer_id, stars, comment, dimPay, dimCom, dimRsp, hiddenUntil)
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
          .run(generateId('ntf'), order.buyer_id, `⭐ 卖家给你 ${stars} 星评价`, comment ? String(comment).slice(0, 100) : '卖家未留言', order.id)
      } catch {}
      try { recordRatingReputation(db, { orderId: order.id, revieweeId: order.buyer_id, revieweeRole: 'buyer', stars }) }
      catch (e) { console.warn('[buyer-rating→rep] delta failed:', (e as Error).message) }
    })()
    res.json({ success: true })
  })

  // 查 seller → buyer 评价（双盲遮蔽：buyer 看不到，除非自己也评过 OR 窗口到期）
  app.get('/api/orders/:order_id/buyer-rating', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<{ buyer_id: string; seller_id: string }>('SELECT buyer_id, seller_id FROM orders WHERE id = ?', [req.params.order_id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.buyer_id !== user.id && order.seller_id !== user.id) {
      return void res.status(403).json({ error: '无权查看' })
    }
    const br = await dbOne<Record<string, unknown>>(`SELECT stars, comment, dim_payment_speed, dim_communication, dim_responsiveness, hidden_until, created_at FROM buyer_ratings WHERE order_id = ?`, [req.params.order_id])
    if (!br) return void res.json({ item: null })
    const isBuyerView = order.buyer_id === user.id
    const buyerAlsoRated = !!(await dbOne(`SELECT order_id FROM order_ratings WHERE order_id = ?`, [req.params.order_id]))
    const blindExpired = br.hidden_until && new Date(br.hidden_until as string) < new Date()
    if (isBuyerView && !buyerAlsoRated && !blindExpired) {
      return void res.json({ item: { masked: true, hidden_until: br.hidden_until, reason: 'blind_until_both_or_expire' } })
    }
    res.json({ item: br })
  })

  // 查 buyer → seller 评价（双盲遮蔽：seller 视角同样）
  app.get('/api/orders/:order_id/rating', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<{ buyer_id: string; seller_id: string }>('SELECT buyer_id, seller_id FROM orders WHERE id = ?', [req.params.order_id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.buyer_id !== user.id && order.seller_id !== user.id) {
      return void res.status(403).json({ error: '无权查看' })
    }
    const r = await dbOne<Record<string, unknown>>('SELECT stars, comment, reply, replied_at, buyer_followup, buyer_followup_at, dim_quality, dim_speed, dim_service, hidden_until, created_at FROM order_ratings WHERE order_id = ?', [req.params.order_id])
    if (!r) return void res.json({ item: null })
    const isSellerView = order.seller_id === user.id
    const sellerAlsoRated = !!(await dbOne(`SELECT order_id FROM buyer_ratings WHERE order_id = ?`, [req.params.order_id]))
    const blindExpired = r.hidden_until && new Date(r.hidden_until as string) < new Date()
    if (isSellerView && !sellerAlsoRated && !blindExpired) {
      return void res.json({ item: { masked: true, hidden_until: r.hidden_until, reason: 'blind_until_both_or_expire' } })
    }
    res.json({ item: r })
  })

  app.post('/api/orders/:order_id/rating/reply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbOne<{ seller_id: string; reply: string | null; hidden_until: string | null }>('SELECT seller_id, reply, hidden_until FROM order_ratings WHERE order_id = ?', [req.params.order_id])
    if (!r) return void res.status(404).json({ error: '该订单暂无评价' })
    if (r.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可回复' })
    // 双盲铁律:未揭晓前不能回复(回复=已读到评价)。揭晓条件 = 自己也评过买家 OR 盲评期已过。
    const sellerAlsoRated = !!(await dbOne(`SELECT order_id FROM buyer_ratings WHERE order_id = ?`, [req.params.order_id]))
    const blindExpired = !!r.hidden_until && new Date(r.hidden_until) < new Date()
    if (!sellerAlsoRated && !blindExpired) {
      return void res.status(403).json({ error: '双盲期未结束:请先评价买家，或等盲评期满后再回应', error_code: 'RATING_STILL_BLIND' })
    }
    if (r.reply) return void res.status(400).json({ error: '已回复过，每条评价仅可回复一次' })
    const reply = req.body?.reply ? String(req.body.reply).slice(0, 500) : null
    if (!reply) return void res.status(400).json({ error: '回复不能为空' })
    await dbRun(`UPDATE order_ratings SET reply = ?, replied_at = datetime('now') WHERE order_id = ?`, [reply, req.params.order_id])
    res.json({ success: true })
  })

  // W3 买家追问 — 在卖家 reply 后可追问一次
  app.post('/api/orders/:order_id/rating/followup', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbOne<{ buyer_id: string; reply: string | null; buyer_followup: string | null }>('SELECT buyer_id, reply, buyer_followup FROM order_ratings WHERE order_id = ?', [req.params.order_id])
    if (!r) return void res.status(404).json({ error: '该订单暂无评价' })
    if (r.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家可追问' })
    if (!r.reply) return void res.status(400).json({ error: '卖家尚未回复，无法追问' })
    if (r.buyer_followup) return void res.status(400).json({ error: '已追问过一次（每条评价最多一次追问）' })
    const followup = req.body?.followup ? String(req.body.followup).trim().slice(0, 200) : ''
    if (followup.length < 2) return void res.status(400).json({ error: '追问内容至少 2 字' })
    await dbRun(`UPDATE order_ratings SET buyer_followup = ?, buyer_followup_at = datetime('now') WHERE order_id = ?`,
      [followup, req.params.order_id])
    res.json({ success: true })
  })

  // 公开：商品评价 + 聚合（仅展示双盲已揭晓的）
  app.get('/api/products/:product_id/ratings', async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    const blindOpen = `(EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id) OR r.hidden_until IS NULL OR datetime(r.hidden_until) <= datetime('now'))`
    const rows = await dbAll(`
      SELECT r.stars, r.comment, r.reply, r.replied_at, r.buyer_followup, r.buyer_followup_at, r.created_at,
             r.dim_quality, r.dim_speed, r.dim_service,
             u.name as buyer_name, u.handle as buyer_handle
      FROM order_ratings r
      JOIN users u ON u.id = r.buyer_id
      WHERE r.product_id = ? AND ${blindOpen}
      ORDER BY r.created_at DESC LIMIT ?
    `, [req.params.product_id, limit])
    const agg = await dbOne(`
      SELECT COUNT(*) as cnt, COALESCE(AVG(stars), 0) as avg_stars,
        SUM(CASE WHEN stars = 5 THEN 1 ELSE 0 END) as s5,
        SUM(CASE WHEN stars = 4 THEN 1 ELSE 0 END) as s4,
        SUM(CASE WHEN stars = 3 THEN 1 ELSE 0 END) as s3,
        SUM(CASE WHEN stars = 2 THEN 1 ELSE 0 END) as s2,
        SUM(CASE WHEN stars = 1 THEN 1 ELSE 0 END) as s1
      FROM order_ratings r WHERE product_id = ? AND ${blindOpen}
    `, [req.params.product_id])
    res.json({ items: rows, agg })
  })

  // 卖家:自己店铺收到的全部评价(含 order_id 便于逐条回复 + 回复/追问状态)。
  // 与公开聚合 endpoint 分开:authed + 只返回本人的评价 + 暴露 order_id(仅给卖家本人)。
  // 纯只读,不改任何评价 / 资金逻辑;回复仍走既有 POST /orders/:order_id/rating/reply。
  // ⚠️ 必须注册在 /api/sellers/:seller_id/ratings 【之前】,否则 'me' 会被 :seller_id 参数路由抢匹配。
  app.get('/api/sellers/me/ratings', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    // 双盲铁律:卖家看 buyer→seller 评价,必须【自己也评过买家】(buyer_ratings 存在) 或【盲评期已过】(hidden_until 到期)。
    // 否则只返回遮蔽行(不含 stars/comment/reply),与 GET /orders/:id/rating 的揭晓条件一致 —— 防卖家看了买家评价再反向报复。
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT r.order_id, r.stars, r.comment, r.reply, r.replied_at, r.buyer_followup, r.buyer_followup_at, r.created_at, r.product_id, r.hidden_until,
             p.title as product_title,
             u.name as buyer_name, u.handle as buyer_handle,
             (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id) AS seller_also_rated
      FROM order_ratings r
      JOIN products p ON p.id = r.product_id
      JOIN users u ON u.id = r.buyer_id
      WHERE r.seller_id = ?
      ORDER BY r.created_at DESC LIMIT ?
    `, [user.id, limit])
    const now = Date.now()
    let unreplied = 0
    const items = rows.map(r => {
      const blindExpired = !!r.hidden_until && new Date(r.hidden_until as string).getTime() < now
      const revealed = !!r.seller_also_rated || blindExpired
      if (!revealed) {
        // 遮蔽:只回最小信息(有评价 + 商品 + 解除条件),绝不泄露分数/评论/回复
        return { order_id: r.order_id, product_title: r.product_title, created_at: r.created_at, hidden_until: r.hidden_until, masked: true, reveal_reason: 'blind_until_both_or_expire' }
      }
      if (!r.reply) unreplied++
      return {
        order_id: r.order_id, stars: r.stars, comment: r.comment, reply: r.reply, replied_at: r.replied_at,
        buyer_followup: r.buyer_followup, buyer_followup_at: r.buyer_followup_at, created_at: r.created_at,
        product_id: r.product_id, product_title: r.product_title, buyer_name: r.buyer_name, buyer_handle: r.buyer_handle,
        masked: false,
      }
    })
    // 聚合双盲铁律:cnt / avg_stars 必须【只算已揭晓评价】,否则盲评期内卖家能从均分反推买家未揭晓评分。
    // 与公开面同 blindOpen 条件;另回 masked_count(只告知"有多少条遮蔽中",不含分数)。
    const blindOpen = `(EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id) OR r.hidden_until IS NULL OR datetime(r.hidden_until) <= datetime('now'))`
    const agg = await dbOne<{ cnt: number; avg_stars: number; masked_count: number }>(`
      SELECT
        SUM(CASE WHEN ${blindOpen} THEN 1 ELSE 0 END) as cnt,
        COALESCE(AVG(CASE WHEN ${blindOpen} THEN stars END), 0) as avg_stars,
        SUM(CASE WHEN ${blindOpen} THEN 0 ELSE 1 END) as masked_count
      FROM order_ratings r WHERE r.seller_id = ?`, [user.id])
    res.json({ items, agg: { ...(agg || {}), unreplied } })
  })

  // 公开：卖家评价聚合（卖家主页）。注册在 /me 之后(见上面注释)。
  app.get('/api/sellers/:seller_id/ratings', async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    // 双盲铁律(公开面):只展示已揭晓的评价 —— 与 GET /products/:id/ratings 同条件。
    // 揭晓 = 双方都评过(buyer_ratings 存在) OR 无盲评窗口(hidden_until 空) OR 盲评期已过。
    const blindOpen = `(EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id) OR r.hidden_until IS NULL OR datetime(r.hidden_until) <= datetime('now'))`
    const rows = await dbAll(`
      SELECT r.stars, r.comment, r.reply, r.replied_at, r.buyer_followup, r.buyer_followup_at, r.created_at, r.product_id,
             p.title as product_title,
             u.name as buyer_name, u.handle as buyer_handle
      FROM order_ratings r
      JOIN products p ON p.id = r.product_id
      JOIN users u ON u.id = r.buyer_id
      WHERE r.seller_id = ? AND ${blindOpen}
      ORDER BY r.created_at DESC LIMIT ?
    `, [req.params.seller_id, limit])
    const agg = await dbOne(`SELECT COUNT(*) as cnt, COALESCE(AVG(stars), 0) as avg_stars FROM order_ratings r WHERE r.seller_id = ? AND ${blindOpen}`, [req.params.seller_id])
    res.json({ items: rows, agg })
  })
}
