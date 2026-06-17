# Future Task Board v1 — design contract (design-only, no implementation)

> **Design contract only.** This locks what a future real task board (`build_tasks` + `webaz_contribute` +
> a PWA board) must express — fields, filters, claim rules, MCP/PWA behavior, and safety/audit boundaries —
> **before** any of it is built. It implements **nothing**: no DB / schema / API / MCP / PWA / UI change,
> no reward / score formula / relationship-graph write / automatic ingestion / webhook / cron. All
> contribution value stays **`value_state: uncommitted`** (RFC-017 I-12) — no amount, percentage, yield,
> payout, or reward is promised.
>
> Authority: **RFC-006** (the `build_tasks` coordination state machine), **RFC-017** (the uncommitted-value
> boundary), [`AGENT-READY-TASK-SPEC.md`](AGENT-READY-TASK-SPEC.md) (the agent-ready field set).
## §1 Data contract / 数据契约

A future task **must be able to carry the complete #325 case-pack field set** (a board that can't represent
a sample task can't run the dogfood). The fields:

`task_id` · `title` · `summary` · `area` · `task_type` · `source_ref` · `rfc_ref` · `version` ·
`allowed_paths` · `forbidden_paths` · `prohibited_actions` · `risk_level` · `audience` · `agent_autonomy` ·
`auto_claimable` · `human_confirmation_points` · `required_capabilities` · `acceptance_criteria` ·
`verification_commands` · `expected_results` · `deliverables` · `definition_of_done` · `estimated_duration`
(`{min_minutes, max_minutes}`) · `estimated_context_size` (`small|medium|large`) · `estimated_agent_budget`
(`minimal|small|moderate|large|xlarge`) · `dependencies` · `blocking_conditions` · `value_state`
(**const `uncommitted`**) · `contribution_type` · `accountable_party_required` · `status` · `claimer_id` ·
`provenance`.

**Core vs satellite (schema NOT locked here):** the existing `build_tasks` columns (`id`, `title`, `area`,
`status`, `claimer_id`, `provenance`, `rfc_ref`, timestamps) stay **core**; the new execution-boundary,
acceptance, estimate, and attribution fields are best held in a **satellite table or a JSON metadata
column** so the board can evolve without locking a final schema. The final shape is decided in PR9B, not
here.

## §2 Discovery & filtering / 发现与过滤

`list_open` (and the PWA board) must let a human or agent filter open tasks by:
`status=open` · `area` · `risk_level` · `required_capabilities` · `estimated_duration` ·
`estimated_context_size` · `estimated_agent_budget` · `auto_claimable` · `audience` — so an agent matches
tasks to its idle time, capability, and risk tier, and a human can find a task to hand to their agent.

## §3 Claim rules / 认领规则

- **State machine (inherited from RFC-006):** `open → claimed → in_review → done | abandoned`. Preserve
  the existing guarantees: **atomic claim on `open` only** (one winner), **claim TTL / auto-release** of
  stale claims, a **WIP limit** per claimer, and **human acceptance** (`done` / `abandoned` are decided by
  a maintainer, never self-asserted by the claimer).
- **`risk_level ∈ {high, critical}` ⇒ `auto_claimable = false`** and `agent_autonomy ∈ {human_in_the_loop,
  human_only}` with ≥1 `human_confirmation_points`.
- **`risk_level = critical` ⇒ `audience ∈ {restricted, internal}` (never `public`).**
- **When information is insufficient, the agent marks `needs_clarification` and asks — it must not guess**
  and act on an ambiguous scope / boundary / acceptance.

## §4 MCP behavior / MCP 行为

The future `webaz_contribute` (RFC-006: `list_open` / `detail` / `suggest` / `claim` / `submit` / `status`) must:

- **Discovery (`list_open` / `detail`) and `suggest` need no api_key** — anyone / any agent can browse and
  propose against the public surface; only `claim` / `submit` / `status` / `profile` require an api_key (a
  real, accountable identity). Discovery returns the same **trusted `canonical_contribution_target`** as
  the PWA (a PR must target the canonical repo; a `source_ref` never overrides it).
- `list_open` returns the **machine-readable task fields** (the §1 set) so an agent can decide and filter.
- `detail` returns one task's full execution boundary + canonical target + a copy-ready agent handoff
  (boundary / forbidden / verification / canonical-repo PR rule / DCO); a sandbox or local draft is **not**
  participation.
- `suggest` files a task proposal into the maintainer inbox (RFC-017) — a suggestion, **not** a
  contribution fact / reward / participation; it never auto-becomes a task.
- `claim` **must refuse to auto-claim a `high` / `critical` task** (those require a human-in-the-loop /
  human-only path), and refuses a non-`open` task (atomic).
- `submit` **must carry a PR / ref and a verification-result summary** (the `verification_commands` and
  their outcome) — a submission without verification is not `in_review`.
- **Sandbox mode must continue to refuse participation** — a local/sandbox run is **not** a contribution
  record (by design, not a bug).

## §5 PWA behavior / PWA 行为

- A human can **view tasks, filter them (§2), and copy a task to their own agent** (e.g. a copy-ready
  prompt with the task's boundaries + verification commands).
- The board UI shows **no reward promise** — only the **`uncommitted` value boundary** (the same
  `value_boundary` every contribution display carries: `value_state: uncommitted`, valuation/redemption
  `not_defined`, `economic_rights: false`). No amount, percentage, yield, or payout is shown.

## §6 Safety & audit / 安全与审计

- **High-risk tasks must be routed to a separate, higher-audit RFC/PR** — the board does not let an
  ordinary public task perform a high-risk action.
- A task **must never lead an agent to touch real funds, production secrets, real user data, the production
  database, a deploy, or a migration.** Those zones are `forbidden_paths` / `prohibited_actions` and route
  to higher audit.
- **`done` ≠ `merge`.** Reaching `done` is human acceptance of the work; **merging is always a
  Holden / maintainer decision**, and `done` never triggers an automatic reward (there is none —
  `uncommitted`).

## §7 Suggested implementation split / 实施拆分建议

Each is a single-topic, Codex-gated PR — **none of them is this PR**:

- **PR9B** — DB / satellite-metadata design **or schema only** (no API/UI), final shape decided there.
- **PR9C** — API read/write (`routes/build-tasks.ts`): accept/return the new fields + the §2 discovery
  filters.
- **PR9D** — MCP `webaz_contribute` per §4: keyless `list_open` / `detail` / `suggest` over the public
  surface + keyed `claim` / `submit` / `status` / `profile`. — *done*
- **PR9E** — PWA board per §5. **PR9E-1** (public pages: `#contribute/tasks` list / detail / suggest) — *done*.

## §8 What this PR does NOT do / 本 PR 不做什么

No DB / schema / API / MCP / PWA / UI implementation in this PR. No task board built. No reward / score
formula / percentage / amount / payout / settlement / KYC. No relationship-graph write, no automatic
ingestion / webhook / cron. No change to `sponsor_id` / `placement_id` / `placement_side`. No
wallet / escrow / commission / production config / deploy. A local **sandbox / private draft is not
participation** — by design. Reward, right, income, and payout are **never** guaranteed; all contribution
value stays `uncommitted`.
