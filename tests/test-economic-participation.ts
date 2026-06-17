// RFC-011 §⑧ 经济参与索引 —— doc=code(费率实时读)+ 守恒 + 诚实 status 测试。
import { buildEconomicParticipation } from '../src/pwa/economic-participation.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// 模拟一个【非默认】的 protocol_params 状态,证明索引读的是实时值而非硬编码默认。
const overrides: Record<string, number> = {
  protocol_fee_rate_shop: 0.015,        // ≠ default 0.02
  default_commission_rate: 0.08,        // ≠ default 0.05
  require_seller_stake: 1,              // ≠ default 0
  'governance_onboarding.verifier_min_reputation': 88,
}
const getParam = <T>(k: string, f: T): T => (k in overrides ? overrides[k] as unknown as T : f)

const e = buildEconomicParticipation(getParam)
const byRole = new Map(e.roles.map(r => [r.role, r]))

expect('含 8 角色', e.roles.length === 8, e.roles.length)
expect('覆盖核心 value-participant 角色', ['seller_shop','seller_secondhand','promoter','logistics','anchor_verifier','arbitrator','skill_author','insurer'].every(r => byRole.has(r)))
// doc=code:费率必须反映传入的实时 param,不能是硬编码默认
expect('seller_shop 费率读实时值 0.015(非默认0.02)', (byRole.get('seller_shop') as any).earns.protocol_fee_rate === 0.015)
expect('promoter 佣金读实时值 0.08(非默认0.05)', (byRole.get('promoter') as any).earns.default_commission_rate === 0.08)
expect('require_seller_stake 实时翻转 → collateral.required=true', (byRole.get('seller_shop') as any).collateral.required === true)
expect('verifier 门槛读实时 reputation 88', /88/.test((byRole.get('anchor_verifier') as any).gate))
// 守恒 + bootstrap 不变量
expect('守恒不变量明示"never minted"', /never minted/i.test(e.principles.conservation))
expect('bootstrap stake_backing=0 零没收', /zero forfeit/i.test(e.principles.bootstrap_no_forfeit))
// 诚实分级:通用承保方未上线必须标 scaffolded + 给出 why
expect('insurer 诚实标 scaffolded', (byRole.get('insurer') as any).status === 'scaffolded')
expect('insurer 说明为何未 live(enters-core)', /enters-core|own RFC|No real underwriters/i.test((byRole.get('insurer') as any).why_not_live))
expect('已上线角色标 live(除 insurer)', e.roles.filter(r => r.role !== 'insurer').every(r => (r as any).status === 'live'))
// 公平三原则 + 责任跟随
expect('含公平三原则', e.principles.fairness.length === 3)
expect('seller fault → settleFault 守恒', /settleFault/.test((byRole.get('seller_shop') as any).liability.settlement))
expect('iron-rule 真人门', /WebAuthn/.test(e.human_gates))
expect('带版本双轴', typeof e.software_version === 'string' && typeof e.contract_version === 'number')

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
