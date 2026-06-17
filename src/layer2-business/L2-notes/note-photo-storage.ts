// 笔记图片 — 内容寻址 blob 存储（复用 evidence-storage 模式）
// 原则：买家无 P2P 节点 → server 持有 blob + hash；图片 hash 跨笔记唯一（防剽窃）
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

const NOTE_PHOTO_DIR = path.join(os.homedir(), '.webaz', 'note-photos')
if (!fs.existsSync(NOTE_PHOTO_DIR)) fs.mkdirSync(NOTE_PHOTO_DIR, { recursive: true })

export const NOTE_PHOTO_MAX_BYTES = 5 * 1024 * 1024   // 5MB / 张 — 比证据更小（笔记图典型 JPG）
export const NOTE_PHOTO_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp',
])

function blobPathFor(hash: string): string {
  const sub = hash.slice(0, 2)
  const dir = path.join(NOTE_PHOTO_DIR, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, hash)
}

export function blobPathForHash(hash: string): string {
  return blobPathFor(hash)
}

export function noteBlobExists(hash: string): boolean {
  return fs.existsSync(blobPathFor(hash))
}

// 写 blob，返回是否 dedup（已存在则不重写）
export function writeNotePhoto(blob: Buffer, declaredHash: string, mime: string): { hash: string; dedup: boolean; size: number } {
  if (!blob || blob.length === 0) throw new Error('photo_empty')
  if (blob.length > NOTE_PHOTO_MAX_BYTES) throw new Error('photo_too_large')
  if (!NOTE_PHOTO_ALLOWED_MIME.has(mime)) throw new Error('photo_mime_not_allowed')
  const actualHash = createHash('sha256').update(blob).digest('hex')
  if (actualHash !== declaredHash) throw new Error('photo_hash_mismatch')

  const bp = blobPathFor(actualHash)
  if (fs.existsSync(bp)) return { hash: actualHash, dedup: true, size: blob.length }
  fs.writeFileSync(bp, blob)
  return { hash: actualHash, dedup: false, size: blob.length }
}

export function readNotePhoto(hash: string): { blob: Buffer; mime: string } {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('photo_bad_hash')
  const bp = blobPathFor(hash)
  if (!fs.existsSync(bp)) throw new Error('photo_not_found')
  const blob = fs.readFileSync(bp)
  // 完整性二次校验
  const actualHash = createHash('sha256').update(blob).digest('hex')
  if (actualHash !== hash) throw new Error('photo_corrupted')
  // mime 用 magic byte 嗅探（不依赖 db 字段）
  const mime = sniffImageMime(blob)
  return { blob, mime }
}

function sniffImageMime(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

// 清理孤儿 blob — disk 上有但 note_photo_index 没引用的 hash
// graceMs：刚上传但还没创建笔记的图片需要保留窗口（默认 1 小时）
//   - 用户先 POST /api/notes/photo 拿 hash
//   - 再 POST /api/shareables 把 hash 写进 note_photo_index
//   - 中间窗口（典型 几十秒）误删会让上传白费
// 由 cron 每天调一次（与 evidence cleanup 同节奏）
// RFC-016 Phase 1:cron 清理 —— db 部分是纯读(查引用),迁异步 seam;文件删除为 fs 操作(非 db)。调用点 server.ts:9262 cron,inTx=false。
export async function cleanupOrphanNotePhotos(_db: Database.Database, graceMs = 60 * 60 * 1000): Promise<{ swept: number; bytes: number }> {
  if (!fs.existsSync(NOTE_PHOTO_DIR)) return { swept: 0, bytes: 0 }
  let swept = 0
  let bytes = 0
  const now = Date.now()
  let subs: string[]
  try { subs = fs.readdirSync(NOTE_PHOTO_DIR) } catch { return { swept: 0, bytes: 0 } }
  for (const sub of subs) {
    const subPath = path.join(NOTE_PHOTO_DIR, sub)
    let stat: fs.Stats
    try { stat = fs.statSync(subPath) } catch { continue }
    if (!stat.isDirectory()) continue
    let files: string[]
    try { files = fs.readdirSync(subPath) } catch { continue }
    for (const fname of files) {
      if (!/^[0-9a-f]{64}$/.test(fname)) continue   // 跳过非内容寻址文件
      const fp = path.join(subPath, fname)
      let fstat: fs.Stats
      try { fstat = fs.statSync(fp) } catch { continue }
      // Math.max(0, ...) 防文件系统亚毫秒级时间戳偏差导致 age 为负
      // 否则 graceMs=0 时永远 skip（mtime 取自 stat 可能比 Date.now() 大几十微秒）
      const age = Math.max(0, now - fstat.mtimeMs)
      if (age < graceMs) continue   // grace 窗口内保留
      const row = await dbOne(`SELECT 1 FROM note_photo_index WHERE hash = ?`, [fname])
      if (!row) {
        try {
          bytes += fstat.size
          fs.unlinkSync(fp)
          swept++
        } catch { /* 并发清理或权限错误 */ }
      }
    }
  }
  return { swept, bytes }
}
