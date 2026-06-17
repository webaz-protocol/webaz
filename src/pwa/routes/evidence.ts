/**
 * 证据 (Evidence) 域 — L3-1 争议附件
 *
 * 由 #1013 Phase 53 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET    /api/evidence/:id/blob                     下载 blob（仅参与方/仲裁员）
 *   DELETE /api/evidence/:id                          撤回（仅上传者，未结案）
 *   GET    /api/evidence/:id/verify                   验签
 *   POST   /api/evidence-requests/:requestId/submit   当事人提交补充证据响应
 *
 * 留 server.ts：
 *   - POST /api/disputes/:id/request-evidence （仲裁员请求补充证据，紧耦合 disputes 域）
 *   - GET /api/disputes/:id/evidence-list（参与方列证据，紧耦合 disputes 域）
 *
 * 跨域：所有 helpers 从 L3-1 evidence-storage + dispute-engine module 内 import
 *      detectFraud 通过 deps 注入（chat.ts 已 export）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { readEvidenceBlob, withdrawEvidence, verifyEvidenceSig, listEvidence as listEvidenceFiles } from '../../layer3-trust/L3-1-dispute-engine/evidence-storage.js'
import { submitEvidenceForRequest, type EvidenceType } from '../../layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface EvidenceDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  detectFraud: (text: string) => string[]
}

export function registerEvidenceRoutes(app: Application, deps: EvidenceDeps): void {
  const { db, auth, detectFraud } = deps

  // 下载证据 blob（仅参与方/仲裁员）
  app.get('/api/evidence/:id/blob', async (req, res) => {
    const user = auth(req, res); if (!user) return
    try {
      const out = await readEvidenceBlob(db, req.params.id, user.id as string)
      res.setHeader('Content-Type', out.mime)
      res.setHeader('X-Content-Hash', out.hash)
      res.setHeader('Cache-Control', 'private, max-age=300')
      if (out.filename) {
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(out.filename)}`)
      }
      res.send(out.blob)
    } catch (e) {
      const msg = (e as Error).message
      const status = msg === 'not_dispute_party' ? 403
        : msg === 'evidence_not_found' || msg === 'evidence_blob_missing' ? 404
        : msg === 'evidence_withdrawn' ? 410
        : msg === 'evidence_corrupted' ? 500
        : 400
      res.status(status).json({ error: msg })
    }
  })

  // 撤回证据（仅上传者，争议未结案时）
  app.delete('/api/evidence/:id', (req, res) => {
    const user = auth(req, res); if (!user) return
    try {
      withdrawEvidence(db, req.params.id, user.id as string)
      res.json({ success: true })
    } catch (e) {
      const msg = (e as Error).message
      const status = msg === 'not_uploader' || msg === 'dispute_closed_cannot_withdraw' ? 403
        : msg === 'evidence_not_found' ? 404
        : 400
      res.status(status).json({ error: msg })
    }
  })

  // 验签 — 任意参与方
  app.get('/api/evidence/:id/verify', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const ev = await dbOne<{ dispute_id: string }>('SELECT dispute_id FROM evidence WHERE id = ?', [req.params.id])
    if (!ev) return void res.status(404).json({ error: 'evidence_not_found' })
    try { await listEvidenceFiles(db, ev.dispute_id, user.id as string) } // 复用鉴权
    catch { return void res.status(403).json({ error: 'not_dispute_party' }) }
    res.json(await verifyEvidenceSig(db, req.params.id))
  })

  // 当事人提交补充证据响应（仲裁员 request 后用）
  app.post('/api/evidence-requests/:requestId/submit', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { evidence_type = 'text', description, file_hash } = req.body
    if (!description?.trim()) return void res.json({ error: '请填写证据内容' })

    const rawDesc = String(description).trim()
    const result = submitEvidenceForRequest(
      db, req.params.requestId, user.id as string,
      evidence_type as EvidenceType, rawDesc, file_hash
    )
    if (!result.success) return void res.json({ error: result.error })
    // 跨窗反诈：写 flag_reasons
    const evReasons = detectFraud(rawDesc)
    if (evReasons.length > 0 && result.evidenceId) {
      try { await dbRun(`UPDATE evidence SET flag_reasons = ? WHERE id = ?`,
        [JSON.stringify(evReasons), result.evidenceId]) } catch {}
    }
    res.json({ success: true, evidence_id: result.evidenceId, anchor_hash: result.anchorHash, flag_reasons: evReasons })
  })
}
