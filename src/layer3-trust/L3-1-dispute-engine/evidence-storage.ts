// L0-4 证据上传通道 — 内容寻址 blob 存储 + HMAC 签名 + 哈希再校验 + TTL 清理
// 原则：信息谁创造谁存储；server 只存 blob + hash + sig；过期自动清理

import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash, createHmac } from 'crypto'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

const EVIDENCE_DIR = path.join(os.homedir(), '.webaz', 'evidence')
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

export const EVIDENCE_MAX_BYTES = 20 * 1024 * 1024
export const EVIDENCE_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
  'text/plain',
])
export const EVIDENCE_TTL_DAYS_AFTER_RESOLVED = 90

function blobPathFor(hash: string): string {
  const sub = hash.slice(0, 2)
  const dir = path.join(EVIDENCE_DIR, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, hash)
}

export function ensureEvidenceColumns(db: Database.Database) {
  const cols = [
    `ALTER TABLE evidence ADD COLUMN size INTEGER DEFAULT 0`,
    `ALTER TABLE evidence ADD COLUMN mime TEXT`,
    `ALTER TABLE evidence ADD COLUMN sig TEXT`,
    `ALTER TABLE evidence ADD COLUMN dispute_id TEXT`,
    `ALTER TABLE evidence ADD COLUMN expires_at TEXT`,
    `ALTER TABLE evidence ADD COLUMN withdrawn_at TEXT`,
    `ALTER TABLE evidence ADD COLUMN filename TEXT`,
    // 跨窗反诈一致性：W4 仲裁陈述/证据描述也跑 detectFraud
    `ALTER TABLE evidence ADD COLUMN flag_reasons TEXT`,
  ]
  for (const stmt of cols) {
    try { db.exec(stmt) } catch { /* 列已存在 */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_dispute ON evidence(dispute_id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_uploader ON evidence(uploader_id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_expires ON evidence(expires_at)') } catch {}
}

function canonicalEvidenceMeta(m: {
  uploaderId: string; disputeId: string; hash: string;
  size: number; mime: string; description: string
}): string {
  return [m.uploaderId, m.disputeId, m.hash, String(m.size), m.mime, m.description].join('|')
}

// PR-E:被指派仲裁员读/写证据须【仍是 active whitelist】—— suspended/revoked 立即失去权限。表缺失 → 视为非 active。
function isActiveArbitratorWL(db: Database.Database, userId: string): boolean {
  try {
    const wl = db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id = ?').get(userId) as { status: string | null } | undefined
    return !!wl && ((wl.status ?? 'active') === 'active')   // legacy NULL = active
  } catch { return false }
}

function isPartyOrArbitrator(db: Database.Database, disputeId: string, userId: string): boolean {
  const dispute = db.prepare('SELECT order_id, initiator_id, defendant_id, assigned_arbitrators FROM disputes WHERE id = ?').get(disputeId) as Record<string, unknown> | undefined
  if (!dispute) return false
  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?').get(dispute.order_id as string) as Record<string, string | null> | undefined
  const caseParties = new Set([
    order?.buyer_id, order?.seller_id, order?.logistics_id,
    dispute.initiator_id as string, dispute.defendant_id as string,
  ].filter(Boolean) as string[])
  if (caseParties.has(userId)) return true
  // 仅【指派本案 且 当前 active】的仲裁员可读/写证据。
  const arbitrators: string[] = JSON.parse((dispute.assigned_arbitrators as string) || '[]')
  return arbitrators.includes(userId) && isActiveArbitratorWL(db, userId)
}

export function uploadEvidence(
  db: Database.Database,
  args: {
    uploaderId: string
    uploaderApiKey: string
    disputeId: string
    blob: Buffer
    declaredHash: string
    mime: string
    description: string
    filename?: string
  }
): { id: string; hash: string; sig: string; dedup: boolean; size: number } {
  if (!args.blob || args.blob.length === 0) throw new Error('evidence_empty')
  if (args.blob.length > EVIDENCE_MAX_BYTES) throw new Error('evidence_too_large')
  if (!EVIDENCE_ALLOWED_MIME.has(args.mime)) throw new Error('evidence_mime_not_allowed')
  if (!args.description || args.description.length < 4) throw new Error('evidence_description_too_short')
  if (args.description.length > 500) throw new Error('evidence_description_too_long')

  const actualHash = createHash('sha256').update(args.blob).digest('hex')
  if (actualHash !== args.declaredHash) throw new Error('evidence_hash_mismatch')

  const dispute = db.prepare('SELECT order_id, status FROM disputes WHERE id = ?').get(args.disputeId) as { order_id: string; status: string } | undefined
  if (!dispute) throw new Error('dispute_not_found')
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    throw new Error('dispute_already_closed')
  }
  if (!isPartyOrArbitrator(db, args.disputeId, args.uploaderId)) {
    throw new Error('not_dispute_party')
  }

  const sig = createHmac('sha256', args.uploaderApiKey)
    .update(canonicalEvidenceMeta({
      uploaderId: args.uploaderId,
      disputeId: args.disputeId,
      hash: actualHash,
      size: args.blob.length,
      mime: args.mime,
      description: args.description,
    })).digest('hex')

  const bp = blobPathFor(actualHash)
  const blobExists = fs.existsSync(bp)

  const evType = args.mime.startsWith('image/') ? 'photo'
    : args.mime.startsWith('video/') ? 'video'
    : args.mime === 'application/pdf' ? 'document'
    : 'document'

  const eid = generateId('evt')
  // 审计加固（A）：DB INSERT + party_evidence_ids 更新一个事务；blob 落盘放到 commit 后
  // 这样 INSERT 失败 → blob 没写 → 无孤儿；blob 写失败 → tombstone row
  db.transaction(() => {
    db.prepare(`
      INSERT INTO evidence (id, order_id, uploader_id, type, description, file_path, file_hash, size, mime, sig, dispute_id, filename)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eid, dispute.order_id, args.uploaderId, evType, args.description,
           `evidence/${actualHash.slice(0, 2)}/${actualHash}`, actualHash,
           args.blob.length, args.mime, sig, args.disputeId, args.filename || null)

    const d = db.prepare('SELECT party_evidence_ids FROM disputes WHERE id = ?').get(args.disputeId) as { party_evidence_ids: string } | undefined
    if (d) {
      const arr: string[] = JSON.parse(d.party_evidence_ids || '[]')
      arr.push(eid)
      db.prepare('UPDATE disputes SET party_evidence_ids = ? WHERE id = ?').run(JSON.stringify(arr), args.disputeId)
    }
  })()

  // INSERT 已提交后再落盘；写失败 → 立刻 tombstone（withdrawn_at）防止 readEvidence 返 evidence_blob_missing 给参与方
  if (!blobExists) {
    try {
      fs.writeFileSync(bp, args.blob)
    } catch (e) {
      db.prepare(`UPDATE evidence SET withdrawn_at = datetime('now') WHERE id = ?`).run(eid)
      throw new Error('evidence_blob_write_failed')
    }
  }

  return { id: eid, hash: actualHash, sig, dedup: blobExists, size: args.blob.length }
}

// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点均 inTx=false)。
//   注:isPartyOrArbitrator(被同步写 uploadEvidence 复用)保持同步,留 Phase 3;async 读内同步调用它 OK(其 db.prepare 仍同步)。
export async function readEvidenceBlob(
  db: Database.Database,
  evidenceId: string,
  requesterId: string,
): Promise<{ blob: Buffer; mime: string; filename: string | null; hash: string }> {
  const ev = await dbOne<Record<string, unknown>>('SELECT id, dispute_id, file_hash, mime, filename, withdrawn_at FROM evidence WHERE id = ?', [evidenceId])
  if (!ev) throw new Error('evidence_not_found')
  if (ev.withdrawn_at) throw new Error('evidence_withdrawn')
  if (!isPartyOrArbitrator(db, ev.dispute_id as string, requesterId)) {
    throw new Error('not_dispute_party')
  }

  const bp = blobPathFor(ev.file_hash as string)
  if (!fs.existsSync(bp)) throw new Error('evidence_blob_missing')
  const blob = fs.readFileSync(bp)

  const actualHash = createHash('sha256').update(blob).digest('hex')
  if (actualHash !== ev.file_hash) throw new Error('evidence_corrupted')

  return {
    blob,
    mime: (ev.mime as string) || 'application/octet-stream',
    filename: (ev.filename as string) || null,
    hash: ev.file_hash as string,
  }
}

export function withdrawEvidence(db: Database.Database, evidenceId: string, uploaderId: string): void {
  const ev = db.prepare('SELECT uploader_id, dispute_id, withdrawn_at FROM evidence WHERE id = ?').get(evidenceId) as Record<string, unknown> | undefined
  if (!ev) throw new Error('evidence_not_found')
  if (ev.uploader_id !== uploaderId) throw new Error('not_uploader')
  if (ev.withdrawn_at) return

  const dispute = db.prepare('SELECT status FROM disputes WHERE id = ?').get(ev.dispute_id) as { status: string } | undefined
  if (dispute && (dispute.status === 'resolved' || dispute.status === 'dismissed')) {
    throw new Error('dispute_closed_cannot_withdraw')
  }

  db.prepare(`UPDATE evidence SET withdrawn_at = datetime('now') WHERE id = ?`).run(evidenceId)
  const d = db.prepare('SELECT party_evidence_ids FROM disputes WHERE id = ?').get(ev.dispute_id) as { party_evidence_ids: string } | undefined
  if (d) {
    const arr: string[] = JSON.parse(d.party_evidence_ids || '[]')
    const filtered = arr.filter(x => x !== evidenceId)
    db.prepare('UPDATE disputes SET party_evidence_ids = ? WHERE id = ?').run(JSON.stringify(filtered), ev.dispute_id)
  }
}

export async function listEvidence(db: Database.Database, disputeId: string, requesterId: string) {
  if (!isPartyOrArbitrator(db, disputeId, requesterId)) {
    throw new Error('not_dispute_party')
  }
  return await dbAll(`
    SELECT id, uploader_id, type, description, file_hash, size, mime, sig, filename, created_at, withdrawn_at
    FROM evidence
    WHERE dispute_id = ?
    ORDER BY created_at ASC
  `, [disputeId])
}

export function markEvidenceExpiry(db: Database.Database, disputeId: string): void {
  const exp = new Date(Date.now() + EVIDENCE_TTL_DAYS_AFTER_RESOLVED * 24 * 3600 * 1000).toISOString()
  db.prepare(`UPDATE evidence SET expires_at = ? WHERE dispute_id = ? AND expires_at IS NULL`).run(exp, disputeId)
}

export function cleanupExpiredEvidence(db: Database.Database): { swept: number; bytes: number } {
  const candidates = db.prepare(`
    SELECT DISTINCT file_hash FROM evidence
    WHERE (withdrawn_at IS NOT NULL OR (expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')))
      AND file_hash IS NOT NULL
  `).all() as Array<{ file_hash: string }>

  let swept = 0
  let bytes = 0
  for (const c of candidates) {
    const live = db.prepare(`
      SELECT 1 FROM evidence
      WHERE file_hash = ?
        AND withdrawn_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) >= datetime('now'))
      LIMIT 1
    `).get(c.file_hash)
    if (live) continue

    const bp = blobPathFor(c.file_hash)
    if (fs.existsSync(bp)) {
      try {
        bytes += fs.statSync(bp).size
        fs.unlinkSync(bp)
        swept++
      } catch { /* concurrent cleanup */ }
    }
  }
  return { swept, bytes }
}

export async function verifyEvidenceSig(
  _db: Database.Database,
  evidenceId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ev = await dbOne<Record<string, unknown>>(`
    SELECT e.id, e.uploader_id, e.dispute_id, e.file_hash, e.size, e.mime, e.description, e.sig,
           u.api_key
    FROM evidence e JOIN users u ON u.id = e.uploader_id
    WHERE e.id = ?
  `, [evidenceId])
  if (!ev) return { ok: false, reason: 'evidence_not_found' }
  if (!ev.sig) return { ok: false, reason: 'no_sig' }

  const expected = createHmac('sha256', ev.api_key as string).update(canonicalEvidenceMeta({
    uploaderId: ev.uploader_id as string,
    disputeId: ev.dispute_id as string,
    hash: ev.file_hash as string,
    size: ev.size as number,
    mime: ev.mime as string,
    description: ev.description as string,
  })).digest('hex')

  return expected === ev.sig ? { ok: true } : { ok: false, reason: 'sig_mismatch' }
}
