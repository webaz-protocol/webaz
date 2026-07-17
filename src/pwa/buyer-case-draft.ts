/**
 * RFC-025 PR-6 — 买家售后案件草稿组装(纯只读 · 零写入 · 零经济 · 零 PII)。
 *
 * 职责:把一张【本人】订单的服务端事实打包成结构化案件草稿,供 agent 帮买家整理售后思路:
 *   状态时间线(from/to/actor_role/时间 —— 【不含】notes/evidence 描述,那些自由文本可能携带 PII,
 *   细节人到 PWA 订单页看)+ 商品原始声明快照(标题/承诺哈希/退货/保修 —— 卖家当初承诺的可核对锚点)
 *   + 证据 ref 列表(仅 id/type/时间)+ 售后分流指引(运输类争议 vs 商品声明验证,S 系列口径)。
 *
 * 不做的事(全部指向现有人路径,如实声明"human path ≠ Passkey path"现状):
 *   不提交争议/退货/撤诉,不冻结/释放资金,不写任何表。提交类售后 action request(approve-to-execute
 *   形态)记为 follow-up,需求触发再建 —— 不造死能力(draft_order 教训)。
 */
import type Database from 'better-sqlite3'

const maskId = (id: string): string => !id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `${id.slice(0, 2)}…`

export function buildCaseDraft(db: Database.Database, humanId: string, orderId: unknown):
  { ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> } {
  if (typeof orderId !== 'string' || !orderId) {
    return { ok: false, status: 400, body: { error_code: 'ORDER_NOT_FOUND', reason: 'order_id is required', retryable: true, missing_requirements: ['order_id'], next_steps: [] } }
  }
  const order = db.prepare('SELECT id, status, product_id, seller_id, payment_rail, quantity, total_amount, created_at FROM orders WHERE id = ? AND buyer_id = ?')
    .get(orderId, humanId) as Record<string, unknown> | undefined
  if (!order) return { ok: false, status: 404, body: { error_code: 'ORDER_NOT_FOUND', reason: 'no such order (or not yours)', retryable: false, missing_requirements: [], next_steps: ['webaz_buyer_orders'] } }

  // 时间线:只取结构字段(notes/evidence 描述是自由文本,可能携 PII —— 一律不出)
  const timeline = (db.prepare('SELECT from_status, to_status, actor_role, created_at FROM order_state_history WHERE order_id = ? ORDER BY created_at, id LIMIT 100')
    .all(orderId) as Array<Record<string, unknown>>).map(r => ({
      from: r.from_status == null ? null : String(r.from_status), to: String(r.to_status),
      actor_role: r.actor_role == null ? null : String(r.actor_role), at: String(r.created_at),
    }))
  // 商品原始声明(卖家当初的承诺锚点;哈希可供声明验证对质)
  const prod = db.prepare('SELECT title, commitment_hash, description_hash, price_hash, hashed_at, return_days, return_condition, warranty_days, import_duty_terms FROM products WHERE id = ?')
    .get(String(order.product_id)) as Record<string, unknown> | undefined
  // 证据 refs:仅 id/type/时间(描述/文件路径不出)
  const evidence = (db.prepare('SELECT id, type, created_at FROM evidence WHERE order_id = ? ORDER BY created_at LIMIT 50')
    .all(orderId) as Array<Record<string, unknown>>).map(r => ({ evidence_ref: String(r.id), type: r.type == null ? null : String(r.type), at: String(r.created_at) }))
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
    original_claims: prod ? {
      title: String(prod.title),
      commitment_hash: prod.commitment_hash ?? null, description_hash: prod.description_hash ?? null,
      price_hash: prod.price_hash ?? null, hashed_at: prod.hashed_at ?? null,
      return_days: prod.return_days ?? null, return_condition: prod.return_condition ?? null,
      warranty_days: prod.warranty_days ?? null, import_duty_terms: prod.import_duty_terms ?? null,
      note: 'seller-declared claims as anchored at listing time; hashes let a claim-verification case prove drift',
    } : null,
    evidence_refs: evidence,
    existing_dispute: dispute ? { dispute_id: String(dispute.id), status: String(dispute.status), type: dispute.dispute_type == null ? null : String(dispute.dispute_type), at: String(dispute.created_at) } : null,
    routing_guide: {
      delivery_problem: 'not received / seller never shipped / lost or damaged in transit / wrong delivery → DELIVERY DISPUTE (order page → dispute; 48h respond / 120h arbitrate clocks)',
      claim_problem: 'received but the listing lied — counterfeit / spec mismatch / not-new / material / origin / warranty claims → CLAIM VERIFICATION (order page → claim-verification; stakes 10 WAZ, 3 verifiers)',
      note: 'This draft is preparation ONLY. Submitting a dispute, escalating, confirming receipt, accepting a refund, or closing a case are done by the human on the order page at webaz.xyz (today those human paths are session-authed; direct_p2p risk actions additionally require a Passkey). Nothing here submits anything.',
    },
    detail_note: 'Free-text details (state-change notes, evidence descriptions) may contain personal data and are NOT included — view them on the order page.',
    economic_action_executed: false,
  } }
}
