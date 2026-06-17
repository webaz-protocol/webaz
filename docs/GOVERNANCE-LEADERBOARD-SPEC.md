# Governance Leaderboard Specification

> **Status**: draft(等用户 review)/ draft (pending review)
> **Track**: meta-rule application(非新元规则)/ meta-rule application (not a new meta-rule)
> **Author**: @seasonkoh
> **Created**: 2026-06-01
> **Parent framework**: [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) — 本 spec 是 §4 phase A "履职数据公示"(observation-only)的具体实现 / This spec implements §4 phase A "performance disclosure" (observation-only)
> **关联** / **Related**:
> - [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) — 父框架,本 spec 严格在 §4 observation-only 边界内 / Parent framework, this spec strictly within §4 observation-only boundary
> - 原则 vs 机制 — 原则永久 / 机制 DAO 可调
> - 隐私先于规模 — 公开机制,私密运营
> - launch ≠ maturity — phase A measurement 不构成 phase D reward distribution
> - [`RFC-001`](rfcs/RFC-001-license-decision.md) §3.5 — phase A 豁免

---

## 🚫 §0 顶层声明:本 leaderboard **不是** reward distribution

⚠️ **本规范严格在 [`CONTRIBUTOR-REWARD-FRAMEWORK`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §4 phase A "履职数据公示(observation-only)" 边界内 — 仅记录 + 展示,不构成任何 token / 经济利益 / 治理席位 分配机制。**

⚠️ **This spec stays strictly within [`CONTRIBUTOR-REWARD-FRAMEWORK`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §4 phase A "performance disclosure (observation-only)" boundary — recording + display only, no token / economic / governance-seat distribution.**

- **目标(永久 locked,framework §1)**:贡献与回报正相关 / Contribution and reward positively correlated
- **本 spec 的 phase A 实现**:展示 4 个履职 measurement(关系层数据 + 简单聚合),**不附带权重 / 复合排名 / "best/worst" 价值判断** / Phase A implementation: display 4 performance measurements (relation-layer data + simple aggregation), **NO weights / composite ranking / "best/worst" value judgment**
- **完整经济 / 治理回报机制**:由 phase D DAO + 专业团队(含法律从业者)决定;**本 spec 不预设、不暗示** / Full economic / governance reward mechanism: decided by phase D DAO + professional team (incl. legal practitioners); **this spec does NOT pre-set or imply**
- 任何 contributor / observer 看到本 leaderboard 时,**不得**假设排名直接对应 token / fund / 治理席位分配 / No contributor / observer should assume ranking directly corresponds to token / fund / governance-seat allocation

→ UI 上必须显式 banner 标注这点(见 §6.1)。
→ UI MUST display this explicitly as a banner (see §6.1).

### 0.1 本 spec 与父框架的对齐性 / Alignment with Parent Framework

| Framework 概念 / Concept | 本 spec 对应 / Spec correspondence |
|---|---|
| **关系层(数据,phase A 记录)** / Relation layer (data, recorded in phase A) | §1 + §2 — 案件计数 / 决议结果 / 推翻状态 / 响应时间(纯事实)/ Case counts / outcomes / overturn status / response time (pure facts) |
| **估值层(机制,未来 DAO 定)** / Valuation layer (mechanism, future DAO) | **本 spec 不涉及** — 不引入权重 / 复合分数 / 排名"质量"标签 / **NOT in this spec** — no weights / composite scores / quality labels |
| **目标层(永久)** / Goal layer (permanent) | §6.1 banner 显式标"本表展示数据,不是 reward 分配" / Banner explicitly states "this is data display, not reward distribution" |

---

## §1 适用对象 / Scope

公示对象 = **arbitrator + verifier 两类角色**(履职质量直接影响 user 结果的人):

Leaderboard subjects = **arbitrator + verifier roles** (those whose performance directly affects user outcomes):

| 角色 / Role | 触碰的 Iron-Rule 路径 / Iron-Rule paths | 性质 / Nature |
|---|---|---|
| **arbitrator** | `arbitrate` | 处理 dispute,真人 Passkey 必须 |
| **verifier** | `claim_verify` | 验证 claim,真人 Passkey 必须 |

**不纳入本 leaderboard 的角色** / **NOT in this leaderboard**:
- code contributor(走 [`CHARTER §3.1`](CHARTER.md) 5-tier ladder,不同维度)
- maintainer(治理身份,不是履职单位)
- logistics / admin / other operational roles(履职属性弱)

→ 若未来需要扩展到其他角色,需 RFC 修订本 spec。
→ Extending to other roles requires RFC revision.

---

## §2 4 个 Measurement 维度 / Four Measurement Dimensions

### 2.1 Accuracy(准确度)

**For arbitrator**:决定后未被推翻的比例 / Proportion of decisions not overturned

- 计算公式 / Formula:
  ```
  accuracy = (decisions_not_appealed + decisions_appealed_but_upheld) / total_decisions
  ```
- 推翻条件 / Overturn conditions:appeal 上诉成功 OR 双方均拒绝接受 OR 后续证据反转决议
- 显示 / Display:百分比 0-100%(<5 cases 显示 "insufficient data")
- Frequency:实时更新(case complete + 14d appeal window 关闭后定版)

**For verifier**:验证后与共识不矛盾的比例 / Proportion of verifications consistent with later consensus

- 计算公式 / Formula:
  ```
  accuracy = verifications_consistent_with_final_outcome / total_verifications
  ```
- 共识来源 / Consensus source:其他 verifier 多数判断 + 商品最终状态(实物核验 / 链上确认 / 后续 dispute 结论)

### 2.2 Fairness(公平度)

**For arbitrator**:决议在双方间的均衡度 / Balanced treatment between parties

- 计算公式 / Formula:
  ```
  fairness_raw = 1 - |buyer_win_rate - 0.5| × 2     # 偏离 50/50 越远越低
  evidence_balance = min(buyer_evidence_view_time, seller_evidence_view_time) / max(...)
  fairness = 0.6 × fairness_raw + 0.4 × evidence_balance
  ```
- 解读 / Interpretation:**不是要 50/50 决议比**,而是要避免**系统性偏向一方**(若长期 80% buyer 赢,可能有偏)/ Not aiming for 50/50, but avoiding **systematic bias**

- 显示 / Display:0-100 score(<10 cases 显示 "insufficient data")

**For verifier**:跨类别一致性 / Cross-category consistency

- 计算公式 / Formula:
  ```
  fairness = 1 - stddev(category_approval_rates)    # 各品类批准率方差越小越公平
  ```
- 解读 / Interpretation:避免某 verifier 对 X 类商品系统性宽松 / Y 类系统性严苛 / Avoid systematic leniency/strictness per category

### 2.3 Case Count(案件数)

总处理案件数 / Total cases handled

- 显示 / Display:整数 + 30d 滚动 / 总累计(双数字)/ Integer + 30d rolling / total cumulative (dual)
- 用于 / Used for:**默认排序维度**(最活跃 first)+ accuracy/fairness 的样本量判断 / **Default sort dimension** (most active first) + sample-size gating for accuracy/fairness

### 2.4 Response Time(响应时间)

从案件分配到首次有效行动的中位数 / Median time from assignment to first valid action

- 计算公式 / Formula:
  ```
  response_time_ms = median(t_first_action - t_assignment) over last 50 cases
  ```
- 首次有效行动 / First valid action:arbitrator 阅读全部证据 / verifier 提交初判
- 显示 / Display:人类可读时间(`2h 15m` / `1d 4h`)/ Human-readable time
- **不是单纯越快越好**:过快可能意味着草率;过慢可能意味着 reservoir 卡 / Faster ≠ better; too fast may = careless; too slow may = bottleneck

---

## §3 ❌ Composite Score:Phase A 不引入 / NOT in Phase A

**判断 / Rationale**:复合得分 = 加权聚合 = **估值层的价值判断**(哪个维度重要、权重几何)= 父框架 [`CONTRIBUTOR-REWARD-FRAMEWORK`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §2 明确交给 phase D DAO + 专业团队。

**Rationale**: Composite score = weighted aggregation = **valuation-layer value judgment** (which dimension matters, what weights) = explicitly deferred to phase D DAO + professional team per framework §2.

**Phase A 实际做的** / **What Phase A actually does**:
- 显示 4 个独立维度,**让用户自己选排序维度**(默认 `case_count desc`,这是事实最 neutral 的选择 — "最活跃 first" ≠ "最好 first")/ Display 4 separate dimensions, **let user pick sort dimension** (default `case_count desc`, the most factually neutral choice — "most active first" ≠ "best first")
- **不提供 "Best" / "Top" 排名标签** / **NO "Best" / "Top" ranking labels**
- **不存储 / 不展示** composite 或衍生 "quality" 分数 / **Do NOT store / display** composite or derived "quality" scores

**未来若 DAO 引入复合机制**:必须走 [`CHARTER §6`](CHARTER.md) RFC 流程,公示 60d,公布完整公式 + 权重 + 是否进入 reward 路径。/ If a future DAO introduces composite: must go through CHARTER §6 RFC, 60d notice, publish full formula + weights + whether it feeds into reward path.

→ 这条 NOT-IN-PHASE-A 决策本身是 **诚实先于聪明** 的体现(不假装我知道权重该是多少;让未来最懂的人定)。
→ This NOT-IN-PHASE-A decision itself reflects **honesty before cleverness** (not pretending I know what weights should be; let future experts decide).

---

## §4 边界 / Edge Cases & Thresholds

| 情况 / Case | 处理 / Handling |
|---|---|
| 新 arbitrator / verifier,0 cases | 显示 "Member,no cases yet";不参与排序 / Show "Member, no cases yet"; excluded from sort |
| < 5 cases | accuracy 列显示 "insufficient data" / Insufficient data |
| < 10 cases | fairness 列显示 "insufficient data" |
| 90d 无案件 | 显示 "inactive" badge,默认隐藏(可勾选 "show inactive")/ "inactive" badge, hidden by default |
| 被 CoC §8 处分 suspended | 显示 "suspended" badge,**保留在 leaderboard**(透明度 > 屏蔽);不显示具体原因(隐私)/ "suspended" badge, **kept in leaderboard** (transparency > censorship); reason not disclosed (privacy) |
| Permanent ban | 移出 leaderboard;**保留历史 anchor handle 在 audit log** / Removed from leaderboard; historical anchor handle retained in audit log |

---

## §5 隐私 / Privacy(对照 #1 + #3 + memory `privacy-before-scale`)

公开字段(任何访客可见)/ **Public fields**(any visitor):
- anchor handle(ASCII only;protocol-level identity)
- role badge(arbitrator / verifier / both)
- 4 metrics(accuracy / fairness / case_count / response_time)
- composite(可选)
- active / inactive / suspended badges

**禁止公开字段** / **NOT public**:
- ❌ real name
- ❌ email / phone / contact
- ❌ physical / IP location(只显示**辖区 group**,如 "APAC" / "EMEA" 粒度,无国别细化)
- ❌ wallet balance / token holdings
- ❌ 具体案件涉及的 user identity(只有 case ID + 双盲 anchor handle)
- ❌ suspension reason(只显示 badge,理由进 audit log 但 PII-redacted)

---

## §6 UI 规范 / UI Specification

### 6.1 顶部 banner(必须)/ Top banner (mandatory)

```
┌──────────────────────────────────────────────────────────────────┐
│ 📊 本 leaderboard 仅展示履职数据,不构成 token / 经济利益分配。     │
│    Reward distribution mechanism = TBD by phase D first DAO.    │
│    详 [GOVERNANCE-LEADERBOARD-SPEC.md].                          │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 表格列 / Table columns

```
Rank | Anchor | Role | Accuracy | Fairness | Case Count | Response Time | Badges
```

- 列头可点切换排序(默认 case_count desc)/ Header click → switch sort (default case_count desc)
- 行点击 → 跳 anchor 主页(`#u/<handle>`)/ Row click → anchor profile
- **不显示 Composite 列**(per §3)/ **NO Composite column** (per §3)

### 6.3 路由 / Route

`#governance` 公开路由(无需登录),PWA 实现 / `#governance` public route (no login), PWA implementation.

### 6.4 国际化 / i18n

双语 zh/en 1:1 — 所有标签 / banner / tooltip 走 `t()`。

Bilingual zh/en 1:1 — all labels / banners / tooltips via `t()`.

---

## §7 数据 Schema / Schema Delta

**W3.5-0 不强制 schema 改动**(决策范围内,具体表设计放 W3.5-B 实施时确定)。

**W3.5-0 does NOT mandate schema changes** (decision scope only; concrete table design deferred to W3.5-B implementation).

需要从 existing tables 算出来 / Derived from existing tables:
- `dispute_cases`(case status / arbitrator_id / outcome)
- `claim_verifications`(claim_id / verifier_id / outcome)
- `reputation_scores`(可能需扩 `judicial_accuracy` / `judicial_fairness` 子字段)/ May need to add sub-fields

**W3.5-B 实施时确认 schema**(可能新增 `governance_leaderboard_cache` 表做 nightly 物化以避免实时 aggregate 性能问题)/ Schema confirmed at W3.5-B implementation (possibly new `governance_leaderboard_cache` for nightly materialization).

---

## §8 更新频率 / Update Cadence

| 维度 / Dimension | 触发更新 / Triggered by |
|---|---|
| accuracy | case 决议 + 14d appeal window 关闭 |
| fairness | 同 accuracy(需聚合,N >= 10 才显示)|
| case_count | 实时(每 case 完成即 +1)|
| response_time | 实时(每 case 完成即重算中位数)|

**Phase A 实现**:可接受 nightly batch refresh(volume < 100 cases / day);**Phase B+** 视性能切换为 event-driven。

**Phase A implementation**: nightly batch acceptable (volume < 100 cases/day); **Phase B+** event-driven when needed.

---

## §8.5 当前实施状态 / Implementation Status (task #1080 audit, 2026-06-03)

### ✅ 已实施 / Implemented(phase A,#1080 audit)

| 项 | 状态 | 位置 |
|---|---|---|
| §6.1 顶部 banner | ✅ kind=arbitrators/verifiers 已加(reward-distribution disclaimer) | `app.js` renderLeaderboard |
| §3 无 composite score 列 | ✅ 一直无 | — |
| §4 `< 5 cases → "insufficient data"`(accuracy + fairness)| ✅ 已实施 | `app.js` arbitrator/verifier card render |
| §3 sort 单键(default `case_count desc`) | ✅ multi-key secondary sort 已移除 | `leaderboard.ts:159,175` |
| §5 PII 隐私(无 GMV / wallet / real name) | ✅ 一直遵守 | `leaderboard.ts` SELECT 字段 |
| §3 中性 metric 颜色(无 green/yellow/red 评级) | ✅ accuracy/fairness 改中性灰 | `app.js` |

### ⏳ Phase A deferred(等真数据 / 后续 PR)

| 项 | 缺什么 | 触发实施 |
|---|---|---|
| §2.1 arbitrator accuracy 维度 | 需 case overturn 信号(appeal 结果反转判决记录)| arbitrator_stats 表上线后 |
| §2.2 fairness 真公式(`evidence_balance` 项)| 需 evidence view time 记录 | evidence tracking 上线后 |
| §2.2 verifier fairness(category 一致性)| 需按 claim category 聚合 | category 字段稳定后 |
| §2.4 response_time 维度 | 需 first valid action 时间戳 | dispute timeline 完善后 |
| §4 `90d inactive` badge | 需 cron 计算 | small follow-up PR |
| §4 `suspended` badge | 需 user_moderation 集成 | small follow-up PR |
| §6.3 独立 `#governance` 路由 | 当前与 8-kind leaderboard 共用 `#leaderboard` | UX 改造 PR |
| §7 `governance_leaderboard_cache` 表 | 当前实时 aggregate(volume < 100 / day 可接受)| volume 增长后 |

→ phase A 0 用户状态下,缺失维度**无人受影响**(界面显示"暂无数据");外部 audit 看代码可见 spec gap,但有明确 deferred tracker。

---

## §9 元规则映射 / Meta-rule Mappings

- **#1 当一切可见** / Visibility:✅ 增强 — leaderboard 公开 + 公式公开 + audit log 公开
- **#3 不偷数据** / No data theft:✅ 增强 — PII 严格 redact(§5 隐私),只展示协议层 metric
- **#4 不撒谎** / No lies:✅ 增强 — 顶部 banner 显式标注"非 reward distribution",防滑坡;< sample 阈值显示 "insufficient data" 不假装精确
- **#5 不偏袒** / No favoritism:✅ 增强 — 所有 contributor 同 4 维度衡量,无身份豁免
- **#6 不滥用** / No abuse:✅ 维持 — 复合公式参数化 protocol_params,DAO 可调,founder 不能单方面权重 / Composite formula parameterized, DAO-tunable, founder cannot unilaterally weight
- **#9 算法即协议** / Algorithm = protocol:✅ 增强 — 公式公开,可机械验证,违反 → CI / community 可挑战
- **#10 参与者即 webazer** / Participant = webazer:✅ 增强 — 任何满足资格的 webazer 可成 arbitrator/verifier,公平展示
- **Iron-Rule**:✅ 维持 — arbitrate / claim_verify 仍真人 Passkey(本 spec 仅展示履职,不改 Iron-Rule)

---

## §10 References / 参考

- [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) — **父框架**,本 spec 严格在其 §4 边界内 / Parent framework, this spec strictly within its §4 boundary
- [`ECONOMIC-MODEL.md`](ECONOMIC-MODEL.md) §11 — ⚠️ **需 follow-up 对齐**:候选机制部分应改为引用 CONTRIBUTOR-REWARD-FRAMEWORK / Follow-up needed: candidate mechanism section should reference CONTRIBUTOR-REWARD-FRAMEWORK
- [`CHARTER.md`](CHARTER.md) §3 — 5-tier contributor ladder(不同维度,但相关)
- [`AGENT-GOVERNANCE.md`](AGENT-GOVERNANCE.md) — 5 指标护照(AI agent 平行系统)
- [`META-RULES-FULL.md`](META-RULES-FULL.md) — #1-#10 元规则
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) §8 — enforcement ladder(suspended 状态关联)

---

**Last reviewed**: 2026-06-01
**Status**: draft — pending @seasonkoh review
**Next**: review 后定稿;W3.5-B implementation 时落地 schema + UI
