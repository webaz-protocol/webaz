import type Database from 'better-sqlite3'

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

export function getAgentSpendCapViolation(
  db: Database.Database,
  apiKey: string | undefined,
  userId: string,
  orderTotals: readonly number[],
): AgentSpendCapViolation | null {
  if (!apiKey) return null
  const cap = db.prepare(`SELECT spend_cap_per_order, spend_cap_daily FROM agent_attestations
    WHERE api_key = ? AND user_id = ? AND revoked_at IS NULL`)
    .get(apiKey, userId) as { spend_cap_per_order: number | null; spend_cap_daily: number | null } | undefined
  if (!cap) return null

  const overPerOrder = orderTotals.find(total => total > 0 && cap.spend_cap_per_order != null && total > cap.spend_cap_per_order)
  if (cap.spend_cap_per_order != null && overPerOrder != null) {
    return {
      error: `本笔订单 ${overPerOrder} WAZ 超过 agent 单笔上限 ${cap.spend_cap_per_order} WAZ（用户设定）`,
      error_code: 'AGENT_SPEND_CAP_PER_ORDER',
      spend_cap: cap.spend_cap_per_order,
    }
  }
  if (cap.spend_cap_daily == null) return null
  const selectedTotal = orderTotals.reduce((sum, total) => sum + total, 0)

  const todaySpent = (db.prepare(`SELECT COALESCE(SUM(total_amount), 0) as t
    FROM orders WHERE buyer_id = ? AND created_at > datetime('now', '-24 hours') AND status != 'cancelled'`)
    .get(userId) as { t: number }).t
  if (todaySpent + selectedTotal <= cap.spend_cap_daily) return null
  return {
    error: `24h 累计 ${todaySpent}+${selectedTotal} 超 agent 日上限 ${cap.spend_cap_daily} WAZ（用户设定）`,
    error_code: 'AGENT_SPEND_CAP_DAILY',
    spend_cap: cap.spend_cap_daily,
    today_spent: todaySpent,
  }
}
