/**
 * 反滥用阈值 — 单一真相源（governance-adjustable protocol_params）
 * ────────────────────────────────────────────────────────────────
 * #420 P1-2 / P1-3 / P1-4：把原先硬编码在 server.ts / claim-verify.ts 的
 * agent 信任公式系数、strike 升级阶梯、verifier outlier 处罚阈值，统一抽到
 * 这里，并以 protocol_params 暴露给治理调节。
 *
 * 设计原则（与 ARBITRATION-PLAYBOOK.md §6.2「算法即协议 / transparent slashing」一致）：
 *   - 公式 + 阈值【公开】，数值【治理可调】（governance PATCH /api/admin/protocol-params/:key）。
 *   - 默认值 === 抽取前的硬编码字面量 ⇒ 行为零变化（behavior-preserving）。
 *   - 纯决策函数（agentTrustLevel / agentStrikeSeverity / verifierOutlierBand）由
 *     生产代码与测试【共用同一实现】，避免「桩掉被测组件」假绿。
 *
 * ⚠️ 关于 P1-3 命名：本组 verifier_outlier_* 参数刻意【不】复用 playbook §6.2 的
 *   governance_auto_deactivate_*。后者锚定 "confirmed_wrong"（被复核确认判错）的
 *   cron 自动停用，是另一套机制；claim-verify 的 outlier strike 锚定 "was_majority=0"
 *   （少数票）的即时处罚。两者语义不同，合并会改变含义。详见 PR 说明。
 */
import type Database from 'better-sqlite3'

export type AgentLevel = 'new' | 'trusted' | 'quality' | 'legend'
export type StrikeSeverity = 'warning' | 'suspend_7d' | 'permanent'

export interface AntiAbuseThresholds {
  // ── P1-2 agent 信任公式（penalty 系数 + sybil + 等级阈值）──
  trustDisputePenalty: number      // 每次 dispute_loss 扣分
  trustSybilFreeThreshold: number  // 同 IP 账户数 ≤ 此值不罚（含自己）
  trustSybilPenalty: number        // 超出 free 阈值后每多 1 个同 IP 账户扣分
  trustCrossPenalty: number        // 每次 commission cross 命中扣分
  trustRatelimitPenalty: number    // 每次 429 命中扣分
  trustLevelTrusted: number        // trust ≥ → trusted
  trustLevelQuality: number        // trust ≥ → quality
  trustLevelLegend: number         // trust ≥ → legend
  // ── P1-4 agent strike 升级阶梯 ──
  strikeWarnWindowDays: number     // 统计 warning 的回看窗口（天）
  strikeWarnEscalateCount: number  // 窗口内已有 ≥N 次 warning + 本次 → 升 suspend_7d
  strikeSuspendWindowDays: number  // 统计 suspend_7d 的回看窗口（天）
  strikeSuspendEscalateCount: number // 窗口内已有 ≥N 次 suspend_7d + 本次 → 升 permanent
  strikeWarnExpiryHours: number    // warning 过期小时数
  strikeSuspendExpiryDays: number  // suspend_7d 过期天数
  // ── P1-3 verifier outlier 处罚阈值 ──
  outlierWindowDays: number        // 统计 outlier 票的回看窗口（天）
  outlierSuspendCount: number      // 窗口内 outlier ≥ → 暂停
  outlierRevokeCount: number       // 窗口内 outlier ≥ → 永久撤销
  outlierSuspendDays: number       // 暂停时长（天）
}

/** 默认值 === 抽取前的硬编码字面量。修改这里 = 修改全协议默认行为。 */
export const DEFAULT_ANTI_ABUSE_THRESHOLDS: AntiAbuseThresholds = {
  trustDisputePenalty: 10,
  trustSybilFreeThreshold: 3,
  trustSybilPenalty: 5,
  trustCrossPenalty: 3,
  trustRatelimitPenalty: 2,
  trustLevelTrusted: 20,
  trustLevelQuality: 50,
  trustLevelLegend: 80,
  strikeWarnWindowDays: 7,
  strikeWarnEscalateCount: 1,
  strikeSuspendWindowDays: 30,
  strikeSuspendEscalateCount: 2,
  strikeWarnExpiryHours: 24,
  strikeSuspendExpiryDays: 7,
  outlierWindowDays: 180,
  outlierSuspendCount: 3,
  outlierRevokeCount: 5,
  outlierSuspendDays: 30,
}

/**
 * protocol_params 注册定义（spread 进 server.ts 的 DEFAULT_PARAMS）。
 * value 必须与 DEFAULT_ANTI_ABUSE_THRESHOLDS 完全一致（测试强制校验）。
 */
