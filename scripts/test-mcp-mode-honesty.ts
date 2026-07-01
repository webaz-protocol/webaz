#!/usr/bin/env tsx
/**
 * MCP 模式/统计 诚实化守卫 —— 防"无 key = sandbox"与"硬编码真实用户数"这类描述随代码漂移复发。
 * 事实源(代码权威):无 WEBAZ_API_KEY → NETWORK 只读(公共读走 webaz.xyz);仅 WEBAZ_MODE=sandbox 才本机沙盒。
 *   真实用户/规模只由 network_live(实时 /api/protocol-status)反映,不在 MCP 描述里硬编码。
 * Usage: npm run test:mcp-mode-honesty
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const R = (p: string): string => readFileSync(p, 'utf8')

const readme = R('README.md')
const readmeZh = R('README.zh-CN.md')
const mcp = R('src/mcp.ts')
const server = R('src/layer1-agent/L1-1-mcp-server/server.ts')

// README(EN):无 key 是 Network 只读默认,不是 sandbox 默认
ok('README: no-key = Network read-only (default)', /Network read-only \(default/i.test(readme))
ok('README: does NOT claim "Sandbox (default"', !/Sandbox \(default/i.test(readme))
ok('README: sandbox is explicit via WEBAZ_MODE=sandbox', /WEBAZ_MODE=sandbox/.test(readme))

// README(zh-CN):同样口径 —— 无 key = NETWORK 只读默认;sandbox 显式;不再说"零配置=本机沙盒"
ok('README.zh-CN: no-key = NETWORK 只读(默认)', /NETWORK 只读（默认/.test(readmeZh))
ok('README.zh-CN: sandbox explicit via WEBAZ_MODE=sandbox', /WEBAZ_MODE=sandbox/.test(readmeZh))
ok('README.zh-CN: no stale "先离线试玩（SANDBOX，零配置)" section title', !/先离线试玩（SANDBOX/.test(readmeZh))
ok('README.zh-CN: no stale "此时所有数据都在本机沙盒" zero-config claim', !/此时所有数据都在本机沙盒/.test(readmeZh))

// bootstrap 注释:不再说"否则 SANDBOX"
ok('src/mcp.ts: no "否则 SANDBOX" (no-key is network read-only)', !/否则\s*SANDBOX/i.test(mcp))
ok('src/mcp.ts: mentions read-only / 只读 for no-key', /只读|read-only/i.test(mcp))

// server 启动 banner:无 key 说的是 NETWORK read-only(权威行为)
ok('server: no-key banner says NETWORK (read-only)', /NETWORK\s*\(read-only\)|NETWORK(?:.*)?只读/i.test(server))

// webaz_register 运行时提示:进沙盒只能 WEBAZ_MODE=sandbox,不能说"或清空 WEBAZ_API_KEY"(清空仍是 network_readonly)
ok('server: register hint does NOT say clearing the key enters sandbox', !/或清空 WEBAZ_API_KEY/.test(server))

// RFC-003(被 src/mcp.ts 当作现行模式说明引用)+ RFC 索引:必须反映三态,不能停留在"双模 / 未配 key = sandbox fallback"
const rfc = R('docs/rfcs/RFC-003-mcp-network-client.md')
const rfcIndex = R('docs/rfcs/README.md')
ok('RFC-003: corrected to three-mode / no-key read-only (network_readonly)', /network_readonly|NETWORK 只读/.test(rfc))
ok('RFC-003: no stale "未配 api_key → sandbox fallback" trigger', !/未配 api_key[^\n]{0,15}fallback/.test(rfc))
// §3.2 config table drift: no-key must NOT be described as falling back to SANDBOX anywhere
ok('RFC-003: no "fallback SANDBOX" anywhere (incl. §3.2 config table)', !/fallback\s*SANDBOX/i.test(rfc))
ok('RFC-003: no "无=...SANDBOX" no-key→sandbox claim', !/无\s*=\s*[^\n]{0,10}SANDBOX/.test(rfc))
ok('RFC-003: WEBAZ_MODE lists network_readonly (three modes, not network|sandbox only)', /WEBAZ_MODE[^\n]*network_readonly/.test(rfc))
ok('RFC-003: _mode field doc includes network_readonly', /_mode[\s\S]{0,60}network_readonly/.test(rfc))
ok('RFC index: RFC-003 not labeled "dual-mode thin client"', !/dual-mode thin client/.test(rfcIndex))

// network_state:不硬编码 real_users_on_canonical 数字(真值来自 network_live)
ok('server: no hardcoded real_users_on_canonical in network_state', !/real_users_on_canonical:\s*\d/.test(server))
ok('server: disclaimer points to network_live (not an absolute prod≈0 claim)', /network_live/.test(server) && !/真实用户≈0|real users?\s*≈\s*0/i.test(server))

if (fail > 0) { console.error(`\n❌ MCP mode/stats honesty FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ MCP mode/stats honesty: no-key = Network read-only (not sandbox) across README + bootstrap + banner · sandbox is explicit · real user count from live network_live, not hardcoded\n  ✅ pass ${pass}`)
