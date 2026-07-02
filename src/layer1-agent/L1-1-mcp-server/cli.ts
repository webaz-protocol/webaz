/**
 * MCP 命令行标志(--version / --help / --mode / --doctor)。
 *
 * 目的:让人 / 陌生 agent 在【不启动 stdio server】的前提下验证安装、看清运行模式与真网络可达性。
 * 无标志 → cliQuickResponse 返回 null,mcp.ts 照常启动 server(既有 MCP 客户端从不传 argv → 零破坏)。
 * 模式判定复用 resolveMode(network-mode.ts)—— 与 server.ts 同一真相源,--mode/--doctor 报的就是 server 实际用的。
 */
import { SOFTWARE_VERSION } from '../../version.js'
import { resolveMode } from './network-mode.js'

const HELP = `webaz — WebAZ MCP server (@seasonkoh/webaz)

Usage:
  npx @seasonkoh/webaz            start the MCP stdio server (what MCP clients invoke)
  npx @seasonkoh/webaz --version  print version and exit
  npx @seasonkoh/webaz --mode     print the resolved run mode and exit
  npx @seasonkoh/webaz --doctor   print mode + config + live-network reachability, then exit
  npx @seasonkoh/webaz --help     show this help

Modes (RFC-003):
  network            WEBAZ_API_KEY set — can transact on the live webaz.xyz network
  network_readonly   no key (DEFAULT) — public reads hit live webaz.xyz; transactions need a key
  sandbox            explicit WEBAZ_MODE=sandbox — local SQLite, isolated from the live network

Env:
  WEBAZ_API_KEY   your api_key (get one at https://webaz.xyz/#welcome). Set → network mode.
  WEBAZ_MODE      force a mode: network | network_readonly | sandbox (sandbox is opt-in only)
  WEBAZ_API_URL   network endpoint (default https://webaz.xyz)`

/** 同步、纯:处理 --version/-v · --help/-h · --mode。命中 → 返回要打印的字符串;无这些标志 → null(mcp.ts 照常启动 server)。 */
export function cliQuickResponse(argv: string[], env: { WEBAZ_MODE?: string; WEBAZ_API_KEY?: string }): string | null {
  const has = (...names: string[]): boolean => names.some(n => argv.includes(n))
  if (has('--version', '-v')) return SOFTWARE_VERSION
  if (has('--help', '-h')) return HELP
  if (has('--mode')) return resolveMode(env)
  return null
}

export interface DoctorEnv { WEBAZ_MODE?: string; WEBAZ_API_KEY?: string; WEBAZ_API_URL?: string }
/** --doctor:模式 + 配置 + 真网络可达性。fetch 可注入便于测试;5s 超时保护,绝不 hang。sandbox 不探网络。 */
export async function runDoctor(env: DoctorEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  const mode = resolveMode(env)
  const url = (env.WEBAZ_API_URL ?? 'https://webaz.xyz').replace(/\/+$/, '')
  const hasKey = !!(env.WEBAZ_API_KEY ?? '')
  const lines = [
    `webaz doctor — @seasonkoh/webaz v${SOFTWARE_VERSION}`,
    `  mode:          ${mode}`,
    `  api_key:       ${hasKey ? 'set (network transactions enabled)' : 'not set (network read-only; set WEBAZ_API_KEY to transact)'}`,
    `  api_url:       ${url}`,
  ]
  if (mode === 'sandbox') {
    lines.push('  reachability:  skipped (sandbox = local SQLite, isolated from the live network)')
    return lines.join('\n')
  }
  let reach: string
  try {
    const r = await fetchImpl(`${url}/api/protocol-status`, { signal: AbortSignal.timeout(5000) })
    reach = r.ok ? `ok (${url} reachable, HTTP ${r.status})` : `degraded (HTTP ${r.status})`
  } catch (e) {
    reach = `unreachable (${(e as Error).message})`
  }
  lines.push(`  reachability:  ${reach}`)
  return lines.join('\n')
}
