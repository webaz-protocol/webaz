# RFC-017: Contribution Protocol v1 — facts, identity, claim, metering, and the uncommitted-value boundary / 贡献协议 v1:事实、身份、认领、计量与未承诺价值边界

**Status**: draft
**Author**: @seasonkoh
**Created**: 2026-06-11
**Track**: meta-rule (60d) — introduces an **authoritative protocol layer** over contribution facts / identity / metering and an economic-value boundary; touches reward semantics → constitutional caution. **Does NOT define any distribution formula, scoring number, or final database schema; does NOT change merge authority.**
**Related issue**: (TBD)
**Supersedes**: (n/a — RFC-017 does not supersede; it sits **above** and **references** existing layers)
**Superseded by**: (n/a)
**Related**: [RFC-006](RFC-006-contribution-layer.md) (in-protocol contribution layer, *implemented*) · [RFC-009](RFC-009-noncode-pr-proxy.md) (non-code PR-proxy, *design-locked*) · [RFC-002](RFC-002-rewards-opt-in.md) (rewards opt-in) · [RFC-004](RFC-004-build-feedback.md) (build-feedback) · [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](../CONTRIBUTOR-REWARD-FRAMEWORK.md) (**valuation principle — single source of truth**) · CHARTER §3.2/§4/§6 · framework §0/§2/§3/§4/§6

---

## Summary / 摘要

RFC-017 defines the **Contribution Protocol** — the authoritative, upper-layer protocol that says, for WebAZ, **what counts as a contribution fact, who it belongs to, how it is claimed, how it is metered, and what it does (and does not) promise**.

It proposes **16 invariants** and a strict **three-layer separation** — *fact · valuation · redemption*. It is deliberately **principle-only**: it locks goals and boundaries, and **defers all formulas, weights, curves, scoring numbers, amounts, currency, yield, vesting, and the final database schema** to later implementation PRs and to the future DAO + professional team (framework §0/§6).

RFC-017 是**贡献协议**——权威的上层协议,定义 WebAZ 中**什么算贡献事实、归属于谁、如何认领、如何计量、承诺与不承诺什么**。它提议 **16 条不变量**与严格的**三层分离(事实 / 估值 / 兑现)**,且**只锁原则**:锁目标与边界,把一切公式 / 权重 / 曲线 / 评分数字 / 金额 / 币种 / 收益率 / 归属计划 / 最终数据库结构,**交给后续实现 PR 与未来 DAO + 专业团队**(framework §0/§6)。

> **This RFC ships nothing executable.** Pure documentation. No code, schema, API, UI, or economic logic changes. / **本 RFC 不落地任何可执行物**,纯文档,不动代码 / schema / API / UI / 经济逻辑。

> **Status & governance timing / 治理时序:** The invariants below are **draft / proposed — NOT yet in effect**. Formal protocol effect requires, **after the repository is public**, a **60-day public notice + the corresponding multi-sig approval** (CHARTER §6). Until then they are a proposal. **Private dogfood MAY proceed now as a non-production experiment** to validate the design. / 以下不变量为 **draft / proposed,尚未生效**;正式协议生效须在**仓库公开后**经 **60 天 public notice + 相应多签批准**(CHARTER §6);在此之前仅为提案。**私有 dogfood 可作为非生产实验先行**以验证设计。

---

## Motivation / 动机

The buyer→contributor funnel (RFC-004/006/009) created in-protocol coordination and the first GitHub-facing contribution paths. But three gaps block a trustworthy, low-friction, agent-era contribution system:

1. **No authoritative fact ledger.** Contribution signals live in scattered places (in-protocol `build_tasks`; GitHub PRs — whose authenticity belongs to a *future, separate GitHub credentials adapter*, **not** RFC-009; governance logs) with no single, immutable, append-only record of *"this real contribution happened, by this identity, at this time."*
2. **No identity model for the agent era.** An agent may execute the work; a real human or legal org must bear the rights and obligations; a GitHub handle, a Passkey account, and a KYC identity are *different* layers that must be related without being conflated. People must be able to **contribute first and bind identity later**.
3. **No clean value boundary.** To build metering and a contributor dashboard, we must be able to *measure and display* contribution without that act implying any payout promise. Today there is no explicit "**uncommitted value**" boundary, so any metering risks reading as a financial commitment — a legal and trust hazard pre-launch.

