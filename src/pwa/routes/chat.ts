/**
 * Chat 域 — 上下文绑定私聊（订单 / RFQ / listing_qa 三种 context）
 *
 * 由 #1013 Phase 4 从 src/pwa/server.ts 抽出。第四次试水。
 *
 * 8 endpoints + 4 helpers:
 *   POST /api/conversations/start              — 开会话（idempotent）
 *   GET  /api/conversations                    — 我的会话列表
 *   GET  /api/conversations/:id                — 会话详情 + 消息分页
 *   POST /api/conversations/:id/messages       — 发消息（反诈 regex + 通知）
 *   POST /api/conversations/:id/read           — 标记已读
 *   POST /api/conversations/:id/archive        — 归档（仅自己侧）
 *   POST /api/conversations/:id/block          — 拉黑（双向屏蔽）
 *   POST /api/conversations/:id/report         — 举报（人工审核）
 *
 * helpers: VALID_CHAT_KINDS · FRAUD_PATTERNS / detectFraud · resolveChatParticipants · findOrCreateConv
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const VALID_CHAT_KINDS = new Set(['order', 'rfq', 'listing_qa'])

// 反诈正则（命中即 flag，仍发出）
const FRAUD_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: 'phone_cn',  rx: /(?<!\d)1[3-9]\d{9}(?!\d)/ },                            // 中国手机号 11 位
  { name: 'wechat',    rx: /(微信|vx|wechat|weixin|v[xX]\s*[:：])/i },
  { name: 'alipay',    rx: /(支付宝|alipay)/i },
  { name: 'qq',        rx: /\bqq\s*[:：]\s*\d{5,11}\b/i },
  { name: 'bank_card', rx: /(?<!\d)\d{16,19}(?!\d)/ },
  { name: 'telegram',  rx: /(@[A-Za-z0-9_]{5,32}|t\.me\/[A-Za-z0-9_]+|telegram)/i },
  // 锚定 host 段：(?:localhost|webaz\.app|webaz\.io) 后必须紧跟 / 或 : 或末端，防 webaz.io.evil.com 绕过
  { name: 'external_url', rx: /https?:\/\/(?!(?:localhost|webaz\.app|webaz\.io)(?:[/:]|$))[^\s]+/i },
]
// exported because server.ts 其它端点（如 listing Q&A / 评论审核）也用同一套反诈 regex
export function detectFraud(text: string): string[] {
  const hits: string[] = []
  for (const p of FRAUD_PATTERNS) if (p.rx.test(text)) hits.push(p.name)
  return hits
}

export interface ChatDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

export function registerChatRoutes(app: Application, deps: ChatDeps): void {
  const { db, auth, generateId, rateLimitOk } = deps

  // 上下文 + 对方校验：只允许有真实商业关系的两方建会话
  async function resolveChatParticipants(kind: string, contextId: string, requesterId: string, recipientId: string | null): Promise<{ user_a: string; user_b: string; allowed: boolean; reason?: string }> {
    if (kind === 'order') {
      const o = await dbOne<{ buyer_id: string; seller_id: string }>('SELECT buyer_id, seller_id FROM orders WHERE id = ?', [contextId])
      if (!o) return { user_a: '', user_b: '', allowed: false, reason: '订单不存在' }
      if (requesterId !== o.buyer_id && requesterId !== o.seller_id) return { user_a: '', user_b: '', allowed: false, reason: '仅订单买卖双方可聊' }
      return { user_a: o.buyer_id, user_b: o.seller_id, allowed: true }
    }
    if (kind === 'rfq') {
      const r = await dbOne<{ buyer_id: string; status: string }>('SELECT buyer_id, status FROM rfqs WHERE id = ?', [contextId])
      if (!r) return { user_a: '', user_b: '', allowed: false, reason: 'RFQ 不存在' }
      if (requesterId === r.buyer_id) {
        // buyer 主动找某个 bidder
        if (!recipientId) return { user_a: '', user_b: '', allowed: false, reason: '需指定 recipient' }
        const hasBid = await dbOne('SELECT 1 FROM bids WHERE rfq_id = ? AND seller_id = ?', [contextId, recipientId])
        if (!hasBid) return { user_a: '', user_b: '', allowed: false, reason: '对方未对此 RFQ 报价' }
        return { user_a: r.buyer_id, user_b: recipientId, allowed: true }
      }
      // seller 找 buyer：必须自己已 bid
      const myBid = await dbOne('SELECT 1 FROM bids WHERE rfq_id = ? AND seller_id = ?', [contextId, requesterId])
      if (!myBid) return { user_a: '', user_b: '', allowed: false, reason: '需先报价才能联系买家' }
      return { user_a: r.buyer_id, user_b: requesterId, allowed: true }
    }
    if (kind === 'listing_qa') {
      const l = await dbOne<{ created_by: string }>('SELECT created_by FROM listings WHERE id = ?', [contextId])
      if (!l) return { user_a: '', user_b: '', allowed: false, reason: 'listing 不存在' }
      // 仅非创建者可主动发起（避免 listing 创建者主动 spam）
      if (requesterId === l.created_by) {
        // 创建者只能回复已存在的线程；不能新建
        if (!recipientId) return { user_a: '', user_b: '', allowed: false, reason: '请等买家先发起咨询' }
        const [a, b] = l.created_by < recipientId ? [l.created_by, recipientId] : [recipientId, l.created_by]
        const exists = await dbOne("SELECT 1 FROM conversations WHERE kind = 'listing_qa' AND context_id = ? AND user_a = ? AND user_b = ?", [contextId, a, b])
        if (!exists) return { user_a: '', user_b: '', allowed: false, reason: '请等买家先发起咨询' }
        return { user_a: l.created_by, user_b: recipientId, allowed: true }
      }
      return { user_a: l.created_by, user_b: requesterId, allowed: true }
    }
    return { user_a: '', user_b: '', allowed: false, reason: 'kind 无效' }
  }

  async function findOrCreateConv(kind: string, contextId: string, userA: string, userB: string): Promise<string> {
    // 规范化：user_a 字典序较小
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA]
    const SELECT_SQL = 'SELECT id FROM conversations WHERE kind = ? AND context_id = ? AND user_a = ? AND user_b = ?'
    const existing = await dbOne<{ id: string }>(SELECT_SQL, [kind, contextId, a, b])
    if (existing) return existing.id
    // 并发场景下 UNIQUE 可能触发；用 INSERT OR IGNORE + 再次 SELECT 兜底
    const id = generateId('cv')
    await dbRun(`INSERT OR IGNORE INTO conversations (id, kind, context_id, user_a, user_b) VALUES (?,?,?,?,?)`,
      [id, kind, contextId, a, b])
    const final = await dbOne<{ id: string }>(SELECT_SQL, [kind, contextId, a, b])
    return final!.id
  }

  // 开会话（idempotent — 已存在则返回 id）
  app.post('/api/conversations/start', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { kind, context_id, recipient_id } = req.body as Record<string, unknown>
    if (!VALID_CHAT_KINDS.has(String(kind))) return void res.json({ error: 'kind 无效' })
    if (!context_id) return void res.json({ error: 'context_id 必填' })

    const r = await resolveChatParticipants(String(kind), String(context_id), user.id as string, recipient_id ? String(recipient_id) : null)
    if (!r.allowed) return void res.json({ error: r.reason || '无权开启会话' })

    const id = await findOrCreateConv(String(kind), String(context_id), r.user_a, r.user_b)
    res.json({ id, kind, context_id })
  })

  // 我的会话列表
  app.get('/api/conversations', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT c.*,
        CASE WHEN c.user_a = ? THEN c.unread_a ELSE c.unread_b END as my_unread,
        CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END as other_id,
        (SELECT handle FROM users WHERE id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END) as other_handle,
        (SELECT name   FROM users WHERE id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END) as other_name,
        -- 友好标签:订单/问商品 → 商品名,让收件箱里同一对方的多个会话可区分(不只显示 kind)。无新 bind 参数(仅用 c.kind/c.context_id)。
        (CASE c.kind
           WHEN 'order'      THEN (SELECT p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = c.context_id)
           WHEN 'listing_qa' THEN (SELECT title FROM products WHERE id = c.context_id)
           ELSE NULL END) as context_title
      FROM conversations c
      WHERE (c.user_a = ? OR c.user_b = ?) AND c.status NOT IN ('blocked','archived')
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT 100
    `, [user.id, user.id, user.id, user.id, user.id, user.id])
    res.json({ items: rows })
  })

  // 会话详情 + 消息分页
  app.get('/api/conversations/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const conv = await dbOne<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [req.params.id])
    if (!conv) return void res.status(404).json({ error: '会话不存在' })
    if (conv.user_a !== user.id && conv.user_b !== user.id) return void res.status(403).json({ error: '无权访问' })

    const before = req.query.before ? String(req.query.before) : null
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    const args: unknown[] = [req.params.id]
    let whereExtra = ''
    if (before) { whereExtra = ' AND created_at < ?'; args.push(before) }
    args.push(limit)

    const messages = await dbAll<Record<string, unknown>>(`
      SELECT id, sender_id, body, attachments, flagged, flag_reasons, read_at, kind, meta, created_at
      FROM messages
      WHERE conversation_id = ?${whereExtra}
      ORDER BY created_at DESC
      LIMIT ?
    `, args)
    messages.reverse()    // 返回时间正序，便于前端 append
    // QA 轮 11 P1：read 端 flag_reasons 是 JSON string，send 端是 array → agent 双向 parse 易错
    // 统一为 array (send 端格式)
    for (const m of messages) {
      if (typeof m.flag_reasons === 'string') {
        try { m.flag_reasons = JSON.parse(m.flag_reasons as string) } catch { m.flag_reasons = [] }
      } else if (m.flag_reasons == null) {
        m.flag_reasons = []
      }
      if (typeof m.attachments === 'string') {
        try { m.attachments = JSON.parse(m.attachments as string) } catch { m.attachments = [] }
      } else if (m.attachments == null) {
        m.attachments = []
      }
    }

    const otherId = conv.user_a === user.id ? conv.user_b : conv.user_a
    const other = await dbOne<Record<string, unknown>>('SELECT id, handle, name, region FROM users WHERE id = ?', [otherId])

    res.json({ conv, messages, other })
  })

  // 发消息
  app.post('/api/conversations/:id/messages', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // P1: 频率限制 — 同用户每分钟 ≤ 60 条（≈ 1/s 持续 + 短时突发）
    if (!rateLimitOk(`chat_msg:${user.id}`, 60, 60_000)) return void res.status(429).json({ error: '发送过于频繁，请稍等' })
    const conv = await dbOne<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [req.params.id])
    if (!conv) return void res.status(404).json({ error: '会话不存在' })
    if (conv.status === 'blocked') return void res.json({ error: '该会话已被屏蔽' })
    if (conv.user_a !== user.id && conv.user_b !== user.id) return void res.status(403).json({ error: '无权发送' })

    const body = String((req.body as Record<string, unknown>).body || '').trim()
    const attachmentsRaw = (req.body as Record<string, unknown>).attachments
    const attachments = Array.isArray(attachmentsRaw)
      ? attachmentsRaw.filter((a: unknown) => typeof a === 'string' && (a as string).length < 200_000).slice(0, 4)
      : []

    // W1: 结构化 kind + meta
    const kind = String((req.body as Record<string, unknown>).kind || 'text')
    if (!['text', 'offer', 'tracking'].includes(kind)) return void res.status(400).json({ error: '无效 kind' })
    const metaIn = (req.body as Record<string, unknown>).meta as Record<string, unknown> | undefined
    let metaJson: string | null = null
    let structuredPreview: string | null = null
    if (kind === 'offer') {
      const amount = Number(metaIn?.amount)
      const productId = metaIn?.product_id ? String(metaIn.product_id) : null
      const note = metaIn?.note ? String(metaIn.note).slice(0, 200) : ''
      if (!(amount > 0) || amount > 1_000_000) return void res.status(400).json({ error: '报价金额需在 0-1000000 之间' })
      metaJson = JSON.stringify({ amount, product_id: productId, note })
      structuredPreview = `💰 ${amount} WAZ${note ? ' · ' + note.slice(0, 30) : ''}`
    } else if (kind === 'tracking') {
      const carrier = metaIn?.carrier ? String(metaIn.carrier).slice(0, 40) : ''
      const trackingNo = metaIn?.tracking_no ? String(metaIn.tracking_no).trim().slice(0, 60) : ''
      if (!trackingNo) return void res.status(400).json({ error: '单号必填' })
      metaJson = JSON.stringify({ carrier, tracking_no: trackingNo })
      structuredPreview = `🚚 ${carrier ? carrier + ' ' : ''}${trackingNo}`
    }

    if (kind === 'text' && !body && attachments.length === 0) return void res.json({ error: '内容不能为空' })
    if (body.length > 2000) return void res.json({ error: '消息最长 2000 字' })

    const reasons = kind === 'text' ? detectFraud(body) : []
    const id = generateId('msg')
    const isFromA = conv.user_a === user.id
    const preview = structuredPreview || (body ? body.slice(0, 60) : '[📷 ' + attachments.length + ']')

    db.transaction(() => {
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, attachments, flagged, flag_reasons, kind, meta)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, req.params.id, user.id,
          body, attachments.length ? JSON.stringify(attachments) : null,
          reasons.length ? 1 : 0, reasons.length ? JSON.stringify(reasons) : null,
          kind, metaJson)
      db.prepare(`UPDATE conversations SET
        last_message_at = datetime('now'),
        last_preview = ?,
        ${isFromA ? 'unread_b = unread_b + 1' : 'unread_a = unread_a + 1'}
        WHERE id = ?`).run(preview, req.params.id)
    })()

    // 通知接收方
    try {
      const recipient = isFromA ? conv.user_b : conv.user_a
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'chat_new',?,?,datetime('now'))`,
        [generateId('ntf'), recipient as string, `💬 新消息`, preview])
    } catch (e) { console.error('[chat notify]', e) }

    res.json({ id, flagged: reasons.length > 0, flag_reasons: reasons })
  })

  // 标记已读
  app.post('/api/conversations/:id/read', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const conv = await dbOne<{ user_a: string; user_b: string }>('SELECT user_a, user_b FROM conversations WHERE id = ?', [req.params.id])
    if (!conv) return void res.status(404).json({ error: '会话不存在' })
    if (conv.user_a !== user.id && conv.user_b !== user.id) return void res.status(403).json({ error: '无权访问' })
    const col = conv.user_a === user.id ? 'unread_a' : 'unread_b'
    db.transaction(() => {
      db.prepare(`UPDATE conversations SET ${col} = 0 WHERE id = ?`).run(req.params.id)
      db.prepare(`UPDATE messages SET read_at = datetime('now')
                  WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL`).run(req.params.id, user.id)
    })()
    res.json({ success: true })
  })

  // 归档（仅自己侧）
  app.post('/api/conversations/:id/archive', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const conv = await dbOne<Record<string, string>>('SELECT user_a, user_b, status FROM conversations WHERE id = ?', [req.params.id])
    if (!conv) return void res.status(404).json({ error: '会话不存在' })
    if (conv.user_a !== user.id && conv.user_b !== user.id) return void res.status(403).json({ error: '无权操作' })
    await dbRun("UPDATE conversations SET status = 'archived' WHERE id = ?", [req.params.id])
    res.json({ success: true })
  })

  // 拉黑（双向屏蔽）
  app.post('/api/conversations/:id/block', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const conv = await dbOne<Record<string, string>>('SELECT user_a, user_b FROM conversations WHERE id = ?', [req.params.id])
    if (!conv) return void res.status(404).json({ error: '会话不存在' })
    if (conv.user_a !== user.id && conv.user_b !== user.id) return void res.status(403).json({ error: '无权操作' })
    await dbRun("UPDATE conversations SET status = 'blocked' WHERE id = ?", [req.params.id])
    res.json({ success: true })
  })

  // 举报（人工审核）
  app.post('/api/conversations/:id/report', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const conv = await dbOne<Record<string, string>>('SELECT user_a, user_b FROM conversations WHERE id = ?', [req.params.id])
    if (!conv) return void res.status(404).json({ error: '会话不存在' })
    if (conv.user_a !== user.id && conv.user_b !== user.id) return void res.status(403).json({ error: '无权操作' })
    const body = req.body as Record<string, unknown>
    const reason = String(body.reason || '').trim()
    if (!reason) return void res.json({ error: '原因必填' })
    // P1: 同 (reporter, conversation) 24h 内最多 3 次
    const recentRpt = (await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM chat_reports WHERE conversation_id = ? AND reporter_id = ? AND created_at > datetime('now','-1 day')`, [req.params.id, user.id]))!.n
    if (recentRpt >= 3) return void res.status(429).json({ error: '24 小时内对同一会话最多举报 3 次' })
    const reportedId = conv.user_a === user.id ? conv.user_b : conv.user_a
    await dbRun(`INSERT INTO chat_reports (id, conversation_id, message_id, reporter_id, reported_id, reason, note)
                VALUES (?,?,?,?,?,?,?)`,
      [generateId('rpt'), req.params.id, body.message_id ? String(body.message_id) : null,
        user.id, reportedId, reason, body.note ? String(body.note).slice(0, 500) : null])
    res.json({ success: true })
  })
}
