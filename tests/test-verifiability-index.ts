// RFC-011 §⑤ 可验证索引结构 + 诚实分级测试(关键:订单链不得过度声明为公开签名)。
import { buildVerifiabilityIndex } from '../src/pwa/verifiability-index.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const v = buildVerifiabilityIndex()
const byId = new Map(v.artifacts.map(a => [a.artifact, a]))

expect('4 个可验证制品', v.artifacts.length === 4, v.artifacts.length)
expect('含 passport/anchor/ap2/order_chain', ['agent_passport','external_anchor','ap2_mandate','order_event_chain'].every(k => byId.has(k)))
expect('每个都有 how_to_verify + level + proves', v.artifacts.every(a => a.how_to_verify && (a as any).level && a.proves))
expect('护照 = public_signature + offline(可 ecrecover)', (byId.get('agent_passport') as any).level === 'public_signature' && byId.get('agent_passport')!.offline === true)
// 诚实分级核心:订单链不得声明公开签名,必须是 integrity_chain + party_gated
expect('订单链 = integrity_chain(非 public_signature)', (byId.get('order_event_chain') as any).level === 'integrity_chain')
expect('订单链标 party_gated', (byId.get('order_event_chain') as any).party_gated === true)
expect('订单链明示 HMAC 第三方不可验(防过度声明)', /HMAC[\s\S]*NOT third-party verifiable/i.test((byId.get('order_event_chain') as any).scheme))
expect('levels 词典含 4 档', Object.keys(v.levels).length === 4 && 'integrity_chain' in v.levels)
expect('密钥不内嵌、指向 did.json(doc=code)', /did\.json/.test((byId.get('agent_passport') as any).keys) && !JSON.stringify(v).includes('0x'))
expect('带版本双轴', typeof v.software_version === 'string' && typeof v.contract_version === 'number')

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
