# Agent-ready Task Specification v1 / Agent 可执行任务规范 v1

**Status**: draft — spec only (no code/schema/API/UI change)
**Author**: @seasonkoh
**Created**: 2026-06-11
**Related**: [RFC-006](rfcs/RFC-006-contribution-layer.md) (build_tasks coordination, *implemented*) · [RFC-017](rfcs/RFC-017-contribution-protocol-v1.md) (contribution protocol — facts/identity/claim/uncommitted value) · `src/layer2-business/L2-9-contribution/build-tasks-engine.ts` · `src/pwa/routes/build-tasks.ts` · MCP `webaz_contribute` · [AGENTS.md](../AGENTS.md) · [CONTRIBUTING.md](../CONTRIBUTING.md)
**Machine-readable**: [`spec/agent-task/agent-task.schema.ts`](../spec/agent-task/agent-task.schema.ts) (canonical zod) · [`agent-task.schema.json`](../spec/agent-task/agent-task.schema.json) (generated) · [`fixtures/`](../spec/agent-task/fixtures/) · test `npm run test:agent-task-spec`

---

## §0 Purpose & scope / 目的与边界

**Goal:** let a stranger hand a task to **their own legally-used Agent**, and have the Agent **complete it safely with minimal clarification and minimal human round-trips** — while **preserving** RFC-006's existing `build_tasks` state machine and `webaz_contribute`'s design.

**目标**:让陌生参与者把任务交给**其合法使用的 Agent**,Agent 能在**极少澄清、低真人操作**下安全完成,同时**保留** RFC-006 现有 `build_tasks` 状态机与 `webaz_contribute` 的优秀设计。

**This document is a *task-exchange contract*, not a migration.** It is a **superset** spec layered on the existing state machine — it adds the fields an Agent needs, maps them to what exists, and lists the gaps a future implementation must close.

> **This PR ships:** spec doc + machine-readable schema (zod + generated JSON Schema) + ≥4 fixtures + a static validation test + a CI job running it. **It does NOT:** change DB tables/migrations, API, MCP handlers, UI; implement GitHub credentials, Passkey claim, performance scoring, or the Agent Assurance Surface; touch wallet/fund/order state machine/permissions/prod config. / **本 PR 只做**:规范 + schema + fixtures + 静态测试 + CI job;**不做**上述实现项。

---

## §1 Preserved foundation (RFC-006) — do NOT redraw / 必须保留(不得从零重画)

The existing state machine and invariants are **authoritative and preserved**:

```
open → claimed → in_review → done | abandoned
```

| Preserved invariant | Source |
|---|---|
| Atomic claim (only `open` is claimable; concurrent → one winner) | `claimBuildTask` (UPDATE … WHERE status='open') |
| Claim TTL (~7d, lazy auto-release back to `open`) | `releaseExpiredClaims` / `claim_expires_at` |
| WIP limit (≤5 active claims/person) + create rate limit | `MAX_ACTIVE_CLAIMS` / `CREATE_RATE_PER_DAY` |
| Self-declared provenance (human / ai_assisted / ai_authored) | `claimer_provenance` |
| Human acceptance only (`done`/`abandoned` = admin/maintainer) | `resolveBuildTask` |
| Event log (every transition) | `build_task_events` |
| Reward anchored to real human (done credits build_reputation only if Passkey anchor) | `resolveBuildTask` → `creditBuildReputation` |

This spec **adds fields around** that machine; it never replaces or weakens it. The static test asserts the spec's `status` enum **equals** `build-tasks-engine.ts` `TASK_STATUS`.

---

## §2 Fields / 字段

Grouped as required by the task. Types and enums are normative in the [zod schema](../spec/agent-task/agent-task.schema.ts).

### Identity / 身份
`task_id` · `title` · `summary` · `task_type` · `area` · `source_ref` · `rfc_ref`

### Execution boundary / 执行边界
`allowed_paths`† · `forbidden_paths` · `prohibited_actions`† · `risk_level` · `audience` · `agent_autonomy` · `human_confirmation_points` · `required_capabilities`† · `auto_claimable`

