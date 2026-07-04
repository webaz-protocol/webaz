/**
 * Direct Pay (Rail 1) 取消库存回补 —— 唯一入口 + 硬边界(2026-07-04 用户领域裁定 + 电商实操情形矩阵)。
 *
 * ══ 电商库存回补情形矩阵(哪些能自动回补,哪些绝不能)══
 *
 * 【A. 自动回补 ✅ —— 货从未出库,库存只是被订单占用】
 *  A1 付款窗口内取消/未付款过期(direct_pay_window / direct_expired_unconfirmed):从未拣货。
 *  A2 货款协商取消(payment_query 各关单路径):恒 pre-ship,货未动。
 *  A3 取消退款握手(accepted,已付未发,#223):卖家同意退款关单,货未出库。
 *  → 本函数放行的 PRE_SHIP_RESTOCK_STATUSES 白名单即 A 类。幂等由调用方 transition CAS 保证
 *    (状态转移只成功一次 → 回补只执行一次,绝不双倍回补)。回补不改商品状态:已下架/软删商品
 *    回补后仍下架(不会因取消而意外重新上架)。
 *
 * 【B. 绝不自动回补 ❌ —— 货已出库,实物状态不可控,直接回补=超卖】
 *  B1 已发货后取消/退货(shipped 及之后):必须走仓库【退货验收上架】(签收→质检→定级:
 *     可再售上架 / 折损降级(二手/翻新渠道) / 报废),验收通过才人工/ERP 回补。
 *  B2 拦截件(发货后立即取消 → 物流半途召回):货没到买家手,但包装/品相未验,同走验收。
 *  B3 拒收件(买家拒签退回):同 B1,且高破损率,必须验收。
 *  B4 争议来源取消(disputed → cancelled,如 mutual-cancel):争议可能发生在发货后任何阶段,
 *     无法区分货物位置 → 一律不自动回补(货在途/在买家手,回补即超卖)。
 *  → 本函数对 B 类来源【拒绝回补】(no-op + 返回 false);调用方不得绕过本函数直接 UPDATE stock。
 *
 * 【C. 策略化(依赖卖家库存模式)—— 纯设计记录:卖家接入 ERP 之前,本模块【零 ERP 运行时逻辑】,
 *     不设 flag/不加分支/不构成任何阻断;native 流程(A 放行/B 拒绝)就是全部行为。届时再改。】
 *  C1 ERP/WMS 接入后:pre-ship ≠ 未拣配 —— 出库流程(占用→拣货→打包)可能已启动,协议侧自动回补
 *     =幻影库存=超卖。届时回补必须 per-seller 策略化:native(现状,协议计数器)=自动回补;
 *     erp_synced=不自动回补,生成【待对账回补事件】由卖家 ERP 确认上架后手动/接口回补。
 *  C2 预售/定制(made-to-order):无现货库存概念,回补无意义(v1 不涉及)。
 *  C3 活动库存(秒杀/团购单独池):回补要回到活动池而非基础池,池已关闭则进基础池需人工决策
 *     (direct_p2p v1 已排除 flash/coupon,escrow 侧处理时须注意)。
 *
 * 【D. 范围边界(v1 现实)】
 *  D1 direct_p2p v1 仅简单商品(无 variant/二手/批次/效期/多仓,见 direct-pay-create.ts);
 *     escrow 侧同类取消泄漏修复(follow-up)须额外处理 product_variants(镜像 returns.ts)与二手终态。
 *  D2 部分取消/换货不存在:v1 整单取消,按 order.quantity 全量回补。
 *  D3 临期/批次:返仓货可能临期,批次库存 v1 未建模 —— 属 B 类验收环节的人工判断。
 *
 * 调用方须在【同一 db.transaction】内先完成状态转移(CAS)再调本函数。
 */
import type Database from 'better-sqlite3'

/** 允许自动回补的取消来源状态(= A 类:货从未出库)。pending_accept=手动接单待确认(v16),付款前必然未出库。 */
export const PRE_SHIP_RESTOCK_STATUSES = new Set(['pending_accept', 'direct_pay_window', 'direct_expired_unconfirmed', 'payment_query', 'accepted'])

/** 回补库存(仅 A 类 pre-ship 来源;B 类已出库来源拒绝 —— 走退货验收上架)。返回是否真的回补了。 */
export function restorePreShipDirectPayStock(db: Database.Database, args: { fromStatus: string; productId: string; quantity: number }): boolean {
  if (!PRE_SHIP_RESTOCK_STATUSES.has(args.fromStatus)) return false   // 已出库/争议来源:绝不直接回补
  db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(args.quantity, args.productId)
  return true
}
