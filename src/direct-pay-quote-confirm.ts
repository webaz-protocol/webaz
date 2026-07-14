import type Database from 'better-sqlite3'
import { AgentSpendCapExceeded, getAgentSpendCapViolation } from './agent-spend-cap.js'
import { buildPayableSnapshot, type DirectPayAccountSnapshot } from './direct-pay-create.js'
import { transition } from './layer0-foundation/L0-2-state-machine/engine.js'
import { toDecimal, toUnits } from './money.js'

interface QuoteRow {
  total_amount: number
  shipping_quote_fee: number
  shipping_quote_est_days: string | null
  direct_pay_account_snapshot: string | null
}

export function confirmDirectPayShippingQuote(
  db: Database.Database,
  args: { orderId: string; buyerId: string; agentApiKey?: string; windowHours: number },
): { fee: number; total: number; estDays: string | null } {
  return db.transaction(() => {
    const current = db.prepare(`SELECT total_amount, shipping_quote_fee, shipping_quote_est_days, direct_pay_account_snapshot
      FROM orders WHERE id = ? AND buyer_id = ? AND status = 'pending_accept' AND shipping_quote_required = 1 AND shipping_quote_fee IS NOT NULL`)
      .get(args.orderId, args.buyerId) as QuoteRow | undefined
    if (!current) throw new Error('QUOTE_CONFIRM_RACE')
    const fee = Number(current.shipping_quote_fee)
    const total = toDecimal(toUnits(Number(current.total_amount)) + toUnits(fee))
    const spendViolation = getAgentSpendCapViolation(db, args.agentApiKey, args.buyerId, [total], { excludeOrderId: args.orderId })
    if (spendViolation) throw new AgentSpendCapExceeded(spendViolation)
    let accountSnapshot = current.direct_pay_account_snapshot
    try {
      if (accountSnapshot) {
        const snapshot = JSON.parse(accountSnapshot) as DirectPayAccountSnapshot
        accountSnapshot = JSON.stringify({ ...snapshot, ...buildPayableSnapshot(total, snapshot.currency ?? null) })
      }
    } catch { accountSnapshot = current.direct_pay_account_snapshot }
    const updated = db.prepare(`UPDATE orders SET total_amount = ?, shipping_fee = ?, shipping_est_days = ?, direct_pay_account_snapshot = ?, direct_pay_window_deadline = ?
      WHERE id = ? AND status = 'pending_accept' AND shipping_quote_fee = ?`)
      .run(total, fee, current.shipping_quote_est_days, accountSnapshot, new Date(Date.now() + args.windowHours * 3600_000).toISOString(), args.orderId, fee)
    if (updated.changes !== 1) throw new Error('QUOTE_CONFIRM_RACE')
    const moved = transition(db, args.orderId, 'direct_pay_window', 'sys_protocol', [], `买家确认运费报价(${fee} USDC,新总额 ${total})→ 进入直付付款窗口`, { requireSignedEvent: true })
    if (!moved.success) throw new Error(moved.error || 'TRANSITION_FAILED')
    return { fee, total, estDays: current.shipping_quote_est_days }
  }).immediate()
}
