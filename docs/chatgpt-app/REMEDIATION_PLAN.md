# REMEDIATION_PLAN (Phase 3 direction only — NOTHING built here)

> Direction and file-impact for fixing the graded findings. No code changed in Phase 2. Each item lists the fix direction, files, risk, and whether a live-host check must precede it. Money/state/schema changes follow the repo's serial-PR + double-audit + Passkey rules; the biggest-blast-radius change goes last.

## Ordering principle
Ship the **honesty/completeness** fixes first (they only add data or flags), the **cache** fix next (URI versioning), and defer anything touching the **bridge/legacy dual-emit** until a live ChatGPT render confirms behavior. Do not migrate the SDK.

## P1 — data completeness / honesty (low blast radius, additive)
1. **BUG-01 truncation** — add a `return_condition_truncated` (and `ship_regions_truncated`) flag; surface a specs-truncated notice on the detail card; add an agent path to fetch full terms (or a stable PWA deep link).
   - Files: `src/agent-model-projection.ts` (projectProductDetail), `src/layer1-agent/L1-1-mcp-server/ui-widgets.ts` (detail render). New contract-test assertions.
   - Risk: low (additive fields; `additionalProperties` is open so no schema break). Live-host: not required.
2. **BUG-02 delivery ETA drift** — carry the quoted ETA into the order snapshot, OR render `trade_terms_snapshot.fulfilment.estimated_days` on the timeline card, AND add the missing ETA row to the OrderTimeline widget.
   - Files: decide between snapshot-write (`src/pwa/routes/orders-create.ts` + `orders` DDL — money/schema, heavier) vs card-read (`src/agent-model-projection.ts:362` timeline projection + `ui-widgets.ts:544-573`). Prefer the card-read path first (no schema/money change).
   - Risk: card-read = low; snapshot-write = medium (touches order creation + DDL → serial PR + double audit). Live-host: confirm on a real order card afterward.
3. **BUG-07 timestamps** — qualify wire timestamps with `Z`/offset at the projection layer.
   - Files: `src/agent-model-projection.ts` (expires_at/deadline/at/refund times). Risk: low. Live-host: not required.
4. **BUG-06 status shape** — document the object-vs-string split prominently in the outputSchema descriptions, or normalize. Risk: low; prefer documentation to avoid consumer breakage.

## P2 — caching / advertisement
5. **BUG-04 unversioned URIs** — version widget URIs (content hash) and keep the old URI as an alias; or set explicit cache semantics. Verify against the prior PWA no-cache lesson.
   - Files: `src/layer1-agent/L1-1-mcp-server/server.ts` (ListResources/ReadResource), tool `_meta` templates. Risk: medium (host may cache the resource list itself → coordinate with a redeploy). Live-host: confirm the new URI loads on ChatGPT before removing the alias.
6. **BUG-09 manifest protocol version** — refresh `remoteMcpManifest().protocol_version` to the negotiated current spec. Files: `src/pwa/routes/mcp-remote.ts:156`. Risk: trivial (advertisement only).

## P3 — observability (default-off; enables closing BUG-03)
7. **BUG-03 duplicate classification** — add a default-off, test-only diagnostic that logs, without PII, the JSON-RPC `id` (tool_call_id), `intent_hash` prefix, `duplicate`, and `reused_existing_request_id` so a real `duplicate=true` can be classified retry-vs-prior-intent.
   - Files: `src/pwa/routes/mcp-remote.ts` and/or the submit route, behind an env flag (mirror the shadow-limiter fail-soft pattern). Risk: low (off by default, no behavior change). This is the pre-req to turning BUG-03 from HIGH_CONFIDENCE into CONFIRMED.
8. **BUG-08 coarse intent_hash** — optional explicit "buy another identical" override that varies the intent (e.g. an intentional nonce the human confirms). Risk: touches money-path idempotency → serial PR + double audit; only if product wants a real second-identical-order flow.

## Deferred / do NOT do in Phase 3
- **BUG-05 dual-emit divergence** — do NOT collapse `openai/outputTemplate` and `_meta.ui.resourceUri` to one resource until a live ChatGPT render confirms ChatGPT tolerates the standard resource. It is plausibly load-bearing.
- **Legacy Skybridge removal** — do NOT remove; ChatGPT currently loads it. Removal is gated on a live-host confirmation that ChatGPT honors the standard resource.
- **SDK migration to `@modelcontextprotocol/ext-apps`** — NOT recommended. The hand-rolled bridges are ~150 lines, single-flight-safe, CSP-clean, and already tested (`test-mcp-apps-standard.ts` + the new diagnostic). Migrating adds a dependency and a CSP/bundling surface with no proven benefit. Rollback path if ever attempted: the SDK is additive; keep both resources and switch `_meta` per host behind a flag. Revisit only if a real cross-host incompatibility appears.

## Live-host confirmations to schedule (blockers for acceptance, not for these fixes)
Real ChatGPT web + mobile render of all 3 cards; enforced CSP/`sandbox`; which template key ChatGPT honors; the duplicate-incident classification (after P3-7 ships). See MISSING_RESOURCES.md §B/§C.

## Test additions per fix
Every P1–P3 change lands with a contract-test assertion in `scripts/test-mcp-card-contract.ts` (or a new `test-*`), wired into `ci.yml` in the same PR (per the repo rule that new `test:*` must be manually added to CI). The Phase-2 diagnostic (`diagnose-mcp-card-matrix.ts`) should be promoted to a CI check so wiring regressions (checks 1–10) fail the build.
