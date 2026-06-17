# WebAZ Open-Source First Tasks (16) / 开源首批 Agent-ready 任务清单

> Purpose: the first public task pool when the repo opens (code-public). Load into the
> `webaz_contribute` task board. Shape: **5 × 30–60 min · 5 × 2–4 h · 3 × tests/audit · 2 × small RFC**
> + **1 flagship feature** (T16, OAuth identity linking — high-audit, maintainer-led; see note below).
> Tasks **T1–T15** all "use an **existing** protocol capability to verify / transform / document / wrap" —
> **never the core logic itself**. **T16 is the deliberate exception**: it implements a new auth/identity
> capability (per [RFC-019](rfcs/RFC-019-github-oauth-identity-linking.md)) and therefore is **NOT** a
> low-risk entry task — it is **high-risk, human-in-the-loop, not auto-claimable, maintainer-led**, with the
> iron-rule / Passkey / human-presence core protected in `forbidden_paths`.
>
> Status: **draft for maintainer review** → after review, load into `webaz_contribute`.
> The p2p canonicalization rule (§B) is confirmed against source and baked into T6/T8/T11.

---

## §A Global restricted boundary (inherited by every task's `forbidden_paths`)

Do **not** touch: wallet / payment / escrow · auth/permission core · DB migrations · order state
machine · `content_hash` trust-root core logic · content-admission allowlist · incentive accounting /
anti-sybil · iron rules (`requireHumanPresence`) · WebAuthn/Passkey · KYC · `matching_rewards`
activation switch. What's open is "use protocol tools to verify / transform / document / wrap" — **not the
core itself**.

## Common rules (apply to every task; not repeated per-task)

- `reward_eligibility: eligible`; `economic_value: uncommitted` (records contribution; **no amount promised**).
- Submit = DCO sign-off; **`done` ≠ merge** — a human maintainer reviews/merges.
- PRs MUST target the canonical WebAZ repo.
- Big-company employees: personal time only; follow your employer's open-source/IP policy; **never** submit
  a prior employer's code / internal designs / confidential info.
- `task_type` is from the `webaz_contribute` enum: `docs | i18n | tests | sdk_example | ui | code | api |
  schema | infra | governance | audit | other`.

---

## §B Canonical-JSON spec — the shared foundation for T6 / T8 / T11 (READ FIRST)

The protocol does **not** compute the p2p `content_hash` server-side: `POST /api/p2p-products` takes the
seller's `content_hash` (64-hex) + `content_signature` and only verifies the signature
(`HMAC-SHA256(api_key, content_hash + '|' + content_signed_at)`). The buyer fetches content from
`peer_endpoint` and checks `sha256(canonical) === content_hash` **client-side**. So for buyer/seller hashes
to match, both MUST canonicalize **identically**. WebAZ's established canonical idiom is
**`src/layer0-foundation/L0-2-state-machine/order-chain.ts` → `canonicalSerialize`** (byte-identical copies
in `src/layer2-business/L2-9-contribution/github-credential/canonical.ts` and
`src/layer1-agent/L1-2-external-anchor/anchor-engine.ts`; a no-drift test guards equivalence). Adopt it
**exactly**:

```js
function canonicalSerialize(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonicalSerialize).join(',') + ']'
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort()                       // recursive, every depth
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalSerialize(obj[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}
// content_hash = sha256_hex(canonicalSerialize(content))
```

**Exact behavior an implementer in any language MUST reproduce byte-for-byte:**
1. **Recursive object-key sort** at every nesting depth, ordered by **UTF-16 code unit** (JS `Array.sort()`
   default — NOT Unicode code point, NOT locale). For ASCII keys this equals byte order; for non-ASCII keys
   it differs. **Recommendation: restrict object keys to ASCII** to keep cross-language sorting trivial.
2. **Arrays preserve element order** (never sorted); each element is recursively canonicalized.
3. **`null` is KEPT**, emitted as `null` — **do NOT drop nulls** (the `webaz_p2p_product` tool description's
   "drop nulls" is inaccurate; this spec is authoritative). A key whose value is **`undefined` is forbidden**
   — omit the key entirely or use `null` (the serializer would otherwise emit invalid `"k":undefined`).
