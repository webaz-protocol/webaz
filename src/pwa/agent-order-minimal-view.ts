/**
 * RFC-021 §6a — 最小化订单读投影(seller_orders_read_minimal)。
 *
 * ALLOWLIST 投影:输出对象由【字面六键】构造,绝不 spread order 行。因此 PII(shipping_address / notes /
 * gift_recipient_name / gift_recipient_phone / recipient_code / 买家名)在【任何输入行下】都不可能出现在输出 ——
 * 这是 I6 的最强保证(不靠 denylist 剥离,靠 allowlist 构造)。调用方另只 SELECT 非 PII 列,PII 连取都不取。
 *
 * next_actor / deadline 复用既有状态机计算(与人类订单视图同源,不 drift):
 *   next_actor = CURRENT_RESPONSIBLE[status](self-fulfill 用 CURRENT_RESPONSIBLE_SELF_FULFILL)
 *   deadline   = getActiveDeadline(order).deadline
 * PR1 不含任何执行/写入;地址揭示(D1 address_reveal_policy)在 PR2 接入,PR1 恒不含地址。
 */
import type Database from 'better-sqlite3'
import { getActiveDeadline } from '../layer0-foundation/L0-2-state-machine/engine.js'
import { CURRENT_RESPONSIBLE, CURRENT_RESPONSIBLE_SELF_FULFILL } from '../layer0-foundation/L0-2-state-machine/transitions.js'

export interface MinimalSellerOrderView {
  order_id: string
  status: string
  next_actor: string | null   // 当前责任方(currentResponsible)
  deadline: string | null     // 当前活跃截止(getActiveDeadline().deadline)
  amount: number | null       // total_amount
  item_ref: string | null     // product_id
}

/** 调用方须只 SELECT 非 PII 列:id, status, total_amount, product_id, logistics_id, 及各 *_deadline 列。 */
export function minimalSellerOrderView(order: Record<string, unknown>, db?: Database.Database): MinimalSellerOrderView {
  const status = String(order.status ?? '')
  const isSelfFulfill = !order.logistics_id
  const table = (isSelfFulfill ? CURRENT_RESPONSIBLE_SELF_FULFILL : CURRENT_RESPONSIBLE) as Record<string, string>
  let deadline: string | null = null
  try { deadline = getActiveDeadline(order as never, db)?.deadline ?? null } catch { deadline = null }
  return {
    order_id: String(order.id ?? ''),
    status,
    next_actor: table[status] ?? null,
    deadline,
    amount: order.total_amount == null ? null : Number(order.total_amount),
    item_ref: order.product_id == null ? null : String(order.product_id),
  }
}

/** 最小化读只取这些【非 PII】列(供路由 SELECT + 测试断言 SELECT 不含 PII)。 */
export const MINIMAL_ORDER_COLUMNS = [
  'id', 'status', 'total_amount', 'product_id', 'logistics_id',
  'pending_accept_deadline', 'pay_deadline', 'accept_deadline', 'ship_deadline',
  'pickup_deadline', 'delivery_deadline', 'confirm_deadline',
] as const
