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
import { startMCPServer } from './layer1-agent/L1-1-mcp-server/server.js'
import { cliQuickResponse, runDoctor } from './layer1-agent/L1-1-mcp-server/cli.js'

// CLI 标志(--version/--help/--mode/--doctor)在【启动 server 前】处理并退出;无标志 → 照常启动 stdio server。
// 既有 MCP 客户端从不传 argv,故 no-arg 行为完全不变。
const argv = process.argv.slice(2)
const quick = cliQuickResponse(argv, process.env)
if (quick !== null) {
  console.log(quick)
  process.exit(0)
} else if (argv.includes('--doctor')) {
  runDoctor(process.env).then((out) => { console.log(out); process.exit(0) }).catch((err) => { console.error(err); process.exit(1) })
} else {
  startMCPServer().catch((err) => {
    console.error('MCP Server 启动失败：', err)
    process.exit(1)
  })
}
