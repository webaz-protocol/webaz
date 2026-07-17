/**
 * RFC-025 PR-6 — 买家售后案件草稿组装(纯读 · 零域写 · 零经济 · 无买家个人数据)。
 *
 * 职责:把一张【本人】订单的服务端事实打包成结构化案件草稿,供 agent 帮买家整理售后思路:
 *   状态时间线(from/to/actor_role/时间 —— 【不含】notes/evidence 描述,那些自由文本可能携带 PII,
 *   细节人到 PWA 订单页看)+ 成交条款(orders.trade_terms_snapshot,下单时刻冻结 —— 商家事后改
 *   设置不影响;这才是"当初承诺"的权威锚点)+ 当前商品行锚点(标题/哈希,标注为【当前值】,可能
 *   已被卖家改过)+ 证据 ref 列表(id/归一化 type/时间)+ 售后分流指引(运输争议 vs 两级声明验证)。
 *
 * 文本边界(Codex round-1 收敛):自由文本一律不出 —— 订单/时间线 notes、evidence 描述、地址、
 *   return_condition/estimated_days(卖家自由文本)全部 withheld;唯一放行的卖家文本是商品标题
 *   (公开 listing 数据,与 webaz_search 同一暴露面)。evidence.type 经 allowlist 归一化
 *   (add-evidence 路径接受任意字符串,不能原样透传)。
 *
 * 写边界:本模块零写。route 层的 agent_grant_auth_log append-only 授权审计对【所有】grant 请求
 *   一视同仁地记录(RFC-020 §3.7 不变量),不属于域状态写 —— 披露口径见 tool-annotations。
 *
 * 不做的事(全部指向现有人路径):不提交争议/退货/撤诉,不冻结/释放资金。提交类售后 action request
 *   (approve-to-execute 形态)记为 follow-up,需求触发再建 —— 不造死能力(draft_order 教训)。
 */
import type Database from 'better-sqlite3'
import { readTradeTermsSnapshot } from '../trade-terms.js'

const maskId = (id: string): string => !id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `${id.slice(0, 2)}…`

// add-evidence 接受任意 evidence_type 字符串 → 只透传已知词表,未知归一化为 'other'(防自由文本走私)
const EVIDENCE_TYPES = new Set(['text', 'image', 'video', 'document', 'chain_data'])
const normEvidenceType = (t: unknown): string => (typeof t === 'string' && EVIDENCE_TYPES.has(t) ? t : 'other')

