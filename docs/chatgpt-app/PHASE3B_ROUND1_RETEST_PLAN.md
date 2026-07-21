# Phase 3B Round 1 — Retest Plan (after UI hotfix deploy)

> Do NOT deploy until owner authorizes. This plan is what to re-verify in real ChatGPT once the hotfix branch is deployed
> to production. Money-path was already proven safe in Round 1; this retest targets the F3/F4/F5 UI behaviors and a
> no-regression check.

## Automated (already green locally; must be green in CI on the PR)
- `npm run test:phase3b-ui-hotfix` (F3/F4/F5 units + wiring).
- Full existing widget/regression suite (mcp-quote-approval-ui, agent-approvals-ui, mcp-card-contract, mcp-uri-versioning,
  mcp-apps-standard, order-timeline-ui, bug08-*, economic-currency-consistency, remote-mcp) — no regression.
- `tsc --noEmit`, schema-verify / pg-parity, definition-budget.

## Live ChatGPT (owner, real Passkey) — after deploy
1. **F4 准备下单**: click once → the card shows an in-card **quote panel** (price / ETA / expiry), no freeze. Rapid
   double/triple-click → **exactly one** `webaz_quote_order` (check DB: `order_quotes` +1, not +N). Button disabled while
   in-flight.
2. **F4 continue chain**: 「创建草稿并提交审批」 → draft then submit render in place → approval panel with copyable
   webaz.xyz link → Passkey on webaz.xyz → exactly one order, one escrow debit (owner-performed Passkey).
3. **F4 QuoteApproval buttons** (if model renders that card): 创建订单草稿 → draft card in place; 提交 Passkey 审批 →
   approval card in place; 🔄 查看最新状态 → executed + order_id in place; 查看订单 → opens webaz.xyz order page.
4. **F4 error/timeout**: force a failure (e.g., expired quote) → in-card error + copyable manual phrase, button re-enabled,
   never a permanent "正在获取报价…".
5. **F3**: product card and quote card show 预计送达 「约12天」 (or a range) — **never** `{"SG":12,...}` / `[object Object]`.
6. **F5**: product card shows 「本卡展示 N 款」 matching the real card count; if the model says "找到6款", the card's own
   count is explicit and honest.
7. **No regression**: search / detail / compare / sort / expand-collapse / recommendation highlight still work; dark theme
   intact; no dev-text leak in cards.

## Transaction-safety re-checks (same as Round 1 §六)
- One quote / one draft / one approval / one order per intended action; request_id↔order_id 1:1; trace zero-PII;
  duplicate_reason accurate on any repeat; balance debited exactly once. STOP + rollback on any duplicate/abnormal amount.

## Rollback
Redeploy the pre-hotfix deployment; or `git revert` the UI commits (UI-only, no schema/money change).

## Out of scope this round
再买一份, Direct Pay happy-path, real merchant message send, returns, disputes, confirm-receipt, refund, iOS/Android,
multi-instance concurrency — Round 2. F2 (search recall) — KNOWN_LIMITATIONS, separate.
