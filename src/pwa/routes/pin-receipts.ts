/**
 * Pin receipts — pinner + recipient 双签
 *
 * 由 #1013 Phase 71 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/pin-receipts        recipient 提交（含 pinner_sig + recipient_sig）
 *   GET  /api/pin-receipts/mine   我作为 pinner 的累计 / 待结算 / 最近
 *
 * 防刷：同 (manifest, pinner, recipient) 24h 内仅接 1 条
 * 限制：bytes_served ∈ (0, 500MB]，pinner_id ≠ self
 *
 * 跨域注入：auth + generateId
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface PinReceiptsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerPinReceiptsRoutes(app: Application, deps: PinReceiptsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, generateId } = deps

  app.post('/api/pin-receipts', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const { manifest_hash, pinner_id, bytes_served, served_at, pinner_sig, recipient_sig } = req.body || {}
    if (!manifest_hash || !pinner_id || !pinner_sig || !recipient_sig || !served_at) {
      return void res.json({ error: '缺少字段' })
    }
    if (typeof bytes_served !== 'number' || bytes_served <= 0 || bytes_served > 500 * 1024 * 1024) {
      return void res.json({ error: 'bytes_served 不合法' })
    }
    if (pinner_id === me.id) return void res.json({ error: 'pinner 不能是自己' })
    const m = await dbOne<{ 1: number }>("SELECT 1 FROM manifest_registry WHERE hash = ? AND status = 'active'", [manifest_hash])
    if (!m) return void res.json({ error: 'manifest 不存在或已下架' })
    const dup = await dbOne(`SELECT id FROM pin_receipts WHERE manifest_hash = ? AND pinner_id = ? AND recipient_id = ? AND served_at > datetime('now', '-1 day')`, [manifest_hash, pinner_id, me.id])
    if (dup) return void res.json({ error: '24 小时内已有相同 pin 回执' })

    const id = generateId('pin')
    await dbRun(`INSERT INTO pin_receipts (id, manifest_hash, pinner_id, recipient_id, bytes_served, served_at, pinner_sig, recipient_sig)
                VALUES (?,?,?,?,?,?,?,?)`,
      [id, manifest_hash, pinner_id, me.id, bytes_served, served_at, pinner_sig, recipient_sig])
    await dbRun(`UPDATE peer_directory SET bytes_served_total = bytes_served_total + ? WHERE peer_id = ? AND manifest_hash = ?`,
      [bytes_served, pinner_id, manifest_hash])
    res.json({ ok: true, id })
  })

  app.get('/api/pin-receipts/mine', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const earned = (await dbOne<{ total: number; count: number }>(`SELECT COALESCE(SUM(rewarded_waz), 0) as total, COUNT(*) as count FROM pin_receipts WHERE pinner_id = ? AND rewarded_at IS NOT NULL`, [me.id]))!
    const pending = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM pin_receipts WHERE pinner_id = ? AND rewarded_at IS NULL`, [me.id]))!
    const recent = await dbAll(`SELECT p.*, m.title as manifest_title FROM pin_receipts p LEFT JOIN manifest_registry m ON m.hash = p.manifest_hash WHERE p.pinner_id = ? ORDER BY p.served_at DESC LIMIT 20`, [me.id])
    res.json({ earned, pending_count: pending.n, recent })
  })
}