export function buildCaseDraft(db: Database.Database, humanId: string, orderId: unknown):
  { ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> } {
  if (typeof orderId !== 'string' || !orderId) {
    return { ok: false, status: 400, body: { error_code: 'ORDER_NOT_FOUND', reason: 'order_id is required', retryable: true, missing_requirements: ['order_id'], next_steps: [] } }
  }
  const order = db.prepare('SELECT id, status, product_id, seller_id, payment_rail, quantity, total_amount, created_at, trade_terms_snapshot FROM orders WHERE id = ? AND buyer_id = ?')
    .get(orderId, humanId) as Record<string, unknown> | undefined
  if (!order) return { ok: false, status: 404, body: { error_code: 'ORDER_NOT_FOUND', reason: 'no such order (or not yours)', retryable: false, missing_requirements: [], next_steps: ['webaz_buyer_orders'] } }

  // 时间线:只取结构字段(notes/evidence 描述是自由文本,可能携 PII —— 一律不出)
  const timeline = (db.prepare('SELECT from_status, to_status, actor_role, created_at FROM order_state_history WHERE order_id = ? ORDER BY created_at, id LIMIT 100')
    .all(orderId) as Array<Record<string, unknown>>).map(r => ({
      from: r.from_status == null ? null : String(r.from_status), to: String(r.to_status),
      actor_role: r.actor_role == null ? null : String(r.actor_role), at: String(r.created_at),
    }))
  // 成交条款权威锚点 = 下单时刻冻结的 trade_terms_snapshot(S0);缺失(pre-S0 订单)如实报 unavailable
  const snap = readTradeTermsSnapshot(order.trade_terms_snapshot)
  const orderTimeTerms = snap ? {
    source: 'order_snapshot' as const, captured_at: snap.captured_at,
    return_days: snap.fulfilment.return_days, warranty_days: snap.fulfilment.warranty_days,
    handling_hours: snap.fulfilment.handling_hours,
    import_duty_terms: snap.declarations.import_duty_terms,
    note: 'Terms FROZEN at order time (seller edits after your order do not apply). Free-text terms (return condition wording, delivery estimates) are on the order page.',
  } : {
    source: 'unavailable' as const,
    note: 'This order predates order-time terms snapshots — the terms in force are on the order page; current listing values below may have changed since your order.',
  }
  // 当前商品行(标注为当前值 —— 卖家可改;标题=公开 listing 数据,与 webaz_search 同暴露面)
  const prod = db.prepare('SELECT title, commitment_hash, description_hash, price_hash, hashed_at FROM products WHERE id = ?')
    .get(String(order.product_id)) as Record<string, unknown> | undefined
  // 证据 refs:仅 id/归一化 type/时间(描述/文件路径/原始 type 字符串不出)
  const evidence = (db.prepare('SELECT id, type, created_at FROM evidence WHERE order_id = ? ORDER BY created_at LIMIT 50')
    .all(orderId) as Array<Record<string, unknown>>).map(r => ({ evidence_ref: String(r.id), type: normEvidenceType(r.type), at: String(r.created_at) }))
  const dispute = db.prepare('SELECT id, status, dispute_type, created_at FROM disputes WHERE order_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(orderId) as Record<string, unknown> | undefined

  return { ok: true, response: {
    case_draft: true,
    order: {
      order_id: String(order.id), status: String(order.status), payment_rail: String(order.payment_rail),
      quantity: Number(order.quantity), amount: Number(order.total_amount), created_at: String(order.created_at),
      item_ref: String(order.product_id), seller_id_hint: maskId(String(order.seller_id)),
    },
    timeline,
    order_time_terms: orderTimeTerms,
    current_listing: prod ? {
      title: String(prod.title),
      commitment_hash: prod.commitment_hash ?? null, description_hash: prod.description_hash ?? null,
      price_hash: prod.price_hash ?? null, hashed_at: prod.hashed_at ?? null,
      note: 'CURRENT listing state (the seller can edit a listing after your order) — do not treat as the original promise; order_time_terms above is authoritative for terms.',
    } : null,
    evidence_refs: evidence,
    existing_dispute: dispute ? { dispute_id: String(dispute.id), status: String(dispute.status), type: dispute.dispute_type == null ? null : String(dispute.dispute_type), at: String(dispute.created_at) } : null,
    routing_guide: {
      delivery_problem: 'not received / seller never shipped / lost or damaged in transit / wrong delivery → DELIVERY DISPUTE (order page → dispute; 48h respond / 120h arbitrate clocks)',
      claim_problem_order: 'your ORDER terms were broken — return / warranty / price / handling / protection promises → ORDER CLAIM VERIFICATION (order page → claim-verification; stake 10 WAZ, 48h deadline, 3 verifiers)',
      claim_problem_listing: 'the LISTING itself lies — counterfeit / spec mismatch / origin / condition / title claims → PRODUCT CLAIM VERIFICATION (product page → claim challenge; stake 5 WAZ, 72h deadline, 3 verifiers)',
      note: 'This draft is preparation ONLY. Submitting a dispute, escalating, confirming receipt, accepting a refund, or closing a case are done by the human on the order page at webaz.xyz (today those human paths are session-authed; direct_p2p risk actions additionally require a Passkey). Nothing here submits anything.',
    },
    detail_note: 'No buyer personal data is included: addresses, free-text notes, evidence descriptions and seller free-text terms are withheld — view them on the order page. The only seller text returned is the public listing title.',
    economic_action_executed: false,
  } }
}
