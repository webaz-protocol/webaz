/**
 * RFC-029 Design A — the Choice/Update contract (§Choice/update contract).
 *
 * The human, at the confirm/approval stage, picks a payment option for a DEFERRED order_submit request.
 * This is the ONE server-side seam that turns "rail not chosen yet" into a concrete, Passkey-approvable
 * request. It is a HUMAN action (own request); the agent can never reach it.
 *
 * Atomic contract (all-or-nothing, one better-sqlite3 transaction):
 *   1. Load + validate: pending order_submit request (own, unexpired) whose draft is a live 'draft' with
 *      a 'deferred' rail (only a not-yet-chosen rail may be chosen — never re-forks a decided draft).
 *   2. Re-validate the chosen option against the CURRENT eligible set (sellerSupportedPaymentOptions —
 *      TOCTOU guard: the seller may have become ineligible since the draft was made).
 *   3. Rail eligibility check: preview-quote the draft WITH the chosen rail. This runs the quote-level
 *      direct_p2p gates a deferred quote skipped (product-shape variant/donation/anonymous/flash +
 *      launch controls + product verification + explicit account activity). It is NOT the full create
 *      stack — create additionally enforces per-order gates (open-order cap, collateral exposure,
 *      fee-prepay) authoritatively. So a chosen rail is quote-eligible here; create remains the final
 *      authority and may still reject with an honest late failure (fail-closed, never a silent switch).
 *   4. Persist {payment_rail, direct_receive_account_id} into the DRAFT (the executor's source of truth —
 *      exec recomputes params_hash from order_drafts and creates from draft fields), CAS on
 *      payment_rail='deferred', AND recompute+update the request's params_hash + intent_hash. Any Passkey
 *      token bound to the old (deferred) params_hash is thereby invalidated (the /approve gate compares
 *      the token's params_hash to the current row).
 *
 * No money moves, no order is created here — the human still Passkey-approves afterwards. Safety: a
 * 'deferred' rail can never create an order (order-submit-exec hard-闸), so a request stuck before this
 * step simply cannot execute.
 *
 * KNOWN LIMITATION (pre-existing, whole direct_p2p flow — not introduced here): params_hash binds the
 * direct_receive_account_id (the account IDENTITY), not the account's mutable CONTENT (instruction/QR/
 * currency/label editable via PUT /api/direct-receive/accounts/:id). So a chosen direct option can
 * never silently switch to a DIFFERENT account (a deactivated/changed id → resolveDirectReceive NONE →
 * create rejects DIRECT_RECEIVE_ACCOUNT_INVALID), but the SAME account's content edited in the
 * choice→Passkey→create window would flow through under the bound id. The buyer always pays per the
 * instruction shown on the final order (off-protocol), so this is a review-vs-final integrity gap, not
 * a fund misdirection to a third party. Binding account-content into params_hash is a shared-hash change
 * (migration-sensitive, affects the agent direct_p2p flow too) — tracked as a follow-up, not this PR.
 */
import type Database from 'better-sqlite3'
import { computeBuyerQuote } from './buyer-quote.js'
import { orderSubmitParamsHash, orderSubmitIntentHash } from './order-submit-request.js'
import { sellerSupportedPaymentOptions, type PaymentOption } from '../direct-pay-payment-options.js'
import { isDeferredRail } from '../direct-pay-rails.js'

type QuoteDeps = { generateId: (p: string) => string; getProtocolParam: <T>(key: string, fallback: T) => T }

export type ChoosePaymentResult =
  | { ok: true; request_id: string; payment_rail: string; direct_receive_account_id: string | null; params_hash: string }
  | { ok: false; http: number; error: string; error_code: string }

export interface ChoosePaymentArgs {
  requestId: string
  humanId: string
  optionId: string
  nowIso: string
  deps: QuoteDeps
  getProtocolParam: <T>(key: string, fallback: T) => T
}

const err = (http: number, error_code: string, error: string): ChoosePaymentResult => ({ ok: false, http, error, error_code })

