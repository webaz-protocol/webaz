/**
 * Direct Pay (Rail 1) — 判责关单后【退款握手 + 举证升级】域模块(P1-D 买家事后救济,方案 A)。
 *
 * 背景:direct_p2p 单买家场外付款后,卖家超时未发货被系统判责关单(fault_seller→completed 终态)。
 *   非托管协议不持货款、不能代退 —— 买家的钱在协议外。此前买家唯一手段是订单聊天,协议内零救济。
 *   本模块给出订单外挂救济通道(订单状态永远不动,completed 终态不变量不破):
 *     ① 买家 request(申请场外退款)→ ② 卖家 mark_refunded(声明已场外退款,可附退款参考)→
 *     ③ 买家 confirm(确认收到;RISK:现场真人 Passkey)→ 握手 settled(纯记录,零资金零状态转移)。
 *   卖家 decline / 超时不响应 / 声明退款但买家未收到 → 买家可【举证升级】:建 dispute_type='fault_refund_claim'
 *   争议进统一仲裁台(信誉裁决:唯一裁决器 resolveFaultRefundClaim,绝不动订单状态、绝不涉资金)。
 *
 * 【关键不变量 / 安全边界】(镜像 direct-pay-cancel-refund 审计项 C)
 *  1. 仅 direct_p2p + status='completed' + settled_fault_at 非空 + completed 事件来源=fault_seller
 *     + 买家曾标记付款(history 有 to_status='accepted' 行)可发起;escrow / 正常成交 / 未付款一律拒。
 *  2. 只有订单 buyer 可 request/withdraw/confirm/escalate,只有 seller 可 decline/mark_refunded;
 *     状态读取 party-gated(非当事方 NOT_A_PARTY,不泄露存在性)。
 *  3. confirm 是终局记录动作:请求行 CAS(refund_marked→settled);【零资金、零订单转移、零库存】
 *     (判责结算 settleFault 已回补库存,此处绝不二次回补)。
 *  4. 卖家超时不响应(respond_deadline,默认 5 天,param direct_pay.fault_refund_respond_days):lazy 过期
 *     (读时映射 expired);无 cron 自动裁定握手本身 —— 但买家可升级举证仲裁(争议侧有超时兜底)。
 *  5. 防骚扰:每单累计最多 3 次 request;举证升级每单至多 1 条 fault_refund_claim 争议(部分唯一索引兜底)。
 *  6. 争议裁决绝不经 arbitrateDispute(其结算路径会对 completed 订单做非法转移)——唯一裁决器见
 *     layer3 fault-refund-resolve.ts;checkDisputeTimeouts 对本类型走专用超时分支。
 */
import type Database from 'better-sqlite3'

export interface FaultRefundResult {
  ok: boolean
  error?: string
  error_code?: string
  request?: Record<string, unknown>
  status?: string
  dispute_id?: string
}

export function initDirectPayFaultRefundSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_fault_refund_requests (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','refund_marked','settled','declined','withdrawn','escalated')),
      reason TEXT,
      refund_reference TEXT,
      respond_deadline TEXT NOT NULL,
      seller_responded_at TEXT,
      settled_at TEXT,
      escalated_dispute_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dfrr_order ON direct_fault_refund_requests(order_id);
  `)
  // 幂等硬约束:一个订单至多一条 fault_refund_claim 争议(镜像 ux_disputes_decline_contest_order)。
  // disputes 表由 initDisputeSchema 先建;此处仅加部分唯一索引(表缺失时静默跳过,server 的 init 顺序保证生效)。
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_disputes_fault_refund_order ON disputes(order_id) WHERE dispute_type = 'fault_refund_claim'`) } catch { /* disputes 未建(独立工具场景)→ 由 server init 顺序保证 */ }
}

type OrderRow = { id: string; buyer_id: string; seller_id: string; status: string; payment_rail: string; settled_fault_at: string | null }

function loadOrder(db: Database.Database, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT id, buyer_id, seller_id, status, payment_rail, settled_fault_at FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
}

/**
 * 资格谓词:仅【卖家违约判责关单的直付单,且买家曾标记付款】。
 * completed 来源从 order_state_history 读(completed 行的 from_status='fault_seller' —— 含超时判责与
 * 主动拒单两条路;declined_nofault(无责拒单)不适用:该路径买家未付款或已按无责收口)。
 */
