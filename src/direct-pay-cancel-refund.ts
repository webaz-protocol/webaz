/**
 * Direct Pay (Rail 1) — 付款后·发货前【取消退款握手】域模块(审计项 C)。
 *
 * 背景:mark_paid → accepted 后买家原本零取消路径(取消只在付款窗口=未付时)。非托管协议不持买家货款,
 *   协议【不能】替卖家退款 —— 取消必须是三步握手,退款动作发生在场外,协议只记录/编排/收口:
 *     ① 买家 request(说明理由)→ ② 卖家 mark_refunded(声明已场外退款,可附退款参考)→
 *     ③ 买家 confirm(确认已收到退款;RISK:现场真人 Passkey)→ 系统执行 accepted→cancelled + 恢复库存。
 *   卖家也可 decline(如已备货)→ 履约继续;买家可 withdraw(仅限卖家未 mark_refunded 前 —— 卖家已声明退款后
 *   撤回会造成"卖家退了钱订单却继续履约"的白嫖面,故禁止,买家只能 confirm 或走争议)。
 *
 * 【关键不变量 / 安全边界】
 *  1. 仅 direct_p2p 且 order.status==='accepted' 可发起;escrow 单一律拒(escrow 有自己的退款语义)。
 *  2. 只有订单 buyer 可 request/withdraw/confirm,只有 seller 可 decline/mark_refunded;状态读取 party-gated
 *     (非当事方 NOT_A_PARTY,不泄露存在性 —— 镜像 mutual-cancel P1 教训)。
 *  3. confirm 是状态手术:必须由【路由用 db.transaction 包裹】;内部重校验 order.status==='accepted'
 *     (防与 ship/争议竞态 —— 卖家已发货则握手失效,confirm 409)+ 请求行 CAS(refund_marked→settled)。
 *  4. 零资金:不碰 wallet/escrow/settlement 任何科目(非托管;fee AR 只在 completed 累计,取消无费可冲)。
 *     唯一库存写:settle 内恢复 products.stock += quantity(direct_p2p v1 仅简单商品,无 variant/二手)。
 *  5. 握手不阻塞履约:request pending 期间卖家仍可正常发货 —— 发货后握手 lazy 失效(getState 报 stale,
 *     confirm/mark_refunded 都会因 status!=='accepted' 被拒),不给买家用握手卡死卖家发货的杠杆。
 *  6. 卖家超时不响应(respond_deadline,默认 5 天,param direct_pay.cancel_refund_respond_days):lazy 过期
 *     (读时映射 expired,可重新 request 或走争议 accepted→disputed);无 cron,无自动关单 —— 自动关单
 *     等于"没证据就判卖家已退款",违反公平三原则。
 *  7. 防骚扰:每单累计最多 3 次 request(声明性动作,cap 防拿通知当骚扰杠杆)。
 */
import type Database from 'better-sqlite3'
import { restorePreShipDirectPayStock } from './direct-pay-stock.js'   // 库存回补唯一入口(pre-ship 放行;已出库拒绝,走退货验收)

export interface CancelRefundResult {
  ok: boolean
  error?: string
  error_code?: string
  request?: Record<string, unknown>
  status?: string
}

export function initDirectPayCancelRefundSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_pay_cancel_requests (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','refund_marked','settled','declined','withdrawn')),
      reason TEXT,
      refund_reference TEXT,
      respond_deadline TEXT NOT NULL,
      seller_responded_at TEXT,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dpcr_order ON direct_pay_cancel_requests(order_id);
  `)
}

type OrderRow = { id: string; buyer_id: string; seller_id: string; status: string; payment_rail: string; product_id: string; quantity: number }

function loadOrder(db: Database.Database, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT id, buyer_id, seller_id, status, payment_rail, product_id, quantity FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
}

/** 最新一条请求(任意状态)。 */
function latestRequest(db: Database.Database, orderId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM direct_pay_cancel_requests WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(orderId) as Record<string, unknown> | undefined
}

/** requested 且 respond_deadline 已过 → 视为 expired(lazy,不写库;可重新 request)。 */
function effectiveStatus(db: Database.Database, r: Record<string, unknown>): string {
  if (r.status === 'requested') {
    const over = db.prepare("SELECT datetime(?) < datetime('now') AS o").get(r.respond_deadline as string) as { o: number }
    if (over.o) return 'expired'
  }
  return r.status as string
}

function respondDays(db: Database.Database): number {
  try {
    const p = db.prepare("SELECT value FROM protocol_params WHERE key = 'direct_pay.cancel_refund_respond_days'").get() as { value: string } | undefined
    if (p) return Math.max(1, Number(p.value) || 5)
  } catch { /* 表缺失 → 默认 */ }
  return 5
}

/** ① 买家发起取消退款请求。 */
export function requestCancelRefund(db: Database.Database, args: { orderId: string; buyerId: string; reason?: string | null; requestId: string }): CancelRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可发起取消退款', error_code: 'NOT_ORDER_BUYER' }
  if (order.payment_rail !== 'direct_p2p') return { ok: false, error: '仅直付订单适用取消退款握手(托管单走托管退款)', error_code: 'NOT_DIRECT_PAY' }
  if (order.status !== 'accepted') return { ok: false, error: '仅付款后、发货前(accepted)可申请取消退款', error_code: 'ORDER_NOT_ACCEPTED' }
  const last = latestRequest(db, args.orderId)
  if (last && ['requested', 'refund_marked'].includes(effectiveStatus(db, last))) return { ok: false, error: '已有进行中的取消退款请求', error_code: 'REQUEST_ALREADY_OPEN' }
  const n = (db.prepare('SELECT COUNT(*) AS n FROM direct_pay_cancel_requests WHERE order_id = ?').get(args.orderId) as { n: number }).n
  if (n >= 3) return { ok: false, error: '本订单取消退款请求次数已达上限(3),请与卖家协商或发起争议', error_code: 'REQUEST_CAP_REACHED' }
  const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 200) : null
  db.prepare(`INSERT INTO direct_pay_cancel_requests (id, order_id, buyer_id, seller_id, reason, respond_deadline)
              VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
    .run(args.requestId, args.orderId, order.buyer_id, order.seller_id, reason, `+${respondDays(db)} days`)
  return { ok: true, request: latestRequest(db, args.orderId), status: 'requested' }
}

/** ② a. 卖家拒绝(如已备货)→ 履约继续。 */
export function declineCancelRefund(db: Database.Database, args: { orderId: string; sellerId: string }): CancelRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.seller_id !== args.sellerId) return { ok: false, error: '只有订单卖家可拒绝', error_code: 'NOT_ORDER_SELLER' }
  const r = db.prepare(`UPDATE direct_pay_cancel_requests SET status = 'declined', seller_responded_at = datetime('now'), updated_at = datetime('now')
                        WHERE order_id = ? AND status = 'requested'`).run(args.orderId)
  if (r.changes !== 1) return { ok: false, error: '没有待响应的取消退款请求', error_code: 'NO_OPEN_REQUEST' }
  return { ok: true, status: 'declined' }
}

/** ② b. 卖家声明已场外退款(可附退款参考)。此后买家只能 confirm 或走争议(不可 withdraw)。 */
export function markRefunded(db: Database.Database, args: { orderId: string; sellerId: string; refundReference?: string | null }): CancelRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.seller_id !== args.sellerId) return { ok: false, error: '只有订单卖家可声明退款', error_code: 'NOT_ORDER_SELLER' }
  if (order.status !== 'accepted') return { ok: false, error: '订单已不在待发货阶段,握手已失效', error_code: 'ORDER_NOT_ACCEPTED' }
  const ref = typeof args.refundReference === 'string' ? args.refundReference.trim().slice(0, 200) : null
  const r = db.prepare(`UPDATE direct_pay_cancel_requests SET status = 'refund_marked', refund_reference = ?, seller_responded_at = datetime('now'), updated_at = datetime('now')
                        WHERE order_id = ? AND status = 'requested'`).run(ref, args.orderId)
  if (r.changes !== 1) return { ok: false, error: '没有待响应的取消退款请求', error_code: 'NO_OPEN_REQUEST' }
  return { ok: true, status: 'refund_marked' }
}

