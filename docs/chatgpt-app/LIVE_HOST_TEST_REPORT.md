# LIVE_HOST_TEST_REPORT — Phase 3B Round 1 (production canary)

> Round 1 executed 2026-07-21 against production `webaz.xyz`, deployment `5daf7d25-…`
> (built from tag `phase3a-ci-green-8cdd3db`, commit `8cdd3db`). PR #471 unmerged, `main` untouched.
> Rollback target deployment: `194f6854-1fd4-4cc6-9718-fbca48b7d977`.

## How this round was run (division of labor)

The end-to-end **live ChatGPT-host + Passkey** leg is, by design, only completable by a present
human (OAuth login + WebAuthn Passkey are the security invariant; platform rules and the round's own
boundary §一.2 forbid the agent handling Tina's token/credentials or approving her Passkey). So the
canary was executed on three tracks:

- **Track A — production live, unauthenticated (agent-run):** protocol surface, anonymous search,
  card/resource contents, auth-gate rejection, health, logs, read-only DB integrity.
- **Track B — money-path logic at the deployed commit (agent-run):** the full automated suite for
  steps 3–9 invariants, run against an ephemeral isolated DB at `8cdd3db` — the exact code prod runs.
  No production data, no Passkey.
- **Track C — real live Passkey→order (human-only):** EXECUTED and PASSED this round. The agent drove
  search→quote→draft→submit via the model-initiated path (browser automation of the user's already-authenticated
  ChatGPT session); the human (owner, confirmed "是我点击了") completed the WebAuthn Passkey, which created
  exactly one order. See §Track C result below.

## Baseline (START 2026-07-21T00:33:32Z)

users 50 · orders 42 · order_quotes 18 · order_drafts 13 · agent_permission_requests 11 ·
agent_idempotency_trace 0. Test account **Tina** (`usr_…08`, handle `tina`, buyer, verified):
wallet balance **944.98**, Σ escrow_amount **75.14**, 40 pre-existing orders (not an empty account —
all deltas isolated by append + row linkage, never by "0→1"). Backup present:
`/root/.webaz/backup-pre-phase3a-8cdd3db.db` = 125,513,728 B.

## §二 Pre-checks — PASS
Online (no restart loop) · /health 200 · MCP initialize `dcp-protocol 0.1.33` / tools 21 / resources 10 ·
OAuth discovery 200 · deployment still `8cdd3db` · rollback deployment available · backup present.

## §三 Host surface (Track A) — PASS
Content-hash resource URIs confirmed (`webaz-products.c4bd5e13bb`, `webaz-quote-approval.6a2e96dfb1`,
`webaz-order-timeline.5ea1e0d365`). Dev-text leak scan (outputSchema / OAuth scope / RFC / tools-list /
securitySchemes / Bearer) = **none** on all three cards. `tool_call_id/mcp_request_id/trace_id/
widget_session_id/bridge_type` = **HOST_NOT_PROVIDED** (agent cannot observe ChatGPT-host internals;
requires the human live session — deferred to Track C).

## §四 Step results

| Step | Track A (live) | Track B (suite @8cdd3db) | Verdict |
|---|---|---|---|
| 1 商品搜索 | anon strict search → 0 hits (see F2); no 500, no PII | — | PASS w/ note F2 |
| 2 商品详情 | — | (card-contract, uri-versioning) PASS | PASS (suite) |
| 3 报价 quote | **live**: Tina made 5 real quotes, priced correct (19.9 WAZ, escrow, qty1), 0 downstream | buyer-quote, shipping-quote, mcp-quote-approval-ui PASS | PASS w/ note F1 |
| 4 草稿 draft | — | order-draft PASS | PASS (suite) |
| 5 提交审批 + 幂等 | auth-gate fail-closed on anon submit (no write) | order-submit-approve, bug08-idempotency, second-purchase-widget-flow, restart-concurrency, execution-revalidation PASS | PASS (suite); live Passkey→order NOT run |
| 6 审批状态 read | — | approval-requests-read, approval-detail-endpoint, approval-window PASS | PASS (suite) |
| 7 查看订单 | — | (order-detail-return-inline) PASS | PASS (suite); live NOT run |
| 8 ETA 冻结 | — | delivery-eta, eta-snapshot-flow, eta-migration PASS | PASS (suite) |
| 9 联系商家 read | — | quote-approval-failvisible PASS | PASS (suite) |

Track B full matrix: **27/27 PASS** (buyer-quote, shipping-quote, order-draft, order-submit-approve,
bug08-idempotency, bug08-second-purchase-widget-flow, bug08-restart-concurrency,
bug08-execution-revalidation, approval-requests-read, approval-detail-endpoint, approval-window,
delivery-eta, eta-snapshot-flow, eta-migration, bug08-trace-propagation,
economic-currency-consistency, currency-display, currency-schema-flip, purchase-terms,
mcp-card-contract, mcp-uri-versioning, mcp-manifest-version, mcp-security-schemes, remote-mcp,
mcp-quote-approval-ui, quote-approval-failvisible, order-detail-return-inline).

## §Track C result — real live Passkey→order (PASS, money-safe)
One order created on prod via genuine WebAuthn. Timeline: apr created 01:11:24 → webauthn_challenge 01:11:34 →
human Passkey (owner-confirmed "我主动做了passkey验证") → apr approved+executed 01:11:50 → order created.
- Order `ord_8e32…96dd`: buyer=tina, qty 1, total 19.9, escrow 19.9, rail escrow, draft_id `odr_6aa2…24e5`.
- APR `apr_36c0…a403`: status approved, kind order_submit, execution_result.order_id = `ord_8e32…` → **request_id↔order_id 1:1**.
- Draft `odr_6aa2…` status=**ordered** (consumed — re-order blocked). **ORDERS_FROM_THIS_DRAFT=1** (no duplicate).
- Trace row `idt_bb08…`: tool webaz_submit_order_request, `idempotency_key_hash=64c3c0b4…` (hashed, not raw),
  `intent_hash_prefix=10e73c64…`, duplicate=0, result_status=created — **PII_LEAK=NONE**. Host-context fields
  (trace_id/interaction_id/widget_session_id/bridge_type/tool_call_id/mcp_request_id) all null = HOST_NOT_PROVIDED
  (ChatGPT does not pass them on the model-initiated path; not a defect).

## §五/六 Money-safety (live prod, final vs baseline)
- orders **42→43** (+1, one genuine Passkey-gated order) · drafts **13→14** · apr **11→12** · trace **0→1**
- order_quotes 18→**24** (+6: your 5 exploratory + 1 model-triggered this run, one shared intent_hash)
- Tina balance **944.98→925.08** (exactly one 19.90 escrow debit) · Tina orders 40→41
- request_id↔order_id **1:1 confirmed live** · draft consumed · trace **zero-PII confirmed live**
- /health 200 · 0 error-ish log lines · no restart loop
- **No duplicate approval/order/charge. No abnormal amount. No migration/auth anomaly. Passkey was genuine
  (webauthn_challenge present + owner-confirmed). Rollback NOT triggered.**
- Observation: order advanced paid→shipped within ~1–2 min (owner is the seller `holden` — likely seller-side/auto
  advance; not a money-safety issue; confirm it was expected).

## Findings
- **F1 (low)** — 5 clicks of 准备下单 on the same product produced 5 `order_quotes` rows with an identical
  `intent_hash`, none consumed. No money risk (order idempotency is enforced at draft/submit, confirmed by
  the suite), but quote regenerates per click rather than reusing the live unconsumed quote. Candidate: dedupe
  or reuse an unexpired unconsumed quote for the same intent_hash. Not a stop-condition.
- **F2 (medium, known design)** — anonymous `webaz_search` returns 0 for every query incl. exact titles,
  because the live dropship products sit on `category_id="cat_default"` (unpublished category) and search is
  strict-match/no-fuzzy by design (0-hit → recovery guidance to PWA #discover). Discoverability limitation,
  not a Phase-3A regression. Fix path is data/config (assign published categories/keywords) + optional
  matcher review — tracked separately from the order-chain work.

## Not tested this round (Track C — human-only, and §七 forbidden)
- Real live Passkey→order end-to-end on prod (steps 5–8 executed live): needs Tina's Passkey; **no prod order
  was created**. This is the one leg only the human can complete.
- §七 forbidden and honored: 再买一份, Direct Pay success path, sending a merchant message, address change,
  confirm receipt, returns, disputes, refund, any non-test-product purchase.

## Can we proceed to the next round?
- **Server-side confidence: high** — money-path logic is 27/27 green at the deployed commit; live prod is
  healthy, money-safe, and the auth gate is fail-closed.
- **Gate: the real live Passkey→order confirmation (Track C) still needs one human pass** before promoting to
  再买一份 / message-send / Direct Pay / iOS-Android / multi-instance concurrency. Minimal runbook: connect as
  Tina → 准备下单 on a test product → create draft → submit → **Passkey once** → confirm exactly one order +
  one escrow debit; the agent captures the DB deltas around it.
