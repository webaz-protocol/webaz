# PHASE3_IMPLEMENTATION_REPORT

> Phase-3A implementation status. Branch `fix/chatgpt-card-contract-phase3` from `5b44137`. **Nothing merged/pushed/deployed. No live-ChatGPT/iOS/Android verification.**
> Phase-3A is **partially complete**: 5 items landed & green; 4 remain (2 heavy money/state/schema, 1 medium wiring, 1 LIVE_HOST-gated). Honest per the grading discipline.

## 1. Final status per BUG
| item | status | commit |
|---|---|---|
| **BUG-01** full product terms | ✅ DONE (read-path) | `110a300` |
| **Model-When-Necessary** 准备下单 → DIRECT_TOOL | ✅ DONE | `801b39f` |
| §II verification (full-terms safety + fallback_reason) | ✅ DONE | `6d380a9` |
| **BUG-09** manifest protocol version | ✅ DONE | `2e2a654` |
| **BUG-07** timestamp ISO-8601-UTC | ✅ DONE | `14d185c` |
| **BUG-04** widget URI versioning | ⬜ NOT DONE — designed (RESOURCE_URI_MIGRATION.md) | — |
| **BUG-02** delivery-ETA snapshot + migration | ✅ DONE (Phase-3A.2A) | `0976128` `2c65d8a` `2a2fbba` `e72b418` |
| **BUG-06** status/quantity schema-version | ⬜ NOT DONE — designed (SCHEMA_MIGRATION.md §status) | — |
| **BUG-08** duplicate semantics + full trace | ⬜ NOT DONE — designed (IDEMPOTENCY_IMPLEMENTATION.md) | — |
| §XI two NL buttons (查看最新状态 / 联系商家) | ⬜ NOT DONE — designed below; LIVE_HOST-gated | — |

## 2. All commits (this branch, on top of Phase-2 `5b44137`)
```
14d185c fix(chatgpt-card): normalize wire timestamps to ISO 8601 UTC (BUG-07)
2e2a654 fix(chatgpt-card): honest, non-conflated manifest protocol version (BUG-09)
6d380a9 test(chatgpt-card): verify full-terms safety + DIRECT_TOOL fallback_reason (§II)
801b39f feat(chatgpt-card): Model-When-Necessary — 准备下单 becomes a DIRECT_TOOL call
110a300 fix(chatgpt-card): preserve full product terms (BUG-01)
```
Each is a normal single-parent commit → independently revertable (`git revert <sha>`).

## 3. Database migrations
**None this phase.** BUG-02 and BUG-06 (which need migrations) are not implemented. No schema change was made; fresh-boot migration verification is therefore N/A for what landed and is a prerequisite for BUG-02/06 when they are built.

## 4. Schema versions
Unchanged. `webaz.product_detail.model.v1` gained additive fields (BUG-01: `terms_complete`, `*_truncated`, `full_terms_fetch`) — additive, no version bump needed (schemas are open, no `additionalProperties:false`). BUG-06 (status/quantity) would bump versions; not done.

## 5. URI versions + old aliases
Unchanged (BUG-04 not done). Widget URIs remain unversioned. Design in RESOURCE_URI_MIGRATION.md.

## 6. Timestamp normalization
`toIsoUtc()` (agent-model-projection.ts) applied to `expires_at` (quote/draft), `fiat_estimate.as_of`, `timeline.deadline.iso`, `timeline[].at`, `refund.created_at/resolved_at`. Bare SQLite UTC → `…Z`; zoned passthrough; unparseable verbatim. Business deadlines unchanged.

## 7. ETA snapshot
Not implemented (BUG-02). Design in SCHEMA_MIGRATION.md §ETA.

## 8. Duplicate semantics
Unchanged (BUG-08 not implemented). Current behavior confirmed in Phase-2 IDEMPOTENCY_TRACE_AUDIT: durable idempotency reuses a live intent row; `intent_hash` excludes `draft_id`; 24h TTL. Target semantics + trace design in IDEMPOTENCY_IMPLEMENTATION.md.

## 9. Duplicate trace sample
Not emitted yet (BUG-08). Proposed record + `duplicate_reason` enum specified in IDEMPOTENCY_IMPLEMENTATION.md (default-off, zero-PII).

## 10. interaction_class of all buttons
See MODEL_USAGE_ARCHITECTURE.md §III (23 controls): LOCAL_UI 11, DIRECT_TOOL 10, DIRECT_TOOL-target-currently-NL 2, MODEL_REQUIRED(button) 0.

