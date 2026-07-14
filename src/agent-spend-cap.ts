import type Database from 'better-sqlite3'
import { add, sum, toDecimal, toUnits, type Units } from './money.js'

export interface AgentSpendCapViolation {
  error: string
  error_code: 'AGENT_SPEND_CAP_PER_ORDER' | 'AGENT_SPEND_CAP_DAILY'
  spend_cap: number
  today_spent?: number
}

export class AgentSpendCapExceeded extends Error {
  constructor(readonly violation: AgentSpendCapViolation) {
    super(violation.error)
  }
}

export function getAgentSpendCapViolation(db: Database.Database, apiKey: string | undefined, userId: string,
  orderTotals: readonly number[], options: { excludeOrderId?: string } = {}): AgentSpendCapViolation | null {
  if (!apiKey) return null
  const cap = db.prepare(`SELECT spend_cap_per_order, spend_cap_daily FROM agent_attestations
    WHERE api_key = ? AND user_id = ? AND revoked_at IS NULL`)
    .get(apiKey, userId) as { spend_cap_per_order: number | null; spend_cap_daily: number | null } | undefined
  if (!cap) return null

  const orderTotalUnits = orderTotals.map(toUnits)
  const perOrderCapU = cap.spend_cap_per_order == null ? null : toUnits(cap.spend_cap_per_order)
  const overPerOrderU = orderTotalUnits.find(totalU => totalU > 0 && perOrderCapU != null && totalU > perOrderCapU)
  if (perOrderCapU != null && overPerOrderU != null) {
    return {
      error: `本笔订单 ${toDecimal(overPerOrderU)} WAZ 超过 agent 单笔上限 ${toDecimal(perOrderCapU)} WAZ（用户设定）`,
      error_code: 'AGENT_SPEND_CAP_PER_ORDER',
      spend_cap: toDecimal(perOrderCapU),
    }
  }
  if (cap.spend_cap_daily == null) return null
  const selectedTotalU = sum(orderTotalUnits)
  const excludedId = options.excludeOrderId ?? null
  const historicalOrders = db.prepare(`SELECT total_amount, COALESCE(donation_amount, 0) AS donation_amount
    FROM orders WHERE buyer_id = ? AND created_at > datetime('now', '-24 hours') AND status != 'cancelled'
      AND (? IS NULL OR id != ?)`).all(userId, excludedId, excludedId)
  const todaySpentU = (historicalOrders as Array<{ total_amount: number; donation_amount: number }>).reduce<Units>(
      (totalU, order) => add(totalU, add(toUnits(order.total_amount), toUnits(order.donation_amount))), 0,
    )
  const dailyCapU = toUnits(cap.spend_cap_daily)
  if (add(todaySpentU, selectedTotalU) <= dailyCapU) return null
  return {
    error: `24h 累计 ${toDecimal(todaySpentU)}+${toDecimal(selectedTotalU)} 超 agent 日上限 ${toDecimal(dailyCapU)} WAZ（用户设定）`,
    error_code: 'AGENT_SPEND_CAP_DAILY',
    spend_cap: toDecimal(dailyCapU),
    today_spent: toDecimal(todaySpentU),
  }
}
