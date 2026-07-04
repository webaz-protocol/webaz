/**
 * Direct Pay (Rail 1) 超时专属 cron — 付款窗口超时 + paid-but-timeout 宽限关单。
 * 设计稿 docs/modules/DIRECT-PAYMENT-MODULE-DESIGN.INTERNAL.md §4/§5。
 *
 * 为何【不走】通用 engine.checkTimeouts:后者要求转移同时带 deadlineField + autoFaultState,
 *   且无"释放费用质押 / 设宽限期"的副作用钩子。本模块在一个事务内完成 transition + 副作用。
 *
 * 两段 sweep:
 *  A. direct_pay_window 过 direct_pay_window_deadline → direct_expired_unconfirmed
 *     + releaseFeeStake(费用质押退卖家,无完成不收费) + 设 direct_grace_deadline(= now + grace)。
 *     收款指令随状态离开 direct_pay_window 自然失效(路由仅在 direct_pay_window 展示收款方式)。
 *  B. direct_expired_unconfirmed 过 direct_grace_deadline → cancelled(system)。
 *     ★ 宽限硬门:WHERE 仅命中 now > direct_grace_deadline → 系统【绝不在宽限期内关单】;
 *       买家 →disputed 门在整个宽限期保持开启(那是 buyer 转移,本 sweep 不触碰)。
 */
import type Database from 'better-sqlite3'
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { releaseFeeStake } from '../../direct-pay-ledger.js'
import { restorePreShipDirectPayStock } from '../../direct-pay-stock.js'   // D3 库存回补唯一入口(pre-ship 放行;已出库拒绝)
import { notifyTransition, createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'

const SYS = 'sys_protocol'

export interface DirectPayTimeoutDeps { db: Database.Database }
export interface DirectPayTimeoutResult {
  windowExpired: string[]    // order ids: direct_pay_window → direct_expired_unconfirmed
  graceCancelled: string[]   // order ids: direct_expired_unconfirmed → cancelled (宽限期满)
  pqRecourseOpened: string[] // order ids: payment_query 买家静默 → 系统代发起取消,开买家申诉窗(不关单)
  pqCancelled: string[]      // order ids: payment_query → cancelled (申诉窗满)
}

/** 货款协商买家申诉窗(天),governance 可调,默认 7d。与 request_cancel 同源 param,保证手动/自动一致。 */
function recourseDays(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM protocol_params WHERE key = 'direct_pay.payment_query_recourse_days'").get() as { value: string } | undefined
    const n = Number(row?.value ?? 7)
    return Number.isFinite(n) && n > 0 ? Math.max(1, n) : 7
  } catch { return 7 }
}

/** 宽限期(小时),governance 可调,默认 48h(2d)。不硬编码。 */
function graceHours(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM protocol_params WHERE key = 'direct_pay.grace_hours'").get() as { value: string } | undefined
    const n = Number(row?.value ?? 48)
    return Number.isFinite(n) && n > 0 ? n : 48
  } catch { return 48 }  // param 表缺失/读失败 → 安全默认,cron 不崩
}

