/**
 * L1-2 · Agent 护照(Phase 1 — 透明化/只读)
 *
 * 从既有数据纯派生 4 个责任指标,不写任何状态、不做任何强制:
 *   - risk_score          0-100(越高越险);429高频/错误率带 30 天半衰期衰减 + 纠纷/sybil 结构罚
 *   - engagement_depth    shallow/medium/deep/profound(调用量 × 动作多样性 × 是否涉治理)
 *   - behavior_profile    query/transact/govern 三类占比(从 agent_call_log)
 *   - custodian_fingerprint  hash(监护人)— 可追溯不暴露身份(由调用方注入 fingerprintFn)
 *
 * 设计:算法公开(本文件即规则)、原始明细不外泄(只出摘要)。后续阶段才接强制/签名/ZK。
 */
import type Database from 'better-sqlite3'

export type EngagementDepth = 'shallow' | 'medium' | 'deep' | 'profound'

export interface AgentPassport {
  risk_score: number
  engagement_depth: EngagementDepth
  behavior_profile: { query: number; transact: number; govern: number }
  custodian_fingerprint: string
  calls_30d: number
  governance_calls_30d: number
}

const HALF_LIFE_DAYS = 30   // 衰减半衰期(默认 30 天)

// endpoint+method → 行为桶
function bucketOf(endpoint: string, method: string): 'query' | 'transact' | 'govern' {
  const e = String(endpoint || '')
  const m = String(method || 'GET').toUpperCase()
  if (/vote|arbitrate|governance|protocol-params|claim-tasks|disputes\/[^/]+\/(arbitrate|respond)/.test(e)) return 'govern'
  if (m === 'GET') return 'query'
  // 非 GET 的业务写 → 交易类
  if (/orders|products|bids|rfqs|wallet|skill-market|secondhand|auction|p2p|trial|claim/.test(e)) return 'transact'
  return 'transact'  // 其余写操作也归交易类(保守)
}

const round2 = (n: number) => Math.round(n * 100) / 100
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * 纯只读派生。fingerprintFn 由上层注入(用协议 secret hash 监护人 id)。
 * 所有可选表/列查询用 try 包裹,缺失时退化为 0,绝不抛。
 */
export function computeAgentPassport(
  db: Database.Database,
  apiKey: string,
  ownerId: string,
  fingerprintFn: (ownerId: string) => string,
): AgentPassport {
  // ── 行为画像 + 调用量(30 天)──
  const rows = (() => {
    try {
      return db.prepare(`SELECT endpoint, method FROM agent_call_log WHERE api_key = ? AND created_at > datetime('now','-30 days')`).all(apiKey) as Array<{ endpoint: string; method: string }>
    } catch { return [] }
  })()
  const counts = { query: 0, transact: 0, govern: 0 }
  for (const r of rows) counts[bucketOf(r.endpoint, r.method)]++
  const calls30d = rows.length
  const denom = calls30d || 1
  const behavior_profile = {
    query: round2(counts.query / denom),
    transact: round2(counts.transact / denom),
    govern: round2(counts.govern / denom),
  }
  const governance_calls_30d = counts.govern

  // ── 风险分 ──
  // 1) 429 高频(主攻击信号)+ 其余 4xx/5xx,按事件年龄做 30d 半衰期衰减(90d 窗口)
  let rlWeighted = 0
  let errWeighted = 0
  try {
    const bad = db.prepare(`
      SELECT status_code AS sc, (julianday('now') - julianday(created_at)) AS age_days
      FROM agent_call_log
      WHERE api_key = ? AND status_code >= 400 AND created_at > datetime('now','-90 days')
    `).all(apiKey) as Array<{ sc: number; age_days: number }>
    for (const b of bad) {
      const w = Math.pow(0.5, Math.max(0, b.age_days) / HALF_LIFE_DAYS)
      if (Number(b.sc) === 429) rlWeighted += w
      else errWeighted += w
    }
  } catch { /* no call log */ }

  // 2) 纠纷败诉(监护人级,结构罚)
  let disputeLoss = 0
  try {
    disputeLoss = (db.prepare(`SELECT COUNT(*) AS n FROM disputes WHERE defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')`).get(ownerId) as { n: number }).n
  } catch { /* table/col absent */ }

  // 3) sybil 簇:同注册 IP 的他户数(结构罚)。注册 IP 在 registration_audit_log。
  let sybilExcess = 0
  try {
    const me = db.prepare(`SELECT ip_hash FROM registration_audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(ownerId) as { ip_hash: string | null } | undefined
    if (me?.ip_hash) {
      const sz = (db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM registration_audit_log WHERE ip_hash = ?`).get(me.ip_hash) as { n: number }).n
      sybilExcess = Math.max(0, sz - 3)   // ≤3 视为正常(家庭/NAT)
    }
  } catch { /* table absent */ }

  const risk_score = clamp(Math.round(
    Math.min(40, rlWeighted * 4) +     // 429 高频 → 最多 40
    Math.min(15, errWeighted * 1.5) +  // 其余错误 → 最多 15
    Math.min(25, disputeLoss * 8) +    // 纠纷败诉 → 最多 25
    Math.min(20, sybilExcess * 5)      // sybil 簇 → 最多 20
  ), 0, 100)

  // ── 参与深度 ──
  let engagement_depth: EngagementDepth
  if (governance_calls_30d > 0 || calls30d >= 1000) engagement_depth = 'profound'
  else if (calls30d >= 100 || counts.transact >= 20) engagement_depth = 'deep'
  else if (calls30d >= 10 || counts.transact >= 1) engagement_depth = 'medium'
  else engagement_depth = 'shallow'

  return {
    risk_score,
    engagement_depth,
    behavior_profile,
    custodian_fingerprint: fingerprintFn(ownerId),
    calls_30d: calls30d,
    governance_calls_30d,
  }
}
