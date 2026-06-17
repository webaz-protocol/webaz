/**
 * 客服 / 反馈通道域 (Wave D-3 + W7 ticket-thread)
 *
 * 由 #1013 Phase 21 从 src/pwa/server.ts 抽出。
 *
 * 7 endpoints:
 *   POST  /api/feedback                     用户提交工单（1h 内最多 5 条 + AI 草拟回复）
 *   GET   /api/feedback/mine                我的工单列表（含 unread_reply_count）
 *   POST  /api/feedback/seen                标记客服回复已读
 *   GET   /api/admin/feedback               admin 列表（按 status/category 筛选）
 *   POST  /api/admin/feedback/:id/reply     admin 回复（reasons + 通知用户）
 *   GET   /api/feedback/:id                 单工单详情 + W7 timeline 事件流
 *   POST  /api/feedback/:id/messages        多轮追问 / 回复（user 或 admin）
 *
 * 跨域：
 *   - detectFraud（来自 chat.ts，作为 deps 注入）
 *   - broadcastSystemEvent / anthropic（server.ts 注入）
 *
 * AI 草拟（G-4）：用户提 ticket 时 fire-and-forget Claude haiku 生成回复草案，admin 审后再发。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import type Anthropic from '@anthropic-ai/sdk'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const VALID_FEEDBACK_CAT = new Set(['bug', 'abuse', 'feature', 'account', 'other'])
const VALID_FEEDBACK_SEV = new Set(['low', 'medium', 'high'])

export interface FeedbackDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void
  detectFraud: (text: string) => string[]
  anthropic: Anthropic
}

export function registerFeedbackRoutes(app: Application, deps: FeedbackDeps): void {
  const { db, generateId, auth, broadcastSystemEvent, detectFraud, anthropic } = deps

  app.post('/api/feedback', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { category, severity, subject, body } = req.body || {}
    if (!VALID_FEEDBACK_CAT.has(String(category))) return void res.status(400).json({ error: '无效类别' })
    const sev = VALID_FEEDBACK_SEV.has(String(severity)) ? String(severity) : 'medium'
    const sub = String(subject || '').trim()
    const bod = String(body || '').trim()
    if (sub.length < 4 || sub.length > 80) return void res.status(400).json({ error: '标题 4-80 字' })
    if (bod.length < 10 || bod.length > 2000) return void res.status(400).json({ error: '正文 10-2000 字' })
    const recent = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM feedback_tickets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')`, [user.id]))!.n
    if (recent >= 5) return void res.status(429).json({ error: '提交过于频繁，请稍后再试' })
    const id = generateId('fbk')
    await dbRun(`INSERT INTO feedback_tickets (id, user_id, category, severity, subject, body) VALUES (?,?,?,?,?,?)`,
      [id, user.id, String(category), sev, sub, bod])
    try { broadcastSystemEvent('feedback', '💬', `反馈工单 ${id} · ${category}/${sev}`, id) } catch {}
    // G-4: 异步 AI 草拟回复（不阻塞）
    ;(async () => {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `你是 WebAZ 客服 AI。用户提交了工单，你先草拟一份回复（admin 会审核后再发出）。客气专业，2-4 句，无前后缀：
类别: ${category}
紧急: ${sev}
标题: ${sub}
正文: ${bod}`,
          }],
        })
        const text = (message.content[0] as { type: string; text?: string })?.text || ''
        await dbRun(`UPDATE feedback_tickets SET ai_suggested_reply = ?, ai_generated_at = datetime('now') WHERE id = ?`,
          [text.trim(), id])
      } catch (e) {
        console.error('[ai feedback draft]', (e as Error).message)
      }
    })()
    res.json({ success: true, id })
  })

  app.get('/api/feedback/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(`SELECT id, category, severity, subject, body, status, admin_reply, replied_at, user_seen_reply_at, created_at, updated_at
      FROM feedback_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, [user.id])
    // 派生 has_unread_reply
    let unreadReplyCount = 0
    for (const r of rows) {
      const hasReply = !!r.admin_reply
      const repliedAt = r.replied_at as string | null
      const seenAt = r.user_seen_reply_at as string | null
      const isUnread = hasReply && (!seenAt || (repliedAt && repliedAt > seenAt))
      r.has_unread_reply = isUnread ? 1 : 0
      if (isUnread) unreadReplyCount++
    }
    res.json({ items: rows, unread_reply_count: unreadReplyCount })
  })

  app.post('/api/feedback/seen', async (req, res) => {
    const user = auth(req, res); if (!user) return
    await dbRun(`UPDATE feedback_tickets SET user_seen_reply_at = datetime('now')
      WHERE user_id = ? AND admin_reply IS NOT NULL AND (user_seen_reply_at IS NULL OR replied_at > user_seen_reply_at)`, [user.id])
    res.json({ success: true })
  })

  // admin 列出工单
  app.get('/api/admin/feedback', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'admin') return void res.status(403).json({ error: '仅 admin 可访问' })
    const status = req.query.status ? String(req.query.status) : null
    const category = req.query.category ? String(req.query.category) : null
    const where: string[] = []
    const params: unknown[] = []
    if (status) { where.push('f.status = ?'); params.push(status) }
    if (category) { where.push('f.category = ?'); params.push(category) }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await dbAll(`
      SELECT f.*, u.name as user_name, u.handle as user_handle, u.role as user_role
      FROM feedback_tickets f
      JOIN users u ON u.id = f.user_id
      ${whereClause}
      ORDER BY
        CASE f.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END,
        CASE f.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        f.created_at DESC
      LIMIT 200
    `, params)
    res.json({ items: rows })
  })

  // admin 回复 + 切状态
  app.post('/api/admin/feedback/:id/reply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'admin') return void res.status(403).json({ error: '仅 admin 可回复' })
    const ticket = await dbOne<{ user_id: string; status: string }>('SELECT user_id, status FROM feedback_tickets WHERE id = ?', [req.params.id])
    if (!ticket) return void res.status(404).json({ error: '工单不存在' })
    const { reply, status } = req.body || {}
    const replyStr = reply ? String(reply).slice(0, 2000).trim() : null
    if (!replyStr) return void res.status(400).json({ error: '回复内容必填' })
    const newStatus = status && ['open','in_progress','resolved','closed'].includes(String(status)) ? String(status) : 'resolved'
    // 跨窗反诈一致性
    const adminReasons = detectFraud(replyStr)
    db.transaction(() => {
      db.prepare(`INSERT INTO feedback_messages (id, ticket_id, sender_id, sender_role, body, flagged, flag_reasons) VALUES (?,?,?,?,?,?,?)`)
        .run(generateId('fmsg'), req.params.id, user.id, 'admin', replyStr,
          adminReasons.length ? 1 : 0, adminReasons.length ? JSON.stringify(adminReasons) : null)
      db.prepare(`UPDATE feedback_tickets SET admin_reply = ?, replied_by = ?, replied_at = datetime('now'), status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(replyStr, user.id, newStatus, req.params.id)
    })()
    try {
      const actions = JSON.stringify([{ kind: 'navigate', label: '查看工单', href: `#ticket/${req.params.id}`, style: 'primary' }])
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
        [generateId('ntf'), ticket.user_id, 'ticket_reply', `💬 客服回复了你的工单`, replyStr.slice(0, 100), null, actions])
    } catch (e) { console.warn('[notif ticket_reply]', (e as Error).message) }
    res.json({ success: true })
  })

  // ─── W7 ticket-thread ────────────────────────────────────

  // 工单详情 + timeline
  app.get('/api/feedback/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const t = await dbOne<Record<string, unknown>>(`
      SELECT f.*, u.name as user_name, u.handle as user_handle, u.role as user_role
      FROM feedback_tickets f JOIN users u ON u.id = f.user_id WHERE f.id = ?
    `, [req.params.id])
    if (!t) return void res.status(404).json({ error: '工单不存在' })
    const isOwner = t.user_id === user.id
    const isAdmin = (user as Record<string, unknown>).role === 'admin'
    if (!isOwner && !isAdmin) return void res.status(403).json({ error: '无权查看' })

    const messages = await dbAll<Record<string, unknown>>(`
      SELECT m.*, u.name as sender_name, u.handle as sender_handle
      FROM feedback_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.ticket_id = ? ORDER BY m.created_at ASC
    `, [t.id])

    type TLEvent = {
      id: string
      type: 'created' | 'message' | 'status_change' | 'resolved' | 'closed'
      ts: string
      actor_id: string | null
      actor_role: 'user' | 'admin' | 'system'
      body: string
      flagged?: number
      flag_reasons?: string[]
      meta?: Record<string, unknown>
    }
    const events: TLEvent[] = []

    events.push({
      id: `create-${t.id}`,
      type: 'created',
      ts: String(t.created_at || ''),
      actor_id: String(t.user_id),
      actor_role: 'user',
      body: String(t.body || ''),
      meta: { subject: t.subject, category: t.category, severity: t.severity },
    })

    for (const m of messages) {
      let fr: string[] = []
      try { fr = m.flag_reasons ? JSON.parse(String(m.flag_reasons)) : [] } catch {}
      events.push({
        id: `msg-${m.id}`,
        type: 'message',
        ts: String(m.created_at || ''),
        actor_id: m.sender_id ? String(m.sender_id) : null,
        actor_role: (m.sender_role || 'user') as 'user' | 'admin',
        body: String(m.body || ''),
        flagged: Number(m.flagged || 0),
        flag_reasons: fr,
      })
    }

    if ((t.status === 'resolved' || t.status === 'closed') && t.replied_at) {
      events.push({
        id: `done-${t.id}`,
        type: t.status === 'closed' ? 'closed' : 'resolved',
        ts: String(t.replied_at),
        actor_id: t.replied_by ? String(t.replied_by) : null,
        actor_role: 'admin',
        body: '',
      })
    }

    events.sort((a, b) => a.ts.localeCompare(b.ts))

    if (isOwner) {
      try {
        await dbRun(`UPDATE feedback_tickets SET user_seen_reply_at = datetime('now') WHERE id = ? AND admin_reply IS NOT NULL`, [t.id])
      } catch {}
    }
    if (isAdmin) {
      try { await dbRun(`UPDATE feedback_tickets SET admin_seen_at = datetime('now') WHERE id = ?`, [t.id]) } catch {}
    }

    res.json({ item: t, timeline: events, is_admin: isAdmin })
  })

  // 工单内追加消息（user 或 admin）
  app.post('/api/feedback/:id/messages', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const t = await dbOne<{ id: string; user_id: string; status: string }>(`SELECT id, user_id, status FROM feedback_tickets WHERE id = ?`, [req.params.id])
    if (!t) return void res.status(404).json({ error: '工单不存在' })
    const isOwner = t.user_id === user.id
    const isAdmin = (user as Record<string, unknown>).role === 'admin'
    if (!isOwner && !isAdmin) return void res.status(403).json({ error: '无权操作' })
    if (t.status === 'closed') return void res.status(400).json({ error: '工单已关闭' })

    const body = String(req.body?.body || '').trim()
    if (body.length < 1 || body.length > 2000) return void res.status(400).json({ error: '消息长度 1-2000 字' })

    const reasons = detectFraud(body)
    const mid = generateId('fmsg')
    db.transaction(() => {
      db.prepare(`INSERT INTO feedback_messages (id, ticket_id, sender_id, sender_role, body, flagged, flag_reasons) VALUES (?,?,?,?,?,?,?)`)
        .run(mid, t.id, user.id, isAdmin ? 'admin' : 'user', body,
          reasons.length ? 1 : 0, reasons.length ? JSON.stringify(reasons) : null)
      // user 追问 → 状态重新打开
      if (isOwner && t.status === 'resolved') {
        db.prepare(`UPDATE feedback_tickets SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`).run(t.id)
      } else {
        db.prepare(`UPDATE feedback_tickets SET updated_at = datetime('now') WHERE id = ?`).run(t.id)
      }
    })()

    try {
      const tktAction = JSON.stringify([{ kind: 'navigate', label: '查看工单', href: `#ticket/${t.id}`, style: 'primary' }])
      if (isOwner) {
        const admins = await dbAll<{ id: string }>(`SELECT id FROM users WHERE role = 'admin'`, [])
        for (const a of admins) {
          await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
            [generateId('ntf'), a.id, 'ticket_followup', '💬 用户追问了工单', body.slice(0, 100), null, tktAction])
        }
      } else {
        await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`,
          [generateId('ntf'), t.user_id, 'ticket_reply', '💬 客服回复了你的工单', body.slice(0, 100), null, tktAction])
      }
    } catch (e) { console.warn('[notif ticket_msg]', (e as Error).message) }

    res.json({ success: true, id: mid })
  })
}