export const ANTI_ABUSE_PARAMS: Array<{ key: string; value: string; type: string; description: string; category: string; min?: number; max?: number }> = [
  // P1-2 agent 信任公式（公开框架 + 治理可调系数）。等级阈值 cap=1000 给治理收紧空间。
  { key: 'agent_trust_dispute_penalty',       value: '10', type: 'number', description: 'agent 信任分:每次败诉 dispute(refund/partial)扣分(#420 P1-2)', category: 'security', min: 0, max: 100 },
  { key: 'agent_trust_sybil_free_threshold',  value: '3',  type: 'number', description: 'agent 信任分:同 IP 注册账户数 ≤ 此值不计 sybil 罚分(含本账户)(#420 P1-2)', category: 'security', min: 0, max: 100 },
  { key: 'agent_trust_sybil_penalty',         value: '5',  type: 'number', description: 'agent 信任分:超出 free 阈值后每多 1 个同 IP 账户扣分(#420 P1-2)', category: 'security', min: 0, max: 100 },
  { key: 'agent_trust_cross_penalty',         value: '3',  type: 'number', description: 'agent 信任分:每次放置同支审计(commission cross)命中扣分(#420 P1-2)', category: 'security', min: 0, max: 100 },
  { key: 'agent_trust_ratelimit_penalty',     value: '2',  type: 'number', description: 'agent 信任分:30d 内每次 429 限速命中扣分(#420 P1-2)', category: 'security', min: 0, max: 100 },
  { key: 'agent_trust_level_trusted',         value: '20', type: 'number', description: 'agent 信任分 ≥ 此值 → trusted 级(#420 P1-2;等级 gate 速率上限)', category: 'security', min: 0, max: 1000 },
  { key: 'agent_trust_level_quality',         value: '50', type: 'number', description: 'agent 信任分 ≥ 此值 → quality 级(#420 P1-2)', category: 'security', min: 0, max: 1000 },
  { key: 'agent_trust_level_legend',          value: '80', type: 'number', description: 'agent 信任分 ≥ 此值 → legend 级(#420 P1-2)', category: 'security', min: 0, max: 1000 },
  // P1-4 agent strike 升级阶梯（公开 consequence-transparency,见 negative-space.ts;数值治理可调）
  { key: 'agent_strike_warn_window_days',      value: '7',  type: 'number', description: 'agent strike:统计 warning 的回看窗口(天)(#420 P1-4)', category: 'security', min: 1, max: 365 },
  { key: 'agent_strike_warn_escalate_count',   value: '1',  type: 'number', description: 'agent strike:窗口内已有 ≥N 次 warning 时本次 warning 升级为 suspend_7d(默认 1=累计第 2 次升级)(#420 P1-4)', category: 'security', min: 1, max: 100 },
  { key: 'agent_strike_suspend_window_days',   value: '30', type: 'number', description: 'agent strike:统计 suspend_7d 的回看窗口(天)(#420 P1-4)', category: 'security', min: 1, max: 365 },
  { key: 'agent_strike_suspend_escalate_count',value: '2',  type: 'number', description: 'agent strike:窗口内已有 ≥N 次 suspend_7d 时升级为 permanent(默认 2=累计第 3 次升级)(#420 P1-4)', category: 'security', min: 1, max: 100 },
  { key: 'agent_strike_warn_expiry_hours',     value: '24', type: 'number', description: 'agent strike:warning 自动过期小时数(#420 P1-4)', category: 'security', min: 1, max: 720 },
  { key: 'agent_strike_suspend_expiry_days',   value: '7',  type: 'number', description: 'agent strike:suspend_7d 自动过期天数(#420 P1-4)', category: 'security', min: 1, max: 365 },
  // P1-3 verifier outlier 处罚阈值（少数票 was_majority=0 即时处罚;非 playbook §6.2 confirmed_wrong cron）
  { key: 'verifier_outlier_window_days',  value: '180', type: 'number', description: 'verifier outlier:统计少数票(was_majority=0)的回看窗口(天)(#420 P1-3)', category: 'governance', min: 1, max: 730 },
  { key: 'verifier_outlier_suspend_count', value: '3',  type: 'number', description: 'verifier outlier:窗口内 ≥N 次 → 暂停资格(#420 P1-3)', category: 'governance', min: 1, max: 100 },
  { key: 'verifier_outlier_revoke_count',  value: '5',  type: 'number', description: 'verifier outlier:窗口内 ≥N 次 → 永久撤销资格(#420 P1-3)', category: 'governance', min: 1, max: 100 },
  { key: 'verifier_outlier_suspend_days',  value: '30', type: 'number', description: 'verifier outlier:暂停时长(天)(#420 P1-3)', category: 'governance', min: 1, max: 365 },
]

