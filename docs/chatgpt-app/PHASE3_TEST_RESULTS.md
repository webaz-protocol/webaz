# PHASE3_TEST_RESULTS

> Phase-3A local test results. All runs hermetic (temp `$HOME`), no network, no prod DB, no deploy. No live-ChatGPT verification claimed.

## Phase-3A.2A run (BUG-02 delivery-ETA snapshot)
```
tsc 0 · complexity OK · diagnostic 10✅
test-delivery-eta            23   (region selection exact/wildcard/product/none · parse · round-trip · legacy · no-PII)
test-eta-migration           21   (additive · NULL-not-backfilled · money/status/deadline untouched · idempotent · fresh+upgrade boot)
test-eta-snapshot-flow       13   (freeze@quote → inherit draft → inherit order · drift-immune · promised≠logistics · legacy_missing · F1 case fix)
test-buyer-quote             59 · test-order-draft 28 · test-buyer-order-full 28 · test-shipping-templates 25 · test-mcp-place-order-rail 13
test-mcp-order-timeline-ui   24   (+E1: promised vs logistics ETA distinction)
(all Phase-3A/3A.1 suites still green: card-contract 37, widget-expand 43, apps-standard 55, uri-versioning 11, direct-tool-buttons 12, …)
```
Commits: `0976128` migration · `2c65d8a` freeze chain · `2a2fbba` card · `e72b418` F1 region-normalization + docs. Adversarial review clean (BUG02_ADVERSARIAL_REVIEW.md). No deploy, no BUG-06/BUG-08, no live-host verification.

---
## Phase-3A.1 run (BUG-04 URI versioning + two NL buttons → DIRECT_TOOL)
```
tsc --noEmit                        exit 0
guard:complexity                    OK
test-mcp-card-contract              pass 37
test-product-widget-expand          pass 43
test-mcp-quote-approval-ui           pass 31
test-mcp-order-timeline-ui           pass 23
test-mcp-apps-standard               pass 55   (BUG-04 version-agnostic + bare-alias R-5; §III renders/callable decoupling T-2/2b/2c)
test-mcp-tool-annotations            pass 36
test-mcp-tool-surfaces               pass 25
test-product-presentation-ui         pass 19
test-mcp-manifest-version            pass 8
test-mcp-http-edge                   pass 38
test-mcp-uri-versioning              pass 11   (URI-hash===sha256(HTML), content→version, dangling-ref, bare alias, bogus reject)
test-mcp-direct-tool-buttons         pass 12   (查看最新状态 + 联系商家 read/send: no-model, single-flight, idempotency, no sensitive-field, fallback_reason)
diagnose-mcp-card-matrix             10 ✅ + 1 expected flag (check 2 = design) ; check 7 now ✅ (versioned) ; check 11 ✅
```
Commits added: `8cc6259` BUG-04 URI versioning · `a04ccd7` two NL buttons → DIRECT_TOOL. Natural-language round-trip buttons now **0**. Interaction_class: LOCAL_UI 12 / DIRECT_TOOL 14 / target-NL 0 (26 controls). **No deploy, no real chat message sent, no live-ChatGPT verification.**

---
## Latest run (Phase-3A — 5 commits landed)
```
tsc --noEmit                       exit 0
guard:complexity                   OK (server.ts 55/55, 234/234)
test-mcp-card-contract             pass 37   (BUG-01 truncation/full-terms/FT-safety + BUG-07 TZ1-9 + duplicate + schema)
test-product-widget-expand         pass 43   (LOCAL_UI no-tool + 准备下单 DIRECT_TOOL + fallback_reason path)
test-mcp-quote-approval-ui         pass 31
test-mcp-order-timeline-ui         pass 23
test-mcp-apps-standard             pass 45   (quote_order now model+app)
test-mcp-tool-annotations          pass 36
test-product-presentation-ui       pass 19
test-mcp-manifest-version          pass 8    (BUG-09 protocol version)
test-mcp-http-edge                 pass 38
diagnose-mcp-card-matrix           9 ✅ + 2 expected flags (checks 2 & 7) + check 11 ✅
boot smoke                         buildMcpServer assembles + lists 55 tools (repeated across suites)
fresh-boot migration               N/A this session (no schema change landed; prerequisite for BUG-02/06)
```
Commits (on `5b44137`): `110a300` BUG-01 · `801b39f` MWN 准备下单 · `6d380a9` §II verify · `2e2a654` BUG-09 · `14d185c` BUG-07 · (docs). **Remaining: BUG-04, BUG-02, BUG-06, BUG-08, §XI two NL buttons** — see PHASE3_IMPLEMENTATION_REPORT §15.

---
## Earlier snapshot (interaction-architecture commit)

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
