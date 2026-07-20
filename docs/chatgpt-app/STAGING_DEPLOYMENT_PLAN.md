# STAGING_DEPLOYMENT_PLAN — Phase 3A → staging (PREPARE ONLY)

> This is a **preparation** document. **Do NOT deploy** without explicit owner authorization. No production
> deploy, no `main` merge, no Phase 3B until staging passes and is approved. **No secrets/credentials appear
> here — only environment-variable NAMES and configuration steps.** Frozen at `phase3a-complete-98e10c9`.

## 0. Preconditions
- PR #471 green in CI (all wired suites incl. the 7 newly-wired ETA/URI/manifest/card-contract tests).
- FINAL_PR_ADVERSARIAL_REVIEW: no BLOCKER/HIGH; M1+L1 fixed.
- Staging is a **separate Railway environment** from production — never share the production DB, OAuth app, or `WALLET_MASTER_SEED`.

## 1. Staging domain
- A dedicated staging host, e.g. `staging.webaz.xyz` (or a Railway-provided `*.up.railway.app`). Set via the platform; the PWA shell + widget `openai/widgetDomain` must resolve to this host (widget CSP `connect_domains: []` is empty by design — the widget makes no external calls).

## 2. Staging MCP URL
- `https://<staging-host>/mcp` (Streamable HTTP). Register THIS URL in the ChatGPT Developer-mode connector, not production. OAuth discovery is served from the same host (`/.well-known/oauth-*`).

## 3. Isolated database
- A staging-only SQLite volume (Railway persistent volume mounted at `/root/.webaz`, per the volume fix) OR a staging PostgreSQL if RFC-016 Phase-3 is being exercised. **Never** point staging at the production DB. Schema is applied at boot (ALTER-after-CREATE); verify the BUG-08 objects exist post-boot (`agent_idempotency_trace`, `ux_apr_submit_idem`, the 3 nullable columns) — the boot has a fail-closed index check.

## 4. Isolated OAuth configuration
- A **separate** OAuth client/registration for staging (DCR or manual). Env var NAMES only (values set in the Railway staging env, never committed): the OAuth issuer/base URL, signing key/seed name, and any client allowlist. `WEBAZ_OAUTH=1` to activate. Redirect URIs must be the staging host (ASCII-only, canonical-prefix validated).

## 5. Test accounts
- Create 2–3 **staging-only** buyer accounts + 1 seller account via the normal register flow (email verification is enforced — use a staging mailbox). Never use real user data or production credentials.

## 6. Test products
- Seed 3–5 staging products via the seller account: at least one with **stock=1** (for the stock-exhaustion second-purchase test), one **active** normal-stock, one to **delist** mid-test, and one for a **price change** test. Include a SG shipping template so ETA resolves.

## 7. Test seller
- One staging seller with a resolvable receiving configuration; for Direct-Pay tests, an `active` `direct_receive_accounts` row (bank/currency/label) — staging data only.

## 8. Test balance
- Fund the staging buyers' simulated wallets (escrow is a **simulated** custody in this build — not real USDC). Enough balance for a few escrow orders + a couple of failures.

## 9. Passkey testing
- Register a WebAuthn Passkey on the staging host for each test buyer (platform authenticator or a test security key). Passkey execution is the only path that creates a real order — the agent/widget cannot execute. Verify the approval deep-link (`/#agent-approvals/<id>`) opens and the Passkey prompt appears.

## 10. Escrow testing
- Full chain: search/quote → draft → submit → open approval → Passkey → order created (wallet→escrow debit at creation). Confirm the OrderTimeline card renders promised vs logistics ETA, status labels (v2), and USDC display.

## 11. Direct Pay testing — preconditions
- Direct Pay is globally gated + requires KYC/bond/account-age (≥30d) + a resolvable receiving account. Enable the staging Direct-Pay flag and satisfy the seller-eligibility gates BEFORE the DP happy-path test. If not enabled, DP is fail-closed (no payable order) — that fail-closed path is already unit-tested; the **enabled** happy path is what staging must confirm.

## 12. Logs & trace inspection
- Server logs on the staging host (Railway logs). Inspect `agent_idempotency_trace` directly (staging DB): each submit should write one row with `idempotency_key_hash` (16-hex, never the full key), `intent_hash_prefix` (12), `duplicate_reason`, `purchase_intent_instance`, `bridge_type`, timings — and **zero PII**. Confirm a retry shares `interaction_id`.

## 13. Data cleanup
- After each test cycle, reset the staging DB (drop the volume / re-seed) or delete the test rows. Do NOT accumulate test orders across cycles that could skew stock/idempotency state. Never export staging DB dumps containing test PII.

## 14. Rollback
- Staging is disposable: redeploy `main` (or the previous staging tag) to revert. Per-commit `git revert` is order-independent (projection/output/component + additive migration). The additive columns/index/table are inert if the code is reverted.

## 15. Control: NO production data on staging
- Hard rule: staging must never be pointed at the production DB, OAuth app, wallet seed, or user emails. Verify the staging env vars are the staging set (distinct issuer, distinct DB path/URL, distinct seed name) before first boot. A pre-boot checklist confirms `DATABASE_URL`/volume + OAuth issuer are staging.

## 16. ChatGPT Developer-mode connect steps
1. ChatGPT → Settings → Connectors → Developer mode (or Apps/MCP connector) → Add connector.
2. Enter the **staging** MCP URL (`https://<staging-host>/mcp`).
3. Complete the OAuth connect prompt (staging OAuth) → grant the buyer scopes.
4. In a chat, exercise: product search → 准备下单 (DIRECT_TOOL) → draft → 提交 Passkey 审批 → open approval → Passkey → order timeline; then trigger a duplicate (re-submit) and the 再买一份 chain.

## 17. iOS & Android test entry
- After web passes: the same staging connector in the ChatGPT iOS and Android apps. Verify card render, DIRECT_TOOL round-trip (does the host return the card-tool result to the widget so the 再买一份 chain advances?), and the fail-visible fallback when a host lacks `callTool`. These are the LIVE_HOST_REQUIRED items from KNOWN_LIMITATIONS.

## 18. Real concurrency test plan
- Two independent connections/sessions submitting the same operation simultaneously (e.g. two devices, or a scripted concurrent POST to `/api/agent/order-drafts/:id/submit`) → confirm exactly one active submit row + one order, and two genuinely-distinct `purchase_intent_instance` each succeed. On PostgreSQL staging, this exercises the real multi-writer path the single-writer SQLite unit test could not.

## Exit criteria (before proposing production)
All 18 above pass on staging web + iOS + Android; the trace shows zero PII; no double-order/double-charge under real concurrency; Direct-Pay enabled happy-path re-validates correctly. Then — and only with explicit owner approval — propose merge/production.
