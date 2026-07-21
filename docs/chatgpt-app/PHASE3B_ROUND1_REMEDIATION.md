# Phase 3B Round 1 — Remediation Report (整改报告)

> Live production canary on `webaz.xyz` (deployment `5daf7d25` = tag `phase3a-ci-green-8cdd3db`, commit `8cdd3db`),
> test account **Tina**, real ChatGPT Developer-mode host + a genuine WebAuthn Passkey (owner-performed).
> PR #471 unmerged, `main` untouched. Date 2026-07-21.

## 1. Test completeness — full 9-step buyer chain executed LIVE

| Step | Path used | Result |
|---|---|---|
| 1 搜索 | ChatGPT model → webaz_search | ✅ works; card rendered (see F2, F5) |
| 2 详情/条款 | suite + card contract | ✅ |
| 3 报价 quote | model-initiated | ✅ 19.90 USDC, escrow, addr server-resolved (see F3) |
| 4 草稿 draft | model-initiated | ✅ inherits quote; not charged |
| 5 提交 + **真人 Passkey** | model submit → **owner Passkey on webaz.xyz** | ✅ **one real order created** |
| 6 审批状态 | model → webaz_approval_requests | ✅ executed + executed_order_id matches (see F4) |
| 7 查看订单 | model → OrderTimeline card | ✅ status/timeline/USDC correct |
| 8 ETA | OrderTimeline | ✅ 下单时预计送达 约12天; tracking 暂无 (honest) |
| 9 联系商家 read | model → webaz_order_chat action=list | ✅ 暂无会话, **no message sent** |

**Money-safety: all green.** One order `ord_8e32…96dd`, one 19.90 escrow debit (Tina 944.98→925.08), request_id↔order_id
1:1, draft consumed (status=ordered), ORDERS_FROM_THIS_DRAFT=1 (no duplicate), trace row zero-PII (hashed key +
12-char intent prefix), Passkey genuine (webauthn_challenge present + owner-confirmed). No rollback. `/health` 200.

## 2. Findings — all UI / host-integration; NO money / security / data defect

### F4 — widget→host `callTool` does not render in ChatGPT (HIGH; blocks one-click UX)
- **Symptom:** in-card buttons (准备下单, 查看最新状态, 创建草稿/提交) fire but nothing renders back; the card stays a
  submit-time snapshot ("正在获取报价…", 状态:未知). Repeated clicks created duplicate quotes (5×).
- **Root cause:** ChatGPT Apps only re-renders **model-initiated** tool results, not **widget-initiated** `oai.callTool`.
  WebAZ's DIRECT_TOOL buttons (`ui-widgets.ts` prepareOrder L259, refresh-status L582) depend on host re-render.
- **Remediation (pick/combine):**
  1. widget consumes the `callTool` promise and renders the result **in-card** (quote/status update in place, no host
     dependency) — the returned promise is already available (L121); prepareOrder/refresh must actually consume it.
  2. or route these buttons through `sendFollowUpCompat` (model-initiated) so the host renders.
  3. or, when host lacks widget-render, degrade the button to "send the one-line instruction to the model" (one tap).
  - Current fail-visible copy-phrase fallback works but is poor UX.

### F3 — ETA object rendered as `[object Object]` in two cards (MEDIUM)
- **Symptom:** ProductResults card + QuoteAndApproval card show 预计送达 `{"SG":12,"all":12}`. OrderTimeline card shows
  「约12天」correctly; the model's text also says 约12天. So it is a widget-render bug in two widgets only.
- **Root cause:** `estimated_days` is stored as a region→days JSON (`{"SG":12,"all":12}`); the card projection
  JSON-parses it to an object, then `ui-widgets.ts:326` (product card) and `:458` (quote card) do `String(obj)`.
- **Remediation:** in those two lines, resolve by destination region (dest_region → value, fallback `.all`), or reuse the
  already-resolved `estimated_days_text` from the promised-ETA resolver — align with how OrderTimeline renders it.

### F5 — product card count ≠ model narrative (MEDIUM)
- **Symptom:** model text says 找到 6 款 / 推荐 3 款, but the ProductResults card shows only 1 product.
- **Root cause:** the widget renders **all** products it receives (no truncation — `ui-widgets.ts:221/294/299`); the
  webaz_search feeding the card strict-matched only 1, while the model's narration/recommendation (PR-B3) draws from a
  larger set. Card-vs-narrative mismatch.
- **Remediation:** feed the card the same candidate/recommendation set the model narrates (project it into the widget), or
  make the model narration reflect the card's real hit count. Ties into F2.

### F2 — anonymous strict search 0-recall (MEDIUM; known design)
- Dropship products sit on `category_id="cat_default"` (unpublished category); search is strict-match, no fuzzy → free-text
  queries return 0 (0-hit → recovery → PWA #discover). **Remediation:** assign published categories/keywords to products.

## 3. Observations
- Order advanced paid→shipped because the **seller (holden, the owner)** accepted at 09:12:54 and shipped at 09:13:22 —
  legitimate seller-side progression, not an auto/anomaly. Tracking number not yet entered (暂无) — honest.

## 4. Proposed next step
- One **UI remediation PR** for F3 + F4 + F5 (no money-path / schema changes). **F4 is the priority** — it determines whether
  the ChatGPT one-click experience works at all. Redeploy, then run **Round 2** (再买一份 / Direct Pay / multi-instance
  concurrency / iOS·Android).
- PR #471 remains unmerged; `main` untouched. No high-risk (§七) actions were tested.