export type PaymentOptionsForRequestResult =
  | { ok: true; request_id: string; rail_chosen: boolean; current_rail: string; options: PaymentOption[] }
  | { ok: false; http: number; error: string; error_code: string }

/** Read companion for the confirm page: the payment-options menu for a pending order_submit request (own).
 *  When the rail is already chosen (not deferred), returns rail_chosen:true + an empty menu (nothing to pick). */
export function paymentOptionsForSubmitRequest(db: Database.Database, args: { requestId: string; humanId: string; nowIso: string; getProtocolParam: <T>(key: string, fallback: T) => T }): PaymentOptionsForRequestResult {
  const reqRow = db.prepare("SELECT human_id, order_id, status, executed_at FROM agent_permission_requests WHERE id = ? AND kind = 'order_submit'").get(args.requestId) as Record<string, unknown> | undefined
  if (!reqRow) return { ok: false, http: 404, error: '提交请求不存在', error_code: 'SUBMIT_REQUEST_NOT_FOUND' }
  if (reqRow.human_id !== args.humanId) return { ok: false, http: 403, error: '不是你的提交请求', error_code: 'NOT_YOUR_REQUEST' }
  const draft = db.prepare('SELECT product_id, seller_id, total_units, payment_rail, status FROM order_drafts WHERE id = ? AND buyer_id = ?').get(String(reqRow.order_id), args.humanId) as Record<string, unknown> | undefined
  if (!draft) return { ok: false, http: 404, error: '草稿不存在', error_code: 'DRAFT_NOT_FOUND' }
  const currentRail = String(draft.payment_rail)
  if (!isDeferredRail(currentRail)) return { ok: true, request_id: args.requestId, rail_chosen: true, current_rail: currentRail, options: [] }
  const options = sellerSupportedPaymentOptions(db, { productId: String(draft.product_id), sellerId: String(draft.seller_id), amountUnits: Number(draft.total_units), getProtocolParam: args.getProtocolParam })
  return { ok: true, request_id: args.requestId, rail_chosen: false, current_rail: currentRail, options }
}

