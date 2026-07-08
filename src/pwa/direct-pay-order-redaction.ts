/**
 * Direct Pay (Rail 1) 收款目标披露门 —— 共享投影器。
 *
 * 背景:披露门原本只以闭包形式活在 orders-read.ts 内,只有该文件的 list/detail 两个 handler 调用它。任何【另一个】
 *   对 orders 做 `SELECT *` / `SELECT o.*` 并回给响应的 reader 都会静默旁路这个门(审计发现 /api/me/export 与
 *   /api/logistics/orders 就是这样泄露了收款目标)。故把门提到共享模块,所有返回 orders 行的响应路径都必须过其一。
 *
 * 核心不变量:direct_p2p 收款目标 —— instruction 原文快照(direct_pay_instruction_snapshot)+ 收款码指针
 *   (direct_pay_account_snapshot.qr_ref)—— 只有【订单买家】在 D1/D2 both-acked 后可见。非敏感元数据
 *   (method/currency/label)可 pre-ack 展示(买家在 selectable-accounts 已见过、且是自己的选择)。
 *
 *   - redactUnackedDirectPayTarget(db,o,userId):买家自视角门(未 ack → 删 instruction + 剥 qr_ref;
 *     method/currency/label 保留;卖家看【自己的】单不删,因为 instruction 是他自填的)。
 *     用于 /api/orders 列表+详情、/api/me/export(自导出)。
 *   - stripDirectPayPaymentTarget(o):无条件删除 instruction 快照 + 整个账号快照。用于【非买家第三方】读
 *     (如物流:只需商品/状态/地址,绝不需要卖家收款目标)。
 *
 * 守卫:scripts/direct-pay-order-reader-guard.ts 会扫 route 层的 orders `SELECT *`/`o.*` reader,强制它们引用本模块。
 */
import type Database from 'better-sqlite3'
import { requireBothDisclosuresAcked } from '../direct-pay-disclosures.js'

/** 买家自视角:未 both-acked 的 direct_p2p 订单,删收款目标。就地改 o。
 *  手动接单(v16):pending_accept 阶段【状态门】无条件遮蔽 —— 卖家还没确认能发货,买家【不该拿到任何收款信息】,
 *  故整块 account_snapshot(连 method/currency/label 非敏感元数据)+ instruction 一并删除,响应零收款目标
 *  (时序门=非托管唯一付款风控,接单→direct_pay_window 才起付款窗;哪怕已 ack 披露也遮蔽)。
 *  已接单但未 both-acked:只删 instruction 原文 + 剥 qr_ref,保留买家结账时已选过的非敏感元数据。 */
export function redactUnackedDirectPayTarget(db: Database.Database, o: Record<string, unknown>, userId: string): void {
  if (o.payment_rail !== 'direct_p2p' || o.buyer_id !== userId) return
  const preAccept = o.status === 'pending_accept'
  if (!preAccept && requireBothDisclosuresAcked(db, o.id as string).ok) return
  delete o.direct_pay_instruction_snapshot
  if (preAccept) { delete o.direct_pay_account_snapshot; return }   // 接单前:零收款目标(元数据也删)
  if (o.direct_pay_account_snapshot != null) {
    try { const s = JSON.parse(o.direct_pay_account_snapshot as string); delete s.qr_ref; o.direct_pay_account_snapshot = JSON.stringify(s) }
    catch { delete o.direct_pay_account_snapshot }
  }
}

/** 无条件删除收款目标(instruction 快照 + 整个账号快照)。用于非买家第三方 reader,他们绝不该看到收款目标。就地改 o。 */
export function stripDirectPayPaymentTarget(o: Record<string, unknown>): void {
  delete o.direct_pay_instruction_snapshot
  delete o.direct_pay_account_snapshot
}

/**
 * 【唯一入口】按查看者投影收款目标(#218 审计发现 6):三类查看者一次分派,route 不再手工按序组合两个原语 ——
 * 曾经的组合错法每种都真实发生过:列表只调 redact(→ logistics 第三方拿到收款目标)、详情只调 redact(→ 仲裁员拿到)。
 *   - 卖家(o.seller_id===viewerId):收款方,instruction 是他自填的 → 不动。
 *   - 买家:ack 门(redactUnackedDirectPayTarget —— 未 both-acked 删 instruction+剥 qr_ref,留非敏感元数据)。
 *   - 其他一切查看者(logistics/仲裁员/admin/任何第三方):无条件剥离(stripDirectPayPaymentTarget)。
 * escrow 单不含收款目标语义,原语各自 no-op/删空,安全。所有返回 orders 整行的 reader 必须调本函数
 * (reader-guard 的 GATE 认的就是本函数名);两个原语仍导出,仅作本函数的构件,route 层不应直接使用。
 */
export function projectDirectPayTargetForViewer(db: Database.Database, o: Record<string, unknown>, viewerId: string): void {
  if (o.seller_id === viewerId) return
  if (o.buyer_id === viewerId) return redactUnackedDirectPayTarget(db, o, viewerId)
  stripDirectPayPaymentTarget(o)
}
