# Phase 3B Round 1 — UI Fix (F3 / F4 / F5)

Branch `fix/chatgpt-live-ui-round1` → `fix/chatgpt-card-contract-phase3` (Draft stacked PR). Scope: UI/host-integration
only. **No** change to money/amounts, escrow, Direct Pay, order state machine, Passkey execution, DB migrations, BUG-08
server idempotency semantics, promised-ETA snapshot, Schema v2 contracts, or OAuth. All edits are in
`src/layer1-agent/L1-1-mcp-server/ui-widgets.ts` (widget JS) + one test + docs.

## F4 — consume tool results in place (HIGH)

**Root cause (verified):** the primary buttons fired `oai.callTool(...)` fire-and-forget and depended on the standard
`ui/notifications/tool-result` re-render, which ChatGPT's legacy `window.openai` bridge never emits → frozen card +
duplicate quotes.

**Fix — one unified helper + consume + single-flight (both bridges):**
- New `callWebazTool(oai, name, args)` (shared blob) → normalizes both bridges (each returns a Promise) to
  `{ok, structuredContent, error, timeout, sourceBridge}`; 15s timeout; increments `__inlineConsuming` for the call
  window so the standard bridge's `__onToolResult` **skips** the duplicate notification render (a result renders once).
- `prepareOrder` (ProductResults): `state.busy` single-flight + button `disabled` → **kills the duplicate-quote bug**;
  consumes the quote → renders an in-card quote panel (price / `etaDisplay` / expiry) + a 「创建草稿并提交审批」 continue
  chain (draft→submit, each consumed, still Passkey-gated); failure/timeout → in-card error + copyable manual phrase.
  `sendFollowUp` is used **only** when the host has no `callTool` (never on the normal path).
- QuoteApproval create-draft (`webaz_order_draft`) and submit (`webaz_submit_order_request`): consume → `renderBody(oai,
  res.structuredContent)` (same widget renders quote/draft/approval schemas) → the card advances in place. **submit args
  unchanged** — still `withTrace({draft_id})` (BUG-08 trace intact), money semantics untouched.
- executed→查看订单 (approval card): QuoteApproval cannot render a timeline schema, so it now opens the webaz.xyz order
  page fail-visibly (validated `openWebaz`) instead of firing a discarded `callTool`.
- refresh-status already consumed correctly (`p.then(applyApprovalStatus)`) — left as-is (in-place status update).

**Bridge result handling:** legacy = await `window.openai.callTool` Promise and consume; standard = same `callTool`
facade Promise **plus** the `ui/notifications/tool-result` path, deduped by `__inlineConsuming`. Only one bridge is
active per session (unchanged handshake). No sendFollowUp on the normal path.

## F3 — unified ETA formatter (MEDIUM)

New shared `etaDisplay(v, region)` (shared blob) handles number / numeric-string / range-string / range object /
region map (`{"SG":12,"all":12}`) / promised_eta v1 / null / malformed → `约12天` · `3–5天` ·
`暂未提供预计配送时间`; **never** raw JSON, never a fabricated date; prefers destination region → all/default → first
numeric. Wired at the two bad sites (product card `:预计送达`, quote card `:预计送达`); OrderTimeline keeps its existing
`etaText` (same output shape).

## F5 — honest shown-count label (MEDIUM, widget scope)

The product card now prints `精确匹配 · 本卡展示 N 款 … 模型文字里的"找到/推荐 N 款"可能来自更广候选集,以本卡商品为准`.
The widget still renders **all** products it receives (no truncation); this closes the card-vs-narrative gap without
touching the server projection or model behavior. Deeper "render the discover candidate set as the authoritative card"
(spec §八 option A) is noted as a follow-up.

## Tests
`scripts/test-phase3b-ui-hotfix.ts` (26 assertions, wired into `package.json` + `ci.yml`): F3 formatter matrix
(region map / range / null / malformed never `[object Object]`); F4 `callWebazTool` consume (ok / error / throw /
no-host); built-HTML wiring (consume+render, no fire-and-forget on the quote button, `withTrace` intact, standard-bridge
notification dedup, no normal-path sendFollowUp); F5 label present. Full existing widget/regression suite re-run green.

## Rollback
Per-commit `git revert` (UI-only, no schema/money change). The whole PR can be reverted to restore the exact `8cdd3db`
widget behavior; nothing else depends on these edits.
