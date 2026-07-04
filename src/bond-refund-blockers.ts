/**
 * 商家保证金退还 —— §5 unlock blockers 枚举(B2)。
 *
 * 原则(设计稿 §5 + 公平三原则):卖家有【任一未了结直付责任】即不得退还保证金 —— 保证金是履约担保物,
 *   责任未清就退等于让无责方(买家/平台)暴露在零担保风险里。**fail-closed**:任何一项查不了(表缺失/
 *   查询异常)按"有阻碍"处理,绝不因读失败放行。
 *
 * v1 枚举项:
 *   OPEN_DIRECT_PAY_ORDERS      在途直付单(含待接单/付款窗/协商/履约中/争议)
 *   OPEN_CANCEL_REFUND_HANDSHAKE 取消退款握手进行中(防御性:此时订单必在 accepted,通常已被上一项覆盖)
 *   OPEN_RETURN_FLOW            退货流进行中(含送达后场外退款握手 —— completed 单也可能有,上一项覆盖不了)
 *   UNPAID_PLATFORM_FEES        平台服务费欠费(已计提 > 预充值;退出须先结清)
 *   PENDING_SLASH_REVIEW        待复核罚没提案(B3 建表后接入;当前表不存在=无此项,非 fail-open —— 提案
 *                               只会由 B3 的仲裁接线产生,B3 前不存在"待复核罚没"这个事实)
 *   UNVERIFIABLE_*              对应项查询异常(fail-closed)
 *
 * 纯读;调用方在【申请时】与【执行时】各查一次(冷静期内可能新增退货等责任)。
 */
import type Database from 'better-sqlite3'
import { OPEN_FEE_ACCRUING_STATUSES, readAvailableFeePrepayUnits } from './direct-pay-fee-ar.js'
import { sellerHasPendingSlash } from './bond-slash.js'   // B3:待复核罚没提案挡退出

export interface BondRefundBlocker { code: string; count?: number }

export function enumerateBondRefundBlockers(db: Database.Database, sellerId: string): BondRefundBlocker[] {
  const out: BondRefundBlocker[] = []

  // ① 在途直付单(OPEN_FEE_ACCRUING_STATUSES 已含 pending_accept..disputed 全部非终态)
  try {
    const ph = OPEN_FEE_ACCRUING_STATUSES.map(() => '?').join(',')
    const n = (db.prepare(`SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND status IN (${ph})`)
      .get(sellerId, ...OPEN_FEE_ACCRUING_STATUSES) as { n: number }).n
    if (n > 0) out.push({ code: 'OPEN_DIRECT_PAY_ORDERS', count: n })
  } catch { out.push({ code: 'UNVERIFIABLE_OPEN_ORDERS' }) }

  // ② 取消退款握手进行中(防御性)
  try {
    const n = (db.prepare(`SELECT COUNT(*) n FROM direct_pay_cancel_requests WHERE seller_id = ? AND status IN ('requested','refund_marked')`)
      .get(sellerId) as { n: number }).n
    if (n > 0) out.push({ code: 'OPEN_CANCEL_REFUND_HANDSHAKE', count: n })
  } catch { out.push({ code: 'UNVERIFIABLE_CANCEL_REFUND' }) }

  // ③ 退货流进行中(completed 直付单的退货/场外退款握手 —— ① 覆盖不到)
  try {
    const n = (db.prepare(`SELECT COUNT(*) n FROM return_requests r JOIN orders o ON o.id = r.order_id
      WHERE o.seller_id = ? AND o.payment_rail = 'direct_p2p'
        AND r.status IN ('pending','accepted_pickup_pending','picked_up','await_refund','refund_marked')`)
      .get(sellerId) as { n: number }).n
    if (n > 0) out.push({ code: 'OPEN_RETURN_FLOW', count: n })
  } catch { out.push({ code: 'UNVERIFIABLE_RETURNS' }) }

  // ⑤ 待复核罚没提案(B3;sellerHasPendingSlash 内部 fail-closed)
  if (sellerHasPendingSlash(db, sellerId)) out.push({ code: 'PENDING_SLASH_REVIEW' })

  // ④ 平台服务费欠费(available = Σ预充值 + Σ调整 − Σ已计提;负 = 欠)
  try {
    if (readAvailableFeePrepayUnits(db, sellerId) < 0) out.push({ code: 'UNPAID_PLATFORM_FEES' })
  } catch { out.push({ code: 'UNVERIFIABLE_FEES' }) }

  return out
}
