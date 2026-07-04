/**
 * Direct Pay (Rail 1) — 送达后【退货 + 场外退款握手】域模块。
 *
 * 背景:direct_p2p 原先整个退货流程被 DIRECT_PAY_NO_REFUND 禁掉(理由:escrow 钱包退款路径会错误移动
 *   无关 WAZ),买家送达后只剩争议一条路 —— 不合理。正确做法是保留退货物流/协商骨架(return_requests
 *   生命周期),只把【退款执行环节】换成场外握手(镜像 direct-pay-cancel-refund 取消退款三步握手):
 *     卖家同意退货 →(货物寄回,可走现有上门取件/picked_up 流)→ await_refund(待卖家场外退款)
 *     → 卖家 mark_refunded(声明已场外退款,可附退款参考)→ 买家 confirm(Passkey RISK)→ refunded。
 *
 * 【关键不变量 / 安全边界】
 *  1. 零资金:不碰 wallet/escrow/settlement/clearing —— 非托管,协议不持买家货款,退款动作发生在场外,
 *     协议只记录/编排/收口。平台费应收(fee AR)也不在此冲销(admin correction 现有路径,治理决策)。
 *  2. 零库存回补:送达后的退货 = 货物已出库(B 类,见 direct-pay-stock.ts 情形矩阵)—— 绝不自动回补,
 *     须走线下退货验收后由卖家手动上架,否则超卖。此处【刻意没有任何 stock 写】。
 *  3. 订单状态不变:退货是订单完成后的侧流(escrow 退货同样不改 order.status),不进状态机。
 *  4. 权限:只有 seller 可 mark_refunded,只有 buyer 可 confirm;所有状态翻转 CAS(防并发双结算)。
 *  5. confirm 是终局(refunded)→ 现场真人 Passkey(RISK 铁律,路由层门);全额退款时 completion_count -1
 *     (best-effort 社交计数,与 escrow executeReturnRefund 同口径;genuineSalePredicate 本就整体排除
 *     direct_p2p,权威口径不受影响)。
 *  6. 卖家同意后不退款:await_refund 超 respond 窗(param direct_pay.return_refund_respond_days,默认 5 天,
 *     锚点 await_refund_since)买家可升级争议;refund_marked 后买家若未真的收到退款,可随时升级争议
 *     (声明≠证据,收口权在买家)。
 */
import type Database from 'better-sqlite3'

export interface DirectPayReturnResult {
  ok: boolean
  error?: string
  error_code?: string
  status?: string
  return_request?: Record<string, unknown>
}

type ReturnRow = {
  id: string; order_id: string; buyer_id: string; seller_id: string; product_id: string
  status: string; reason: string; refund_amount: number; await_refund_since: string | null
  payment_rail: string | null; order_total: number
}

function loadReturn(db: Database.Database, returnId: string): ReturnRow | undefined {
  return db.prepare(`SELECT r.id, r.order_id, r.buyer_id, r.seller_id, r.product_id, r.status, r.reason,
                            r.refund_amount, r.await_refund_since, o.payment_rail, o.total_amount AS order_total
                     FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = ?`).get(returnId) as ReturnRow | undefined
}

export function returnRefundRespondDays(db: Database.Database): number {
  try {
    const p = db.prepare("SELECT value FROM protocol_params WHERE key = 'direct_pay.return_refund_respond_days'").get() as { value: string } | undefined
    if (p) return Math.max(1, Number(p.value) || 5)
  } catch { /* 表缺失 → 默认 */ }
  return 5
}

/**
 * 卖家同意退货后进入 await_refund(替代 escrow 的 executeReturnRefund)。
 * fromStatus = 'pending'(同意·无取件)| 'picked_up'(取件流·确认收到退货)。CAS 防并发。
 * 同 tx 内写协商时间线消息(与 escrow accept 同模式)。调用方负责通知。
 */
