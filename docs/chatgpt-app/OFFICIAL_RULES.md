# OFFICIAL_RULES

> Executable normative baseline for WebAZ's ChatGPT interaction cards, distilled from official sources only
> (see `OFFICIAL_SOURCE_INDEX.md`). Access date **2026-07-20**.
> Every rule is phrased as **MUST / MUST NOT / SHOULD** and quotes exact identifiers verbatim.
> Items that can only be confirmed against a live ChatGPT host or the full `apps.mdx` spec body are tagged **[confirm-live]**.
>
> **Two identifier families coexist and both are official:**
> - **MCP Apps (cross-host, SEP-1865)** — `_meta.ui.*` keys, camelCase CSP (`connectDomains`/`resourceDomains`), `ui/*` postMessage dialect, mime `text/html;profile=mcp-app`.
> - **OpenAI/ChatGPT compatibility** — `openai/*` `_meta` keys, snake_case CSP (`connect_domains`/`resource_domains`), `window.openai` bridge, legacy mime `text/html+skybridge`.
> Portability rule of thumb: **set the MCP Apps standard keys for cross-host portability, and add the `openai/*` aliases for ChatGPT.**

---

## 0. Versions this baseline pins to

- MCP Apps governance: **SEP-1865, Status = Final** (first official MCP extension).
- MCP Apps technical spec: **`2026-01-26`** (stable), SDK **`@modelcontextprotocol/ext-apps` v1.1.2**; a rolling `draft` also exists.
- Core MCP spec targeted by the extension: **`2025-11-25`** (`/specification/latest`), via the SEP-1724 extensions mechanism.
- OpenAI Apps SDK: undated rolling docs (snapshot 2026-07-20).

---

## 1. MCP server & transport

- **MUST** implement MCP: advertise tools via **`tools/list`** (JSON-Schema input/output), execute via **`tools/call`**.
- Transport **MAY** be SSE or Streamable HTTP; OpenAI **SHOULD**-recommends **Streamable HTTP**. Public endpoint path is **`/mcp`**.
- For plugin submission the server **MUST** be on a **publicly reachable HTTPS domain** — a local/ngrok/testing endpoint is rejected at review.
- The server **MAY** return an **`instructions`** string during `initialize` for model-wide workflow/rate-limit guidance.
- MCP Apps **MUST** be treated as **optional & backwards-compatible**: existing (non-UI) behavior keeps working when the host has no UI support.

## 2. Capability negotiation

- MCP Apps support **MUST** be negotiated through the **extensions capabilities map** (SEP-1724): extensions keyed by **reverse-DNS ID**, advertised on both client and server `capabilities`, versioned independently of the core spec. **[confirm-live: the exact reverse-DNS capability key string for the Apps extension is in `apps.mdx`, not in the public doc pages.]**
- Hosts **MUST** advertise UI support when connecting; the server **SHOULD** check host capabilities before exposing UI-only behavior.
- A UI-enabled tool **MUST** still return usable non-UI content (`content:[{type:"text",…}]`) so a non-supporting host degrades cleanly (progressive enhancement — "tools still work, they just return text instead of UI").

## 3. UI resource declaration

- A UI resource **MUST** use the **`ui://`** URI scheme (path structure is arbitrary, e.g. `ui://widget/products.html`).
- The resource **MUST** be served with mime **`text/html;profile=mcp-app`** (= the SDK constant `RESOURCE_MIME_TYPE`). This is the **current** cross-host value.
  - `text/html+skybridge` is the **legacy ChatGPT-only** value and does **not** appear in current MCP Apps docs — treat as superseded. **[confirm-live: whether production ChatGPT still requires/accepts skybridge for existing widgets.]**
- UI resources **MUST be predeclared** (registered up-front, appearing in `resources/list`), **MUST NOT** be embedded inline in tool results. Rationale: preload/prefetch, cache separation, security review.
- On `tools/call`, the host fetches the `ui://` resource via **`resources/read`** and renders it; the tool result is then pushed into the view.

## 4. Tool → UI binding metadata

- A UI-enabled tool **MUST** carry **`_meta.ui.resourceUri`** = the `ui://` URI (cross-host standard).
- For ChatGPT, **SHOULD** also set **`_meta["openai/outputTemplate"]`** to the same `ui://` URI (OpenAI compatibility alias).
- Optional tool-descriptor `_meta` keys (verbatim, from the OpenAI reference catalog):
  `_meta["openai/widgetAccessible"]`, `_meta["openai/visibility"]`, `_meta.ui.visibility` (values seen `["model","app"]`; `["app"]` = app-only tool hidden from the model), `_meta["openai/toolInvocation/invoking"]` (status text while running), `_meta["openai/toolInvocation/invoked"]` (completion status text), `_meta["openai/fileParams"]`, `_meta["securitySchemes"]`.

## 5. Tool result payload — `content` / `structuredContent` / `_meta`

Three siblings with **distinct audiences** — this is the most misuse-prone contract:

