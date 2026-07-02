/**
 * 平台服务费【预充值申请】域 helper(卖家发起 → admin 核实入账)。
 *
 * ⚠️ 申请【绝不动钱】—— 只建 pending 记录 + 留痕(凭据必填)。真正入账在 admin 确认后(PR3)调 recordFeePrepay。
 * 边界:不碰 wallet/escrow/settlement/fee 余额;不判币种真伪(以平台核实真实到账为准)。金额 = base units(1 WAZ=1e6)。
 */
import type Database from 'better-sqlite3'
import { getPlatformAccount } from './platform-receive-accounts.js'

export interface FeePrepayRequest {
  id: string
  seller_id: string
  amount_units: number
  currency: string | null
  platform_account_id: string | null
  evidence_ref: string
  evidence_note: string | null
  status: string
  created_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  resulting_payment_id: string | null
}

export const MAX_EVIDENCE_LEN = 200
export const MAX_EVIDENCE_NOTE_LEN = 500

export interface FeePrepayRequestInput {
  amountUnits: number
  currency?: string | null
  platformAccountId?: string | null
  evidenceRef: string
  evidenceNote?: string | null
}

const COLS = 'id, seller_id, amount_units, currency, platform_account_id, evidence_ref, evidence_note, status, created_at, reviewed_by, reviewed_at, review_note, resulting_payment_id'

/** 卖家发起预充值申请。校验:金额正整数、凭据必填(不能无据)、平台收款方式须为 active。建 pending。不动钱。 */
export function createFeePrepayRequest(
  db: Database.Database, sellerId: string, input: FeePrepayRequestInput, generateId: (p: string) => string,
): { ok: true; request: FeePrepayRequest } | { ok: false; reason: string } {
  const amount = Number(input.amountUnits)
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive integer (base units)' }   // 严格整数,不静默截断非整数
  const evidenceRef = String(input.evidenceRef ?? '').trim()
  if (!evidenceRef) return { ok: false, reason: '付款凭证号必填(不能无据)' }
  if (evidenceRef.length > MAX_EVIDENCE_LEN) return { ok: false, reason: `evidence_ref must be ≤ ${MAX_EVIDENCE_LEN} chars` }
  const note = input.evidenceNote == null ? null : String(input.evidenceNote).trim().slice(0, MAX_EVIDENCE_NOTE_LEN) || null
  const currency = input.currency == null || !String(input.currency).trim() ? null : String(input.currency).trim().toUpperCase().slice(0, 8)
  // platform_account_id 必填 + 必须 active:充值必须对准一个 WebAZ 收款账户,admin 才能据此核对到账来源(不能无账户的半场外流程)。
  const pid = input.platformAccountId == null ? '' : String(input.platformAccountId).trim()
  if (!pid) return { ok: false, reason: '必须选择平台收款方式' }
  const acc = getPlatformAccount(db, pid)
  if (!acc || acc.status !== 'active') return { ok: false, reason: '所选平台收款方式无效或已停用' }
  const id = generateId('fpr')
  db.prepare(`INSERT INTO direct_pay_fee_prepay_requests (id, seller_id, amount_units, currency, platform_account_id, evidence_ref, evidence_note, status) VALUES (?,?,?,?,?,?,?, 'pending')`)
    .run(id, sellerId, amount, currency, pid, evidenceRef, note)
  return { ok: true, request: getRequest(db, id) as FeePrepayRequest }
}

/** 卖家自己的申请(全状态,新→旧)。 */
export function listSellerRequests(db: Database.Database, sellerId: string): FeePrepayRequest[] {
  return db.prepare(`SELECT ${COLS} FROM direct_pay_fee_prepay_requests WHERE seller_id = ? ORDER BY created_at DESC, id DESC`).all(sellerId) as FeePrepayRequest[]
}

export function getRequest(db: Database.Database, id: string): FeePrepayRequest | null {
  return (db.prepare(`SELECT ${COLS} FROM direct_pay_fee_prepay_requests WHERE id = ?`).get(id) as FeePrepayRequest | undefined) ?? null
}

/** 卖家撤销自己的 pending 申请(owner-scoped;仅 pending 可撤)。返回是否改动。 */
export function cancelRequest(db: Database.Database, id: string, sellerId: string): boolean {
  return db.prepare("UPDATE direct_pay_fee_prepay_requests SET status='cancelled', reviewed_at=datetime('now') WHERE id=? AND seller_id=? AND status='pending'").run(id, sellerId).changes > 0
}
