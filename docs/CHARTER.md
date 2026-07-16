# WebAZ 开发协作宪章 / Development Collaboration Charter

> **版本 / Version**: v1.0 (draft, W3 末 lock / lock at end of W3)
> **生效 / Effective**: 公示 30 天后(W3-W7)/ After 30-day public notice (W3-W7)
> **修改流程 / Modification process**: 见 §6 / See §6
> **父级 / Parent**: 10 元规则 `docs/META-RULES.md` + `docs/META-RULES-FULL.md`
> **子文档 / Child docs**: GOVERNANCE / CONTRIBUTING / CODE_OF_CONDUCT 等都引用本宪章 / all reference this charter
> **机读依赖图 / Machine-readable dependency graph**: `docs/charter-deps.yaml`

---

## §1 使命与定位 / Mission & Positioning

### 1.1 我们是什么 / What we are

**WebAZ 是一个 agent-native 的去中心化商业协议** — 让 AI Agent 成为去中心化商业的原生参与者。

**WebAZ is an agent-native decentralized commerce protocol** — making AI agents first-class participants in decentralized commerce.

- 协议层(L0-L4):状态机 / 经济引擎 / 仲裁 / 声誉 / 技能市场,**协议级 trust** / Protocol layer: state machine / economic engine / arbitration / reputation / skill market, **protocol-level trust**
- agent 接口层:MCP / AP2 / W3C VC,**让 agent 平等参与** / Agent interface layer: MCP / AP2 / W3C VC, **equal participation for agents**
- 应用层:卖家 / 买家 / 物流 / 仲裁员 / 创作者等多角色,**所有人都是 webazer** / Application layer: seller / buyer / logistics / arbitrator / creator, **all are webazers**

### 1.2 我们不是什么 / What we are not

