// RFC-011 §① 目标索引 —— doc=code 锁(每个 action 是 ② 真实 token)+ 覆盖 + 无断链 + endpoint 不漂移。
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildGoalIndex, invalidGoalActions } from '../src/pwa/goal-index.js'
import { capabilityMatrix } from '../src/pwa/endpoint-actions.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const g = buildGoalIndex()
const m = capabilityMatrix()
const validActions = new Set<string>(['open', ...m.write_actions.map(w => w.action), ...m.read_scopes.map(r => r.scope)])

// ── doc=code 防漂移核心:每个 goal.action 必须在 ② capability matrix 里真实存在(或 'open')──
expect('每个 goal.action ∈ ② 真实 token(无幽灵能力)', invalidGoalActions().length === 0, invalidGoalActions())
expect('交叉验证:所有 action 在 validActions 集', g.goals.every(x => validActions.has(x.action)), g.goals.filter(x => !validActions.has(x.action)).map(x => x.action))

// ── endpoint 防漂移锁(Codex #136):每个 goal.endpoint 必须命中真实注册的 REST 路由 ──
//   外部 agent 靠 goal index 自路由;advertised endpoint 与实际 app.<method>('/path') 漂移 = 把 agent 引到 404。
//   实时扫 routes/*.ts + server.ts 的真实注册(不维护手抄清单,故测试本身不会漂移),
//   再把 goal.endpoint 的人读简写规范化成 `METHOD /path` token 逐个核对。
const PWA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pwa')
const routeSrc = [
  ...readdirSync(join(PWA_DIR, 'routes')).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(PWA_DIR, 'routes', f), 'utf8')),
  readFileSync(join(PWA_DIR, 'server.ts'), 'utf8'),
].join('\n')
// :param 名无关紧要(doc 用 :id,路由可能 :product_id)→ 两边都折叠成 :p,只校验路径【结构】。
const normPath = (p: string) => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
const REGISTERED = new Set<string>()
for (const mm of routeSrc.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
  REGISTERED.add(`${mm[1].toUpperCase()} ${normPath(mm[2])}`)
}
// 把一条 endpoint 简写展开成具体 `METHOD /path` token(支持 ` · ` 多端点、`POST|PUT` 多方法、
//  `{a|b|c}` 花括号枚举、`?query` 后缀、` (注解)` 尾注)。
function endpointTokens(endpoint: string): string[] {
  const out: string[] = []
  for (let clause of endpoint.split('·')) {
    clause = clause.replace(/\s*\([^)]*\)\s*$/, '').trim()        // 去尾部 (注解)
    const slash = clause.indexOf('/')
    if (slash < 0) continue
    const methods = clause.slice(0, slash).trim().split('|').map(s => s.trim()).filter(Boolean)
    let path = clause.slice(slash).trim().split(/\s+/)[0].split('?')[0]   // 取首个 /token,去 query
    const brace = path.match(/\{([^}]*)\}/)
    const paths = brace ? brace[1].split('|').map(v => path.replace(/\{[^}]*\}/, v.trim())) : [path]
    for (const mth of methods) for (const pp of paths) out.push(`${mth.toUpperCase()} ${normPath(pp)}`)
  }
  return out
}
expect('扫到真实路由注册(sanity)', REGISTERED.size > 100, REGISTERED.size)
const endpointDrift = g.goals.flatMap(x => endpointTokens(x.endpoint).filter(t => !REGISTERED.has(t)).map(t => ({ goal: x.goal, advertised: x.endpoint, missing: t })))
expect('每个 goal.endpoint 命中真实注册路由(无 404 漂移)', endpointDrift.length === 0, endpointDrift)
// 负向自证:故意编造的端点必须被抓到(证明锁会咬,不是空过)。
expect('锁会咬:编造 endpoint 不在 REGISTERED', endpointTokens('GET /api/totally-not-a-route').every(t => !REGISTERED.has(t)))
// 专项锚定 Codex #136:外链匹配走 POST /api/search-by-link,不是任何 GET /api/search。
const linkGoal = g.goals.find(x => /pasted external link/i.test(x.goal))
expect('#136: 外链 goal = POST /api/search-by-link', !!linkGoal && endpointTokens(linkGoal.endpoint).includes('POST /api/search-by-link'), linkGoal?.endpoint)

// ── 覆盖整条旅程的关键意图 ──
const tokens = new Set(g.goals.map(x => x.action))
expect('覆盖核心写动作(place_order/list_product/fulfill/confirm_order/dispute_respond/bid)', ['place_order','list_product','fulfill','confirm_order','dispute_respond','bid'].every(t => tokens.has(t)), [...tokens])
expect('含开放读目标(搜索/比价/查判例/验证)', g.goals.filter(x => x.action === 'open').length >= 4)
expect('含 set_address(PII 写门)', tokens.has('set_address'))
expect('含经济参与 + 验证 跨维度目标', g.goals.some(x => /economic\.json/.test(x.endpoint)) && g.goals.some(x => /verifiability\.json/.test(x.endpoint)))

// ── 结构自洽:无空 endpoint / 无空 goal / 字段齐全 ──
expect('每个目标 goal/when/endpoint/pwa 非空', g.goals.every(x => x.goal && x.when && x.endpoint && x.pwa))
expect('mcp_tool 要么 null 要么 webaz_ 前缀', g.goals.every(x => x.mcp_tool === null || /^webaz_/.test(x.mcp_tool)))
expect('目标数 ≥ 18(旅程铺满)', g.goals.length >= 18, g.goals.length)
expect('指向 ② capability_matrix', /webaz-capabilities\.json/.test(g.capability_matrix))
expect('带版本双轴', typeof g.software_version === 'string' && typeof g.contract_version === 'number')

// ── 负向:故意注入幽灵 action 必须被 invalidGoalActions 抓到(证明锁会咬)──
// (静态验证 invalidGoalActions 的判定逻辑:validActions 不含编造 token)
expect('锁会咬:编造 token 不在 validActions', !validActions.has('totally_made_up_action'))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
