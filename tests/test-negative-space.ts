// RFC-011 §② 负空间 —— 限额与 limits.ts 同源(doc=code)+ 速率实时读 + 禁区/后果阶梯齐全。
import { buildNegativeSpace } from '../src/pwa/negative-space.js'
import { CROSS_USER_READ_DAILY_CAP, MASS_ACTION_DAILY_CAPS, AGENT_RATE_PER_MIN_DEFAULTS, IP_RATE_DEFAULT } from '../src/pwa/limits.js'
import { capabilityMatrix } from '../src/pwa/endpoint-actions.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// 默认 param getter(全回落 → 反映 limits.ts 默认)
const fallback = <T>(_k: string, f: T): T => f
const n = buildNegativeSpace(fallback)

// ── doc=code:发布的限额表 === limits.ts 源(同源,零漂移)──
expect('cross-user cap == limits.ts', JSON.stringify(n.rate_limits.cross_user_read_daily.by_trust_level) === JSON.stringify(CROSS_USER_READ_DAILY_CAP))
expect('mass-action cap == limits.ts', JSON.stringify(n.rate_limits.mass_action_daily.by_action_and_level) === JSON.stringify(MASS_ACTION_DAILY_CAPS))
expect('anon IP 限流 == limits.ts', n.rate_limits.anonymous_ip.max === IP_RATE_DEFAULT.max && n.rate_limits.anonymous_ip.window_ms === IP_RATE_DEFAULT.window_ms)
expect('per-agent 速率回落 == limits.ts 默认', JSON.stringify(n.rate_limits.per_agent_per_min.by_trust_level) === JSON.stringify(AGENT_RATE_PER_MIN_DEFAULTS))

// ── per-agent 速率【实时读 param】(注入非默认值 → 必须反映)──
const overridden = buildNegativeSpace(<T>(k: string, f: T): T => k === 'agent_rate_new_per_min' ? (7 as unknown as T) : f)
expect('per-agent 速率实时读 param(new→7,非默认120)', overridden.rate_limits.per_agent_per_min.by_trust_level.new === 7)

// ── read_scopes 与 ② capability matrix 同源 ──
expect('read_scopes == capability matrix', JSON.stringify(n.read_scopes) === JSON.stringify(capabilityMatrix().read_scopes))

// ── 禁区(meta-rule #3)──
expect('禁区含跨用户聚合/转售/冒充/越 scope', ['aggregate','resell','impersonate','scope'].every(k => n.forbidden.some(f => f.toLowerCase().includes(k))))
expect('禁区有 enforced_by', Array.isArray(n.forbidden_enforced_by) && n.forbidden_enforced_by.length >= 3)

// ── 后果阶梯(3-strike)──
expect('后果阶梯 warning→suspend_7d→permanent', n.consequence_ladder.steps.map(s => s.level).join(',') === 'warning,suspend_7d,permanent')
expect('阶梯有申诉路径', /strikes\/:id\/appeal/.test(n.consequence_ladder.appeal))
expect('iron-rule 不被 scope/限额覆盖', /WebAuthn/.test(n.iron_rule))
expect('带版本双轴', typeof n.software_version === 'string' && typeof n.contract_version === 'number')

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