4. **String escaping = JSON.stringify rules**: escape `"`, `\`, and control chars U+0000–U+001F (short
   escapes `\n \t \r \b \f`, else `\uXXXX`); **do NOT escape `/`**; **do NOT `\u`-escape non-ASCII** — emit
   UTF-8 as-is. Cross-language gotchas: Python `json.dumps(..., ensure_ascii=False, separators=(',',':'))`;
   Go `encoding/json` — disable HTML escaping (`SetEscapeHTML(false)`); never pretty-print.
5. **No insignificant whitespace** anywhere (`:` and `,` have no surrounding spaces).
6. **Numbers = JS `Number→string`** (shortest round-trip repr; values ≥ 1e21 use exponential; `NaN` /
   `Infinity` → `null`; `-0` → `0`). **Prefer integers** — WebAZ money is integer base-units (RFC-014);
   if a float is unavoidable, the content spec must define its formatting. Avoid floats in canonical content.

**Conformance gate (mandatory for T6/T8/T11):** because the protocol does not compute this hash, the
**shared fixture set IS the contract**. Each of T6/T8/T11 must include a **no-drift test** that diffs its
canonical output against the `order-chain.ts` `canonicalSerialize` on a shared fixture set covering: nested
objects, key reordering, arrays (with nested objects), `null` values, non-ASCII strings, and integer
prices. A produced `content_hash` must round-trip through the protocol's signature verify.

---

## §C Group A — 5 × 30–60 min (low risk, entry-level)

### T1 — Document the public protocol manifest (`/.well-known/webaz-protocol.json`)
- **task_type**: docs · **risk**: low
- **summary**: Field-by-field documentation of the public protocol manifest (generated by
  `src/layer0-foundation/L0-5-manifest/manifest.ts`): what each key means, which are trust anchors, and how
  an integrator / agent should read it (capability discovery, version axes, network state).
- **allowed_paths**: `docs/manifest-reference.md` (new)
- **forbidden_paths**: any code; do not change the manifest generator
- **acceptance_criteria**: every current manifest field documented + accurate vs the generator output; trust-anchor fields flagged; no field invented that the generator doesn't emit
- **verification_commands**: fetch `/.well-known/webaz-protocol.json` (local) and diff the field list against the doc
- **expected_output**: one markdown reference doc
- **dependencies**: none

### T2 — i18n: complete one missing language on the public discover page
- **task_type**: i18n · **risk**: low
- **summary**: Add a missing-language (en/ja/ko — pick one) translation for the public `#discover` UI strings, against the existing zh/en keys in `src/pwa/public/i18n.js`.
- **allowed_paths**: `src/pwa/public/i18n.js` (translations only)
- **forbidden_paths**: any logic; any string implying earnings/recruiting (translate only already-reviewed neutral copy)
- **acceptance_criteria**: target-language keys map 1:1 to zh with no gaps; introduces **no** recruiting / income-promise wording; `npm run check:pwa-syntax` green
- **verification_commands**: `npm run check:pwa-syntax` (+ T13's audit once it exists)
- **expected_output**: the completed i18n entries
- **dependencies**: none

### T3 — Agent usage example for one read-only MCP tool
- **task_type**: docs · **risk**: low
- **summary**: Pick a read-only MCP tool (`webaz_search` / `webaz_get_status` / `webaz_leaderboard`); write "how an agent calls it + typical input/output + one common misuse," grounded in the tool's actual schema.
- **allowed_paths**: `docs/mcp-examples/*.md` (new)
- **forbidden_paths**: any code; nothing about "bypassing" money/auth tools
- **acceptance_criteria**: example is reproducible + matches the tool schema; states the tool's auth requirement; calls out 1 real misuse
- **verification_commands**: human cross-check example vs tool schema
- **expected_output**: one markdown doc
- **dependencies**: none

### T4 — README structure guide + badges
- **task_type**: docs · **risk**: low
- **summary**: Add a top-level directory guide (one line of responsibility per top dir) + CI/license badges to lower onboarding cost.
- **allowed_paths**: `README.md`, `docs/STRUCTURE.md` (new)
- **forbidden_paths**: any code; do not surface internal-only strategy doc contents
- **acceptance_criteria**: the directory guide matches the real tree; badge links valid; references no internal-only doc
- **verification_commands**: human cross-check the dir list vs the repo
- **expected_output**: updated README + STRUCTURE.md
- **dependencies**: none

### T5 — Typed-error-code reference doc
- **task_type**: docs · **risk**: low
- **summary**: Pick one group of existing typed outcomes (e.g. the GitHub fetch-adapter's `timeout` /
  `auth_required` / `malformed_response` …) and document, per code, "what it means + how an agent should
  handle it" — **document existing codes only, no code change**.
- **allowed_paths**: `docs/error-codes.md` (new)
- **forbidden_paths**: any error-logic code; do not add/change any code value
- **acceptance_criteria**: covers all existing codes in that group; each meaning matches the actual trigger condition in source; handling advice is sound
- **verification_commands**: human cross-check doc code list vs the source outcome enum
- **expected_output**: one error-codes doc
- **dependencies**: none

---

## §D Group B — 5 × 2–4 h (low–medium risk)

### T6 — content_hash verification SDK (one language)
- **task_type**: sdk_example · **risk**: low
- **summary**: A reusable library (TS first; or Python/Go) exporting `canonicalize()` + `verifyContentHash(endpoint, expectedHash)` for agents to verify p2p content. **Implements §B exactly.**
- **allowed_paths**: `sdk/p2p-verify/` (new; sibling of the existing `sdk/agent-template/`)
- **forbidden_paths**: the `content_hash` **generation/admission** core in `src/` (only reuse the rule to *verify*)
- **acceptance_criteria**:
  - `canonicalize()` is **byte-identical** to `order-chain.ts` `canonicalSerialize` on the §B fixture set (no-drift test included)
  - tampering any field → verify fails; key reorder → hash unchanged; arrays keep order; `null` kept; non-ASCII string handled per §B.4
  - follows §B points 1–6 precisely (recursive sort, array order, null/undefined, escaping, no-whitespace, numbers)
- **verification_commands**: `npm test` (SDK) green, incl. the no-drift diff vs the src serializer
- **expected_output**: SDK package with tests + README citing §B
- **dependencies**: §B (this doc)

### T7 — seller-export → list_product field-mapping skill (one platform)
- **task_type**: sdk_example · **risk**: medium
- **summary**: A skill/script: input a seller's **own export** (Taobao/Shopify — pick one) CSV/JSON; parse and map to `webaz_list_product` fields (title/price/stock/specs/…); output a publish-ready structure.
- **allowed_paths**: `examples/catalog-import-<platform>/` (new; avoid `skills/` — that name collides with the runtime skill-market concept)
- **forbidden_paths**: any **scraping** of external platforms (accept seller-exported files only); payment/inventory core
- **acceptance_criteria**:
  - sample export → correct mapping to list_product fields
  - missing fields → `null`/default, **never invented** (never-guess)
  - explicit error on "export format mismatch" (no silent swallow)
  - 🔴 doc states "only processes the seller's own exported data, not scraping"
- **verification_commands**: `node examples/catalog-import-<platform>/test.js` (bundled sample export)
- **expected_output**: parse skill + sample file + mapping doc
- **dependencies**: T15 (mapping standard) helpful but not blocking

### T8 — seller p2p endpoint reference implementation (seller-side static host)
- **task_type**: sdk_example · **risk**: medium
- **summary**: A minimal "seller p2p endpoint": a static service returning product-detail JSON by `product_id`,
  plus a helper that computes `content_hash` + `content_signature` per **§B** and
  `HMAC-SHA256(api_key, content_hash + '|' + content_signed_at)`. Lets a seller run an agent-fetchable,
  verifiable endpoint.
- **allowed_paths**: `examples/seller-p2p-node/` (new)
- **forbidden_paths**: `src/` core; WebAZ-side anchoring/admission (seller-side reference only)
- **acceptance_criteria**:
  - `GET /<product_id>` returns valid JSON
  - the helper's `content_hash` (§B canonical) verifies via T6/T1 and via the protocol's signature check
  - signature rule matches `webaz_p2p_product` exactly: `HMAC-SHA256(api_key, content_hash + '|' + content_signed_at)`
  - README: local start → cloud migration; cites §B as the canonical-hash source of truth
- **verification_commands**: start service + verify a fetched product via the T6 SDK
- **expected_output**: reference impl + hash/sign helper + README
- **dependencies**: §B; pairs with T6
- **note**: this reference impl effectively publishes the seller-side canonicalization convention — keep it §B-conformant so all sellers/buyers agree.

### T9 — anti-oversell config end-to-end example (existing fields)
- **task_type**: sdk_example · **risk**: medium
- **summary**: Example + doc showing how to use list_product's existing `auto_delist_on_zero` /
  `low_stock_threshold` to prevent oversell: publish → simulate stock→0 → auto-delist → document the trigger.
  **Uses existing fields; does not change inventory core.**
- **allowed_paths**: `examples/inventory-guard/` (new), `docs/inventory-guard.md`
- **forbidden_paths**: inventory-decrement / order core; list_product backend
- **acceptance_criteria**: example walks "stock→0 ⇒ auto-delist"; doc accurately describes
  `auto_delist_on_zero` / `low_stock_threshold` behavior (the existing list_product fields)
- **verification_commands**: run the example, observe auto-delist firing
- **expected_output**: example script + doc
- **dependencies**: none

### T10 — seller NL-instruction prototype (read + publish only; never funds)
- **task_type**: sdk_example · **risk**: medium
- **summary**: A small agent instruction-layer prototype mapping seller natural language ("sync these",
  "what's out of stock", "delist this") to the right MCP tool calls (`list_product` / `get_status` …).
  Covers read + publish/(de)list only; **never any funds/withdraw/escrow instruction**.
- **allowed_paths**: `examples/seller-agent-cli/` (new)
- **forbidden_paths**: any wallet/withdraw/escrow/payment mapping; iron-rule actions
- **acceptance_criteria**:
  - 3–5 example instructions map correctly
  - a funds-type instruction → explicit refusal + "needs PWA + Passkey", never proxied
  - never invents capabilities a tool doesn't have
- **verification_commands**: run examples; verify mapping + that funds instructions are refused
- **expected_output**: CLI prototype + mapping table + README
- **dependencies**: T3 helpful

---

## §E Group C — 3 tests/audit (medium risk; high-quality-contributor signal)

### T11 — p2p verification adversarial test suite (against a real fixture)
- **task_type**: tests · **risk**: medium
- **summary**: Adversarial fixtures for the §B verification flow: normal, single-field tamper, key reorder,
  `null` values, non-ASCII, oversized payload, invalid JSON, hash mismatch — ensuring verify behaves
  correctly everywhere (reject what must be rejected, pass what must pass).
- **allowed_paths**: `scripts/__tests__/` or `sdk/p2p-verify/__tests__/`
- **forbidden_paths**: the verification/generation core under test (add tests only)
- **acceptance_criteria**:
  - ≥ 8 fixtures covering normal + multiple attacks/anomalies, **including the §B edge cases** (recursive
    sort, array order, null kept, non-ASCII, undefined-key rejected)
  - each fixture has an explicit expected result + a comment on what it tests
  - includes a no-drift check against `order-chain.ts` `canonicalSerialize`
  - all green
- **verification_commands**: `npm test` green
- **expected_output**: test suite + fixture set
- **dependencies**: T6 (or T1) + §B

### T12 — read-only public-API smoke test set
- **task_type**: tests · **risk**: medium
- **summary**: Smoke tests for **read-only** public endpoints (search / get_status / leaderboard / info):
  response shape matches expected schema, bad input returns a typed error, and sensitive fields stay hidden
  (e.g. GMV/amounts hidden by design). Read-only — triggers no writes.
- **allowed_paths**: `scripts/smoke/` (new)
- **forbidden_paths**: any write/order/payment endpoint; no auth-bypass probing
- **acceptance_criteria**:
  - covers the listed read-only endpoints
  - asserts leaderboard etc. **do** hide GMV/amounts (privacy design)
  - bad input → typed error (not a crash)
- **verification_commands**: `node scripts/smoke/run.js` (against local/testnet)
- **expected_output**: smoke test set + run notes
- **dependencies**: none

### T13 — i18n completeness audit script
- **task_type**: audit · **risk**: low
- **summary**: A CI-friendly script scanning `src/pwa/public/i18n.js`: report which keys have zh but no EN
  (and any other lang gaps), output a gap list, non-zero exit on gaps (CI gate). Gives T2-type tasks a guard.
- **allowed_paths**: `scripts/i18n-audit.{ts,js}` (new)
- **forbidden_paths**: do not change i18n content (audit only)
- **acceptance_criteria**:
  - correctly reports missing keys
  - **key-position-aware** matching (`'key':` with the colon), **NOT** raw substring — a substring scan
    false-negatives keys whose text also appears as another entry's *value* (e.g. `t('Spam')` masked by
    `'垃圾信息': 'Spam'`; this exact bug was hit in dogfood round 3)
  - exit code: gaps → non-zero (CI gate); readable gap list
