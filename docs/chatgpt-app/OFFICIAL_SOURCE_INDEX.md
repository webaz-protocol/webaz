# OFFICIAL_SOURCE_INDEX

> Provenance ledger for the ChatGPT MCP Apps / Apps SDK audit baseline.
> **Rule:** only official first-party domains are cited here. No blogs, forums, videos, or second-hand tutorials.
> Access date for every row below: **2026-07-20** (all fetched in one session).
> None of the OpenAI Apps SDK pages expose a version number or "last updated" date — treat the whole corpus as a snapshot as-of the access date.

## A. OpenAI Apps SDK — domain `developers.openai.com`

| Page title | URL | Version / date | Scope for WebAZ | Volatile? |
|---|---|---|---|---|
| Build your MCP server | https://developers.openai.com/apps-sdk/build/mcp-server | none visible | server/transport, tools/list & tools/call, result shape, outputSchema, `_meta` keys | Yes — implementation API |
| Build your ChatGPT UI | https://developers.openai.com/apps-sdk/build/chatgpt-ui | none visible | widget resource declaration, mime type, `window.openai`, CSP | Yes — implementation API |
| Reference (authoritative identifier list) | https://developers.openai.com/apps-sdk/reference | none visible | canonical `_meta` key catalog + `window.openai` surface | Yes — API surface |
| MCP server (concepts) | https://developers.openai.com/apps-sdk/concepts/mcp-server | none visible | transport, tools/list, tools/call, `initialize.instructions` | No — conceptual |
| Define tools (plan) | https://developers.openai.com/apps-sdk/plan/tools | none visible | outputSchema, tool annotations | No — guidance |
| Managing State | https://developers.openai.com/apps-sdk/build/state-management | none visible | widgetState, callTool, update-model-context | Yes — API surface |
| Security & Privacy (guides) | https://developers.openai.com/apps-sdk/guides/security-privacy | none visible | CSP, iframe sandbox, blocked browser APIs, OAuth | Yes — policy |
| Test your integration | https://developers.openai.com/apps-sdk/deploy/testing | none visible | Developer mode, MCP Inspector, Playground, verification checklist | Yes — UI menu paths |
| Prepare app for plugin submission | https://developers.openai.com/apps-sdk/deploy/submission | none visible | verification, publicly-reachable domain, review/rejection rules, versioning locks | Yes — policy |
| Apps SDK full docs (raw, used to verify exact strings) | https://developers.openai.com/apps-sdk/llms-full.txt | none visible | mirror of all pages — used to corroborate verbatim identifiers | Yes — mirrors docs |

Discovered-but-not-fetched official slugs (for later phases): `/apps-sdk/quickstart`, `/apps-sdk/plan/components`, `/apps-sdk/build/monetize`, `/apps-sdk/deploy` (Deploy your app), `/apps-sdk/deploy/connect-chatgpt`, `/apps-sdk/app-submission-guidelines`, `/apps-sdk/guides/optimize-metadata`, `/apps-sdk/guides/troubleshooting`, and the Conversion Apps specs (Restaurant reservation / Product checkout).

## B. MCP Apps extension — domains `modelcontextprotocol.io`, `apps.extensions.modelcontextprotocol.io`

