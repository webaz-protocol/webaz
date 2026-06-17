/**
 * Shareables 域 CRUD + 笔记 — Phase 13 (#1013)
 *
 * 11 endpoints + 1 domain constant:
 *   POST /api/notes/photo                    — 笔记图片上传（raw blob + sha256）
 *   GET  /api/notes/photo/:hash              — 笔记图片下载（永久缓存）
 *   POST /api/shareables                     — 创建（双路径：笔记 / 外链）
 *   GET  /api/shareables/me                  — 我的全部
 *   GET  /api/creator/stats                  — 创作者贡献仪表盘
 *   GET  /api/shareables/by-product/:pid     — 商品的策展引用 (top 10 by 加权)
 *   GET  /api/shareables/by-anchor/:anchor   — 锚点关联的全部
 *   GET  /api/notes                          — 公开笔记 feed (newest / trending / following)
 *   GET  /api/shareables/:id                 — 详情（公开可读）
 *   PATCH /api/shareables/:id                — 修改字段
 *   DELETE /api/shareables/:id               — 软删除（status=removed + anchor GC + photo index 清理）
 *
 * 互动（like/comment/bookmark）见 Phase 12 routes/shareables-interactions.ts。
 */
import type { Application, Request, Response, RequestHandler } from 'express'
import express from 'express'
import type Database from 'better-sqlite3'
import { writeNotePhoto, readNotePhoto, noteBlobExists, NOTE_PHOTO_MAX_BYTES, NOTE_PHOTO_ALLOWED_MIME } from '../../layer2-business/L2-notes/note-photo-storage.js'
import { retireAnchorsByTarget } from '../../layer2-business/L2-anchor-registry/anchor-registry.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export const SHAREABLE_DAILY_LIMIT = 10

export interface ShareablesDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getUser: (req: Request) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  // 中间件 — server.ts 定义（lightAuthGuard 多处共用）
  lightAuthGuard: RequestHandler
  // 共享 helpers（server.ts 多处用）
  detectExternalPlatform: (url: string) => { type: string; platform: string; video_id?: string; thumbnail?: string }
  noteAuthenticityBadges: (row: { owner_id: unknown; related_order_id: unknown; photo_hashes: unknown; created_at: unknown }) => { verified_buyer: boolean; original_photos: boolean }
  parseHashtags: (text: string) => string[]
  parseMentions: (text: string) => Array<{ handle: string; user_id: string }>
  notifyMentions: (mentions: Array<{ handle: string; user_id: string }>, fromUserId: string, kind: 'note' | 'comment', noteId: string, preview: string) => void
  flagNewAccountShareable: (shareableId: string, ownerId: string) => void
  refreshProductSharerCount: (productId: string) => void
}