RFC-017 closes these by defining the fact ledger, the identity layering + post-hoc claim, and the uncommitted-value boundary — **as principle**, leaving mechanism to the future.

---

## Design / 设计

### §1 Three-layer separation (structural, locked) / 三层分离(结构性,锁定)

RFC-017 **refines** framework §3 (which separated *relationship* vs *valuation*) into **three** layers, splitting *redemption* out of *valuation*:

| Layer / 层 | What it holds / 内容 | Mutability / 可变性 | Decided by / 谁定 |
|---|---|---|---|
| **Fact / 事实层** | Contribution facts + relationship facts (binary-tree position, referral, registration time, early participation) + identity bindings | **Append-only, immutable, permanent** | Code (auto-recorded) |
| **Valuation / 估值层** | How facts → scores / weights / dimensions / decay | **Evolvable** (DAO + professional team) | future DAO (framework §6) |
| **Redemption / 兑现层** | Whether / how valuation → actual return (amount, currency, yield, vesting) | **Currently `uncommitted` in full** | future DAO + legal/regulatory |

**Why three, not two:** splitting *redemption* out lets us build the *fact* layer now and define *valuation* (metering / display) openly **without** implying any payout — because redemption is a separate, explicitly **uncommitted** layer (see §I-12). This is the structural enabler for "measure and show, promise nothing."

**为什么三层不是两层**:把"兑现"从"估值"拆出,使我们现在就能建**事实层**、未来公开定义**估值层(计量/展示)**,而**不暗示任何兑付**——因为兑现是独立且明确**未承诺**的一层(见 §I-12)。这是"可计量、可展示、不承诺"的结构性前提。

---

### §2 The proposed invariants (I-1 … I-16) / 提议的不变量

