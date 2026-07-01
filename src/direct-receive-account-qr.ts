/**
 * Direct Pay (Rail 1) — 收款二维码图 存/取 + 账号审计事件 (Phase C1)。
 *
 * ⚠️ 安全边界(store-only, non-custodial):WebAZ 只把卖家上传的收款码【原始字节】存下、经硬化端点原样转发,
 *   【绝不】解析二维码含义、【绝不】验证收款方、【绝不】路由资金。校验只做"这是不是一张受限栅格图 + 不超限":
 *   - 仅 data:image/(png|webp);base64(拒 svg/html/text/jpeg —— 防 stored-XSS / 脚本化内容 / 有损坏码)
 *   - 解码字节 ≤ 64KB(先量字节再说,绝不 server 端 decode/resize —— 防图片炸弹)
 *   - magic bytes 必须与 mime 一致(防扩展名/类型混淆)
 * 内容寻址 + 不可变:ref = sha256(bytes),同图幂等复用;写入用 INSERT OR IGNORE,行【永不改/删】(schema 触发器兜底),
 *   这样订单能快照某个 ref 并在 D1/D2 ack 后取回【当时那一版】,卖家换码 = 新 ref 新行,旧行仍可取。
 * 审计:append-only 事件只记 account/qr ref,【绝不】写 raw instruction / raw QR。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'

export const QR_DATA_URI_RE = /^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/
export const QR_MAX_BYTES = 64 * 1024

export interface ValidatedQr { mime: 'image/png' | 'image/webp'; buf: Buffer; sha256: string }

/** PNG magic 8 bytes / WEBP RIFF....WEBP。仅接受与声明 mime 一致的字节。 */
function magicMatches(subtype: string, buf: Buffer): boolean {
  if (subtype === 'png') return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (subtype === 'webp') return buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  return false
}

/** PURE: 校验收款码 data-URI。返回 {ok, ...} 或 {ok:false, reason}。绝不解析二维码。 */
export function validateQrDataUri(dataUri: unknown): { ok: true; value: ValidatedQr } | { ok: false; reason: string } {
  const s = typeof dataUri === 'string' ? dataUri.trim() : ''
  const m = QR_DATA_URI_RE.exec(s)
  if (!m) return { ok: false, reason: 'QR must be a data:image/(png|webp);base64 image (svg/html/text/jpeg rejected)' }
  const subtype = m[1]
  let buf: Buffer
  try { buf = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64') } catch { return { ok: false, reason: 'QR base64 decode failed' } }
  if (buf.length === 0) return { ok: false, reason: 'QR is empty' }
  if (buf.length > QR_MAX_BYTES) return { ok: false, reason: `QR must decode to ≤ ${QR_MAX_BYTES} bytes` }
  if (!magicMatches(subtype, buf)) return { ok: false, reason: `QR bytes do not match declared image/${subtype} (magic-byte mismatch)` }
  const sha256 = createHash('sha256').update(buf).digest('hex')
  return { ok: true, value: { mime: `image/${subtype}` as ValidatedQr['mime'], buf, sha256 } }
}

export type AccountEventType = 'account_added' | 'account_updated' | 'account_deactivated' | 'qr_uploaded'
/** append-only 审计事件。只记 ref,【绝不】写 raw instruction / raw QR。 */
export function appendAccountEvent(
  db: Database.Database,
  args: { accountId: string; sellerId: string; eventType: AccountEventType; qrRef?: string | null },
  generateId: (p: string) => string,
): void {
  db.prepare('INSERT INTO direct_receive_account_events (id, account_id, seller_id, event_type, qr_ref) VALUES (?,?,?,?,?)')
    .run(generateId('drae'), args.accountId, args.sellerId, args.eventType, args.qrRef ?? null)
}

/**
 * 存收款码(owner-scoped)。校验 → sha256 → 【一个同步事务】内:INSERT OR IGNORE 不可变行 + 更新 account.qr_image_ref
 *   + append qr_uploaded 事件。account 必须属于 sellerId(不属于 → {ok:false})。返回 ref。
 */
export function storeQrImage(
  db: Database.Database,
  args: { accountId: string; sellerId: string; dataUri: unknown },
  generateId: (p: string) => string,
): { ok: true; ref: string } | { ok: false; reason: string } {
  const v = validateQrDataUri(args.dataUri)
  if (!v.ok) return v
  const owns = db.prepare("SELECT 1 FROM direct_receive_accounts WHERE id = ? AND seller_id = ?").get(args.accountId, args.sellerId)
  if (!owns) return { ok: false, reason: 'account not found or not owned' }
  const ref = v.value.sha256
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO direct_receive_account_qr_images (ref, account_id, seller_id, mime, data_b64, byte_len, sha256) VALUES (?,?,?,?,?,?,?)')
      .run(ref, args.accountId, args.sellerId, v.value.mime, v.value.buf.toString('base64'), v.value.buf.length, ref)
    db.prepare("UPDATE direct_receive_accounts SET qr_image_ref = ?, updated_at = datetime('now') WHERE id = ? AND seller_id = ?").run(ref, args.accountId, args.sellerId)
    appendAccountEvent(db, { accountId: args.accountId, sellerId: args.sellerId, eventType: 'qr_uploaded', qrRef: ref }, generateId)
  })()
  return { ok: true, ref }
}

/** owner-scoped 取码字节(供硬化端点转发)。非本人 / 不存在 → null(端点统一 404,不枚举)。 */
export function getQrImageForOwner(db: Database.Database, ref: string, sellerId: string): { mime: string; buf: Buffer } | null {
  const row = db.prepare('SELECT mime, data_b64 FROM direct_receive_account_qr_images WHERE ref = ? AND seller_id = ?').get(ref, sellerId) as { mime: string; data_b64: string } | undefined
  if (!row) return null
  let buf: Buffer
  try { buf = Buffer.from(row.data_b64, 'base64') } catch { return null }
  // defense-in-depth: re-validate on read (mime whitelist + magic + size) — never serve unexpected bytes.
  const re = validateQrDataUri(`data:${row.mime};base64,${row.data_b64}`)
  if (!re.ok) return null
  return { mime: row.mime, buf }
}