- **`audience`**: `public | restricted | internal` — who a task may be exposed to. **`critical` ⇒ MUST NOT be `public`** (enforced in both schema layers). Convention: high-risk fixtures are `restricted`, ordinary public tasks are `public`.
- **† non-empty** (`NonEmptyStrList`): `allowed_paths`, `prohibited_actions`, `required_capabilities`, `verification_commands`, `expected_results` must have ≥1 entry — an Agent cannot act safely on a vacuous boundary / acceptance list.
- **Empty allowed**: `forbidden_paths`, `human_confirmation_points`, `dependencies`, `blocking_conditions`. `forbidden_paths` may be empty, but **public tasks SHOULD list high-risk forbidden zones explicitly** (defense-in-depth for autonomous Agents).

### Acceptance / 完成标准
`acceptance_criteria` (structured list) · `verification_commands` · `expected_results` · `deliverables` · `definition_of_done`

### Work estimate / 工作估计
`estimated_duration` `{min_minutes,max_minutes}` · `estimated_context_size` (`small|medium|large`) · `estimated_agent_budget` (**relative tier only**: `minimal|small|moderate|large|xlarge` — **never** product-specific token counts) · `dependencies` · `blocking_conditions`

### Contribution & attribution / 贡献与归属
`provenance_requirement` · `accountable_party_required` · `reward_eligibility` (`eligible|pending|excluded`) · `value_state` (**const `uncommitted`** — RFC-017 I-12) · `contribution_type` (RFC-017 §5: `code|tests|audit|maintenance|governance|usage|transaction|referral`)

### Lifecycle / 生命周期
`status` · `claimed_by` · `claim_expires_at` · `submission_ref` · `resolution` · `version`

### Reserved (referenced, not built) / 预留
`assurance` `{required, evidence_refs?, notes?}` — see §6. Optional signals: `needs_clarification`, `scope_partition`.

---

## §3 Risk tiers / 风险分级

| Tier | Examples | Agent autonomy |
|---|---|---|
| **low** | docs, i18n, test additions, SDK examples, non-sensitive UI | highly autonomous; `auto_claimable=true` allowed |
| **medium** | shared logic, ordinary API, non-financial data writes | `supervised`; stronger tests + human review before merge |
| **high** | wallet, balance, escrow, order state machine, stake, commission, charity/global fund, KYC/admin, permissions, API key, migration, prod config | `human_in_the_loop`/`human_only`; **`auto_claimable=false`**; explicit authorization + dedicated audit |
| **critical** | production funds, secrets, deploy, executing DB migrations, irreversible ops | **not opened to ordinary public tasks**; `auto_claimable=false` |

**Enforced in BOTH schema layers (zod superRefine + JSON Schema `if/then`):**
- `risk_level ∈ {high,critical}` ⇒ `auto_claimable=false`
- `risk_level ∈ {high,critical}` ⇒ `agent_autonomy ∈ {human_in_the_loop, human_only}`
- `risk_level ∈ {high,critical}` ⇒ `human_confirmation_points` ≥ 1
- `risk_level = critical` ⇒ `audience ∈ {restricted, internal}` (never `public`)

The static test proves the **same illegal object is rejected at both layers** (e.g. high + `auto_claimable=true`, or critical + `audience=public`) — see §8.

---

## §4 Process rules / 流程规则 (the 12)

