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
import { getMutualCancelState } from '../layer3-trust/L3-1-dispute-engine/mutual-cancel.js'

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

/**
 * 服务端权威动作面 —— 与人类路由【同谓词】推导(Codex HIGH:状态数组是虚假广告):
 *   confirm_receipt 仅 delivered(transitions delivered→confirmed;dp 另需披露 ack+Passkey);
 *   open_dispute = 状态机允许集原样(paid/accepted/shipped/picked_up/in_transit/delivered,
 *     dp 另有 direct_expired_unconfirmed/payment_query);
 *   dp 买家取消 = orders-action 权威门同谓词(direct_pay_window / payment_query / direct_expired_unconfirmed);
 *   request_return = returns 路由同谓词(completed + 现商品 return_days>0 + 窗口内 + 无活跃请求);
 *   disputed 收口 = orders-read 同谓词(最近一次 from delivered + 买家为发起人 + 争议未裁定 → 撤诉确认收货;
 *     from payment_query → 撤回仲裁)+ 协商取消直接复用 getMutualCancelState 域 helper。
 * escrow 的 paid/accepted 没有买家单方取消 —— 不广告(双方合意走 disputed 里的协商取消)。
 */
function availableActions(db: Database.Database, o: Record<string, unknown>, humanId: string, returns: Array<Record<string, unknown>>): Array<Record<string, string>> {
  const status = String(o.status ?? ''); const rail = String(o.payment_rail ?? 'escrow'); const orderId = String(o.id)
  const acts: Array<Record<string, string>> = []
  if (status === 'delivered') acts.push({ action: 'confirm_receipt', executor: 'human_order_page', note: rail === 'direct_p2p' ? 'delivered only; Direct Pay confirm additionally requires disclosure acks + a live Passkey' : 'delivered only; confirming releases escrow to the seller' })
  const DISPUTE_FROM = ['paid', 'accepted', 'shipped', 'picked_up', 'in_transit', 'delivered', 'delivery_failed']   // delivery_failed→disputed 买家可发(transitions:410)
  if (DISPUTE_FROM.includes(status) || (rail === 'direct_p2p' && ['direct_expired_unconfirmed', 'payment_query'].includes(status))) {
    acts.push({ action: 'open_dispute', executor: 'human_order_page', note: 'evidence required; 48h respond / 120h arbitrate clocks' })
  }
  if (rail === 'direct_p2p' && status === 'direct_pay_window') {
    acts.push({ action: 'pay_seller_offplatform_then_mark_paid', executor: 'human_order_page', note: 'funds move off-platform per the payment instruction (D1/D2 Passkey acks first), then mark paid' })
    acts.push({ action: 'request_cancel', executor: 'human_order_page', note: 'cancel inside the payment window (before paying)' })
  }
  if (rail === 'direct_p2p' && ['payment_query', 'direct_expired_unconfirmed'].includes(status)) {
    acts.push({ action: 'request_cancel', executor: 'human_order_page', note: 'cancel by confirming non-payment (negotiation / expired grace)' })
  }
  if (status === 'completed') {
    const prod = db.prepare('SELECT return_days FROM products WHERE id = ?').get(String(o.product_id)) as { return_days: number | null } | undefined
    const rd = Number(prod?.return_days || 0)
    const baseTime = String(o.updated_at || o.created_at || '')
    const within = rd > 0 && baseTime !== '' && Date.now() <= new Date(baseTime).getTime() + rd * 86400 * 1000
    const activeRR = returns.some(r => ['pending', 'accepted', 'accepted_pickup_pending', 'picked_up', 'await_refund', 'refund_marked'].includes(String(r.status)))
    if (within && !activeRR) acts.push({ action: 'request_return', executor: 'human_order_page', note: `route-enforced window: CURRENT listing return_days=${rd} from ${baseTime.slice(0, 10)} (the frozen snapshot above is the promise anchor for disputes; the return route is governed by the live listing — recorded upstream gap)` })
  }
  // 路由权威门 = direct_p2p 且 refund_marked(direct-pay-returns.ts):escrow 退款走托管释放,无此人工确认动作
  if (rail === 'direct_p2p' && returns.some(r => String(r.status) === 'refund_marked')) acts.push({ action: 'confirm_refund_received', executor: 'human_order_page', note: 'seller marked the off-platform refund sent — your Passkey confirmation closes the return (Direct Pay only)' })
  if (status === 'disputed') {
    const froms = (db.prepare("SELECT from_status FROM order_state_history WHERE order_id = ? AND to_status = 'disputed' ORDER BY created_at, id").all(orderId) as Array<{ from_status: string | null }>).map(r => String(r.from_status ?? ''))
    const lastFrom = froms[froms.length - 1]
    const disp = db.prepare("SELECT initiator_id FROM disputes WHERE order_id = ? AND status NOT IN ('resolved','dismissed') ORDER BY created_at DESC LIMIT 1").get(orderId) as { initiator_id: string } | undefined
    if (lastFrom === 'delivered' && disp && disp.initiator_id === humanId) acts.push({ action: 'withdraw_dispute_confirm_receipt', executor: 'human_order_page', note: 'mutual closure: withdrawing confirms receipt (only for YOUR delivery dispute, undecided)' })
    if (lastFrom === 'payment_query' && disp) acts.push({ action: 'withdraw_payment_query_dispute', executor: 'human_order_page', note: 'withdraw the payment-query arbitration' })
    try {
      const mc = getMutualCancelState(db, orderId, humanId) as unknown as Record<string, unknown>
      if (mc && mc.ok) {
        if (mc.can_propose) acts.push({ action: 'mutual_cancel_propose', executor: 'human_order_page', note: 'no-fault cancellation by mutual consent' })
        if (mc.can_accept) acts.push({ action: 'mutual_cancel_accept', executor: 'human_order_page', note: 'accept the counterparty cancellation proposal' })
        if (mc.can_decline) acts.push({ action: 'mutual_cancel_decline', executor: 'human_order_page', note: 'decline the cancellation proposal' })
        if (mc.can_withdraw) acts.push({ action: 'mutual_cancel_withdraw', executor: 'human_order_page', note: 'withdraw your cancellation proposal' })
      }
    } catch { /* mutual-cancel schema 未初始化的库:不广告 */ }
  }
  acts.push({ action: 'prepare_case', executor: 'agent_tool', tool: 'webaz_prepare_case', note: 'read-only after-sales case draft' })
  acts.push({ action: 'check_approval_status', executor: 'agent_tool', tool: 'webaz_approval_requests', note: 'status of pending approvals' })
  return acts
}

export function buildBuyerOrderFull(db: Database.Database, humanId: string, orderId: unknown):
  { ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> } {
  if (typeof orderId !== 'string' || !orderId) return { ok: false, status: 400, body: { error_code: 'ORDER_NOT_FOUND', reason: 'order_id is required', retryable: true } }
  const cols = [...BUYER_MINIMAL_ORDER_COLUMNS, 'created_at', 'updated_at', 'quantity', 'ship_to_region', 'shipping_fee', 'shipping_est_days', 'trade_terms_snapshot', 'direct_pay_window_deadline'].join(', ')
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
    available_actions: availableActions(db, o, humanId, returns),
    actions_note: 'Server-authoritative list — do NOT infer other actions from the state machine. executor=human_order_page actions happen at webaz.xyz; agents cannot execute them.',
  } }
}