export function faultRefundEligible(db: Database.Database, order: OrderRow): { eligible: boolean; reason?: string } {
  if (order.payment_rail !== 'direct_p2p') return { eligible: false, reason: 'NOT_DIRECT_PAY' }
  if (order.status !== 'completed' || !order.settled_fault_at) return { eligible: false, reason: 'NOT_FAULT_CLOSED' }
  const completedRow = db.prepare("SELECT from_status FROM order_state_history WHERE order_id = ? AND to_status = 'completed' ORDER BY created_at DESC, id DESC LIMIT 1").get(order.id) as { from_status: string | null } | undefined
  if (!completedRow || completedRow.from_status !== 'fault_seller') return { eligible: false, reason: 'NOT_SELLER_FAULT_CLOSURE' }
  const paid = db.prepare("SELECT 1 FROM order_state_history WHERE order_id = ? AND to_status = 'accepted' LIMIT 1").get(order.id)
  if (!paid) return { eligible: false, reason: 'BUYER_NEVER_MARKED_PAID' }
  return { eligible: true }
}

function latestRequest(db: Database.Database, orderId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM direct_fault_refund_requests WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(orderId) as Record<string, unknown> | undefined
}

/** requested 且 respond_deadline 已过 → 视为 expired(lazy,不写库;可重新 request 或升级举证)。 */
function effectiveStatus(db: Database.Database, r: Record<string, unknown>): string {
  if (r.status === 'requested') {
    const over = db.prepare("SELECT datetime(?) < datetime('now') AS o").get(r.respond_deadline as string) as { o: number }
    if (over.o) return 'expired'
  }
  return r.status as string
}

function respondDays(db: Database.Database): number {
  try {
    const p = db.prepare("SELECT value FROM protocol_params WHERE key = 'direct_pay.fault_refund_respond_days'").get() as { value: string } | undefined
    if (p) return Math.max(1, Number(p.value) || 5)
  } catch { /* 表缺失 → 默认 */ }
  return 5
}

