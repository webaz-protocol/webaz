/**
 * Admin 运维杂项 — CSV export / AI 异常分 / 信誉衰减 / 估值徽章重算 / 错误日志查询
 *
 * 由 #1013 Phase 106 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET  /api/admin/export/:kind                    (users)     CSV 5 类导出，10k 截断
 *   POST /api/admin/ai/anomaly-check/:user_id       (users)     haiku 风控分 0-100
 *   POST /api/admin/reputation/decay                (admin)     强制触发月衰减
 *   POST /api/admin/_dev/recompute-value-badges     (admin)     重算品类价值徽章
 *   GET  /api/admin/errors                          (protocol)  错误日志查询（含 source 过滤）
 *
 * 跨域注入：requireUsersAdmin + auth + hasAdminPermission
 *           + INTERNAL_AUDITOR_ID + ADMIN_EXPORT_LIMIT + csvEscapeAdmin
 *           + anthropic + applyDecayIfDue + computeValueBadges
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminOpsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireUsersAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  hasAdminPermission: (user: Record<string, unknown>, key: any) => boolean
  INTERNAL_AUDITOR_ID: string
  ADMIN_EXPORT_LIMIT: number
  csvEscapeAdmin: (val: unknown) => string
  anthropic: any
  applyDecayIfDue: (db: Database.Database, opts: { force?: boolean }) => unknown
  computeValueBadges: () => { categories: number; total_products: number; badged: number; skipped_small: number }
  // 统一审计:reputation/decay 是管理员触发的全局声誉变更 → 记入 admin_audit_log(#admin/audit 可查)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminOpsRoutes(app: Application, deps: AdminOpsDeps): void {
  const { db, auth, requireUsersAdmin, hasAdminPermission, INTERNAL_AUDITOR_ID,
          ADMIN_EXPORT_LIMIT, csvEscapeAdmin, anthropic, applyDecayIfDue,
          computeValueBadges, logAdminAction } = deps

  app.get('/api/admin/export/:kind', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const kind = String(req.params.kind || '')
    let headers: string[] = []
    let rows: Array<Record<string, unknown>> = []
    if (kind === 'users') {
      headers = ['id', 'name', 'handle', 'role', 'region', 'email_verified', 'created_at']
      rows = await dbAll<Record<string, unknown>>(`SELECT id, name, handle, role, region, email_verified, created_at FROM users WHERE id NOT IN ('sys_protocol', ?) ORDER BY created_at DESC LIMIT ?`, [INTERNAL_AUDITOR_ID, ADMIN_EXPORT_LIMIT])
    } else if (kind === 'orders') {
      headers = ['id', 'product_id', 'buyer_id', 'seller_id', 'status', 'total_amount', 'quantity', 'created_at']
      rows = await dbAll<Record<string, unknown>>(`SELECT id, product_id, buyer_id, seller_id, status, total_amount, quantity, created_at FROM orders ORDER BY created_at DESC LIMIT ?`, [ADMIN_EXPORT_LIMIT])
    } else if (kind === 'disputes') {
      headers = ['id', 'order_id', 'initiator_id', 'defendant_id', 'status', 'ruling_type', 'created_at', 'resolved_at']
      rows = await dbAll<Record<string, unknown>>(`SELECT id, order_id, initiator_id, defendant_id, status, ruling_type, created_at, resolved_at FROM disputes ORDER BY created_at DESC LIMIT ?`, [ADMIN_EXPORT_LIMIT])
    } else if (kind === 'reward_log') {
      headers = ['id', 'user_id', 'amount', 'source', 'ref', 'created_at']
      rows = await dbAll<Record<string, unknown>>(`SELECT id, user_id, amount, source, ref, created_at FROM platform_reward_log ORDER BY created_at DESC LIMIT ?`, [ADMIN_EXPORT_LIMIT])
    } else if (kind === 'feedback') {
      headers = ['id', 'user_id', 'category', 'severity', 'subject', 'status', 'created_at']
      rows = await dbAll<Record<string, unknown>>(`SELECT id, user_id, category, severity, subject, status, created_at FROM feedback_tickets ORDER BY created_at DESC LIMIT ?`, [ADMIN_EXPORT_LIMIT])
    } else {
      return void res.status(400).json({ error: 'kind 必须 users/orders/disputes/reward_log/feedback' })
    }
    const lines = [headers.join(',')]
    for (const r of rows) lines.push(headers.map(h => csvEscapeAdmin(r[h])).join(','))
    const truncated = rows.length >= ADMIN_EXPORT_LIMIT
    const filename = `webaz-${kind}-${new Date().toISOString().slice(0, 10)}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    if (truncated) {
      res.setHeader('X-Truncated', '1')
      res.setHeader('X-Truncated-Limit', String(ADMIN_EXPORT_LIMIT))
      res.setHeader('Access-Control-Expose-Headers', 'X-Truncated, X-Truncated-Limit')
    }
    res.send('﻿' + lines.join('\n'))
  })

  app.post('/api/admin/ai/anomaly-check/:user_id', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const uid = req.params.user_id
    const u = await dbOne<Record<string, unknown>>("SELECT id, name, handle, role, created_at FROM users WHERE id = ?", [uid])
    if (!u) return void res.status(404).json({ error: '用户不存在' })
    const orders = (await dbOne<{ n: number; gmv: number }>(`SELECT COUNT(*) as n, COALESCE(SUM(total_amount),0) as gmv FROM orders WHERE buyer_id=? OR seller_id=?`, [uid, uid]))!
    const completed = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE (buyer_id=? OR seller_id=?) AND status='completed'`, [uid, uid]))!.n
    const disputes = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM disputes WHERE initiator_id=? OR defendant_id=?`, [uid, uid]))!.n
    const withdrawals = (await dbOne<{ n: number; t: number }>(`SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as t FROM withdrawal_requests WHERE user_id=?`, [uid]))!
    const repNegEvents = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM reputation_events WHERE user_id=? AND points < 0`, [uid]))!.n
    const accountAgeDays = u.created_at ? Math.floor((Date.now() - new Date(u.created_at as string).getTime()) / 86400_000) : 0

    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `你是 WebAZ 风控分析师。基于以下数据评估账户异常风险（0-100，越高越危险）：
账户: ${u.handle || u.id} (${u.role}) · 注册 ${accountAgeDays} 天
订单总数: ${orders.n} (完成 ${completed}) · 总额 ${orders.gmv} WAZ
争议: ${disputes} 次
提现: ${withdrawals.n} 次 · ${withdrawals.t} WAZ
负面信誉事件: ${repNegEvents}

只返回 JSON（无前后缀）：
{
  "risk_score": 0-100 数字,
  "level": "low" | "medium" | "high",
  "flags": ["string 数组，2-5 个异常点"],
  "recommendation": "1-2 句建议（suspend/observe/clear）"
}`,
        }],
      })
      const text = (message.content[0] as { type: string; text?: string })?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return void res.status(500).json({ error: 'AI 返回格式错误' })
      const parsed = JSON.parse(m[0])
      res.json({ ...parsed, user_summary: { id: u.id, handle: u.handle, role: u.role, account_age_days: accountAgeDays, orders, completed, disputes, withdrawals, neg_rep_events: repNegEvents } })
    } catch (e) {
      res.status(503).json({ error: 'AI 失败: ' + (e as Error).message })
    }
  })

  app.post('/api/admin/_dev/recompute-value-badges', (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'admin') return void res.status(403).json({ error: '仅 admin' })
    const r = computeValueBadges()
    res.json({ ok: true, ...r })
  })

  app.post('/api/admin/reputation/decay', (req, res) => {
    const user = auth(req, res); if (!user) return
    // gate 维持现状(任一 admin);收紧到 requireUsersAdmin / protocol 权限是 gate 变更(非纯增量),留作 follow-up。
    if (user.role !== 'admin') return void res.status(403).json({ error: '仅管理员' })
    const force = !!req.body?.force
    const r = applyDecayIfDue(db, { force }) as { applied?: boolean; affected?: number; rate?: number } | null
    // 审计:管理员触发的全局声誉衰减 → 记触发者 + 入参 + 结果(无论是否真正执行,记录这次触发)。
    try {
      logAdminAction(user.id as string, 'reputation_decay', 'protocol', null, {
        force, applied: r?.applied ?? null, affected: r?.affected ?? null, rate: r?.rate ?? null,
      })
    } catch (e) { console.error('[reputation_decay audit]', e) }
    res.json(r)
  })

  app.get('/api/admin/errors', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!hasAdminPermission(user, 'protocol')) return void res.status(403).json({ error: 'forbidden' })
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const source = req.query.source ? String(req.query.source) : ''
    const where = source ? 'WHERE source = ?' : ''
    const args: unknown[] = source ? [source, limit] : [limit]
    const rows = await dbAll(`SELECT * FROM error_log ${where} ORDER BY id DESC LIMIT ?`, args)
    res.json({ items: rows })
  })

  // Tier 1 #5: 错误聚合 view（24h / 1h 趋势 + top by source + top messages + burst alert）
  app.get('/api/admin/errors/aggregate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!hasAdminPermission(user, 'protocol')) return void res.status(403).json({ error: 'forbidden' })
    // 24h 按 source 聚合 + 1h 数 + 最近时间（COALESCE 防 SUM null）
    const bySource = await dbAll<{ source: string; cnt_24h: number; cnt_1h: number; cnt_10m: number; last_seen: string }>(`
      SELECT source,
             COUNT(*) as cnt_24h,
             COALESCE(SUM(CASE WHEN created_at > datetime('now', '-1 hour') THEN 1 ELSE 0 END), 0) as cnt_1h,
             COALESCE(SUM(CASE WHEN created_at > datetime('now', '-10 minutes') THEN 1 ELSE 0 END), 0) as cnt_10m,
             MAX(created_at) as last_seen
      FROM error_log
      WHERE created_at > datetime('now', '-24 hours')
      GROUP BY source
      ORDER BY cnt_24h DESC
    `)
    // top 10 重复错误（前 100 字符聚合）
    const topMessages = await dbAll<{ msg: string; source: string; cnt: number; last_seen: string }>(`
      SELECT substr(message, 1, 100) as msg, source, COUNT(*) as cnt, MAX(created_at) as last_seen
      FROM error_log
      WHERE created_at > datetime('now', '-24 hours')
      GROUP BY substr(message, 1, 100), source
      ORDER BY cnt DESC LIMIT 10
    `)
    // 总数
    const totals = (await dbOne<{ total_24h: number; total_1h: number; total_10m: number }>(`
      SELECT
        COUNT(*) as total_24h,
        COALESCE(SUM(CASE WHEN created_at > datetime('now', '-1 hour') THEN 1 ELSE 0 END), 0) as total_1h,
        COALESCE(SUM(CASE WHEN created_at > datetime('now', '-10 minutes') THEN 1 ELSE 0 END), 0) as total_10m
      FROM error_log
      WHERE created_at > datetime('now', '-24 hours')
    `))!
    // burst alert: 1h 内任一 source > 50，或 10min > 20 → 标红
    const BURST_1H = 50
    const BURST_10M = 20
    const burst = bySource.filter(r => r.cnt_1h > BURST_1H || r.cnt_10m > BURST_10M)
      .map(r => ({
        source: r.source,
        reason: r.cnt_10m > BURST_10M
          ? `10min ${r.cnt_10m} > ${BURST_10M}`
          : `1h ${r.cnt_1h} > ${BURST_1H}`,
      }))
    res.json({
      totals,
      by_source: bySource,
      top_messages: topMessages,
      burst,
      thresholds: { burst_1h: BURST_1H, burst_10m: BURST_10M },
    })
  })
}