| Page title | URL | Version / status | Scope for WebAZ | Volatile? |
|---|---|---|---|---|
| SEP-1865: MCP Apps — Interactive User Interfaces for MCP | https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp | **Status: Final**; Extensions Track; created 2025-11-21 | governance status, `ui://` rationale, security model, mime type | No — status Final |
| MCP Apps (Overview) | https://modelcontextprotocol.io/extensions/apps/overview | extension to core spec; links stable spec `2026-01-26` | ui:// preload, `_meta.ui.resourceUri`/`.csp`/`.permissions`, mime type, view↔host JSON-RPC, sandbox, client matrix | Yes — evolving |
| Build an MCP App | https://modelcontextprotocol.io/extensions/apps/build | "under active development" | `registerAppTool`/`registerAppResource`/`RESOURCE_MIME_TYPE`, `App` class | Yes — tutorial/API |
| Overview (API docs) | https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html | Spec **2026-01-26**; SDK **v1.1.2** | full `ui/*` method list, progressive enhancement, sandbox, CSP-by-declaration | Yes — SDK versioned |
| Patterns | https://apps.extensions.modelcontextprotocol.io/api/documents/Patterns.html | v1.1.2; spec 2026-01-26 | `_meta.ui.csp`, `_meta.ui.visibility:["app"]`, `_meta.viewUUID` | Yes |
| CSP & CORS | https://apps.extensions.modelcontextprotocol.io/api/documents/csp-and-cors.html | v1.1.2; spec 2026-01-26 | `connectDomains`/`resourceDomains`, CORS, `_meta.ui.domain` | Yes |
| McpUiResourceMeta (interface) | https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiResourceMeta.html | v1.1.2; spec 2026-01-26 | typed `{ csp, domain, permissions, prefersBorder }` | Yes — typed API |
| ext-apps API index | https://apps.extensions.modelcontextprotocol.io/api/ | pkg `@modelcontextprotocol/ext-apps` **v1.1.2**; spec 2026-01-26 | package layout, `/react`, `/app-bridge`, `/server` | Yes |
| MCP core spec (target of the extension) | https://modelcontextprotocol.io/specification/latest → `2025-11-25` | core spec **2025-11-25** | the base protocol version MCP Apps extends | Yes — spec cadence |

**Version reconciliation (important):**
- Governance proposal **SEP-1865 = "Final"** (first official MCP extension).
- The **technical spec is versioned independently** of the core spec: stable snapshot **`2026-01-26`**, shipped as **`@modelcontextprotocol/ext-apps` v1.1.2**; a rolling `draft` also exists.
- It attaches to the **core MCP spec (2025-11-25 / `latest`) via the extensions mechanism of SEP-1724** (reverse-DNS extension IDs, negotiated in a capabilities extensions map).
- The full normative spec body is `specification/2026-01-26/apps.mdx` in the `modelcontextprotocol/ext-apps` GitHub repo (a source domain outside the two official doc domains; items that can only be confirmed there are flagged `[confirm in real env]` in OFFICIAL_RULES.md).

## C. Claude Code (build host) — domain `code.claude.com` (was `docs.anthropic.com` / `docs.claude.com`, now 301 → `code.claude.com/docs`)

| Page title | URL | Version / date | Scope | Volatile? |
|---|---|---|---|---|
| Claude Code — Settings | https://code.claude.com/docs/en/settings | none; references v2.1.181+ / v2.1.193+ features | permission modes, Bash/Read/Write/Git permissions, MCP config, headless `-p`, verbose | Yes — active dev |

**Redirect note:** `docs.anthropic.com/en/docs/claude-code/settings` → `docs.claude.com/en/docs/claude-code/settings` → **301** `code.claude.com/docs/en/settings`. The Anthropic-domain claude-code docs path listed in the task now resolves to `code.claude.com`.

## D. Version verification for BUG-09 (Phase-3A, verified 2026-07-20 against the installed SDK, not a doc claim)

The `/mcp` manifest's `protocol_version` refers to the **MCP CORE protocol** (transport handshake), a version system **distinct** from the MCP Apps card extension. Verified from `@modelcontextprotocol/sdk` v1.29.0 `types.js`:
- `LATEST_PROTOCOL_VERSION = '2025-11-25'` — now advertised as `protocol_version` (was the SDK's `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26'`, which under-advertised).
- `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']` — now advertised as `protocol_versions_supported`.
- The MCP Apps extension (`SEP-1865`, spec `2026-01-26`) is reported under a separate `mcp_apps_extension` key — never folded into `protocol_version`. Actual per-connection version is negotiated by the MCP `initialize` handshake (SDK-managed); the manifest is advisory only.
