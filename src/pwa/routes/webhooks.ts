/**
 * Webhooks 域 — 用户订阅事件 + 后端 HTTP 投递
 *
 * 由 #1013 Phase 7 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints + 1 cross-domain function:
 *   POST   /api/webhooks            — 订阅事件
 *   GET    /api/webhooks            — 我的订阅
 *   DELETE /api/webhooks/:id        — 取消订阅
 *   PATCH  /api/webhooks/:id        — toggle active
 *   POST   /api/webhooks/test       — 测试 endpoint 可达性
 *
 * + fireWebhooks(db, generateId, eventType, payload, userIds?) — 跨域调用
 *   被 charity / RFQ / orders 等多域调用，server.ts 通过 makeFireWebhooks 注入到各 deps
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { isPrivateOrInternalHost } from '../security/ssrf.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export const WEBHOOK_EVENT_TYPES = [
  'order.created','order.paid','order.shipped','order.delivered','order.completed','order.disputed',
  'wish.claimed','wish.proof','wish.confirmed','wish.repay','wish.repay_resp',
  'rfq.bid_received','rfq.awarded',
  'charity.donation','charity.fund_redirect',
] as const
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number]

// P2.2 失败通知：连续 5 次失败 → 自动 active=0 + 通知用户
// RFC-016: db 参数保留(调用方仍传),内部走异步 seam(同一实例,setSeamDb)。
async function recordWebhookFailure(_db: Database.Database, generateId: (prefix: string) => string, sub: Record<string, unknown>, errMsg: string): Promise<void> {
  await dbRun(`UPDATE webhook_subscriptions SET fail_count = fail_count + 1, last_error = ?, last_fired_at = datetime('now') WHERE id = ?`, [errMsg, sub.id])
  const after = (await dbOne<{ fail_count: number; active: number }>(`SELECT fail_count, active FROM webhook_subscriptions WHERE id = ?`, [sub.id]))!
  if (after.active && after.fail_count > 0 && after.fail_count % 5 === 0) {
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'webhook_fail',?,?,datetime('now'))`,
        [generateId('ntf'), sub.user_id, `⚠ Webhook 连续 ${after.fail_count} 次失败`, `${sub.event_type} → ${String(sub.target_url).slice(0, 60)}... · ${errMsg}`])
    } catch (e) { console.error('[webhook notify fail]', e) }
    // 失败 >= 20 次 → 自动暂停
    if (after.fail_count >= 20) {
      await dbRun(`UPDATE webhook_subscriptions SET active = 0 WHERE id = ?`, [sub.id])
    }
  }
}

// 触发 webhook 投递（v1 同步 fetch，超时 5s）
// 跨域 API — charity / RFQ / orders 等通过此函数广播事件
export async function fireWebhooks(
  _db: Database.Database,
  generateId: (prefix: string) => string,
  eventType: string,
  payload: Record<string, unknown>,
  userIds?: string[],
): Promise<void> {
  const where = userIds && userIds.length
    ? `event_type = ? AND active = 1 AND user_id IN (${userIds.map(() => '?').join(',')})`
    : `event_type = ? AND active = 1`
  const args: unknown[] = [eventType, ...(userIds || [])]
  const subs = await dbAll<Record<string, unknown>>(`SELECT * FROM webhook_subscriptions WHERE ${where}`, args)
  for (const sub of subs) {
    // P1.1 SSRF：投递前再次校验（防止旧订阅或 DB 直改绕过创建时检查）
    if (isPrivateOrInternalHost(String(sub.target_url))) {
      await dbRun(`UPDATE webhook_subscriptions SET fail_count = fail_count + 1, last_error = ?, active = 0 WHERE id = ?`,
        ['blocked: private/internal host', sub.id])
      continue
    }
    const body = JSON.stringify({ event: eventType, payload, ts: new Date().toISOString() })
    const sig = sub.secret ? createHmac('sha256', String(sub.secret)).update(body).digest('hex') : null
    try {
      const ctrl = new AbortController()
      const tm = setTimeout(() => ctrl.abort(), 5000)
      const r = await fetch(String(sub.target_url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-WebAZ-Signature': sig } : {}) },
        body, signal: ctrl.signal,
      })
      clearTimeout(tm)
      if (r.ok) {
        await dbRun(`UPDATE webhook_subscriptions SET fire_count = fire_count + 1, last_fired_at = datetime('now'), last_error = NULL WHERE id = ?`, [sub.id])
      } else {
        await recordWebhookFailure(_db, generateId, sub, 'HTTP ' + r.status)
      }
    } catch (e) {
      await recordWebhookFailure(_db, generateId, sub, String((e as Error).message).slice(0, 200))
    }
  }
}

export interface WebhookDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

export function registerWebhookRoutes(app: Application, deps: WebhookDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, generateId, rateLimitOk } = deps

  // POST 订阅
  app.post('/api/webhooks', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 10, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const body = req.body as Record<string, unknown>
    const url = String(body.target_url || '').trim()
    const eventType = String(body.event_type || '').trim()
    const secret = body.secret ? String(body.secret).slice(0, 200) : null
    if (!url.startsWith('https://')) return void res.json({ error: 'target_url 必须以 https:// 开头' })
    if (url.length > 500) return void res.json({ error: 'URL 过长' })
    // P1.1 SSRF 修复：拒绝私网/localhost/metadata 端点
    if (isPrivateOrInternalHost(url)) return void res.json({ error: 'target_url 不可指向私网/localhost/内部地址' })
    if (!WEBHOOK_EVENT_TYPES.includes(eventType as WebhookEventType)) return void res.json({ error: '不支持的 event_type' })
    // 每用户最多 20 个订阅
    const cnt = (await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM webhook_subscriptions WHERE user_id = ?`, [user.id]))!.n
    if (cnt >= 20) return void res.json({ error: '订阅数量上限 20' })
    const id = generateId('whk')
    await dbRun(`INSERT INTO webhook_subscriptions (id, user_id, event_type, target_url, secret) VALUES (?,?,?,?,?)`,
      [id, user.id, eventType, url, secret])
    res.json({ id, event_type: eventType, target_url: url })
  })

  // GET 我的订阅
  app.get('/api/webhooks', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const items = await dbAll(`SELECT id, event_type, target_url, active, last_fired_at, fire_count, fail_count, last_error, created_at
                              FROM webhook_subscriptions WHERE user_id = ? ORDER BY created_at DESC`, [user.id])
    res.json({ items, event_types: WEBHOOK_EVENT_TYPES })
  })

  // DELETE
  app.delete('/api/webhooks/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbRun(`DELETE FROM webhook_subscriptions WHERE id = ? AND user_id = ?`, [req.params.id, user.id])
    if (r.changes === 0) return void res.json({ error: '订阅不存在或非你所有' })
    res.json({ ok: true })
  })

  // PATCH active toggle
  app.patch('/api/webhooks/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const active = (req.body as Record<string, unknown>).active ? 1 : 0
    const r = await dbRun(`UPDATE webhook_subscriptions SET active = ? WHERE id = ? AND user_id = ?`, [active, req.params.id, user.id])
    if (r.changes === 0) return void res.json({ error: '订阅不存在' })
    res.json({ ok: true, active })
  })

  // P2.4 测试端点：subscribe 前先验 endpoint 可达 + 不私网
  app.post('/api/webhooks/test', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 5, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const body = req.body as Record<string, unknown>
    const url = String(body.target_url || '').trim()
    const secret = body.secret ? String(body.secret).slice(0, 200) : null
    if (!url.startsWith('https://')) return void res.json({ ok: false, error: 'target_url 必须 https://' })
    if (isPrivateOrInternalHost(url)) return void res.json({ ok: false, error: 'target_url 不可指向私网/localhost/内部地址' })
    const payload = JSON.stringify({ event: 'webaz.test_ping', payload: { hello: 'from WebAZ', user_id: user.id }, ts: new Date().toISOString() })
    const sig = secret ? createHmac('sha256', secret).update(payload).digest('hex') : null
    try {
      const ctrl = new AbortController()
      const tm = setTimeout(() => ctrl.abort(), 5000)
      const t0 = Date.now()
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-WebAZ-Signature': sig } : {}) },
        body: payload, signal: ctrl.signal,
      })
      clearTimeout(tm)
      const ms = Date.now() - t0
      if (r.ok) return void res.json({ ok: true, status: r.status, ms })
      return void res.json({ ok: false, status: r.status, ms, error: 'HTTP ' + r.status })
    } catch (e) {
      return void res.json({ ok: false, error: String((e as Error).message).slice(0, 200) })
    }
  })
}
