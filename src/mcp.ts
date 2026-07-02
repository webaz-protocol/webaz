#!/usr/bin/env node
/**
 * MCP Server 入口 — WebAZ 的 agent 入口
 *
 * 运行:npm run mcp(或 npx @seasonkoh/webaz);通过 stdio 与 Claude 等 MCP 客户端通信。
 * 工具实现都在 src/layer1-agent/L1-1-mcp-server/server.ts(本文件只是 bootstrap)。
 * 模式:配 WEBAZ_API_KEY → NETWORK(可交易,调 webaz.xyz 共享网络);无 key → NETWORK 只读(公共读走 webaz.xyz);
 *   仅 WEBAZ_MODE=sandbox 才用本机库(与全网隔离,dev/demo)。默认【不是】sandbox。详见 RFC-003。
 *
 * 关联 / Related: AGENTS.md(项目地图) · RFC-003(三态:network / network_readonly / sandbox) · RFC-004(webaz_feedback)
 */
// ⚠️ 只【静态】import cli.js(纯:version + network-mode,无副作用)。【不】静态 import server.js ——
//   server.js 顶层会 initDatabase()/建 schema,静态 import 会让 --version/--help/--mode 也触发 DB 副作用
//   (写 ~/.webaz/*.db)+ 加载整个 server(#186 审计 P1)。故 server.js 只在真正启动时【动态】import。
import { cliQuickResponse, runDoctor } from './layer1-agent/L1-1-mcp-server/cli.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const quick = cliQuickResponse(argv, process.env)   // --version / --help / --mode(纯,不碰 DB/server)
  if (quick !== null) { console.log(quick); process.exit(0) }
  if (argv.includes('--doctor')) { console.log(await runDoctor(process.env)); process.exit(0) }
  // 只有真正启动 stdio server 时才动态加载 server.js(此时才允许 DB 初始化等副作用)。
  const { startMCPServer } = await import('./layer1-agent/L1-1-mcp-server/server.js')
  await startMCPServer()
}

main().catch((err) => {
  console.error('MCP Server 启动失败：', err)
  process.exit(1)
})
