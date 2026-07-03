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
import { notifyTransition } from '../../layer2-business/L2-6-notifications/notification-engine.js'

const SYS = 'sys_protocol'

export interface DirectPayTimeoutDeps { db: Database.Database }
export interface DirectPayTimeoutResult {
  windowExpired: string[]    // order ids: direct_pay_window → direct_expired_unconfirmed
  graceCancelled: string[]   // order ids: direct_expired_unconfirmed → cancelled (宽限期满)
  pqCancelled: string[]      // order ids: payment_query → cancelled (卖家请求取消后 7d 买家申诉窗满)
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
  const pqCancelled: string[] = []

  // A. 付款窗口超时 → 可争议态(非静默关单)+ 退费用质押 + 设宽限期
  const windowRows = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'direct_pay_window'
      AND payment_rail = 'direct_p2p'
      AND direct_pay_window_deadline IS NOT NULL
      AND datetime(direct_pay_window_deadline) < datetime('now')
    LIMIT 1000
  `).all() as Array<{ id: string }>
  for (const { id } of windowRows) {
    db.transaction(() => {
      const r = transition(db, id, 'direct_expired_unconfirmed', SYS, [], 'Rail1 直付:付款窗口超时未标记')
      if (!r.success) return
      releaseFeeStake(db, { orderId: id })   // 费用质押退卖家(无完成,不收费)
      db.prepare(`UPDATE orders SET direct_grace_deadline = datetime('now', ?) WHERE id = ?`).run(`+${gh} hours`, id)
      windowExpired.push(id)
    })()
  }

  // B. 宽限期满 → 系统关单(★ WHERE 保证仅 now>grace 命中;宽限期内绝不关,买家 →disputed 全程可用)
  const graceRows = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'direct_expired_unconfirmed'
      AND payment_rail = 'direct_p2p'
      AND direct_grace_deadline IS NOT NULL
      AND datetime(direct_grace_deadline) < datetime('now')
    LIMIT 1000
  `).all() as Array<{ id: string }>
  for (const { id } of graceRows) {
    db.transaction(() => {
      const r = transition(db, id, 'cancelled', SYS, [], 'Rail1 直付:宽限期满,买家未付款/未升级争议,系统关单')
      if (r.success) graceCancelled.push(id)
    })()
  }

  // C. 货款协商:卖家已请求取消(payment_query_cancel_deadline 已设)+ 买家申诉窗满 → 系统关单 + 退费用质押。
  //    ★ 窗内(now < deadline)绝不关:买家全程可主张已付/升级举证(pq_escalate 回 disputed)。
  const pqCancelRows = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'payment_query'
      AND payment_rail = 'direct_p2p'
      AND payment_query_cancel_deadline IS NOT NULL
      AND datetime(payment_query_cancel_deadline) < datetime('now')
    LIMIT 1000
  `).all() as Array<{ id: string }>
  for (const { id } of pqCancelRows) {
    let done = false
    db.transaction(() => {
      const r = transition(db, id, 'cancelled', SYS, [], 'Rail1 直付:货款协商申诉窗满,买家未回应/未升级,系统关单')
      if (!r.success) return
      releaseFeeStake(db, { orderId: id })   // 无完成不收费:退卖家费用质押
      done = true
    })()
    if (done) { pqCancelled.push(id); try { notifyTransition(db, id, 'payment_query', 'cancelled') } catch (e) { console.warn('[direct-pay-timeouts] notify pq-cancel:', (e as Error).message) } }  // 通知买卖双方(cron 系统关单也要发,route 之外)
  }

  return { windowExpired, graceCancelled, pqCancelled }
}

export function startDirectPayTimeoutCron(deps: DirectPayTimeoutDeps): void {
  const ms = 10 * 60 * 1000   // 10min — 付款窗口最短 30min,10min 粒度足够
  setInterval(() => {
    try {
      const r = runDirectPayTimeoutSweep(deps)
      if (r.windowExpired.length || r.graceCancelled.length || r.pqCancelled.length) {
        console.log(`[direct-pay-timeouts] window→expired ${r.windowExpired.length}, grace→cancelled ${r.graceCancelled.length}, pq→cancelled ${r.pqCancelled.length}`)
      }
    } catch (e) {
      console.error('[direct-pay-timeouts-cron]', e)
    }
  }, ms)
  console.log('⏳ Direct Pay (Rail 1) 超时 cron 已启动 (每 10min:付款窗口超时 + 宽限关单)')
}
