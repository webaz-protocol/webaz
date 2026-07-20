# ACTION_SAFETY_MATRIX

> Phase-2 §VIII. Every card action that can leave the widget, graded for real-world effect. Source: `ui-widgets.ts` + the tool annotations (`tool-annotations.ts`) + the submit/draft domain (`order-submit-request.ts`, `order-draft.ts`). No code changed.

## Effect classes
- **LOCAL** — no host/network call (sort, expand, select, copy).
- **READ** — read-only tool call or read follow-up (no state change).
- **ADDITIVE-WRITE** — inserts a new row (draft / approval-queue), no fund/stock/order execution.
- **NAV** — opens webaz.xyz (where Passkey-gated execution lives).
- **EXECUTE / FUND-MOVE** — **none exist in any widget.**

## Matrix

| action | card | effect class | tool / target | annotations (RO/D/OW) | Passkey needed | single-flight | fail-visible | verdict |
|---|---|---|---|---|---|---|---|---|
| sort / expand / compare / copy | Product | LOCAL | — | — | no | n/a | yes | safe |
| 下一页 · 详情 | Product | READ | `webaz_search` | RO,F,OW | no | onceGuard | yes | safe |
| 准备下单 (primary/compare) | Product | READ (follow-up only) | model runs quote→draft→submit | — | downstream | onceGuard | yes | safe — no direct write; model orchestrates |
| 创建订单草稿 | Quote/Approval | ADDITIVE-WRITE | `webaz_order_draft` (create) | W,**D**,OW* | no | onceGuard+disabled | yes | safe — draft only, no fund/stock (D flag is for `cancel` overwrite, not create) |
| 提交 Passkey 审批 | Quote/Approval | ADDITIVE-WRITE | `webaz_submit_order_request` | W,F,OW | **execution: yes** | onceGuard+disabled | yes | safe — INSERT into human approval queue; **cannot execute**; Passkey @webaz.xyz creates the order |
| 打开审批页面 | Quote/Approval | NAV | webaz.xyz approval page | — | yes (on that page) | onceGuard | yes (URL always copyable) | safe |
| 🔄 查看最新状态 | Quote/Approval | READ | `webaz_approval_requests` (get) | RO,F,F | no | onceGuard+disabled | yes | safe |
| 查看完整时间线 / row / 刷新 | Timeline | READ | `webaz_buyer_orders` (full) | RO,F,OW | no | onceGuard | yes | safe |
| 联系商家 | Timeline | READ (follow-up) | `webaz_order_chat` (read) | W,F,OW** | no | onceGuard 2s | yes | safe — read follow-up; send is a separate PWA path |
| 订单页(webaz.xyz) | Timeline | NAV | webaz.xyz order page | — | high-risk actions there | onceGuard | yes | safe |

\* `webaz_order_draft` is annotated destructive because its `cancel` action overwrites draft status; the **card only invokes `create`** (additive). \*\* `webaz_order_chat` is annotated write because `send` is additive; the **card only triggers a read follow-up**.

## Confirmed safety invariants (CONFIRMED)
1. **No widget button moves funds or executes an order.** The only writes are additive draft/approval-queue inserts; order creation + payment happen exclusively behind the webaz.xyz Passkey (`ui-widgets.ts` comments `:7,:321-324,:453`; execution isolated from the agent path per `order-submit-request.ts:5-6`). — CONFIRMED
2. **Every host callback is single-flight** (`onceGuard` 1.5–2 s; money-path buttons also `disabled`+4 s reenable). — CONFIRMED
3. **Every host callback is fail-visible** — a copyable manual phrase/URL is always surfaced when the host silently drops the call. — CONFIRMED
4. **Deep links are origin-locked** — `safeWebazHref` allows only `https://webaz.xyz`, default port, no userinfo (`ui-widgets.ts:71`). — CONFIRMED
5. **No user-confirmation dialog is used** (`alert/confirm/prompt` are forbidden by MCP-Apps CSP and absent from the code) — consequential steps rely on the downstream Passkey gate, not an in-widget confirm. — CONFIRMED (spec-compliant)

## Residual / live-host items
- Whether ChatGPT's own "the app wants to run tool X" consent UI appears for the two additive-write `callTool`s is **LIVE_HOST_REQUIRED** (the MCP-Apps spec lets the host require approval per UI-initiated tool call).
- `准备下单` relies on the model to actually chain quote→draft→submit; an over-eager model could submit prematurely, but that is **model behavior, not a card side effect** — NOT_REPRODUCED as a card defect.