export function runDirectPayTimeoutSweep(deps: DirectPayTimeoutDeps): DirectPayTimeoutResult {
  const { db } = deps
  const gh = graceHours(db)
  const windowExpired: string[] = []
  const graceCancelled: string[] = []
  const pqRecourseOpened: string[] = []
  const pqCancelled: string[] = []

  // A. 付款窗口超时 → 可争议态(非静默关单)+ 退费用质押 + 设宽限期
  const windowRows = db.prepare(`
    SELECT id, buyer_id FROM orders
    WHERE status = 'direct_pay_window'
      AND payment_rail = 'direct_p2p'
      AND direct_pay_window_deadline IS NOT NULL
      AND datetime(direct_pay_window_deadline) < datetime('now')
    LIMIT 1000
  `).all() as Array<{ id: string; buyer_id: string }>
  for (const { id, buyer_id } of windowRows) {
    let done = false
    db.transaction(() => {
      const r = transition(db, id, 'direct_expired_unconfirmed', SYS, [], 'Rail1 直付:付款窗口超时未标记')
      if (!r.success) return
      releaseFeeStake(db, { orderId: id })   // 费用质押退卖家(无完成,不收费)
      db.prepare(`UPDATE orders SET direct_grace_deadline = datetime('now', ?) WHERE id = ?`).run(`+${gh} hours`, id)
      windowExpired.push(id); done = true
    })()
    // 审计项 B(N2):此前窗口静默过期,卡点付款的买家毫不知情直到 48h 后自动取消。tx 外 fail-soft。
    if (done) { try { createNotification(db, buyer_id, id, 'direct_pay_window_expired', '⏰ 直付付款窗口已过期', `若你已付款:请在 ${gh} 小时宽限期内到订单页提交付款凭证发起争议;未付款可直接关闭订单,否则宽限期满将自动取消。`, { templateKey: 'dp_window_expired', params: { graceHours: gh } }) } catch (e) { console.warn('[direct-pay-timeouts] notify window-expired:', (e as Error).message) } }
  }

  // B. 宽限期满 → 系统关单(★ WHERE 保证仅 now>grace 命中;宽限期内绝不关,买家 →disputed 全程可用)
  const graceRows = db.prepare(`
    SELECT id, product_id, quantity, buyer_id, seller_id FROM orders
    WHERE status = 'direct_expired_unconfirmed'
      AND payment_rail = 'direct_p2p'
      AND direct_grace_deadline IS NOT NULL
      AND datetime(direct_grace_deadline) < datetime('now')
    LIMIT 1000
  `).all() as Array<{ id: string; product_id: string; quantity: number; buyer_id: string; seller_id: string }>
  for (const { id, product_id, quantity, buyer_id, seller_id } of graceRows) {
    let done = false
    db.transaction(() => {
      const r = transition(db, id, 'cancelled', SYS, [], 'Rail1 直付:宽限期满,买家未付款/未升级争议,系统关单')
      if (!r.success) return
      restorePreShipDirectPayStock(db, { fromStatus: 'direct_expired_unconfirmed', productId: product_id, quantity })   // D3 回补(pre-ship 唯一入口)
      graceCancelled.push(id); done = true
    })()
    // 审计项 B(N2):自动关单也要告知双方(此前静默,买家不知单没了、卖家不知库存已回)。tx 外 fail-soft。
    if (done) {
      try { createNotification(db, buyer_id, id, 'direct_pay_grace_cancelled', '🚫 直付订单已自动取消', '付款窗口与宽限期均已过且未收到你的付款标记/凭证,订单已关闭。若你确已付款,请通过订单页联系卖家协商。', { templateKey: 'dp_grace_cancelled_buyer', params: {} }) } catch (e) { console.warn('[direct-pay-timeouts] notify grace-cancel buyer:', (e as Error).message) }
      try { createNotification(db, seller_id, id, 'direct_pay_grace_cancelled', '🚫 直付订单已自动取消(买家未付款)', '买家未在付款窗口+宽限期内付款,订单已自动关闭,库存已恢复。', { templateKey: 'dp_grace_cancelled_seller', params: {} }) } catch (e) { console.warn('[direct-pay-timeouts] notify grace-cancel seller:', (e as Error).message) }
    }
  }

  // D. 货款协商买家静默:payment_query 已过买家响应宽限(payment_query_deadline)且卖家未手动请求取消
  //    (payment_query_cancel_deadline 仍空)→ 系统【代卖家自动启动取消申请】(等价 request_cancel):
  //    设 payment_query_cancel_deadline = now + recourse_days + 通知买家最后申诉窗已开。★ 不关单、不动状态、不涉资金;
  //    买家窗内仍可 pq_escalate 主张已付,订单离开 payment_query 后本 sweep 与 Sweep C 均不再命中。之后由 Sweep C 窗满关单。
  //    幂等:WHERE payment_query_cancel_deadline IS NULL —— 卖家已手动 request_cancel 的单不被重置,重复 cron 也不刷新窗口。
  const rd = recourseDays(db)
  const pqSilentRows = db.prepare(`
    SELECT id, buyer_id FROM orders
    WHERE status = 'payment_query'
      AND payment_rail = 'direct_p2p'
      AND payment_query_deadline IS NOT NULL
      AND datetime(payment_query_deadline) < datetime('now')
      AND payment_query_cancel_deadline IS NULL
    LIMIT 1000
  `).all() as Array<{ id: string; buyer_id: string }>
  for (const { id, buyer_id } of pqSilentRows) {
    const res = db.prepare(`UPDATE orders SET payment_query_cancel_deadline = datetime('now', ?) WHERE id = ? AND payment_query_cancel_deadline IS NULL`).run(`+${rd} days`, id)
    if (res.changes === 0) continue   // 竞态:同 tick 已被设(卖家 request_cancel)——不重复处理
    pqRecourseOpened.push(id)
    try {
      const dl = (db.prepare("SELECT payment_query_cancel_deadline d FROM orders WHERE id = ?").get(id) as { d: string }).d
      createNotification(db, buyer_id, id, 'payment_query_cancel_requested', '⏳ 卖家申请取消订单', `卖家称未收到货款且你未在响应期内回应,系统已代卖家发起取消。你约有 ${rd} 天:若确已付款请提供付款参考或发起举证(pq_escalate),否则订单将于 ${dl} 自动取消。直付非托管,无平台退款。`)
    } catch (e) { console.warn('[direct-pay-timeouts] notify pq-recourse:', (e as Error).message) }
  }

  // C. 货款协商:卖家已请求取消(payment_query_cancel_deadline 已设)+ 买家申诉窗满 → 系统关单 + 退费用质押。
  //    ★ 窗内(now < deadline)绝不关:买家全程可主张已付/升级举证(pq_escalate 回 disputed)。
  const pqCancelRows = db.prepare(`
    SELECT id, product_id, quantity FROM orders
    WHERE status = 'payment_query'
      AND payment_rail = 'direct_p2p'
      AND payment_query_cancel_deadline IS NOT NULL
      AND datetime(payment_query_cancel_deadline) < datetime('now')
    LIMIT 1000
  `).all() as Array<{ id: string; product_id: string; quantity: number }>
  for (const { id, product_id, quantity } of pqCancelRows) {
    let done = false
    db.transaction(() => {
      const r = transition(db, id, 'cancelled', SYS, [], 'Rail1 直付:货款协商申诉窗满,买家未回应/未升级,系统关单')
      if (!r.success) return
      releaseFeeStake(db, { orderId: id })   // 无完成不收费:退卖家费用质押
      restorePreShipDirectPayStock(db, { fromStatus: 'payment_query', productId: product_id, quantity })   // D3 回补(pre-ship 唯一入口)
      done = true
    })()
    if (done) { pqCancelled.push(id); try { notifyTransition(db, id, 'payment_query', 'cancelled') } catch (e) { console.warn('[direct-pay-timeouts] notify pq-cancel:', (e as Error).message) } }  // 通知买卖双方(cron 系统关单也要发,route 之外)
  }

  return { windowExpired, graceCancelled, pqRecourseOpened, pqCancelled }
}

export function startDirectPayTimeoutCron(deps: DirectPayTimeoutDeps): void {
  const ms = 10 * 60 * 1000   // 10min — 付款窗口最短 30min,10min 粒度足够
  setInterval(() => {
    try {
      const r = runDirectPayTimeoutSweep(deps)
      if (r.windowExpired.length || r.graceCancelled.length || r.pqRecourseOpened.length || r.pqCancelled.length) {
        console.log(`[direct-pay-timeouts] window→expired ${r.windowExpired.length}, grace→cancelled ${r.graceCancelled.length}, pq→recourse ${r.pqRecourseOpened.length}, pq→cancelled ${r.pqCancelled.length}`)
      }
    } catch (e) {
      console.error('[direct-pay-timeouts-cron]', e)
    }
  }, ms)
  console.log('⏳ Direct Pay (Rail 1) 超时 cron 已启动 (每 10min:付款窗口超时 + 宽限关单)')
}
