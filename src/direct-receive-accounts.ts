/**
 * Direct Pay (Rail 1) — 卖家多收款账号(direct_receive_accounts)读写 helper (Phase B)。
 *
 * ⚠️ 与 direct-receive-payment-instruction 同性质:WebAZ 只【存储 + 读取】卖家自填的展示内容
 *   (method / instruction / currency / 二维码引用),【绝不】验证、路由、托管、判断币种,也【不】解析二维码,
 *   不做 crypto|fiat allowlist。currency 仅供买家侧换算展示;qr_image_ref 指向硬化图片端点(Phase C)。
 *   命名刻意避开 payment_method / payment_provider,以免被误读为 WebAZ 具备支付能力。
 *
 * 多行模型:一个 seller 可有【多个】active 账号(买家下单自选其一),与单 instruction 的"至多一条 active"不同。
 *   只写 direct_receive_accounts,绝不碰 buyer wallet / escrow / settlement / refund / order status。
 *
 * Phase B = schema + 这些纯 helper。无路由、无 UI、无 create-route 接线(留 Phase C/D)。
 */
import type Database from 'better-sqlite3'

export interface DirectReceiveAccount {
  id: string
  seller_id: string
  method: string | null
  currency: string | null
  instruction: string
  label: string | null
  qr_image_ref: string | null
  status: string
}

export const MAX_INSTRUCTION_LEN = 500
export const MAX_LABEL_LEN = 40
export const MAX_METHOD_LEN = 40
export const MAX_QR_REF_LEN = 200
// currency:卖家声明的币种码(自由文本,2-8 位大写字母数字)。WebAZ 不限制卖家怎么收钱;买家侧只在 FX 支持时才显换算。
export const CURRENCY_RE = /^[A-Z0-9]{2,8}$/

export interface AccountInput {
  method?: string | null
  currency?: string | null
  instruction: string
  label?: string | null
  qrImageRef?: string | null
}
export interface NormalizedAccount {
  method: string | null
  currency: string | null
  instruction: string
  label: string | null
  qr_image_ref: string | null
}

/** PURE: 校验 + 规范化卖家入参(trim / 长度 / 币种格式 / 大写)。不碰 DB。
 *  长度超限 = 【显式拒绝】(非静默截断)—— 卖家看到的收款标签 / 方式 / 二维码引用不能被悄悄改短。 */
export function normalizeAccountInput(input: AccountInput): { ok: true; value: NormalizedAccount } | { ok: false; reason: string } {
  const instruction = String(input?.instruction ?? '').trim()
  if (!instruction) return { ok: false, reason: 'instruction required' }
  if (instruction.length > MAX_INSTRUCTION_LEN) return { ok: false, reason: `instruction must be ≤ ${MAX_INSTRUCTION_LEN} chars` }
  // trim + reject-if-over-limit (no silent slice). null/absent → null.
  const field = (v: unknown, max: number, name: string): { ok: true; v: string | null } | { ok: false; reason: string } => {
    if (v == null) return { ok: true, v: null }
    const s = String(v).trim()
    if (s.length > max) return { ok: false, reason: `${name} must be ≤ ${max} chars` }
    return { ok: true, v: s || null }
  }
  const L = field(input.label, MAX_LABEL_LEN, 'label'); if (!L.ok) return L
  const M = field(input.method, MAX_METHOD_LEN, 'method'); if (!M.ok) return M
  const Q = field(input.qrImageRef, MAX_QR_REF_LEN, 'qr image ref'); if (!Q.ok) return Q
  let currency: string | null = null
  if (input.currency != null && String(input.currency).trim()) {
    currency = String(input.currency).trim().toUpperCase()
    if (!CURRENCY_RE.test(currency)) return { ok: false, reason: 'currency must be a 2-8 char code (e.g. THB, IDR, USDC)' }
  }
  return { ok: true, value: { instruction, label: L.v, method: M.v, currency, qr_image_ref: Q.v } }
}

const COLS = 'id, seller_id, method, currency, instruction, label, qr_image_ref, status'

/** 卖家的收款账号(默认仅 active;{ includeInactive:true } 取全部)。多行。 */
export function listSellerAccounts(db: Database.Database, sellerId: string, opts: { includeInactive?: boolean } = {}): DirectReceiveAccount[] {
  const where = opts.includeInactive ? '' : " AND status = 'active'"
  return db.prepare(`SELECT ${COLS} FROM direct_receive_accounts WHERE seller_id = ?${where} ORDER BY created_at ASC, id ASC`).all(sellerId) as DirectReceiveAccount[]
}

/** 单个账号(任意状态);调用方自行做 owner 校验。 */
export function getAccount(db: Database.Database, id: string): DirectReceiveAccount | null {
  return (db.prepare(`SELECT ${COLS} FROM direct_receive_accounts WHERE id = ?`).get(id) as DirectReceiveAccount | undefined) ?? null
}

/** 新增一个 active 收款账号。入参经 normalizeAccountInput 校验;只写本表。 */
export function addAccount(
  db: Database.Database, sellerId: string, input: AccountInput, generateId: (prefix: string) => string,
): { ok: true; account: DirectReceiveAccount } | { ok: false; reason: string } {
  const norm = normalizeAccountInput(input)
  if (!norm.ok) return norm
  const id = generateId('dra')
  const v = norm.value
  db.prepare(`INSERT INTO direct_receive_accounts (id, seller_id, method, currency, instruction, label, qr_image_ref, status) VALUES (?,?,?,?,?,?,?, 'active')`)
    .run(id, sellerId, v.method, v.currency, v.instruction, v.label, v.qr_image_ref)
  return { ok: true, account: { id, seller_id: sellerId, status: 'active', ...v } }
}

/** owner-scoped 更新(仅该 seller 拥有的行)。返回是否有行被改。 */
export function updateAccount(
  db: Database.Database, id: string, sellerId: string, input: AccountInput,
): { ok: true; changed: boolean } | { ok: false; reason: string } {
  const norm = normalizeAccountInput(input)
  if (!norm.ok) return norm
  const v = norm.value
  const info = db.prepare(
    `UPDATE direct_receive_accounts SET method = ?, currency = ?, instruction = ?, label = ?, qr_image_ref = ?, updated_at = datetime('now') WHERE id = ? AND seller_id = ?`,
  ).run(v.method, v.currency, v.instruction, v.label, v.qr_image_ref, id, sellerId)
  return { ok: true, changed: info.changes > 0 }
}

/** owner-scoped 软停用。返回是否有行被停用。 */
export function deactivateAccount(db: Database.Database, id: string, sellerId: string): boolean {
  const info = db.prepare("UPDATE direct_receive_accounts SET status = 'inactive', updated_at = datetime('now') WHERE id = ? AND seller_id = ? AND status = 'active'").run(id, sellerId)
  return info.changes > 0
}
