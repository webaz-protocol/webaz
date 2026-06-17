/**
 * Welcome 域端点（#991 /welcome 预发布页 + #1005 安全加固）
 *
 * 由 #1013 Phase 2 从 src/pwa/server.ts 抽出。
 *
 * 7 endpoints + 1 helper:
 *   POST   /api/public-ideas              — "我有建议" 公开提交（无需登录 + 反 bot）
 *   POST   /api/email-subscriptions       — 邮件订阅
 *   POST   /api/email-subscriptions/unsubscribe — 退订（JSON）
 *   GET    /unsubscribe                   — 浏览器友好退订页（HTML）
 *   GET    /api/admin/public-ideas        — admin 看建议列表（需 support perm）
 *   PATCH  /api/admin/public-ideas/:id    — admin 改状态
 *   GET    /api/admin/email-subscriptions — admin 看订阅列表
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const SUB_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const VALID_ROLE_PREFS = new Set(['buyer', 'seller', 'creator', 'verifier', 'arbitrator', 'other'])

export interface WelcomeDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  getUser: (req: Request) => { id?: string } | null
  clientIpHash: (req: Request) => string
  clientUaHash: (req: Request) => string
  // pre-bound 'support' 权限 admin gate（避免在 routes 层耦合 AdminPermission 类型）
  requireSupportAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerWelcomeRoutes(app: Application, deps: WelcomeDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { generateId, getUser, clientIpHash, clientUaHash, requireSupportAdmin } = deps

  // ─── admin 端 ─────────────────────────────────────────────
  app.get('/api/admin/public-ideas', async (req, res) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const status = req.query.status ? String(req.query.status) : null
    const where: string[] = ["content NOT LIKE 'WELCOME_EMAIL_SUBSCRIBE:%'"]   // 旧前缀数据兼容：排除被迁过的邮箱订阅
    const args: unknown[] = []
    if (status) { where.push('status = ?'); args.push(status) }
    const whereClause = `WHERE ${where.join(' AND ')}`
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT id, user_id, contact, content, status, created_at
      FROM public_ideas ${whereClause}
      ORDER BY created_at DESC LIMIT 500
    `, args)
    const counts = await dbOne<Record<string, number>>(`SELECT
      SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) as st_new,
      SUM(CASE WHEN status='triaged' THEN 1 ELSE 0 END) as st_triaged,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as st_resolved,
      SUM(CASE WHEN status='spam' THEN 1 ELSE 0 END) as st_spam,
      COUNT(*) as total
      FROM public_ideas WHERE content NOT LIKE 'WELCOME_EMAIL_SUBSCRIBE:%'`)
    // P1 审计：admin 读 PII 留痕
    try {
      await dbRun(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail)
                  VALUES (?, ?, 'read_public_ideas', 'public_ideas', NULL, ?)`,
        [generateId('aud'), admin.id, JSON.stringify({ count: rows.length, status })])
    } catch {}
    res.json({ items: rows, counts })
  })

  app.patch('/api/admin/public-ideas/:id', async (req, res) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const newStatus = String(req.body?.status || '')
    if (!['new', 'triaged', 'resolved', 'spam'].includes(newStatus)) return void res.status(400).json({ error: 'status 取值非法' })
    const r = await dbRun("UPDATE public_ideas SET status=? WHERE id=?", [newStatus, req.params.id])
    if (r.changes === 0) return void res.status(404).json({ error: '记录不存在' })
    try {
      await dbRun(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail)
                  VALUES (?, ?, 'patch_public_idea', 'public_ideas', ?, ?)`,
        [generateId('aud'), admin.id, req.params.id, JSON.stringify({ status: newStatus })])
    } catch {}
    res.json({ ok: true, status: newStatus })
  })

  // 2026-05-25 admin 查邮箱订阅 — 独立端点，与建议分开
  app.get('/api/admin/email-subscriptions', async (req, res) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const includeUnsub = req.query.include_unsubscribed === '1'
    const HANDLE_STATES = ['pending', 'contacted', 'invited', 'done']
    const statusFilter = HANDLE_STATES.includes(String(req.query.handle_status || '')) ? String(req.query.handle_status) : ''
    const conds: string[] = []
    const args: unknown[] = []
    if (!includeUnsub) conds.push('unsubscribed_at IS NULL')
    if (statusFilter) { conds.push("COALESCE(handle_status,'pending') = ?"); args.push(statusFilter) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT id, email, source, role_preference, note, consent_at, unsubscribed_at, user_id, created_at,
             COALESCE(handle_status,'pending') as handle_status, handled_at
      FROM email_subscriptions ${where}
      ORDER BY created_at DESC LIMIT 500
    `, args)
    const counts = await dbOne<Record<string, number>>(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN unsubscribed_at IS NULL THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) as unsubscribed,
      SUM(CASE WHEN COALESCE(handle_status,'pending') = 'pending'   THEN 1 ELSE 0 END) as st_pending,
      SUM(CASE WHEN handle_status = 'contacted' THEN 1 ELSE 0 END) as st_contacted,
      SUM(CASE WHEN handle_status = 'invited'   THEN 1 ELSE 0 END) as st_invited,
      SUM(CASE WHEN handle_status = 'done'      THEN 1 ELSE 0 END) as st_done
      FROM email_subscriptions`)
    try {
      await dbRun(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail)
                  VALUES (?, ?, 'read_email_subscriptions', 'email_subscriptions', NULL, ?)`,
        [generateId('aud'), admin.id, JSON.stringify({ count: rows.length, include_unsubscribed: includeUnsub })])
    } catch {}
    res.json({ items: rows, counts })
  })

  // 2026-05-29: admin 标记申请处理状态（pending→contacted→invited→done）— 不动 POST 提交逻辑
  app.patch('/api/admin/email-subscriptions/:id/status', async (req, res) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const HANDLE_STATES = ['pending', 'contacted', 'invited', 'done']
    const status = String((req.body || {}).status || '')
    if (!HANDLE_STATES.includes(status)) return void res.status(400).json({ error: 'status 必须是 pending/contacted/invited/done' })
    const row = await dbOne<{ id: string; handle_status: string | null }>('SELECT id, handle_status FROM email_subscriptions WHERE id = ?', [req.params.id])
    if (!row) return void res.status(404).json({ error: '记录不存在' })
    await dbRun("UPDATE email_subscriptions SET handle_status = ?, handled_at = datetime('now'), handled_by = ? WHERE id = ?",
      [status, admin.id, req.params.id])
    try {
      await dbRun(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail)
                  VALUES (?, ?, 'update_email_subscription_status', 'email_subscriptions', ?, ?)`,
        [generateId('aud'), admin.id, req.params.id, JSON.stringify({ from: row.handle_status || 'pending', to: status })])
    } catch {}
    res.json({ success: true, status })
  })

  // ─── 公开端 ───────────────────────────────────────────────
  // 2026-05-24 首屏「我有建议」— 公开提交（无需登录）
  // 反 bot：honeypot 字段 + 单 IP+UA 联合 rate limit 5/h + 内容 hash 去重 1h
  app.post('/api/public-ideas', async (req, res) => {
    // 蜜罐字段 `_hp`：bot 倾向于填所有 input；真人不会看到（前端 display:none）
    if (req.body?._hp) return void res.status(400).json({ error: 'invalid' })   // 不告诉 bot 真原因
    const content = String(req.body?.content || '').trim()
    const contact = String(req.body?.contact || '').trim().slice(0, 200)
    if (content.length < 10 || content.length > 2000) {
      return void res.status(400).json({ error: '内容 10-2000 字' })
    }
    const ipHash = clientIpHash(req)
    const uaHash = clientUaHash(req)
    // IP+UA 联合：5/h（之前是仅 IP，NAT 误伤）
    const recent = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM public_ideas
      WHERE (ip_hash = ? OR ua_hash = ?) AND created_at > datetime('now', '-1 hour')`, [ipHash, uaHash]))!.n
    if (recent >= 5) return void res.status(429).json({ error: '提交过于频繁，请稍后再试' })
    // 内容去重：1h 内同 ip+content 不重复落库
    const dup = await dbOne(`SELECT 1 FROM public_ideas
      WHERE ip_hash = ? AND content = ? AND created_at > datetime('now', '-1 hour')`, [ipHash, content])
    if (dup) return void res.status(409).json({ error: '请勿重复提交相同内容' })
    const userId = getUser(req)?.id || null
    const id = generateId('idea')
    await dbRun(`INSERT INTO public_ideas (id, user_id, contact, content, ip_hash, ua_hash) VALUES (?,?,?,?,?,?)`,
      [id, userId, contact || null, content, ipHash, uaHash])
    res.json({ ok: true, id })
  })

  // 2026-05-25 邮箱订阅独立端点（替代旧 WELCOME_EMAIL_SUBSCRIBE: 前缀 hack）
  // 2026-05-26 加 role_preference + note 字段（welcome 表单丰富化）
  app.post('/api/email-subscriptions', async (req, res) => {
    if (req.body?._hp) return void res.status(400).json({ error: 'invalid' })   // honeypot
    const email = String(req.body?.email || '').trim().toLowerCase()
    const source = String(req.body?.source || 'welcome').slice(0, 30)
    if (!email || !SUB_EMAIL_RE.test(email) || email.length > 200) {
      return void res.status(400).json({ error: '邮箱格式无效' })
    }
    // role_preference 可选；非法值视为 null（不报错，前端 select 也限了枚举）
    const rolePrefRaw = String(req.body?.role_preference || '').trim().toLowerCase()
    const rolePref = VALID_ROLE_PREFS.has(rolePrefRaw) ? rolePrefRaw : null
    // note 可选；trim + 500 截断
    const noteRaw = String(req.body?.note || '').trim()
    const note = noteRaw ? noteRaw.slice(0, 500) : null
    const ipHash = clientIpHash(req)
    // rate limit: 单 IP 1h 最多 3 次（防爆破探测同人多邮箱）
    const recent = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM email_subscriptions
      WHERE ip_hash = ? AND created_at > datetime('now', '-1 hour')`, [ipHash]))!.n
    if (recent >= 3) return void res.status(429).json({ error: '提交过于频繁，请稍后再试' })
    // 已存在（active）→ 幂等返回 ok（不暴露"该邮箱已订阅"避免邮箱枚举）
    // 但若提供了新 role/note，更新这俩字段（用户可能回来补充）
    const exist = await dbOne<{ id: string; unsubscribed_at: string | null }>(`SELECT id, unsubscribed_at FROM email_subscriptions WHERE email = ?`, [email])
    if (exist) {
      const sets: string[] = []
      const args: unknown[] = []
      if (exist.unsubscribed_at) { sets.push("unsubscribed_at = NULL", "consent_at = datetime('now')") }
      if (rolePref) { sets.push("role_preference = ?"); args.push(rolePref) }
      if (note)     { sets.push("note = ?");            args.push(note) }
      if (sets.length > 0) {
        args.push(exist.id)
        await dbRun(`UPDATE email_subscriptions SET ${sets.join(', ')} WHERE id = ?`, args)
      }
      return void res.json({ ok: true, id: exist.id, status: 'subscribed' })
    }
    const id = generateId('eml')
    const token = createHash('sha256').update(id + email + Math.random()).digest('hex').slice(0, 32)
    const userId = getUser(req)?.id || null
    await dbRun(`INSERT INTO email_subscriptions (id, email, source, role_preference, note, unsubscribe_token, ip_hash, user_id) VALUES (?,?,?,?,?,?,?,?)`,
      [id, email, source, rolePref, note, token, ipHash, userId])
    res.json({ ok: true, id, status: 'subscribed', unsubscribe_url: `/unsubscribe?t=${token}` })
  })

  // 公开退订端点 — 接受 GET（邮件里的链接）+ POST（页面按钮）
  async function doUnsubscribe(token: string): Promise<{ ok: boolean; email?: string; error?: string }> {
    if (!token || token.length !== 32) return { ok: false, error: 'invalid_token' }
    const row = await dbOne<{ id: string; email: string; unsubscribed_at: string | null }>(`SELECT id, email, unsubscribed_at FROM email_subscriptions WHERE unsubscribe_token = ?`, [token])
    if (!row) return { ok: false, error: 'token_not_found' }
    if (row.unsubscribed_at) return { ok: true, email: row.email }  // 已退订也返 ok（幂等）
    await dbRun(`UPDATE email_subscriptions SET unsubscribed_at = datetime('now') WHERE id = ?`, [row.id])
    return { ok: true, email: row.email }
  }
  app.post('/api/email-subscriptions/unsubscribe', async (req, res) => {
    const r = await doUnsubscribe(String(req.body?.token || ''))
    res.status(r.ok ? 200 : 400).json(r)
  })
  // 浏览器友好的退订页（GET）
  app.get('/unsubscribe', async (req, res) => {
    const r = await doUnsubscribe(String(req.query?.t || ''))
    const okHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>已退订 — webaz</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#FAFAFA;color:#18181B}main{text-align:center;padding:32px}h1{font-size:22px;font-weight:600;margin:0 0 12px}p{font-size:14px;color:#71717A;margin:0 0 8px}a{color:#6366f1;text-decoration:none;font-size:13px}</style></head><body><main><h1>✓ 已退订 / Unsubscribed</h1><p>${r.email ? `<code>${r.email}</code>` : ''}</p><p>不会再收到 webaz 的邮件。<br>You won't receive emails from webaz anymore.</p><a href="/">← 返回首页 / Back</a></main></body></html>`
    const errHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>退订链接无效</title><style>body{font-family:-apple-system,sans-serif;text-align:center;padding:80px 20px;color:#18181B}p{color:#71717A}</style></head><body><h1>退订链接无效</h1><p>${r.error}</p><a href="/">← 返回首页</a></body></html>`
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.send(r.ok ? okHtml : errHtml)
  })
}
