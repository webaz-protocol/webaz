/**
 * RFC-026 PR-3 — 买家订单【全量只读】投影(safe scope buyer_orders_read)。
 *
 * 让 agent 能回答:订单现在什么状态 / 下一责任人是谁 / 截止时间 / 商家接单发货没有 / 冻结的退货保修
 * 期是什么 / 退款到哪一步 / 现在有哪些动作可做 —— 全部服务端权威,agent 不自行推测状态机。
 *
 * 组合而非复刻:基座 = minimalBuyerOrderView(next_actor/deadline 与人类订单视图同源,不 drift);
 * 条款 = orders.trade_terms_snapshot(下单时刻冻结,PR-6 同款 shape 守卫);时间线 = 结构字段 only。
 *
 * 零 PII 纪律(I6 同强度):地址/notes/收件人连取都不取;物流 tracking 只回【agent 提交并被 Passkey
 * 批准执行】的 ship 动作里的单号(本就经 I6 sanitize);人工在订单页录入的单号如实标注去订单页看。
 * available_actions 诚实标注执行者:executor='agent_tool'(现有工具)或 'human_order_page'(人在
 * webaz.xyz 订单页操作)—— 绝不暗示 agent 能执行它不能执行的动作。
 */
import type Database from 'better-sqlite3'
import { minimalBuyerOrderView, BUYER_MINIMAL_ORDER_COLUMNS } from './agent-order-minimal-view.js'
import { readTradeTermsSnapshot } from '../trade-terms.js'

const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

function orderTimeTerms(raw: unknown): Record<string, unknown> {
  const snap = readTradeTermsSnapshot(raw)
  const fulfil = snap && typeof snap.fulfilment === 'object' && snap.fulfilment !== null ? snap.fulfilment : null
  const decl = snap && typeof snap.declarations === 'object' && snap.declarations !== null ? snap.declarations : null
  if (!fulfil || !decl) return { source: 'unavailable', note: 'No usable order-time terms snapshot — terms in force are on the order page.' }
  return {
    source: 'order_snapshot', captured_at: String(snap!.captured_at ?? ''),
    return_days: numOrNull(fulfil.return_days), warranty_days: numOrNull(fulfil.warranty_days),
    handling_hours: numOrNull(fulfil.handling_hours),
    import_duty_terms: decl.import_duty_terms === 'ddu' || decl.import_duty_terms === 'ddp' ? decl.import_duty_terms : null,
    note: 'Terms FROZEN at order time — seller edits after your order do not apply.',
  }
}

/** agent 路径已执行 ship 动作的单号(I6 sanitize 过);人工录入的单号不在此,如实指去订单页。 */
function agentShipTracking(db: Database.Database, orderId: string): string | null {
  const r = db.prepare("SELECT action_params FROM agent_permission_requests WHERE kind = 'order_action' AND order_action = 'ship' AND order_id = ? AND executed_at IS NOT NULL ORDER BY executed_at DESC LIMIT 1")
    .get(orderId) as { action_params: string | null } | undefined
  try { const p = r?.action_params ? JSON.parse(r.action_params) as { tracking?: string } : null; return p?.tracking ? String(p.tracking) : null } catch { return null }
}

/** 服务端权威动作面:按状态+轨枚举,逐项标注执行者 —— agent 不自行推测状态机(RFC-026 §L2)。 */
function availableActions(status: string, rail: string): Array<Record<string, string>> {
  const acts: Array<Record<string, string>> = []
  const preShip = ['created', 'paid', 'pending_accept', 'direct_pay_window', 'accepted']
  const inFlight = ['shipped', 'in_transit', 'picked_up', 'delivered']
  if (preShip.includes(status)) acts.push({ action: 'request_cancel', executor: 'human_order_page', note: 'cancellation before shipment on the order page' })
  if (rail === 'direct_p2p' && status === 'direct_pay_window') acts.push({ action: 'pay_seller_offplatform', executor: 'human_order_page', note: 'Direct Pay: funds move off-platform per the payment instruction (Passkey D1/D2 acks first)' })
  if (inFlight.includes(status)) {
    acts.push({ action: 'confirm_receipt', executor: 'human_order_page', note: 'confirming releases escrow to the seller (escrow rail)' })
    acts.push({ action: 'open_dispute', executor: 'human_order_page', note: 'delivery dispute (48h respond / 120h arbitrate clocks)' })
  }
  if (['delivered', 'confirmed', 'completed'].includes(status)) acts.push({ action: 'request_return', executor: 'human_order_page', note: 'within the frozen return window (see order_time_terms.return_days)' })
  if (status === 'disputed') acts.push({ action: 'withdraw_dispute_confirm_receipt', executor: 'human_order_page', note: 'mutual closure: withdrawing confirms receipt' })
  acts.push({ action: 'prepare_case', executor: 'agent_tool', tool: 'webaz_prepare_case', note: 'read-only after-sales case draft' })
  acts.push({ action: 'check_approval_status', executor: 'agent_tool', tool: 'webaz_approval_requests', note: 'status of pending approvals' })
  return acts
}

