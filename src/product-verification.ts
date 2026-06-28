/**
 * Direct Pay (Rail 1) — 【按产品】外部平台商品认证(per-product verification)。降低作弊。
 *
 * 为什么按产品(Holden 决策):一次验证【绝不】默认放行该卖家所有产品。每个要走直付收款的产品都必须【单独】被真人 admin
 *   手动核验通过 —— 这是【硬门】:未验证的产品 direct-pay 不可用(退回托管轨)。防"验证一个正经店、再上架一堆假货"。
 *
 * 诚实边界(铁律):
 *  - WebAZ【绝不】抓取 external_url —— 无 SSRF、无"WebAZ 已核验该商品/店铺真实性"超claim。本模块只【存储】卖家提交的
 *    链接 + 签发的验证码 + 真人 admin 的手动核对结论。
 *  - 机制 = 卖家为【该产品】申领 code → 展示在其外部平台商品页 → 提交该产品链接 → 真人 admin 手动打开核对 → attest。
 *  - 记录的【最弱准确事实】= "admin <id> 于 <时间> 手动确认产品 <product_id> 在 <url> 展示了验证码 <code>"。
 *  - 状态机:issued(已签发 code)→ submitted(卖家已交链接)→ verified | rejected(真人 admin 结论)。
 *  - 单一活跃(per product):同一产品同时只允许一条活跃(issued/submitted/verified)记录;rejected 后可重新申请。
 *  - 纯状态机 + 文本存储:不碰 wallet/escrow/settlement/refund/订单状态机。产品所有权由【调用方 route】校验(seller 拥有该产品)。
 */
import type Database from 'better-sqlite3'

export type ProductVerificationStatus = 'issued' | 'submitted' | 'verified' | 'rejected'
export const MAX_URL_LEN = 2048
export const MAX_PLATFORM_LEN = 60
export const MAX_NOTES_LEN = 500

export type ProductVerificationResult =
  | { ok: true; status: ProductVerificationStatus; code?: string; already?: boolean }
  | { ok: false; reason: string }

export interface ProductVerificationRow {
  id: string; product_id: string; seller_id: string; code: string; platform: string | null; external_url: string | null
  status: string; reviewed_by: string | null; reviewed_at: string | null; notes: string | null
  created_at: string | null; updated_at: string | null
}

