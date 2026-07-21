# ENVIRONMENT_CAPABILITIES

> What this development environment can and cannot do for the ChatGPT-card audit, verified 2026-07-20.
> No secrets, cookies, tokens, Passkeys, or personal data are recorded here.

## 1. Repo & toolchain (verified)

| Item | Value | How verified |
|---|---|---|
| Canonical repo | `/Users/holden/webaz` (remote `webaz-protocol/webaz`) | `git` |
| Working branch | `docs/chatgpt-app-audit-baseline` (cut from clean `main` @ `b2537d3`) | `git checkout -b` |
| Uncommitted changes at start | none (clean tree) | `git status --short` |
| Node | v25.9.0 | `node -v` |
| Package managers | npm 11.12.1, pnpm 10.32.1 (no `packageManager` field pinned; repo uses npm scripts + `package-lock.json`) | `npm -v` / `pnpm -v` |
| TypeScript | ^6.0.3 (tsc 6.0.3) | `npx tsc -v` |
| Test runner | `tsx` v4.23.1 (all `test:*` scripts are `tsx scripts/test-*.ts`) | `npx tsx --version` |
| MCP SDK | `@modelcontextprotocol/sdk` **^1.29.0** (present in node_modules) | `package.json` / `ls node_modules` |
| MCP **Apps** SDK | **`@modelcontextprotocol/ext-apps` NOT installed** — WebAZ hand-rolls the widget bridge inline; it does not depend on the SDK's `App`/`registerAppTool` helpers | `ls node_modules/@modelcontextprotocol` → only `sdk` |
| Web framework | express ^5.2.1; zod ^4.4.3 | `package.json` |
| Git identity | `holden <holden@webaz.xyz>`; DCO sign-off required; `main` branch-protected (PR + self-merge) | `git config` + project rules |

## 2. Claude Code capabilities (this session)

| Capability | Status | Notes |
|---|---|---|
| Internet access | **Yes** — WebFetch + WebSearch | Verified against developers.openai.com, modelcontextprotocol.io, apps.extensions.modelcontextprotocol.io, code.claude.com |
| Bash execution | **Yes** | Verified (git, node, npm, npx). Note: shell cwd resets to `/Users/holden/dcp` between calls — always `cd /Users/holden/webaz` inside each command. `timeout` is unavailable on this shell. |
| File read/write | **Yes** | Created `docs/chatgpt-app/*` |
| Git | **Yes** (branch/commit/PR local ops) | Cannot push to protected `main` directly; PR + self-merge workflow |
| Install dependencies | **Capable** (npm/pnpm), but **avoid** for audit — no business/dep changes this phase | — |
| Run local server | **Capable** (`npm run dev` = `tsx src/index.ts`; `npm run mcp` = stdio) | Not started this phase (read-only). Boot is heavy (DB init, volume) |
| Run local tests | **Yes, verified** | `npm run test:mcp-tool-annotations` → `pass 36` (55/55 tools carry 3 hints, stdio+remote share `buildMcpServer`) |
| Browser automation (Claude-in-Chrome) | Available via MCP tools (deferred) | Not used this phase; relevant for live-env confirmation later |

**Domain reachability (verified via WebFetch, 2026-07-20):**
- `developers.openai.com` — reachable (Apps SDK docs).
- `modelcontextprotocol.io` — reachable (MCP + MCP Apps + SEPs).
- `apps.extensions.modelcontextprotocol.io` — reachable; root redirects to `/api/` (typedoc for `@modelcontextprotocol/ext-apps` v1.1.2).
- `docs.anthropic.com` (task-listed) — **301 → `docs.claude.com` → `code.claude.com/docs`**; the Claude Code docs now live at `code.claude.com/docs`.

## 3. What this environment CANNOT do (for the audit)

- **Cannot see inside a live ChatGPT render.** The `[confirm-live]` items in `OFFICIAL_RULES.md` (actual enforced CSP/sandbox strings, whether skybridge is still required, real notification field shapes) need a human in ChatGPT Developer mode. See `MISSING_RESOURCES.md`.
- **No MCP Inspector cached locally** — `npx @modelcontextprotocol/inspector@latest` is on-demand and needs network + an interactive browser; usable but not yet run.
- **No ChatGPT Developer-mode access, no test account/order visibility** from here — these are human-operated. Must not enter or record any credential.
- **Cannot read the full `specification/2026-01-26/apps.mdx`** normative body from the two allowed doc domains (it lives in the `modelcontextprotocol/ext-apps` GitHub repo); some exact strings are therefore `[confirm-live]`.

