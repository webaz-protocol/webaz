# GitHub Immutable Contribution Credential v2 / GitHub 不可变贡献凭证 v2

**Status**: draft — credential spec + **pure** verifier (PR #294) + **authenticated, read-only GitHub fetch adapter** (PR 3B-1) **+ richer paginated evidence** (checks/reviews/commits with machine-readable per-stream coverage; **credential v2**; DCO deferred; PR 3B-2). No DB/migration/persistence/ingestion/write-API/MCP/UI change.
**Author**: @seasonkoh
**Created**: 2026-06-11
**Track**: normal — new verifiable-evidence module crossing the protocol↔GitHub boundary; introduces no authority over attribution/scoring/reward.
**Related**: [RFC-017](rfcs/RFC-017-contribution-protocol-v1.md) · [RFC-006](rfcs/RFC-006-contribution-layer.md) · [RFC-009](rfcs/RFC-009-noncode-pr-proxy.md) (**non-code inbox PR proxy only** — NOT this credential layer, RFC-017 I-14) · [AGENT-READY-TASK-SPEC](AGENT-READY-TASK-SPEC.md) · [RFC-005](rfcs/RFC-005-ai-triage-pipeline.md) ("diff is untrusted data")
**Machine-readable**: [`src/layer2-business/L2-9-contribution/github-credential/`](../src/layer2-business/L2-9-contribution/github-credential/) — `github-credential.schema.ts` (zod) · `github-credential.schema.json` (generated) · `verifier.ts` (pure) · `canonical.ts` · `fixtures/` · `npm run test:github-credential`

---

## §0 Purpose & scope / 目的与边界

A **GitHub Contribution Credential** turns *"what happened on GitHub"* (a merged PR, observed via a GitHub API response) into a **candidate** for RFC-017's contribution fact layer. It does **not** perform Passkey/KYC claim, scoring, or reward.

> **What this doc covers:** the credential spec + zod/JSON-Schema contract + a **pure** verifier + deterministic canonical SHA-256 digests + fixtures + tests + CI guard (**PR #294**), **and** the **authenticated, read-only GitHub fetch adapter** that establishes source authenticity (**PR 3B-1**, §8). The **credential schema + verifier are pure / offline**; the **3B-1 adapter** performs WebAZ's own **authenticated, read-only** GitHub `GET`s with the operator's token (**no token/secret committed; tests swap `globalThis.fetch` and never touch the network**). **It does NOT:** add/modify DB tables/migrations or persist anything; write any production DB; add a webhook or call any GitHub **write** API; implement ingestion/Contribution-Fact write, Passkey/KYC claim, scoring, reward, or the Assurance Surface; deploy/publish; touch wallet/fund/permission/order state machine.

> **⚠️ Trust boundary (read this):** the verifier is a **pure function over a caller-supplied object**. It validates **structure + repository anchoring**; it **cannot prove** the object authentically originated from GitHub. Therefore `event_source='github_api'` is a *claimed* source and `verification_state='verified'` means **structural + repo-anchor verification only** — **not** proof of source authenticity. Source-authenticity (an authenticated fetch) is **deferred to PR 3B**. This limitation is also encoded in every credential's `known_limitations`.

### Four distinct things — never conflated / 四个明确区分

| Concept | This PR? | What it is |
|---|---|---|
| **GitHub credential** | ✅ this PR | proves a GitHub **fact** (a **merged PR**; lifecycle = `merged` only (merged-only profile)), subject to the trust boundary above |
| **Contribution Fact** | ✗ later | RFC-017 **authoritative** ledger record, produced by *ingesting* a credential |
| **Identity Claim** | ✗ later | future **Passkey** binding to an accountable party |
| **Valuation / Reward** | ✗ never here | entirely out of scope |

---

## §1 Structure: immutable core vs mutable observation / 不可变 core vs 可变 observation

A credential is split so that **`credential_id` authenticates ONLY the immutable GitHub fact** — not the surrounding observation. (Codex #294 P1 fix.)

```
{
  credential_id,            // = ghc_<core_digest[0:40]> — authenticates the CORE only
  event_source, accountable_party_ref (=null, reserved),
  core: { ... },            // immutable GitHub fact (incl. credential_type + credential_version)
  core_digest,              // SHA-256 over core — the fact identity
  observation: { ... },     // NON-authoritative, MUTABLE envelope
  observation_digest        // SHA-256 over observation — identifies a specific observation
}
```

**`core` (immutable, authoritative)** — `credential_type`(fixed protocol domain)· `credential_version`(version domain)· `repository_id`(stable)· `pr_node_id`(stable)· `pr_number` · `base_ref` · `head_sha`(actual observed)· `merge_commit_sha` · `merged_at` · `github_actor_id`(stable)· `lifecycle_event` · `supersedes_credential_id`(lifecycle parent link). `credential_type` + `credential_version` are in the digest so the same GitHub fact under a **different `credential_version`** gets a **different** `core_digest`/`credential_id` (domain/version isolation).

**`observation` (non-authoritative, mutable)** — `observed_at` · `repository_owner`/`repository_name`(display)· `repository_visibility_at_observation`(`unknown` if GitHub didn't say — **never guessed `public`**)· `head_ref`(display)· `github_login`(display)· `commit_authors[]`(ids/logins/names, `is_coauthor`; **no emails**)· `agent_provenance`(self-declared; `unknown` when not validly self-reported — **never guessed `human`**)· `claimed_task_id`/`source_ref`(self-reported, **non-authoritative**)· `contribution_type`(candidate; **`null` when not self-reported** — never guessed `code`)· `verification_state` · `evidence_scope` · `checks_summary` · `reviews_summary` · `dco_state` · **`evidence_coverage`** (per-stream `observed`/`unobserved`/`partial` — see §8 3B-2) · `merged_by_actor_id` · `evidence_refs` · `known_limitations`.

> **Cannot verify → never guess** also applies to the observation classifiers: a missing self-report yields `agent_provenance='unknown'` / `contribution_type=null`, and a missing GitHub visibility yields `repository_visibility_at_observation='unknown'` — an unknown Agent contribution is **not** silently recorded as human/code/public.

> **All credential objects are `strict`** (zod `strictObject` ⇄ JSON Schema `additionalProperties:false`): unknown fields are **rejected at both layers, at every level** (top / core / observation / nested). This keeps consumers consistent and prevents the immutable `core` from carrying un-digested side claims. *(The input GitHub-API parser stays lenient — GitHub's extra fields are ignored, not rejected.)*

> The same fact re-observed ⇒ **same `credential_id` + `core_digest`**, possibly a **different `observation_digest`**. `credential_id`/`core_digest` make **no** claim about the observation envelope.

---

## §2 Canonical digests / 确定性摘要

`core_digest = SHA-256( canonicalSerialize(core) )`; `observation_digest = SHA-256( canonicalSerialize(observation) )`; `credential_id = ghc_<core_digest[0:40]>`. Uses Node built-in `node:crypto` (**no new dependency**) and the repo's canonical-JSON idiom (recursively sort object keys; arrays keep order; `null` for absent fields).

**Core digest fields** (`DIGEST_CORE_FIELDS`): `credential_type`, `credential_version`, `repository_id`, `pr_node_id`, `pr_number`, `base_ref`, `head_sha`, `merge_commit_sha`, `merged_at`, `github_actor_id`, `lifecycle_event`, `supersedes_credential_id`. The leading `credential_type` + `credential_version` provide **protocol-domain / version isolation** (Codex P2): identical GitHub facts under different credential versions never collide on `credential_id`.

**Excluded from the core digest** (live only in the observation envelope): `observed_at`, display names, visibility-at-observation, `head_ref`, `github_login`, evidence summaries/URLs, self-reported task/provenance/type, `known_limitations`.

**Determinism:** key-order independent; **same fact ⇒ same `core_digest`** (idempotent); **any core change ⇒ different `core_digest`**. Proven by tests: idempotent repeat, rename (same ids) → same, force-push (head_sha) / supersedes change → different, forged self-report → **same core_digest but different observation_digest**.

---

## §3 Authenticity rules / 真实性规则 (the 12)

1. PR body / user `pr_ref` / self-reported JSON are **NOT** authoritative — kept only in the observation envelope, excluded from the core digest.
2. `merged` must come from the **GitHub API** for the **target repository** (verifier requires `expectedRepositoryId`).
3. Must verify `repository_id`, `pr_node_id`, `base_ref`, `merged`, `merge_commit_sha` — missing → `insufficient_evidence`.
4. `closed/unmerged` PR ⇒ **no** credential (`not_merged`).
5. Fork / rename ⇒ anchor on **stable IDs**; names are display-only (observation).
6. After force-push/rebase ⇒ record the **actual observed** `head_sha` / `merge_commit_sha`.
7. GitHub identity = attribution + future-claim candidate, **not** a Passkey owner — `accountable_party_ref` is always `null` at mint.
8. `Co-authored-by` ≠ DCO — `dco_state` is recorded **independently**.
9. Implementer / self-review / CI / audit / maintainer-merge are **distinct evidence** — never one "safe pass".
10. Never store tokens / cookies / full private diff / real emails / unnecessary PII.
11. Cannot verify ⇒ **never guess**: an unverifiable *fact* → typed refusal; an unprovided observation *classifier* → `unknown`/`null` (provenance/visibility/contribution_type are never defaulted to human/public/code).
12. Idempotent: the same fact observed twice ⇒ the same `core_digest` / `credential_id`.

> Plus the **trust boundary** (§0): structural + repo-anchor verification ≠ proof of GitHub source authenticity.

---

## §4 Lifecycle (append-only) / 生命周期(只追加)

**The verifier mints ONLY `merged` (merged-only profile).** State is **never overwritten in place** (append-only model). `merged` ⇒ `supersedes_credential_id = null` (no parent link); the field stays in `core`/the digest for forward compatibility.

**`reverted` / `superseded` / `void` are ALL deferred to PR 3B.** A pure PR response only proves *this PR merged* — it does **not** prove that it rolled back a target credential. Guessing a revert from PR title / body / branch name / commit message is **forbidden**. These lifecycle events require a **separate lifecycle-event verifier (PR 3B)** with their own trusted evidence + `reason` + explicit verification rules. The verifier returns `unsupported_lifecycle` for any non-`merged` lifecycle — which also closes the audit bug where an *unmerged* PR could be minted as `verified + void`, and the earlier gap where any merged PR could be relabeled `reverted` against an arbitrary parent.

> A revert PR is itself a merged PR → the verifier mints it as a normal `merged` credential (fixture 07). The *revert linkage* (lifecycle + supersedes) is established later by PR 3B.

---

## §5.1 Self-consistency ≠ schema ≠ anti-tamper / 三种不同保证

Three **different** guarantees — do not conflate them:

| | What it checks | What it CANNOT do |
|---|---|---|
| **Schema validation** (zod / JSON Schema) | structure + cross-field rules | **cannot verify hash relationships** — tampered `core` with a stale `core_digest` still passes |
| **Self-consistency** ([`self-consistency.ts`](../src/layer2-business/L2-9-contribution/github-credential/self-consistency.ts) `verifyCredentialSelfConsistency`) | re-computes & checks `core_digest === digestCore(core)`, `credential_id === ghc_<core_digest>`, `observation_digest === digestObject(observation)` | **NOT tamper-proof** (see below) |
| **Authenticity / anti-tamper** | proof the credential reflects real GitHub state and was not forged | **NOT possible in PR 3A** — needs an external root of trust (PR 3B) |

> ⚠️ **Self-consistency is NOT anti-tamper.** A plain SHA-256 recomputation only proves the payload is *internally consistent*. An attacker who controls the whole credential can edit `core` **and recompute** `core_digest` + `credential_id` — and self-consistency then **passes** (the test proves this on purpose). It detects accidental corruption / wrong-id wiring, not malicious tampering.

`verifyCredentialSelfConsistency(credential)` is a **pure function returning a typed result (never throws)**; the verifier runs it after schema validation. **Anti-tamper / authenticity is impossible from a self-describing payload** — it requires an **external root of trust**, deferred to PR 3B: **re-fetch + re-derive** the credential via an **authenticated** GitHub API, **or** verify a **trusted-service signature / anchored record**. **PR 3B ingestion MUST do that IN ADDITION to schema validation and self-consistency — never accept caller-supplied digests as proof of authenticity.**

---

## §5 Verifier (pure) / 纯函数 verifier

`verifyGithubContribution(resp, opts) → { ok: true, credential } | { ok: false, outcome }`, `outcome ∈ {wrong_repository, not_merged, insufficient_evidence, unsupported_lifecycle}`. No network I/O, no token; reads only structured fields. It **fully parses the external response with an input Zod schema first** — any malformed input (missing/typed-wrong `repository`/`owner`/`pull_request`/`user`/`base`/`head`/`observed_at`, a non-array or `[null]` `commit_authors`/`reviews`/`check_conclusions`, or a `null` response) returns a **typed `insufficient_evidence` refusal and never throws a `TypeError`**. Before returning, it runs **schema validation** and the **self-consistency** check (§5.1). Input is an **already-fetched** response — fetching (and proving its authenticity) is out of scope here (§0 trust boundary, PR 3B).

---

## §6 Dual-format consistency (zod ⇄ JSON Schema) / 双格式一致性

Canonical = zod (`superRefine`). The generated JSON Schema (`toJSONSchema()`) attaches the same cross-field rules as an `allOf` **`if/then`** block (on the nested `core`/`observation`):
- `merged` ⇒ `core.merge_commit_sha` + `core.merged_at` present **and** `core.supersedes_credential_id = null` **and** `observation.verification_state = verified`.

> **Schema layers validate STRUCTURE + cross-field rules only — they CANNOT verify hash relationships.** Digest self-consistency is a separate (still non-anti-tamper) guarantee (§5.1).

The static test ([`scripts/test-github-credential.ts`](../scripts/test-github-credential.ts), **wired into CI**) keeps the two in lock-step (drift guard), validates all minted credentials under **both** schema layers **and** self-consistency, rejects the **same illegal object** at both schema layers (e.g. merged + null `merge_commit_sha`, merged + non-null supersedes, non-`merged` lifecycle, non-null `accountable_party_ref`, bad digest format), proves self-consistency **rejects tampered core/observation/credential_id that still pass schema** *and* that it **is NOT tamper-proof** (a recomputed forgery passes — by design, needs PR 3B), proves **domain isolation** (a different `credential_version` yields a different id), and asserts the inlined `canonicalSerialize` is **byte-identical** to `order-chain.ts` (reuse no-drift).

---

## §7 Fixtures / 测试夹具

| Fixture | Scenario | Expected |
|---|---|---|
| 01 merged-ci-green | normal merged, CI green | credential |
| 02 fork-pr-merged | fork PR merged (base repo anchor) | credential |
| 03 closed-unmerged | closed, not merged | `not_merged` |
| 04 rename-same-ids | names changed, stable ids same | credential, **core_digest == 01** |
| 05 forcepush-head-changed | head_sha changed | credential, **core_digest ≠ 01** |
| 06 multi-author-agent | authors + co-authors + agent provenance | credential |
| 07 revert-pr-merged | a revert PR (itself merged) | minted as a normal `merged` credential |
| 08 insufficient-missing-merge-sha | merged but no merge_commit_sha | `insufficient_evidence` |
| 09 forged-body-taskid | forged self-reported task_id/author | credential, **core_digest == 01**, observation_digest ≠ 01 |
| 10 idempotent-repeat | same fact re-observed | credential, **core_digest & id == 01** |

Test also covers: `reverted`/`superseded`/`void`/anything ≠ `merged` → `unsupported_lifecycle`; `merged` + caller supersedes → forced `null`; **self-consistency counter-examples** (tampered core/observation/credential_id rejected while schema passes) **and the honest not-tamper-proof case** (recomputed forgery passes); **domain isolation** (credential_type/version change → different digest); **malformed input** (missing/typed-wrong fields, non-array/`[null]` `commit_authors`/`reviews`/`check_conclusions`, or `null`) → typed `insufficient_evidence`, no throw.

---

## §8 PR 3B — split roadmap (mandatory boundaries) / 拆分路线(强制边界)

PR 3B is split so each PR completes **one trust boundary**:

- **✅ PR 3B-1 — Authenticated GitHub Fetch Adapter (this PR):** [`github-fetch-adapter.ts`](../src/layer2-business/L2-9-contribution/github-credential/github-fetch-adapter.ts) — WebAZ performs its **own** authenticated, read-only GitHub fetch (fixed origin `https://api.github.com`, GET-only, manual-redirect, AbortSignal timeout, token never logged/returned), validates the responses, builds the PR #294 verifier input, and mints a credential **inside this trusted execution path**. This is what lets the *fetched* credential's `verified` mean "WebAZ read it from GitHub" — solving "the caller can forge the response".
  - **Control boundary (precise):** the **caller** chooses only `owner` / `repo` / `prNumber` (which PR to ask about). `expectedRepositoryId`, `token`, and the **runtime environment** are **trusted-service configuration**. The **transport and clock are the runtime's own** — the production entry takes **NO `fetchImpl` / `now`** and is the *only* path that can make the "authenticated source" claim. Injecting transport/clock (or any unknown arg) is **rejected** by a strict args schema (`invalid_request`), so a caller cannot return forged bytes without touching GitHub or forge `fetched_at`.
  - Repository **anchored on a stable `node_id` from trusted config** (never self-derived from the same response); fork PRs anchored on the **base** repo; the PR response's `number` must equal the requested `prNumber`. All predictable failures (auth/rate-limit/network/timeout/redirect/malformed/refusal/bad-args) are **typed outcomes, never thrown**.
  - **It does NOT make a serialized credential a portable signature** (see below); `fetch_metadata` is **audit info for this execution only**, not independently verifiable. Lifecycle still **`merged`-only**; no title/body/branch/commit inference. **No token/secret committed; tests swap `globalThis.fetch` and never touch the network.**
  - **`evidence_scope` is fixed to `public_metadata`** (not a caller argument): 3B-1 does not prove repo-collaborator access, so it must not let a caller claim a higher scope. Injecting `evidenceScope` is rejected (`invalid_request`).
- **✅ PR 3B-2 — richer evidence + credential v2 (this PR builds on 3B-1):** the adapter additionally fetches (best-effort, paginated, **in parallel under a shared deadline**) **check-runs** (by `head_sha`), **reviews**, and **commits → authors**. Each stream carries **machine-readable per-stream coverage** in `observation.evidence_coverage` (`observed`/`unobserved`/`partial`), so a consumer distinguishes "observed zero" from "not observed" — a summary's zeros/unknown are only meaningful when its coverage is `observed`. This is a **formal `credential_version` bump to `2`** (a strict schema rejects unknown fields both ways, so the new field is not v1-compatible; no v1 credentials are persisted, so v2 cleanly supersedes; the version is in the digest → v2 of a fact gets a different `credential_id`).
  - **Best-effort, honest:** the **core merged fact** (repo + PR) must still fetch or the credential is refused; a **supplementary** stream failure degrades that stream to `unobserved` (never half-claimed) and still mints. Supplementary items are **structurally validated**; an **unrepresentable item that gets dropped downgrades its stream to `partial`** (we never claim a complete result after dropping data; a malformed commit never becomes an all-`null` author).
  - **Pagination** is capped (10×100) → `partial`; the whole supplementary phase shares a **wall-clock deadline** (`min(4×timeoutMs, 20s)`), per-page timeout capped by the remaining budget — a slow stream is cut to `partial`, never an unbounded hang. **Commits** also cross-check the PR's total `commits` count — GitHub's PR-commits API truncates at **250**, so a short last page below the total is marked **`partial`** (≥250 with no total → conservatively `partial`).
  - **DCO is DEFERRED:** a DCO check-run `success` does **not** reliably prove a real-human `Signed-off-by` (the DCO legal statement) — e.g. a lenient check may pass on `Co-authored-by`. The adapter does **not** derive `present`/`absent` from a check whose semantics it cannot verify; `dco_state` stays `unknown` / coverage `unobserved`. Reliable DCO (verifying per-commit `Signed-off-by` against the author) is a later PR. **Never** parsed from commit `Signed-off-by` here either.
  - **Reviews** are deduped per reviewer: final state = the last **decisive** review (`APPROVED`/`CHANGES_REQUESTED`/`DISMISSED`); `COMMENTED` never changes it. One vote per reviewer.
  - **Co-authors** come only from a valid `Co-authored-by:` trailer in the commit message's **trailing trailer block** (a distinct last paragraph whose every line is a `Token: value` trailer) — **not** arbitrary body lines. Both a non-empty name and a syntactically-valid email are required, but the **email is never stored** (rule 10; name only). These are **commit-declared and IDENTITY-UNVERIFIED** (no GitHub id; `author_id=null`) → **must not be used for identity claim or reward** (also stated in every credential's `known_limitations`).
  - *Still deferred:* elevating `evidence_scope` to `repo_collaborator_metadata` requires *proving* collaborator/admin access.
  - *Deferred to 3B-3:* DB store (append-only `github_contribution_credentials`) + ingestion → RFC-017 fact layer. **Ingestion MUST re-establish trust** (re-fetch via 3B-1's authenticated path, **or** verify a trusted-service **signature / anchored record**) **in addition to** schema + self-consistency — **never** accept a caller-supplied credential's digests as proof. Only then emit a **Contribution Fact** (`source=github`, `artifact_ref=merge_commit_sha`, `executor_ref=github_actor_id`, `accountable_ref=null`, `status` from `lifecycle_event`). Credential ≠ Fact. `observation_digest` persistence + `credential_id`-bound-to-`core`-only also decided here.
- **`reverted`/`superseded`/`void` lifecycle-event verifier (separate):** own trusted evidence + `reason`; not provable from a single PR response.
- **Identity Claim (later):** Passkey binding sets `accountable_party_ref` on the *fact*, not on the immutable credential.
- **Assurance Surface (later):** referenced, not built.

> **A serialized credential is still NOT a signature.** Authenticity holds only *inside* the fetch execution; a credential replayed later cannot be re-verified for source authenticity without re-fetching (or a future signing/anchoring step). Storage, ingestion, lifecycle-events, and Passkey claim remain **deferred**; this RFC-017 slice stays **draft / dogfood** (§0/§12 — value is `uncommitted`). **No reward / redemption is claimed at any step.**
