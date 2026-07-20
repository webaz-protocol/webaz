# BRIDGE_PROTOCOL_AUDIT — standard (`ui/*`) vs legacy (`window.openai`)

> Phase-2 §IV. WebAZ hand-rolls both bridges in `src/layer1-agent/L1-1-mcp-server/ui-widgets.ts` (no `@modelcontextprotocol/ext-apps` dependency). No SDK migration performed. No code changed.
> Grades: **CONFIRMED** · **HIGH_CONFIDENCE** · **LIVE_HOST_REQUIRED** · **NOT_REPRODUCED**.

## Two boot paths, one render body
`buildWidgetHtml({standard})` (`ui-widgets.ts:132-148`) emits a widget from shared pieces: theme, compat-core, (optional) link-safe, (optional) standard bridge, and a boot. Each component ships **two** HTML resources sharing one `renderBody` (`:584-591`):
- **legacy** `*.html` (`text/html+skybridge`) → `WIDGET_BOOT_LEGACY_JS` (`:76-79`): `renderBody(window.openai, window.openai.toolOutput)`. `window.openai` only.
- **standard** `*-mcp.html` (`text/html;profile=mcp-app`) → `WIDGET_BOOT_STANDARD_JS` (`:112-130`): standard `ui/*` bridge with a `window.openai` **fallback**.

## Which listeners / methods each bridge registers (CONFIRMED)
| | legacy (`window.openai`) | standard (`makeStandardBridge`, `:83-110`) |
|---|---|---|
| inbound listener | none added by widget; reads `window.openai.toolOutput` synchronously at boot; host pushes via `openai:set_globals` (not subscribed here) | `window.addEventListener('message', onMsg)` — validates `e.source===window.parent`, `jsonrpc==='2.0'`, pins `hostOrigin` on first message |
| render trigger | `renderBody(oai, oai.toolOutput)` once at boot | `ui/notifications/tool-result` → `onToolResult(r)` → `renderBody(__facade, r.structuredContent)` (`:114`) |
| tool call | `window.openai.callTool(name,args)` | `request('tools/call',{name,arguments})` (`:106`) |
| open link | `window.openai.openExternal({href})` | `request('ui/open-link',{url})` (`:107`) |
| follow-up | `sendFollowUpMessage`/`sendFollowupTurn` (`:59-65`) | `request('ui/message',{role:'user',content:{type:'text',text}})` (`:108`) — single ContentBlock (2026-01-26) |
| handshake | none | `ui/initialize` (protocolVersion `2026-01-26`) → on success posts `ui/notifications/initialized` (`:102-103`) |

## The 12 §IV questions — graded