## 4. Available test entry points (MCP / widget surface)

47 relevant `scripts/test-*.ts` (mcp / gateway / agent). Widget-specific and conformance ones to lean on in the audit:
- Widget UI: `test:mcp-quote-approval-ui`, `test:mcp-order-timeline-ui`, `test-product-widget-expand.ts`, `test-product-presentation-ui.ts`, `test-agent-approvals-ui.ts`.
- Standard MCP Apps bridge: `test:mcp-apps-standard` (drives the SEP-1865 `ui/*` bridge in a `node:vm`).
- Contract/shape: `test:mcp-tool-annotations` (verified pass 36), `test:mcp-security-schemes`, `test:mcp-model-projection`, `test:mcp-result-handle`, `test:mcp-tool-surfaces`, `test:mcp-definition-budget`, `test:mcp-http-edge`, `test-agent-invocation-conformance.ts`.
- OAuth: `test-oauth-*.ts` family.

---

## Appendix — WebAZ code map (read-only survey, 2026-07-20)

The MCP + card surface lives in two clusters: the MCP server core at `src/layer1-agent/L1-1-mcp-server/`, and the HTTP edge at `src/pwa/routes/mcp-remote.ts`. **No file below was modified this phase.**

### MCP server entry / `/mcp` / JSON-RPC
- `src/pwa/routes/mcp-remote.ts` — Remote MCP over Streamable HTTP (RFC-022). `POST /mcp` handler `:270-407`; `registerRemoteMcpRoutes()` `:221`; per-request `buildMcpServer()` + `StreamableHTTPServerTransport` (stateless, `enableJsonResponse:true`) `:386-402`; GET/DELETE→405 `:411-418`; `remoteMcpEnabled()` `:34`.
- Mounted at `src/pwa/server.ts:7737`; import `:366`.
- `src/layer1-agent/L1-1-mcp-server/server.ts` — shared MCP `Server`; handlers: ListTools `:5939`, ListResources `:5942`, ReadResource `:6025`, CallTool `:6222`; `startMCPServer()` (stdio) `:6354`.
- `src/mcp.ts` (stdio entry) + `src/layer1-agent/L1-1-mcp-server/cli.ts`.

### Tool registration / schemas / catalog
- `server.ts` — `TOOLS` catalog `:613`; assembly `TOOLS_ANNOTATED = withSecuritySchemes(withOutputSchemas(annotateTools(TOOLS)))` `:2135`; transport filter `toolsForTransport()` `:2200`.
- `src/layer1-agent/L1-1-mcp-server/tool-output-schemas.ts` — `OUTPUT_SCHEMAS` `:21`, `withOutputSchemas()` `:124`.
- `src/layer1-agent/L1-1-mcp-server/tool-annotations.ts` — `TOOL_ANNOTATIONS` `:32-88`, `annotateTools()` `:97` (fail-closed on unmapped tool).

### UI resource registration (`ui://` / mime / `_meta`)
- `server.ts` ListResources `:5942-6023` — registers 6 resources: **3 legacy skybridge** (`ui://widget/webaz-products.html`, `-quote-approval.html`, `-order-timeline.html`, mime `text/html+skybridge`, `_meta["openai/widgetCSP"]` + `openai/widgetDomain`) `:5951-5975`; **3 standard MCP Apps** (`*-mcp.html`, mime `text/html;profile=mcp-app`, `_meta.ui.csp`) `:5980-5998`.
- `server.ts` ReadResource `:6025-6047` — serves widget HTML; legacy `:6026-6037`, standard `STANDARD_WIDGETS` `:6040-6046`.
- Per-tool `_meta` carrying `ui.resourceUri` + `openai/outputTemplate` + `openai/widgetAccessible` + `openai/toolInvocation/*`: search `:735-740`, order_timeline `:1930-1935`, quote/draft/submit `:1982-2037`.