- **`structuredContent`** — concise JSON the **widget uses AND the model reads**. **MUST** validate against the tool's declared **`outputSchema`**. Keep small. Appears in the transcript.
- **`content`** — optional Markdown/plaintext narration. Visible to **both the model and the component** (it is part of the tool result the model reads AND is delivered to the view alongside `structuredContent`); it is NOT model-only. Appears in the transcript. (Phase-3A clarification.)
- **`_meta`** — large or sensitive data **exclusively for the widget**; **`_meta` never reaches the model**. Use for hydrating UI without exposing data to the model. **MUST NOT** put secrets/tokens in `structuredContent` or component props.

Tool-result `_meta` keys (verbatim): `_meta["openai/widgetSessionId"]` (per-widget id for correlating calls/logs while mounted), `_meta["mcp/www_authenticate"]` (auth challenge).

- **MUST** declare **`outputSchema`** for any tool returning `structuredContent`; the testing checklist enforces "structured content matches the declared `outputSchema` for **every** tool."
- Tool annotations **MUST** match real behavior (a common rejection cause): `readOnlyHint` (true = cannot mutate), `destructiveHint` (true = deletes/overwrites user data), `openWorldHint` (true = publishes / reaches outside the user's account).

## 6. Widget runtime & the `window.openai` bridge (ChatGPT)

- The widget runs in a **sandboxed iframe** and talks to the host via **JSON-RPC 2.0 over `postMessage`**.
- To call a tool from inside the iframe: MCP Apps **`tools/call`** over postMessage, or OpenAI sugar **`window.openai.callTool(name, args)`**.
- `window.openai` globals (verbatim): `toolInput`, `toolOutput`, `toolResponseMetadata`, `widgetState`, `theme`, `displayMode`, `maxHeight`, `safeArea`, `view`, `userAgent`, `locale`.
- `window.openai` methods (verbatim): `setWidgetState(state)` (sync call, async persistence — no `await`), `callTool(name,args)`, `sendFollowUpMessage({prompt,scrollToBottom})`, `uploadFile(file,{library?})`, `selectFiles()`, `getFileDownloadUrl({fileId})`, `requestDisplayMode(...)` (`"fullscreen"`/`"PiP"`/`"inline"`), `requestModal({params,template})`, `requestClose()`, `notifyIntrinsicHeight(...)`, `openExternal({href,redirectUrl})`, `setOpenInAppUrl({href})`.
- Host→widget global updates arrive via the DOM event **`openai:set_globals`** (`detail.globals`).
- **[confirm-live]** notification names `ui/notifications/tool-result` (carries `{content,structuredContent}`) and `ui/notifications/tool-input`, and the `_meta["openai/closeWidget"]` key, appeared only in single-page summaries — the reference catalog documents `requestClose()` as the close mechanism.

## 7. MCP Apps view↔host dialect (cross-host, `ui/*`)

- Transport **MUST** be browser **`postMessage`** (not stdio/HTTP), JSON-RPC framed.
- Verbatim method list: **`ui/initialize`**, **`ui/notifications/initialized`**, **`ui/notifications/tool-input`**, **`ui/notifications/tool-result`**, **`ui/resource-teardown`**, **`ui/message`**, **`ui/update-model-context`**, **`ui/open-link`**, plus core **`tools/call`** / **`tools/list`**.
- The view **MUST** send **`ui/initialize`** to the host and receives host context (theme, capabilities, container dims) as `McpUiHostContext`.
- Every UI-initiated action **MUST** go through the **same audit/consent path** as a direct tool call. The host **MAY** require explicit user approval for UI-initiated calls, **MAY** restrict which tools an app can call, and **MAY** disable capabilities such as `sendOpenLink`/`ui/open-link`. Views **SHOULD** degrade gracefully and **MUST** handle host-enforced denial rather than assuming success.
- The `App` class (`@modelcontextprotocol/ext-apps`) is a **convenience wrapper, not a requirement** — the raw postMessage protocol MAY be implemented directly (WebAZ does exactly this — hand-rolled inline bridge, no dependency on the SDK).

## 8. State management

- **Business data** — owned by server/backend, source of truth; **MUST** re-fetch from the server after mutations.
- **UI state** — ephemeral, per-widget-instance; persist via `window.openai.setWidgetState()` / read via `window.openai.widgetState`; persists only for that message's widget instance.
- Use **`ui/update-model-context`** when the model needs to see UI state (selected filters, staged edits).
- **SHOULD NOT** use `localStorage` for core state; **MUST NOT** diverge from server truth.

## 9. Security & CSP

- Widgets **MUST** run in a **sandboxed iframe** with **no access to the parent** — MUST NOT access parent DOM, read host cookies/localStorage, navigate the parent, or run scripts in the parent context. All host communication **MUST** go solely through `postMessage`.
- CSP is **deny-by-default**: "if no domains are declared, no external connections are allowed." The server **MUST** declare every external origin (including `localhost` in dev).
  - MCP Apps `_meta.ui.csp` (camelCase): **`connectDomains`** (fetch/XHR/WebSocket → connect-src family), **`resourceDomains`** (scripts/styles/images/fonts → script/style/img/font-src family).
  - OpenAI `_meta["openai/widgetCSP"]` (snake_case): `connect_domains`, `resource_domains`, `frame_domains`, `redirect_domains`.
  - Subframes/iframes are **blocked by default**, allowed only via `frameDomains` / `_meta.ui.csp` frame allowance.
  - `redirect_domains` (OpenAI): listing a destination origin lets `window.openai.openExternal` skip the safe-link modal and appends a `redirectUrl` param for return-to-conversation.
  - Additional device capabilities (microphone, camera) **MUST** be requested via `_meta.ui.permissions`.
- **Blocked browser APIs** the widget **MUST NOT** use: `window.alert`, `window.prompt`, `window.confirm`, `navigator.clipboard`.
- If the widget's app calls an external API, that API **MUST** return permissive CORS (`Access-Control-Allow-Origin: *`) or use API-key auth; for origin-specific allowlisting use `_meta.ui.domain` (a stable origin the API server can allowlist).
- Auth: **SHOULD** use OAuth 2.1 authorization-code for external accounts; **MUST** verify & enforce scopes on **every** tool call, reject expired/malformed tokens, avoid long-lived secrets, validate all inputs server-side (even model-supplied), and require human confirmation for irreversible operations.
- **[confirm-live]** No page publishes the assembled `Content-Security-Policy` header string or the literal iframe `sandbox="…"` token list — the docs describe policy *semantics* only; the enforced strings must be read off a live host / `apps.mdx`.

## 10. Testing, developer mode, submission (ChatGPT)

- **Developer mode**: Settings → Security and login → Developer mode. Add connector: Settings → Plugins (`chatgpt.com/plugins`) → `+` → developer-mode app pointing at the HTTPS `/mcp` endpoint. **[confirm-live: exact menu wording shifts.]**
- **MCP Inspector**: `npx @modelcontextprotocol/inspector@latest`, enter server URL, use List Tools / Call Tool to inspect raw JSON.
- **API Playground** (`platform.openai.com/playground`): Tools → Add → MCP Server → HTTPS endpoint → test prompts, inspect request/response JSON.
- **Verification checklist**: tool list matches docs & prototypes removed; **structuredContent matches declared outputSchema for every tool**; auth returns valid tokens and rejects invalid ones with meaningful messages.
- **Submission MUSTs**: individual (or business) verification in the OpenAI Platform Dashboard; permissions `api.apps.write` (create drafts) / `api.apps.read` (view drafts/status); publicly-reachable domain with a CSP allowing the exact domains; "Scan Tools" imports metadata; test cases pass on **both ChatGPT web and mobile**; outputs carry **no PII / no internal identifiers / no auth secrets**; demo accounts **MUST NOT** require MFA/SMS; annotations must match behavior.
- **Versioning locks**: once published, submitted info + reviewed metadata snapshot are **locked**; **breaking changes inside a published plugin are not currently supported**; changing MCP origin **scheme/hostname/port requires a brand-new app** (path changes allowed in new versions).

## 11. Host-specific differences (ChatGPT vs generic MCP Apps host)

| Concern | ChatGPT (OpenAI) | Generic MCP Apps host (SEP-1865) |
|---|---|---|
| Mime | legacy `text/html+skybridge` + current `text/html;profile=mcp-app` | `text/html;profile=mcp-app` only |
| Tool→UI binding | `_meta["openai/outputTemplate"]` (+ standard `_meta.ui.resourceUri`) | `_meta.ui.resourceUri` |
| Bridge API | `window.openai.*` + `openai:set_globals` event | `ui/*` JSON-RPC over postMessage, `App` wrapper optional |
| CSP keys | `openai/widgetCSP` snake_case + `openai/widgetDomain` | `_meta.ui.csp` camelCase + `_meta.ui.domain` |
| Status text | `openai/toolInvocation/invoking|invoked` | (host-defined) |
| Submission/review | plugin submission portal, verification, locks | n/a (per-host) |

WebAZ's existing approach (per repo survey) **dual-emits both families** — legacy skybridge + `window.openai` for ChatGPT, and standard `text/html;profile=mcp-app` + `ui/*` bridge for cross-host. Whether that dual emission is still the correct/most-current shape is a **Phase-2 audit question**, not settled here.

## 12. Open items to confirm in a real environment (carried into the audit)

1. Whether production ChatGPT still requires `text/html+skybridge`, or now honors `text/html;profile=mcp-app` for existing WebAZ widgets. **[confirm-live]**
2. The exact reverse-DNS capability key for the Apps extension in the `initialize` extensions map. **[confirm-live / apps.mdx]**
3. The assembled `Content-Security-Policy` header + iframe `sandbox` token list ChatGPT actually enforces. **[confirm-live]**
4. Exact `ui/notifications/tool-result` / `tool-input` field schemas and whether ChatGPT emits them (vs `window.openai` globals). **[confirm-live]**
5. Whether `_meta["openai/closeWidget"]` exists or `requestClose()` is the only close path. **[confirm-live]**
6. Current developer-mode menu wording and connector-add flow. **[confirm-live]**