export function buildBuyerOrderFull(db: Database.Database, humanId: string, orderId: unknown):
  { ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> } {
  if (typeof orderId !== 'string' || !orderId) return { ok: false, status: 400, body: { error_code: 'ORDER_NOT_FOUND', reason: 'order_id is required', retryable: true } }
  const cols = [...BUYER_MINIMAL_ORDER_COLUMNS, 'created_at', 'quantity', 'ship_to_region', 'shipping_fee', 'shipping_est_days', 'trade_terms_snapshot', 'direct_pay_window_deadline'].join(', ')
  const o = db.prepare(`SELECT ${cols} FROM orders WHERE id = ? AND buyer_id = ?`).get(orderId, humanId) as Record<string, unknown> | undefined
  if (!o) return { ok: false, status: 404, body: { error_code: 'ORDER_NOT_FOUND', reason: 'no such order (or not yours)', retryable: false } }

  const base = minimalBuyerOrderView(o, db)
  const timeline = (db.prepare('SELECT from_status, to_status, actor_role, created_at FROM order_state_history WHERE order_id = ? ORDER BY created_at, id LIMIT 100')
    .all(orderId) as Array<Record<string, unknown>>).map(r => ({
      from: r.from_status == null ? null : String(r.from_status), to: String(r.to_status),
      actor_role: r.actor_role == null ? null : String(r.actor_role), at: String(r.created_at),
    }))
  const returns = (db.prepare('SELECT status, refund_amount, created_at, resolved_at FROM return_requests WHERE order_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(orderId) as Array<Record<string, unknown>>).map(r => ({
      status: String(r.status), refund_amount: r.refund_amount == null ? null : Number(r.refund_amount),
      created_at: String(r.created_at), resolved_at: r.resolved_at == null ? null : String(r.resolved_at),
    }))
  const status = String(o.status ?? '')
  const rail = String(o.payment_rail ?? 'escrow')
  const tracking = agentShipTracking(db, orderId)

  return { ok: true, response: {
    order: { ...base, quantity: numOrNull(Number(o.quantity)), created_at: String(o.created_at ?? '') },
    timeline,
    order_time_terms: orderTimeTerms(o.trade_terms_snapshot),
    logistics: {
      dest_region: o.ship_to_region == null ? null : String(o.ship_to_region),
      shipping_fee: o.shipping_fee == null ? null : Number(o.shipping_fee),
      shipping_est_days: o.shipping_est_days == null ? null : String(o.shipping_est_days),
      tracking, tracking_note: tracking ? 'tracking from the Passkey-approved agent ship action' : 'human-entered tracking (if any) is on the order page — never exposed to agents here',
    },
    deadlines: {
      active: base.deadline, next_actor: base.next_actor,
      pay: o.pay_deadline ?? null, accept: o.accept_deadline ?? o.pending_accept_deadline ?? null, ship: o.ship_deadline ?? null,
      delivery: o.delivery_deadline ?? null, confirm: o.confirm_deadline ?? null,
      direct_pay_window: o.direct_pay_window_deadline ?? null,
    },
    refund_status: {
      rail, return_requests: returns,
      note: rail === 'direct_p2p'
        ? 'Direct Pay refunds settle OFF-platform (seller→buyer handshake); WebAZ records outcomes but moves no funds.'
        : 'Escrow-rail refunds release from escrow per dispute/return outcomes (escrow currently simulated WAZ).',
    },
    available_actions: availableActions(status, rail),
    actions_note: 'Server-authoritative list — do NOT infer other actions from the state machine. executor=human_order_page actions happen at webaz.xyz; agents cannot execute them.',
  } }
}
