# AUDIT_REPORT — Phase 2 (code-level gap audit, protocol reproduction, root-cause)

> ChatGPT MCP Apps / Apps SDK interaction cards. Read-only + tests + diagnostics; no business logic, DB, or prod config changed. Branch `docs/chatgpt-app-audit-baseline`.
> Every claim is graded: **CONFIRMED** · **HIGH_CONFIDENCE** · **LIVE_HOST_REQUIRED** · **NOT_REPRODUCED**. Detailed evidence in the sibling docs.

## Scope covered
55 tools; 3 card components (ProductResults, QuoteAndApproval, OrderTimeline) each dual-emitted as legacy skybridge + standard MCP-Apps; 6 UI resources; the money-path chain quote→draft→submit→(Passkey). Ground truth was **code-generated** (`scripts/diagnose-mcp-card-matrix.ts`) and **contract-locked** (`scripts/test-mcp-card-contract.ts`, 16/16), not hand-transcribed.

## Headline: the card wiring is fundamentally sound
The two most-feared failure modes did **not** reproduce. There is **no** tool→resource mis-binding, **no** draft-shows-quote cross-wiring, and **no** double-bridge / double-fire path. quote/draft/submit deliberately share one component differentiated by `schema_version`, and that differentiation is correct end-to-end. The real defects are in **data completeness/consistency** (truncation, ETA drift), **caching** (unversioned URIs), and **observability** (duplicate-cause logging) — not in the card plumbing.

## CONFIRMED
- **Wiring integrity** — all 5 UI tools resolve to existing resources; ListResources URI == ReadResource URI == MIME; legacy+standard variants bind the same correct component; no duplicate/cache-collision URIs; binding is by explicit string switch (no index drift). (matrix checks 1,3,4,5,6,8,9,10)
- **BUG-01 truncation** — `return_condition`/`ship_regions` silently 200-byte-capped (no flag); oversized `specs` dropped wholesale; no agent full-text second fetch (dead end).
- **BUG-03 mechanism** — `duplicate=true` is correct idempotent reuse of a pre-existing live `order_submit` row; it never mislabels a new row; a clean first submit does not duplicate.
- **Envelope hygiene** — exact 5:5 structuredContent↔outputSchema; no `_meta` on any result envelope; content = short summary (5 tools success) / JSON dump (others); `_mode` honesty stamp is the only extra key reaching structuredContent.
- **Single-bridge + single-flight** — one handshake picks standard OR window.openai; money-path buttons are `onceGuard`+`disabled`; no widget button moves funds or executes an order.

## HIGH_CONFIDENCE (needs live/logs to close)
- **BUG-02** quoted delivery ETA lost on the order (two-source mismatch + schema gap; timeline card never renders ETA).
- **BUG-04** unversioned widget URIs → stale-cache risk on redeploy.
- **BUG-05** `_meta.ui.resourceUri` ≠ `openai/outputTemplate` (deliberate) ⇒ ChatGPT loads only the legacy skybridge component; standard `ui/*` bridge dormant on ChatGPT.
- **BUG-03 cause** the observed first-visible `duplicate=true` is most likely a prior live intent row or a ChatGPT safe-retry; which one is blocked by weak correlation logging.
- **BUG-06/07/08/09** status object↔string drift; bare wire timestamps; coarse intent_hash blocks a genuine re-buy in 24h; manifest advertises old protocol `2025-03-26`.

## LIVE_HOST_REQUIRED
Real ChatGPT web + mobile renders; enforced CSP/`sandbox` strings; which template key ChatGPT honors (appears to be `openai/outputTemplate`→legacy); the real duplicate-incident classification; whether any host surfaces resource/tool descriptions to end users (N-DEV).

## NOT_REPRODUCED (disproven or by-design; NOT bugs)
N1 product-card-shows-tool-desc (no path), N2 draft-shows-quote (disproven), N3 stringified-JSON (by design for non-card tools), N4 准备下单→submit (disproven; follow-up only), N5 approval no auto-update (by design snapshot + manual refresh), N6 double bridge (disproven), N7 escrow/USDC misleading (rail-honesty present; UX judgment), N-DUP-SUMMARY summary-misses-duplicate (disproven; summary runs on projected object).

## Two-protocol-stack conclusion (§X)
Both bridges are hand-rolled in `ui-widgets.ts` (no `ext-apps` SDK). They are correctly single-selected and share one render body. The standard variant is well-formed (SEP-1865 `ui/*`, spec `2026-01-26`) but **dormant on ChatGPT** because ChatGPT reads `openai/outputTemplate`→legacy. This is not a defect to "fix" blindly — it may be load-bearing for ChatGPT. SDK migration is **not** recommended for Phase 3 (see REMEDIATION_PLAN §SDK): the hand-rolled code is small, tested, and CSP-clean; migrating would add a dependency and risk regressions without a proven benefit. Do NOT remove legacy Skybridge until a live host confirms ChatGPT no longer needs it.

## What Phase 3 should change (files) — see REMEDIATION_PLAN
`agent-model-projection.ts` (truncation flag + ETA carry + TZ-qualify), the order snapshot path (`buyer-quote`/`order-draft`/`orders-create` or the timeline card read) for ETA, `server.ts` ListResources (versioned URIs), `mcp-remote.ts` (manifest protocol version), and a default-off diagnostic trace for duplicate classification. All are behind Phase-3 approval; nothing changed here.
