/**
 * RFC-026 PR-6 — 买家动作请求(kind='buyer_action';safe scope buyer_action_request,粗 scope aftersales:request)。
 *
 * v1 三动作(每个的可用性与【执行路由同谓词】,执行=回环打真实人类路由,单一真相源第三次复用):
 *   confirm_receipt —— 仅 escrow 轨 + delivered(POST /api/orders/:id/action {confirm} → 真实结算释放托管;
 *     direct_p2p 的确认有专属 D 披露+现场 Passkey 门,人专属,这里诚实拒 DP_CONFIRM_HUMAN_ONLY);
 *   cancel —— 仅 direct_p2p 且 direct_pay_window/payment_query/direct_expired_unconfirmed(同 orders-action 门);
 *   request_return —— completed + effectiveReturnDays 冻结窗内 + 无活跃退货(returns 路由同谓词);
 *     reason 只收 enum(quality/wrong_item/damaged/no_longer_needed/other),绝不透传自由文本。
 * open_dispute / refund 系列因证据框架与 dp 握手依赖顺延(不造死能力)。
 *
 * params_hash = SHA-256(canonical{order_id, action, 经济后果快照}):提交时服务端算后果
 * (confirm=释放金额+卖家;return=默认退款额;cancel=零资金语义),批准执行前重算重验 —— 状态/金额
 * 任何漂移硬拒。恰一次:每 (order, action) 一条活跃请求(部分唯一索引);干净失败 'failed' 终态释放坑;
 * 执行恢复走【天然 oracle】(订单已 confirmed/completed、已 cancelled、return_requests 行已存在 →
 * already_executed),崩溃边界重批即收敛,绝无重复经济动作。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { effectiveReturnDays } from '../trade-terms.js'
import type { ApiLoopback } from './order-chat-agent.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const BUYER_ACTIONS = ['confirm_receipt', 'cancel', 'request_return'] as const
const RETURN_REASONS = new Set(['quality', 'wrong_item', 'damaged', 'no_longer_needed', 'other'])

interface Consequence { snapshot: Record<string, unknown>; summary: Record<string, unknown> }

/** 可用性 + 经济后果快照(与执行路由同谓词;不可用 → 结构化拒绝)。 */
function evaluate(db: Database.Database, humanId: string, orderId: string, action: string, reason: string | null):
  { ok: true; c: Consequence } | { ok: false; http: number; error: string; error_code: string } {
  const o = db.prepare('SELECT id, buyer_id, seller_id, status, payment_rail, total_amount, escrow_amount, product_id, updated_at, created_at, trade_terms_snapshot FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!o || o.buyer_id !== humanId) return { ok: false, http: 404, error: '订单不存在或不属于你', error_code: 'ORDER_NOT_FOUND' }
  const status = String(o.status); const rail = String(o.payment_rail ?? 'escrow')
  if (action === 'confirm_receipt') {
    if (rail === 'direct_p2p') return { ok: false, http: 409, error: '直付确认收货需人本人完成披露确认+现场 Passkey(订单页)—— 不可经 agent 请求', error_code: 'DP_CONFIRM_HUMAN_ONLY' }
    if (status !== 'delivered') return { ok: false, http: 409, error: `仅 delivered 可确认收货(当前 ${status})`, error_code: 'ORDER_NOT_DELIVERED' }
    return { ok: true, c: { snapshot: { order_id: orderId, action, seller_id: String(o.seller_id), release_amount: Number(o.escrow_amount), rail }, summary: { moves_funds: true, releases_escrow: Number(o.escrow_amount), to_seller_hint: String(o.seller_id).slice(0, 4) + '…', note: 'confirming releases the escrow to the seller and settles the order' } } }
  }
  if (action === 'cancel') {
    if (rail !== 'direct_p2p' || !['direct_pay_window', 'payment_query', 'direct_expired_unconfirmed'].includes(status)) {
      return { ok: false, http: 409, error: '取消仅适用于直付订单的付款窗口/协商/过期宽限(与订单页同规则)', error_code: 'NOT_DIRECT_PAY_WINDOW' }
    }
    return { ok: true, c: { snapshot: { order_id: orderId, action, rail, from_status: status }, summary: { moves_funds: false, note: 'cancels the unpaid Direct Pay order (no funds have moved on this rail)' } } }
  }
  if (action === 'request_return') {
    if (status !== 'completed') return { ok: false, http: 409, error: '仅订单完成后可申请退货', error_code: 'ORDER_NOT_COMPLETED' }
    if (!reason || !RETURN_REASONS.has(reason)) return { ok: false, http: 400, error: 'reason 须为 quality/wrong_item/damaged/no_longer_needed/other 之一', error_code: 'RETURN_REASON_INVALID' }
    const prod = db.prepare('SELECT return_days FROM products WHERE id = ?').get(String(o.product_id)) as { return_days: number | null } | undefined
    const eff = effectiveReturnDays(o.trade_terms_snapshot, prod?.return_days)
    const base = String(o.updated_at || o.created_at || '')
    if (!(eff.days > 0) || base === '' || Date.now() > new Date(base).getTime() + eff.days * 86400 * 1000) {
      return { ok: false, http: 409, error: `退货窗不可用(生效 ${eff.days} 天,${eff.source === 'order_snapshot' ? '下单时冻结' : '现商品行'})`, error_code: 'RETURN_WINDOW_CLOSED' }
    }
    const active = db.prepare("SELECT id FROM return_requests WHERE order_id = ? AND status IN ('pending','accepted','accepted_pickup_pending','picked_up','await_refund','refund_marked') LIMIT 1").get(orderId)
    if (active) return { ok: false, http: 409, error: '已存在进行中的退货请求', error_code: 'RETURN_ALREADY_ACTIVE' }
    return { ok: true, c: { snapshot: { order_id: orderId, action, reason, refund_amount: Number(o.total_amount), rail }, summary: { moves_funds: false, note: `files a return request (default refund ${Number(o.total_amount)} ${rail === 'direct_p2p' ? '— Direct Pay refunds settle off-platform' : 'from escrow flow on acceptance path'}); the seller still decides` } } }
  }
  return { ok: false, http: 400, error: `action 须为 ${BUYER_ACTIONS.join('/')}`, error_code: 'BAD_ACTION' }
}

export function buyerActionParamsHash(snapshot: Record<string, unknown>): string { return sha(JSON.stringify(snapshot)) }

export function createBuyerActionRequest(db: Database.Database, args: {
  humanId: string; grantId: string; agentLabel: string; orderId: unknown; action: unknown; reason?: unknown; generateId: (p: string) => string
}): { ok: true; request_id: string; params_hash: string; economic_effect: Record<string, unknown>; duplicate?: boolean } | { ok: false; http: number; error: string; error_code: string; existing_request_id?: string } {
  const { humanId, grantId, agentLabel, generateId } = args
  const orderId = typeof args.orderId === 'string' ? args.orderId : ''
  const action = typeof args.action === 'string' ? args.action : ''
  const reason = typeof args.reason === 'string' ? args.reason : null
  if (!orderId) return { ok: false, http: 400, error: 'order_id 必填', error_code: 'ORDER_NOT_FOUND' }
  const ev = evaluate(db, humanId, orderId, action, reason)
  if (!ev.ok) return ev
  const paramsHash = buyerActionParamsHash(ev.c.snapshot)
  const requestId = generateId('apr')
  try {
    db.prepare(`INSERT INTO agent_permission_requests
        (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, action_params)
      VALUES (?,?,?,?, '[]', 'high', 'once', 'pending', ?, 'buyer_action', ?, ?, ?, ?)`)
      .run(requestId, humanId, grantId, agentLabel, new Date(Date.now() + 24 * 3600_000).toISOString(), orderId, action, paramsHash, JSON.stringify(ev.c.snapshot))
    return { ok: true, request_id: requestId, params_hash: paramsHash, economic_effect: ev.c.summary }
  } catch (e) {
    if (!/UNIQUE|PRIMARY/i.test((e as Error).message)) return { ok: false, http: 503, error: '提交暂不可用', error_code: 'BUYER_ACTION_UNAVAILABLE' }
    const prev = db.prepare("SELECT id, params_hash, status, expires_at FROM agent_permission_requests WHERE kind = 'buyer_action' AND order_id = ? AND order_action = ? AND status IN ('pending','approved') AND executed_at IS NULL LIMIT 1").get(orderId, action) as { id: string; params_hash: string; status: string; expires_at: string } | undefined
    if (!prev) return { ok: false, http: 409, error: '提交冲突,请重试', error_code: 'BUYER_ACTION_UNAVAILABLE' }
    if (prev.status === 'pending' && prev.expires_at <= new Date().toISOString()) {
      db.prepare("UPDATE agent_permission_requests SET status = 'expired' WHERE id = ? AND status = 'pending'").run(prev.id)
      return createBuyerActionRequest(db, args)
    }
    if (prev.params_hash === paramsHash) return { ok: true, request_id: prev.id, params_hash: paramsHash, economic_effect: ev.c.summary, duplicate: true }
    return { ok: false, http: 409, error: '同订单同动作已有一条活跃请求(经济后果已变)—— 请先处理或拒绝已有请求', error_code: 'BUYER_ACTION_PENDING', existing_request_id: prev.id }
  }
}

/** 人工审批卡摘要(域层 sync 读;action_params 即快照,零 PII —— 全是金额/状态/枚举)。 */
export function buyerActionSummary(db: Database.Database, requestId: string): Record<string, unknown> | null {
  const r = db.prepare("SELECT order_id, order_action, action_params FROM agent_permission_requests WHERE id = ? AND kind = 'buyer_action'").get(requestId) as { order_id: string; order_action: string; action_params: string | null } | undefined
  if (!r) return null
  let snap: Record<string, unknown> = {}
  try { snap = r.action_params ? JSON.parse(r.action_params) as Record<string, unknown> : {} } catch { snap = {} }
  const o = db.prepare('SELECT status, total_amount, payment_rail, product_id FROM orders WHERE id = ?').get(r.order_id) as Record<string, unknown> | undefined
  const prod = o ? db.prepare('SELECT title FROM products WHERE id = ?').get(String(o.product_id)) as { title: string } | undefined : undefined
  return { order_id: r.order_id, action: r.order_action, snapshot: snap, current_status: o ? String(o.status) : null, total_amount: o ? Number(o.total_amount) : null, payment_rail: o ? String(o.payment_rail ?? 'escrow') : null, product_title: prod?.title ?? null }
}

/** Passkey 批准执行:重验(同谓词重算 hash 必须一致)→ 回环真实路由 → oracle 恢复。 */
export async function approveBuyerAction(db: Database.Database, deps: {
  requestId: string; approverId: string; nowIso: string; apiLoopback: ApiLoopback
}): Promise<{ ok: boolean; http?: number; error?: string; error_code?: string; executed?: string; already_executed?: boolean }> {
  const { requestId, approverId, nowIso, apiLoopback } = deps
  const fail = (error_code: string, http: number, error: string) => ({ ok: false, error_code, http, error })
  const failTerminal = (error_code: string, http: number, error: string) => {
    db.prepare("UPDATE agent_permission_requests SET status = 'failed' WHERE id = ? AND executed_at IS NULL").run(requestId)
    return fail(error_code, http, error)
  }
  const r = db.prepare("SELECT * FROM agent_permission_requests WHERE id = ? AND kind = 'buyer_action'").get(requestId) as Record<string, unknown> | undefined
  if (!r) return fail('BUYER_ACTION_NOT_FOUND', 404, '请求不存在')
  if (r.human_id !== approverId) return fail('NOT_YOUR_REQUEST', 403, '不是你的请求')
  const orderId = String(r.order_id); const action = String(r.order_action)
  // 天然 oracle:目标状态已达成 → already_executed(崩溃边界收敛,绝不重复经济动作)
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as { status: string } | undefined
  const oracleDone = (action === 'confirm_receipt' && o && ['confirmed', 'completed'].includes(o.status))
    || (action === 'cancel' && o && o.status === 'cancelled')
    || (action === 'request_return' && !!db.prepare('SELECT id FROM return_requests WHERE order_id = ? LIMIT 1').get(orderId))
  if (r.executed_at || oracleDone) {
    db.prepare('UPDATE agent_permission_requests SET executed_at = COALESCE(executed_at, ?) WHERE id = ?').run(nowIso, requestId)
    return { ok: true, already_executed: true, executed: action }
  }
  const claim = db.prepare("UPDATE agent_permission_requests SET status = 'approved', approved_at = ? WHERE id = ? AND executed_at IS NULL AND ((status = 'pending' AND expires_at > ?) OR status = 'approved')").run(nowIso, requestId, nowIso)
  if (claim.changes !== 1) return fail('BUYER_ACTION_NOT_PENDING', 409, '请求已过期或已处理')
  // 同谓词重验:当前状态重算后果快照,与 Passkey 绑定的 hash 一字不差
  let snap: Record<string, unknown> = {}
  try { snap = r.action_params ? JSON.parse(String(r.action_params)) as Record<string, unknown> : {} } catch { snap = {} }
  const ev = evaluate(db, approverId, orderId, action, typeof snap.reason === 'string' ? snap.reason : null)
  if (!ev.ok) return failTerminal('BUYER_ACTION_DRIFT', 409, `当前状态下该动作已不成立(${ev.error_code})—— 请重新提交`)
  if (buyerActionParamsHash(ev.c.snapshot) !== String(r.params_hash)) return failTerminal('BUYER_ACTION_DRIFT', 409, '经济后果与你 Passkey 批准的不一致,已拒绝执行')
  const u = db.prepare('SELECT api_key FROM users WHERE id = ?').get(approverId) as { api_key: string } | undefined
  if (!u) return fail('BUYER_ACTION_UNAVAILABLE', 503, '账户不可用')
  // 执行 = 回环真实人类路由(结算/守卫/时间线全生产同路)
  const lb = action === 'request_return'
    ? await apiLoopback(u.api_key, `/api/orders/${encodeURIComponent(orderId)}/return-request`, { reason: String(snap.reason), refund_amount: Number(snap.refund_amount) }).catch(() => null)
    : await apiLoopback(u.api_key, `/api/orders/${encodeURIComponent(orderId)}/action`, { action: action === 'confirm_receipt' ? 'confirm' : 'cancel' }).catch(() => null)
  if (!lb) return { ok: false, http: 502, error: '执行结果不明 —— 请求保持可重批;再次批准会先核对是否已生效,绝不重复执行。', error_code: 'BUYER_ACTION_AMBIGUOUS' }
  const success = lb.status >= 200 && lb.status < 300 && !(lb.json && (lb.json.error || lb.json.error_code))
  if (!success) {
    if (lb.status >= 500) return { ok: false, http: 502, error: '执行结果不明(上游 5xx)—— 保持可重批,先核对再执行。', error_code: 'BUYER_ACTION_AMBIGUOUS' }
    return failTerminal(String(lb.json?.error_code || 'BUYER_ACTION_REJECTED'), 409, `执行被拒绝(${String(lb.json?.error_code || lb.json?.error || `HTTP_${lb.status}`)})—— 请求已终结,可修正后重新提交`)
  }
  db.prepare('UPDATE agent_permission_requests SET executed_at = ?, execution_result = ? WHERE id = ? AND executed_at IS NULL').run(nowIso, JSON.stringify({ ok: true, action }), requestId)
  return { ok: true, executed: action }
}
