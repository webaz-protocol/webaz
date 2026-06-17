/**
 * Admin: 实时事件 stream (Wave F-5)
 *
 * 由 #1013 Phase 67 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET  /api/admin/events/recent      初始拉取最近 N 条
 *   POST /api/admin/events/ticket      P0-1: 60s 单次 ticket（避免 api_key 进 URL）
 *   GET  /api/admin/events/stream      SSE 推流（ticket 鉴权）
 *
 * 权限：admin 即可（任意分级 admin）
 *
 * P1-2 心跳：25s 一次 :ping，防反向代理 idle 关闭
 *
 * 跨域注入：requireAdmin + generateId + systemEventBuffer + SYSTEM_EVENT_BUFFER_SIZE
 *           + adminEventClients（Set，需共享引用）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminEventsDeps {
  db: Database.Database
  requireAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  systemEventBuffer: Record<string, unknown>[]
  SYSTEM_EVENT_BUFFER_SIZE: number
  adminEventClients: Set<Response>
}

export function registerAdminEventsRoutes(app: Application, deps: AdminEventsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne),不再直接用 deps.db
  const { requireAdmin, generateId, systemEventBuffer, SYSTEM_EVENT_BUFFER_SIZE, adminEventClients } = deps

  app.get('/api/admin/events/recent', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return
    const limit = Math.min(SYSTEM_EVENT_BUFFER_SIZE, Math.max(10, Number(req.query.limit) || 100))
    res.json({ items: systemEventBuffer.slice(-limit).reverse() })
  })

  // P0-1: 一次性 ticket — admin 用 api_key 换 60s 有效 ticket，SSE 用 ticket 鉴权
  const sseTickets = new Map<string, { userId: string; expiresAt: number }>()
  const cleanupSseTickets = () => {
    const now = Date.now()
    for (const [t, info] of sseTickets) if (info.expiresAt < now) sseTickets.delete(t)
  }

  app.post('/api/admin/events/ticket', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return
    cleanupSseTickets()
    const ticket = generateId('sse')
    sseTickets.set(ticket, { userId: String(admin.id), expiresAt: Date.now() + 60_000 })
    res.json({ ticket, expires_in: 60 })
  })

  app.get('/api/admin/events/stream', async (req, res) => {
    const ticket = String(req.query.ticket || '')
    cleanupSseTickets()
    const info = sseTickets.get(ticket)
    if (!info) return void res.status(403).json({ error: '无效或已过期的 ticket' })
    sseTickets.delete(ticket)  // 单次使用
    const u = await dbOne<{ role: string }>('SELECT role FROM users WHERE id = ?', [info.userId])
    if (!u || u.role !== 'admin') return void res.status(403).json({ error: '需要 admin 身份' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ type: 'hello', count: systemEventBuffer.length })}\n\n`)
    for (const evt of systemEventBuffer.slice(-50)) {
      try { res.write(`data: ${JSON.stringify(evt)}\n\n`) } catch {}
    }
    adminEventClients.add(res)
    const ping = setInterval(() => {
      try { res.write(':ping\n\n') } catch {}
    }, 25_000)
    req.on('close', () => {
      clearInterval(ping)
      adminEventClients.delete(res)
    })
  })
}