// ── 同步读取器（与生产热路径同步语义:better-sqlite3 prepared get）──
function num(db: Database.Database, key: string, fallback: number): number {
  try {
    const r = db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(key) as { value: string } | undefined
    if (!r) return fallback
    const n = Number(r.value)
    return Number.isFinite(n) ? n : fallback
  } catch { return fallback }
}
/** 用于会被插入 SQL 字符串的窗口天数:强制非负整数(injection-safe + 语义正确)。 */
function intNum(db: Database.Database, key: string, fallback: number): number {
  const n = Math.round(num(db, key, fallback))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 从 protocol_params 读取全部反滥用阈值;缺行/坏值回落默认(= 当前生产行为)。 */
export function readAntiAbuseThresholds(db: Database.Database): AntiAbuseThresholds {
  const d = DEFAULT_ANTI_ABUSE_THRESHOLDS
  return {
    trustDisputePenalty:      num(db, 'agent_trust_dispute_penalty', d.trustDisputePenalty),
    trustSybilFreeThreshold:  num(db, 'agent_trust_sybil_free_threshold', d.trustSybilFreeThreshold),
    trustSybilPenalty:        num(db, 'agent_trust_sybil_penalty', d.trustSybilPenalty),
    trustCrossPenalty:        num(db, 'agent_trust_cross_penalty', d.trustCrossPenalty),
    trustRatelimitPenalty:    num(db, 'agent_trust_ratelimit_penalty', d.trustRatelimitPenalty),
    trustLevelTrusted:        num(db, 'agent_trust_level_trusted', d.trustLevelTrusted),
    trustLevelQuality:        num(db, 'agent_trust_level_quality', d.trustLevelQuality),
    trustLevelLegend:         num(db, 'agent_trust_level_legend', d.trustLevelLegend),
    strikeWarnWindowDays:     intNum(db, 'agent_strike_warn_window_days', d.strikeWarnWindowDays),
    strikeWarnEscalateCount:  num(db, 'agent_strike_warn_escalate_count', d.strikeWarnEscalateCount),
    strikeSuspendWindowDays:  intNum(db, 'agent_strike_suspend_window_days', d.strikeSuspendWindowDays),
    strikeSuspendEscalateCount: num(db, 'agent_strike_suspend_escalate_count', d.strikeSuspendEscalateCount),
    strikeWarnExpiryHours:    num(db, 'agent_strike_warn_expiry_hours', d.strikeWarnExpiryHours),
    strikeSuspendExpiryDays:  num(db, 'agent_strike_suspend_expiry_days', d.strikeSuspendExpiryDays),
    outlierWindowDays:        intNum(db, 'verifier_outlier_window_days', d.outlierWindowDays),
    outlierSuspendCount:      num(db, 'verifier_outlier_suspend_count', d.outlierSuspendCount),
    outlierRevokeCount:       num(db, 'verifier_outlier_revoke_count', d.outlierRevokeCount),
    outlierSuspendDays:       num(db, 'verifier_outlier_suspend_days', d.outlierSuspendDays),
  }
}

// ── 纯决策函数（生产 + 测试共用;无副作用,不读 db）──

/** P1-2:trust 分 → 等级。镜像原 server.ts:3818-3821 的 ≥ 级联。 */
export function agentTrustLevel(score: number, t: AntiAbuseThresholds): AgentLevel {
  if (score >= t.trustLevelLegend) return 'legend'
  if (score >= t.trustLevelQuality) return 'quality'
  if (score >= t.trustLevelTrusted) return 'trusted'
  return 'new'
}

/** P1-2:sybil 罚分。镜像原 `sybilSize > free ? -(sybilSize-free)*pen : 0`。返回非正数。 */
export function agentSybilPenalty(sybilSize: number, t: AntiAbuseThresholds): number {
  return sybilSize > t.trustSybilFreeThreshold ? -(sybilSize - t.trustSybilFreeThreshold) * t.trustSybilPenalty : 0
}

/**
 * P1-4:strike 升级判定。镜像原 server.ts:4493-4502。
 * priorWarnings = 窗口内已有未过期 warning 数;priorSuspends = 窗口内已有 suspend_7d 数。
 */
export function agentStrikeSeverity(
  initial: StrikeSeverity, priorWarnings: number, priorSuspends: number, t: AntiAbuseThresholds,
): { severity: StrikeSeverity; escalated: boolean } {
  let severity: StrikeSeverity = initial
  let escalated = false
  if (initial === 'warning' && priorWarnings >= t.strikeWarnEscalateCount) {
    severity = 'suspend_7d'; escalated = true
  }
  if (initial === 'suspend_7d' || severity === 'suspend_7d') {
    if (priorSuspends >= t.strikeSuspendEscalateCount) { severity = 'permanent'; escalated = true }
  }
  return { severity, escalated }
}

/**
 * P1-3:verifier outlier 累计数 → 处罚档位（不含 existing/dup 守卫,由调用方各自施加）。
 * 镜像原 revoke-优先、suspend-其次 的阈值比较。
 */
export function verifierOutlierBand(count: number, t: AntiAbuseThresholds): 'revoke' | 'suspend' | 'none' {
  if (count >= t.outlierRevokeCount) return 'revoke'
  if (count >= t.outlierSuspendCount) return 'suspend'
  return 'none'
}
