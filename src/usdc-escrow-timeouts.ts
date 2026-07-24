/**
 * USDC 合约担保 PR-B3(R2)— 付款窗到期清扫:'created' 超 pay_deadline 的 usdc_escrow 单
 * 取消 + 回补库存(#520 复审:通用 checkTimeouts 只做 transition 不回补,而本轨是第一个会
 * 滞留 'created' 的轨 —— 不清扫 = 永久库存泄漏 + 零成本占库 griefing)。
 *
 * 纪律:
 *   - 回补走唯一入口 restorePreShipDirectPayStock('created' 已入白名单:链上未存入=必然未出库);
 *   - 每单独立 sync 事务(transition + 回补原子;单单失败不阻断其它);
 *   - 只扫本轨:通用超时引擎对本轨 'created' 单不再是唯一收口(本清扫先行,cron 间隔更短)。
 */
import type Database from 'better-sqlite3'
import { restorePreShipDirectPayStock } from './direct-pay-stock.js'
import { voidUsdcEscrowIntentOnCancel } from './usdc-escrow-store.js'   // B6a:付款窗超时 → 作废未存入凭证

export interface UsdcEscrowSweepDeps {
  // 直接兼容 engine.transition 的真实签名(toStatus 为受限枚举;本清扫只用 'cancelled')
  transition: (db: Database.Database, orderId: string, to: 'cancelled', actorId: string, evidence: string[], note: string) => { success: boolean; error?: string }
}

/** 清扫到期未存入的 usdc_escrow 单。返回处理明细(测试/运维观测用)。 */
export function sweepExpiredUsdcEscrowOrders(db: Database.Database, deps: UsdcEscrowSweepDeps): Array<{ orderId: string; ok: boolean; error?: string }> {
  const out: Array<{ orderId: string; ok: boolean; error?: string }> = []
  let rows: Array<{ id: string; product_id: string; quantity: number }> = []
  try {
    rows = db.prepare(`SELECT id, product_id, quantity FROM orders
      WHERE payment_rail = 'usdc_escrow' AND status = 'created' AND datetime(pay_deadline) < datetime('now')   -- datetime() 归一化:create 写 ISO('T'),裸文本比较会失明到次日 UTC(B3 复审 Break-A)`).all() as typeof rows
  } catch { return out }
  for (const o of rows) {
    try {
      db.transaction(() => {
        const r = deps.transition(db, o.id, 'cancelled', 'sys_protocol', [], '链上存入窗口超时,订单自动取消(库存已回补)')
        if (!r.success) throw new Error(r.error || 'transition failed')
        if (!restorePreShipDirectPayStock(db, { fromStatus: 'created', productId: o.product_id, quantity: Number(o.quantity) || 1 })) {
          throw new Error('restock refused for created (must never happen — whitelist regression)')
        }
        voidUsdcEscrowIntentOnCancel(db, o.id)   // B6a:作废未存入(issued)凭证 —— 之后晚存入由 watcher void 分支拦截告警

      })()
      out.push({ orderId: o.id, ok: true })
    } catch (e) {
      out.push({ orderId: o.id, ok: false, error: (e as Error).message })
      console.error('[usdc-escrow sweep]', o.id, (e as Error).message)
    }
  }
  return out
}
