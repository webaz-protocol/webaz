# PR 3B-3 — Credential Persistence + Trusted Ingestion (DESIGN, not yet implemented)

**Status**: **implemented** — 3B-3a (schema, 4 tables + constraints, PR #297) and 3B-3b (ingestion engine + state machine + append-only, this PR) are landed. Design revised per Codex design-audit rounds 1, 2 & 3.
**Builds on**: PR #294 (credential v2 schema/verifier) · #295 (3B-1 authenticated fetch adapter) · #296 (3B-2 evidence + coverage) · RFC-017 §10 (fact layer) · RFC-006 (build_tasks/build_reputation persistence patterns) · RFC-016 (SQLite→PG seam).

> This is the **first** PR in the chain that touches the **database** and writes the **RFC-017 fact layer**. The risk magnitude jumps. Design-first + threat-model-first.

---

## §1 Scope — one trust boundary

**Does:** persist an **authenticated-fetched** GitHub credential (append-only) + **re-establish trust at ingestion** + emit an RFC-017 **Contribution Fact**.

**Explicitly deferred / NOT done:** valuation / scoring / reward / leaderboard; Passkey/KYC **identity claim** (`accountable_ref` stays `null`); `reverted`/`superseded`/`void` lifecycle-event verifier; reliable DCO; **contribution-type classification**; any API/MCP/PWA/webhook **trigger surface** (ingestion is an internal engine function only); wallet/fund/order/permission tables; production deploy.

---

## §2 Trust model — untrusted request vs trusted config (Codex #4)

| Input | Trust | Source |
|---|---|---|
| `owner`, `repo`, `prNumber` | **UNTRUSTED request** — only *selects* a target | ordinary caller |
| `token` | **trusted config/dep** | operator config |
| **allowed repository mapping** `owner/repo → expectedRepositoryId` | **trusted config** | operator config |
| `expectedRepositoryId` | **derived from the trusted mapping** (NOT caller-reported) | looked up by `owner/repo` |

`expectedRepositoryId` is **never self-reported by the caller**. Ingestion looks it up in the trusted mapping; an `owner/repo` not in the mapping → `repository_not_allowed` (refuse).

**No transport injection (Codex #2):** the production ingestion entry takes **no `fetchImpl`** — it uses only the runtime's `globalThis.fetch` (same as the 3B-1 adapter's final design). Tests **swap `globalThis.fetch`** (restored in `finally`, no-network sentinel); the signature never re-opens a caller-controlled transport.

### Trust-root re-establishment (the crux — Codex #4 + the §8 mandatory boundary)
Ingestion **re-fetches and re-derives** the credential inside the trusted path via the **3B-1 authenticated adapter** (`fetchGithubContributionCredential`). It **never** accepts a caller-supplied serialized credential or its digests as proof of authenticity. Only `verification_state='verified'` produced by WebAZ's own authenticated read is persisted. (Engine uses `globalThis.fetch`; tests swap it; zero real network; token never stored.)

---

## §3 Data model — 4 append-only tables

### Version-independent fact key (Codex #1)
`credential_id = ghc_<core_digest>` **includes `credential_version`** (it is in the digest, by design for domain isolation). It therefore **cannot** be the long-term idempotency key for a Contribution Fact (a v2 and a future v3 credential for the *same* PR-merge would mint different `credential_id`s but represent **one** fact).

**Fact identity = a version-independent `source_event_key`:**
```
source_event_key = github:<repository_id>:<pr_node_id>:merged
```
`contribution_facts` is **UNIQUE on `source_event_key`**. The link from a fact to the **credential(s) that evidenced it** lives in the separate GitHub link table (Table 4), never as a GitHub-specific column on the generic fact table, and never as the dedup key.

### Table 1 — `github_contribution_credentials` (immutable CORE, one row per `credential_id`)
`credential_id` authenticates **only** the core (PR #294), so this table holds only the core.
```
credential_id        TEXT PRIMARY KEY        -- ghc_<core_digest>
core_digest          TEXT NOT NULL UNIQUE    -- 1:1 with credential_id (id is derived from it)
credential_version   TEXT NOT NULL
source_event_key     TEXT NOT NULL           -- github:<repository_id>:<pr_node_id>:merged
repository_id        TEXT NOT NULL
pr_node_id           TEXT NOT NULL
pr_number            INTEGER NOT NULL
merge_commit_sha     TEXT NOT NULL           -- merged-only profile (Codex r3 #4)
merged_at            TEXT NOT NULL           -- merged-only profile
github_actor_id      TEXT NOT NULL
lifecycle_event      TEXT NOT NULL CHECK (lifecycle_event = 'merged')   -- merged-only profile
core_json            TEXT NOT NULL           -- the immutable core snapshot
created_at           TEXT NOT NULL DEFAULT (datetime('now'))
```

### Table 2 — `github_credential_observations` (full observation snapshot per observation)
`credential_id` does **not** authenticate the observation envelope (PR #294), so observations are separate and may differ across re-observations.
```
id                   TEXT PRIMARY KEY        -- gco_xxx
credential_id        TEXT NOT NULL REFERENCES github_contribution_credentials(credential_id)
observation_digest   TEXT NOT NULL
observation_json     TEXT NOT NULL           -- full observation snapshot
observed_at          TEXT NOT NULL
created_at           TEXT NOT NULL DEFAULT (datetime('now'))
UNIQUE(credential_id, observation_digest)
```
**`observation_digest` semantics (Codex #5):** it is the PR #294 digest over the **whole observation envelope, which INCLUDES `observed_at`** — this definition is **not changed here**. Consequence: every real re-fetch happens at a new wall-clock time → a **new `observation_digest`** → a repeated request normally yields **`re_observed`** (a new observation row), and **`already_present`** means **only** that an *identical observation snapshot* already exists (e.g. a replay of the exact same bytes). If a future PR wants to collapse re-observations, it must introduce a **separate `material_digest`** (content excluding `observed_at`) — it must **not** silently redefine `observation_digest`.

### Table 3 — `contribution_facts` (RFC-017 §10 — GENERIC authoritative fact table, Codex #4)
This is the **generic, source-agnostic** RFC-017 fact table — it must **not** carry GitHub-specific columns. GitHub→credential traceability lives in Table 4.
```
fact_id              TEXT PRIMARY KEY                  -- cfact_xxx
source_event_key     TEXT NOT NULL UNIQUE              -- version-independent idempotency key (format per source)
source               TEXT NOT NULL CHECK (source IN ('github','in_protocol','governance','transaction'))
type                 TEXT CHECK (type IS NULL OR type IN ('code','tests','audit','maintenance','governance','usage','transaction','referral'))   -- NULL = UNCLASSIFIED (Codex #3)
artifact_ref         TEXT NOT NULL                     -- generic: PR/commit SHA | task id | order id | gov-action id
occurred_at          TEXT
executor_ref         TEXT NOT NULL                     -- generic identity ref (e.g. github:<actor_id>)
accountable_ref      TEXT                              -- NULL until identity claim (deferred)
provenance           TEXT NOT NULL DEFAULT 'unknown' CHECK (provenance IN ('human','ai_assisted','ai_authored','unknown'))   -- never 'human' guess (Codex #3)
status               TEXT NOT NULL CHECK (status IN ('active','superseded','reverted','void','forfeited'))   -- 'merged' → 'active'
immutable            INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1)
created_at           TEXT NOT NULL DEFAULT (datetime('now'))
```

### Table 4 — `github_fact_credentials` (GitHub-specific evidence link, Codex #4)
Keeps Table 3 generic while making a GitHub fact **traceable to the credential(s) that evidenced it**. On a v2→v3 upgrade for the same `source_event_key`, the new `credential_id` is added as **another** evidence link to the **same** `fact_id`.
```
fact_id              TEXT NOT NULL REFERENCES contribution_facts(fact_id)
credential_id        TEXT NOT NULL REFERENCES github_contribution_credentials(credential_id)
created_at           TEXT NOT NULL DEFAULT (datetime('now'))
PRIMARY KEY (fact_id, credential_id)
UNIQUE (credential_id)   -- one credential evidences exactly ONE fact (Codex r3 #3)
```
> `UNIQUE(credential_id)` still allows `credential_upgraded` (v2 and v3 are **different** `credential_id`s both linking to the **same** `fact_id`); it forbids the **same** credential evidencing a **second** fact.

### No guessing; enrichment is separate & append-only (Codex #3)
- `type` is **NULL (unclassified)** — a GitHub PR's contribution type **cannot** be inferred from "it merged". `provenance` is **`unknown`** — never `human`.
- These are recorded **as-known-at-ingestion** and the fact row is **immutable**.

**Future enrichment — read-overlay CONTRACT only this round (Codex #7):** later **type classification**, **identity claim** (`accountable_ref`), **and lifecycle status changes** (`reverted`/`superseded`/`void`) will all be supplied by **separate append-only tables** (a future classification-events table / RFC-017 `IdentityBinding` / a **status-events** log) and **overlaid at read time** — the fact row is **never edited in place** (RFC-017 I-3). In particular, **`contribution_facts.status` is the as-ingested value (`active`) and is NEVER `UPDATE`d** (Codex r3 #5); a revert is a new append-only status event, and the *current* status is computed by the read overlay. **This round records only that contract: no enrichment/status tables, no hooks, no scope expansion of 3B-3a.**

---

## §4 Ingestion flow — precise states (Codex #2), atomic (Codex #5)

`ingestGithubContribution(request:{owner,repo,prNumber}, deps:{token, repositoryMapping})` — **no `fetchImpl`** (Codex #2):
1. Resolve `expectedRepositoryId` from the **trusted mapping** by `owner/repo`; not found → `repository_not_allowed`.
2. **Re-fetch + mint** via the 3B-1 adapter (uses `globalThis.fetch`; failure → typed refusal, no writes). **— OUTSIDE the transaction** (network is async).
3. Schema-validate + self-consistency self-check the minted credential. — outside the transaction.
4. Compute `source_event_key` from the core.
5. **Inside ONE synchronous `db.transaction`** do **everything that touches the DB** — existence **lookups**, **state decision**, **INSERTs**, and the **result decision** — to eliminate TOCTOU (Codex #3). **No async `dbOne/dbAll/dbRun` inside the transaction** (sync prepared statements only). **No "credential_id exists → return early".** Precise states (fact looked up by **`source_event_key`**, observation by **`(credential_id, observation_digest)`**):

The decision reads **all four** tables (core, observation, fact-by-`source_event_key`, link-by-`(fact_id,credential_id)`):

| Core (T1) | Obs (T2) | Fact (T3) | Link (T4) | Action | Result |
|---|---|---|---|---|---|
| new | new | new | (none) | INSERT core + obs + fact + link | **`ingested`** |
| **new** | **new** | **exists** (v2→v3, same source event) | none for this core | INSERT core + obs + **link to the existing fact** (NO new fact) | **`credential_upgraded`** |
| exists | new | exists | exists | INSERT obs | **`re_observed`** |
| exists | exists | exists | exists | no writes | **`already_present`** |
| **any other combination** — incl. fact/core/link **missing or mismatched** (e.g. core exists but no fact; fact exists but core's link missing; v2→v3 with a stray pre-existing link) | | | | **NO writes — fail-closed** | **`refused{outcome:'invariant_violation'}`** |

> The transaction guarantees the four tables never diverge — UNIQUE keys are the **second** line. The catch-all row is mandatory: **any state the four valid rows don't cover is a corrupted invariant → refuse, never silently repair or continue** (Codex r3 #1). `credential_upgraded` stores a new immutable core + observation and **links** to the existing fact; **no second fact** (`source_event_key` is version-independent).

Returns a typed result: `ingested | credential_upgraded | re_observed | already_present | refused{outcome}` (`refused` covers `repository_not_allowed`, adapter outcomes, `backend_unsupported`, `db_busy`, and `invariant_violation`). **No valuation/reward is ever produced.**

---

## §5 Atomicity & backends (Codex #5)

- **Transaction is a HARD requirement** — not optional, and UNIQUE/idempotent-reentry are only the **second** line of defense.
- **3B-3b** wraps **all DB access for the decision** — existence lookups + state determination + INSERTs + result determination — in **one synchronous `better-sqlite3` transaction run as `.immediate()`** (`BEGIN IMMEDIATE` takes the **write lock BEFORE the existence lookups**, so two racers can't both read "new" and both insert — Codex r3 #2). This eliminates TOCTOU; the re-fetch/validate is the only thing outside (async/network). The async seam has **no** transaction wrapper yet (`dbTx` deferred to RFC-016 Phase 3), so **no async `dbOne/dbAll/dbRun` may be called inside the transaction** — sync prepared statements only.
- **`SQLITE_BUSY`** is handled explicitly: a **bounded retry** (small fixed count/backoff) and, on exhaustion, a **typed `refused{outcome:'db_busy'}`** — **never** an unclassified thrown exception. (No `BEGIN DEFERRED` lock-upgrade deadlock path, because `.immediate()` takes the write lock up front.)
- **PG backend without a transaction wrapper → FAIL-CLOSED.** Ingestion on a PG backend must **refuse** (`backend_unsupported`) until a real PG transaction (BEGIN/COMMIT) exists. We must **not** claim PG ingestion works.
- **3B-3a** only requires the **DDL to be generated correctly by the PG schema generator** (`gen-pg-schema` → `pg:verify`); it does not enable PG ingestion.

---

## §6 Migration / schema-guard discipline (Codex #6)

- **Iron rule ALTER-after-CREATE**: all four are pure `CREATE TABLE IF NOT EXISTS` (no ALTER) → fresh-DB safe; `initSchema(db)` mounted at boot (next to `initBuildReputationSchema(db)`), before any query.
- **Async seam**: all reads/writes go through `dbOne/dbAll/dbRun` (no bare `db.prepare`) — except the synchronous transaction in §5; the seam/routes-seam-guard interplay is a **design point to confirm in 3B-3b** (sync transaction vs async seam coexistence).
- **RFC-016 PG**: `datetime('now')` defaults are handled by the existing dialect translators; `gen-pg-schema` **auto-scans DDL** → run `pg:schema` to regenerate the artifact + `pg:verify`.
- **⚠️ Correction (Codex #6):** `schema:verify` currently scans **server.ts / MCP / routes only** — it does **NOT** auto-cover a new engine file's SQL. The earlier claim "all new engine SQL is automatically covered by schema:verify" was **wrong**. Mitigation, **both**:
  1. **Add a dedicated fresh-DB schema/constraint test** (spin a fresh DB, run the ingestion `initSchema`, assert the tables + every constraint below actually **enforces**, and that the engine's INSERT/lookup SQL prepare + dedup correctly). This verifies *constraints*, not just column names.
  2. Optionally extend `schema:verify`'s scan list to include the new engine file.

**DB constraints 3B-3a must declare AND the fresh-DB test must prove enforced (Codex #6):**
- **NOT NULL (merged-only)**: `credentials.merge_commit_sha` and `credentials.merged_at` are **NOT NULL** (Codex P3).
- **FK**: `observations.credential_id → credentials`, and `github_fact_credentials.{fact_id→facts, credential_id→credentials}`.
- **UNIQUE**: `credentials.core_digest`, `observations(credential_id, observation_digest)`, `contribution_facts.source_event_key`, `github_fact_credentials(fact_id, credential_id)` PK, **and `github_fact_credentials.credential_id` UNIQUE** — one credential evidences exactly one fact (Codex P3).
- **CHECK**: **`credentials.lifecycle_event = 'merged'`** (merged-only, Codex P3); `contribution_facts.immutable = 1`; `source ∈ {github,in_protocol,governance,transaction}`; `status ∈ {active,superseded,reverted,void,forfeited}`; `provenance ∈ {human,ai_assisted,ai_authored,unknown}` **DEFAULT `unknown` (never default `human`)**; `type IS NULL OR type ∈ §5 8 types` (**no default — NULL = unclassified**).
- **⚠️ SQLite `PRAGMA foreign_keys = ON`** — SQLite leaves FK enforcement **OFF by default per connection**. 3B-3a must ensure the app connection sets it (verify the existing boot does, or add it) and the **fresh-DB test must assert an orphan insert is rejected** (else FKs are decorative).
- **PG DDL**: `gen-pg-schema` must emit the **FK / UNIQUE / CHECK** for PG too — if its scanner only carries columns, that is a **gap to close in 3B-3a**; `pg:verify` must confirm the constraints exist on the PG side. (CHECK enum-sets are valid in both SQLite and PG.)

---

## §7 Risk-boundary audit (threat model)

| Risk | Mitigation |
|---|---|
| Caller forges a credential into the store | **re-fetch-only**; ingestion derives the credential itself; never trusts supplied digests (§2) |
| Caller self-reports a wrong `expectedRepositoryId` | derived from **trusted mapping**, not caller (§2, Codex #4) |
| Same merge → duplicate fact / double-count | **`source_event_key` UNIQUE** (version-independent) + transaction (Codex #1) |
| credential v2/v3 of the same merge → two facts | `source_event_key` is version-independent → **one** fact (Codex #1) |
| Mid-ingest crash → half-write (core but no fact) | **single transaction** (hard req); UNIQUE = 2nd line (Codex #5) |
| Fact mistaken for valuation/reward/authority | fact is a record; `type=null`, `accountable_ref=null`, `provenance=unknown`; zero valuation; RFC-017 §12 uncommitted |
| Fact edited/deleted in place (violates append-only) | **3B-3a**: no write path exists (schema only). `CHECK(immutable=1)` only blocks flipping `immutable` — the DB does **not** forbid UPDATE/DELETE. **3B-3b (mandatory, §9)**: engine issues **only INSERT**; row-level immutability is **code-enforced + tested**; enrichment/status via separate append-only overlays |
| Guessing type=`code` / provenance=`human` | **forbidden** — `type=null`, `provenance=unknown` (Codex #3) |
| token / email / unnecessary PII persisted | **never store** token, email, or unnecessary PII (reuse 3B-1/3B-2: token never stored; co-author emails discarded). **Only the public GitHub attribution metadata needed to attribute the fact is stored** — `github_login` / `name` / actor id (public identity metadata, not protected PII) |
| New tables break fresh-DB boot (iron rule) | pure CREATE IF NOT EXISTS + dedicated fresh-DB test (Codex #6) |
| PG path silently wrong | `gen-pg-schema` auto-scan + `pg:verify`; **PG ingestion fail-closed** (Codex #5) |

---

## §8 Test plan — append-only must cover (Codex #7)

Counter-examples first, fake fetch (swap `globalThis.fetch`, no-network sentinel), zero real network:

**Ingestion-state / append-only (3B-3b):**
1. **Same request repeated + concurrent** → **exactly one fact** (UNIQUE on `source_event_key` + transaction); concurrent racers both safe.
2. **Identical observation snapshot** re-ingested (same bytes, e.g. injected same `observed_at`) → `already_present`, **no writes**.
3. **Normal re-fetch** (new `observed_at` → new `observation_digest`) on an existing core → `re_observed`: **one** new observation row, **no** new fact (Codex #5 semantics).
4. **credential v2→v3** for the **same** source event → `credential_upgraded`: new core + observation rows + a **new link** to the **existing** fact; **no second fact**; the link table then has **both** credential_ids for that fact (Codex #1).
5. **Any mid-step failure inside the transaction** → **none of the four tables left half-written** (rollback).
6. **No UPDATE / DELETE** path exists on these tables (assert the engine issues only INSERT).
7. **token / email never persisted** (assert stored rows + JSON snapshots contain neither); **public attribution metadata** (`github_login`/`name`) **is** present where expected (that is correct, not a leak).

**Refusals:** `repository_not_allowed` (unmapped repo); adapter refusals propagate; `backend_unsupported` (fail-closed) on a PG backend.

**Fresh-DB constraint enforcement (3B-3a, §6) — each must be *rejected by the DB*, not just by code:**
8. orphan FK insert (observation/link with non-existent parent) → rejected (proves `PRAGMA foreign_keys=ON`).
9. duplicate `core_digest` / `(credential_id, observation_digest)` / `source_event_key` → rejected (UNIQUE).
10. `immutable≠1`, bad `source`/`status`/`provenance`, `type` outside the 8 → rejected (CHECK).
11. same constraints verified on the **PG-generated DDL** (`pg:verify`).

---

## §9 Recommended split (isolate the highest-risk change)

- **3B-3a — schema only:** the **4 tables** (credentials · observations · contribution_facts · github_fact_credentials) + all constraints (§6) + `initSchema` + boot mount + `PRAGMA foreign_keys=ON` verification + `gen-pg-schema` regen + `pg:verify` (incl. FK/UNIQUE/CHECK) + the **fresh-DB constraint-enforcement test** (§8 #8-11). **No logic.**
- **3B-3b — ingestion engine:** re-fetch trust-root + the in-transaction state machine + persist + emit fact, on top of 3B-3a, with the §8 #1-7 tests.

> **⚠️ MANDATORY 3B-3b prerequisite — row-level immutability (review P2/P3②):** 3B-3a's append-only is **"no write path exists yet"**, NOT "the DB forbids modification". `CHECK(immutable=1)` only blocks *flipping* `immutable`; SQLite does **not** prevent an `UPDATE` of other columns or a `DELETE` of an existing row. Therefore **3B-3b MUST enforce row-level immutability in code** (the engine issues **only INSERT** on these four tables; no UPDATE/DELETE) **and TEST it** — assert no UPDATE/DELETE path exists and that an attempted mutation of an already-stored row is rejected/prevented. (Status changes go through the separate append-only status-events overlay, §3, never `UPDATE`.) This gate **must not be forgotten** when 3B-3b lands.

Rationale: isolates the constitutional schema/fact-layer change from the ingestion logic (serial single-trust-boundary; state-path guards into CI).

---

## §10 Resolved-by-Codex decisions
1. Trust-root = **re-fetch-only**; `expectedRepositoryId` from a **trusted repository mapping**, never caller-reported (round 2 #4). ✅
2. **No `fetchImpl`** on the production entry — only `globalThis.fetch`; tests swap the global (round 2 #2). ✅
3. Atomicity = **one sync `db.transaction` enclosing lookups + decision + INSERTs + result** (no async seam inside; eliminates TOCTOU); **PG fail-closed** (round 2 #3, #5). ✅
4. Fact idempotency = version-independent **`source_event_key`**; `contribution_facts` stays **generic** (no GitHub-specific column); GitHub→credential traceability via the **link table**; v2→v3 = **`credential_upgraded`** (round 2 #1, #4). ✅
5. `observation_digest` **includes `observed_at`** (unchanged def) → repeated real fetch ⇒ `re_observed`; `already_present` = identical snapshot only (round 2 #5). ✅
6. **No defaults** for `type` (NULL/unclassified) or `provenance` (`unknown`); enrichment is a **read-overlay CONTRACT only** this round — **no tables, no hooks, no 3B-3a scope expansion** (round 2 #7). ✅
7. **Split** 3B-3a (schema + constraints) / 3B-3b (logic); **engine-only** (no API/MCP/PWA/webhook). ✅

**No open design questions remain** — pending Codex's second design-level review.