export function enterAwaitRefund(
  db: Database.Database,
  args: { returnId: string; fromStatus: 'pending' | 'picked_up'; sellerResponse?: string | null; messageId: string },
): DirectPayReturnResult {
  const rr = loadReturn(db, args.returnId)
  if (!rr) return { ok: false, error: '退货请求不存在', error_code: 'RETURN_NOT_FOUND' }
  if (rr.payment_rail !== 'direct_p2p') return { ok: false, error: '仅直付订单走场外退款握手', error_code: 'NOT_DIRECT_PAY' }
  const resp = typeof args.sellerResponse === 'string' ? args.sellerResponse.slice(0, 500) : null
  const r = db.prepare(`UPDATE return_requests SET status = 'await_refund', await_refund_since = datetime('now'),
                        seller_response = COALESCE(?, seller_response) WHERE id = ? AND status = ?`)
    .run(resp, args.returnId, args.fromStatus)
  if (r.changes !== 1) return { ok: false, error: '退货请求已被处理(请刷新后查看)', error_code: 'RETURN_ALREADY_SETTLED' }
  try {
    db.prepare(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`)
      .run(args.messageId, rr.id, rr.seller_id, 'seller', `[✓ 同意退货 · 待场外退款] ${resp || ''}`)
  } catch { /* 时间线消息 best-effort */ }
  return { ok: true, status: 'await_refund' }
}

/** 卖家声明已场外退款(await_refund → refund_marked,可附退款参考)。此后买家 confirm 或走争议。 */
export function markReturnRefunded(
  db: Database.Database,
  args: { returnId: string; sellerId: string; refundReference?: string | null; messageId: string },
): DirectPayReturnResult {
  const rr = loadReturn(db, args.returnId)
  if (!rr) return { ok: false, error: '退货请求不存在', error_code: 'RETURN_NOT_FOUND' }
  if (rr.seller_id !== args.sellerId) return { ok: false, error: '只有订单卖家可声明退款', error_code: 'NOT_ORDER_SELLER' }
  if (rr.payment_rail !== 'direct_p2p') return { ok: false, error: '仅直付订单走场外退款握手', error_code: 'NOT_DIRECT_PAY' }
  const ref = typeof args.refundReference === 'string' ? args.refundReference.trim().slice(0, 200) : null
  const r = db.prepare(`UPDATE return_requests SET status = 'refund_marked', refund_reference = ? WHERE id = ? AND status = 'await_refund'`)
    .run(ref, args.returnId)
  if (r.changes !== 1) return { ok: false, error: '当前状态不可声明退款(须先同意退货,或已被处理)', error_code: 'NOT_AWAIT_REFUND' }
  try {
    db.prepare(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`)
      .run(args.messageId, rr.id, rr.seller_id, 'seller', `[💸 已声明场外退款] ${ref ? `退款参考:${ref}` : ''}`)
  } catch { /* best-effort */ }
  return { ok: true, status: 'refund_marked' }
}

/**
 * 买家确认已收到场外退款(refund_marked → refunded,终态)。【必须由路由 db.transaction 包裹 + Passkey 门】。
 * 全额退款 → completion_count -1(与 escrow 同口径的 best-effort 社交计数;无钱、无库存、无 clearing)。
 */
export function confirmReturnRefundReceived(
  db: Database.Database,
  args: { returnId: string; buyerId: string; messageId: string },
): DirectPayReturnResult & { seller_fault_reason?: string | null; order_id?: string; seller_id?: string } {
  const rr = loadReturn(db, args.returnId)
  if (!rr) return { ok: false, error: '退货请求不存在', error_code: 'RETURN_NOT_FOUND' }
  if (rr.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可确认收到退款', error_code: 'NOT_ORDER_BUYER' }
  if (rr.payment_rail !== 'direct_p2p') return { ok: false, error: '仅直付订单走场外退款握手', error_code: 'NOT_DIRECT_PAY' }
  const cas = db.prepare(`UPDATE return_requests SET status = 'refunded', resolved_at = datetime('now') WHERE id = ? AND status = 'refund_marked'`)
    .run(args.returnId)
  if (cas.changes !== 1) return { ok: false, error: '卖家尚未声明退款,不可确认', error_code: 'REFUND_NOT_MARKED' }
  if (Number(rr.refund_amount) >= Number(rr.order_total)) {
    db.prepare(`UPDATE products SET completion_count = MAX(0, COALESCE(completion_count,0) - 1) WHERE id = ?`).run(rr.product_id)
  }
  try {
    db.prepare(`INSERT INTO return_messages (id, return_id, sender_id, sender_role, body) VALUES (?,?,?,?,?)`)
      .run(args.messageId, rr.id, rr.buyer_id, 'buyer', '[✅ 已确认收到场外退款] 退货完成')
  } catch { /* best-effort */ }
  const SELLER_FAULT_REASONS = new Set(['quality', 'wrong_item', 'damaged'])
  return {
    ok: true, status: 'refunded', order_id: rr.order_id, seller_id: rr.seller_id,
    seller_fault_reason: SELLER_FAULT_REASONS.has(String(rr.reason)) ? String(rr.reason) : null,
  }
}

/**
 * 直付退货是否可升级争议(escalate 的 direct_p2p 分支;通用分支 rejected / pending≥7d 仍适用):
 *  - refund_marked:随时可(卖家声明≠买家收到,声明不实的收口权在买家)。
 *  - await_refund:超 respond 窗(默认 5 天)—— 卖家同意了却迟迟不退款。
 */
export function directPayReturnEscalatable(db: Database.Database, rr: { status?: unknown; await_refund_since?: unknown }): boolean {
  if (rr.status === 'refund_marked') return true
  if (rr.status === 'await_refund' && rr.await_refund_since) {
    const over = db.prepare(`SELECT datetime(?, '+' || ? || ' days') < datetime('now') AS o`)
      .get(String(rr.await_refund_since), returnRefundRespondDays(db)) as { o: number }
    return !!over.o
  }
  return false
}
