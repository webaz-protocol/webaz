# BUG06_ADVERSARIAL_REVIEW

> Independent read-only adversarial review of the BUG-06 (unified v2 card contract) change, run by a
> fresh Claude session (review model = Claude, this session; Codex unavailable until 2026-07-25 — noted
> as the limitation: single-model adversarial pass, no external second model). The review session did
> **not** modify code; findings were processed by the main implementation session afterward and re-tested.
>
> Scope reviewed: `git diff 481c846..HEAD` — commits `1a572a1` (docs), `1d82a73` (v2 projections +
> adapters), `cd0eeeb` (component v1+v2), `7ba21af` (timeline v2 + summary object-safety),
> `670b14b` (tests/docs/regen).

## Verdict: no BLOCKER, no HIGH. v2 contract is safe on money, status-gating, back-compat rendering, safe-fail, and rollback.

## Findings

### F1 — LOW (i18n regression on legacy v1 approval cards) — **FIXED** (`ui-widgets.ts`)
Old **v1 approval** cards (status = bare string `"pending"`) rendered the status row as the English
machine code `"pending"` instead of the pre-BUG-06 hardcoded `待批准`. Root cause: the baseline
hardcoded `row(box,'状态','待批准')`; the BUG-06 edit used `stLabel(out.status)||'待批准'`, and for a
v1 approval `stLabel('pending')` is the truthy string `"pending"`. Cosmetic only — no button/functional
impact (approval buttons gate on `stCode`; the live-read path is unchanged). Bilingual UI is a hard repo
rule, so fixed: the status row now uses the localized `stLabel` only when `status` is a v2 **object**;
a v1 bare string falls back to `待批准` (the submit-time status is always `pending`), never the English
code. Locked by `test-mcp-schema-v2-contract` B1e.

### F2 — TRIVIAL (stale doc string) — **FIXED** (`server.ts`)
The OrderTimeline resource `description` said `webaz.order_timeline.model.v1`; updated to
`webaz.order_timeline.model — v1 legacy + BUG-06 v2`. Non-functional.

## Checks that passed cleanly (reviewer-confirmed)
1. **History/back-compat** — v1 draft (bare-string status), quote, and timeline (object status) all
   render unchanged; the draft submit button still fires via `stCode('draft')`. (Only F1 diverged.)
2. **Cross-routing** — branches are distinct `schema_version` literals per card × {v1,v2}; no overlap,
   no fallthrough. A quote payload can only enter the quote branch.
3. **Status → buttons** — gating reads canonical `stCode` (`==='draft'`, `==='executed'`), never the
   localized label; missing code → `''` → button suppressed (fail-closed).
4. **Quantity → amount** — `toPosInt` returns trusted DB integers faithfully (5→5, no understatement);
   malformed → 1; it feeds only display fields. The charged amount is `price.amount_minor` computed
   server-side from the real DB quantity, never from the card's `quantity`.
5. **Money/status/deadline/idempotency untouched** — diff confined to projection / output-schema /
   component / docs / tests. No change to orders-create / direct-pay-create / order-submit-request /
   settlement / dedup hashes. BUG-08 untouched.
6. **Unknown/missing safe-fail** — missing → "no structured payload" before any body; unknown →
   "不支持此旧卡片版本…" + `return`, no partial card. Both components.
7. **promised_eta** — `PROMISED_ETA_SCHEMA` stays `webaz.promised_eta.v1`; projection preserves
   `promised_eta: logi.promised_eta ?? null`; timeline `etaText` still handles `legacy_missing`. Not
   re-versioned / reshaped / dropped.
8. **Summary text safety** — `statusText` + `summarizeOrderTimeline` are object-safe; the timeline
   summary dispatch matches `startsWith('webaz.order_timeline.model.')` (v1+v2) on the projected result.
   No `[object Object]`.
9. **Raw vs consumer version tags** — `buyer-quote.ts` raw tags v1; `order-draft.ts` /
   `buyer-order-full-view.ts` / `order-submit-request.ts` carry no `schema_version` (none falsely claim
   v2). Draft creation consumes `quote_token` via the DB, not the raw response's version.
10. **Rollback** — projection-layer only; no DB migration or persisted-data change. Expected safe
    degradation: after revert, v2 cards already in chat history hit the unknown-version safe message
    rather than rendering (no partial render).
- General scan: no null derefs / regex / off-by-one / wrong-variable bugs; outputSchemas add `type` +
  object `status` consistently without `additionalProperties:false`, so validation is not broken;
  `statusView`'s new optional `meanings` param is backward-compatible with the default-arg (timeline) caller.

## Addendum — pre-acceptance quantity-safety hardening (commit after `ef61fbd`)

The original BUG-06 review noted `toPosInt` faithfully passed valid integers and fell back to `1` for
malformed input (finding 4 = OK, since the amount is server-side). A pre-acceptance requirement tightened
this: **invalid machine data must never be faked as "quantity 1".** Changes:

- `toPosInt` → **`projectQuantity`**: valid positive safe integer (or a pure-digit legacy string) →
  `{quantity:n}`; negative / zero / decimal / overflow / empty / null / non-numeric → explicit
  `{quantity:null, quantity_valid:false, quantity_error:<machine code>}` (codes:
  missing|empty|zero|negative|not_integer|overflow|non_numeric — zero-PII).
- Component: a bad quantity (server signal OR local re-check for old v1 cards) renders **数量数据异常**
  (never `×1`) and **disables** the quote→create-draft and draft→submit-approval buttons — clicking a
  disabled button fires **no** `callTool`, so no quote/draft/order is initiated on corrupt data.
- outputSchema: `quantity` is now `["integer","null"]` + `quantity_valid`/`quantity_error` declared.

Re-review of the hardening (this session, read-only):
- **Money path** — `projectQuantity` still feeds only display; amount stays `price.amount_minor`. A now
  `null` quantity cannot reach any amount computation. OK.
- **Valid path unchanged** — valid data emits `{quantity:n}` with no extra field; card shows `×N`;
  buttons enabled; exactly one tool call fires. Locked by tests A1a–d, B6c/d, B7f/g.
- **Button suppression** — verified in `node:vm` that a disabled invalid-quantity button fires zero
  `callTool` (B7a/b/d/e) and a valid button fires exactly one (B7g).
- **Bug found & fixed during hardening** — the string-path regex `/^\d+$/` was authored inside the
  widget **template literal**, where `\d` collapses to `d` at runtime (the file's convention is `\\`).
  Test B6c ("4"→×4) caught it; fixed to `/^\\d+$/`. Without the test this would have rejected every
  legacy integer-string quantity as invalid.
- **Rollback** — still projection-layer + component only; no DB/persisted change. Reverting restores the
  prior behavior; v2 cards in history keep rendering.

No BLOCKER / HIGH in the hardening. New machine fields are additive and zero-PII.

## Limitation of this review
Single-model adversarial pass (Claude, this session). A second-model (Codex) pass is recommended when it
returns (2026-07-25) before this branch is merged — standard for schema/contract changes.
