# RFC-006: Contribution Layer — applying trade-side trust primitives to building / 把交易侧的信任原语用到"建设"上

**Status**: implemented — 2026-06-06 (all stages; #101/#103/#104; stage 4 by reuse of existing accountability middleware)
**Author**: @seasonkoh
**Track**: normal — new module (coordination + build-reputation + contributor dashboard); does NOT change merge authority or any meta-rule
**Related**: [RFC-002](RFC-002-rewards-opt-in.md) (rewards opt-in identity) · [RFC-004](RFC-004-build-feedback.md) (feedback intake) · [RFC-005](RFC-005-ai-triage-pipeline.md) (AI triage, advisory-only) · CONTRIBUTING (approval matrix) · CHARTER §3.2/§4 (decision authority + iron rules) · framework §2.1④/§3.1/§4.2 (contribution-as-type, position-as-modifier)

---

## The root problem / 根问题

> **没有雇佣关系,怎么保证质量和方向?** / How do you guarantee quality and direction **without an employment relationship**?

Traditional companies use **hire + manage + fire**. A decentralized protocol cannot. But it has three equivalents — and WebAZ already runs all three, **on the trade side only**:

| Equivalent / 等效物 | Trade side (already built) / 交易侧已有 | This RFC: apply to building / 本 RFC:搬到建设 |
|---|---|---|
| **门槛 Gate** (who may act) | verifier (age≥60d / ≥20 orders / rep≥110) · arbitrator (90d / 50 / rep≥300) | tiered contribution access: docs=open · review PR=gated · protocol-level=highest + guardian backstop |
| **信誉 Reputation** (whose word counts) | `reputation` pool, outlier penalty | a **separate** `build_reputation` pool |
| **不可逆判例 Irreversible precedent** (errors have consequences) | agent-strike · blocklist · arbitration | same machinery, applied to contributions |

This RFC is **not** a new trust model. It is **reuse**: ~90% of the parts exist; only a coordination layer and a build-reputation/visibility loop are genuinely new.

---

## Scope — what this layer CAN / CANNOT do / 边界:能做什么、不能做什么

> Safety-first, limited-scope by construction. New mechanism, **zero new authority** over the protocol. Limits are structural (code/config), not promises.

**✅ CAN / 能:**
- Coordinate work: list open tasks, **claim** one, mark in-review/done (prevent 100 people colliding)
- Record **accepted** contributions into a **separate** `build_reputation` pool
- Show each contributor **their own** KPI / tier / achievements / restrictions / penalties + an appeal entry
- Carry self-declared **provenance** (human / AI-assisted / AI-authored) alongside the accountable identity
- Apply existing strike / blocklist / outlier machinery to bad-faith contributions

**❌ CANNOT (structurally blocked) / 不能(结构性禁止):**

| ❌ | Why it's blocked / 挡得住的原因 |
|---|---|
| build_reputation → unlock verifier/arbitrator (or any **trade** privilege) | **separate pool**, never read by trade-side eligibility — see Invariant 1. Doing docs can never buy a trading role. |
| any actor (human or AI) auto-merge / write `main` / decide protocol-level | branch protection (humans only) + CHARTER §4 iron rule; AI advisory-only inherited from RFC-005 — see Invariant 2 |
| publish a public contributor leaderboard / ranking | self-view only; pre-launch operational scale stays private — see Invariant 3 |
| "detect AI-generated content" and auto-reject | we do **not** police authorship (unreliable, arms-race). We require **accountable identity + self-declared provenance** instead — see §"Provenance" |
| grant standing by identity ("founder/maintainer floor") | contribution counts by *what was done × how depended-upon* (framework §4.2); accumulation is **computed**, never granted (contribution types, not identity privilege) |
| reward an unverified actor | crediting requires a **Passkey anchor** on the contributor (real human) — reuses RFC-004's `credit_skipped_no_anchor` gate |

Kill switch: the coordination board and dashboard are read-mostly; disabling the MCP tool / route leaves trade + governance untouched.

---

## Invariants (locked) / 不变量(已锁)

1. **Separate build-reputation pool.** `build_reputation` is computed and displayed independently and is **never** an input to `verifier`/`arbitrator`/any trade-side eligibility. Rationale: prevent "farm doc edits → qualify as arbitrator", upholds contribution-types-not-privilege and protocol-level fairness (§3.1 position ≠ income-right).
2. **merge / protocol-level = real human (iron rule).** No actor — contributor agent, triage AI, or this layer — can merge or decide protocol-level. Inherited from CHARTER §4 + RFC-005 (AI advisory-only). This layer only *coordinates* and *records*.
3. **Dashboard is self-view, private.** A contributor sees **their own** KPI/tier/penalties + appeal. **No public contributor leaderboard** pre-launch — that leaks operational scale and invites premature forks. Public/aggregate views are re-evaluated once real users exist.

These three are enforced in code (pool separation, route gating, branch protection), not by convention.

---

## Why now / 为什么现在做 (and why *minimal*)

Pre-launch, **0 real contributors**. The flywheel doesn't spin yet. As with RFC-005, we **build the mechanism, not the volume** — and say so plainly. Building these rails now (while it's cheap and we are agent-native from day one) means the first real contributors land on a coordinated, accountable, rewarding surface instead of an unmanaged free-for-all. We deliberately build the *minimum* viable parts, not a heavyweight contribution platform.

