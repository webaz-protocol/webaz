/**
 * RFC-022 — Remote MCP endpoint: POST /mcp (Streamable HTTP, stateless).
 *
 * Agent Reachability First:把 stdio MCP 的同一套 38 工具面暴露给无本地运行时的客户端
 * (ChatGPT/Claude 移动端 connector、云 agent、SDK agent)。传输层换了,信任边界不变:
 *   - 匿名 = network_readonly 语义(公开读);
 *   - Authorization: Bearer <api_key> = 等价本地 WEBAZ_API_KEY(args 显式 key 仍优先);
 *   - Iron-Rule 动作照旧硬拒(412 → PWA/Passkey);RISK 订单动作照旧返回 approve_url(RFC-021)。
 *
 * 威胁模型落点(RFC-022 §2):
 *   T3 无状态:每请求新建 Server+Transport,零会话驻留;body 走全局 express.json 100kb 帽。
 *   T6 无 CORS:不发任何 Access-Control-* 头 → 浏览器 JS 读不到跨源响应(v1 面向服务端/App agent)。
 *   T7 硬钉 NETWORK:WEBAZ_MODE=sandbox 时拒绝挂载(远程面永不暴露本机沙盒)。
 *   T8 日志隐私:本模块不打印 args / Authorization。
 * 上线开关:WEBAZ_REMOTE_MCP=1 才挂载(fail-closed)。
 */
import type { Express, Request, Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildMcpServer } from '../../layer1-agent/L1-1-mcp-server/server.js'

export function remoteMcpEnabled(): boolean {
  return process.env.WEBAZ_REMOTE_MCP === '1' && process.env.WEBAZ_MODE !== 'sandbox'
}

// 机器可读的 Remote MCP 公告(单一真相源,两个 well-known 清单共用防漂移)。只在端点真开时返回,
// 让陌生 agent 一次 fetch well-known 就能发现"可连接的 HTTPS MCP 地址 + 匿名/鉴权边界 + 怎么浏览商品"。
export function remoteMcpManifest(): Record<string, unknown> | null {
  if (!remoteMcpEnabled()) return null
  return {
    transport: 'streamable_http',
    endpoint: 'https://webaz.xyz/mcp',
    methods: 'POST (JSON-RPC 2.0); GET/DELETE → 405 (stateless, no session)',
    protocol_version: '2025-03-26',
    status: 'live',
    authentication: {
      anonymous: 'public read-only tools (webaz_info / webaz_search / leaderboard / price-history / open build-tasks)',
      bearer: 'Authorization: Bearer <api_key> → authenticated write tools; RISK actions return approve_url (Passkey in browser)',
    },
    stdio_alternative: 'npx -y @seasonkoh/webaz  (local STDIO transport — same 42-tool surface, for clients that run a local process)',
    sdks: {
      python: 'pip install webaz  →  async with WebAZ() as wz: await wz.browse()  (thin wrapper over this endpoint; anonymous by default, api_key for writes)',
      typescript_stdio: 'npx -y @seasonkoh/webaz  (STDIO MCP server)',
    },
    connect_page: 'https://webaz.xyz/#connect',
    anonymous_quickstart: 'initialize → tools/list → call webaz_search. Browse the catalog: webaz_search with filters (category/sort/max_price) and NO query. Strict exact-title match when you pass query. Machine catalog: https://webaz.xyz/.well-known/webaz-acp-feed.json',
    docs: 'https://webaz.xyz/docs/REMOTE-MCP.md',
  }
}

// deps.rateLimitOk 复用主 server 的进程级 IP 限流器(T2/T3:防公开端点被刷 / 暴力猜 key / DoS)。
export interface RemoteMcpDeps {
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
}