/** ① 买家发起退款握手。 */
export function requestFaultRefund(db: Database.Database, args: { orderId: string; buyerId: string; reason?: string | null; requestId: string }): FaultRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可发起退款握手', error_code: 'NOT_ORDER_BUYER' }
  const el = faultRefundEligible(db, order)
  if (!el.eligible) return { ok: false, error: '仅卖家违约判责关单且已标记付款的直付订单可发起', error_code: el.reason || 'NOT_ELIGIBLE' }
  const last = latestRequest(db, args.orderId)
  const eff = last ? effectiveStatus(db, last) : null
  if (eff && ['requested', 'refund_marked'].includes(eff)) return { ok: false, error: '已有进行中的退款握手', error_code: 'REQUEST_ALREADY_OPEN' }
  if (eff === 'settled') return { ok: false, error: '退款已确认收讫,握手已完成', error_code: 'ALREADY_SETTLED' }
  if (eff === 'escalated') return { ok: false, error: '本单已升级举证仲裁,等待裁决', error_code: 'ALREADY_ESCALATED' }
  const n = (db.prepare('SELECT COUNT(*) AS n FROM direct_fault_refund_requests WHERE order_id = ?').get(args.orderId) as { n: number }).n
  if (n >= 3) return { ok: false, error: '本订单退款握手请求次数已达上限(3),可升级举证仲裁', error_code: 'REQUEST_CAP_REACHED' }
  const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 200) : null
  db.prepare(`INSERT INTO direct_fault_refund_requests (id, order_id, buyer_id, seller_id, reason, respond_deadline)
              VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
    .run(args.requestId, args.orderId, order.buyer_id, order.seller_id, reason, `+${respondDays(db)} days`)
  return { ok: true, request: latestRequest(db, args.orderId), status: 'requested' }
}

/** ② a. 卖家拒绝(主张已退款/不认可)→ 买家可升级举证。 */
export function declineFaultRefund(db: Database.Database, args: { orderId: string; sellerId: string }): FaultRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.seller_id !== args.sellerId) return { ok: false, error: '只有订单卖家可拒绝', error_code: 'NOT_ORDER_SELLER' }
  const r = db.prepare(`UPDATE direct_fault_refund_requests SET status = 'declined', seller_responded_at = datetime('now'), updated_at = datetime('now')
                        WHERE order_id = ? AND status = 'requested'`).run(args.orderId)
  if (r.changes !== 1) return { ok: false, error: '没有待响应的退款握手请求', error_code: 'NO_OPEN_REQUEST' }
  return { ok: true, status: 'declined' }
}

/** ② b. 卖家声明已场外退款(可附退款参考)。此后买家 confirm 或(未收到)升级举证,不可 withdraw。 */
export function markFaultRefunded(db: Database.Database, args: { orderId: string; sellerId: string; refundReference?: string | null }): FaultRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.seller_id !== args.sellerId) return { ok: false, error: '只有订单卖家可声明退款', error_code: 'NOT_ORDER_SELLER' }
  const ref = typeof args.refundReference === 'string' ? args.refundReference.trim().slice(0, 200) : null
  const r = db.prepare(`UPDATE direct_fault_refund_requests SET status = 'refund_marked', refund_reference = ?, seller_responded_at = datetime('now'), updated_at = datetime('now')
                        WHERE order_id = ? AND status = 'requested'`).run(ref, args.orderId)
  if (r.changes !== 1) return { ok: false, error: '没有待响应的退款握手请求', error_code: 'NO_OPEN_REQUEST' }
  return { ok: true, status: 'refund_marked' }
}

/** 买家撤回 —— 仅限卖家尚未响应(requested)。 */
export function withdrawFaultRefund(db: Database.Database, args: { orderId: string; buyerId: string }): FaultRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可撤回', error_code: 'NOT_ORDER_BUYER' }
  const r = db.prepare(`UPDATE direct_fault_refund_requests SET status = 'withdrawn', updated_at = datetime('now')
                        WHERE order_id = ? AND status = 'requested'`).run(args.orderId)
  if (r.changes !== 1) return { ok: false, error: '没有可撤回的请求(卖家已声明退款后不可撤回,请确认或升级举证)', error_code: 'NO_OPEN_REQUEST' }
  return { ok: true, status: 'withdrawn' }
}

/** ③ 买家确认已收到场外退款 → settled(纯记录:零资金、零订单转移、零库存)。 */
export function confirmFaultRefundReceived(db: Database.Database, args: { orderId: string; buyerId: string }): FaultRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可确认收到退款', error_code: 'NOT_ORDER_BUYER' }
  // 请求行 CAS:仅 refund_marked → settled(卖家未声明退款前买家不可单方确认)
  const cas = db.prepare(`UPDATE direct_fault_refund_requests SET status = 'settled', settled_at = datetime('now'), updated_at = datetime('now')
                          WHERE order_id = ? AND status = 'refund_marked'`).run(args.orderId)
  if (cas.changes !== 1) return { ok: false, error: '卖家尚未声明退款,不可确认', error_code: 'REFUND_NOT_MARKED' }
  return { ok: true, status: 'settled' }
}

/**
 * 举证升级:卖家 decline / 超时未响应(expired) / 声明退款但买家未收到(refund_marked)→
 * 建 dispute_type='fault_refund_claim' 争议(initiator=买家,defendant=卖家;信誉裁决,不动订单)。
 * 幂等:每单至多一条(存在性检查 + 部分唯一索引双保险)。
 */
export function escalateFaultRefund(
  db: Database.Database,
  args: { orderId: string; buyerId: string; notes: string; disputeId: string },
): FaultRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可升级举证', error_code: 'NOT_ORDER_BUYER' }
  const el = faultRefundEligible(db, order)
  if (!el.eligible) return { ok: false, error: '本订单不适用退款申索', error_code: el.reason || 'NOT_ELIGIBLE' }
  const notes = String(args.notes || '').trim()
  if (notes.length < 10) return { ok: false, error: '请说明情况(≥10 字):付款方式/时间/金额,以及卖家未退款的经过', error_code: 'NOTES_TOO_SHORT' }
  // 已有申索先查(escalated 后请求行状态已变,先给最准确的错误)
  const existing = db.prepare("SELECT id FROM disputes WHERE order_id = ? AND dispute_type = 'fault_refund_claim'").get(args.orderId) as { id: string } | undefined
  if (existing) return { ok: false, error: '本单已有退款申索争议', error_code: 'CLAIM_ALREADY_EXISTS', dispute_id: existing.id }
  const last = latestRequest(db, args.orderId)
  const eff = last ? effectiveStatus(db, last) : null
  if (!eff || !['declined', 'expired', 'refund_marked'].includes(eff)) {
    return { ok: false, error: '升级前提:先发起握手,且卖家已拒绝/超时未响应/声明退款但你未收到', error_code: 'ESCALATE_NOT_AVAILABLE' }
  }
  const now = Date.now()
  const respondDeadline = new Date(now + 48 * 3600_000).toISOString()
  const arbitrateDeadline = new Date(now + 120 * 3600_000).toISOString()
  const reason = `直付判责关单退款申索(fault_refund_claim):买家主张卖家违约关单后未场外退款。买家陈述:${notes.slice(0, 500)}`
  try {
    db.prepare(`INSERT INTO disputes (id, order_id, initiator_id, defendant_id, reason, status, dispute_type,
                 defendant_evidence_ids, respond_deadline, arbitrate_deadline, assigned_arbitrators)
                VALUES (?, ?, ?, ?, ?, 'open', 'fault_refund_claim', '[]', ?, ?, '[]')`)
      .run(args.disputeId, args.orderId, order.buyer_id, order.seller_id, reason, respondDeadline, arbitrateDeadline)
  } catch {
    const race = db.prepare("SELECT id FROM disputes WHERE order_id = ? AND dispute_type = 'fault_refund_claim'").get(args.orderId) as { id: string } | undefined
    if (race) return { ok: false, error: '本单已有退款申索争议', error_code: 'CLAIM_ALREADY_EXISTS', dispute_id: race.id }
    return { ok: false, error: '建立申索失败', error_code: 'CLAIM_CREATE_FAILED' }
  }
  db.prepare(`UPDATE direct_fault_refund_requests SET status = 'escalated', escalated_dispute_id = ?, updated_at = datetime('now')
              WHERE id = ?`).run(args.disputeId, String(last!.id))
  return { ok: true, status: 'escalated', dispute_id: args.disputeId }
}

/** 状态读取(party-gated):非当事方一律 NOT_A_PARTY,不泄露存在性。 */
export function getFaultRefundState(db: Database.Database, orderId: string, viewerId: string): FaultRefundResult & {
  eligible?: boolean
  can_request?: boolean; can_respond?: boolean; can_confirm?: boolean; can_withdraw?: boolean; can_escalate?: boolean
  claim?: Record<string, unknown> | null
} {
  const order = loadOrder(db, orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  const isBuyer = order.buyer_id === viewerId; const isSeller = order.seller_id === viewerId
  if (!isBuyer && !isSeller) return { ok: false, error: '仅订单当事方可查看', error_code: 'NOT_A_PARTY' }
  const el = faultRefundEligible(db, order)
  const last = latestRequest(db, orderId)
  const eff = last ? effectiveStatus(db, last) : null
  const open = eff === 'requested' || eff === 'refund_marked'
  const claim = db.prepare("SELECT id, status, ruling_type, resolved_at FROM disputes WHERE order_id = ? AND dispute_type = 'fault_refund_claim'").get(orderId) as Record<string, unknown> | undefined
  const capped = ((db.prepare('SELECT COUNT(*) AS n FROM direct_fault_refund_requests WHERE order_id = ?').get(orderId) as { n: number }).n) >= 3
  return {
    ok: true,
    eligible: el.eligible,
    request: last ? { ...last, status: eff } : undefined,
    claim: claim ?? null,
    can_request: isBuyer && el.eligible && !open && eff !== 'settled' && eff !== 'escalated' && !claim && !capped,
    can_respond: isSeller && eff === 'requested',
    can_confirm: isBuyer && eff === 'refund_marked',
    can_withdraw: isBuyer && eff === 'requested',
    can_escalate: isBuyer && el.eligible && !claim && !!eff && ['declined', 'expired', 'refund_marked'].includes(eff),
  }
}
