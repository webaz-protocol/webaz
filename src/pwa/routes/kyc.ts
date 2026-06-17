/**
 * KYC 用户端 — 提交 + 查询自己的认证状态
 *
 * 由 #1013 Phase 97 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/kyc/submit  提交（4 类证件 + last4 + sha256(id + master_seed)，已通过/审核中拒绝）
 *   GET  /api/kyc/me      查自己的状态（last4 + status + reject_reason）
 *
 * 跨域注入：auth + MASTER_SEED
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface KycDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  MASTER_SEED: string
}

export function registerKycRoutes(app: Application, deps: KycDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth, MASTER_SEED } = deps

  const VALID_KYC_ID_TYPES = new Set(['passport', 'national_id', 'driver_license', 'other'])

  app.post('/api/kyc/submit', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { real_name, id_type, id_number } = req.body || {}
    if (!real_name || String(real_name).trim().length < 2) return void res.status(400).json({ error: '真实姓名不能为空' })
    if (!VALID_KYC_ID_TYPES.has(String(id_type))) return void res.status(400).json({ error: 'id_type 无效' })
    if (!id_number || String(id_number).trim().length < 6) return void res.status(400).json({ error: '证件号无效' })
    const idStr = String(id_number).trim()
    const idHash = createHash('sha256').update(idStr + MASTER_SEED).digest('hex')
    const idLast4 = idStr.slice(-4)
    // 已存在？必须先 admin reject 或允许重新提交
    const existing = await dbOne<{ status: string }>('SELECT status FROM kyc_records WHERE user_id = ?', [user.id])
    if (existing && existing.status === 'approved') return void res.status(400).json({ error: '已通过认证，无需重复提交' })
    if (existing && existing.status === 'pending') return void res.status(400).json({ error: '审核中，请耐心等待' })
    await dbRun(`INSERT INTO kyc_records (user_id, real_name, id_type, id_number_hash, id_number_last4, status, submitted_at)
      VALUES (?,?,?,?,?,'pending', datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET real_name = excluded.real_name, id_type = excluded.id_type,
        id_number_hash = excluded.id_number_hash, id_number_last4 = excluded.id_number_last4,
        status = 'pending', reject_reason = NULL, submitted_at = datetime('now')`,
      [user.id, String(real_name).trim().slice(0, 60), String(id_type), idHash, idLast4])
    res.json({ success: true, status: 'pending' })
  })

  app.get('/api/kyc/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne('SELECT status, id_type, id_number_last4, reject_reason, submitted_at, reviewed_at FROM kyc_records WHERE user_id = ?', [user.id])
    res.json({ kyc: row || null })
  })
}