1. **Discovery.** An Agent finds suitable tasks by filtering `status=open` on `required_capabilities`, `risk_level`, `estimated_duration`, `estimated_agent_budget`, and `area` — matching its idle time and capability. (`webaz_contribute action=list_open` is the existing entry; gap §7 adds capability/risk filters.)
2. **Conflict check before claim.** Claim is **atomic** on `open` only (preserved). The Agent must `list/get` and confirm `status=open` and no overlapping `allowed_paths` with an active claim before attempting; the engine guarantees one winner.
3. **Stuck → report & release.** If blocked, the Agent posts a note (event) and **releases** (`→ open`) so others can take it, rather than holding the claim until TTL. TTL auto-release remains the backstop.
4. **Verification gates completion.** An Agent **must not** claim completion unless `verification_commands` produce `expected_results`. Failing verification ⇒ not done.
5. **Insufficient description → `needs_clarification`, not guessing.** When the task is under-specified, the Agent sets `needs_clarification=true` and asks — it does **not** guess. This is a **signal/event, NOT a new status** (the state machine is unchanged).
6. **Version change invalidates stale claims.** Bumping `version` while a task is claimed requires the claimer to **re-confirm**; otherwise the claim is invalidated (back to `open`).
7. **Multi-agent scope declaration.** Collaborating Agents declare non-overlapping `scope_partition` (and/or split into sub-tasks with disjoint `allowed_paths`) so they don't collide.
8. **No duplicate PRs.** Atomic single-claimer (preserved) + a single `submission_ref` per task prevents two PRs for the same task.
9. **Done ≠ merge.** Reaching `in_review`/passing verification does **not** merge. Merge authority stays with **Holden / a maintainer** (RFC-006 human-acceptance invariant; CHARTER).
10. **One line still counts.** Even a single valid line of contribution must be able to enter the later **contribution fact layer** (RFC-017 I-3) — the fact is recorded permanently regardless of size.
11. **ToS-legitimate capabilities only.** An Agent may use **only** Agent/subscription capabilities that are **legally owned and permitted by their Terms of Service** (RFC-017 I-16).
12. **Human- and machine-readable.** Output serves both: human prose in this doc + the machine-readable schema/fixtures for Agent parsing.

---

## §5 RFC-006 compatibility mapping / 与现有 build_tasks 的兼容映射

| Spec field | Existing `build_tasks` | Note |
|---|---|---|
| `task_id` | `id` (`bt_…`) | same |
| `title` | `title` | same (≤200) |
| `summary` | `description` (partial) | summary = short form of description |
| `task_type` | — | **new** (`area` is adjacent but not a type) |
| `area` | `area` | same |
| `rfc_ref` | `rfc_ref` | same |
| `source_ref` | — | **new** (issue/PR/inbox ref) |
| `status` | `status` | **same state machine** (asserted by test) |
| `claimed_by` | `claimer_id` | same |
| `claim_expires_at` | `claim_expires_at` | same (TTL preserved) |
| `submission_ref` | `pr_ref` | same role |
| `resolution` | `resolution` | same |
| `provenance_requirement` | `claimer_provenance` (actual, not required) | existing stores the *actual*; spec adds the *allowed* set |
| `version` | — | **new** (claim invalidation, rule 6) |
| execution boundary (`allowed_paths`/`forbidden_paths`/`prohibited_actions`/`risk_level`/`audience`/`agent_autonomy`/`human_confirmation_points`/`required_capabilities`/`auto_claimable`) | — | **all new** |
| acceptance (`acceptance_criteria`/`verification_commands`/`expected_results`/`deliverables`/`definition_of_done`) | — | **all new** |
| estimate (`estimated_*`/`dependencies`/`blocking_conditions`) | — | **all new** |
| attribution (`reward_eligibility`/`value_state`/`contribution_type`/`accountable_party_required`) | implicit (build_reputation credit on done, Passkey-gated) | **new explicit fields**, aligned to RFC-017 |
| `assurance` | — | **new, reserved** (§6) |

`created_by`, `created_at`, `updated_at`, and the `build_task_events` log are preserved as-is (not part of the exchange contract surface but unchanged).

---

## §6 Agent Assurance Surface — reserved, NOT built / 预留,不实现

A future **Agent Assurance Surface** will provide tasks and the using Agent with: capability risk, CI status, independent-audit results, reviewed-commit evidence, known limitations, stale-state, and human-confirmation recommendations.

**This PR only ensures the task spec can *reference* assurance** via the optional `assurance` field (`required` / `evidence_refs` / `notes`). **No dashboard, no collection, no enforcement is built here.**

