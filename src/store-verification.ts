/**
 * Direct Pay (Rail 1) — 【按卖家】店铺认证(store verification)= 逐品验证(product-verification)的【豁免】路径。
 *
 * 模型(Holden 决策):默认每个商品都要逐品验证(硬门,见 product-verification.ts)。但卖家可【申请一次店铺】,
 *   真人 admin 核对店铺时【勾选 per_product_exempt】:
 *     - 勾选(per_product_exempt=1)+ 店铺 verified → 该卖家【所有商品】免逐品验证、可直付。
 *     - 不勾选(默认 0)→ 该卖家仍需逐品验证。
 *   gate combiner(create/availability):productEligible = productStoreVerified(product) OR sellerExemptFromPerProduct(seller)。
 *
 * 诚实边界(铁律,同 product-verification):WebAZ【绝不】抓取 external_url(无 SSRF、无"WebAZ 已核店铺真实性"超claim),
 *   只存卖家提交的店铺链接 + 签发的 code + 真人 admin 的手动 attest。状态:issued→submitted→verified|rejected。单一活跃 per seller。
 *   纯状态机 + 文本存储:不碰 wallet/escrow/settlement/refund/订单状态机。
 */
import type Database from 'better-sqlite3'

export type StoreVerificationStatus = 'issued' | 'submitted' | 'verified' | 'rejected'
export const MAX_URL_LEN = 2048
export const MAX_PLATFORM_LEN = 60
export const MAX_NOTES_LEN = 500

export type StoreVerificationResult =
  | { ok: true; status: StoreVerificationStatus; code?: string; perProductExempt?: boolean; already?: boolean }
  | { ok: false; reason: string }

export interface StoreVerificationRow {
  id: string; user_id: string; code: string; platform: string | null; external_url: string | null
  status: string; per_product_exempt: number; reviewed_by: string | null; reviewed_at: string | null; notes: string | null
  created_at: string | null; updated_at: string | null
}

const ACTIVE = "('issued','submitted','verified')"
const getActive = (db: Database.Database, userId: string): StoreVerificationRow | undefined =>
  db.prepare(`SELECT * FROM store_verifications WHERE user_id = ? AND status IN ${ACTIVE} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId) as StoreVerificationRow | undefined

function isStorableHttpUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LEN) return false
  return /^https?:\/\/[^\s]+$/i.test(url.trim())
}

/** 卖家申请店铺认证 → issued(签发 code)。单一活跃 per seller。 */
export function requestStoreVerification(db: Database.Database, args: { id: string; userId: string; code: string; platform?: string }): StoreVerificationResult {
  const { id, userId, code } = args
  if (!id || !userId || !code) return { ok: false, reason: 'missing id/userId/code' }
  const platform = args.platform ? String(args.platform).trim().slice(0, MAX_PLATFORM_LEN) : null
  if (getActive(db, userId)) return { ok: false, reason: '已有进行中的店铺认证' }
  db.prepare(`INSERT INTO store_verifications (id, user_id, code, platform, status, created_at, updated_at)
    VALUES (?,?,?,?, 'issued', datetime('now'), datetime('now'))`).run(id, userId, code, platform)
  return { ok: true, status: 'issued', code }
}

/** 卖家提交店铺外链 → submitted。要求有 issued 记录;链接仅存储(不抓取)。 */
export function submitStoreVerificationLink(db: Database.Database, args: { userId: string; externalUrl: string; platform?: string }): StoreVerificationResult {
  const url = String(args.externalUrl || '').trim()
  if (!isStorableHttpUrl(url)) return { ok: false, reason: '请提交有效的 http(s) 店铺链接' }
  const active = getActive(db, args.userId)
  if (!active) return { ok: false, reason: '请先申请店铺认证获取验证码' }
  if (active.status === 'verified') return { ok: false, reason: '店铺认证已通过,无需重复提交' }
  const platform = args.platform != null ? String(args.platform).trim().slice(0, MAX_PLATFORM_LEN) : active.platform
  db.prepare(`UPDATE store_verifications SET external_url = ?, platform = ?, status = 'submitted', updated_at = datetime('now') WHERE id = ?`).run(url, platform, active.id)
  return { ok: true, status: 'submitted' }
}

/** 真人 admin 核对结论 → verified | rejected。verified 时按 perProductExempt 置豁免位(默认 false)。仅从 submitted 流转。 */
export function reviewStoreVerification(db: Database.Database, args: {
  id: string; reviewerId: string; decision: 'verified' | 'rejected'; perProductExempt?: boolean; notes?: string
}): StoreVerificationResult {
  const { id, reviewerId, decision } = args
  if (!reviewerId) return { ok: false, reason: 'reviewStoreVerification requires a human reviewerId' }
  if (decision !== 'verified' && decision !== 'rejected') return { ok: false, reason: 'decision must be verified|rejected' }
  const row = db.prepare('SELECT * FROM store_verifications WHERE id = ?').get(id) as StoreVerificationRow | undefined
  if (!row) return { ok: false, reason: 'store verification not found' }
  if (row.status === decision) return { ok: true, status: decision, perProductExempt: row.per_product_exempt === 1, already: true }
  if (row.status !== 'submitted') return { ok: false, reason: `cannot review from status '${row.status}' (need submitted)` }
  const exempt = decision === 'verified' && args.perProductExempt === true ? 1 : 0   // 仅 verified 才可置豁免;reject 一律 0
  const notes = args.notes != null ? String(args.notes).slice(0, MAX_NOTES_LEN) : null
  db.prepare(`UPDATE store_verifications SET status = ?, per_product_exempt = ?, reviewed_by = ?, reviewed_at = datetime('now'), notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(decision, exempt, reviewerId, notes, id)
  return { ok: true, status: decision, perProductExempt: exempt === 1 }
}

