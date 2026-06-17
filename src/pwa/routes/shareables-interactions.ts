/**
 * Shareables 互动域 — click / like / comments / bookmark
 *
 * 由 #1013 Phase 12 从 src/pwa/server.ts 抽出。
 * shareables CRUD (POST / GET-me / by-product / by-anchor / detail / PATCH / DELETE /
 * notes-photo / notes-feed / creator-stats) 留下次 phase
 * （共享 helpers: detectExternalPlatform / SHAREABLE_DAILY_LIMIT /
 * noteAuthenticityBadges / parseHashtags / NOTE_PHOTO 系列）
 *
 * 8 endpoints:
 *   POST /api/shareables/:id/click           — 点击计数（无 auth）
 *   POST /api/shareables/:id/like            — toggle 点赞（含 Sybil 门槛 + 通知 owner）
 *   GET  /api/shareables/:id/comments        — 楼中楼 1 层（root + replies）
 *   POST /api/shareables/:id/comments        — 发评论（blocklist + PII + LLM 三层审核 + @ 提及）
 *   GET  /api/shareables/:id/like-status     — 我是否点赞过 + 总数
 *   POST /api/shareables/:id/bookmark        — toggle 收藏
 *   GET  /api/shareables/:id/bookmark-status — 我是否收藏过
 *   GET  /api/users/:id/bookmarked-shareables — 我收藏的列表（仅 owner 自见）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // 真实成交单一真相源

export interface ShareablesInteractionsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
  // 跨域审核 helpers（server.ts 多处用）
  piiSanitize: (text: string) => string
  detectFraud: (text: string) => string[]
  commentBlocklistHit: (text: string) => string | null
  llmModerateComment: (text: string) => Promise<{ ok: boolean; reason?: string }>
  // @ 提及解析与通知（server.ts 定义，因 POST /api/shareables 也用）
  parseMentions: (text: string) => Array<{ handle: string; user_id: string }>
  notifyMentions: (mentions: Array<{ handle: string; user_id: string }>, fromUserId: string, kind: 'note' | 'comment', noteId: string, preview: string) => void
}

export function registerShareablesInteractionsRoutes(app: Application, deps: ShareablesInteractionsDeps): void {
  const { db, auth, generateId, rateLimitOk, piiSanitize, detectFraud, commentBlocklistHit, llmModerateComment, parseMentions, notifyMentions } = deps

  app.post('/api/shareables/:id/click', async (req, res) => {
    // 点击计数（不要求 auth — 任何人点击外链都计数）
    await dbRun("UPDATE shareables SET click_count = click_count + 1 WHERE id = ? AND status = 'active'", [req.params.id])
    res.json({ ok: true })
  })

  // LIKE 系统：toggle 点赞（每用户对每 shareable 一票；不能给自己点）
  app.post('/api/shareables/:id/like', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(`like:${user.id}`, 60, 60_000)) return void res.status(429).json({ error: '点赞过于频繁' })
    const sh = await dbOne<{ id: string; owner_id: string; related_product_id: string | null; status: string }>("SELECT id, owner_id, related_product_id, status FROM shareables WHERE id = ?", [req.params.id])
    if (!sh) return void res.status(404).json({ error: 'shareable 不存在' })
    if (sh.status !== 'active') return void res.json({ error: 'shareable 已下架' })
    if (sh.owner_id === user.id) return void res.json({ error: '不能给自己点赞' })
    // P1 Sybil 软门槛：至少完成过 1 笔订单（不限购买该商品，只需活跃用户）
    const completed = (await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [user.id]))!.n  // 真实成交,排除退款/违约
    if (completed < 1) return void res.json({ error: '完成首笔购买后才能点赞（防止刷赞）' })

    // P0 fix：SELECT existing 进 transaction
    let liked = false
    db.transaction(() => {
      const existing = db.prepare('SELECT id FROM shareable_likes WHERE shareable_id = ? AND user_id = ?').get(req.params.id, user.id) as { id: string } | undefined
      if (existing) {
        db.prepare('DELETE FROM shareable_likes WHERE id = ?').run(existing.id)
        db.prepare('UPDATE shareables SET like_count = MAX(0, like_count - 1) WHERE id = ?').run(req.params.id)
        if (sh.related_product_id) db.prepare('UPDATE products SET total_likes = MAX(0, total_likes - 1) WHERE id = ?').run(sh.related_product_id)
        liked = false
      } else {
        db.prepare('INSERT INTO shareable_likes (id, shareable_id, user_id) VALUES (?,?,?)').run(generateId('lk'), req.params.id, user.id)
        db.prepare('UPDATE shareables SET like_count = like_count + 1 WHERE id = ?').run(req.params.id)
        if (sh.related_product_id) db.prepare('UPDATE products SET total_likes = total_likes + 1 WHERE id = ?').run(sh.related_product_id)
        liked = true
      }
    })()

    const newCount = (await dbOne<{ like_count: number }>('SELECT like_count FROM shareables WHERE id = ?', [req.params.id]))!.like_count
    // 通知 owner（仅新增点赞，避免取消时打扰）
    if (liked) {
      try {
        await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                    VALUES (?,?,'shareable_like',?,?,datetime('now'))`,
          [generateId('ntf'), sh.owner_id, `❤️ 收到点赞`, `分享 #${req.params.id.slice(-8)} 被点赞（累计 ${newCount}）`])
      } catch {}
    }
    res.json({ liked, like_count: newCount })
  })

  // W6 笔记评论 — 楼中楼 1 层（root + replies）
  app.get('/api/shareables/:id/comments', async (req, res) => {
    const sh = await dbOne<{ id: string }>(`SELECT id FROM shareables WHERE id = ?`, [req.params.id])
    if (!sh) return void res.status(404).json({ error: 'shareable 不存在' })
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50))
    const sort = String(req.query.sort || 'newest')
    const orderBy = sort === 'top' ? 'c.likes DESC, c.created_at DESC' : 'c.created_at DESC'
    const roots = await dbAll<Record<string, unknown>>(`
      SELECT c.*, u.handle, u.name, u.role
      FROM shareable_comments c LEFT JOIN users u ON u.id = c.commenter_id
      WHERE c.shareable_id = ? AND c.parent_id IS NULL AND c.flagged = 0
      ORDER BY ${orderBy} LIMIT ?
    `, [sh.id, limit])
    const rootIds = roots.map(r => r.id as string)
    const replies = rootIds.length > 0 ? await dbAll<Record<string, unknown>>(`
      SELECT c.*, u.handle, u.name, u.role
      FROM shareable_comments c LEFT JOIN users u ON u.id = c.commenter_id
      WHERE c.parent_id IN (${rootIds.map(() => '?').join(',')}) AND c.flagged = 0
      ORDER BY c.created_at ASC
    `, rootIds) : []
    const replyMap = new Map<string, Array<Record<string, unknown>>>()
    for (const r of replies) {
      const pid = String(r.parent_id)
      const arr = replyMap.get(pid) || []
      arr.push(r)
      replyMap.set(pid, arr)
    }
    const items = roots.map(r => ({ ...r, replies: replyMap.get(r.id as string) || [] }))
    const total = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM shareable_comments WHERE shareable_id = ? AND flagged = 0`, [sh.id]))!.n
    res.json({ items, total, sort })
  })

  app.post('/api/shareables/:id/comments', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const sh = await dbOne<{ id: string; owner_id: string; status: string }>(`SELECT id, owner_id, status FROM shareables WHERE id = ?`, [req.params.id])
    if (!sh) return void res.status(404).json({ error: 'shareable 不存在' })
    if (sh.status !== 'active') return void res.status(400).json({ error: 'shareable 已下架' })
    const parentId = req.body?.parent_id ? String(req.body.parent_id) : null
    if (parentId) {
      const parent = await dbOne<{ id: string; parent_id: string | null }>(`SELECT id, parent_id FROM shareable_comments WHERE id = ? AND shareable_id = ?`, [parentId, sh.id])
      if (!parent) return void res.status(404).json({ error: '父评论不存在' })
      if (parent.parent_id) return void res.status(400).json({ error: '只能回复顶层评论' })
    }
    const rawBody = String(req.body?.body || '').trim()
    const minLen = parentId ? 2 : 5
    const maxLen = parentId ? 300 : 500
    if (rawBody.length < minLen) return void res.status(400).json({ error: `内容至少 ${minLen} 字` })
    if (rawBody.length > maxLen) return void res.status(400).json({ error: `内容最多 ${maxLen} 字` })
    const blocked = commentBlocklistHit(rawBody)
    if (blocked) return void res.status(400).json({ error: blocked, error_code: 'COMMENT_BLOCKED' })
    const body = piiSanitize(rawBody)
    const llm = await llmModerateComment(body)
    if (!llm.ok) return void res.status(400).json({ error: llm.reason || '内容不符合社区规范', error_code: 'COMMENT_MODERATED' })

    // 同仲裁评论：flagged 给管理员，flag_reasons 给反诈；用 rawBody
    const reasons = detectFraud(rawBody)
    const cid = generateId('scom')
    await dbRun(`INSERT INTO shareable_comments (id, shareable_id, commenter_id, parent_id, body, flag_reasons) VALUES (?,?,?,?,?,?)`,
      [cid, sh.id, user.id, parentId, body,
        reasons.length ? JSON.stringify(reasons) : null])

    // 通知作者（自己评论自己除外）+ W9 action
    if (sh.owner_id !== user.id) {
      try {
        const actions = JSON.stringify([{ kind: 'navigate', label: '查看笔记', href: `#note/${sh.id}`, style: 'primary' }])
        await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
          [generateId('ntf'), sh.owner_id, 'note_comment', parentId ? '💬 笔记评论新回复' : '💬 笔记新评论', body.slice(0, 80), null, actions])
      } catch (e) { console.warn('[notif note_comment]', (e as Error).message) }
    }
    // 2026-05-22 audit P1：评论 @ 提及 → notifications（含笔记 owner 避免重复）
    const commentMentions = parseMentions(body).filter(m => m.user_id !== sh.owner_id)
    notifyMentions(commentMentions, user.id as string, 'comment', sh.id, body.slice(0, 100))
    res.json({ success: true, id: cid, flag_reasons: reasons, mentions: commentMentions.map(m => m.handle) })
  })

  // 查询单个 shareable 我是否点赞过（用于 UI 状态）
  app.get('/api/shareables/:id/like-status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne<{ id: string }>('SELECT id FROM shareable_likes WHERE shareable_id = ? AND user_id = ?', [req.params.id, user.id])
    const count = (await dbOne<{ like_count: number }>('SELECT like_count FROM shareables WHERE id = ?', [req.params.id]))?.like_count ?? 0
    res.json({ liked: !!row, like_count: count })
  })

  // ─── 收藏 Bookmarks（小红书风格"收藏" tab）── 2026-05-22 audit ─────
  // POST 切换：未收藏 → 加 / 已收藏 → 删（toggle 模式）
  app.post('/api/shareables/:id/bookmark', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const id = String(req.params.id)
    // 确认 shareable 存在 + active
    const sh = await dbOne<{ id: string }>("SELECT id FROM shareables WHERE id = ? AND status = 'active'", [id])
    if (!sh) return void res.status(404).json({ error: 'not_found' })
    const existing = await dbOne<{ id: string }>('SELECT id FROM shareable_bookmarks WHERE shareable_id = ? AND user_id = ?', [id, user.id])
    if (existing) {
      await dbRun('DELETE FROM shareable_bookmarks WHERE id = ?', [existing.id])
      return void res.json({ bookmarked: false })
    }
    await dbRun('INSERT INTO shareable_bookmarks (id, shareable_id, user_id) VALUES (?, ?, ?)', [generateId('bm'), id, user.id])
    res.json({ bookmarked: true })
  })

  // 查 bookmark 状态
  app.get('/api/shareables/:id/bookmark-status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne<{ id: string }>('SELECT id FROM shareable_bookmarks WHERE shareable_id = ? AND user_id = ?', [req.params.id, user.id])
    res.json({ bookmarked: !!row })
  })

  // 我收藏过的 shareables（仅 owner 自己可见）
  app.get('/api/users/:id/bookmarked-shareables', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const ref = String(req.params.id || '').trim()
    let ownerId: string | null = null
    if (ref === 'me' || ref === me.id) ownerId = me.id as string
    if (!ownerId) return void res.status(403).json({ error: 'only owner can view bookmarks' })
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT s.id, s.owner_id, s.owner_code, s.type, s.external_url, s.external_platform,
             s.thumbnail_url, s.title, s.description, s.photo_hashes, s.related_product_id, s.related_anchor,
             s.click_count, s.like_count, s.created_at,
             p.title AS product_title,
             b.created_at as bookmarked_at
      FROM shareable_bookmarks b
      JOIN shareables s ON s.id = b.shareable_id
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE b.user_id = ? AND s.status = 'active'
      ORDER BY b.created_at DESC LIMIT 100
    `, [ownerId])
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r.photo_hashes === 'string') {
        try { r.photo_hashes = JSON.parse(r.photo_hashes as string) } catch { r.photo_hashes = [] }
      }
    }
    res.json({ shareables: rows })
  })
}