未来 **Agent Assurance Surface** 将向任务与使用 Agent 提供 capability risk / CI / 独立审计 / reviewed commit / known limitations / stale 状态 / human-confirmation 建议。**本 PR 仅确保任务规范可*引用* assurance,不建看板、不采集、不强制。**

---

## §7 Gap list — future DB / API / MCP implementation / 后续实现缺口

Closing this spec into running code (separate later PRs) requires:

- **DB:** add columns/satellite tables for the new fields (`task_type`, `source_ref`, `version`, execution-boundary, acceptance, estimate, attribution, `assurance`). **No migration in this PR** — and never lock the final schema here.
- **API (`routes/build-tasks.ts`):** accept/return the new fields; add discovery filters (`required_capabilities`, `risk_level`, `estimated_duration`, `budget`).
- **MCP (`webaz_contribute`):** extend `list_open`/`claim` to honor `auto_claimable` (refuse auto-claim of high/critical), surface `human_confirmation_points`, and expose discovery filters; keep iron-rule/human-acceptance behavior.
- **Validation wiring:** enforce the zod schema at the create/claim boundary (refuse high/critical auto-claim) — reusing this PR's canonical schema.
- **Claim invalidation:** implement rule 6 (`version` bump ⇒ re-confirm) and rule 5 (`needs_clarification` signal) **without** adding a new core status.
- **Fact-layer feed:** on `done`, emit a contribution fact (RFC-017 fact layer) so even a one-line contribution is permanently recorded.
- **Assurance Surface:** the separate future surface (§6).

> All of the above are **out of scope for this PR** and are listed so the next PRs have a concrete checklist. Final DB schema and any scoring numbers remain **deferred** (RFC-017 §0/§15).

---

## §8 Dual-format consistency (zod ⇄ JSON Schema) / 双格式一致性

The spec ships in two machine-readable forms that **must agree**:

- **Canonical:** [`agent-task.schema.ts`](../spec/agent-task/agent-task.schema.ts) (zod). Cross-field rules live in `superRefine`.
- **Generated:** [`agent-task.schema.json`](../spec/agent-task/agent-task.schema.json) (JSON Schema, Draft 2020-12). The same cross-field rules are expressed as `allOf` **`if/then`** blocks, so a pure JSON-Schema consumer (no zod) enforces them too.

`toJSONSchema()` generates the base structure from zod and **attaches the conditional `if/then` blocks**, so the committed `.json` is fully generated (single source of truth). The static test ([`scripts/test-agent-task-spec.ts`](../scripts/test-agent-task-spec.ts), `npm run test:agent-task-spec`, **wired into CI**) guarantees:

1. every fixture validates under **both** layers;
2. core list fields reject empty arrays (`NonEmptyStrList`), informational lists still allow empty;
3. the **same illegal object** (e.g. high + `auto_claimable=true`, or critical + `audience=public`, or `value_state≠uncommitted`) is **rejected at both layers** — using a lightweight in-repo JSON-Schema evaluator (no new dependency);
4. the committed JSON Schema is **in sync** with the zod source (drift guard) and structurally carries the 4 `if/then` blocks;
5. the `status` enum **equals** RFC-006 `build-tasks-engine.ts TASK_STATUS` (state machine preserved).

两份机器可读形态**必须一致**:canonical 为 zod(跨字段规则在 `superRefine`),generated 为 JSON Schema(同规则以 `allOf`/`if-then` 表达,纯 JSON-Schema 消费方也能强制)。`toJSONSchema()` 由 zod 生成基础结构并附加 if/then 块(committed `.json` 全自动生成,单源)。静态测试(已接入 CI)证明:两层都校验 fixtures、核心字段空数组双层拒绝、**同一非法对象在 zod 与 JSON Schema 两层都被拒绝**(用仓库内轻量 evaluator,零新依赖)、JSON Schema 与 zod 源同步且带 4 个 if/then、状态机 enum 与引擎一致。