export function registerShareablesRoutes(app: Application, deps: ShareablesDeps): void {
  const { db, auth, getUser, generateId, lightAuthGuard,
    detectExternalPlatform, noteAuthenticityBadges, parseHashtags, parseMentions, notifyMentions,
    flagNewAccountShareable, refreshProductSharerCount } = deps

  // Phase C2 笔记图片上传 — raw blob，sha256 重算，返回 hash + dedup
  app.post('/api/notes/photo',
    lightAuthGuard,
    express.raw({ type: 'application/octet-stream', limit: NOTE_PHOTO_MAX_BYTES }),
    (req: Request, res: Response) => {
      const user = auth(req, res); if (!user) return
      const hash = String(req.headers['x-content-hash'] || '').trim().toLowerCase()
      const mime = String(req.headers['x-content-mime'] || '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(hash)) return void res.status(400).json({ error: 'invalid_hash' })
      if (!NOTE_PHOTO_ALLOWED_MIME.has(mime)) return void res.status(415).json({ error: 'mime_not_allowed', allowed: [...NOTE_PHOTO_ALLOWED_MIME] })
      const blob = req.body as Buffer
      if (!Buffer.isBuffer(blob) || blob.length === 0) return void res.status(400).json({ error: 'empty_body' })

      try {
        const out = writeNotePhoto(blob, hash, mime)
        res.json({ success: true, hash: out.hash, dedup: out.dedup, size: out.size })
      } catch (e) {
        const msg = (e as Error).message
        const status = msg === 'photo_too_large' ? 413
          : msg === 'photo_mime_not_allowed' ? 415
          : msg === 'photo_hash_mismatch' ? 400
          : 400
        res.status(status).json({ error: msg })
      }
    }
  )

  // 笔记图片下载 — 公开（笔记 landing page 公开可读，图也得公开）
  app.get('/api/notes/photo/:hash', (req: Request, res: Response) => {
    const hash = String(req.params.hash)
    try {
      const out = readNotePhoto(hash)
      res.setHeader('Content-Type', out.mime)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')  // 内容寻址 → 永久缓存
      res.setHeader('X-Content-Hash', hash)
      res.send(out.blob)
    } catch (e) {
      const msg = (e as Error).message
      res.status(msg === 'photo_not_found' ? 404 : 400).json({ error: msg })
    }
  })

  // 创建 shareable — 双路径：笔记模式 / 外链或 native_text 模式
  app.post('/api/shareables', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const {
      external_url, title, description, native_text, related_product_id, related_anchor,
      // Phase C 笔记新增字段：
      kind, photo_hashes, related_order_id, parent_id,
    } = req.body || {}
    const isNote = kind === 'note'
    const trimUrl = (external_url || '').toString().trim()
    const trimText = (native_text || '').toString().trim()

    if (isNote) {
      // ─── 笔记模式专属校验 ───────────────────────────────────────
      if (!related_order_id) return void res.json({ error: '笔记必须关联订单（你购买过的 completed 订单）' })
      const order = await dbOne<{ id: string; buyer_id: string; seller_id: string; product_id: string; status: string }>(`SELECT id, buyer_id, seller_id, product_id, status FROM orders WHERE id = ?`, [related_order_id])
      if (!order) return void res.status(404).json({ error: '订单不存在' })
      if (order.buyer_id !== me.id) return void res.status(403).json({ error: '只能为自己买过的订单发笔记' })
      if (order.status !== 'completed') return void res.json({ error: '订单完成后才能发笔记' })
      // 每订单 1 篇原创（转发不算 — 转发用 parent_id）
      const dupOrder = await dbOne<{ id: string }>(`SELECT id FROM shareables WHERE owner_id = ? AND related_order_id = ? AND type = 'note' AND parent_id IS NULL AND status != 'removed' LIMIT 1`, [me.id, related_order_id])
      if (dupOrder && !parent_id) return void res.json({ error: '该订单已发过原创笔记', existing_id: dupOrder.id })
      if (trimText.length < 30) return void res.json({ error: '笔记正文至少 30 字' })
      if (trimText.length > 1000) return void res.json({ error: '笔记正文不能超过 1000 字' })
      if (!Array.isArray(photo_hashes) || photo_hashes.length === 0) return void res.json({ error: '笔记必须至少 1 张图' })
      if (photo_hashes.length > 9) return void res.json({ error: '最多 9 张图' })
      for (const h of photo_hashes) {
        if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return void res.json({ error: 'photo_hash 必须是 64 位 hex' })
        if (!noteBlobExists(h)) return void res.json({ error: `图片 blob 未上传：${h.slice(0, 12)}…`, missing_hash: h })
      }
      // 图 hash 跨笔记唯一（防剽窃）— 审计修 C-1
      const hashList = photo_hashes as string[]
      for (const h of hashList) {
        const existing = await dbOne<{ shareable_id: string }>(`SELECT shareable_id FROM note_photo_index WHERE hash = ?`, [h])
        if (existing && existing.shareable_id) {
          return void res.json({
            error: `图片已被其它笔记使用（疑似剽窃）：${h.slice(0, 12)}…`,
            existing_note_id: existing.shareable_id,
          })
        }
      }
      const productId = order.product_id
      // parent_id 校验（转发链）
      if (parent_id) {
        const parent = await dbOne<{ id: string; related_product_id: string }>(`SELECT id, related_product_id FROM shareables WHERE id = ? AND status != 'removed'`, [parent_id])
        if (!parent) return void res.json({ error: '原笔记不存在' })
        if (parent.related_product_id !== productId) return void res.json({ error: '转发必须基于同一商品的笔记' })
      }
      // 日上限
      const todayCount = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM shareables WHERE owner_id = ? AND created_at > datetime('now', '-1 day')`, [me.id]))!.n
      if (todayCount >= SHAREABLE_DAILY_LIMIT) return void res.json({ error: `每日上限 ${SHAREABLE_DAILY_LIMIT} 条，请明天再来` })

      const id = generateId('shr')
      const ownerCode = (await dbOne<{ permanent_code: string | null }>("SELECT permanent_code FROM users WHERE id = ?", [me.id]))?.permanent_code || null
      await dbRun(`INSERT INTO shareables
        (id, owner_id, type, native_text, title, description, related_product_id, related_order_id, parent_id, photo_hashes, owner_code)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, me.id, 'note', trimText,
             (title || null), (description || null),
             productId, related_order_id, parent_id || null,
             JSON.stringify(hashList), ownerCode])
      for (const h of hashList) {
        try { await dbRun(`INSERT OR IGNORE INTO note_photo_index (hash, shareable_id) VALUES (?,?)`, [h, id]) } catch {}
      }
      // 2026-05-22 audit P1：parseHashtags 写入 shareable_tags（话题系统）
      const tags = parseHashtags((title || '') + ' ' + trimText)
      for (const tg of tags) {
        try { await dbRun(`INSERT OR IGNORE INTO shareable_tags (shareable_id, tag) VALUES (?,?)`, [id, tg]) } catch {}
      }
      // 2026-05-22 audit P1：@ 提及 → notifications
      const mentions = parseMentions((title || '') + ' ' + trimText)
      notifyMentions(mentions, me.id as string, 'note', id, trimText.slice(0, 100))
      flagNewAccountShareable(id, me.id as string)
      refreshProductSharerCount(productId)
      return void res.json({ ok: true, id, type: 'note', owner_code: ownerCode, photo_count: hashList.length, tags, mentions: mentions.map(m => m.handle) })
    }

    // ─── 既有外链 / native_text 路径 ─────────────────────────────
    if (!trimUrl && !trimText) return void res.json({ error: '请提供外链 URL 或文字内容' })
    if (!related_product_id && !related_anchor) return void res.json({ error: '请关联商品或流量口令（至少一项）' })
    if (trimText.length > 2000) return void res.json({ error: '文字内容不能超过 2000 字' })
    if ((title || '').length > 100) return void res.json({ error: '标题不能超过 100 字' })
    if ((description || '').length > 200) return void res.json({ error: '描述不能超过 200 字' })

    const todayCount = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM shareables WHERE owner_id = ? AND created_at > datetime('now', '-1 day')`, [me.id]))!.n
    if (todayCount >= SHAREABLE_DAILY_LIMIT) return void res.json({ error: `每日上限 ${SHAREABLE_DAILY_LIMIT} 条，请明天再来` })

    if (trimUrl) {
      const dup = await dbOne<{ id: string }>(`SELECT id FROM shareables WHERE owner_id = ? AND external_url = ? AND status != 'removed' LIMIT 1`, [me.id, trimUrl])
      if (dup) return void res.json({ error: '已存在相同链接，请编辑现有条目', existing_id: dup.id })
    }

    if (related_product_id) {
      const p = await dbOne<{ id: string }>("SELECT id FROM products WHERE id = ?", [related_product_id])
      if (!p) return void res.json({ error: '关联商品不存在' })
    }

    const id = generateId('shr')
    const { type, platform, video_id, thumbnail } = trimUrl
      ? detectExternalPlatform(trimUrl)
      : { type: 'native_text', platform: 'native', video_id: undefined, thumbnail: undefined }
    const ownerCode = (await dbOne<{ permanent_code: string | null }>("SELECT permanent_code FROM users WHERE id = ?", [me.id]))?.permanent_code || null
    await dbRun(`INSERT INTO shareables (id, owner_id, type, external_url, external_platform, external_video_id, thumbnail_url, title, description, native_text, related_product_id, related_anchor, owner_code)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, me.id, type, trimUrl || null, platform, video_id || null, thumbnail || null,
           (title || null), (description || null), trimText || null,
           related_product_id || null, related_anchor || null, ownerCode])
    flagNewAccountShareable(id, me.id as string)
    if (related_product_id) refreshProductSharerCount(related_product_id as string)
    res.json({ ok: true, id, type, platform, thumbnail, owner_code: ownerCode })
  })

  app.get('/api/shareables/me', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const rows = await dbAll(`
      SELECT s.*, p.title as product_title FROM shareables s
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE s.owner_id = ? AND s.status != 'removed'
      ORDER BY s.created_at DESC LIMIT 100
    `, [me.id])
    res.json({ shareables: rows })
  })

  // 里程碑 L3：创作者贡献仪表盘
  app.get('/api/creator/stats', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const meId = me.id as string
    const shareables = await dbAll<{ id: string; related_product_id: string | null; click_count: number; unique_click_count: number; flag_new_account: number; created_at: string }>(`
      SELECT id, related_product_id, click_count, unique_click_count, flag_new_account, created_at
      FROM shareables WHERE owner_id = ? AND status != 'removed'
    `, [meId])

    const totalShares = shareables.length
    const productShares = shareables.filter(s => s.related_product_id)
    const uniqueProducts = new Set(productShares.map(s => s.related_product_id)).size
    const rawClicks = shareables.reduce((a, s) => a + (s.click_count || 0), 0)
    const uniqueClicks = shareables.reduce((a, s) => a + (s.unique_click_count || 0), 0)
    const newAccountFlagged = shareables.filter(s => s.flag_new_account).length

    const conversions = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM product_share_attribution psa
      JOIN orders o ON o.product_id = psa.product_id AND o.buyer_id = psa.recipient_id
      WHERE psa.sharer_id = ? AND o.status = 'completed' AND o.created_at >= psa.created_at
    `, [meId]))!.n

    const l1Earn = (await dbOne<{ total: number }>(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM commission_records WHERE beneficiary_id = ? AND level = 1
    `, [meId]))!.total

    // #7 按 source_type 分项 — 笔记 vs 普通分享 vs sponsor 链
    const bySource = await dbAll<{ source_type: string | null; total: number; cnt: number }>(`
      SELECT source_type, COALESCE(SUM(amount), 0) as total, COUNT(*) as cnt
      FROM commission_records WHERE beneficiary_id = ?
      GROUP BY source_type
    `, [meId])
    const sourceBreakdown = { note: 0, link: 0, sponsor: 0 }
    const sourceCntBreakdown = { note: 0, link: 0, sponsor: 0 }
    for (const r of bySource) {
      const k = (r.source_type === 'note' ? 'note' : r.source_type === 'link' ? 'link' : 'sponsor') as 'note' | 'link' | 'sponsor'
      sourceBreakdown[k] += Number(r.total) || 0
      sourceCntBreakdown[k] += Number(r.cnt) || 0
    }

    // 30 天点击趋势
    const trend30d = await dbAll<{ day: string; raw_clicks: number; unique_clicks: number }>(`
      SELECT substr(created_at, 1, 10) as day, COUNT(*) as raw_clicks, COUNT(DISTINCT ip_hash || ':' || ua_hash) as unique_clicks
      FROM shareable_click_log
      WHERE shareable_id IN (SELECT id FROM shareables WHERE owner_id = ?)
        AND created_at > datetime('now', '-30 days')
      GROUP BY day ORDER BY day ASC
    `, [meId])

    res.json({
      shares: { total: totalShares, product_count: uniqueProducts, new_account_flagged: newAccountFlagged },
      clicks: { raw: rawClicks, unique: uniqueClicks, raw_to_unique_ratio: rawClicks > 0 ? Math.round(uniqueClicks / rawClicks * 100) / 100 : null },
      conversions,
      l1_commission_total: Math.round(l1Earn * 100) / 100,
      commission_by_source: {
        note:    { total: Math.round(sourceBreakdown.note * 100) / 100,    count: sourceCntBreakdown.note },
        link:    { total: Math.round(sourceBreakdown.link * 100) / 100,    count: sourceCntBreakdown.link },
        sponsor: { total: Math.round(sourceBreakdown.sponsor * 100) / 100, count: sourceCntBreakdown.sponsor },
      },
      trend_30d: trend30d,
      ranking_contribution: {
        description: '你作为独立分享者，对相关商品的 ranking 信号有贡献（unique_sharer_count × 2 / 商品）',
        products_boosted: uniqueProducts,
        ranking_signal_value: uniqueProducts * 2,
      },
    })
  })

  // 策展引用：按 click*1 + like*3 + induced_orders*10 加权排序，取 top 10
  app.get('/api/shareables/by-product/:pid', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT * FROM (
        SELECT s.*, u.name as owner_name, u.handle as owner_handle,
          (SELECT COUNT(DISTINCT o.id) FROM orders o
            JOIN product_share_attribution psa
              ON psa.recipient_id = o.buyer_id AND psa.product_id = o.product_id
            WHERE psa.shareable_id = s.id AND o.status = 'completed') as induced_orders
        FROM shareables s
        LEFT JOIN users u ON u.id = s.owner_id
        WHERE s.related_product_id = ? AND s.status = 'active'
      ) sub
      ORDER BY (click_count * 1.0 + like_count * 3.0 + induced_orders * 10.0) DESC, created_at DESC
      LIMIT 10
    `, [req.params.pid])
    for (const r of rows) {
      r.badges = noteAuthenticityBadges(r as { owner_id: string; related_order_id: string | null; photo_hashes: string | null; created_at: string })
    }
    res.json({ shareables: rows })
  })

  app.get('/api/shareables/by-anchor/:anchor', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT s.*, u.name as owner_name FROM shareables s
      LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.related_anchor = ? AND s.status = 'active'
      ORDER BY s.created_at DESC LIMIT 50
    `, [req.params.anchor])
    res.json({ shareables: rows })
  })

  // Phase D2 笔记 list — 公开 feed，3 种 sort
  // sort=newest: created_at DESC
  // sort=trending: (likes*2 + click/10 + freshness/(age_hours+1)) DESC
  // sort=following: 需登录，仅显示 follows.followee_id 的笔记
  app.get('/api/notes', async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    const cursor = req.query.cursor ? String(req.query.cursor) : null
    const sort = String(req.query.sort || 'newest')
    const user = getUser(req)  // 不强制 auth；following 模式需要

    let where = `s.type = 'note' AND s.status = 'active'`
    const args: unknown[] = []
    if (cursor) {
      where += ` AND s.created_at < ?`
      args.push(cursor)
    }
    let orderBy = `s.created_at DESC`
    if (sort === 'trending') {
      orderBy = `(COALESCE(s.like_count,0)*2 + COALESCE(s.click_count,0)/10.0 - (julianday('now') - julianday(s.created_at))*0.5) DESC, s.created_at DESC`
    } else if (sort === 'following') {
      if (!user) return void res.status(401).json({ error: 'auth_required_for_following' })
      where += ` AND s.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)`
      args.push(user.id)
    }
    const sql = `
      SELECT s.id, s.owner_id, s.owner_code, s.title, s.native_text, s.photo_hashes,
             s.related_order_id,
             s.click_count, s.like_count, s.created_at,
             s.related_product_id, s.parent_id,
             p.title as product_title, p.price as product_price,
             u.handle as owner_handle, u.name as owner_name, u.region as owner_region
      FROM shareables s
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `
    args.push(limit + 1)
    const rows = await dbAll<Record<string, unknown>>(sql, args)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(r => {
      let photos: string[] = []
      try { photos = JSON.parse((r.photo_hashes as string) || '[]') } catch {}
      const badges = noteAuthenticityBadges(r as { owner_id: string; related_order_id: string | null; photo_hashes: string | null; created_at: string })
      return {
        id: r.id, owner_handle: r.owner_handle, owner_name: r.owner_name, owner_region: r.owner_region, owner_code: r.owner_code,
        title: r.title, body_excerpt: ((r.native_text as string) || '').slice(0, 120),
        first_photo: photos[0] || null, photo_count: photos.length,
        product: r.related_product_id ? { id: r.related_product_id, title: r.product_title, price: r.product_price } : null,
        stats: { clicks: r.click_count, likes: r.like_count },
        is_repost: !!r.parent_id,
        created_at: r.created_at,
        badges,
      }
    })
    // 审计修 D-4：trending 不用 cursor（分数排序 cursor 不可靠）
    const nextCursor = (hasMore && sort !== 'trending') ? items[items.length - 1].created_at : null
    res.json({ items, next_cursor: nextCursor, sort })
  })

  // Phase C 笔记公开读 — 任何人可读
  app.get('/api/shareables/:id', async (req, res) => {
    const id = String(req.params.id)
    const row = await dbOne<Record<string, unknown>>(`
      SELECT s.id, s.owner_id, s.owner_code, s.type, s.title, s.description, s.native_text,
             s.related_product_id, s.related_order_id, s.parent_id, s.photo_hashes,
             s.click_count, s.unique_click_count, s.like_count, s.created_at, s.status,
             u.handle as owner_handle, u.name as owner_name, u.region as owner_region
      FROM shareables s LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.id = ? AND s.status = 'active'
    `, [id])
    if (!row) return void res.status(404).json({ error: 'not_found' })
    let photos: string[] = []
    try { photos = JSON.parse((row.photo_hashes as string) || '[]') } catch {}
    let product: Record<string, unknown> | null = null
    if (row.related_product_id) {
      product = (await dbOne<Record<string, unknown>>(`SELECT id, title, price, category, images FROM products WHERE id = ?`, [row.related_product_id])) ?? null
    }
    const tags = (await dbAll<{ tag: string }>(`SELECT tag FROM shareable_tags WHERE shareable_id = ? ORDER BY id`, [id])).map(r => r.tag)
    const badges = noteAuthenticityBadges(row as { owner_id: string; related_order_id: string | null; photo_hashes: string | null; created_at: string })
    res.json({
      id: row.id, type: row.type,
      title: row.title, description: row.description, body: row.native_text,
      photo_hashes: photos,
      parent_id: row.parent_id,
      owner_id: row.owner_id,
      owner_code: row.owner_code,
      owner: { id: row.owner_id, handle: row.owner_handle, name: row.owner_name, region: row.owner_region, code: row.owner_code },
      product,
      tags,
      stats: { clicks: row.click_count, unique_clicks: row.unique_click_count, likes: row.like_count },
      created_at: row.created_at,
      badges,
    })
  })

  app.patch('/api/shareables/:id', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const row = await dbOne<{ owner_id: string }>("SELECT owner_id FROM shareables WHERE id = ?", [req.params.id])
    if (!row || row.owner_id !== me.id) return void res.json({ error: '无权操作' })
    const updates: string[] = []
    const values: unknown[] = []
    // 2026-05-22：扩展支持 native_text（笔记正文）编辑 + 长度校验
    for (const k of ['title', 'description', 'native_text', 'related_product_id', 'related_anchor']) {
      if (k in (req.body || {})) {
        let v = req.body[k]
        if (v != null && typeof v === 'string') {
          if (k === 'title') v = v.slice(0, 100)
          if (k === 'description') v = v.slice(0, 200)
          if (k === 'native_text') {
            v = v.trim()
            if (v.length > 0 && (v.length < 30 || v.length > 1000)) {
              return void res.json({ error: '正文长度需 30-1000 字' })
            }
          }
        }
        updates.push(`${k} = ?`)
        values.push(v || null)
      }
    }
    if ((req.body || {}).status === 'archived' || (req.body || {}).status === 'active') {
      updates.push('status = ?'); values.push(req.body.status)
    }
    if (updates.length === 0) return void res.json({ error: '没有可更新字段' })
    updates.push(`updated_at = datetime('now')`)
    values.push(req.params.id)
    await dbRun(`UPDATE shareables SET ${updates.join(', ')} WHERE id = ?`, values)
    res.json({ ok: true })
  })

  app.delete('/api/shareables/:id', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const row = await dbOne<{ owner_id: string; related_product_id: string | null; like_count: number; status: string; type: string }>("SELECT owner_id, related_product_id, like_count, status, type FROM shareables WHERE id = ?", [req.params.id])
    if (!row || row.owner_id !== me.id) return void res.json({ error: '无权操作' })
    if (row.status === 'removed') return void res.json({ ok: true })   // 幂等

    db.transaction(() => {
      db.prepare(`UPDATE shareables SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(req.params.id)
      // E1 anchor GC：把所有指向该 shareable 的 active anchor 设为 retired
      try { retireAnchorsByTarget(db, 'shareable', String(req.params.id)) } catch (e) { console.warn('[anchor-gc shareable]', (e as Error).message) }
      // P1 fix #2: 同步 products.total_likes（扣掉这个 shareable 的累计赞）
      if (row.related_product_id && row.like_count > 0) {
        db.prepare('UPDATE products SET total_likes = MAX(0, total_likes - ?) WHERE id = ?').run(row.like_count, row.related_product_id)
      }
      // 审计修 C-4：笔记删除时清理 photo index（释放 hash 让别人可以重用）
      if (row.type === 'note') {
        db.prepare(`DELETE FROM note_photo_index WHERE shareable_id = ?`).run(req.params.id)
      }
    })()
    // P1 fix #3: 重算 unique_sharer_count
    if (row.related_product_id) {
      try { refreshProductSharerCount(row.related_product_id) } catch (e) { console.error('[LIKE-audit refresh sharer]', e) }
    }
    res.json({ ok: true })
  })
}