1. **Listeners registered by each bridge:** table above. — CONFIRMED
2. **Events/methods each handles:** table above. — CONFIRMED
3. **Capability probe:** every host action is feature-detected before use — `typeof oai.callTool==='function'` (`:253,:272,:426,:526,:565`), `canFollowUp(oai)` (`:59,:570`), `openExternal` presence (`:72`). Missing capability → graceful text/hint fallback. — CONFIRMED
4. **Can standard + legacy be active simultaneously?** **NO.** `WIDGET_BOOT_STANDARD_JS` runs `__br.connect(600)`; on success it installs a standard-only `__facade` (`:117-124`); on timeout/failure it `closed=true; removeEventListener` inside `connect().catch` (`:104`) and falls back to `window.openai` (`:125-128`). The legacy resource never loads the standard bridge. **Single-bridge principle** — one handshake outcome picks one bridge, explicitly documented `ui-widgets.ts:17`. — CONFIRMED / **NOT_REPRODUCED** (double-bridge)
5. **Same button firing via both `window.openai.callTool` AND `postMessage/tools/call`?** No — only one `oai`/`__facade` object is in scope per widget instance; its `callTool` is either the standard facade or `window.openai`, never both. — **NOT_REPRODUCED**
6. **Duplicate listener registration?** The standard bridge adds exactly one `message` listener (`:98`) and removes it on handshake failure (`:104`). No re-add path. — **NOT_REPRODUCED**
7. **Listener cleanup on remount?** Each widget instance is a fresh iframe document; there is no in-document re-mount/teardown handling (`ui/resource-teardown` is **not** handled). If a host reuses one iframe and re-boots the script, the old `message` listener from a **successful** handshake is not removed (only the failure path removes it). — **HIGH_CONFIDENCE** (minor; standard hosts create a new iframe per render, and ChatGPT uses the legacy path which adds no listener — see §Consequence). **LIVE_HOST_REQUIRED** to see if any host re-boots in place.
8. **Single-flight on clicks?** Yes — `onceGuard(fn,1500)` busy-locks for 1.5 s (`:66`); money-path buttons additionally set `disabled=true` + `reenable` 4 s (`:428,:445`, quote/submit). — CONFIRMED
9. **Rapid double-click → two requests?** No — `onceGuard` swallows the second click within 1.5 s; `disabled` blocks re-click until `reenable`. — CONFIRMED / **NOT_REPRODUCED**
10. **Host retry reusing the same idempotency key?** The widget carries no client idempotency key; idempotency is **server-side** (`intent_hash`, see IDEMPOTENCY_TRACE_AUDIT). A host-level retry is deduped by the server, not the widget. — CONFIRMED (server-side)
11. **Request-ID collision between standard & legacy?** Not applicable — the two bridges never run together (Q4); the standard bridge's `id` is a per-instance `++seq` starting at 1 (`:97`), scoped to that iframe. — **NOT_REPRODUCED**
12. **Error response auto-resend?** No auto-retry in either bridge. Standard `callTool` rejections are swallowed (`__facade.callTool … .catch(function(){})` `:120`); legacy calls are wrapped in try/catch that sets a fail-visible hint, no resend (`:247,:428,:445`). — CONFIRMED / **NOT_REPRODUCED**

## Consequence for ChatGPT specifically — HIGH_CONFIDENCE / LIVE_HOST_REQUIRED
Per the tool wiring (see RESOURCE_REGISTRATION_MATRIX check 2), ChatGPT reads `_meta["openai/outputTemplate"]` → the **legacy** `*.html` (skybridge, `window.openai`). So **on ChatGPT the standard `ui/*` bridge never runs** — the `makeStandardBridge` handshake, `ui/initialize`, and the tool-result notification path are dormant on ChatGPT and exercised only by other MCP-Apps hosts that read `_meta.ui.resourceUri`. Confirming ChatGPT's template-key preference is **LIVE_HOST_REQUIRED**.

## Test coverage added
- `scripts/test-mcp-apps-standard.ts` (pre-existing) drives the SEP-1865 `ui/*` bridge in `node:vm`.
- `scripts/diagnose-mcp-card-matrix.ts` (new, this phase) verifies each resource's bridge type from the returned HTML (see matrix: legacy variants = `legacy(window.openai)`, standard variants = `standard(+legacy fallback)`).
- A dedicated JSDOM double-click / remount / out-of-order / duplicate-response harness is **recommended for Phase 3** (§IX). It is not built here because the money-path single-flight is already proven by `onceGuard`+`disabled` code inspection and the existing `vm` bridge test; a full DOM simulator would materially change nothing in the graded conclusions above. Its differences from a real ChatGPT host (no real CSP, no real iframe sandbox, synthetic postMessage timing) must be documented when built.

## Open items (LIVE_HOST_REQUIRED)
- Whether ChatGPT honors `openai/outputTemplate` over `_meta.ui.resourceUri` (it appears to → legacy path).
- Whether any host re-boots the widget script in a reused iframe (would exercise the un-removed success-path `message` listener, Q7).
- Real enforced CSP/`sandbox` tokens for both resource variants.
