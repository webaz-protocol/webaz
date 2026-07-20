# RESOURCE_URI_MIGRATION — BUG-04 (DESIGN — NOT YET IMPLEMENTED)

> Concrete plan for versioning the 6 widget resource URIs so a redeploy that changes the HTML busts host caches. To be built as its own commit. Preserves the legacy/standard dual-rail; does NOT merge template keys, delete legacy, or install ext-apps SDK.

## Problem (Phase-2 BUG-04, HIGH_CONFIDENCE)
All six widget URIs are unversioned (`ui://widget/webaz-products.html`, `…-mcp.html`, ×3 components). Hosts cache by URI; a redeploy that changes the widget body can serve stale HTML until the host TTL expires.

## Design
1. **Content-addressed version.** At module load compute `v = sha256(html).slice(0,10)` per widget HTML (legacy + standard variants differ → different `v`). Versioned URI: `ui://widget/webaz-products.<v>.html` and `ui://widget/webaz-products-mcp.<v>.html`. Stable per build; changes iff the HTML changes (no build-time randomness).
2. **Atomic references.** Define the versioned URI constants once (module scope), and reference them from: the tool descriptor `_meta.ui.resourceUri` + `openai/outputTemplate`, `ListResources`, and `ReadResource` (`contents[].uri`). Because all read one constant, they can never drift.
3. **Old URIs kept as read aliases.** `ReadResource` resolves BOTH the versioned URI and the bare legacy URI to the same HTML/mime/_meta, so cards in historical chat messages still load. `ListResources` advertises the **new versioned** URIs (new tool calls point there). Aliases are read-only; never advertised.
4. **Dual-rail preserved.** Legacy `text/html+skybridge` and standard `text/html;profile=mcp-app` each get their own versioned URI. Template keys stay split (BUG-05 unchanged).

## Files
- `src/layer1-agent/L1-1-mcp-server/server.ts`: compute versioned URIs (import `createHash`); rewrite the 5 UI tools' `_meta` resourceUri/outputTemplate to the versioned constants (via a post-process pass in the assembly chain to avoid editing 5 inline literals); `ListResources` → versioned; `ReadResource` → versioned + bare alias map.
- Tests: `test-mcp-apps-standard.ts` (update T-1 to compute expected versioned URI from the HTML, and assert bare alias resolves); `diagnose-mcp-card-matrix.ts` (checks 2–5 use URIs — verify versioned + alias); new `test-mcp-uri-versioning.ts`: (a) all new URIs List+Read; (b) MIME correct; (c) bare alias returns identical body; (d) tool `_meta` points at versioned; (e) **content-change → version-change** (mutate the HTML constant in a fixture and assert the hash differs); (f) quote/draft still differentiated by schema_version.

## Cache migration & rollback
- Migration: deploy → hosts fetch the new versioned URIs on next tool call; old cached cards keep working via aliases. No user action.
- Rollback: point tool `_meta` back to bare URIs (aliases keep both live), or `git revert`. Aliases mean no card ever 404s during the transition.

## When to bump
The version bumps automatically whenever the widget HTML body changes (content hash). No manual step. Keep aliases for ≥1 release cycle (historical messages), then optionally prune.