## 11. Paths still on NL fallback + why
- **查看最新状态** (`webaz_approval_requests`) and **联系商家** (`webaz_order_chat`): tools have no card and no app-visibility. The apps-standard invariant T-2 asserts only the 5 card tools carry `_meta.ui`; enabling app-call requires either a `widgetAccessible`-only marker (ChatGPT-target) or reworking that invariant, AND the result of a card-initiated call to a card-less tool renders via the model (LIVE_HOST-uncertain). Deferred to avoid rushing an invariant change; NL fallback records `fallback_reason` and is fail-visible. Design below.
- **准备下单** NL path is now a *fallback only* (host without callTool); primary is DIRECT_TOOL.

## 12. Test commands + results
See PHASE3_TEST_RESULTS.md. All green: tsc 0, complexity OK, card-contract 37, widget-expand 43, quote-approval 31, order-timeline 23, apps-standard 45, tool-annotations 36, presentation 19, manifest 8, http-edge 38, diagnostic 9✅+2 expected-flags.

## 13. Fresh boot
No schema change → `buildMcpServer` assembles and lists tools cleanly across all suites (repeated hermetic boots). Full PWA fresh-boot + `pg:schema` verification is a prerequisite for BUG-02/06 migrations (not yet built).

## 14. Independent adversarial review (self, this session — Codex capped till 2026-07-25)
Reviewed the money-adjacent landed changes; model = Claude (this session), read-only pass, no external second model. Findings:
- **BUG-07 (money-path projections):** `toIsoUtc` only changes *representation*; it never mutates `payable`, amounts, or the actual deadline instant (offset inputs convert to the same UTC instant — TZ4 proves it). Unparseable values pass through verbatim (no silent local reinterpret). Card `localTime()` already tolerated `Z`, so display is unchanged. **No fund/state impact.** ✅
- **BUG-01 (read-path):** `full_terms` rides the SAME guarded `/api/products/result-fetch` route (handle TTL, item-membership, active-visibility predicate, IP rate-limit) — it changes projection verbosity only, adds no auth bypass; full mode returns a whitelisted key set (FT3 proves no source_price/seller_id/internal_note/api_key leak). ✅
- **MWN (quote_order visibility):** widened `['model']`→`['model','app']` (additive); `webaz_quote_order` is an additive snapshot (no fund/stock/order) already consistent with draft/submit being app-callable; server-side auth/scope enforcement unchanged. Residual: cross-component render is LIVE_HOST. ✅ (bounded)
- **BUG-09:** advertisement only; capability negotiation (SDK handshake) untouched. ✅
- **Concurrency/idempotency/migration/rollback/permissions/sensitive-fields:** no new money/state/schema surface introduced this phase; BUG-02/06/08 (which do) are not implemented, so those risk classes are unchanged from Phase-2 baseline.
No blocking issues in what landed. The adversarial review did not modify code.

## 15. Unfinished items
BUG-04, BUG-02, BUG-06, BUG-08, and the two §XI NL-button conversions. Designs in the sibling docs; each is an independent commit gated on your go-ahead. BUG-02/06/08 are money/state/schema and additionally warrant a real second-model adversarial pass + fresh-boot when Codex returns.

## 16. Phase-3B (live-host) must-verify
Cross-component quote-card render; ChatGPT honoring `['app']`/`widgetAccessible` on the legacy path; skybridge vs profile=mcp-app requirement; enforced CSP/sandbox; the real duplicate incident (needs BUG-08 trace); all 3 cards on web+iOS+Android; whether card-less tools (approval_requests/order_chat) render acceptably when widget-called.

## 17. Deploy-to-staging requirements
Before any live verification: this branch must be built (`npm run build`) and deployed (`railway up --detach`, Dockerfile builder) to a **staging/non-prod** environment (prod has 40+ real accounts — never test mutations there). No env/secret change is needed for the landed changes (all default-safe). BUG-02/06 would additionally need their migration applied + fresh `pg:schema` verify.

## 18. Rollback
See ROLLBACK_PLAN.md. Summary: each commit reverts independently; the landed changes are behavior-additive (new fields / normalized representation / an additive DIRECT_TOOL path with NL fallback) — reverting any one restores prior behavior with no data migration to undo.

## §XII low-token acceptance (status)
1. LOCAL_UI no tool/model ✅ · 2. DIRECT_TOOL no NL ✅ (准备下单 proven) · 3. DIRECT_TOOL one structured call ✅ · 4. fallback only on host-incapability ✅ (fallback_reason) · 5. main chain one model point ✅ · 6–7. 查看最新状态/商家消息no-model ⬜ (still NL-fallback — §XI pending) · 8. subjective needs model ✅ · 9. large detail on-demand ✅ · 10. visibility not needlessly widened ✅ (only quote_order, additive).
Items 6–7 remain gated on the §XI conversion (LIVE_HOST).