- **verification_commands**: `node scripts/i18n-audit.js`
- **expected_output**: audit script + usage doc
- **dependencies**: none

---

## §F Group D — 2 small design/RFC (produce docs, not code)

### T14 — RFC: node discovery / `content_hash` → replica index
- **task_type**: governance · **risk**: low (doc) / design-sensitive: medium
- **summary**: A small RFC designing "how WebAZ maintains a `content_hash` → list-of-replica-nodes index"
  (design only, no impl): what the index stores (pointers/metadata, **not content bytes**), how node up/down
  is reflected, how an agent queries a nearby replica, and how it composes with §B hash verification.
- **allowed_paths**: `docs/rfcs/RFC-node-discovery.md` (new)
- **forbidden_paths**: no code; no incentive-accounting design (that's core, maintainer-owned)
- **acceptance_criteria**:
  - explicit "pointers/metadata only, not content bytes"
  - fallback when nodes are unstable (origin fallback + multi-replica)
  - does not stray into incentive/anti-sybil design
  - flags open questions left for maintainer decision
- **verification_commands**: maintainer review
- **expected_output**: one RFC
- **dependencies**: none; read the architecture summary first

### T15 — RFC: seller-export → WebAZ field-mapping standard
- **task_type**: governance · **risk**: low (doc)
- **summary**: An RFC defining the standard mapping "external-platform seller export → `webaz_list_product`
  fields" (a uniform standard for T7-type per-platform import skills): field-correspondence table,
  never-guess handling of missing fields, normalization across platforms, compliance boundary
  (only seller's own exported data).
- **allowed_paths**: `docs/rfcs/RFC-catalog-import-mapping.md` (new)
- **forbidden_paths**: no impl; no scraping design
- **acceptance_criteria**:
  - at least one platform's complete field-mapping table
  - explicit never-guess (missing → null/default, never invented)
  - 🔴 explicit compliance boundary: seller's own export only, not scraping
  - flags open questions
- **verification_commands**: maintainer review
- **expected_output**: one RFC
- **dependencies**: none

---

## §I Flagship feature (1 · high-audit · maintainer-led) — the deliberate §A exception

### T16 — GitHub OAuth identity linking (per RFC-019)
- **task_type**: code · **risk**: **high** · **agent_autonomy**: **human_in_the_loop** · **auto_claimable**: **false**
- **authority**: [`docs/rfcs/RFC-019-github-oauth-identity-linking.md`](rfcs/RFC-019-github-oauth-identity-linking.md) (read first — it is the spec + threat model)
- **summary**: Implement a low-friction **"Connect GitHub" OAuth** identity-linking path (Authorization Code +
  PKCE → `GET /user` → authoritative `github_actor_id`) that **preserves the existing security model**: the
  bind still commits **only** behind the `requireHumanPresence('identity_claim')` Passkey ceremony, GitHub
  ownership is server-verified against `api.github.com`, and the **Gist proof flow remains as a fallback**.
  Future contribution facts then auto-attribute via the existing accountable read-overlay (no per-fact claim).
- **why this is NOT a normal first task**: it touches the **auth/identity trust root** (explicitly inside §A's
  restricted boundary). It is included as the launch's flagship initiative but is **high-risk, maintainer-led,
  human-in-the-loop, not auto-claimable**. Milestones **M4/M5** (binding-engine wiring + Passkey-gated routes)
  are **maintainer-owned / high-audit**; **M2/M3/M6/M7** (additive schema, read-only OAuth adapter, PWA UI,
  docs) are contributor-friendly under supervision.
- **allowed_paths**: new files only for the additive parts — `src/.../identity-claim/github-oauth-adapter.ts`,
  `oauth_link_states` schema+store, the new `oauth/*` endpoints in `routes/contribution-identity.ts`, PWA
  "Connect GitHub" UI + i18n, `docs/runbooks/github-oauth-setup.md`; **plus** the `proof_method='github_oauth'`
  extension to the claim engine (M4, **maintainer review required**).
- **forbidden_paths** (beyond §A): **must not weaken or bypass** `requireHumanPresence` / the human-presence
  gate; **must not** alter WebAuthn/Passkey core, the existing gist proof verifier trust root, the
  `identity_bindings_active` double-bind PK, or any money/escrow/auth-permission core. Token must **never** be
  persisted or logged; scope **read:user only** (no `repo`/write).
- **acceptance_criteria** (from RFC-019 §2):
  - bind commits **only** behind the Passkey ceremony — OAuth success alone never binds (an agent cannot self-bind)
  - GitHub ownership proven by **server-side** `GET /user` (numeric `id`), never client-asserted
  - **Gist fallback intact**; existing bindings unaffected (no re-link); both paths produce identical bindings
  - PKCE + single-use session-bound `state` (CSRF); access token used once then discarded; **fail-closed** when OAuth creds unset (503 before consuming state)
  - double-bind still blocked; rebind still = revoke event + fresh proof + Passkey (append-only)
- **human_confirmation_points**: ["RFC-019 accepted by maintainer before M2", "maintainer security review confirming Passkey gating + ownership verification are unchanged before M4/M5 merge"]
- **verification_commands**: new schema/adapter/engine/route tests green **and** the existing identity-claim suite still green; `npm run build`; `npm run check:api-docs-fresh`
- **expected_output**: the RFC-019 milestones as separate PRs (M2–M7), each independently CI-green
- **dependencies**: RFC-019 (M1, this PR's companion doc)

---

## §G Pre-publish discipline (do not skip)

1. **Zero-context blind run**: before publishing each task, give a **fresh agent session with no project
   memory** (not your Claude Code) only the task description + repo link, and have it attempt the task blind.
   - If it needs to ask **more than 2 key questions** → the spec isn't precise enough; tighten and re-test.
   - Especially for T6/T8/T11: if it asks "how exactly do I canonicalize nested null / array order /
     cross-language" → §B isn't yet sufficiently linked from the task; fix before publishing.
2. **forbidden_paths recheck**: confirm each task's `forbidden_paths` truly blocks the core
   (money/auth/DB-migration/order-state-machine/hash-trust-root/admission/incentive/iron-rule/Passkey/KYC).
3. **IP/DCO in place**: LICENSE + DCO boundary clear; big-company-employee reminder copy present, before the
   pool goes public.
4. **Load into `webaz_contribute`** (its execution-boundary fields map 1:1 to this doc's fields).

## §H Maintainer follow-ups surfaced while writing this (not contributor tasks)
- The `webaz_p2p_product` MCP tool description says "drop nulls" — **inaccurate** (the canonical idiom keeps
  nulls). 1-line core-doc fix.
- `src/layer2-business/L2-7-snf/snf-engine.ts` `canonicalSerialize` is **shallow** (top-level sort only),
  inconsistent with the recursive `order-chain.ts` idiom. Internal-only (SNF messaging), but worth a note.
