# PHASE3_TEST_RESULTS

> Phase-3A local test results. All runs hermetic (temp `$HOME`), no network, no prod DB, no deploy. No live-ChatGPT verification claimed.

## Commands + results (rerun any)
```
npx tsc --noEmit                                  # exit 0 (whole project typechecks)
npm run guard:complexity                          # complexity ratchet OK (server.ts 55/55, 234/234)
npx tsx scripts/test-mcp-card-contract.ts         # pass 24  (BUG-01 truncation/full-terms + duplicate + schema)
npx tsx scripts/test-product-widget-expand.ts     # pass 43  (LOCAL_UI no-tool + 准备下单 DIRECT_TOOL + fail-visible)
npx tsx scripts/test-mcp-quote-approval-ui.ts     # pass 31
npx tsx scripts/test-mcp-order-timeline-ui.ts     # pass 23
npx tsx scripts/test-mcp-apps-standard.ts         # pass 45  (dual-rail bridge + visibility, quote_order now model+app)
npx tsx scripts/test-mcp-tool-annotations.ts      # pass 36
npx tsx scripts/test-product-presentation-ui.ts   # pass 19
npx tsx scripts/diagnose-mcp-card-matrix.ts       # 9 ✅ + 2 ⚠️ (checks 2 & 7 = expected design flags, not failures) + check 11 ✅
```

## What each new/changed assertion locks
- **card-contract T1–T13**: description/specs byte-capped WITH flags; `return_condition`/`ship_regions` boundary-capped WITH `*_truncated` flags (no silent truncation); UTF-8 never broken (no U+FFFD); `terms_complete`; `full_terms_fetch` replay reference with `full_terms:true` + threaded `result_handle`; full mode returns untruncated terms; short fields → no flags.
- **widget-expand B2-3/4/5**: 准备下单 issues exactly one structured `webaz_quote_order{product_id,quantity:1}` call, no NL follow-up when callTool is available, never a money-path tool; compare-row + throw-path still exercise the NL fallback.
- **diagnostic check 11**: all DIRECT_TOOL card tools (search/buyer_orders/order_draft/submit/quote_order) are app-visible.
- **apps-standard T-1**: quote_order dual-rail resources + visibility `['model','app']` (was `['model']`).

## §X invariant → result
| §X | invariant | result |
|---|---|---|
| 1 | LOCAL_UI emits no tool call | ✅ (widget-expand sort/expand assert no callTool) |
| 2 | DIRECT_TOOL emits one structured call | ✅ (B2-3, B4-5) |
| 3 | DIRECT_TOOL creates no NL chat message | ✅ (B2-4 `sent.length===0`) |
| 4 | DIRECT_TOOL independent of model tool-selection | ✅ structured args (code) |
| 5 | double-click → no duplicate call | ✅ onceGuard + disabled (code); submit server intent_hash |
| 6 | remount no double-listener | ✅ per-render iframe; ⚠️ in-place reboot LIVE_HOST |
| 7 | MODEL_REQUIRED has explicit reason | ✅ none at button level (documented) |
| 8 | large UI data not unconditional in ctx | ✅ minimal projection + on-demand fetch |
| 9 | app-only tools not in model list | ✅ WebAZ uses model+app (check 11) |
| 10 | no-UI host text fallback | ✅ content summary (card contract) |
| 11 | all 22(+1) buttons classified | ✅ MODEL_USAGE_ARCHITECTURE |

## Button test levels — summary
- CODE_INSPECTED: 4 · UNIT_TESTED / HOST_SIMULATED: 19 · CHATGPT_WEB/IOS/ANDROID: **0** (Phase 3B).

## Committed this phase (branch `fix/chatgpt-card-contract-phase3`, from `5b44137`)
1. `110a300` fix(chatgpt-card): preserve full product terms (BUG-01)
2. `801b39f` feat(chatgpt-card): Model-When-Necessary — 准备下单 becomes a DIRECT_TOOL call
3. (this docs commit) docs(chatgpt-app): Phase-3A interaction architecture + button classification + limitations

## Remaining Phase-3A (NOT done; Phase-3A is NOT complete)
BUG-02 (ETA snapshot + migration), BUG-04 (URI versioning), BUG-06 (status/quantity schema-version), BUG-07 (timestamp TZ), BUG-08 (duplicate semantics + trace telemetry wiring), BUG-09 (manifest version). Each is a money/state/schema change to be done as its own isolated, adversarially-reviewed, fresh-boot-verified step — gated on your go-ahead. Nothing is merged/pushed/deployed.
