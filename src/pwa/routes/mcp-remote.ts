/**
 * RFC-022 — Remote MCP endpoint: POST /mcp (Streamable HTTP, stateless).
 *
 * Agent Reachability First:把 stdio MCP 的同一套全量工具面暴露给无本地运行时的客户端
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
import { resolveSurface } from '../../layer1-agent/L1-1-mcp-server/tool-surfaces.js'  // MCP Token PR-3
import { oauthEnabled } from './oauth-discovery.js'
import { OAUTH_SCOPE_CAPABILITIES } from './oauth-approve.js'
import { verifyGrantToken, verifyGrantIdentity } from '../../runtime/agent-grant-verifier.js'
import {
  verifyAgentGatewayDpopRequest,
  verifyAgentGatewayGrantToken,
  type AgentGatewayContext,
  type GatewayReplayStore,
} from '../../runtime/agent-gateway-proof.js'
import { evaluateGatewayLimitsAsync, type AsyncGatewayLimitStore, type GatewayLimitInput } from '../../runtime/gateway-limits.js'
import { buildMcpLimitInput } from '../../runtime/gateway-request-shaping.js'
import { TOOL_ANNOTATIONS } from '../../layer1-agent/L1-1-mcp-server/tool-annotations.js'

export function remoteMcpEnabled(): boolean {
  return process.env.WEBAZ_REMOTE_MCP === '1' && process.env.WEBAZ_MODE !== 'sandbox'
}

// RFC-023 PR-5:/mcp 的 401 挑战指向 RFC 9728 protected-resource metadata(路径后缀形态,对应
// resource=https://webaz.xyz/mcp 的规范推导),合规 MCP 客户端读到它即可自启 OAuth 流。
const PROTECTED_RESOURCE_METADATA_URL = 'https://webaz.xyz/.well-known/oauth-protected-resource/mcp'

// RFC-023 PR-5:401 OAuth 挑战名单 —— 挑战即承诺(Codex P1):只列【OAuth 完流后重试真能走通】的工具。
// oat_ 在 /mcp 只作为 grant 凭证注入(PR-4),永远不是 human api_key,所以入列条件 = 该工具有 grant 路径
// (resolveGrantCredential → requireAgentGrantScope 端点),oat_ 重试 = 成功或 scope 级 PERMISSION_REQUIRED
// (结构化、可恢复)。api_key-only 工具(place_order/update_order/wallet/notifications/default_address)
// 【绝不入列】—— oat_ 满足不了它们,401 广告 OAuth = 虚假恢复路径;双模工具(匿名读+鉴权写,如
// webaz_search / webaz_contribute / webaz_profile)与匿名返回引导文案的工具(webaz_mykey /
// webaz_rotate_key / webaz_revoke_key / webaz_pair)照旧绝不入列(I-2 匿名读不变是硬不变量)。
// 漏列 fail-soft:未列出的鉴权工具照旧走工具层的 API_KEY_REQUIRED / GRANT_REQUIRED 带引导 JSON。
const AUTH_ONLY_TOOLS = new Set([
  'webaz_list_product', 'webaz_get_agent_order', 'webaz_order_action_request', 'webaz_connection_status',
  'webaz_buyer_orders',   // RFC-025 PR-1 (grant path: GET /api/agent/buyer/orders(/:id))
  'webaz_discover',       // RFC-025 PR-2 (grant path: POST /api/agent/discover)
  'webaz_quote_order',    // RFC-025 PR-3 (grant path: POST /api/agent/quote)
  'webaz_order_draft',    // RFC-025 PR-4 (grant path: /api/agent/order-draft(s))
  'webaz_submit_order_request',   // RFC-025 PR-5a (grant path: POST /api/agent/order-drafts/:id/submit)
  'webaz_prepare_case',           // RFC-025 PR-6 (grant path: GET /api/agent/buyer/orders/:id/case-draft)
  'webaz_approval_requests',      // RFC-026 PR-2 (grant path: GET /api/agent/approval-requests(/:id))
  'webaz_wallet_view',            // RFC-026 PR-3 (grant path: GET /api/agent/wallet; read-only forever)
  'webaz_order_chat',             // RFC-026 PR-4 (grant path: /api/agent/orders/:id/chat)
  'webaz_address',                // RFC-026 PR-5 (grant path: /api/agent/address/*)
  'webaz_buyer_action_request',   // RFC-026 PR-6 (grant path: POST /api/agent/orders/:id/buyer-action-request)
])
// webaz_list_product 是多 action 工具:只有 grant 路径真支持的 action 才配挑战(承诺即真实)。
//   mine → seller_products_read;create/draft(缺省即 create)→ seller_product_draft —— 均可由 OAuth scope 铸出。
//   update/delist/publish/delete = api_key-only(GRANT_WRITE_NOT_ENABLED),oat_ 满足不了 → 不挑战,
//   照旧落工具层 api_key 引导。get_agent_order / order_action_request 单 capability,整工具可挑战。
const LIST_PRODUCT_GRANT_ACTIONS = new Set(['mine', 'create', 'draft'])
function isAuthOnlyToolCall(body: unknown): boolean {
  const b = body as { method?: unknown; params?: { name?: unknown; arguments?: { action?: unknown } } } | null
  if (!b || b.method !== 'tools/call' || typeof b.params?.name !== 'string') return false
  const name = b.params.name
  if (name === 'webaz_list_product') {
    const action = typeof b.params.arguments?.action === 'string' ? b.params.arguments.action : 'create'  // 缺省 create
    return LIST_PRODUCT_GRANT_ACTIONS.has(action)
  }
  return AUTH_ONLY_TOOLS.has(name)
}

// The exact SAFE grant scope each auth-only tool CALL requires — MUST match the requireAgentGrantScope
// mounts in agent-grants.ts so the edge's 401-vs-403 split agrees with the tool layer. Used only to
// tell an INVALID token (401, re-auth) apart from a valid token that merely lacks this scope (403).
// A presented oat_ is validated only on tools/call (any tool) — NOT on initialize/tools/list, which are
// anonymous handshake/discovery and must stay reachable during a client's setup phase.
function isToolCall(body: unknown): boolean {
  return (body as { method?: unknown } | null)?.method === 'tools/call'
}
function scopeForAuthOnlyCall(body: unknown): string {
  const b = body as { params?: { name?: unknown; arguments?: { action?: unknown } } } | null
  const name = b?.params?.name
  if (name === 'webaz_get_agent_order') return 'seller_orders_read_minimal'         // GET /api/agent/orders(/:id)
  if (name === 'webaz_buyer_orders') return 'buyer_orders_read_minimal'              // GET /api/agent/buyer/orders(/:id)
  if (name === 'webaz_discover') return 'buyer_discover'                              // POST /api/agent/discover
  if (name === 'webaz_quote_order') return 'price_quote'                              // POST /api/agent/quote
  if (name === 'webaz_order_draft') return 'draft_order'                              // /api/agent/order-draft(s)
  if (name === 'webaz_submit_order_request') return 'order_submit_request'            // POST /api/agent/order-drafts/:id/submit
  if (name === 'webaz_prepare_case') return 'buyer_case_prepare'                      // GET /api/agent/buyer/orders/:id/case-draft
  if (name === 'webaz_approval_requests') return 'approval_requests_read'             // GET /api/agent/approval-requests(/:id)
  if (name === 'webaz_wallet_view') return 'wallet_read_minimal'                      // GET /api/agent/wallet
  if (name === 'webaz_order_chat') return 'order_chat_read'                           // /api/agent/orders/:id/chat(send 由路由细分 order_chat_send)
  if (name === 'webaz_address') return 'address_read_masked'                          // /api/agent/address/*(change 由路由细分 address_change_request)
  if (name === 'webaz_buyer_action_request') return 'buyer_action_request'            // POST /api/agent/orders/:id/buyer-action-request
  if (name === 'webaz_connection_status') return 'read_public'                       // GET /api/agent-grants/connection
  if (name === 'webaz_order_action_request') return 'order_action_request'           // POST /api/agent/orders/:id/action-request
  if (name === 'webaz_list_product') {
    const action = typeof b?.params?.arguments?.action === 'string' ? b.params.arguments.action : 'create'  // default create
    return action === 'mine' ? 'seller_products_read' : 'seller_product_draft'        // GET vs POST /api/agent/seller/products
  }
  return ''
}

// Reverse of OAUTH_SCOPE_CAPABILITIES: a fine grant capability → the COARSE OAuth scope a client requests
// at /oauth/authorize. An insufficient_scope challenge shown to ChatGPT MUST name the coarse scope
// (OAUTH_SCOPES: read / order:draft / list:draft) — naming a fine capability would make ChatGPT request a
// scope the authorize endpoint rejects with invalid_scope. Enforcement still keys off the FINE capability
// (scopeForAuthOnlyCall → verifyGrantToken); this reverse map is for the challenge's `scope=` param only.
const FINE_TO_COARSE_SCOPE: Record<string, string> = Object.fromEntries(
  Object.entries(OAUTH_SCOPE_CAPABILITIES).flatMap(([coarse, caps]) => caps.map(c => [c, coarse])),
)
function coarseScopeForAuthOnlyCall(body: unknown): string {
  return FINE_TO_COARSE_SCOPE[scopeForAuthOnlyCall(body)] ?? ''
}

// MCP Streamable HTTP transport MUST validate Origin (DNS-rebinding defense, MCP spec). A request with
// NO Origin header (server-to-server / non-browser agent) is allowed; a PRESENT Origin must EXACT-match
// the allowlist — no wildcard, no suffix-contains, no forgeable substring — else 403. Minimal WebAZ +
// OpenAI set, extendable via WEBAZ_MCP_ALLOWED_ORIGINS (comma-separated). This is transport Origin
// validation only — it adds no Access-Control-* header and does not touch the no-CORS posture (T6).
const DEFAULT_MCP_ALLOWED_ORIGINS = ['https://webaz.xyz', 'https://chatgpt.com', 'https://chat.openai.com']
// A well-formed http(s) Origin is EXACTLY `scheme://host[:port]` — no path/query/fragment/trailing slash
// (`new URL(s).origin === s`). Configured entries are validated so a malformed value like "not-a-url"
// can never enter the allowlist (and thus can never match a malformed incoming Origin).
function isWellFormedOrigin(s: string): boolean {
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s } catch { return false }
}
function mcpAllowedOrigins(): Set<string> {
  const extra = String(process.env.WEBAZ_MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(isWellFormedOrigin)
  return new Set([...DEFAULT_MCP_ALLOWED_ORIGINS, ...extra])
}
function mcpOriginAllowed(req: Request): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true                 // no Origin = server-to-server / non-browser → allow
  if (typeof origin !== 'string') return false          // duplicate/array Origin header → reject
  return mcpAllowedOrigins().has(origin)                 // exact match only (malformed → not in set → reject)
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
      // RFC-023 PR-5:OAuth 面仅在 WEBAZ_OAUTH=1 时披露(fail-closed:关着时 metadata/端点 404,不广告)。
      ...(oauthEnabled() ? {
        oauth: {
          flow: 'OAuth 2.1 authorization_code + PKCE(S256) — Connect without pasting an api_key: log in with Passkey, approve SAFE scopes, get a short-lived audience-bound token. RISK actions still return approve_url (human gate unchanged).',
          protected_resource_metadata: PROTECTED_RESOURCE_METADATA_URL,
          authorization_server_metadata: 'https://webaz.xyz/.well-known/oauth-authorization-server',
        },
      } : {}),
    },
    stdio_alternative: 'npx -y @seasonkoh/webaz  (local STDIO transport — same full tool surface, for clients that run a local process)',
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
  gatewayReplayStore?: GatewayReplayStore
  gatewayLoopbackBaseUrl?: () => string
  gatewayLimitStore?: AsyncGatewayLimitStore   // RFC-028 S2b: authoritative distributed limiter (shadow-mode only for now)
}

/**
 * RFC-028 S2b-2b — shadow-mode multi-dimensional limit OBSERVATION. Evaluates the authoritative distributed
 * limiter for this request against real traffic and LOGS what it WOULD have decided. It NEVER blocks, awaits
 * in the response path, mutates `res`, or changes control flow — it is called fire-and-forget, so a slow or
 * down limiter database cannot stall /mcp. Active only when a limit store is configured AND
 * WEBAZ_AGENT_GATEWAY_LIMITS_MODE=shadow; otherwise a pure no-op. Enforcement (deny) is a later slice.
 *
 * First slice observes the IP + per-class global budgets only (the primary availability surface); client and
 * subject dimensions are added when identity extraction is wired. Only would-be DENIALS are logged, without
 * the raw dimension values (the limiter key is already a hash).
 */