const ACTIVE = "('issued','submitted','verified')"
const getActiveForProduct = (db: Database.Database, productId: string): ProductVerificationRow | undefined =>
  db.prepare(`SELECT * FROM product_verifications WHERE product_id = ? AND status IN ${ACTIVE} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(productId) as ProductVerificationRow | undefined

/** http(s) 链接最弱校验(仅存储,不抓取):必须 http/https、长度受限。拒 javascript:/data: 等危险 scheme。 */
function isStorableHttpUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LEN) return false
  return /^https?:\/\/[^\s]+$/i.test(url.trim())
}

/** 卖家为【某产品】申请认证 → issued(签发 code)。绝不自动 verify。单一活跃(per product)。调用方须先校验 seller 拥有该产品。 */
export function requestProductVerification(db: Database.Database, args: {
  id: string; productId: string; sellerId: string; code: string; platform?: string
}): ProductVerificationResult {
  const { id, productId, sellerId, code } = args
  if (!id || !productId || !sellerId || !code) return { ok: false, reason: 'missing id/productId/sellerId/code' }
  const platform = args.platform ? String(args.platform).trim().slice(0, MAX_PLATFORM_LEN) : null
  const active = getActiveForProduct(db, productId)
  if (active) return { ok: false, reason: `该产品已有进行中的认证(${active.status})` }
  db.prepare(`INSERT INTO product_verifications (id, product_id, seller_id, code, platform, status, created_at, updated_at)
    VALUES (?,?,?,?,?, 'issued', datetime('now'), datetime('now'))`).run(id, productId, sellerId, code, platform)
  return { ok: true, status: 'issued', code }
}

/** 卖家为【某产品】提交外部链接 → submitted。要求该产品有 issued 记录;链接仅存储(不抓取)。调用方须校验 seller 拥有该产品。 */
export function submitProductVerificationLink(db: Database.Database, args: {
  productId: string; externalUrl: string; platform?: string
}): ProductVerificationResult {
  const url = String(args.externalUrl || '').trim()
  if (!isStorableHttpUrl(url)) return { ok: false, reason: '请提交有效的 http(s) 商品链接' }
  const active = getActiveForProduct(db, args.productId)
  if (!active) return { ok: false, reason: '请先为该产品申请认证获取验证码' }
  if (active.status === 'verified') return { ok: false, reason: '该产品认证已通过,无需重复提交' }
  const platform = args.platform != null ? String(args.platform).trim().slice(0, MAX_PLATFORM_LEN) : active.platform
  db.prepare(`UPDATE product_verifications SET external_url = ?, platform = ?, status = 'submitted', updated_at = datetime('now') WHERE id = ?`)
    .run(url, platform, active.id)
  return { ok: true, status: 'submitted' }
}

/** 真人 admin 手动核对结论 → verified | rejected。仅从 submitted 流转。reviewerId 必填(责任分层;ROOT/Passkey 由调用方强制)。 */
export function reviewProductVerification(db: Database.Database, args: {
  id: string; reviewerId: string; decision: 'verified' | 'rejected'; notes?: string
}): ProductVerificationResult {
  const { id, reviewerId, decision } = args
  if (!reviewerId) return { ok: false, reason: 'reviewProductVerification requires a human reviewerId' }
  if (decision !== 'verified' && decision !== 'rejected') return { ok: false, reason: 'decision must be verified|rejected' }
  const row = db.prepare('SELECT * FROM product_verifications WHERE id = ?').get(id) as ProductVerificationRow | undefined
  if (!row) return { ok: false, reason: 'product verification not found' }
  if (row.status === decision) return { ok: true, status: decision, already: true }
  if (row.status !== 'submitted') return { ok: false, reason: `cannot review from status '${row.status}' (need submitted)` }
  const notes = args.notes != null ? String(args.notes).slice(0, MAX_NOTES_LEN) : null
  db.prepare(`UPDATE product_verifications SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(decision, reviewerId, notes, id)
  return { ok: true, status: decision }
}

/** 某产品最新一条认证记录(任意状态)。无 → null。 */
export function getProductVerification(db: Database.Database, productId: string): ProductVerificationRow | null {
  return (db.prepare('SELECT * FROM product_verifications WHERE product_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(productId) as ProductVerificationRow | undefined) ?? null
}

/** 某卖家所有产品认证记录(供卖家自助面板逐产品展示状态)。最新在前。 */
export function listSellerProductVerifications(db: Database.Database, sellerId: string): ProductVerificationRow[] {
  return db.prepare('SELECT * FROM product_verifications WHERE seller_id = ? ORDER BY created_at DESC, rowid DESC').all(sellerId) as ProductVerificationRow[]
}

/** admin 队列:按 status 过滤(默认全部),最新在前。纯读。 */
export function listProductVerifications(db: Database.Database, opts: { status?: ProductVerificationStatus } = {}): ProductVerificationRow[] {
  if (opts.status) return db.prepare(`SELECT * FROM product_verifications WHERE status = ? ORDER BY created_at DESC, rowid DESC`).all(opts.status) as ProductVerificationRow[]
  return db.prepare(`SELECT * FROM product_verifications ORDER BY created_at DESC, rowid DESC`).all() as ProductVerificationRow[]
}

/** 硬门读取:该产品是否【已验证】(有 verified 记录)。供 direct-pay create/availability 强制(未验证 → 不可直付)。 */
export function productStoreVerified(db: Database.Database, productId: string): boolean {
  return !!db.prepare("SELECT 1 FROM product_verifications WHERE product_id = ? AND status = 'verified' LIMIT 1").get(productId)
}