This RFC closes the two gaps identified in the four-problems analysis:

- **Gap 1 — coordination** ("who's doing what", problem 3c: prevent collisions). RFCs already align *large* changes; what's missing is claiming *day-to-day small* changes.
- **Gap 2 — reward closed-loop** (problem 4c: churn). Open-source churns when contribution yields no visible belonging/return. RFC-004 already wired *one* contribution type (feedback) into co-build reputation; this generalizes it and **makes it visible**.

The other problems are already covered by existing parts: tiered access (gate), 3-verifier vote + outlier (cross-check), meta-rule trace + dual-AI triage (digestion), CHARTER/meta-rules/guardianship/onboarding-quiz (alignment + anti-malice).

---

## Design / 设计

### A. Provenance — attribution, not detection / 溯源:问责而非检测

We cannot reliably tell whether text was written by an AI. So we do not try. Instead, every contribution carries:

1. **Accountable identity** (already enforced by the accountability middleware): `agent` (api_key + declared scope + custodian human) vs `human` (Passkey). The custodian is liable regardless of who/what authored the text.
2. **Self-declared provenance**: `human` | `ai_assisted` | `ai_authored`. Honest disclosure is the norm; a false declaration that surfaces becomes an irreversible precedent (strike). Same philosophy as the trade-side disclosure posture.

The dashboard shows provenance transparently — informative, not punitive.

### B. Gap 1 — coordination layer (minimal) / 协调层(最小)

- **Table `build_tasks`**: `id, title, area, status (open|claimed|in_review|done|abandoned), claimer_id, provenance, rfc_ref, created_at, updated_at`. Claims expire (auto-release stale claims) so nothing is silently parked forever.
- **MCP tool `webaz_contribute`** (agent-native — the primary path): `list_open` / `detail` / `suggest` / `claim` / `submit` / `status` / `profile`. Discovery (`list_open` / `detail`) and `suggest` need no api_key (public surface); `claim` / `submit` / `status` / `profile` require an api_key (accountable identity). Before changing an area, an agent calls `list_open` to see if someone's already on it and whether the direction is settled.
- **Scope**: day-to-day small changes. *Large* changes still go through the RFC process (this is not a replacement for RFC alignment).

### C. Gap 2 — build-reputation pool + contributor dashboard / 建设信誉池 + 贡献者看板