- **不是电商平台**(虽然有商品交易):平台 = 中心化裁判,WebAZ = 协议 + 自治 / **Not an e-commerce platform**: platform = central arbiter, WebAZ = protocol + self-governance
- **真实成交计酬**:WebAZ **无加入费**;commission **按真实商品成交**计算(**非按发展人头**);**无静态 / 被动收益**。多级 commission / PV 结构**按辖区合规收放**(详 `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`),**确保计酬只与真实价值创造挂钩,并按辖区设置上限与披露;此为设计意图,非正式法律认证** / **Earnings from real sales only**: no joining fee; commissions computed on **real product sales** (**not headcount**); no static / passive income. The multi-level commission / PV structure **adjusts per-jurisdiction compliance** (see `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`); **ensures compensation tracks only real value creation, with jurisdiction-specific caps and disclosures; this is design intent, not a formal legal certification**
- **不是 web2 商业**(虽然商业):/ **Not web2 commerce** (though commercial):
  - **无 ads**(不投放第三方广告 / 不卖排序位 — 元规则 #5 #9)/ **No ads** (no third-party advertising / no paid ranking — Rule #5 #9)
  - **无数据贩卖**(用户数据不外卖 — 元规则 #3)/ **No data selling** (user data not sold externally — Rule #3)
  - **无 dark pattern**(不操纵用户选择 — 元规则 #7)/ **No dark patterns** (no user manipulation — Rule #7)
  - 注:广告与数据政策由协议层硬约束保证,详 `docs/ECONOMIC-MODEL.md`(排序不能花钱买)+ `docs/META-RULES-FULL.md#3` 的代码 enforce 路径 / Note: Ad and data policies are hard-enforced at protocol layer, see `docs/ECONOMIC-MODEL.md` (rankings can't be bought) and `docs/META-RULES-FULL.md#3` enforcement
- **不是单一公司项目**(虽然 phase A user 主导):路径上是 community-owned 协议(phase D 目标)/ **Not a single-company project**: trajectory is community-owned protocol (phase D goal)
- **不是技术 toy**:真协议 / 真交易 / 真治理责任 / 真伦理底线 / **Not a tech toy**: real protocol / transactions / governance responsibility / ethics floor

### 1.3 双重承诺 / Dual Commitments

- **协议级 trust**(对所有 webazer):规则透明 / 算法可审 / 不偏袒 / 故障可追责 / **Protocol-level trust** (to all webazers): transparent rules / auditable algorithms / no favoritism / fault traceability
- **agent-native**(对 AI agent + 其监护人):agent 是 first-class 参与者,有身份 / 责任 / 申诉权 / **Agent-native** (to AI agents and custodians): agents are first-class with identity / accountability / appeal rights

### 1.4 协议层 vs 应用层 / Protocol Layer vs Application Layer

```
[协议层 / Protocol]: 本仓库代码 + 元规则 + 状态机 + 经济引擎
                      (由 webazer 共建,宪法级条款由高门槛多签保护,user 作为多签一票,详 §4 I-4)
                      Repo code + meta-rules + state machine + economic engine
                      (built by webazers, constitutional clauses protected by
                       high-threshold multisig with user as one signer, see §4 I-4)
   ↑
   ┊  (通过 MCP / PWA / 第三方 SDK 接入 / via MCP / PWA / 3rd-party SDK)
   ↓
[应用层 / Application]: 卖家店铺 / agent 自动化 / 测评内容 / 慈善许愿(自发繁荣,WebAZ 不偏袒)
                        Seller shops / agent automation / review content / charity wishes
                        (organic flourishing, WebAZ stays neutral)
```

**WebAZ 治理范围 = 协议层**。应用层活动 WebAZ 不审批 / 不挑选 / 不偏袒(参元规则 #5)/ **WebAZ governance scope = Protocol layer**. WebAZ does NOT approve / curate / favor application-layer activities (Rule #5)

---

## §2 价值观:10 元规则 / Values: 10 Meta-Rules

> 本节是 charter 的灵魂,也是宪法。所有开发协作动作必须先对照本节。
> 修改本节需 ≥ 2/3 maintainer 多签(`constitutional_supermajority_ratio`,**user 作为多签一票,非个人否决**)+ 60 天公示。详 §4 I-4 宪法级修改保护。
> 完整阐释见 `docs/META-RULES-FULL.md`,每条 5 字段展开(核心 / 反例 / 适用 / AI hint / 开发协作场景)。
>
> This section is the soul of the charter and a constitutional core. All dev-collab actions must check against this section first.
> Modification requires: ≥ 2/3 maintainer multisig (`constitutional_supermajority_ratio`, **user as one signer, no personal veto**) + 60-day public notice. See §4 I-4 Constitutional Amendment Protection.
> Full expansion at `docs/META-RULES-FULL.md` (5 fields per rule).

### 信仰层 / Faith Layer
1. **当一切可见,公平就是可能的。** _When all is visible, fairness becomes possible._ → [META-RULES-FULL.md #1](META-RULES-FULL.md#1-当一切可见公平就是可能的--when-all-is-visible-fairness-becomes-possible)
2. **代码即规则,协议即信任。** _Code is Rule, Protocol is Trust._ → [META-RULES-FULL.md #2](META-RULES-FULL.md#2-代码即规则协议即信任--code-is-rule-protocol-is-trust)

### 红线层 / Red Lines
3. **不偷数据。** _No data theft._ → [META-RULES-FULL.md #3](META-RULES-FULL.md#3-不偷数据--no-data-theft)
4. **不撒谎。** _No lies._ → [META-RULES-FULL.md #4](META-RULES-FULL.md#4-不撒谎--no-lies)
5. **不偏袒。** _No favoritism._ → [META-RULES-FULL.md #5](META-RULES-FULL.md#5-不偏袒--no-favoritism)
6. **不滥用。** _No abuse._ → [META-RULES-FULL.md #6](META-RULES-FULL.md#6-不滥用--no-abuse)
7. **不操纵。** _No manipulation._ → [META-RULES-FULL.md #7](META-RULES-FULL.md#7-不操纵--no-manipulation)

### 操作层 / Operations
8. **最小介入。** _Minimal intervention._ → [META-RULES-FULL.md #8](META-RULES-FULL.md#8-最小介入--minimal-intervention)
9. **算法即协议。** _Algorithm is Protocol._ → [META-RULES-FULL.md #9](META-RULES-FULL.md#9-算法即协议--algorithm-is-protocol)

### 身份层 / Identity
10. **参与者即 webazer。** _Participants are webazers._ → [META-RULES-FULL.md #10](META-RULES-FULL.md#10-参与者即-webazer--participants-are-webazers)

> _不可推翻,可演化。_ **Inviolable. Evolvable.**

**开发协作场景对照(简版)**:任何 PR 必须填"元规则对照表"(模板见 PR 模板);AI review 第一道关检查元规则冲突;冲突解决决策树见 [META-RULES-FULL.md 跨规则关系](META-RULES-FULL.md#-跨规则关系--cross-rule-relations)。

**Dev-collab application (brief)**: Every PR must fill a "Meta-Rules Checklist" (in PR template); AI review's first gate checks meta-rule conflicts; conflict resolution decision tree in META-RULES-FULL.md.

---

## §3 治理结构 / Governance Structure

### 3.1 5 级 contributor 阶梯 / 5-Tier Contributor Ladder

**自动晋升,无需人工 review** / **Auto-promote, no manual review needed**:

| 等级 / Tier | 进入门槛 / Entry threshold | 能做 / Capabilities |
|---|---|---|
| **Reader** | 任何人 / Anyone | 看代码 / 文档 / 公开数据 / 在 Discussions 评论 / Read code, docs, public data; comment in Discussions |
| **Member** | 注册 webaz 账号 + 同意 CoC / Register webaz account + agree to CoC | 提 issue / RFC / 想法 / Submit issues, RFCs, ideas |
| **Contributor** | 绑 Passkey(真人门)+ 第 1 个 merge PR / Passkey bound (real-human gate) + 1st merged PR | 提 PR / 评他人 issue / Submit PRs, comment on issues |
| **Reviewer** | 累计 5 merge + 评过 10 PR / Cumulative 5 merges + reviewed 10 PRs | 评他人 PR(非阻断) / Review others' PRs (non-blocking) |
| **Approver** | 累计 20 merge + 持续维护 1 个目录 ≥ 3 月 / Cumulative 20 merges + maintain 1 directory ≥ 3 months | 批准合并(目录范围内) / Approve merges (within directory) |
| **Maintainer** | user 提名 + 14 天公示 + 1 approver 推荐 / Nominated by user + 14-day public notice + 1 approver endorsement | 跨模块,phase B+ 解锁 / Cross-module, unlocked in phase B+ |

**技术实现 / Technical Implementation**:
- 阶梯计数实时进入 `reputation_scores.dev_contribution` 子字段(自动) / Tier counts flow into `reputation_scores.dev_contribution` sub-fields in real-time (auto)
- 满足条件后**自动**升级 + 通知 + audit log / **Auto** promote upon meeting criteria + notify + audit log
- 任何 contributor 可查任何 contributor 的当前阶梯进度(公开 API) / Any contributor can query any contributor's tier progress (public API)
- 满足条件**不晋升 = bug**(违反元规则 #1 透明),走 issue 报告 / Failing to promote = bug (violates Rule #1), report via issue

**字段映射(初步,W4 实现) / Field mapping (initial, W4 implementation)**:
- merge 计数 → `reputation_scores.dev_contribution.merges`
- review 计数 → `reputation_scores.dev_contribution.reviews`
- approver 目录 → `ownership/<dir>.maintainer_log`
- 任何字段 query API 公开 / All fields query API public

身份系统复用 webaz 既有 `reputation_scores` + `agent_passport`(参 `docs/AGENT-GOVERNANCE.md`)/ Identity system reuses existing `reputation_scores` + `agent_passport`.

### 3.2 决策权与多签矩阵 / Decision Authority & Multisig Matrix

| 改动类型 / Change type | 必要审批 / Required approval | 超时机制 / Timeout |
|---|---|---|
| docs / 文案 / i18n | AI review + 任 1 maintainer / AI review + any 1 maintainer | 14 天无响应 → AI review 自动推进 / 14d no response → AI auto-advance |
| 普通 code(无协议/资金/Iron-Rule)/ Normal code | AI review + 1 maintainer | 14 天无响应 → AI review 自动推进 / 14d no response → AI auto-advance |
| 协议状态机 / **fault 处置规则**(非个案判决)/ 资金路径 / Protocol state-machine / **fault-handling rule** (NOT individual case verdict) / fund-path | AI review + 2-of-2 多签(任 1 maintainer + user 作为多签一票)/ AI review + 2-of-2 multisig (any 1 maintainer + user as one signer) | 30 天无多签完成 → 自动归档,maintainer 决定重启 / 30d no multisig completion → auto-archive, maintainer decides restart |
| 元规则 / 宪法参数 / Iron-Rule 默认 / Meta-rules / constitutional params / Iron-Rule defaults | AI review + **超级多数多签**(phase A: user 1-of-1 单签;phase B+: ≥ 2/3 maintainer 多签,user 作为一票)+ 14 天公示(**宪法级 60 天**,详 §4 I-4)/ AI review + **supermajority multisig** (phase A: user 1-of-1; phase B+: ≥ 2/3 maintainer multisig with user as one signer) + 14d (**60d for constitutional**, see §4 I-4) | 60 天公示期内未达多签 → 自动作废 / 60d without multisig → auto-void |
| 安全 / Passkey / api_key 流转 / Security / Passkey / api_key flow | AI review + 2-of-2 多签(任 1 maintainer + user 作为多签一票)+ security 专审 / AI review + 2-of-2 multisig (any 1 maintainer + user as one signer) + security audit | **24h 无响应 → 紧急多签**(任 2 maintainer + user 14d 追认) / **24h no response → emergency multisig** (any 2 maintainers + user retro-confirm within 14d) |
| 本宪章修改 / Charter changes | 见 §6 / See §6 | 见 §6 / See §6 |

### 3.3 治理升级路径(phase A → D)/ Governance Path

| Phase | 决策结构 / Decision structure | 触发条件(全满足)/ Trigger (all required) |
|---|---|---|
| **A(当前 / Current)** | user 单签(作为唯一 maintainer,**因 solo 非个人特权**)/ user single-sign (as sole maintainer, **because solo, not personal privilege**) | now |
| **B** | maintainer 2-3 人;**宪法级修改 = 2/3 多签**(user 作为多签一票,无个人否决)/ 2-3 maintainers; constitutional amendments = 2/3 multisig (user as one signer, **no personal veto**) | 5 名 active code contributor / 3 月稳定 / user 信任 ≥ 2 人 / 治理章程 v1 通过 / 5 active contributors / 3 months stable / user trusts ≥ 2 / governance charter v1 passed |
| **C** | DAO 多签(maintainer + 高分 contributor);**宪法级修改 = 超级多数 + 60 天公示**(user 作为多签一票,无个人否决)/ DAO multisig; constitutional amendments = supermajority + 60d (user as one signer, no personal veto) | 50 名 active contributor / 12 月稳定 / DAO 章程公示 90 天通过 / 多签 wallet ready / 50 active / 12 months stable / DAO charter 90-day public passed / multisig wallet ready |
| **D** | 完全去中心化,**user 退到普通 DAO 成员**(日常宪法守护由 DAO 超级多数履行);**创始人守护权收缩为仅"挡破坏"**(防御性否决,详 §4 I-4a)/ Fully decentralized, **user retires to regular DAO member** (routine constitutional guardianship by DAO supermajority); **founder guardianship contracts to defensive-only** (see §4 I-4a) | DAO 自治 1 年无重大事故 / 协议参数稳定 / user 主动让权 / DAO self-governed 1 year incident-free / protocol params stable / user voluntarily steps down |

**创始人守护权状态(Linux/Rails BDFL,详 §4 I-4a)/ Founder guardianship status (BDFL, see §4 I-4a)**:
- **phase A / B / C**:创始人对"关键决策"(§3.2 高敏感类别)有**最终决定权** —— 在 §3.2 多签结论【之上】 / founder holds **final decision authority** over "key decisions" (§3.2 high-sensitivity categories) — **above** the §3.2 multisig conclusion
- **phase D**:**收缩为仅"挡破坏"**(只否决违反元规则 / 破坏 Iron-Rule / 改坏资金路径 / 危及存续的提案,不再主动推动)/ **contracts to defensive-only** (veto only proposals that violate meta-rules / break Iron-Rule / corrupt fund-path / threaten survival; no longer proactively drives)

**宪法级条款的守护对象(phase A 起即守护,详 §4 I-4)/ Constitutional clause guardianship (active from phase A, see §4 I-4)**:
- 元规则 #1-#10 修改 / Meta-rules #1-#10 amendments
- Iron-Rule 7 paths 默认修改 / Iron-Rule 7 default modifications
- 资金路径修改 / Fund-path modifications
- **fault 处置【规则】修改**(不是个案判决的 veto;个案归仲裁机制)/ **Fault-handling【rule】modifications** (NOT individual case verdict veto; per-case verdict belongs to arbitration)
- 三承重墙 / 反 EEE 底线 / license / Three load-bearing walls / Anti-EEE floor / license
- **I-4 宪法级修改保护本身** / **I-4 itself** (anti-circumvention)

> ⚠️ **这些是"协议宪法级修改流程(I-4)"的去人格化对象**。phase A user 单签 = 因 solo;phase B+ 高门槛多签(user 作为一票,详 §4 I-4)。**注:创始人对关键决策的守护权是【独立机制】,见 §4 I-4a(BDFL)—— 与本处"修改流程去人格化"分属两层。**
> ⚠️ **These are depersonalized targets of the "constitutional amendment process (I-4)"**. phase A user single-sign = because solo; phase B+ high-threshold multisig (user as one signer, see §4 I-4). **Note: the founder's guardianship over key decisions is a *separate mechanism*, see §4 I-4a (BDFL) — a different layer from this "amendment-process depersonalization".**

### 3.4 反向调整(降级/撤销)路径 / Reverse Adjustment (Downgrade/Recall) Paths

**升级 ≠ 单向不可逆**;治理弹性是元规则"可演化"的核心。/ **Upgrade ≠ one-way irreversible**; governance elasticity is core to "evolvable" in meta-rules.

**触发降级的场景 / Downgrade triggers**:
- active contributor 持续 < 当前 phase 门槛 × 50% 超过 3 个月 / Active contributors persist below current phase × 50% for 3+ months
- 治理失败事件(重大决策无法达成 / 元规则被试图破坏 / 多签持续无法签字)/ Governance failure events
- 安全事件后**临时**降级(user + 全 maintainer 多签,期限 ≤ 90 天)/ Post-security-incident **temporary** downgrade (user + all maintainers multisig, ≤ 90 days)

**降级流程 / Downgrade process**:
- 任何 maintainer 可发起 RFC-downgrade / Any maintainer can initiate RFC-downgrade
- 30 天公示 + ≥ 2/3 maintainer 多签(user 作为多签一票,非个人否决,详 §4 I-4)/ 30-day public notice + ≥ 2/3 maintainer multisig (user as one signer, no personal veto, see §4 I-4)
- 降级不是失败,是治理弹性的体现 / Downgrade is not failure; it's governance elasticity
- **不允许跨级降级**(D→A 必须经 C→B→A)/ **No skip-level downgrade** (D→A must pass through C→B→A)

**phase D 后的特殊条款 / Phase D special clauses**:
- D→C 需 DAO 投票 ≥ 80% + user 复活 + 60 天公示 / D→C requires DAO vote ≥ 80% + user reactivation + 60-day public notice
- 永远保留紧急回退到 C 的元规则修改权(灾难情境)/ Always retain emergency meta-rules modification right to fall back to C (disaster scenarios)

---

## §4 不可侵犯 / Constitutional Invariants

以下事项**永远**不允许 / The following are **always** prohibited:

### I-1 元规则不可推翻 / Meta-Rules Inviolable
- 修改 10 元规则任一条 → 60 天公示 + user + 2/3 maintainer 多签 / Modifying any of 10 rules → 60-day public + user + 2/3 maintainer multisig
- 删除任一条 → **不允许**(可演化 ≠ 可删除) / Deleting any → **prohibited** (evolvable ≠ deletable)

### I-2 license 演化锁定 / License Evolution Lock

**当前 License**: **Business Source License 1.1** (BSL 1.1) — **Change Date 2030-05-18 自动转 MIT**(`LICENSE` 文件 hardcoded)
**Current License**: **Business Source License 1.1** (BSL 1.1) — **Change Date 2030-05-18 auto-converts to MIT** (hardcoded in `LICENSE` file)

**BSL 期间约束 / BSL period constraints**:
- 限制:不能提供与 WebAZ 竞争的 hosted/managed service / Restriction: no competing hosted/managed service
- **允许**:非商业 / 学术 / 个人 / fork 修改非竞争性使用 / **Allowed**: non-commercial / academic / personal / fork modification for non-competing use

**演化锁定(永久 invariant)/ Evolution lock (permanent invariant)**:
- **不允许在 Change Date 前转向更严格 license**(SSPL / proprietary 等)/ **No transition to stricter license before Change Date**
- **不允许延后 Change Date**(2030-05-18 hard-locked) / **No delay of Change Date**
- **不允许在 Change Date 后比 MIT 更严格** / **No license stricter than MIT after Change Date**
- 任何 license 调整需 user + 2/3 maintainer 多签 + 60 天公示(且不能违反以上 3 条)/ Any license adjustment requires user + 2/3 maintainer multisig + 60-day public notice (and cannot violate above 3)

**评审节点 / Review cadence**:
- 每年 Q4 review 是否要提前转向 Apache-2.0 / MIT(只能更宽,不能更严)/ Annually in Q4: review whether to switch to Apache-2.0 / MIT earlier (only more permissive, never more restrictive)

### I-3 反 MLM 红线 / Anti-MLM Red Line

**反 MLM 底线(本 Invariant 守的是底线,不锁激励的具体实现方式)/ Anti-MLM floor (this Invariant guards the floor, does NOT lock specific incentive implementation)**:

- 永远 0 directly per-PR 现金激励 / Never directly per-PR cash rewards
- 永远不收"会员费 / 加入费" / Never "membership/joining fees"
- 任何激励机制不得引入"先付钱后获益"、不得按"发展人头"计酬 / No "pay-first-benefit-later"; no "headcount-based" compensation

**关系层 vs 估值层(对齐 [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §3)/ Relationship vs Valuation layer (aligned with framework §3)**:

- **关系层(定死,Invariant)/ Relationship layer (locked, Invariant)**:"先来后到"的位置坐标 = 历史事实,append-only 不可篡改 — **这是记录,不是收益权** / "First-come-first-serve" position coordinates = historical fact, append-only immutable — **this is a record, not entitlement**
- **估值层(不定死,交 DAO)/ Valuation layer (NOT locked, decided by DAO)**:是否将关系层位置用作激励参数、如何换算,由 phase D DAO + 估值层决定;**位置是可选用的工具之一,非强制机制** / Whether to use relationship-layer position as an incentive parameter and how — decided by phase-D DAO; **position is one optional tool, NOT a required mechanism**

> ⚠️ 本 Invariant **不规定"激励必须通过位置"** — 那是估值层的演化空间(详 framework §3.2 "位置可作修饰参数 + 4 边界")。本条只守底线 + 锁记录层事实。
> ⚠️ This Invariant **does NOT mandate "incentives must use position"** — that's the valuation layer's evolution space (see framework §3.2). This clause only guards the floor + locks relationship-layer facts.

### I-4 宪法级修改保护(去人格化)/ Constitutional Amendment Protection (depersonalized)

> **不是 user 个人否决权 — 是协议级高门槛保护机制,user 仅作为多签一票参与。**
> **Not user's personal veto — a protocol-level high-threshold mechanism; user is one signer in multisig.**

**宪法级条款清单 / Constitutional clause registry**(本清单本身也是宪法级 / this registry itself is constitutional):
- 元规则 #1-#10(`META-RULES-FULL.md` §2)/ Meta-rules #1-#10
- Iron-Rule 7 paths 默认(`SECURITY.md`)/ Iron-Rule 7 default paths
- 三承重墙:来去自由 / DAO 定回报 / 不偏袒(详 25-核心承诺,文件 W3.5 落地中)/ Three load-bearing walls: free-exit / DAO-decides-reward / no-favoritism
- 反 EEE 底线:用户主权可迁移 + 网络层 copyleft(详 主权岛屿战略)/ Anti-EEE floor: user-sovereignty portability + network-layer copyleft
- 资金路径 / **fault 处置【规则】**(非个案判决,个案归仲裁机制)/ Fund-paths / **fault-handling 【rule】** (NOT individual case verdict)
- **本条款(I-4)本身**(防绕过:先改保护机制再改一切)/ **This clause (I-4) itself** (anti-circumvention: prevent changing the protection mechanism first to change everything else)

**三重门槛**(全部满足) / **Three-tier gate** (all required):

1. **超级多数 多签 / Supermajority multisig**:
   - phase A:user 作为唯一 maintainer 单签(因 solo,非个人特权)/ user signs as sole maintainer (because solo, not personal privilege)
   - phase B+:≥ `protocol_params.constitutional_supermajority_ratio`(默认 0.667 = 2/3)maintainer 多签,**user 作为其中一票,非个人否决** / phase B+: ≥ ratio maintainer multisig, **user is one signer, no personal veto**

2. **60 天公示 / 60-day public notice**:RFC 提案 → 60 天 GitHub Issue 公开质疑期 → 期间任何 webazer 可挑战 / RFC → 60-day public challenge window → any webazer may challenge

3. **多签合约 enforce / Multisig contract enforce**:I-6 中代码层强制(`constitutional_amendment` 多签收集器),不是"承诺记得检查" / Code-enforced in I-6 (`constitutional_amendment` collector), not "remember to check"

**门槛分级 / Threshold tiers**:

| 宪法级条款类型 / Type | 多签门槛 / Multisig threshold | 公示 / Notice |
|---|---|---|
| 元规则 #1-#10 / Iron-Rule / 资金路径 / **fault 处置规则**(非个案判决)| 超级多数(`constitutional_supermajority_ratio`,默认 2/3) | 60 天 |
| license / 反 EEE 底线 / 三承重墙 | **全 maintainer 多签**(同 I-2) | 60 天 |
| **本条款(I-4)修改本身** | **全 maintainer 多签**(防"用低门槛改保护机制再改一切") | 60 天 |

**ratio 参数化 + 自我指涉锁 / Ratio parameterization + self-referential lock**:

- `protocol_params.constitutional_supermajority_ratio`(默认 0.667)
- **只能调高(更严),不能调低(更松)** — 代码 enforce(I-6 `only-increase` hook)/ **Only increase, never decrease** — code-enforced
- 修改 ratio 本身 = 宪法级修改,需走本条款完整流程 / Changing ratio itself = constitutional amendment, follows this clause's full flow
- 即:"想放松保护"必须先满足"当前保护"才能改 — 任何放松提案都需当前 ratio 通过 / "Loosening protection" must satisfy current protection — any relaxation proposal needs current ratio to pass

**phase 演化(去人格化轨迹)/ Phase evolution (depersonalized trajectory)**:

- **phase A**:user = 唯一 maintainer,等于 1-of-1 多签(因 solo,非特权)/ User = sole maintainer, equivalent to 1-of-1 multisig (because solo, not privilege)
- **phase B**:user 是 2-3 maintainer 中的一票;宪法级 2/3 多签 → user 不能单独阻止,也不能单独通过 / User is one of 2-3 maintainers; 2/3 multisig → user cannot solely block nor solely pass
- **phase C**:DAO 多签(maintainer + 高分 contributor);user 是多签一票;无任何"宪法否决"特权残留 / DAO multisig; user is one signer; no constitutional veto residual
- **phase D**:user 退到普通 DAO 成员;宪法守护完全由 DAO 超级多数履行 / User retires to regular DAO member; constitutional guardianship fully by DAO supermajority

**I-4 修改机制内无个人否决;守护权是独立的 I-4a / No personal veto *within the I-4 amendment mechanism*; guardianship is the separate I-4a**:

- 在【I-4 常规宪法修改流程】内,创始人不享个人否决:user 作为多签一票,守的是"协议根基不被多数轻易改",**对所有提案者一致**。/ *Within the I-4 routine amendment process*, the founder has no personal veto: user is one signer in multisig; this protects "protocol roots can't be lightly changed", **uniform for all proposers**.
- 创始人参与 I-4 多签是因 phase A 唯一 maintainer / phase B+ 是多签人之一,**不是因为是创始人** / Founder is in the I-4 multisig because they are sole maintainer (phase A) or one of multiple maintainers (phase B+), **not because they're the founder**.
- **守护权(I-4a)是另一层、另一目的**:I-4 是"社区如何修宪"的去人格化流程;I-4a 是"项目成熟前防被劫持"的创始人守护。两者不互相覆盖。守护权受 I-4a 三约束(不牟利 / fork 敞开 / 公开记录)、不给任何经济优待,属元规则 #5 所允许的"有合规理由的角色差异",非个人牟利特权。/ **Guardianship (I-4a) is a different layer and purpose**: I-4 is the depersonalized process for *how the community amends*; I-4a is founder guardianship *against capture before maturity*. They do not override each other. Guardianship is bound by I-4a's three constraints, grants no economic advantage, and falls under meta-rule #5's permitted "justified role-differentiation", not for-gain privilege.

**检验 / Self-check**:
- 在 I-4 流程内,user 凭"创始人身份"否决【常规修宪多签结论】为自身谋私 → ❌ 违反本条款 / Within I-4, user vetoing a *routine amendment multisig conclusion* by "founder identity" for self-benefit → ❌ violates this clause
- 守护权(I-4a)的行使受 I-4a 约束:phase D 后仅限"挡破坏",须公开理由、不得牟利 → ✅ 合规守护 / Exercise of guardianship (I-4a) is bound by I-4a: post-phase-D limited to "blocking destruction", with public reason and no personal gain → ✅ compliant guardianship

### I-4a 创始人守护权 / Founder Guardianship (Linux/Rails BDFL model)

> **本条与 I-4 是不同层级**:I-4 管"常规宪法修改流程"(去人格化、多签、user 仅一票);I-4a 管"项目成熟前防被劫持的守护"(创始人作为发起者,对关键决策的最终把关)。PR #16 去人格化的是【日常 / 常规决策】;本条守护的是【关键决策】。二者不冲突、不互相覆盖。
> **This clause is a different layer from I-4**: I-4 governs the *routine constitutional amendment process* (depersonalized, multisig, user as one vote); I-4a governs *guardianship against capture before maturity* (the founder, as originator, holds the final backstop over key decisions). PR #16 depersonalized *daily / routine decisions*; this clause guards *key decisions*. They do not conflict nor override each other.

**理由 / Rationale**:项目真正成长起来之前,创始人是最有动机维护其健康的人。phase A-C 阶段项目脆弱,少数 maintainer 串通搞停、或恶意 fork 劫持方向的风险真实存在。守护权是平稳成长前的防劫持安全网(Linux / Torvalds、Rails / DHH 的 BDFL 模式)。/ Before the project truly matures, the founder is the most motivated to keep it healthy. In phases A-C the project is fragile, and the risk of a few maintainers colluding to stall it or maliciously forking its direction is real. Guardianship is a safety net against capture before stable growth (the BDFL model of Linux/Torvalds, Rails/DHH).

**"关键决策"定义 / "Key decisions"**:复用 §3.2 矩阵已定义的高敏感类别,**不另立新定义** / reuses the high-sensitivity categories already defined in the §3.2 matrix, **no new definition**:协议状态机 / 资金路径 / 元规则 / Iron-Rule 默认 / 增减 maintainer / 对外重大承诺 / 危及存续的决定。/ Protocol state-machine / fund-path / meta-rules / Iron-Rule defaults / adding-or-removing maintainers / major external commitments / survival-threatening decisions.

**phase 演化 / Phase evolution**:
- **phase A / B / C**:创始人对"关键决策"有**最终决定权**(可主动推动,可否决)。这是 §3.2 多签的【上层】:**当守护权与多签结论冲突时,phase A-C 以创始人决定为准**。/ Founder holds **final decision authority** over "key decisions" (may proactively drive, may veto). This sits **above** §3.2 multisig: **when guardianship conflicts with a multisig conclusion, the founder's decision prevails in phases A-C**.
- **phase D**:守护权**收缩为仅"挡破坏"** —— 只能否决【违反元规则 / 破坏 Iron-Rule / 改坏资金路径 / 危及存续】的提案,**不能再主动推动**任何决策。/ Guardianship **contracts to defensive-only** — may only veto proposals that [violate meta-rules / break Iron-Rule / corrupt fund-path / threaten survival]; **may no longer proactively drive** any decision.
- phase D 触发条件 = §3.3 已定义,**不另设**(DAO 自治 1 年无重大事故 / 协议参数稳定 / **user 主动让权**)。注意:§3.3 phase D 触发**含"user 主动让权"** —— 即进入 phase D 本身需创始人同意。守护权不会被单方面剥夺,只会被创始人**自愿**收缩为防御性。/ Phase D trigger = as already defined in §3.3, **not redefined** (DAO self-governed 1 year incident-free / params stable / **user voluntarily steps down**). Note: §3.3's phase D trigger **includes "user voluntarily steps down"** — entering phase D requires founder consent. Guardianship is never unilaterally stripped, only **voluntarily** contracted to defensive by the founder.

**约束(使守护为防御、非牟利特权)/ Constraints (guardianship is defensive, not an extractive privilege)**:
1. 守护权**仅用于维护项目健康**,不得用于给创始人谋取收益 / 资源优待 / 个人利益。/ Guardianship is **solely for project health**, never for founder profit / resource preference / personal gain.
2. **fork 权利始终敞开** —— 开源天然权利,守护权不禁止任何人 fork。/ **Fork right always open** — an inherent open-source right; guardianship forbids no one from forking.
3. 每次行使守护权**必须公开记录理由**(GitHub Issue / commit / audit log)。/ Every exercise of guardianship **must be publicly recorded with its reason**.

**与元规则 #5(不偏袒)的关系 / Relation to Meta-Rule #5 (No favoritism)**:
#5 禁止的是【为个人牟利 / 绕过流程谋私】的特权(见 `META-RULES-FULL.md` #5 反例:给自己钱包打款、删差评、自批 PR、开 Iron-Rule 豁免 —— 全是牟利 / 绕流程)。#5 的"适用场景"**明确允许**"基于角色 / 身份的差异化处理,**只要有元规则之外的合规理由**"。创始人守护权是【为协议防御、有明确治理理由、且受上述 3 约束】的角色差异 —— **属于 #5 允许的有理由差异,不属于 #5 禁止的牟利偏袒**。守护权不给创始人任何经济 / 资源 / 搜索排序 / 仲裁上的优待。/ #5 forbids privilege [for personal gain / bypassing process for self-benefit] (see #5 reverse-examples: paying own wallet, deleting reviews, self-approving PRs, Iron-Rule exemptions — all for-gain / process-bypass). #5's "applies to" **explicitly permits** "role/identity-based differential treatment **as long as there is a justification outside the meta-rules**." Founder guardianship is role-differentiation [for protocol defense, with a clear governance justification, bound by the 3 constraints above] — **it falls under #5's permitted justified differentiation, not the for-gain favoritism #5 forbids**. Guardianship grants the founder no economic / resource / search-ranking / arbitration advantage.

**修改 I-4a 本身 / Modifying I-4a itself**:属"关键决策"。phase A-C 受守护权保护(创始人可否决移除 —— 这正是防"成熟前被串通剥夺守护"的设计目的);phase D 后按 §6 中 §4 的最高门槛(全 maintainer 多签 + 60 天公示)。/ A "key decision". Phases A-C: protected by guardianship (the founder may veto its removal — precisely the design intent of preventing "guardianship being stripped by collusion before maturity"); post-phase-D: §6's §4 highest threshold (all-maintainer multisig + 60-day notice).

### I-5 contribution = participation = ownership(元规则 #10) / Same as Meta-Rule #10
- contributor 跟 user 共享同一身份系统 / Contributors and users share same identity system
- contributor 同时也是 user,享有 webaz 协议全部权利 / Contributors are also users with all webaz protocol rights
- 不分"开发者 vs 用户"两套规则 / No "developer vs user" dual-track rules

### I-6 invariants 的加密学保证 / Cryptographic Guarantees for Invariants

> 元规则 #2 "代码即规则" 要求 invariants 必须**代码 enforce**,不能只靠"我们承诺"。
> Rule #2 "Code is Rule" requires invariants to be **code-enforced**, not "trust us".

| Invariant | 机器可验证检查点 / Machine-verifiable checkpoint |
|---|---|
| I-1 元规则不可推翻 / Meta-rules inviolable | `meta-rules.yaml` SHA256 入 git tag,变更必须新版本号 / SHA256 in git tag, change requires new version<br>**Phase A 已实施 / Phase A status(2026-06-03, task #1086)**:✅ `docs/meta-rules.yaml` + `docs/META-RULES-LOCK.md` + `scripts/meta-rules-invariant-check.ts`(CI job `meta-rules invariants`);git tag 暂留空(phase A 单人无 GPG 设置),CI 检测 + LOCK.md hash 是主 enforcement |
| I-2 license 演化锁定 / License evolution lock | `LICENSE` 文件 Change Date 硬编码 + commit hash 跨多副本镜像 / Change Date hardcoded + commit hash mirrored |
| I-3 反 MLM 红线 / Anti-MLM | `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md` 校验 + 经济引擎自动检查 / Validation + economic engine auto-check |
| I-4 宪法级修改保护 / Constitutional amendment protection | 多签合约 enforce `constitutional_supermajority_ratio`(phase A: 1-of-1;phase B+: ratio-based 多签收集器);ratio `only-increase` hook 防回滚;RFC bot 计数多签人数对照 ratio;ratio 当前值入 git tag / Multisig contract enforces ratio (phase A: 1-of-1; phase B+: ratio-based collector); `only-increase` hook on ratio; RFC bot counts signers vs ratio; ratio value in git tag<br>**Phase A 已实施 / Phase A status (2026-06-03, task #1095)**:✅ ratio param + only-increase hook(`category='constitutional'`,PATCH + reset 都守门)— `src/pwa/routes/admin-protocol-params.ts`;⏳ phase B+ deferred:multisig collector / RFC bot / 60d Issue tracker / git tag |
| I-5 同身份系统 / Same identity system | `reputation_scores` schema diff 必须 RFC / `reputation_scores` schema diff requires RFC |

任何 invariant 被代码上绕过 = 重大事故 → 触发紧急回滚 + 公开复盘。/ Any invariant bypassed in code = major incident → triggers emergency rollback + public post-mortem.

**落地路径 / Implementation path**:
- W4-W5: I-1/I-2/I-3 检查点纳入 CI / I-1/I-2/I-3 checkpoints integrated into CI
- W6-W7: I-4/I-5 验证机制建成 / I-4/I-5 verification mechanism built
- W8 公开 repo 时全部生效 / All active when repo goes public in W8

---

## §5 加入与退出 / Join & Leave

### 5.1 加入 / Join
- **Reader → Member**:webaz 注册 + 同意 CoC 即可,无门槛 / webaz register + agree to CoC, no barrier
- **Member → Contributor**:绑 Passkey(真人)+ 第 1 个 PR merge / Passkey bound + 1st merged PR
- **Contributor → Reviewer**:满累计数 + 时长,自动升级 / Auto-upgrade upon meeting counts + duration
- **Approver → Maintainer**:user 提名 + 公示 14 天 / User nominates + 14-day public notice

### 5.2 退出 / Leave
- Contributor / Reviewer / Approver 可随时停;无需通知,身份保留但不再活跃 / Can stop at any time; no notification needed, identity preserved but inactive
- Maintainer 退出走 14 天交接(交接 OWNERS 文件中负责的目录、未完 PR 等)/ Maintainer leaves with 14-day handover

### 5.3 驱逐与复议 / Eviction & Reconsideration

**升级路径 / Escalation path**:
1. 私下警告(maintainer)/ Private warning (maintainer)
2. 公开警告(2 maintainer 同意)/ Public warning (2 maintainers agree)
3. 暂停(≥ 3-of-N 多签:2 maintainer + user 作为一票;期限 30 天起)/ Suspension (≥ 3-of-N multisig: 2 maintainers + user as one signer; ≥ 30 days)
4. 永久驱逐(≥ 3-of-N 多签:2 maintainer + user 作为一票)/ Permanent eviction (≥ 3-of-N multisig: 2 maintainers + user as one signer)

**永久驱逐生效后 7 天内可申请复议** / **Reconsideration available within 7 days of permanent eviction**:
- **申请方式**:发起 `RFC-rehear`,提供新证据 / Initiate `RFC-rehear`, provide new evidence
- **复议门槛**:全 maintainer 多签同意复议(user 作为一票,非个人否决) / All-maintainer multisig agree to rehear (user as one signer, no personal veto)
- **复议结果**:维持原判 / 减为暂停 / 撤销 / Outcomes: uphold / downgrade to suspension / revoke
- **复议结果是最终的**,不再上诉 / Reconsideration outcome is **final**, no further appeal

**跨 phase 的特殊条款 / Cross-phase special clauses**:
- phase D 后所有驱逐复议由 DAO 决定 / Post-phase D, all eviction reconsiderations decided by DAO
- **系统级驱逐**(影响协议安全,已通过紧急多签确认)不可复议 / **System-level eviction** (protocol security, confirmed via emergency multisig) is non-reconsiderable

**驱逐后 / Post-eviction**:
- Contributor 身份撤销 / Contributor identity revoked
- 已 merge 的代码不收回(license 保障)/ Already-merged code not retracted (license guarantees)
- reputation 标 "removed"(不删除历史)/ Reputation marked "removed" (history preserved)
- 永久驱逐复议失败后不可再申请 / Permanent eviction after failed reconsideration: no re-application

---

## §6 修改本宪章的流程 (Meta) / Charter Self-Modification

宪章本身可演化,但代价应足以反映其重要性 / Charter is evolvable, but at a cost reflecting its importance:

| 章节 / Section | 修改要求(user 作为多签一票,非否决)/ Requirement (user as one signer, not veto) |
|---|---|
| **§1 使命与定位 / Mission** | RFC + 30 天公示 + 2-of-2 多签(任 1 maintainer + user 作为一票)/ 30d + 2-of-2 multisig |
| **§2 10 元规则 / 10 Meta-Rules** (canonical 一句话 / one-liners) | 60 天公示 + **超级多数多签**(phase A: user 1-of-1;phase B+: ≥ `constitutional_supermajority_ratio`,等同元规则修改)/ 60d + supermajority (phase A: 1-of-1; phase B+: ≥ ratio) |
| **§3 治理结构 / Governance** | RFC + 30 天公示 + 超级多数多签(同 §2)/ 30d + supermajority |
| **§4 不可侵犯 / Invariants**(含 I-4 宪法级修改保护 + I-4a 创始人守护权) | 60 天公示 + **全 maintainer 多签**(user 作为一票;改 I-4 / I-4a 本身 = 最高门槛防绕过)。**注:phase A-C 改 I-4a 另受守护权约束(创始人可否决移除,详 §4 I-4a);phase D 后按本行门槛**。/ 60d + all-maintainer multisig (user as one signer; modifying I-4 / I-4a itself = highest threshold, anti-circumvention). **Note: in phases A-C, modifying I-4a is additionally subject to guardianship (founder may veto its removal, see §4 I-4a); post-phase-D follows this row's threshold.** |
| **§5 加入与退出 / Join & Leave** | RFC + 14 天公示 + 2-of-2 多签(任 1 maintainer + user 作为一票)/ 14d + 2-of-2 multisig |
| **§6 本章(修改流程)/ This Section** | **全 maintainer 多签** + 60 天公示(**改本节本身 = 改宪法级保护机制 = 最高门槛**,user 作为一票)/ **all-maintainer multisig** + 60d (**modifying this section itself = modifying constitutional protection mechanism = highest threshold**, user as one signer) |

**任何 contributor 可提宪章 RFC**(`docs/rfcs/RFC-charter-xxx.md`)/ Any contributor can submit charter RFC:
- **phase A**:user 作为唯一 maintainer 单签(因 solo,非个人特权)/ phase A: user signs as sole maintainer (because solo, not personal privilege)
- **phase B+**:user 作为多签一票,**无个人否决权**(详 §4 I-4)/ phase B+: user as one multisig signer, **no personal veto** (see §4 I-4)

phase D 触发后 / After phase D:
- §1 / §3 / §5 改 → DAO 多签(user 作为普通 DAO 成员一票)/ DAO multisig (user as regular DAO member, one vote)
- §2 / §4 / §6 改 → DAO 60 天公示 + 超级多数 / 全 maintainer 多签(同 phase B+ 但 user 是普通成员)/ DAO 60d + supermajority / all-maintainer multisig (same as phase B+ but user is regular member)

---

## §7 引用关系 / Reference Relations

**人类可读版本 / Human-readable**:

```
                    [META-RULES.md / META-RULES-FULL.md]
                              ↑ §2 嵌入 / embedded (canonical 不超链接 / not via link)
                              │ §4 引用为 invariant / referenced as invariants
                    ┌─────────┴────────┐
                    │   CHARTER (本 / this) │
                    └─────────┬────────┘
                              │
              ┌───────────┬───┴────┬──────────────┐
        GOVERNANCE   CONTRIBUTING   CODE_OF_     ARCHITECTURE
                                    CONDUCT
                              │
                     (子文档都引用 charter / child docs all reference charter)
```

**机读版本 / Machine-readable**:`docs/charter-deps.yaml`,供 AI review 在宪章改动时自动检查 children 一致性(实现见 G4c AI review)。/ For AI review to auto-check children consistency on charter changes (see G4c AI review implementation).

`charter-deps.yaml` 结构 / Structure:

```yaml
dependencies:
  charter:
    parent:
      - docs/META-RULES.md
      - docs/META-RULES-FULL.md
    children:
      - docs/GOVERNANCE.md
      - CONTRIBUTING.md
      - docs/CODE_OF_CONDUCT.md
      - docs/ARCHITECTURE.md

  sync_rules:
    parent_change_requires_child_review: true
    child_change_within_parent_scope: true
    circular_reference: forbidden

ai_review:
  on_charter_change:
    - check_all_children_consistency
    - flag_inconsistencies
    - require_user_approval_before_merge
```

所有子文档**不重复**宪章定义,而是引用 `CHARTER §X.Y`。这样改宪章一处,生效全局。/ Child docs **don't duplicate** charter definitions; they reference `CHARTER §X.Y`. One charter change → global effect.

---

> **本宪章 v1.0 起草于 2026-05-31**,W2 起公示 30 天,W3 末 lock 后启用 / **Charter v1.0 drafted on 2026-05-31**, 30-day public notice starting W2, lock at end of W3.
> 任何 webazer(含 reader)可在公示期通过 GitHub Issue 提反馈 / Any webazer (including readers) can submit feedback via GitHub Issue during public period.
> 修改记录 append-only 写在 `docs/CHARTER-CHANGELOG.md`(v1.1 / v2.0 ...)/ Modification history append-only in `docs/CHARTER-CHANGELOG.md`.
