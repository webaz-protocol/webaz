# ROLLBACK_PLAN (Phase-3A)

> All landed changes are on branch `fix/chatgpt-card-contract-phase3`, unmerged/unpushed/undeployed. Rollback here means reverting a commit before merge, or reverting after a hypothetical staging deploy.

## Landed commits (each reverts independently, no data migration to undo)
| commit | change | revert effect | data undo? |
|---|---|---|---|
| `110a300` BUG-01 | detail projection adds truncation flags + full_terms mode; card full-terms button | detail reverts to prior byte-cap (silent); `full_terms` arg ignored (unknown args are dropped) | none — read-path, no writes |
| `801b39f` MWN | quote_order `+app` visibility; 准备下单 direct-call | 准备下单 reverts to NL follow-up; quote_order back to model-only | none — no writes |
| `6d380a9` §II | tests + fallback_reason observability | loses fallback_reason log + tests | none |
| `2e2a654` BUG-09 | manifest version fields | manifest reverts to `protocol_version:'2025-03-26'` | none — advertisement only |
| `14d185c` BUG-07 | `toIsoUtc` on wire timestamps | timestamps revert to bare passthrough | none — representation only |
| (BUG-04) | content-versioned widget URIs + bare aliases | tool `_meta`/ListResources revert to bare URIs; ReadResource still served both (aliases) so no card 404s mid-revert | none — URIs only; no data |
| `0976128` BUG-02 migration | + `promised_eta_snapshot TEXT` on orders/order_quotes/order_drafts | revert leaves the (nullable, unread) columns harmless; or drop-column via a follow-up (SQLite: rebuild). No data to undo. | none — additive nullable, no backfill |
| `2c65d8a` BUG-02 freeze | quote/draft/order freeze + read | revert → quote shows live ETA again; the stored snapshots become unread (harmless). No money/status/deadline change to undo. | none |
| `2a2fbba` BUG-02 card | OrderTimeline promised/logistics ETA lines | revert → card drops the ETA lines (prior behavior). | none |
| `e72b418` BUG-02 F1 | normalize quote region for fee+ETA | revert → mis-cased regions fall back to the pre-existing (inconsistent) fee/ETA tiering. | none |
| BUG-06 (`1d82a73`+`cd0eeeb`+`7ba21af`+`ef61fbd`) | v2 card contract (type + status object + posInt quantity) in the projection layer + component v1/v2 rendering | revert → projections emit v1 again; v2 cards already in chat history hit the "不支持此旧卡片版本" safe message (no partial render). **No DB migration** — projection/output/component only. | none — no writes, no schema change |
| BUG-06 quantity-safety (`projectQuantity`) | invalid quantity → explicit `quantity_valid:false`+`quantity_error` (never faked to 1); card 数量数据异常 + disabled buttons | revert → invalid quantity falls back to the prior `toPosInt` fake-1 behavior (display only; amount always was `price.amount_minor`) | none — display/diagnostic only |
| BUG-08 migration (`b8e3569`) | +idempotency_key/purchase_intent_instance/operation_attempt_id (nullable) + `ux_apr_submit_idem` partial index + `agent_idempotency_trace` table | revert leaves the columns/index/table inert (unread); or drop them via a follow-up. No backfill, no data to undo. | none — additive nullable + partial index + new table |
| BUG-08 submit semantics (`f520988`) | three-layer identity + duplicate_reason + `new_purchase_intent` intent-hash fold | revert → submit reverts to the prior draft+intent dedup (implicit repeats still deduped; no client key, no explicit second-purchase). No money/status/exec change to undo. | none — pre-execution submit row only |
| BUG-08 trace (`409569a`) | zero-PII `recordIdempotencyTrace` wired into the submit route | revert → the diagnostic rows stop being written (fail-open; the trade path never depended on them). | none |
| BUG-08 UI (`8f69530`) | approval card per-reason text + 3 actions | revert → the card shows the prior generic duplicate warning; buttons unchanged. | none — component only |

**Full-branch rollback:** `git checkout main` (branch never merged) — production is entirely unaffected (nothing deployed).

**Single-commit rollback:** `git revert <sha>` on the branch. Order-independent because the changes touch disjoint concerns (projection representation, manifest advertisement, tool visibility). Re-run the suite after any revert.

## If a change were deployed to staging and misbehaved
- **BUG-07** (timestamps): a downstream consumer that strictly parsed the old bare format would now see `…Z`. The card's `localTime()` already handles both; if an external consumer breaks, `git revert 14d185c` + redeploy restores bare passthrough. No stored data changed (normalization is at projection time, not at write time).
- **MWN** (准备下单 direct-call): if a host mis-renders the cross-component quote call, the NL fallback + copyable phrase already cover the user; to fully revert to NL-primary, `git revert 801b39f`. quote_order `+app` is additive and safe to keep or drop.
- **BUG-01** (`full_terms`): if the full-terms fetch surfaced a field it shouldn't (it can't — whitelisted, FT3), `git revert 110a300` removes the mode; the summary/truncation still functions.
- **BUG-09**: advertisement only; revert is cosmetic.

## Not-yet-built items (BUG-02/04/06/08) — rollback preconditions to design NOW
- **BUG-02 / BUG-06** (DB migrations): must be **backward-compatible, additive** migrations (new columns, `IF NOT EXISTS`), so rollback = revert the code; the added columns are harmless if unread. **Never** backfill historical rows with current-listing values (show "下单时未记录"). Fresh-boot + `pg:schema` verify before merge.
- **BUG-08** (duplicate trace): a new append-only diagnostic table + `duplicate_reason`; default-off. Rollback = disable the flag; the table is inert.
- **BUG-04** (URI versioning): keep old URIs as read aliases so historical cards resolve; rollback = point tool `_meta` back to bare URIs (aliases keep both live during transition).

## Iron rules preserved
No legacy Skybridge removed, no template-key merge, no ext-apps SDK, no forced ChatGPT bridge switch, no prod deploy, no `main` merge. `webaz_quote_order` visibility only widened (never narrowed).
