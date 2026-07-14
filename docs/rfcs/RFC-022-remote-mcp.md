# RFC-022: Remote MCP Endpoint — `/mcp` over Streamable HTTP

- Status: **Draft**
- Author: Holden (+ Claude)
- Created: 2026-07-14
- Depends on: RFC-003 (MCP dual-mode), RFC-011 (agent-native integration contract), RFC-020/021 (approve-to-execute)

## 1. Motivation / 动机

The WebAZ MCP server ships as an npm package over **STDIO only** (`npx -y @seasonkoh/webaz`). Every client without a local process runtime — ChatGPT (web/mobile connectors), Claude mobile, cloud agents, serverless agents — **cannot reach WebAZ at all**, even though all 38 tools, the discovery surfaces (`/.well-known/*`) and the approve-to-execute human gate already exist.

Field evidence (2026-07-14): a user asked ChatGPT's mobile app to buy a phone stand on WebAZ. It failed — not because WebAZ lacks agent-native capability, but because the capability is locked behind a local transport.

One endpoint closes the gap: **`https://webaz.xyz/mcp`** speaking the official MCP Streamable HTTP transport, serving the same tool implementations.

**Principle 0 — Agent Reachability First.** The failure observed was not capability but *reachability*: the agent knew WebAZ, knew MCP, knew which tool to call — and had no way to connect. Accordingly this RFC's acceptance bar is reachability-shaped: *a third-party agent that has never seen WebAZ connects and completes a real product search in its first conversation, with no human assistance* (see §5).

**Positioning: Browser = Trust Anchor.** The browser is neither first nor last — it is the confirmation terminal. Agent does search/compare/prepare; browser does Passkey/approve/governance/dispute. This is already how RFC-020/021 work; the remote endpoint changes the transport, not the trust boundary.

中文摘要:MCP 目前只有 STDIO 形态,手机/云端 agent 无本地运行时接不上。挂一个官方 Streamable HTTP 传输的 `/mcp` 端点,复用同一套 38 工具实现,即打通 ChatGPT/Claude 移动端与一切云 agent。

## 2. Threat model first / 威胁模型(先于设计)

| # | Threat | Mitigation |
|---|--------|------------|
| T1 | api_key theft in transit | HTTPS only (Railway + CF); `Authorization` header value never logged (log key prefix at most, reusing existing redaction conventions) |
| T2 | key brute-force via public endpoint | keys are 128-bit (guessing infeasible); still rate-limit per IP and count auth failures into the existing anti-abuse thresholds |
| T3 | resource exhaustion (agents hammering) | per-IP anonymous cap + per-key cap via existing `rate-limit.ts`; JSON body size cap; **stateless** transport (no server-held sessions to leak); request timeout |
| T4 | SSRF / request smuggling | no user-controlled URLs: tool backends call the canonical REST base (`WEBAZ_API_URL`, const at boot); remote mode never accepts a base override from the request |
| T5 | privilege escalation vs stdio surface | tool surface is byte-identical to the stdio server; Iron-Rule actions keep their hard-reject (412 `HUMAN_PRESENCE_REQUIRED` → PWA/Passkey); RISK order actions keep returning `approve_url` (RFC-021). The bearer key only substitutes the *default* `api_key` — exactly what `WEBAZ_API_KEY` does locally |
| T6 | browser-origin abuse (rebinding/XSS-driven calls) | **no CORS headers emitted** in v1 → browsers cannot read cross-origin responses; endpoint is for server/app agents. Explicit non-goal: browser JS clients (revisit with OAuth) |
| T7 | sandbox exposure | remote server **hard-pins NETWORK mode**; `WEBAZ_MODE=sandbox` is ignored for the remote path (assert at mount); RFC-003 safety net (network-unmigrated tools hard-fail) already applies |
| T8 | privacy in logs | tool args may contain addresses/PII → log only tool name, duration, status, key prefix; never args |

## 3. Design / 设计

### 3.1 Transport & lifecycle

