// RFC-011 总入口结构测试 —— 8 维 + 旅程齐全 + live 端点路径自洽(防漏维度/断链)。
import { buildIntegrationContract } from '../src/pwa/integration-contract.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const c = buildIntegrationContract()
const dims = Object.keys(c.dimensions)

expect('8 个维度齐全', dims.length === 8, dims)
expect('维度键含 ①..⑧', ['①','②','③','④','⑤','⑥','⑦','⑧'].every(n => dims.some(k => k.startsWith(n))))
expect('旅程 8 步', c.journey.length === 8 && c.journey[0].name === 'discover' && c.journey[7].name === 'participate')
expect('全 8 维度均标 live', ['①_semantics','②_boundary','③_authz','④_versioning','⑤_verifiability','⑥_eventing','⑦_liability','⑧_economic'].every(k => (c.dimensions as Record<string, { status: string }>)[k].status === 'live'))
expect('⑧ 指向 economic index', /webaz-economic\.json/.test((c.dimensions as any)['⑧_economic'].index))
expect('⑤ 指向 verifiability index', /webaz-verifiability\.json/.test((c.dimensions as any)['⑤_verifiability'].index))
expect('③ 指向 INTEGRATOR.md', /INTEGRATOR\.md/.test((c.dimensions as any)['③_authz'].onboarding))
expect('⑦ 指向 INTEGRATOR.md + enforced 责任', /INTEGRATOR\.md/.test((c.dimensions as any)['⑦_liability'].terms))
// 外部可达性:集成必需文档必须由协议自服务(webaz.xyz/docs),不得指向私有 repo 的 github(对外 404)
const critDocs = [(c.dimensions as any)['③_authz'].onboarding, (c.dimensions as any)['⑦_liability'].terms, (c.negative_space as any).meta_rules]
expect('集成必需文档 webaz.xyz-served 非 github(GAP-1)', critDocs.every((u: string) => /webaz\.xyz\/docs\//.test(u) && !/github\.com/.test(u)), critDocs)
// GAP-2:入口自答"怎么从匿名升到能写"(取 key = 真人前提,agent 不能自助)
expect('含 access 块', !!c.access && typeof c.access === 'object')
expect('access.get_api_key 讲明真人 + Passkey + agent 不能自助', /human/i.test(c.access.get_api_key) && /Passkey/i.test(c.access.get_api_key) && /CANNOT self-register|cannot self-register/i.test(c.access.get_api_key))
expect('access 给出三层升级路径', /anonymous/i.test(c.access.tiers) && /value_participant/i.test(c.access.tiers))
expect('① 指向 entity_dictionary live 端点', /webaz-entities\.json/.test((c.dimensions as any)['①_semantics'].entity_dictionary))
expect('① 指向 goal_index + 含 order/product/dispute', /webaz-goals\.json/.test((c.dimensions as any)['①_semantics'].goal_index) && ['order','product','dispute'].every((x: string) => (c.dimensions as any)['①_semantics'].entities.includes(x)))
expect('② 指向 capability_matrix', /webaz-capabilities\.json/.test((c.dimensions as any)['②_boundary'].capability_matrix))
expect('② negative_space 指向 live 端点(非 to-build)', /webaz-negative-space\.json/.test((c.dimensions as any)['②_boundary'].negative_space))
expect('④ 指向 change_feed', /api\/agent\/changes/.test((c.dimensions as any)['④_versioning'].change_feed))
expect('⑥ 指向 event_stream', /api\/agent\/events/.test((c.dimensions as any)['⑥_eventing'].event_stream))
expect('带版本双轴', typeof c.software_version === 'string' && typeof c.contract_version === 'number')
expect('含 negative_space(禁区+enforce)', Array.isArray(c.negative_space.forbidden) && c.negative_space.forbidden.length >= 3 && Array.isArray(c.negative_space.enforced_by))
expect('含三层责任 tiers', c.liability_tiers.length === 3 && c.liability_tiers.map(t => t.tier).join(',') === 'anonymous_read,authenticated_write,value_participant')
expect('含 enters_core_test + iron_rule', typeof c.enters_core_test === 'string' && /WebAuthn/.test(c.iron_rule))
expect('所有 URL 引用非空', JSON.stringify(c).split('"').filter(s => s.startsWith('https://webaz.xyz')).every(u => u.length > 'https://webaz.xyz/'.length))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
