# PR 4 — GitHub Identity Post-hoc Claim (DESIGN + THREAT MODEL)

**Status**: 4a (binding schema + engine + read-overlay) — this PR. 4b (proof flow + Passkey gate + claim endpoint) — next.
**Builds on**: RFC-017 §3 (identity layering + post-hoc claim, I-5/I-6/I-7) · #299 ingestion engine (facts carry `executor_ref=github:<id>`, `accountable_ref=NULL`) · #295 3B-1 authenticated fetch adapter (the 4b proof trust-root).
**Framework**: Holden 8-PR plan, **PR4** — "GitHub 身份事后认领". Threat-model-first.

> This binds a **GitHub identity → a WebAZ accountable account**, which is what later sets a contribution fact's `accountable_ref`. It is the gateway to all future valuation/reward — so the binding's authenticity and its invariants are constitutional. **No valuation/reward/KYC here** (RFC-017 three-layer separation; KYC stays empty until fulfillment).

---

## §1 What is bound (and what is NOT)

- **Bound:** a stable **`github_actor_id`** (NEVER the renameable `login`) → a WebAZ **account** (`users.id`, exposed as `accountable_ref = webaz:<account_id>`).
- **NOT bound / deferred:** KYC (fulfillment-time only); co-author / non-executor attribution claiming (v1 binds the PR executor identity only); reward eligibility / economic value (uncommitted, PR5/6).
- **executor ≠ accountable (RFC-017 I-7):** the fact's `executor_ref=github:<id>` is **immutable**; the binding adds an **accountable** overlay. An agent may have executed; the human/org that controls that GitHub account is accountable.

## §2 Trust model — the binding direction is the whole security argument

A claim is `{ account (claimer), github_actor_id (target), server-nonce }`. **Proof = an artifact only the owner of `github_actor_id` could produce.** So binding `github_V` to *my* account requires proof produced *by* `github_V` — which an attacker who doesn't control `github_V` cannot make. The binding can therefore never be forged by a non-owner.