### Card / widget frontend
- `src/layer1-agent/L1-1-mcp-server/ui-widgets.ts` (596 lines) — all widget HTML/JS/CSS as inline template strings, self-contained (no bundler). Shared theme `:26`, standard SEP-1865 bridge `:83-130`, legacy `window.openai` boot `:76`, `buildWidgetHtml()` `:132`. Widgets: ProductResults (`PRODUCT_RESULTS_BODY_JS` `:184`), QuoteAndApproval (`QUOTE_APPROVAL_BODY_JS` `:387`), OrderTimeline (`ORDER_TIMELINE_BODY_JS` `:506`). Exports `:584-591`.
- **Build:** no separate widget bundle step — HTML generated in-process; `tsc` compiles. `npm run build` → `build:whitepaper && tsc && cp -r src/pwa/public dist/pwa/`; runtime `dist/pwa/server.js`.

### Tool result shape (`content` / `structuredContent` / `_meta`)
- `server.ts` — `buildToolEnvelope()` `:2152-2173`, `projectForTool()` `:2140`, `STRUCTURED_RESULT_TOOLS` `:2178-2189`, CallTool tail `:6308-6348`.
- `src/agent-model-projection.ts` — consumer projections (`projectProductModel` `:64`, `projectQuoteConsumer` `:242`, `projectOrderTimelineConsumer` `:338`, etc.) + `SCHEMA_*` version constants.
- Auth challenge `_meta['mcp/www_authenticate']` at `mcp-remote.ts:254-268`.

### ChatGPT/OpenAI compat fields
- `server.ts` — `openai/outputTemplate`, `openai/widgetAccessible`, `openai/toolInvocation/invoking|invoked`, `openai/widgetCSP`, `openai/widgetDomain`.
- `mcp-remote.ts` — OpenAI auth-challenge shape (`mcp/www_authenticate`, HTTP-200 + `isError`) `:244-268`,`:337-374`; Origin allowlist incl. `chatgpt.com`/`chat.openai.com` `:129`.
- `ui-widgets.ts` — dual-emit legacy (`window.openai`) vs standard (`ui/*` postMessage) bridges `:76-130`.
- `src/layer1-agent/L1-1-mcp-server/tool-security-schemes.ts` — per-tool `securitySchemes` + `OAUTH_TOOL_SCOPES` `:29-46`.

### OAuth / auth / origin
- `mcp-remote.ts` — bearer/oat_/gtk_/DPoP `:283-395`, `AUTH_ONLY_TOOLS` `:50-63`, Origin allowlist `:129-145`.
- `src/layer1-agent/L1-1-mcp-server/auth.ts` (api_key), `tool-security-schemes.ts`, `network-mode.ts`.
- OAuth routes: `oauth-discovery.ts` / `-authorize.ts` / `-token.ts` / `-approve.ts` / `-register.ts` (DCR) / `-revoke.ts` / `-verified-connectors.ts`.

### Order state machine
- `src/layer0-foundation/L0-2-state-machine/transitions.ts` — `OrderStatus` `:8`, `VALID_TRANSITIONS` `:53`, `ORDER_STATE_MEANINGS` `:502`.
- `.../engine.ts` — `transition()` `:71`, `checkTimeouts()` `:175`, `getOrderStatus()` `:345`.
- Routes: `src/pwa/routes/orders-action.ts`, `src/pwa/order-action-exec.ts`.

### Deployment
- `Dockerfile` — `npm run build` `:32`, `CMD ["node","dist/pwa/server.js"]` `:57`.
- `railway.toml` — DOCKERFILE builder, `startCommand="node dist/pwa/server.js"`, volume `/root/.webaz`.
- `server.json`, `.env.example`, `.dockerignore`.

### Logging / telemetry
- `server.ts` — `recordToolCall()` `:6368` (INSERT `mcp_tool_calls` + `sendTelemetry`), `sendTelemetry()` `:6408`, `TELEMETRY_URL` `https://webaz.xyz/api/mcp-telemetry` `:114`, DDL `:545-560`, ring buffer `pushRecentCall()` `:173`.
- `mcp-remote.ts` — privacy-preserving edge logging (no args/Authorization), shadow gateway-limit observation `:199-219`, IP rate-limit `:272`.