export function chooseSubmitPaymentOption(db: Database.Database, args: ChoosePaymentArgs): ChoosePaymentResult {
  const { requestId, humanId, optionId, nowIso } = args
  if (typeof optionId !== 'string' || !optionId) return err(400, 'OPTION_ID_REQUIRED', 'option_id is required')

  // 1. request:pending order_submit,本人,未过期,未执行。
  const reqRow = db.prepare("SELECT id, human_id, order_id, status, expires_at, executed_at, purchase_intent_instance FROM agent_permission_requests WHERE id = ? AND kind = 'order_submit'").get(requestId) as Record<string, unknown> | undefined
  if (!reqRow) return err(404, 'SUBMIT_REQUEST_NOT_FOUND', '提交请求不存在')
  if (reqRow.human_id !== humanId) return err(403, 'NOT_YOUR_REQUEST', '不是你的提交请求')
  if (reqRow.executed_at) return err(409, 'ALREADY_EXECUTED', '该请求已执行,支付方式不可再改')
  if (reqRow.status !== 'pending') return err(409, 'REQUEST_NOT_PENDING', `请求状态为 ${String(reqRow.status)},支付方式仅在待批准时可选`)
  if (String(reqRow.expires_at) <= nowIso) return err(409, 'REQUEST_EXPIRED', '请求已过期,请重新报价')

  // 2. draft:本人,live 'draft',rail='deferred'(仅未选择的可选;绝不改动已定轨草稿)。
  const draftId = String(reqRow.order_id)
  const draft = db.prepare('SELECT * FROM order_drafts WHERE id = ? AND buyer_id = ?').get(draftId, humanId) as Record<string, unknown> | undefined
  if (!draft) return err(404, 'DRAFT_NOT_FOUND', '草稿不存在')
  if (String(draft.status) !== 'draft') return err(409, 'DRAFT_NOT_AVAILABLE', `草稿状态为 ${String(draft.status)},不可选支付方式`)
  if (String(draft.expires_at) <= nowIso) return err(409, 'DRAFT_EXPIRED', '草稿已过期,请重新报价')
  if (!isDeferredRail(draft.payment_rail)) return err(409, 'RAIL_ALREADY_CHOSEN', '该草稿的支付方式已确定,无需再选(如需更换请重新报价)')

  // 3. 重算当前可选项(TOCTOU):选中的 option 必须仍在售卖家支持集里。
  const amountUnits = Number(draft.total_units)
  const options = sellerSupportedPaymentOptions(db, { productId: String(draft.product_id), sellerId: String(draft.seller_id), amountUnits, getProtocolParam: args.getProtocolParam })
  const chosen = options.find(o => o.option_id === optionId)
  if (!chosen) return err(409, 'PAYMENT_OPTION_UNAVAILABLE', '该支付方式当前不可用(卖家资格或收款方式已变化)—— 请刷新可选支付方式')

  // 4. 权威轨道校验:用选中的 rail preview-报价整张草稿(跑齐 direct_p2p 产品形态/资格/账户门 —— deferred 报价当初跳过了)。
  const previewInput = {
    product_id: String(draft.product_id),
    variant_id: draft.variant_id == null ? undefined : String(draft.variant_id),
    quantity: Number(draft.quantity),
    payment_rail: chosen.rail,
    direct_receive_account_id: chosen.direct_receive_account_id == null ? undefined : chosen.direct_receive_account_id,
    donation_bps: Number(draft.donation_bps),
    anonymous_recipient: Number(draft.anonymous_recipient) === 1,
    address_source: 'default' as const,
  }
  const pv = computeBuyerQuote(db, args.deps, humanId, previewInput, 'preview')
  if (!pv.ok) return err(409, 'PAYMENT_OPTION_INELIGIBLE', `所选支付方式对本单不可用(${pv.body.error_code})—— 请改选其他方式`)

  // 5. 原子事务:草稿写入 {rail, account}(CAS on deferred);请求 params_hash + intent_hash 重算更新(仅 pending)。
  //    唯一索引 ux_apr_intent_active 冲突(同买家同经济意图已有活跃请求)→ 事务抛错 → 干净拒绝(防重复购买)。
  const updatedDraft = { ...draft, payment_rail: chosen.rail, direct_receive_account_id: chosen.direct_receive_account_id }
  const newParamsHash = orderSubmitParamsHash(updatedDraft)
  const newIntentHash = orderSubmitIntentHash(humanId, updatedDraft, reqRow.purchase_intent_instance == null ? null : String(reqRow.purchase_intent_instance))
  try {
    const tx = db.transaction(() => {
      const du = db.prepare("UPDATE order_drafts SET payment_rail = ?, direct_receive_account_id = ? WHERE id = ? AND buyer_id = ? AND status = 'draft' AND payment_rail = 'deferred'")
        .run(chosen.rail, chosen.direct_receive_account_id, draftId, humanId)
      if (du.changes !== 1) throw new Error('DRAFT_RACE')   // 并发改动(另一次选择/过期/取消)→ 回滚
      const ru = db.prepare("UPDATE agent_permission_requests SET params_hash = ?, intent_hash = ? WHERE id = ? AND status = 'pending' AND executed_at IS NULL")
        .run(newParamsHash, newIntentHash, requestId)
      if (ru.changes !== 1) throw new Error('REQUEST_RACE')
    })
    tx()
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (m.includes('DRAFT_RACE') || m.includes('REQUEST_RACE')) return err(409, 'CONCURRENT_CHANGE', '草稿/请求状态并发变化,请刷新后重试')
    // 唯一索引冲突(重复经济意图)等 → 防重复扣款优先
    return err(409, 'IDEMPOTENCY_CONFLICT', '你已有一笔相同商品/条款的待批准请求 —— 请先处理它,避免重复下单')
  }
  return { ok: true, request_id: requestId, payment_rail: chosen.rail, direct_receive_account_id: chosen.direct_receive_account_id, params_hash: newParamsHash }
}