**4b proof method (decided): authenticated-publication challenge** (reuses the #295 trust-root, no OAuth app / no new secret): the server issues a single-use, per-claim, time-bound nonce; the contributor publishes it in an artifact **owned by the target GitHub account** (a gist / PR); WebAZ re-fetches it via its **own authenticated read** and verifies `owner.id == github_actor_id` **and** the nonce matches **this** pending claim. (4b.)

## §3 Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | False binding / impersonation (bind someone else's GitHub id) | proof is an artifact only the GitHub-id owner can produce (§2); anchored on **stable `github_actor_id`**, not `login` |
| T2 | Replay / nonce reuse | nonce is **server-generated, single-use, per-claim, time-bound** (4b) |
| T3 | Double-bind (a github id bound to two accounts) | **`identity_bindings_active.github_actor_id` PRIMARY KEY** — DB-enforces at most ONE active binding per github id; one account may hold many bindings |
| T4 | Editing the immutable fact in place | `contribution_facts.accountable_ref` **stays NULL forever**; the binding lives in the **append-only `identity_binding_events`** log; current accountable is a **read-overlay** (RFC-017 I-3; same gate as 3B-3b) |
| T5 | Account takeover inherits bindings | the account's Passkey security (existing); bindings follow the account; out of scope but noted |
| T6 | Sold / compromised github account, fraud | **revocation is append-only** (`revoked` event + drop from active); **rebind = revoke-then-bind**; disputes → governance via `admin_manual` proof (audited) |
| T8 | Agent auto-claims (iron rule) | the claim COMPLETION requires a real **Passkey/WebAuthn** assertion (4b); agent/MCP/API-token paths cannot complete a binding ([[人工铁律节点]]) |
| T9 | Doxxing (GitHub id ↔ WebAZ account ↔ real person) | binding **`visibility` defaults `'private'`** (DB default); public display is opt-in, exposed only by a future read API/UI (4b) |
| T14 | Sybil (one person, many github ids) | binding grants **no** reward (uncommitted); Sybil resistance belongs to valuation (PR5/6) + fulfillment-time KYC — **not solved here** |
| — | Bind to a non-existent account | `account_id` **FK → users(id)** |

## §4 Data model — append-only log + a current-state projection

**`identity_binding_events`** — append-only, immutable audit log (the source of truth):
`event_id` PK · `event_type` CHECK(`bound`/`revoked`) · `github_actor_id` (external, no FK) · `account_id` FK→users · `visibility` CHECK(`private`/`public`) DEFAULT `private` · `proof_method` CHECK(`github_publication_challenge`/`admin_manual`) · `proof_ref` (nullable) · `supersedes_event_id` FK→self (a `revoked` points at the `bound` it cancels) · `created_at` · `immutable` CHECK=1.

**`identity_bindings_active`** — the **current-state projection** (a derived cache; mutable BY DESIGN — `bound`→INSERT, `revoked`→DELETE; the immutable truth is the event log):
`github_actor_id` **PK** (one active binding per id) · `account_id` FK→users · `visibility` · `bound_event_id` · `ref_event_type` (`'bound'`, CHECK-pinned) · `bound_at`.

### §4.1 DB-level integrity (#300 follow-up — was code-only)
- **Event log is immutable BY THE DB (req1):** `BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT)` (SQLite); the PG generator emits the equivalent `RAISE EXCEPTION` plpgsql trigger guard (`webaz_reject_mutation`). `immutable=1` CHECK only blocked flipping that one column; the triggers block ALL row mutation/removal. **Covered in both SQLite and PG.**
- **Projection can't disagree with its event (req2):** a **composite FK** `(bound_event_id, ref_event_type, github_actor_id, account_id, visibility) → identity_binding_events(event_id, event_type, github_actor_id, account_id, visibility)`, with `ref_event_type` pinned to `'bound'` by CHECK, forces the referenced event to be a **`bound`** event whose `github_actor_id`/`account_id`/`visibility` **match** the projection row. A mismatch, or a reference to a `revoked` event, is rejected by the DB.
- Both are exercised by fresh-DB counter-example tests (UPDATE/DELETE event, mismatched projection, revoked-event reference → all DB-rejected). The store init applies these via the same **atomic, full-structure-aware migration** as `github-credential-store` (recreate-if-empty / fail-closed-if-not / rollback-on-error, one `.immediate()` transaction).

> Why a projection: it lets the DB **hard-enforce the single-active-binding invariant (T3)** via the PK, and makes the read-overlay an indexed point lookup. The event log stays purely append-only; the projection is explicitly a cache rebuildable from the log. (The append-only gate from 3B-3b applies to the **event log**, not the cache.)

## §5 Engine (4a) — synchronous, atomic, PG fail-closed

Same backbone as the 3B-3b ingestion engine: one synchronous `better-sqlite3` `db.transaction(...).immediate()` (write lock before the lookup → no double-bind race), `SQLITE_BUSY`→bounded retry→typed, non-sqlite backend → `backend_unsupported` (fail-closed), unexpected errors re-thrown loud. **The engine takes an ALREADY-VERIFIED `github_actor_id` as trusted input** (the proof is 4b's job — exactly the 3B-3a/3B-3b schema/trigger split).

- `bindGithubIdentity({ githubActorId, accountId, proofMethod, proofRef?, visibility='private' })` → `bound` | `already_bound` (same account, no-op) | `refused{already_bound_to_other}` (must revoke first).
- `revokeGithubIdentityBinding({ githubActorId, accountId, proofMethod, proofRef? })` → `revoked` | `refused{not_bound}` | `refused{not_owner}` (only the current account may self-revoke; `admin_manual` lets governance override, audited).
- `resolveAccountable(executorRef)` → the active binding (`{ accountableRef: webaz:<id>, visibility, boundAt, boundEventId }`) or `null`. Only `github:<id>` executors are bindable in v1.

**Current-binding overlay model:** the latest active binding for a github id is accountable for **all** that id's facts (past + future) — this is what makes "contribute first, claim months later" work. *Limitation (v1):* rebinding reassigns historical accountability; rebind is rare + governance-gated; a future PR may add point-in-time scoping for reward snapshots.

## §6 Mandatory invariants the fresh-DB test must prove (DB-enforced, not code-only)
- `immutable=1` CHECK on the event log (incl. rejecting an `UPDATE` that flips it); `event_type` / `visibility` / `proof_method` CHECK sets; `visibility` **defaults `private`**.
- `identity_bindings_active.github_actor_id` PK rejects a second active binding (T3).
- FK: `account_id → users(id)`, `bound_event_id → events`, `supersedes_event_id → events` — orphans rejected (`PRAGMA foreign_keys=ON`).
- engine append-only on the **event log**: only INSERT (behavioral + static scan); the active projection may INSERT/DELETE.

## §7 Split
- **4a (this PR):** schema (2 tables) + binding/revoke engine + read-overlay + threat-model doc + fresh-DB constraint test + PG regen + `pg:verify`. **No proof flow, no endpoint, no Passkey, no exposure API.**
- **4b (next):** the publication-challenge proof + Passkey gate + claim endpoint; calls 4a's engine only AFTER proof; the opt-in exposure read API/UI.

## §8 Iron-rule enforcement (PR-S — pipeline before PR-F)

PR-S adds the **security pipeline** that locks these boundaries **before** PR-F introduces any claim API/MCP/UI, so a future endpoint cannot bypass them. Each rule maps to an enforcing guard/test (CI job `identity-claim-iron-rules`; documents don't count — the guard scans actual code paths, and `test:iron-rules-guard` proves it can fail):

| # | Iron rule | Enforced by |
|---|---|---|
| 1 | `admin_manual` (high-risk override) only behind a controlled engine path + admin-capability check; never in a route/MCP/API handler | **static**: `scripts/identity-claim-iron-rules-guard.ts` rule1 (allowlist) |
| 2 | `identity_binding_events` append-only — no UPDATE/DELETE bypass | **DB**: `BEFORE UPDATE/DELETE` triggers (SQLite) + PG trigger guard, proven by `scripts/test-identity-binding.ts`; **static**: guard rule2 (no row UPDATE/DELETE in code) |
| 3 | `active` projection only from a legit `bound` event; can't forge actor/account/visibility/event_type | **DB**: composite FK + `ref_event_type` CHECK, proven by `scripts/test-identity-binding.ts` (mismatch / revoked-ref / `ref_event_type='revoked'` rejected) |
| 4 | claim/binding writes go through the engine; route/API can't write identity/contribution core tables directly | **static**: guard rule4 (scans `src/pwa/**`, `src/layer1-agent/**`) |
| 5 | credential = evidence · fact = contribution · binding = post-hoc claim — no reward/identity-rights mixed in | **static**: guard rule5 (engines don't import reward/KYC/wallet/economic) |
| 6 | every failure is fail-closed, no silent pass | guard exits non-zero on any violation + **fails on a missing anchor**; engines return typed refusals (`test-identity-binding`); `test:iron-rules-guard` asserts the guard itself fails-closed |
| 7 | tests use no real token / user data / prod secret | **static**: guard rule7 (no real-looking `ghp_` token in `scripts/`) |

**Out of scope for PR-S (deferred to PR-F, gated by these guards):** the publication-challenge proof, the Passkey/iron-rule human gate, the claim endpoint, the opt-in exposure read API/UI. When PR-F adds a claim route, rule4 forces it through the engine and rule1 keeps `admin_manual` out of the handler — a bypass fails CI.

### §8.1 PR-F0 — human-presence gate plumbing (landed; no endpoint yet)
The claim **commit** (binding accountability) is a high-risk action, so it is wired as a first-class iron-rule alongside `vote`/`arbitrate`/`agent_revoke`/`delete_passkey`: a new `identity_claim` purpose in the WebAuthn one-time gate-token system (`requireHumanPresence` / `consumeGateToken`, extracted behavior-zero to `src/pwa/human-presence.ts`), the issuance allowlist (`routes/webauthn.ts`), and the protocol param `require_human_presence_for_identity_claim` (default `1`, min 0 / max 1 — same level as its peers). **PR-F0 only wires the gate** — there is **no claim endpoint, no challenge table, no binding write** yet; PR-F3 will require this token to complete a binding. Proven by `tests/test-human-presence.ts` (issue/consume/replay/expiry/wrong-purpose/cross-user/param + no regression).

### §8.2 PR-F1 — challenge state (landed; no endpoint)
The publication challenge needs server-side memory of the issued nonce. PR-F1 adds the table
`identity_claim_challenges` (`challenge_id` PK · `account_id` FK→users · `github_actor_id` ·
`source_event_key` · `nonce_hash` UNIQUE — sha256, **never plaintext** · `status` CHECK
`issued|consumed|expired|revoked` · `expires_at` · `consumed_at` · `immutable=1`). It is **ephemeral
transactional state**, modeled on `webauthn_gate_tokens` (mutable, **single-use via a future CAS**:
`UPDATE … WHERE status='issued' AND expires_at>now` → changes=1), NOT an append-only log. `immutable=1`
marks the identity fields write-once + blocks flipping `immutable`; it does NOT make the row append-only
(sanctioned status CAS still migrates `status`/`consumed_at`).

**State machine DB-enforced** (Codex F1 — so F2/F3 can't write an illegal state even with a bug):
- **INSERT must be `status='issued'`** — a `BEFORE INSERT` trigger (the PG generator emits the plpgsql equivalent). consumed/expired/revoked are reachable only *from* issued via the status CAS (UPDATE).
- **`consumed_at IS NOT NULL` ⟺ `status='consumed'`** — row-level CHECK.
- **`nonce_hash` is a 64-char LOWERCASE sha256 hex** — `CHECK(length(nonce_hash)=64 AND nonce_hash NOT GLOB '*[^0-9a-f]*')` + UNIQUE (the hash, never plaintext / short / non-hex / uppercase). gen-pg-schema translates the GLOB to PG `!~ '[^0-9a-f]'`.

**F1 builds only the table + DB integrity** — no issuance/consume helper, no engine, no endpoint. `identity_claim_challenges` is in the §8 iron-rule guard's CORE_TABLES, so an API-layer file writing it directly fails CI (must go through the future engine). The single-use consume is the future engine's CAS (`UPDATE … SET status='consumed', consumed_at=… WHERE status='issued' AND expires_at>now` → changes=1).

### §8.3 PR-F2 — claim engine (landed; no API)
`identity-claim-engine.ts` `claimGithubIdentity(input)` consumes an issued challenge and binds the
GitHub actor → WebAZ account in **one synchronous transaction**, no API/MCP/UI, no GitHub fetch. Binding
is **identity-level** (`github_actor_id → account_id`, stable id never login); the fact/`source_event_key`
is a **precondition guard** — it must be a **GitHub credential-BACKED** active fact, not merely one with a matching generic `executor_ref` (Codex F2 P1): the engine joins `contribution_facts f ⋈ github_fact_credentials l ⋈ github_contribution_credentials c` (`f.source='github' · f.status='active' · f.source_event_key=input · f.executor_ref='github:'||actor · l→f on (fact_id,source_event_key) · c→l on (credential_id,source_event_key) · c.github_actor_id=actor`). Order:
fact/actor check (BEFORE the CAS, so a doomed claim leaves the challenge **issued**) → CAS consume
(`status='issued' AND not expired AND account/github/source match` → changes=1) → `bindGithubIdentityCore`
(extracted from 4a so it runs inside this tx — `bindGithubIdentity` still wraps it in its own tx,
behavior-zero). bound→`claimed`; already_bound(self)→`already_bound_self` (idempotent, challenge consumed);
**already_bound_other / any bind failure → THROW → whole tx rolls back, challenge NOT consumed**. proof is
**pre-verified** (`proofVerified:true`; F3 verifies the gist) — `proofVerified` not true → `proof_not_verified`;
`proof_method` is always `github_publication_challenge` (never `admin_manual`); `visibility` defaults `private`.
F2 does **not** mark expiry (an expired challenge stays `issued`; a future sweep may mark `expired`).
The new engine is in the §8 guard's ENGINES (rule5: no reward/KYC/wallet imports). Next: **F3** proof
(gist via #301) + minimal API + wire the human-presence (PR-F0) gate.

### §8.4 PR-F3a — publication-proof verifier (landed; internal, no API/DB)
`identity-claim-proof-verifier.ts` `verifyGithubGistProof(args)` is the internal verifier the future F3 API
calls **before** `claimGithubIdentity(... proofVerified:true)`. Lesson from #308: authenticity comes from
WebAZ's **own re-fetch**, never caller-supplied JSON. It re-fetches `GET /gists/<id>` via the #295/#301
audited primitives (`pathFromOrigin`+`getJson`, fixed origin `https://api.github.com`, GET-only,
manual-redirect, AbortSignal timeout — `getJson`'s #301 guard rejects any other host) and verifies:
gist `owner.id` **strictly equals** `githubActorId` (the stable id, **never** login); a gist file contains
the marker **`webaz-identity-claim:v1:<challengeId>:<nonce>`**; and `sha256(nonce) == expectedNonceHash`
(the value stored in `identity_claim_challenges`). **GitHub Gist proof v1 only** (no PR/issue comment / raw
URL). Truncated content → `proof_truncated` (**raw_url is NEVER followed**). Strict zod args reject unknown
keys (`fetchImpl`/`now`/caller `owner` → `invalid_request`); no transport/clock injection (production uses
`globalThis.fetch`; tests swap the global). `token` is a trusted-config dep (optional — public gists need
none), sent only to api.github.com and **never** in any result/reasons. Typed outcomes only (no predictable
throw): `verified` / `owner_mismatch` / `proof_not_found` / `nonce_mismatch` / `proof_truncated` /
`malformed_response` / `not_found` / `rate_limited` / `upstream_unavailable` / `timeout` / `invalid_request`.
Writes **no DB**, calls **no** engine. In the §8 guard's ENGINES (rule5). Next: **F3b** — challenge issuance
helper + minimal claim API wiring the PR-F0 human-presence gate + this verifier + the #308 engine.

### §8.5 PR-F3b — challenge issuance engine (landed; internal, no API)
`identity-claim-challenge-engine.ts` `issueGithubIdentityClaimChallenge(args)` issues an
`identity_claim_challenges` row (`status='issued'`) for an **active GitHub credential-backed** fact and
returns `{ challenge_id, expires_at, proof_marker }`. Same trust root as F2 via the shared
`assertGithubCredentialBackedFact` (extracted from #308, behavior-zero): refuses governance/in_protocol/
transaction facts, github facts without a credential link, and credential-actor mismatches. If the actor
is already actively bound → `already_bound_self` (no new challenge) / `already_bound_other` (refused).
`nonce` / `challenge_id` / `expires_at` are **engine-generated** (`crypto.randomBytes`, never caller-supplied
— the strict input rejects them); **only `sha256(nonce)` is stored**, the plaintext nonce is returned ONLY
inside `proof_marker` = `${CLAIM_MARKER_PREFIX}<challenge_id>:<nonce>` (prefix imported from F3a so they never
drift). One synchronous `.immediate()` tx; non-sqlite → `backend_unsupported`. Writes **no** bindings, calls
**neither** the F3a verifier nor the claim engine. Typed outcomes: `issued` / `already_bound_self` /
`already_bound_other` / `fact_not_found` / `actor_mismatch` / `backend_unsupported` / `db_busy` /
`invalid_request`. In the §8 guard's ENGINES (rule5). Next: **F3c** — the minimal claim API wiring
issuance (F3b) + the PR-F0 human-presence gate + the F3a verifier + the #308 claim engine → the closed loop.

### §8.6 PR-F3c — minimal claim API (landed; the first human-facing, Passkey-gated closed loop)
`routes/contribution-identity.ts` exposes exactly two logged-in endpoints and adds **no new trust** — it
only orchestrates the audited engines and shapes responses:

- `POST /api/contribution-identity/github/claim-challenge` `{ source_event_key, github_actor_id }` →
  `issueGithubIdentityClaimChallenge({ accountId: user.id, … })` (F3b) → `{ challenge_id, expires_at,
  proof_marker }` (or `already_bound_self` / refusal). The user posts `proof_marker` into a **public Gist
  they own**. Never returns `nonce_hash` or any DB row.
- `POST /api/contribution-identity/github/claim-complete`
  `{ source_event_key, github_actor_id, challenge_id, gist_id, webauthn_token }` →
  ① **server-config check first** — the trusted GitHub read token comes ONLY from server config
  (`getGithubReadToken`, e.g. `GITHUB_CONTRIB_READ_TOKEN`); if unconfigured → `503
  GITHUB_READ_NOT_CONFIGURED` **before** the human gate token is consumed (no anonymous, rate-limited
  identity reads in prod). ② `requireHumanPresence(user.id, 'identity_claim', webauthn_token,
  'require_human_presence_for_identity_claim', …)` — the one-time WebAuthn gate token's `purpose_data` must
  bind THIS exact `{ github_actor_id, source_event_key, challenge_id }`, so a token minted for one claim
  can't complete another and an agent can't replay it. ③ `getIssuedChallengeForVerification` (F3b read,
  seam-based) confirms the challenge is `issued`, unexpired, and owned by THIS `(account, actor, source)`
  **before any network call**, yielding the stored `nonce_hash`. ④ `verifyGithubGistProof` (F3a) — WebAZ
  **re-fetches the gist itself** (trusted token; never the body) and checks `owner.id == actor` + marker +
  `sha256(nonce) == nonce_hash`. ⑤ on pass, `claimGithubIdentity({ …, proofVerified: true })` (F2)
  **atomically CAS-consumes the challenge + binds**. A failure at ②/③/④ does **not** consume the challenge
  (F2 isn't called) — fix the gist and retry.

Boundaries (proven by `scripts/test-identity-claim-api.ts`, 68 checks): the route holds **no `db` handle and
runs no SQL** (every core-table read/write goes through a layer2 engine — rule4; the authoritative single-use
consume is the F2 CAS); `accountId` is **always** the session user (never the body); strict input rejects
`expectedNonceHash` / `proofVerified` / `accountId` / `nonce` and any unknown key; responses never leak the
token, `nonce_hash`, gist content, or a stack trace; registered after auth, before the SPA fallback. CI:
`identity-claim-api`.

### §8.7 PR-F4 — read surface (landed; contribution-attribution visibility, read-only)
`identity-claim-read.ts` `getMyGithubIdentitySurface(accountId)` + `GET
/api/contribution-identity/github/me` let a logged-in account see (a) its OWN current GitHub identity
bindings and (b) the contribution facts currently attributable to it via those bindings. **Read-only; no
reward / score / KYC / leaderboard / UI; no new table.**

- **Scope is the security argument**: every query is anchored on `account_id = <the caller>` (the session
  user — `WHERE identity_bindings_active.account_id = ?`), so a row for any OTHER account is never
  selected. The route reads **no query/body input** — a caller cannot pass `account_id` / `github_actor_id`
  to ask about someone else. No other account's id is returned; visibility is shown to its OWNER only, so a
  `private` binding is never disclosed to anyone else. No token / email / nonce / `nonce_hash` / gist
  content is read or returned.
- **Accountable overlay (read-time, never a mutation)**: a fact is "mine" iff it is an active GitHub
  **credential-BACKED** fact (`contribution_facts ⋈ github_fact_credentials ⋈
  github_contribution_credentials`, the same trust root as F2/F3b) **AND** its `executor_ref` is
  `github:<actor>` for an `<actor>` currently bound to me. `contribution_facts.accountable_ref` stays
  **NULL** (facts immutable — RFC-017 I-3; the accountable party is resolved at read time, like the 4a
  `resolveAccountable`). The credential join blocks a fact with a merely-matching generic `executor_ref`
  but no authenticated credential (#308 lesson); the executor-match blocks a credential for my actor on a
  fact executed by someone else.

Boundaries (proven, together with §8.8, by `scripts/test-identity-claim-read.ts`, 39 checks — engine +
route): GET requires auth (401 otherwise); only MY bindings/facts; another account's private binding never
disclosed; a historical fact of a bound actor surfaces via the overlay without touching `accountable_ref`;
an UNBOUND actor's fact, a mismatched-executor fact, and a `reverted` fact are not shown; `account_id` /
`github_actor_id` query params are ignored; the route holds no `db` handle / writes no core table; the read
engine pulls in no reward/KYC/wallet/economic module (in the §8 guard's ENGINES — rule5) and contains no
write. Read path = the async seam (`dbAll`). CI: `identity-claim-read`.

### §8.8 PR-5A — uncommitted-value boundary (landed; Metering & Display safety contract)
`contribution-display-envelope.ts` is the SAFETY CONTRACT that must wrap every contribution
metering/display surface **before** any valuation/scoring is ever built (RFC-017 step 5 — Metering &
Display; authority: **RFC-017 I-12 / §7**, the legal/trust firewall). It is a pure display contract —
computes/stores nothing, imports no reward/KYC/wallet/valuation module (in the §8 guard's ENGINES, rule5).
`withUncommittedValueBoundary(payload)` stamps one frozen top-level `value_boundary` onto a payload:
`value_state: 'uncommitted'` · `valuation_state: 'not_defined'` · `redemption_state: 'not_defined'` ·
`economic_rights: false` · `boundary_ref: 'RFC-017 I-12'` · a bilingual informational `notice` that
**promises nothing** and deliberately does not even name amount/currency/yield/payout. `GET
/api/contribution-identity/github/me` (§8.7) now returns its surface wrapped in this boundary, so the act
of *measuring and displaying* contribution can never read as a payout promise.

This PR does **no** scoring/weight/ranking/reward formula, adds **no** valuation/redemption table, and
touches no wallet/funds/KYC/binary-tree/DAO parameter. The test asserts the boundary is present
(`value_state='uncommitted'`, valuation/redemption `not_defined`, `economic_rights=false`), the helper is
pure (no input mutation, frozen constant, payload preserved), and — recursively over the whole response —
**no economic-promise field key** (`amount` / `currency` / `yield` / `payout` / `reward` / `price` /
`promise`) ever appears. CI: `identity-claim-read`.

### §8.9 PR-5B — legacy RFC-006 contributor dashboard under the same boundary
The pre-existing RFC-006 contributor self-view (`GET /api/build-reputation/me` + PWA `#my-contributions`)
is also a contribution display surface, so it is brought under the §8.8 contract — avoiding the split
where one surface carries `value_boundary` and another still implies a reward:
- The route now wraps `getBuildProfile(...)` in `withUncommittedValueBoundary`, so the dashboard carries the
  same `value_boundary` (`value_state:'uncommitted'`, valuation/redemption `not_defined`,
  `economic_rights:false`).
- The legacy `reward_anchored` field is **renamed to `passkey_anchor_present`** (true iff a Passkey/
  webauthn credential exists) — an accountability-anchor semantic, not an economic one; the PWA reads the
  new field and its copy says binding a Passkey anchors an accountable real person and records BUILD
  reputation (no "claim a reward", no amount/redemption). This also satisfies the §8.8 "no
  economic-promise field key" rule (the old name contained `reward`).
- `build_points` / `tier` remain the RFC-006 **build/coordination-layer** reputation — an independent pool
  that never gates trade-side admission (verifier/arbitrator), per RFC-006 invariant 1. No build_points
  formula change, no new table, no DB write (read-only self-view; auth required; self-only).

Proven by `scripts/test-build-reputation-boundary.ts` (22 checks — engine + route). CI:
`build-reputation-boundary`.