- **`POST /mcp`** — official `@modelcontextprotocol/sdk` (already at `^1.29.0`) `StreamableHTTPServerTransport` in **stateless** mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true` → plain JSON responses, maximum client compatibility incl. ChatGPT connectors).
- `GET /mcp`, `DELETE /mcp` → `405` (no server-push streams, no sessions in v1).
- One fresh `Server` + transport pair **per request** (the SDK's documented stateless pattern); nothing retained between requests.

### 3.2 Reuse seam (the only refactor)

`startMCPServer()` in `src/layer1-agent/L1-1-mcp-server/server.ts` is split:

- `buildMcpServer(opts?: { defaultApiKey?: string })` — constructs the `Server` and registers all existing handlers (tools/resources/prompts). **One added behavior**: in the `CallToolRequestSchema` handler, if `opts.defaultApiKey` is set and `args.api_key` is absent, inject it — the remote equivalent of the local `WEBAZ_API_KEY` env default (`resolveMcpApiKey` precedence is preserved: explicit `args.api_key` > bearer > env).
- `startMCPServer()` = `buildMcpServer()` + `StdioServerTransport` (npm package behavior unchanged, byte-for-byte tool surface).

New route module `src/pwa/routes/mcp-remote.ts` mounts the endpoint on the existing express app:
1. read `Authorization: Bearer <api_key>` (optional),
2. `buildMcpServer({ defaultApiKey: bearer })`,
3. hand the request to a stateless `StreamableHTTPServerTransport`.

### 3.3 Auth model

| Caller | Result |
|---|---|
| anonymous | `network_readonly` semantics — public reads (info/search/leaderboard/price-history/contribute list/…) work; identity-required tools return the existing "get an invite" guidance |
| `Authorization: Bearer <api_key>` | same as a local user with `WEBAZ_API_KEY` set — writes allowed per the key's scope; RISK actions return `approve_url` for Passkey on the phone |
| OAuth | **non-goal v1** (P1 follow-up; bearer covers ChatGPT developer-mode connectors and all SDK agents) |

### 3.4 Backend base

Tool backends keep calling REST via `WEBAZ_API_URL` (default `https://webaz.xyz`). Same-process loopback (`http://127.0.0.1:$PORT`) is a deploy-time optimization via env — not required for v1 correctness.

### 3.5 Rollout

- Env flag **`WEBAZ_REMOTE_MCP=1`** required to mount (fail-closed default off); flip on Railway after deploy verification.
- Discovery: add `remote_mcp: "https://webaz.xyz/mcp"` to `/.well-known/webaz-integration.json` + `protocol-status.agent_endpoints` **in the same PR**, gated on the same flag being documented as live.
- `gen:api-docs` regenerated (route file touched).

## 4. Non-goals / 非目标

- OAuth flows, session/SSE streaming, CORS for browser JS clients, remote SANDBOX mode, any tool-surface change (no cart/coupon tools — strict-match search stays strict), npm publish changes (stdio package unaffected), Python/Go SDKs.
- **A separate `agent.webaz.xyz` gateway service**: rejected for v1 — a second deployment/attack surface duplicating what the canonical origin already provides (`/mcp` + `/.well-known/webaz-integration.json` *is* the unified agent entry; the "capability manifest" the gateway proposal asks for already exists as RFC-011's well-known suite, including which actions need approval/login and the negative space). If a dedicated hostname is ever wanted it can CNAME to the same app — zero code, deferred.

## 5. Testing / 测试

- **Integration (fresh DB + real express app)**: JSON-RPC `initialize` → `tools/list` (38 tools) → `tools/call webaz_info` anonymous (returns `network_readonly` banner); `tools/call` identity-required tool anonymous → invite guidance (not an executed write); bearer-injection precedence (explicit `args.api_key` wins over bearer); `GET/DELETE /mcp` → 405; flag off → 404.
- **Security assertions**: response carries no `Access-Control-Allow-*`; logs contain no `Authorization` value; oversized body rejected; rate-limit path exercised.
- **Manual acceptance ("Agent First Success")**: from a fresh third-party agent with zero prior context — Claude mobile/desktop remote connector AND ChatGPT developer-mode connector — connect with only the URL, discover tools, and complete one real product search anonymously, unaided. **Mobile clients are the primary validation target** (if mobile works, desktop works; not vice versa). This check joins the release checklist for any future agent-surface change.
- **Explicitly not built (v1)**: an automated "Agent First Success Rate" metric — measured manually pre-launch; instrumentation is a post-launch follow-up if volume justifies it.

## 6. Rollback

Flag off (`WEBAZ_REMOTE_MCP` unset) → endpoint unmounted, zero residual state (stateless by construction).
