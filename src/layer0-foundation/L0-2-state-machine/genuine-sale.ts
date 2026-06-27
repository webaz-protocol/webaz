/**
 * 「真实成交」判据 — 单一真相源。
 *
 * 背景:`orders.status='completed'` 是结算状态机的**通用终态**,不只 happy path(`confirmed→completed`),
 * 还包括 `fault_seller` / `fault_logistics` / `fault_buyer` / `declined_nofault` / `disputed → completed`
 * 这些**退款 / 违约 / 争议**处置终态。所以裸 `status='completed'` ≠ 有效成交 —— 被退款的失败交易也是
 * completed。任何「有效成交」语义的资格门 / 信任信号都不能裸用 status。
 *
 * 真实成交 = 该订单曾进入过 `confirmed`(买家确认收货,或送达 72h 自动确认)**且未被全额退货**。仅 happy path
 * 经过 confirmed;所有 fault/退款/争议终态都不经过。据 `order_state_history`(transition() 每次状态变更写入)判定。
 *
 * RFC-018 PR4:退货发生在 `confirmed→completed` **之后**(returns 只作用于 completed 单),所以仅靠 confirmed
 * 判据会把【已全额退货】的单仍算成真实成交 —— 退货虚增资格门 / completion_count / sales_count。故再排除
 * 【累计退款达到订单总额】的单:`SUM(return_requests.refund_amount WHERE status='refunded') >= 订单总额`。
 * 用累计 SUM 而非单行 `refund_amount >= total` —— 同一单可先后多次退货(已退款的旧 return 不挡新 return),
 * 多次部分退款累计到全额也应排除。累计 < total 仍算真实成交(确曾成交,只是部分退款)。
 *
 * 用法:把查询里的 `status='completed'` 条件替换为本谓词。
 *   单表:`... WHERE buyer_id = ? AND ${genuineSalePredicate()}`           // 默认别名 orders
 *   相关子查询:`... FROM orders o WHERE ... AND ${genuineSalePredicate('o')}`
 *
 * Direct Pay (Rail 1) 排除:`payment_rail='direct_p2p'` 是场外直付,付款不可观测、本档无资金保障,
 * 不计真实成交/佣金/PV(设计稿 §3「Commission/PV/genuine-sale on Rail 1」)。escrow 及将来可观测的
 * Rail 2(链上全额质押)仍计入。NULL → 视为 escrow(老行)。
 *
 * 注:这是纯 SQL 片段(无 DB 依赖),保证所有消费方用同一定义。整体加括号防 OR 上下文优先级。
 * 若将来规模下相关子查询成性能瓶颈,再升级为 settleOrder 写入的 `orders.settled_ok_at` 列(届时只改本文件)。
 */
export function genuineSalePredicate(ordersAlias = 'orders'): string {
  return `(EXISTS (SELECT 1 FROM order_state_history osh WHERE osh.order_id = ${ordersAlias}.id AND osh.to_status = 'confirmed') AND (SELECT COALESCE(SUM(rr.refund_amount), 0) FROM return_requests rr WHERE rr.order_id = ${ordersAlias}.id AND rr.status = 'refunded') < ${ordersAlias}.total_amount AND COALESCE(${ordersAlias}.payment_rail, 'escrow') != 'direct_p2p')`
}
