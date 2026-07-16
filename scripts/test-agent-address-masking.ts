#!/usr/bin/env tsx
/**
 * RFC-025 PR-2.5 — agent 路径地址脱敏(G-PII-1 修复)。用法:npm run test:agent-address-masking
 *
 * 修的类别:MCP agent 面【永不】返回完整地址文本(自由文本里姓名/门牌/电话混在一起,任何子串截取都不安全)。
 * 两个泄漏面同修:webaz_default_address action=read(network+sandbox 双路径共用 maskedDefaultAddressView)
 * 与 webaz_profile action=view(network 透传 /api/me → 剥地址字段;sandbox 本就 allowlist 构造)。
 * set 动作不变;下单默认地址解析发生在 place_order 的 MCP handler 内(P-1..P-4 直接覆盖)。
 *
 * 手法:network 路径 = 假 /api/me 返回全文,证明 handler 端脱敏(WEBAZ_API_URL 必须在 import mcp 前设好 ——
 * 模块加载时读常量);sandbox 分支 = 共用纯函数直测 + 源守卫断言该分支确实调用它(两路径零 drift)。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-addrmask-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const PII = /SECRET|Jane|\+65 9123|91234567|1 Test St|default_address_text|address_text/i
const FULL_ADDR = 'Jane SECRET / 1 Test St #05-01 / Singapore SG / +65 91234567'

// ── 假上游(返回全文地址的 /api/me + set 回执)必须先起,URL 在 import mcp 前钉死 ──
const app = express(); app.use(express.json())
let lastSetBody: Record<string, unknown> | null = null
app.get('/api/me', (req, res) => {
  if (String(req.headers.authorization || '').includes('k_noaddr')) return void res.json({ id: 'usr_n', handle: 'noaddr' })
  res.json({ id: 'usr_x', handle: 'masker', default_address_text: FULL_ADDR, default_address_region: 'SG', default_address: { line1: '1 Test St', city: 'Singapore' }, default_address_json: '{"line1":"1 Test St"}', wallet: { balance: 1 } })
})
app.post('/api/profile/default-address', (req, res) => { lastSetBody = req.body as Record<string, unknown>; res.json({ success: true, stored: true }) })
let lastOrderBody: Record<string, unknown> | null = null
app.post('/api/orders', (req, res) => { lastOrderBody = req.body as Record<string, unknown>; res.json({ success: true, order: { id: 'ord_t1', status: 'created', shipping_address: (req.body as Record<string, unknown>).shipping_address } }) })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

try {
  // ── network read:上游给了全文,handler 必须只回脱敏视图 ──
  { const r = await mcp.handleDefaultAddress({ action: 'read', api_key: 'k_net' })
    ok('N-1 network read → masked view (has_default + region + summary; NO address_ref until PR-4 ships its consumer)', r.has_default === true && !('address_ref' in r) && r.address_region === 'SG' && typeof r.masked_summary === 'string', JSON.stringify(r).slice(0, 250))
    ok('N-2 network read carries NO full-address PII (upstream returned it; handler stripped it)', !PII.test(JSON.stringify(r)), JSON.stringify(r)) }
  // ── set 不变(体验零回退):照旧转发 text/region ──
  { const r = await mcp.handleDefaultAddress({ action: 'set', text: FULL_ADDR, region: 'SG', api_key: 'k_net' })
    ok('N-3 set unchanged (forwards text+region, upstream success passes through)', r.success === true && lastSetBody?.text === FULL_ADDR && lastSetBody?.region === 'SG', JSON.stringify({ r, lastSetBody }).slice(0, 200)) }
  // ── profile view:地址字段剥掉,其余身份字段透传 ──
  { const r = await mcp.handleProfile({ action: 'view', api_key: 'k_net' })
    ok('N-4 profile view strips default_address_text / default_address / default_address_json', !('default_address_text' in r) && !('default_address' in r) && !('default_address_json' in r), JSON.stringify(r).slice(0, 250))
    ok('N-5 profile view keeps non-PII identity fields (handle passes through)', r.handle === 'masker')
    ok('N-6 profile view carries NO full-address PII', !/SECRET|1 Test St|91234567/.test(JSON.stringify(r))) }
  // ── place_order 默认地址兜底(Codex High 修复):省略 → handler 注入全文;工具返回值零全文回流 ──
  { const r = await mcp.handlePlaceOrder({ product_id: 'prd_x', quantity: 2, session_token: 'pst_t', expected_price: 30, payment_rail: 'escrow', api_key: 'k_net' })
    ok('P-1 omitted shipping_address → handler injected the FULL default into the API call', lastOrderBody?.shipping_address === FULL_ADDR, JSON.stringify(lastOrderBody).slice(0, 250))
    ok('P-1b injection preserves session_token/expected_price/payment_rail/quantity forwarding', lastOrderBody?.session_token === 'pst_t' && lastOrderBody?.expected_price === 30 && lastOrderBody?.payment_rail === 'escrow' && lastOrderBody?.quantity === 2)
    ok('P-2 tool RESULT carries NO address text (echo stripped, marker present)', !PII.test(JSON.stringify(r)) && String((r as Record<string, unknown>).shipping_address_used || '').includes('default'), JSON.stringify(r).slice(0, 250)) }
  { const r = await mcp.handlePlaceOrder({ product_id: 'prd_x', api_key: 'k_noaddr' })
    ok('P-4 omitted + NO saved default → ADDRESS_REQUIRED (no silent null order)', (r as Record<string, unknown>).error_code === 'ADDRESS_REQUIRED', JSON.stringify(r).slice(0, 200)) }
  { const r = await mcp.handlePlaceOrder({ product_id: 'prd_x', shipping_address: 'explicit addr 1', api_key: 'k_net' })
    ok('P-3 explicit shipping_address unchanged (passes through; echo NOT stripped — agent supplied it)', lastOrderBody?.shipping_address === 'explicit addr 1' && JSON.stringify(r).includes('explicit addr 1'), JSON.stringify(r).slice(0, 200)) }
} finally { server.close() }

// ── sandbox 分支与 network 共用同一纯函数:直测函数 + 源守卫锁调用点(两路径零 drift) ──
{ const v = mcp.maskedDefaultAddressView(FULL_ADDR, 'SG')
  ok('U-1 masked view (has): region + summary, zero text substring, no dead ref marker', v.has_default === true && !('address_ref' in v) && v.address_region === 'SG' && !PII.test(JSON.stringify(v)), JSON.stringify(v)) }
{ const v = mcp.maskedDefaultAddressView(null, null)
  ok('U-2 masked view (none): has_default=false + guidance note', v.has_default === false && typeof v.note === 'string') }
{ const v = mcp.maskedDefaultAddressView('   ', 'SG')
  ok('U-3 whitespace-only text = no default', v.has_default === false) }

const src = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
ok('G-1 source guard: no `address_text: me.default_address_text` passthrough remains', !/address_text:\s*me\.default_address_text/.test(src))
ok('G-2 source guard: SANDBOX read branch also routes through maskedDefaultAddressView', /return maskedDefaultAddressView\(u\?\.default_address_text, u\?\.default_address_region\)/.test(src))
ok('G-3 source guard: tool description states full text is never returned to agents', /FULL address text is NEVER returned to agents/.test(src))
ok('G-4 source guard: no-default → ADDRESS_REQUIRED on both paths (no silent null order)', (src.match(/ADDRESS_REQUIRED/g) || []).length >= 3)
ok('G-5 source guard: place_order schema no longer hard-requires shipping_address', /required: \['product_id'\],/.test(src))

if (fail > 0) { console.error(`\n❌ agent-address-masking FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent-address-masking: agent 面永不见全文地址(default_address read 双路径共用纯函数 + profile view 剥字段)· set/兜底不变\n  ✅ pass ${pass}`)
