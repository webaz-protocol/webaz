#!/usr/bin/env node
/**
 * MCP Server 入口 — WebAZ 的 agent 入口
 *
 * 运行:npm run mcp(或 npx @seasonkoh/webaz);通过 stdio 与 Claude 等 MCP 客户端通信。
 * 工具实现都在 src/layer1-agent/L1-1-mcp-server/server.ts(本文件只是 bootstrap)。
 * 模式:配 WEBAZ_API_KEY → NETWORK(可交易,调 webaz.xyz 共享网络);无 key → NETWORK 只读(公共读走 webaz.xyz);
 *   仅 WEBAZ_MODE=sandbox 才用本机库(与全网隔离,dev/demo)。默认【不是】sandbox。详见 RFC-003。
 *
 * 关联 / Related: AGENTS.md(项目地图) · RFC-003(双模) · RFC-004(webaz_feedback)
 */
import { startMCPServer } from './layer1-agent/L1-1-mcp-server/server.js'

startMCPServer().catch((err) => {
  console.error('MCP Server 启动失败：', err)
  process.exit(1)
})