export function registerRemoteMcpRoutes(app: Express, deps: RemoteMcpDeps) {
  if (process.env.WEBAZ_REMOTE_MCP !== '1') return               // fail-closed:默认不挂载
  if (process.env.WEBAZ_MODE === 'sandbox') {                    // T7:远程面 + 沙盒 = 配置错误,拒绝启动该面
    console.error('[mcp-remote] REFUSING to mount: WEBAZ_MODE=sandbox must never be exposed remotely')
    return
  }
  // 公开端点 IP 限流:240/min(4/s)足够正常 agent 会话(initialize+tools/list+多次 tools/call),
  // 又挡住刷量 / 暴力猜 128-bit key。body 体积由全局 express.json 100kb 帽兜(T3)。
  const REMOTE_MCP_RPM = 240
  // 客户端 IP 真相源:webaz.xyz 前置 Cloudflare → CF-Connecting-IP 是 CF 覆盖的真实客户端 IP,经 CF 的流量
  //   不可伪造(CF 重写该头)。CF 后面 req.ip 可能塌缩成 CF 边缘 IP(trust proxy 不含公网 CF 段),故优先取
  //   CF-Connecting-IP(且校验为合法 IP 形态,防任意字符串当桶键),缺失/非法才回退 req.ip(反伪造 socket IP)。
  //   ★残余(Codex round-2 P2,已知并接受):直连 origin(绕过 CF)可伪造该头轮换桶键、规避限流 —— 这是
  //   【DoS 规避,非鉴权/数据风险】(隔离/Passkey/128-bit key 才是主控,暴力破解无论限流都不可行)。彻底闭合 =
  //   开 cf-origin-guard enforce(CF_ORIGIN_GUARD_MODE=enforce + 共享密钥,挡直连 origin)。限流本身只是 CF 边缘
  //   DDoS 之上的第二层纵深。
  const IP_RE = /^[0-9a-fA-F:.]{3,45}$/   // 粗校验 IPv4/IPv6 形态,拒任意字符串桶键
  const clientIp = (req: Request): string => {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim()
    if (cf && IP_RE.test(cf)) return cf
    return req.ip || 'unknown'
  }

  app.post('/mcp', async (req: Request, res: Response) => {
    // 命名空间桶(修 Codex P2):'remote_mcp:' 前缀,与 telemetry/error-report 的裸-IP 桶隔离,不互相消耗
    if (!deps.rateLimitOk('remote_mcp:' + clientIp(req), REMOTE_MCP_RPM, 60_000)) {
      return void res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'rate limited — slow down' }, id: null })
    }
    try {
      const authz = String(req.headers.authorization || '')
      const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : ''
      // RFC-023 PR-4:grant token(gtk_ 直接 grant / oat_ OAuth access token)走 grant 凭证注入,不当 human
      //   api_key —— 它 audience-bound 到 /mcp 的 grant 面,通用工具照旧匿名。human api_key 走 defaultApiKey。
      const isGrantBearer = bearer.startsWith('gtk_') || bearer.startsWith('oat_')
      // 每请求独立装配(SDK 无状态模式的标准形态)— 请求间零共享状态。
      // isolated:true = 凭证隔离(RFC-022 §2 T5):远程只认本请求 bearer,绝不继承宿主 env key / 存储 grant /
      //   pairing 文件;匿名远程 = 真 network_readonly。修 Codex 两个 P0(跨请求越权 + pairing 竞态)。
      const server = buildMcpServer({
        isolated: true,
        ...(bearer && !isGrantBearer ? { defaultApiKey: bearer } : {}),
        ...(isGrantBearer ? { grantBearer: bearer } : {}),
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,        // stateless:不发 session id
        enableJsonResponse: true,             // 纯 JSON 响应(连接器兼容性最大化,不开 SSE)
      })
      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      // T8:不回显内部错误细节,不打印请求内容
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
    }
  })

  // 无状态传输:没有可恢复的服务端流/会话 → GET(SSE 拉流)与 DELETE(关会话)一律 405
  const notAllowed = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless transport — POST only' }, id: null })
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
}
