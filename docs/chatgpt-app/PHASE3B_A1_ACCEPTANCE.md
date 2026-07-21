# Phase 3B — A1 Deployment Acceptance & B-2 Formal Closure (2026-07-21)

> Deployment `18563640-d48d-4267-a298-02457c899e21` (tag `phase3b-a1-sourcing-green-a0edf99`,
> merge #475, main `a0edf99`). Rollback targets: near `e5faeb2c` (round1b), long-term `5daf7d25`.
> Connector was NOT refreshed, deleted, or reconnected at any point before or after this deploy.

## Server-side checks — ALL PASS
- health 200 · MCP 21 tools · `openai/outputTemplate` = stable bare aliases on all 5 card tools.
- Bare alias serves current content: `webaz-products.html` sha256-prefix `2992d4bf3f` == pinned (A1 is
  byte-identical by design; parity test P-4 locks this).
- Known-stale hash allowlist live: 7 sampled URIs across all 6 widgets (incl. the 2026-07-19
  connector-era `c4bd5e13bb` / `6a2e96dfb1` / `5ea1e0d365`) → 200 with
  `webaz/compat {alias_of, reason: known-stale-content-hash, policy: explicit-allowlist}`.
- Fabricated hashes (`deadbeef00`, `0123456789`) → explicit 未知资源 rejection (+ server reject log).
- Current versioned URI still served immutably.

## ChatGPT no-reconnect checks — PASS
- Old conversation reloaded post-deploy: card content loads, no "Failed to fetch template".
- New conversation: `webaz_search` renders OUR interactive ProductResults (sort bar + F5 count label
  + 展开/详情/准备下单/比较). Note: when the model instead calls `webaz_discover` (no outputTemplate),
  ChatGPT renders its own static product view — that is host behavior, not a template failure
  (A2 candidate: give discover an outputTemplate).
- Human-performed in-card regression (owner, own window): 准备下单 ×1 → quote panel ~2s,
  **19.90 USDC · 预计送达 约12天** (B-1 ✓, no JSON/[object Object]); 复制继续 → **已复制✓** with correct
  clipboard payload (B-4 ✓); F5 label consistent (5=5).
- Single-flight nuance (measured): clicks <1s apart (same busy window) → exactly 1 quote (morning
  automated burst); deliberate clicks ~3s apart → 1 quote each (known F1 improvement candidate:
  reuse unexpired same-intent quote; server idempotency unaffected, none consumed).

## Money safety
orders 44 → 44 · drafts 15 → 15 · apr 13 → 13 · **Tina balance 905.18 unchanged** through every test.
Only order_quotes grew (34 → 38), each row matching a real click, same intent_hash, none consumed.

## Verdict — **B-2 CLOSED**
Closure criteria met: deploy without touching the connector; old + new conversations load cards; no
template-fetch failure; bare alias = current; known historical hashes load (compat-marked); random
fake hashes fail loudly; F4/F5/B-1/B-3/B-4 regression green (B-3 unchanged content, zero-leak
re-checked this morning); quote-phase order count & balance unchanged.
Honest caveat: A1's template content is byte-identical, so this deploy exercised the mechanism rather
than a real content flip; the first content-changing deploy (A2) re-runs this 1-minute checklist and
appends the superseded hashes to the allowlist (procedure documented in widget-template-compat.ts).
