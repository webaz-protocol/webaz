/**
 * Peer directory — 在线节点心跳 + 退出
 *
 * 由 #1013 Phase 102 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST   /api/peers/heartbeat   上报本节点持有的 manifest hash 列表（验 active）
 *   DELETE /api/peers/:hash       从在线列表移除某 hash
 *
 * 跨域注入：auth
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface PeersDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerPeersRoutes(app: Application, deps: PeersDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth } = deps

  app.post('/api/peers/heartbeat', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : []
    const pinIntents = Array.isArray(req.body?.pin_intents) ? new Set(req.body.pin_intents) : new Set()
    const now = new Date().toISOString()
    let registered = 0
    for (const h of hashes) {
      if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) continue
      const m = await dbOne<{ owner_id: string; status: string }>("SELECT owner_id, status FROM manifest_registry WHERE hash = ?", [h])
      if (!m || m.status !== 'active') continue
      const isOwner = m.owner_id === me.id ? 1 : 0
      const pinIntent = pinIntents.has(h) ? 1 : 0
      await dbRun(`INSERT INTO peer_directory (peer_id, manifest_hash, is_owner, pin_intent, last_heartbeat)
                  VALUES (?,?,?,?,?)
                  ON CONFLICT(peer_id, manifest_hash) DO UPDATE SET is_owner=excluded.is_owner, pin_intent=excluded.pin_intent, last_heartbeat=excluded.last_heartbeat`,
        [me.id, h, isOwner, pinIntent, now])
      registered++
    }
    res.json({ ok: true, registered })
  })

  app.delete('/api/peers/:hash', async (req, res) => {
    const me = auth(req, res); if (!me) return
    await dbRun("DELETE FROM peer_directory WHERE peer_id = ? AND manifest_hash = ?", [me.id, req.params.hash])
    res.json({ ok: true })
  })
}
