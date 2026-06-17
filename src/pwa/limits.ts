/**
 * Enforced rate/cap tables —— 单一真相源(doc=code)。
 * server.ts 的 enforcer(getAgentRateCap / checkMassActionCap / checkCrossUserReadCap / rateLimitOk)
 * 与 RFC-011 §② negative-space 发布面【都从这里读】,所以发布的限额永远 == 真正 enforce 的限额,零漂移。
 * 抽取自 server.ts 内联常量(行为不变,值逐一对应),同 endpoint-actions.ts(#126)抽取模式。
 */

/** Per-agent 每分钟请求上限的【默认值】(治理可经 param `agent_rate_<level>_per_min` 覆盖,运行时实时读)。 */
export const AGENT_RATE_PER_MIN_DEFAULTS: Record<string, number> = {
  legend: 1200,
  quality: 600,
  trusted: 300,
  new: 120,
}

/** 跨用户读日 cap —— 每天可读的【不同】其他用户数(distinct other_user_id)。防枚举/扒数据;真人监护人也罩(只是更高)。 */
export const CROSS_USER_READ_DAILY_CAP: Record<string, number> = {
  passkey_human: 300,
  legend: 200,
  quality: 100,
  trusted: 60,
  new: 30,
}

/** Mass-action(social-write)日 cap —— 防 spam / 信息轰炸。 */
export const MASS_ACTION_TYPES: readonly string[] = ['chat', 'comment', 'share']
export const MASS_ACTION_DAILY_CAPS: Record<string, Record<string, number>> = {
  chat:    { new: 30, trusted: 100, quality: 300, legend: 1000 },
  comment: { new: 20, trusted: 60,  quality: 150, legend: 500 },
  share:   { new: 10, trusted: 30,  quality: 100, legend: 300 },
}

/** 公开/匿名端点的 per-IP 限流默认(rateLimitOk)。 */
export const IP_RATE_DEFAULT = { max: 200, window_ms: 60_000 } as const
