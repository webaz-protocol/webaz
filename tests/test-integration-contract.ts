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

// ── agent_quickstart: 陌生 agent 60 秒冷启动块(离散可解析 + 贡献边界前置 + 无经济承诺) ──
const q = (c as any).agent_quickstart
expect('含 agent_quickstart 块', !!q && typeof q === 'object')
expect('quickstart.canonical_start_url 指向 integration.json', /\/\.well-known\/webaz-integration\.json$/.test(q.canonical_start_url))
expect('quickstart 一句话定位(agent-native + launched + rail boundary)', /agent-native/i.test(q.what_is_webaz) && /publicly launched/i.test(q.what_is_webaz) && /Direct Pay is live/i.test(q.what_is_webaz) && /escrow rail remains simulated/i.test(q.what_is_webaz))
expect('quickstart.public_readonly_entrypoints 是数组且含 well-known + 公开任务板',
  Array.isArray(q.public_readonly_entrypoints) && q.public_readonly_entrypoints.some((u: string) => /webaz-protocol\.json/.test(u)) && q.public_readonly_entrypoints.some((u: string) => /\/api\/public\/build-tasks/.test(u)))
expect('quickstart.anonymous_allowed_actions 含只读 + keyless suggest',
  Array.isArray(q.anonymous_allowed_actions) && q.anonymous_allowed_actions.some((a: string) => /no credential|no key/i.test(a)) && q.anonymous_allowed_actions.some((a: string) => /suggest/i.test(a)))
expect('quickstart.authenticated_required_actions 含 write/transact',
  Array.isArray(q.authenticated_required_actions) && q.authenticated_required_actions.some((a: string) => /write|transact/i.test(a)))
expect('quickstart.how_to_authenticate 讲明真人 + Passkey + agent 不能自助',
  /human/i.test(q.how_to_authenticate) && /Passkey/i.test(q.how_to_authenticate) && /CANNOT self-register|cannot self-register/i.test(q.how_to_authenticate))
expect('quickstart.safe_next_actions 是有序数组(≥3)', Array.isArray(q.safe_next_actions) && q.safe_next_actions.length >= 3)
expect('quickstart.proposal_flow 含 discover + suggest + after_submit(人工审、非自动采纳)',
  !!q.proposal_flow && /build-tasks/.test(q.proposal_flow.discover) && /task-proposals/.test(q.proposal_flow.suggest) && /manual|maintainer/i.test(q.proposal_flow.after_submit))
// 贡献边界:建议明确 NOT 贡献事实 / NOT 自动奖励;facts/evidence/attribution only
expect('quickstart.contribution_boundary 说明 建议≠贡献事实 + facts/evidence/attribution only',
  /NOT a contribution fact/i.test(q.contribution_boundary) && /facts \/ evidence \/ attribution only/i.test(q.contribution_boundary))
// 无经济承诺:quickstart 块整体不得出现 reward/payout/income/收益/提现 等承诺性措辞
expect('quickstart 块无承诺性经济措辞(reward/payout/income/收益/提现)',
  !/reward|payout|income|收益|提现/i.test(JSON.stringify(q)), JSON.stringify(q).match(/reward|payout|income|收益|提现/i)?.[0])

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
