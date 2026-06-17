#!/usr/bin/env node
/**
 * MCP Server 入口 — WebAZ 的 agent 入口
 *
 * 运行:npm run mcp(或 npx @seasonkoh/webaz);通过 stdio 与 Claude 等 MCP 客户端通信。
 * 工具实现都在 src/layer1-agent/L1-1-mcp-server/server.ts(本文件只是 bootstrap)。
 * 双模:配 WEBAZ_API_KEY → NETWORK(调 webaz.xyz 共享网络);否则 SANDBOX(本机库)。详见 RFC-003。
 *
 * 关联 / Related: AGENTS.md(项目地图) · RFC-003(双模) · RFC-004(webaz_feedback)
 */
import { startMCPServer } from './layer1-agent/L1-1-mcp-server/server.js'

startMCPServer().catch((err) => {
  console.error('MCP Server 启动失败：', err)
  process.exit(1)
})
