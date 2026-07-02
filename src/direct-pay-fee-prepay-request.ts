/**
 * 平台服务费【预充值申请】域 helper(卖家发起 → admin 核实入账)。
 *
 * ⚠️ 申请【绝不动钱】—— 只建 pending 记录 + 留痕(凭据必填)。真正入账在 admin 确认后(PR3)调 recordFeePrepay。
 * 边界:不碰 wallet/escrow/settlement/fee 余额;不判币种真伪(以平台核实真实到账为准)。金额 = base units(1 WAZ=1e6)。
 */
import type Database from 'better-sqlite3'
import { getPlatformAccount } from './platform-receive-accounts.js'
import { recordFeePrepayTopup } from './direct-pay-fee-ar.js'

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

/** admin 队列:按状态列出所有卖家的申请(pending 升序供审核;无状态时取最近)。 */
export function listAllRequests(db: Database.Database, status?: string): FeePrepayRequest[] {
  if (status) return db.prepare(`SELECT ${COLS} FROM direct_pay_fee_prepay_requests WHERE status = ? ORDER BY created_at ASC, id ASC`).all(status) as FeePrepayRequest[]
  return db.prepare(`SELECT ${COLS} FROM direct_pay_fee_prepay_requests ORDER BY created_at DESC, id DESC LIMIT 200`).all() as FeePrepayRequest[]
}

/**
 * admin 确认真实到账 → 入账(【唯一动钱处】)。原子:pending→approved + recordFeePrepayTopup(记 direct_pay_fee_payments,
 *   带申请的 evidence_ref)+ 回填 resulting_payment_id,全在一个 tx。非 pending / 记账失败 → 整体回滚不动钱。method=usdc|fiat。
 */
export function approveFeePrepayRequest(
  db: Database.Database, args: { requestId: string; adminId: string; method: string; reviewNote?: string | null },
): { ok: true; paymentId: string } | { ok: false; error: string } {
  if (args.method !== 'usdc' && args.method !== 'fiat') return { ok: false, error: 'BAD_METHOD' }
  const req = getRequest(db, args.requestId)
  if (!req) return { ok: false, error: 'REQUEST_NOT_FOUND' }
  if (req.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
  let paymentId = ''
  try {
    db.transaction(() => {
      const r = recordFeePrepayTopup(db, { sellerId: req.seller_id, amountUnits: req.amount_units, method: args.method, recordedBy: args.adminId, evidenceRef: req.evidence_ref, note: args.reviewNote ?? undefined })
      if (!r.ok) throw new Error(r.error)
      const upd = db.prepare("UPDATE direct_pay_fee_prepay_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now'), review_note=?, resulting_payment_id=? WHERE id=? AND status='pending'").run(args.adminId, args.reviewNote ?? null, r.id, args.requestId)
      if (upd.changes !== 1) throw new Error('NOT_PENDING')   // 并发保险:非 pending → 回滚(含刚记的 topup)
      paymentId = r.id as string
    })()
  } catch (e) { return { ok: false, error: (e as Error).message } }
  return { ok: true, paymentId }
}

/** admin 驳回 pending 申请(不动钱)。返回 ok / 非 pending。 */
export function rejectFeePrepayRequest(
  db: Database.Database, args: { requestId: string; adminId: string; reviewNote?: string | null },
): { ok: true } | { ok: false; error: string } {
  const upd = db.prepare("UPDATE direct_pay_fee_prepay_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), review_note=? WHERE id=? AND status='pending'").run(args.adminId, args.reviewNote ?? null, args.requestId)
  return upd.changes === 1 ? { ok: true } : { ok: false, error: 'NOT_PENDING' }
}