- **Table `build_reputation`** (separate pool, Invariant 1): per-contributor accepted-contribution count × depended-upon weight (framework §4.2 formula), derived tier, achievements. **Never** read by trade-side eligibility.
- **Tiered access mapped from trade gates**: docs/translation = open · review = gated (verifier-like threshold) · protocol-level = highest (arbitrator-like) + guardianship backstop. "People-count" can only do low-risk work; high-risk work is structurally held by the few (the Linux maintainer pattern).
- **Self-view dashboard** (PWA `#my-contributions` + MCP `webaz_contribute status`), showing — exactly what the contributor asked to see:
  - my contribution KPI (submitted / accepted / depended-upon)
  - my tier = what I am currently allowed to do
  - achievements / belonging (visible → anti-churn)
  - **restrictions & penalties** (strike / downgrade / suspension) **with reason + appeal entry** — transparency *before/with* enforcement, same as the agent passport
- **Generalize crediting**: extend RFC-004's co-build credit (`recordRepEvent` + Passkey-anchor gate, already live for feedback) to all accepted contributions → `build_reputation`. Credit only on acceptance, once, Passkey-anchored (anti-gaming reused as-is).

### D. Malicious-contributor management — near-zero new build / 恶意管理:几乎零新建

Reuse, retargeting the object from "trade" to "building":
- **gate** keeps high-risk work in few hands;
- **agent-strike / blocklist** issued against bad contributions, accumulate → downgrade/ban;
- **outlier penalty** on the review side: a reviewer who is *wrong* (not merely in the minority) is penalized, mirroring `claim_verify`;
- **merge / protocol-level = human** (Invariant 2);
- the dashboard lets the accused **see their own deductions + reason → appeal → precedent**.

---

## Staged delivery / 分阶段交付

Build the mechanism; do not chase volume. Each stage is a single-topic PR, human-reviewed, human-merged.

1. **This RFC** (design + CAN/CANNOT + invariants). — *done (#101)*
2. **Gap 1**: `build_tasks` + MCP `webaz_contribute` (list_open/claim/submit/status). Read-mostly coordination. — *done (#103)*
3. **Gap 2**: `build_reputation` separate pool + `#my-contributions` self-view dashboard + generalized co-build crediting (feedback_accepted + task_done → build pool, Passkey-anchored). Also fixed the pre-existing leak where feedback credit went to the *trade* reputation pool. — *done (#104)*
4. **Malice wiring**: **no new code — already enforced by reuse.** `build_tasks` are api_key write endpoints, so a contributor struck to `suspend_7d`/`permanent` is already blocked from all build writes by the existing accountability middleware (`isApiKeyBlocked`, server.ts) — the same machinery that gates trade. strike/blocklist/outlier therefore retarget to contributions automatically. The dashboard surfaces a contributor's active strikes + appeal entry (transparency); appeals use the existing `POST /api/me/agents/strikes/:id/appeal`. We deliberately did **not** add a redundant build-specific suspend gate. — *done by reuse*

The only genuinely new storage is `build_tasks` and `build_reputation`. Schema additions follow the ALTER-after-CREATE rule; `schema:verify` gates each.

---

## Honesty (pre-launch) / 诚实

0 real contributors today. We are building rails, not expecting traffic. The dashboard will, pre-launch, mostly show empty/seed state — and we say so. Maintainer capacity still bounds how much is *digested* (RFC-005); this layer makes *coordination* and *reward* legible, it does not manufacture contributors.

## Risks / 风险

- **Over-engineering for absent users** → mitigated by minimal/staged build and read-mostly first.
- **build_reputation leaking into trade eligibility** (the worst failure) → Invariant 1 enforced by pool separation + a `schema:verify`/grep guard that trade-eligibility queries never reference `build_reputation`.
- **Gaming the credit loop** → reuse RFC-004's once-only, acceptance-gated, Passkey-anchored crediting; AI triage (RFC-005) flags duplicate/low-value before human acceptance.
- **Coordination board becoming a stale graveyard** → claims auto-expire; `done`/`abandoned` are first-class.
- **Provenance mis-declaration** → not detected proactively (we don't police authorship); handled as precedent when surfaced, like any other dishonest disclosure.

## Open questions / 待议

- Exact `build_reputation` weighting formula (depended-upon measure) — defer to implementation, must follow framework §4.2.
- Whether review-tier threshold reuses the literal verifier params or a build-specific set — implementation detail, default to a build-specific param so trade params stay untouched.