/** 卖家本人最新一条店铺认证(任意状态)。无 → null。 */
export function getStoreVerification(db: Database.Database, userId: string): StoreVerificationRow | null {
  return (db.prepare('SELECT * FROM store_verifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId) as StoreVerificationRow | undefined) ?? null
}

/** admin 队列:按 status 过滤(默认全部),最新在前。纯读。 */
export function listStoreVerifications(db: Database.Database, opts: { status?: StoreVerificationStatus } = {}): StoreVerificationRow[] {
  if (opts.status) return db.prepare(`SELECT * FROM store_verifications WHERE status = ? ORDER BY created_at DESC, rowid DESC`).all(opts.status) as StoreVerificationRow[]
  return db.prepare(`SELECT * FROM store_verifications ORDER BY created_at DESC, rowid DESC`).all() as StoreVerificationRow[]
}

/** 硬门豁免读取:该卖家是否【已被豁免逐品验证】(店铺 verified 且 per_product_exempt=1)。供 direct-pay gate combiner。 */
export function sellerExemptFromPerProduct(db: Database.Database, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM store_verifications WHERE user_id = ? AND status = 'verified' AND per_product_exempt = 1 LIMIT 1").get(userId)
}

/** 卖家自助视图 DTO:只暴露卖家可见字段(含豁免位 + 状态)。绝不下发 reviewed_by(admin 身份)/ notes(内部备注)。 */
export interface SellerStoreVerificationView {
  id: string; code: string; platform: string | null; external_url: string | null
  status: string; per_product_exempt: boolean; reviewed_at: string | null; created_at: string | null; updated_at: string | null
}
export function toSellerStoreVerificationView(row: StoreVerificationRow): SellerStoreVerificationView {
  return {
    id: row.id, code: row.code, platform: row.platform, external_url: row.external_url,
    status: row.status, per_product_exempt: row.per_product_exempt === 1,
    reviewed_at: row.reviewed_at, created_at: row.created_at, updated_at: row.updated_at,
  }   // 故意省略 reviewed_by + notes
}