These are **proposed locked principle** — *draft, not yet in effect* (see the governance-timing note in Summary). Each notes what is **proposed-locked** vs what is **deferred to mechanism** (framework §0 discipline; meta-rule #4 forbids writing the undecided as decided).

> 这些是**提议锁定的原则**——*draft,尚未生效*(见 Summary 的治理时序 note)。每条标注**拟锁定**部分与**交机制**部分(遵 framework §0;元规则 #4 禁止把未决写成既成)。

**I-1 — Low-barrier, no-prerequisite contributorship.** Contribution entry does **not** require already being a WebAZ user. Any individual or legal organization may **contribute first** via GitHub or an Agent, and register WebAZ + bind a Passkey **later** (I-6). *Locked:* the open, no-prerequisite door. *Deferred:* tiered access thresholds for higher-risk surfaces (RFC-006: docs=open · review=gated · protocol-level=highest+guardian).
贡献入口**不要求**已是 WebAZ 用户;任何个人或合法组织可**先**通过 GitHub / Agent 贡献,**之后再**注册 WebAZ、绑定 Passkey(I-6)。

**I-2 — Fact / valuation / redemption are strictly separated** (§1). *Locked:* the separation. *Deferred:* valuation & redemption contents.
事实层、估值层、兑现层严格分离。

**I-3 — Every real contribution keeps a permanent fact record** — even a single line, even if later superseded or reverted. The fact ("this happened") is never deleted; a later `superseded`/`reverted` *status* is added alongside, not by erasure. *Locked:* permanence + append-only. *Deferred:* nothing.
每项真实贡献永久保留事实记录,即使只有一行、后被替代或回滚——事实不删除,只追加状态。

**I-4 — Permanent record ≠ permanent valuation.** A permanent fact does not imply a fixed or perpetual score. Valuation decays / re-weights over time and on supersession (framework §2.1③, §4.1). *Locked:* record≠valuation. *Deferred:* decay curves / half-lives.
永久记录 ≠ 永久固定估值;估值随时间 / 被替代而衰减。

**I-5 — Identity is layered:** GitHub identity · Agent · accountable real human / legal org · Passkey account · KYC identity (§3). *Locked:* the layering + that they must be related-not-conflated. *Deferred:* KYC provider / thresholds / process.
身份分层:GitHub 身份 / Agent / 责任真人或合法组织 / Passkey 账户 / KYC 身份。

**I-6 — Contribute first, bind (Passkey) later.** A contribution may be recorded against a GitHub handle or agent before any Passkey account exists; the real party may **claim** it later by binding a Passkey (§3, §6). *Locked:* claimability. *Deferred:* claim-proof mechanics.
允许先贡献、后绑定 Passkey 认领。

**I-7 — Agents execute; humans/orgs are accountable.** An agent may perform the work, but rights and obligations attach to an accountable real human or legal organization (the guardian model; execution division detailed in **I-16**). *Locked:* executor≠accountable-party. *Deferred:* guardianship binding details.
Agent 可执行,权利义务由真人或合法组织承担(执行分工见 **I-16**)。

**I-8 — Contribution types span:** code · tests · audit · maintenance · governance · real usage · transactions · valid referrals (§5). *Locked:* the taxonomy is broad (not code-only). *Deferred:* per-type metering dimensions.
贡献类型覆盖:代码 / 测试 / 审计 / 维护 / 治理 / 真实使用 / 交易 / 有效推荐。

**I-9 — Early participation, registration time, referral relationships, and binary-tree position are permanently recorded** and **MAY** be future valuation parameters (framework §3.2 modifier). *Locked:* recorded + may-be-modifier. *Deferred:* whether/how much weight (DAO; phase-A default = 1, i.e. unused).
早期参与 / 注册时间 / 邀请关系 / 二叉树位置永久记录,并可作未来估值参数。

**I-10 — Position and headcount alone guarantee nothing.** The reward base **must** include real contribution; `reward = f(contribution>0) × g(position) × h(decay)`; zero contribution × any position = zero (framework §3.1/§3.2). *Locked:* base>0, multiplicative-not-additive, non-inheritable. *Deferred:* g/h ranges.
位置和人头本身不保证收益;奖励基础必须包含真实贡献。

**I-11 — One public, consistent metering rule for everyone**, with rights to **query, claim, and appeal** (framework meta-rules #1/#9; RFC-006 dashboard + appeal). *Locked:* uniform + queryable + claimable + appealable. *Deferred:* the rule's contents.
所有人适用公开一致的计量规则,并享查询 / 认领 / 申诉权。

**I-12 — Current economic value is uniformly `uncommitted`.** No promise of amount, currency, yield, or that redemption will ever occur. Metering/display is informational, not a financial instrument or entitlement (framework §0/§5). *Locked:* uncommitted boundary. *Deferred:* if/when/how redemption is ever defined (future DAO + legal/regulatory).
当前经济价值统一为 uncommitted —— 不承诺金额 / 币种 / 收益率 / 必然兑付。

**I-13 — Explicit anti-abuse + IP obligations:** anti-impersonation, anti-farming / wash activity, fake transactions, fake referrals, PR-splitting (gaming count/size), and intellectual-property obligations (DCO / right-to-submit). *Locked:* these are violations with consequences (quality veto → fact may be marked `void`/`forfeited`). *Deferred:* detection thresholds.
明确反冒领 / 刷量 / 虚假交易 / 虚假推荐 / 拆 PR,及知识产权义务。

**I-14 — RFC-006 / RFC-009 / RFC-017 dependency + single source of truth** (§9). *Locked:* RFC-017 is the single authority for contribution **facts, attribution, and value boundary**; RFC-006 is in-protocol **infrastructure**; **RFC-009 is an *optional* inbox/new-content PR-proxy feeder for participants without GitHub technical ability — NOT a general GitHub event-ingestion or authenticity layer**; GitHub contribution credentials (ingestion + authenticity) require a **separate adapter/module** (impl. tracking ③). *Deferred:* nothing.
明确 RFC-006 / RFC-009 / RFC-017 的依赖与单源真理关系:RFC-009 仅为**可选**的 inbox feeder,非通用 GitHub 接入/真实性层;GitHub 凭证需独立 adapter。

**I-15 — A minimal field contract is listed for implementers** (§10), but the **final database schema and scoring numbers are NOT locked here** (framework §0). *Locked:* the minimal conceptual fields. *Deferred:* final schema + numbers.
列出后续实现的最小字段契约,但不锁定最终数据库结构与评分数字。

**I-16 — Agent-first, human-light execution.** *Locked principle:* (a) an Agent may **discover, claim, implement, test, submit, and revise** low-risk tasks; (b) a real human bears **legal authorization, accountability, and key confirmations** (consistent with I-7); (c) ordinary contributions should **minimize human operations and round-trips**; (d) only Agent / subscription capabilities that are **legally owned and permitted by their Terms of Service** may be used. *Deferred:* per-task risk-classification thresholds.
Agent 优先、真人轻量:Agent 可发现 / 认领 / 实现 / 测试 / 提交 / 修正低风险任务;真人负责合法授权、责任承担与关键确认;普通贡献尽量减少真人操作与往返沟通;仅可使用**合法拥有且服务条款(ToS)允许**的 Agent / 订阅能力。

---

### §3 Identity layering + post-hoc claim / 身份分层 + 事后认领

Five layers, related but never conflated (I-5, I-7):

| Layer / 层 | Role / 角色 | Bears rights/obligations? |
|---|---|---|
| **GitHub identity** | external pseudonymous handle that produced a PR/commit (authenticity via the **future, separate GitHub credentials adapter** — **not** RFC-009) | retains fact attribution + query + future-claim eligibility; **no** in-protocol permission / redemption until claimed |
| **Agent** | executor that performed the work; carries an agent passport | no — executor only |
| **Accountable real human / legal org** | the **guardian** who answers for the agent's work | **yes** |
| **Passkey account** | the on-protocol WebAZ account (WebAuthn) that **claims** facts | yes (on-protocol) |
| **KYC identity** | highest tier, gated for legal / large-redemption contexts (future) | yes (legal) |

**Post-hoc claim (I-6):** a contribution fact may be recorded against a GitHub handle or an agent **before** any Passkey exists. The real party later **claims** the fact by binding a Passkey account (and, where required, ascending to KYC). Claim **binds attribution and accountability**; it does **not** by itself create any redemption right (I-12).

**事后认领**:事实可先挂在 GitHub handle / agent 上;真实方之后绑定 Passkey(必要时升 KYC)来认领。认领绑定**归属与问责**,本身**不**产生任何兑现权(I-12)。

> **Unclaimed GitHub identity (I-6):** even before any Passkey binding, a GitHub identity **retains fact attribution, query access, and future-claim eligibility** — its place in the fact record is preserved. What it lacks until claimed is **in-protocol permissions and any redemption right**, not its attribution. / **未绑定 Passkey 的 GitHub 身份**:即便尚未绑定,仍**保有事实署名、查询及未来认领资格**——事实记录中的位置被保留;未认领前缺少的是**协议内权限与兑现权**,而非署名本身。

> Provenance (human / AI-assisted / AI-authored) is carried as a fact field alongside the accountable identity (consistent with RFC-006 self-declared provenance). / 出处(人工 / AI 辅助 / AI 生成)作为事实字段与责任身份并列记录。

---

### §4 Contribution fact model (immutable) / 贡献事实模型(不可变)

A **contribution fact** is an append-only record asserting *a real contribution occurred*. Facts are never edited or deleted (I-3); corrections are **new facts** or **status additions** (`superseded` / `reverted` / `void` / `forfeited`), preserving the audit trail.

- A fact references the **artifact** (PR/commit SHA, in-protocol task id, order id, governance action id…), the **executor identity**, the **accountable identity** (nullable until claimed), **provenance**, **occurred_at**, and **status**.
- A fact's *valuation* is **not** stored in the fact layer — valuation is derived in the valuation layer (I-2/I-4) and may change without ever mutating the fact.

---

### §5 Contribution taxonomy (8 types) / 贡献类型(8 类)

I-8's 8 types, reconciled with framework §4's 6 (no contradiction — this is a finer split):

| RFC-017 type | framework §4 mapping | notes |
|---|---|---|
| 1. Code / 代码 | §4 type 2 (code) | lifecycle-asset metering, framework §4.1 |
| 2. Tests / 测试 | refines type 2 | tests as first-class, not "lines" |
| 3. Audit / 审计 | type 3 (履职) + type 6 (maintenance) | security/protocol audits |
| 4. Maintenance / 维护 | type 6 | review-merge, ops, direction, triage — framework §4.2 |
| 5. Governance / 治理 | type 3 (履职) | arbitration / verification / governance participation |
| 6. Real usage / 真实使用 | (new split from type 1) | genuine use of the protocol |
| 7. Transactions / 交易 | type 1 (交易) | real GMV / completed orders |
| 8. Valid referrals / 有效推荐 | type 4 (传播) | broadened — see definition below; headcount alone = zero (I-10) |

**Valid referral (type 8) — broadened scope (Codex P1-2):** **not** limited to per-order sales. It covers referring **developers, sellers, buyers, reviewers, maintainers, and other participants**. The metering basis is the **verifiable real value produced by the referred party** — real usage, transactions, supply, code, audit, governance, or maintenance — **attributed** to the referrer. **Registration count / headcount alone remains zero value** (I-10).

**有效推荐(类型 8)——扩大范围**:**不限于** per-order 成交,覆盖推荐**开发者 / 卖家 / 买家 / 审核者 / 维护者及其他参与者**。计量基础是**被推荐者产生的可验证真实价值**(真实使用 / 交易 / 供给 / 代码 / 审计 / 治理 / 维护),归因给推荐者。**注册人数 / 人头本身仍为零价值**(I-10)。

> Founding (framework type 5 立项) and ongoing maintenance (type 6) remain **contribution types, not identity privilege** (framework §2.1④/§4.2): metered by *what was done × how depended-upon*, never by *who*.

---

### §6 Metering, query, claim, appeal / 计量、查询、认领、申诉

- **Metering rule is public and uniform** (I-11): the same ruler for everyone; a later strong contributor can, by real contribution, match or surpass an early participant (framework §2.3 "healthy meritocracy, not toxic hereditary").
- **Query:** each party can see *their own* facts, derived valuation (when defined), tier, restrictions, penalties — extends RFC-006's contributor dashboard.
- **Claim:** §3 post-hoc claim.
- **Appeal:** an appeal entry exists for disputed facts/penalties — reuses RFC-006 + existing arbitration machinery.

---

### §7 The uncommitted-value boundary / 未承诺价值边界

**I-12 is the legal/trust firewall.** Until the future DAO + professional team (and, where applicable, legal/regulatory guidance) defines redemption:

- All metering output carries an explicit **`value_state: uncommitted`** semantics.
- No surface (UI, MCP, docs, manifest) may state or imply a guaranteed amount, currency, yield, payout date, or that redemption will occur.
- **This protocol itself grants no security, equity, debt, or redemption right.** Any future redemption mechanism — and its regulatory classification — must be **separately assessed under applicable law**. Metering output is an informational record of contribution facts and (later) their open valuation. / **本协议本身不授予证券、股权、债权或兑付权;任何未来兑现机制及其监管分类,须另行依法评估。**

> This boundary is what lets later PRs build metering & display safely: *show the facts and (eventually) the score; promise nothing.* / 这条边界让后续 PR 能安全地建计量与展示:**展示事实与(最终)分数,不承诺任何兑付**。

---

### §8 Anti-abuse & IP obligations / 反滥用与知识产权义务

Per I-13, with framework §4.1 Goodhart defenses (difficult-to-forge value signals + quality one-veto + mechanism deferred to DAO):

- **Anti-impersonation:** claiming requires identity binding (§3); a fact cannot be claimed by a party that cannot prove the executor/GitHub/Passkey linkage.
- **Anti-farming / wash:** fake transactions, self-dealing, and fake referrals are violations; metering uses hard-to-forge signals (per-order attribution, real production usage), never raw counts/lines.
- **Anti-PR-splitting:** splitting work to inflate count/size is a violation; metering values *depended-upon survival*, not volume.
- **IP / right-to-submit:** contributions carry DCO obligations (the contributor certifies the right to submit under the project license); IP violations void the fact.
- Consequence: violating facts may be marked `void` / `forfeited` and feed existing strike / blocklist / outlier machinery (reuse, not new authority).

---

### §9 RFC-006 / RFC-009 / RFC-017 boundary (single source of truth) / 边界与单源真理

| RFC | Role | Owns | Does NOT own |
|---|---|---|---|
| **RFC-006** (implemented) | In-protocol contribution **infrastructure** | `build_tasks`, `webaz_contribute`, `build_reputation`, contributor dashboard | the authoritative fact ledger / attribution authority / value boundary |
| **RFC-009** (design-locked) | **optional** inbox/new-content **PR-proxy** for participants **without GitHub technical ability** | opening a PR on behalf of a non-GitHub-capable contributor (new-content inbox scope) | general GitHub **event ingestion / authenticity verification**, attribution authority, scoring, or reward |
| *(future)* **GitHub credentials adapter** | separate module: ingest + **verify authenticity** of GitHub events | turning verified GitHub events into facts for RFC-017's ledger | attribution authority, scoring, or reward (RFC-017 decides) |
| **RFC-017** (this) | **Authoritative upper protocol** | contribution **facts, identity, claim, metering rules, rights/obligations, value boundary** | the plumbing of 006/009; any distribution formula |

**Single source of truth:** RFC-017 is authoritative for *what is a contribution fact, whom it belongs to, and what it promises*. RFC-006 (in-protocol infra), RFC-009 (an **optional** inbox PR-proxy for non-GitHub-capable contributors), and the future GitHub credentials adapter are all **feeders** — they produce signals/events that flow **up** into RFC-017's fact layer. None independently decides attribution or value. In particular, **RFC-009 is not the GitHub authenticity/ingestion layer**; that is the separate adapter (impl. ③). Valuation **principle** remains delegated to `CONTRIBUTOR-REWARD-FRAMEWORK.md` (RFC-017 references, does not restate).

**单源真理**:RFC-017 对"什么是贡献事实、归属于谁、承诺什么"是权威;RFC-006(站内基础设施)、RFC-009(**可选**的非 GitHub 能力者 inbox PR-proxy)、未来的 GitHub 凭证 adapter 都是**上报源**,把信号/事件**向上**汇入 RFC-017 事实层,均不独立决定归属或价值。尤其 **RFC-009 不是 GitHub 真实性/接入层**——那由独立 adapter 负责(实现 ③)。估值**原则**仍委托给 framework(引用,不复述)。

---

### §10 Minimal field contract (conceptual — NOT final schema) / 最小字段契约(概念,非最终结构)

Per I-15. **Conceptual minimum** for implementers; field names, types, table layout, indexes, and all scoring numbers are **decided in later implementation PRs**, not here.

```
ContributionFact (append-only):
  fact_id            stable unique id
  type               one of §5's 8 types
  source             in-protocol | github | governance | transaction
  artifact_ref       PR/commit SHA | task id | order id | gov-action id
  occurred_at        timestamp
  executor_ref       agent/github/passkey identity that performed it
  accountable_ref    accountable human/org identity   (nullable until claimed)
  provenance         human | ai-assisted | ai-authored
  status             active | superseded | reverted | void | forfeited   (append-only transitions)
  immutable          true   (corrections = new facts / status additions)

IdentityBinding (append-only):
  github_handle ↔ agent ↔ accountable_party ↔ passkey_account ↔ kyc_ref (tiered, nullable upward)
  claimed_at, claim_proof_ref

RelationshipFact (append-only, framework §3 relationship layer):
  webazer_ref, binary_tree_position, referral_edge, registration_time, early_participation_marker
```

> Valuation and redemption tables are **intentionally absent** — they belong to future, separately-governed PRs (I-2/I-4/I-12).

---

## Meta-rule impact / 元规则影响

| Meta-rule | Impact |
|---|---|
| **#1 当一切可见** | ✅ fact layer + metering rules public (I-11) |
| **#4 不撒谎** | ✅ I-12 uncommitted boundary; principle vs mechanism cleanly separated; no undecided-as-decided |
| **#5 不偏袒** | ✅ I-10 position/headcount guarantee nothing; one ruler for all (I-11); founding = contribution type not privilege |
| **#6 不滥用** | ✅ valuation/redemption delegated to future DAO + professional team, not founder-unilateral |
| **#9 算法即协议** | ✅ metering rule public & verifiable once defined |
| **#10 参与者即 webazer** | ✅ low-barrier contributorship (I-1); future contributors co-decide mechanism |

This RFC introduces an **authoritative protocol layer touching reward semantics** → **meta-rule track**. Its invariants take formal effect only **after the repository is public**, via a **60-day public notice + multi-sig approval (CHARTER §6)** — until then they are draft/proposed (see Summary governance-timing note); **private dogfood may run beforehand as a non-production experiment**. It defines **no** distribution mechanism, so it does **not** itself trigger the economic-parameter governance gates (those fire when valuation/redemption is later defined).

---

## Alternatives / 替代方案

- **Alt 1 — Extend RFC-006 instead of a new RFC.** Rejected (per decision): RFC-006 is implemented infrastructure; conflating the authoritative fact/value protocol into it would blur the single-source-of-truth boundary (I-14) and entangle a constitutional-track concern with a live module.
- **Alt 2 — Define valuation now.** Rejected: violates framework §0 and meta-rule #4 (locking the future with today's limited knowledge). RFC-017 deliberately stops at principle + boundary.
- **Alt 3 — Two layers (fact/valuation), redemption folded in.** Rejected: without a separate uncommitted *redemption* layer, building metering/display risks implying payout (legal/trust hazard). The three-layer split is the enabler for "measure, promise nothing."

---

## Migration & compatibility / 迁移与兼容

Pure documentation; no migration. RFC-006 stays `implemented` and unchanged; RFC-009 stays `design-locked`. Future implementation PRs (Agent-ready task spec → GitHub immutable credentials → identity+claim → metering/display → private dogfood) build *under* RFC-017's invariants and feed its fact layer.

---

## Risks / 风险

- **R1 — Reading metering as a financial promise.** Mitigated by I-12 + §7 (explicit `uncommitted`, no surface may imply payout).
- **R2 — Goodhart gaming of metrics.** Mitigated by I-13 + framework §4.1 (hard-to-forge signals, quality veto, mechanism deferred).
- **R3 — Identity conflation / false claims.** Mitigated by §3 layering + claim-proof + DCO/IP obligations.
- **R4 — Scope creep into mechanism.** Mitigated by §0 discipline: this RFC is principle-only; any number/formula/schema is out of scope by construction.
- **R5 — "Defer to DAO" becoming "founder forever decides."** Acknowledged: the phase A→D transition trigger is owed by a later governance RFC (framework §6); RFC-017 leaves the hook, does not close it.

---

## Test plan / 测试计划

Documentation-only RFC → no code tests. Verification = **consistency review**:
- No contradiction with `CONTRIBUTOR-REWARD-FRAMEWORK.md` (§0/§2/§3/§4/§6), CHARTER, ECONOMIC-MODEL, RFC-002/006/009.
- All invariants (I-1…I-16) traceable and each marked locked-vs-deferred.
- No undecided item stated as decided (meta-rule #4).
- Handed to **Codex read-only audit** after the standalone PR.

---

## Pre-flight checklist / 提交前自查

- [x] Principle vs mechanism cleanly separated (framework §0)
- [x] No formula / weight / curve / number / final schema locked (I-15)
- [x] EN-first / bilingual
- [x] Single-source-of-truth boundary with RFC-006/009 explicit (I-14)
- [x] References framework for valuation principle (no restatement / no drift)
- [x] Pure doc — no code/schema/API/UI/economic change
- [ ] 60d meta-rule notice + multi-sig (on acceptance, per CHARTER §6)

---

## Implementation tracking / 实现追踪

RFC-017 is itself doc-only. Subsequent **separate** implementation PRs (each its own topic, dependency-ordered):

1. **RFC-017** (this doc) ← then **stop for Codex read-only audit**
2. Agent-ready task specification
3. GitHub immutable contribution credentials — a **separate adapter/module** that ingests + **verifies authenticity** of GitHub events and feeds facts upward; **RFC-009 is only an optional feeder**, not this layer
4. GitHub identity ↔ Passkey post-hoc claim
5. Metering & display
6. Private dogfood (multi-round private PRs, all-green) → regenerate Public Genesis from a fresh all-green `main`

**Status history / 状态变更**:
- 2026-06-11 — draft created (this PR).
