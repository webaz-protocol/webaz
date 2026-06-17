/**
 * 通知 API 域
 *
 * 由 #1013 Phase 36 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET  /api/notifications/stream     SSE 实时推送（EventSource，URL ?key= 或 Bearer header）
 *   GET  /api/notifications            列表 + unread 计数
 *   POST /api/notifications/read       标已读（不传 id → 全部）
 *
 * 跨域：
 *   - getNotifications / getUnreadCount / markRead — L2-6 notification-engine
 *   - sseClients — 在 server.ts 顶层定义（其他模块如 broadcastSystemEvent 也用），注入
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { getNotifications, getUnreadCount, markRead } from '../../layer2-business/L2-6-notifications/notification-engine.js'

export interface NotificationsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  sseClients: Map<string, Response>
}

export function registerNotificationsRoutes(app: Application, deps: NotificationsDeps): void {
  const { db, auth, sseClients } = deps

  // SSE 实时推送流（EventSource 不支持自定义 header，URL ?key= 也兼容）
  app.get('/api/notifications/stream', async (req, res) => {
    const key = (req.query.key as string) ?? req.headers.authorization?.replace('Bearer ', '')
    const user = key ? await dbOne<Record<string, unknown>>('SELECT * FROM users WHERE api_key = ?', [key]) : null
    if (!user) return void res.status(401).end()

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    sseClients.set(user.id as string, res)

    // 连接时推送未读数
    const unread = await getUnreadCount(db, user.id as string)
    res.write(`data: ${JSON.stringify({ type: 'init', unread })}\n\n`)

    // 心跳保活（每 30s）
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch { clearInterval(heartbeat) }
    }, 30_000)

    req.on('close', () => {
      sseClients.delete(user.id as string)
      clearInterval(heartbeat)
    })
  })

  app.get('/api/notifications', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const onlyUnread = req.query.unread === '1'
    const notifs = await getNotifications(db, user.id as string, onlyUnread)
    const unread = await getUnreadCount(db, user.id as string)
    res.json({ unread, notifications: notifs })
  })

  app.post('/api/notifications/read', (req, res) => {
    const user = auth(req, res); if (!user) return
    markRead(db, user.id as string, req.body?.id as string | undefined)
    res.json({ success: true })
  })
}