export function observeGatewayLimitsShadow(store: AsyncGatewayLimitStore | undefined, body: unknown, ip: string): void {
  if (!store || process.env.WEBAZ_AGENT_GATEWAY_LIMITS_MODE !== 'shadow') return
  let input: GatewayLimitInput
  try {
    const b = body as { method?: unknown; params?: { name?: unknown } } | null
    const method = typeof b?.method === 'string' ? b.method : ''
    const toolName = method === 'tools/call' && typeof b?.params?.name === 'string' ? b.params.name : undefined
    const annotation = toolName ? TOOL_ANNOTATIONS[toolName] : undefined
    input = buildMcpLimitInput({ method, toolName, annotation, ip })
  } catch { return }   // extraction must NEVER affect the request
  // Fire-and-forget: not awaited. .catch() guards unhandledRejection; in shadow a store outage is silently
  // ignored (it would only ever have logged). The hits still increment the authoritative counters so the
  // shadow data reflects real load before enforcement is turned on.
  // ★SAFETY PIN: this call sits OUTSIDE the try/catch above. That is safe ONLY because
  // evaluateGatewayLimitsAsync is `async` — a synchronous throw before its first await (planGatewayLimitChecks
  // / the store.hit map) becomes a REJECTED promise caught by .catch() below, not a sync throw into /mcp. Do
  // NOT convert it to a non-async function that can throw synchronously without also wrapping this in try/catch.
  void evaluateGatewayLimitsAsync(input, store, Date.now())
    .then(d => { if (!d.allowed) console.warn(`[agent-gateway-limits] shadow would-deny class=${input.cost_class} dim=${d.denied_dimension} retry_after=${d.retry_after_sec}s`) })
    .catch(() => undefined)
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

  // OpenAI Apps SDK auth-challenge shape (RFC-023 PR-4). When a tools/call is presented WITHOUT adequate
  // authorization, ChatGPT expects a tools/call RESULT at HTTP 200 whose result._meta["mcp/www_authenticate"]
  // carries the RFC 6750 challenge (an array of challenge strings, each with BOTH error and error_description),
  // together with isError:true — NOT an HTTP 401/403 with a WWW-Authenticate header. ChatGPT reads the
  // challenge from the result body and only pops the OAuth / scope-expansion UI when this runtime signal is
  // present AND the tool declares securitySchemes (both halves required; see OpenAI Authentication docs).
  //   Design note: this REPLACES the earlier RFC 9728 HTTP 401/403 shape for tool-call auth failures (the
  //   north star is native ChatGPT client integration). Connection-time OAuth still works via the .well-known
  //   discovery documents. Origin (DNS-rebinding) rejection stays a hard 403 — it is a transport guard, not an
  //   auth challenge. The challenge is also mirrored to a WWW-Authenticate header for parity/diagnostics.
  const authChallengeResult = (res: Response, id: number | string | null, humanText: string, challenge: string): void => {
    // WWW-Authenticate is an HTTP header → MUST be ASCII (res.setHeader throws on non-ASCII, e.g. an em-dash).
    // Normalize once and use the SAME value for the header and result._meta[0] so they stay byte-identical.
    const asciiChallenge = challenge.replace(/[^\x20-\x7E]/g, '-')
    res.setHeader('WWW-Authenticate', asciiChallenge)
    res.status(200).json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: humanText }],
        isError: true,
        _meta: { 'mcp/www_authenticate': [asciiChallenge] },
      },
    })
  }

  app.post('/mcp', async (req: Request, res: Response) => {
    // 命名空间桶(修 Codex P2):'remote_mcp:' 前缀,与 telemetry/error-report 的裸-IP 桶隔离,不互相消耗
    if (!deps.rateLimitOk('remote_mcp:' + clientIp(req), REMOTE_MCP_RPM, 60_000)) {
      return void res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'rate limited — slow down' }, id: null })
    }
    // MCP transport Origin validation (DNS-rebinding). Applies uniformly to initialize/tools/list/
    // tools/call (all POST /mcp). No Origin (server-to-server) passes; a non-allowlisted/malformed
    // Origin is rejected before any body processing.
    if (!mcpOriginAllowed(req)) {
      return void res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'forbidden origin — /mcp accepts requests with no browser Origin or an allowlisted Origin only' }, id: null })
    }
    // RFC-028 S2b-2b: shadow-mode limit observation — log-only, fire-and-forget, never blocks or mutates res.
    observeGatewayLimitsShadow(deps.gatewayLimitStore, req.body, clientIp(req))
    try {
      const authz = String(req.headers.authorization || '')
      const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : ''
      const authorizationHeaders: string[] = []
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === 'authorization') authorizationHeaders.push(req.rawHeaders[i + 1] ?? '')
      }
      const dpopMatch = /^DPoP ([^\s]+)$/i.exec(authz)
      const dpopBearer = dpopMatch?.[1] ?? ''
      const credential = dpopBearer || bearer
      // RFC-023 PR-5:匿名调用注定需要身份的工具 → 401 + WWW-Authenticate 指回 protected-resource
      //   metadata,合规 MCP 客户端据此自启 OAuth 流(MCP Authorization spec)。仅 WEBAZ_OAUTH=1 时
      //   挑战(关着时 metadata 404,不能把客户端指向不存在的文档);带任何 Bearer 的请求照旧进工具层
      //   (无效凭证的语义化 error_code 在那里,PR-4)。匿名【读】面完全不受影响(I-2)。
      const bodyId = (req.body as { id?: number | string | null } | null)?.id ?? null
      let gatewayContext: AgentGatewayContext | undefined
      if (oauthEnabled() && dpopBearer && isToolCall(req.body)) {
        // RFC-9449 sender-constrained access uses the DPoP authorization scheme. Ordinary ChatGPT OAuth
        // continues to use Bearer and never enters this branch. DPoP is independently default-off.
        if (authorizationHeaders.length !== 1) {
          res.setHeader('WWW-Authenticate', 'DPoP error="invalid_token", error_description="exactly one DPoP Authorization header is required"')
          return void res.status(401).json({ jsonrpc: '2.0', id: bodyId, error: { code: -32001, message: 'invalid DPoP authorization' } })
        }
        if (process.env.WEBAZ_AGENT_GATEWAY_DPOP_RESOURCE !== '1') {
          res.setHeader('WWW-Authenticate', 'DPoP error="invalid_token", error_description="DPoP protected-resource access is not enabled"')
          return void res.status(401).json({ jsonrpc: '2.0', id: bodyId, error: { code: -32001, message: 'DPoP protected-resource access is not enabled' } })
        }
        if (!deps.gatewayReplayStore || !deps.gatewayLoopbackBaseUrl) {
          return void res.status(503).json({ jsonrpc: '2.0', id: bodyId, error: { code: -32003, message: 'sender-constrained proof verification is unavailable' } })
        }
        const dpopHeaders: string[] = []
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i]?.toLowerCase() === 'dpop') dpopHeaders.push(req.rawHeaders[i + 1] ?? '')
        }
        if (dpopHeaders.length !== 1 || !dpopHeaders[0]) {
          res.setHeader('WWW-Authenticate', 'DPoP error="invalid_dpop_proof", error_description="exactly one non-empty DPoP proof is required"')
          return void res.status(401).json({ jsonrpc: '2.0', id: bodyId, error: { code: -32001, message: 'invalid DPoP proof' } })
        }
        const verified = await verifyAgentGatewayDpopRequest({
          access_token: dpopBearer,
          dpop_proof: dpopHeaders[0],
          http_method: 'POST',
          target_uri: 'https://webaz.xyz/mcp',
        }, deps.gatewayReplayStore)
        if (!verified.ok) {
          const status = verified.status === 409 ? 409 : verified.status === 503 ? 503 : verified.status === 403 ? 403 : 401
          res.setHeader('WWW-Authenticate', 'DPoP error="invalid_dpop_proof", error_description="sender-constrained proof validation failed"')
          return void res.status(status).json({ jsonrpc: '2.0', id: bodyId, error: { code: -32001, message: 'sender-constrained proof validation failed' } })
        }
        gatewayContext = verified.context
        if (isAuthOnlyToolCall(req.body)) {
          const requiredScope = scopeForAuthOnlyCall(req.body)
          const scoped = await verifyAgentGatewayGrantToken(gatewayContext, dpopBearer, requiredScope)
          if (!scoped.ok) {
            if (scoped.error_code === 'SCOPE_NOT_GRANTED') {
              const coarseScope = coarseScopeForAuthOnlyCall(req.body)
              const challenge = `DPoP resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", error="insufficient_scope", error_description="your OAuth grant does not carry the ${coarseScope} scope this tool needs", scope="${coarseScope}"`
              return void authChallengeResult(res, bodyId, `insufficient scope — your OAuth grant does not carry the "${coarseScope}" scope this tool needs.`, challenge)
            }
            res.setHeader('WWW-Authenticate', 'DPoP error="invalid_token", error_description="sender-constrained token is no longer active"')
            return void res.status(scoped.status).json({ jsonrpc: '2.0', id: bodyId, error: { code: -32001, message: 'sender-constrained token is no longer active' } })
          }
        }
      } else if (oauthEnabled() && bearer.startsWith('oat_') && isToolCall(req.body)) {
        // A PRESENTED oat_ is validated at the transport edge — a bad credential is NEVER silently
        // downgraded to anonymous. Identity is checked for ANY tool (invalid/expired/revoked/wrong-aud →
        // invalid_token challenge); for an auth-only tool call the required safe scope is also checked (valid
        // token, missing scope → insufficient_scope scope-EXPANSION, not re-login). Both are returned via
        // authChallengeResult (HTTP 200 + result._meta["mcp/www_authenticate"] + isError, the OpenAI shape).
        // Only oat_ is edge-validated — api_key and gtk_ semantics are untouched (fall through to dispatch).
        const authOnly = isAuthOnlyToolCall(req.body)
        const requiredScope = authOnly ? scopeForAuthOnlyCall(req.body) : ''
        const gv = authOnly ? await verifyGrantToken(bearer, requiredScope) : await verifyGrantIdentity(bearer)
        if (!gv.ok) {
          if (gv.error_code === 'SCOPE_NOT_GRANTED') {
            // Valid identity, missing THIS tool's scope → insufficient_scope challenge: ChatGPT opens the
            // scope-EXPANSION UI, not a fresh login. Returned as a 200 result._meta (see authChallengeResult).
            // The challenge names the COARSE OAuth scope the client requests at authorize (coarseScope),
            // NOT the fine capability enforced above (requiredScope) — a fine name would be invalid_scope.
            const coarseScope = coarseScopeForAuthOnlyCall(req.body)
            const challenge = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", error="insufficient_scope", error_description="your OAuth grant does not carry the ${coarseScope} scope this tool needs; request it (webaz_pair action=request), have the human approve, then retry - no re-login needed", scope="${coarseScope}"`
            return void authChallengeResult(res, bodyId, `insufficient scope — your OAuth grant does not carry the "${coarseScope}" scope this tool needs. Request it (webaz_pair action="request"), have the human approve, then retry. No re-login needed.`, challenge)
          }
          // Invalid / expired / revoked / wrong-audience / inactive token → invalid_token challenge (re-auth).
          const challenge = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", error="invalid_token", error_description="your OAuth token is invalid, expired, revoked, or not scoped to this resource; reconnect via OAuth"`
          return void authChallengeResult(res, bodyId, 'authentication required — your OAuth token is invalid, expired, revoked, or not scoped to this resource. Reconnect via OAuth.', challenge)
        }
        // gv.ok → valid oat_ (identity ok; scope ok when auth-only) → fall through to dispatch.
      } else if (oauthEnabled() && !bearer && isAuthOnlyToolCall(req.body)) {
        // Anonymous call to an account-scoped tool → invalid_token challenge (I-1). Anonymous reads (I-2) untouched.
        const challenge = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", error="invalid_token", error_description="authentication required - this tool acts as an account; connect via OAuth or send Authorization: Bearer api_key"`
        return void authChallengeResult(res, bodyId, 'authentication required — this tool acts as an account. Connect via OAuth, or send Authorization: Bearer <api_key>.', challenge)
      }
      // gtk_ / api_key / anonymous-public → fall through to dispatch (unchanged).
      // RFC-023 PR-4:grant token(gtk_ 直接 grant / oat_ OAuth access token)走 grant 凭证注入,不当 human
      //   api_key —— 它 audience-bound 到 /mcp 的 grant 面,通用工具照旧匿名。human api_key 走 defaultApiKey。
      const isGrantBearer = credential.startsWith('gtk_') || credential.startsWith('oat_')
      // 每请求独立装配(SDK 无状态模式的标准形态)— 请求间零共享状态。
      // isolated:true = 凭证隔离(RFC-022 §2 T5):远程只认本请求 bearer,绝不继承宿主 env key / 存储 grant /
      //   pairing 文件;匿名远程 = 真 network_readonly。修 Codex 两个 P0(跨请求越权 + pairing 竞态)。
      // MCP Token PR-3:工具面选择 —— ?surface=buyer|seller|full 显式 > api_key bearer(full)> 默认 buyer。
      //   只影响 tools/list 可见性(定义 ~101KB→buyer ~40KB);按名 tools/call 一切照旧(授权在 call 时)。
      const surface = resolveSurface(req.query.surface, credential ? (isGrantBearer ? 'grant' : 'api_key') : 'none')
      const server = buildMcpServer({
        isolated: true,
        surface,
        ...(bearer && !isGrantBearer ? { defaultApiKey: bearer } : {}),
        ...(isGrantBearer ? { grantBearer: credential } : {}),
        ...(gatewayContext ? {
          agentGatewayContext: gatewayContext,
          gatewayLoopbackBaseUrl: deps.gatewayLoopbackBaseUrl!(),
        } : {}),
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

  // 无状态传输:GET(SSE 拉流)与 DELETE(关会话)一律 405。Origin 校验对所有方法一致(MCP: all incoming
  // connections)—— 不可信 Origin 在 405 之前先 403(DNS-rebinding 防护适用于每个 /mcp 入口)。
  const notAllowed = (req: Request, res: Response): void => {
    if (!mcpOriginAllowed(req)) {
      return void res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'forbidden origin — /mcp accepts requests with no browser Origin or an allowlisted Origin only' }, id: null })
    }
    return void res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless transport — POST only' }, id: null })
  }
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
}
