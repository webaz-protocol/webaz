/**
 * RFC-011 §② 负空间策略 —— agent【不能做什么】+ 真实 enforced 限额 + 后果阶梯,统一成机读契约面。
 *
 * 正空间(写能力矩阵)已 #126 发布在 /.well-known/webaz-capabilities.json;本面是其【负空间】补全。
 *
 * doc=code:限额表从 ./limits.ts 读(与 server.ts enforcer 同源,零漂移);per-agent 速率从 protocol_params
 * 实时读(治理可调)。禁区对照 META-RULES-FULL.md #3。后果阶梯对应 server.ts issueAgentStrike 状态机。
 */
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'
import { capabilityMatrix } from './endpoint-actions.js'
import { AGENT_RATE_PER_MIN_DEFAULTS, CROSS_USER_READ_DAILY_CAP, MASS_ACTION_DAILY_CAPS, IP_RATE_DEFAULT } from './limits.js'

export type ParamGetter = <T>(key: string, fallback: T) => T

const BASE = 'https://webaz.xyz'

export function buildNegativeSpace(getParam: ParamGetter) {
  // per-agent 每分钟速率:实时读 param(治理可调),回落 limits.ts 默认。
  const perAgentRatePerMin: Record<string, number> = {}
  for (const level of Object.keys(AGENT_RATE_PER_MIN_DEFAULTS)) {
    perAgentRatePerMin[level] = getParam<number>(`agent_rate_${level}_per_min`, AGENT_RATE_PER_MIN_DEFAULTS[level])
  }

  const cap = capabilityMatrix()

  return {
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    note: 'RFC-011 §② negative space — what an agent must NOT do + the ENFORCED limits + the consequence ladder. The positive write boundary is the capability matrix (/.well-known/webaz-capabilities.json). Numeric limits are doc=code (shared with the runtime enforcer via src/limits.ts); per-agent rate caps are read live from protocol_params. Crossing a limit returns 429; repeated abuse escalates strikes (see consequence_ladder).',
    // 禁区(质性)—— 元规则 #3,机制 enforce
    forbidden: [
      'rebuild/aggregate a cross-user graph or dataset (user profiling, content farming, scraping) — meta-rule #3',
      'resell or redistribute user data obtained via the protocol — meta-rule #3',
      'impersonate another user or the protocol itself',
      'exceed your declared scope (capability matrix write_actions you did not declare)',
      'self-register accounts to bypass invite/captcha/real-person accountability (NETWORK mode blocks agent self-register)',
    ],
    forbidden_enforced_by: [
      'default-deny write boundary (undeclared agent → AGENT_SCOPE_UNDECLARED)',
      'cross-user read daily cap (distinct other-user reads; humans capped too)',
      'sensitive cross-user read scopes (search / profile) constrain declared agents',
      'accountability strikes → 3-strike block; api-key revocation',
    ],
    // enforced 限额
    rate_limits: {
      per_agent_per_min: { by_trust_level: perAgentRatePerMin, param: 'agent_rate_<level>_per_min (live)', on_exceed: '429; sustained abuse → strike (reason rate_limit_abuse)' },
      cross_user_read_daily: { unit: 'distinct other-user reads per day (e.g. /api/users/:id/*)', by_trust_level: CROSS_USER_READ_DAILY_CAP, note: 'passkey_human is capped too (a scraper using a real account does not bypass)', on_exceed: '403 CROSS_USER_READ_DAILY_CAP' },
      mass_action_daily: { unit: 'social-write actions per day', by_action_and_level: MASS_ACTION_DAILY_CAPS, on_exceed: '429 AGENT_DAILY_CAP; ≥3 overruns/24h → strike (warning)' },
      anonymous_ip: { max: IP_RATE_DEFAULT.max, window_ms: IP_RATE_DEFAULT.window_ms, note: 'per-IP default for public/unauthenticated endpoints' },
    },
    read_scopes: cap.read_scopes,   // 敏感跨用户读门(search / profile),与 ② 同源
    // 后果阶梯(对应 issueAgentStrike 状态机)
    consequence_ladder: {
      model: '3-strike state machine on the agent api_key (→ passport, → custodian).',
      steps: [
        { level: 'warning', effect: 'recorded; expires ~24h', escalates: 'a 2nd warning within 7 days → suspend_7d' },
        { level: 'suspend_7d', effect: '7-day suspension; active skills auto-disabled', escalates: 'a 3rd suspension within 30 days → permanent' },
        { level: 'permanent', effect: 'permanent block of the api_key' },
      ],
      appeal: `POST ${BASE}/api/me/agents/strikes/:id/appeal (reason ≥10 chars)`,
      enforced_by: 'src/pwa/server.ts issueAgentStrike + agent_strikes table',
    },
    iron_rule: 'arbitrate / vote / agent_revoke / delete_passkey / large withdraw require a live WebAuthn ceremony regardless of declared scope (CHARTER §4 iron-rule) — no scope or rate budget overrides it.',
    references: {
      meta_rules: `${BASE}/docs/META-RULES-FULL.md`,   // 协议自服务 —— agent 必须能读到约束它的规则
      capability_matrix: `${BASE}/.well-known/webaz-capabilities.json`,
      integrator_guide: `${BASE}/docs/INTEGRATOR.md`,
    },
  }
}
