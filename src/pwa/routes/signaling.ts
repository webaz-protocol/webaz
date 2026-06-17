/**
 * WebRTC Signaling 中继（SDP / ICE 短期队列）
 *
 * 由 #1013 Phase 71 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/signaling/send      入队（offer/answer/ice，data ≤ 50KB）
 *   GET  /api/signaling/poll      取走未投递的（2 分钟窗口）
 *
 * P1 fix: 单条脏 signal_data 解析失败回退原字符串（不要封死握手）
 *
 * 跨域注入：auth + generateId
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface SignalingDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerSignalingRoutes(app: Application, deps: SignalingDeps): void {
  // db 已走 RFC-016 异步 seam(dbAll/dbRun),不再直接用 deps.db
  const { auth, generateId } = deps

  app.post('/api/signaling/send', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const { to, type, data } = req.body || {}
    if (!to || !type || !data) return void res.json({ error: '缺少参数' })
    if (!['offer', 'answer', 'ice'].includes(type)) return void res.json({ error: 'type 不合法' })
    if (JSON.stringify(data).length > 50000) return void res.json({ error: 'data 过大' })
    await dbRun(`INSERT INTO signaling_queue (id, to_peer_id, from_peer_id, signal_type, signal_data, created_at)
                VALUES (?,?,?,?,?,datetime('now'))`,
      [generateId('sig'), to, me.id, type, JSON.stringify(data)])
    res.json({ ok: true })
  })

  app.get('/api/signaling/poll', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const rows = await dbAll<{ id: string; from_peer_id: string; signal_type: string; signal_data: string; created_at: string }>(`
      SELECT id, from_peer_id, signal_type, signal_data, created_at FROM signaling_queue
      WHERE to_peer_id = ? AND delivered_at IS NULL AND created_at > datetime('now', '-2 minutes')
      ORDER BY created_at ASC LIMIT 50
    `, [me.id])
    if (rows.length > 0) {
      const ids = rows.map(r => r.id)
      await dbRun(`UPDATE signaling_queue SET delivered_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    }
    res.json({ signals: rows.map(r => {
      let signal_data: unknown = null
      try { signal_data = JSON.parse(r.signal_data) } catch { signal_data = r.signal_data }
      return { ...r, signal_data }
    }) })
  })
}