/** 买家撤回 —— 仅限卖家尚未响应(requested)。卖家已 mark_refunded 后禁撤(防"收了退款还让订单继续履约")。 */
export function withdrawCancelRefund(db: Database.Database, args: { orderId: string; buyerId: string }): CancelRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可撤回', error_code: 'NOT_ORDER_BUYER' }
  const r = db.prepare(`UPDATE direct_pay_cancel_requests SET status = 'withdrawn', updated_at = datetime('now')
                        WHERE order_id = ? AND status = 'requested'`).run(args.orderId)
  if (r.changes !== 1) return { ok: false, error: '没有可撤回的请求(卖家已声明退款后不可撤回,请确认收款或发起争议)', error_code: 'NO_OPEN_REQUEST' }
  return { ok: true, status: 'withdrawn' }
}

/**
 * ③ 买家确认已收到场外退款 → settled + accepted→cancelled(system)+ 恢复库存。
 * 【必须由路由 db.transaction 包裹】;transition 依赖注入(状态机 adapter,便于单测与防循环依赖)。
 */
export function confirmRefundReceived(
  db: Database.Database,
  args: { orderId: string; buyerId: string },
  transition: (db: Database.Database, orderId: string, to: 'cancelled', actorId: string, evidence: string[], notes: string) => { success: boolean; error?: string },
): CancelRefundResult {
  const order = loadOrder(db, args.orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  if (order.buyer_id !== args.buyerId) return { ok: false, error: '只有订单买家可确认收到退款', error_code: 'NOT_ORDER_BUYER' }
  // 竞态重校验:卖家已发货/已争议 → 握手失效,绝不在非 accepted 状态上关单
  if (order.status !== 'accepted') return { ok: false, error: '订单已不在待发货阶段(可能已发货/争议),握手已失效', error_code: 'ORDER_NOT_ACCEPTED' }
  const sys = db.prepare("SELECT id FROM users WHERE role = 'system' LIMIT 1").get() as { id: string } | undefined
  if (!sys) return { ok: false, error: '系统账号缺失', error_code: 'SYS_MISSING' }
  // 请求行 CAS:仅 refund_marked → settled(卖家未声明退款前买家不可单方确认关单)
  const cas = db.prepare(`UPDATE direct_pay_cancel_requests SET status = 'settled', settled_at = datetime('now'), updated_at = datetime('now')
                          WHERE order_id = ? AND status = 'refund_marked'`).run(args.orderId)
  if (cas.changes !== 1) return { ok: false, error: '卖家尚未声明退款,不可确认', error_code: 'REFUND_NOT_MARKED' }
  const t = transition(db, args.orderId, 'cancelled', sys.id, [], '直付取消退款握手:卖家已场外退款,买家确认收到 → 无责取消')
  if (!t.success) throw new Error(t.error || 'TRANSITION_FAILED')   // 抛错让路由 db.transaction 整体回滚(含上面 CAS)
  // 库存回补:经唯一守卫入口(accepted=已付未发,A 类放行;已出库来源在入口被拒 —— 见 direct-pay-stock.ts 情形矩阵)
  restorePreShipDirectPayStock(db, { fromStatus: 'accepted', productId: order.product_id, quantity: Number(order.quantity) || 1 })
  return { ok: true, status: 'cancelled' }
}

/** 状态读取(party-gated):非当事方一律 NOT_A_PARTY,不泄露请求存在性。 */
export function getCancelRefundState(db: Database.Database, orderId: string, viewerId: string): CancelRefundResult & { can_request?: boolean; can_respond?: boolean; can_confirm?: boolean; can_withdraw?: boolean } {
  const order = loadOrder(db, orderId)
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  const isBuyer = order.buyer_id === viewerId; const isSeller = order.seller_id === viewerId
  if (!isBuyer && !isSeller) return { ok: false, error: '仅订单当事方可查看', error_code: 'NOT_A_PARTY' }
  const last = latestRequest(db, orderId)
  const eff = last ? effectiveStatus(db, last) : null
  const open = eff === 'requested' || eff === 'refund_marked'
  const req = last ? { ...last, status: eff, stale: open && order.status !== 'accepted' } : null
  return {
    ok: true,
    request: req ?? undefined,
    can_request: isBuyer && order.payment_rail === 'direct_p2p' && order.status === 'accepted' && !open,
    can_respond: isSeller && eff === 'requested' && order.status === 'accepted',
    can_confirm: isBuyer && eff === 'refund_marked' && order.status === 'accepted',
    can_withdraw: isBuyer && eff === 'requested',
  }
}
