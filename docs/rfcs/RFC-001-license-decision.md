# RFC-001: License Decision — BSL 1.1 with 2030-05-18 → MIT Auto-Transition

**Status**: ratified (retroactive — phase A founder authority,见 §3.5 phase A 豁免条款 / phase A founder authority exemption, see §3.5)
**Author**: @seasonkoh
**Created**: 2026-06-01
**Track**: meta-rule (constitutional level — locks Change Date as CHARTER §4 I-2 invariant)
**Related issue**: (n/a — phase A pre-launch, retroactive)
**Supersedes**: (n/a — first RFC)
**Superseded by**: (n/a)

---

## Summary / 摘要

WebAZ 采用 **Business Source License 1.1**(BSL 1.1),**stated Change Date 2030-05-18**(LICENSE 字段,hard ceiling)/ **effective Change Date undetermined**(repo 当前 private,BSL "first publicly available distribution" 时钟状态未定;详 §3.1.1),Change License **MIT**;Additional Use Grant 在 BSL 期间允许非商业 / 学术 / 个人 / fork-with-attribution / 文章引用,**禁止商业服务命名 + 商业 logo 使用**(走 [`licensing@webaz.xyz`](mailto:licensing@webaz.xyz) 单独授权)。

Change Date **作为宪章不变条款**([`CHARTER §4 I-2`](../CHARTER.md))锁定 — 任何方向的修改(提前 / 推迟 / 改 license)都需走 §6 修宪流程并被一致拒绝(因为修改 = 违反 invariant)。**无论 effective date 何时落定,转 MIT 不晚于 stated 2030-05-18**。

WebAZ adopts **Business Source License 1.1** with **stated Change Date 2030-05-18** (LICENSE field, hard ceiling) / **effective Change Date undetermined** (repo currently private; BSL "first publicly available distribution" clock state TBD; see §3.1.1), and Change License **MIT**. Additional Use Grant permits non-commercial / academic / personal / fork-with-attribution / citation; commercial naming + commercial logo usage require separate licensing via [`licensing@webaz.xyz`](mailto:licensing@webaz.xyz). **Regardless of effective date determination, MIT transition occurs no later than stated 2030-05-18**.

The Change Date is **locked as a charter invariant** ([`CHARTER §4 I-2`](../CHARTER.md)) — any modification (earlier, later, or different license) must pass §6 charter amendment AND would by definition violate the invariant clause.

---

## Motivation / 动机

License 的选择决定了 WebAZ 在 **brand 建立期(0-4 年)** 和 **OSI 永久开源期(2030 后)** 两个阶段的发展路径。底层取舍:

License choice determines WebAZ's path through the **brand-establishment phase (years 0-4)** vs. the **OSI-permanent-open phase (2030+)**:

| 风险 / Risk | 后果 / Consequence | License 应对 |
|---|---|---|
| **Hyperscaler 早期 fork 商业化** | AWS / Azure 等大厂在我们没建立品牌前 fork → 用规模 + 销售网络碾压 | BSL 限制商业部署 → 给 4 年窗口建社区 |
| **Enterprise 拒绝非 OSI license** | 大企业 procurement 不接受 non-OSI → 限制采用 | Change Date 硬编码 → MIT 是 OSI,enterprise 可信任未来路径 |
| **掌权方锁定 license** | 任何掌权方(founder / maintainer / 未来 DAO)反悔不开源 → community 被困 | Change Date 在 CHARTER §4 I-2 invariant → **任何角色都不能改** |
| **AGPL viral 杀 enterprise** | AGPL 一引入,任何用 WebAZ 的网络服务必须开源 → 商业 user 不敢碰 | 不用 AGPL |

→ BSL 1.1 + 2030 MIT 是**双阶段最优解**:**短期阻止 fork 商业化,长期保证无条件开源**。
→ BSL 1.1 + 2030 MIT is the **dual-phase optimum**: short-term anti-fork-commercialization, long-term unconditional open source.

---

## Design / 设计

### 3.1 BSL 1.1 主文本 / Base text

[`LICENSE`](../../LICENSE) 采用 BSL 1.1 标准模板(MariaDB plc 原作,CC-BY-SA-3.0)+ WebAZ 填空:

| BSL 字段 / Field | WebAZ 值 / Value |
|---|---|
| **Licensor** | WebAZ Pte Ltd / @seasonkoh (phase A solo) |
| **Licensed Work** | WebAZ Protocol (this repository) |
| **Additional Use Grant** | 非商业 / 学术 / 教学 / 个人 / fork-with-attribution / 文章引用(见 [`BRAND-GUIDE §2`](../BRAND-GUIDE.md))/ Non-commercial / academic / teaching / personal / fork-with-attribution / citation (see [`BRAND-GUIDE §2`](../BRAND-GUIDE.md)) |
| **Change Date** | **2030-05-18**(由 Licensor 在 LICENSE 中**手动设定**;实际生效日见 §3.1.1 "whichever comes first" 条款)/ **2030-05-18** (**manually set** by Licensor in LICENSE; effective date subject to §3.1.1 "whichever comes first" clause) |
| **Change License** | **MIT** |

#### 3.1.1 BSL "whichever comes first" 条款 + 公私库时间线 / Whichever-First Clause + Public/Private Timeline

BSL 1.1 标准条款规定 license 实际转换发生于:**stated Change Date** 或 **首次公开发布日 (under this License) + 4 年**,**以先到者为准**。

BSL 1.1: license transition occurs on **stated Change Date** OR **4 years after first publicly available distribution under this License**, **whichever comes first**.

**WebAZ 公私库时间线 / WebAZ public/private timeline**(诚实披露 honest disclosure):

| 阶段 / Stage | 状态 / Status | 来源 / Source |
|---|---|---|
| 早期公开期 / Early public period | repo public(无 LICENSE / no LICENSE)| GitHub repo history,具体首日 TBD / exact start TBD |
| 2026-05-14 | LICENSE 首次 commit `8f512da` + 同日 repo 转 private(两个事件相对顺序未在 git 元数据中保留)/ LICENSE first commit + repo went private same day (event ordering not preserved) | 创始人陈述 / founder statement |
| 2026-05-14 至今 / through today | private(LICENSE 不持续公开可用)/ private (LICENSE not sustainably publicly available) | gh api verify 2026-06-01 |
| 预期公开重新发布 / Projected re-public launch | W8 launch(具体日期 TBD)/ W8 launch (date TBD) | 内部 roadmap / internal roadmap |

**BSL 时钟当前状态:undetermined** / **BSL clock state: undetermined**

repo 现在 private,LICENSE 未持续公开可用 → **BSL 严格意义的 "first publicly available distribution under this License" 未明确发生**。2026-05-14 当天 LICENSE commit 与 visibility-private 翻转共发生,**是否存在数小时公开窗口构成 "publicly available distribution" 是法律问题**。

The clock is **undetermined**: repo is private, LICENSE is not sustainably publicly available, so the BSL "first publicly available distribution" has not unambiguously occurred. On 2026-05-14, LICENSE commit and visibility-private flip happened the same day; **whether a brief public window (if any) qualifies is a legal question**.

**两种解释 / Two interpretations**:

| 解释 / Interpretation | effective Change Date |
|---|---|
| **严格** / Strict — 需 LICENSE 持续公开可用 / requires sustained public LICENSE availability | **W8 re-launch + 4 yr**(capped at stated 2030-05-18)/ W8 re-launch + 4 yr (capped at 2030-05-18) |
| **宽松** / Lenient — 任意公开瞬间满足 / any moment of public availability suffices | **2030-05-14**(2026-05-14 + 4 yr,提前 4 天 vs stated)/ 2030-05-14 (4 days earlier than stated) |

**Phase A 立场 / Phase A position**:采用**严格解释**(更诚实于 BSL 立法精神,公私库切换让"持续可用"语义模糊,严格解释避免争议)。

We adopt the **strict interpretation** (more faithful to BSL's legislative intent; private-public switching muddies "sustained availability" so strict interpretation avoids dispute).

→ **不变事实 / Invariant**:无论哪种解释胜出,**license 转 MIT 不会晚于 stated 2030-05-18**(LICENSE 字段值,CHARTER §4 I-2 invariant 锁定)。任何延后均违反 invariant。
→ **Invariant**: Regardless of which interpretation prevails, **license auto-MITs no later than stated 2030-05-18** (LICENSE field, locked by CHARTER §4 I-2 invariant). Any postponement violates the invariant.

→ **法律层 / Legal**:建议律所在 W8 re-launch 前确认严格 vs 宽松解释定性;phase A pre-launch 阶段无 user 受影响,确认窗口充裕。**正式 enforcement 时以律所意见为准**。
→ **Legal**: legal counsel should confirm strict vs lenient interpretation before W8 re-launch; phase A pre-launch has no affected users, ample time. **Legal counsel opinion controls at enforcement time**.

### 3.2 锁定为 CHARTER 不变条款 / Locked as charter invariant

[`CHARTER §4 I-2`](../CHARTER.md) 明确:**Change Date 与 Change License 一旦确定,不可更改**(包括 founder)。修改尝试自动失败,因为 §4 invariants 比 §6 修宪流程更高一级。

[`CHARTER §4 I-2`](../CHARTER.md) explicitly states: **Change Date and Change License, once set, cannot be modified** (including by founder). Modification attempts auto-fail because §4 invariants are hierarchically above §6 amendment process.

→ 这是 WebAZ "**协议大于人**" 原则在 license 层的落地;founder 也不能反悔。
→ This is WebAZ's "**protocol over person**" principle at the license layer; founder cannot rescind.

### 3.3 DCO + License 演化兼容性 / DCO + license evolution compatibility

contributor sign-off(DCO 1.1)**跟随 license 演化**保持有效(详 [`DCO.md`](../DCO.md) §"DCO + License 演化兼容性"):

Contributor DCO 1.1 sign-off **remains valid across license evolution** (per [`DCO.md`](../DCO.md) §"DCO + License Evolution Compatibility"):

| 阶段 / Stage | License | Sign-off 仍有效? / Sign-off valid? |
|---|---|---|
| LICENSE 存在期至 Change Date(BSL 1.1 期,起算见 §3.1.1)/ LICENSE existence to Change Date (BSL 1.1 period, see §3.1.1 for start) | BSL 1.1 | ✓ |
| Change Date 后 MIT 期 / Post-Change-Date MIT period | MIT | ✓(MIT 比 BSL 更宽松,DCO 条款 a/b/c/d 在更宽松 license 下自动满足)/ ✓ (MIT is more permissive than BSL; DCO a/b/c/d auto-satisfied) |

→ 一次 DCO sign-off,跨整个 license 演化生效。无需重签。
→ One DCO sign-off, valid through entire license evolution. No re-sign required.

### 3.4 依赖 license 双层 check / Dep license double-layer

[`dep-license-policy.md`](../../.github/dep-license-policy.md) 定义依赖 license 必须**同时**与:

[`dep-license-policy.md`](../../.github/dep-license-policy.md) requires deps to be compatible **simultaneously** with:

- 当前 BSL 1.1 期(2026-2030)
- Change Date 后 MIT 期(2030+)

→ 红区(GPL / AGPL / SSPL)永远 PR reject;白名单(MIT / BSD / Apache / ISC / 0BSD / MPL / CC0)永远绿灯。
→ Red zone (GPL / AGPL / SSPL) auto-rejected; whitelist (MIT / BSD / Apache / ISC / 0BSD / MPL / CC0) auto-allowed.

### 3.5 Phase A 豁免条款 / Phase A Exemption Clause

**正常 meta-rule track 要求 60d 公示 + 多签**(见 [`CHARTER §6`](../CHARTER.md) 修宪流程 + [`docs/rfcs/README.md`](README.md) Lifecycle)。本 RFC-001 **直接 ratified 未走 60d 公示**,依据如下豁免:

The **normal meta-rule track requires 60d public notice + multisig** (see [`CHARTER §6`](../CHARTER.md) amendment process + [`docs/rfcs/README.md`](README.md) Lifecycle). RFC-001 **was ratified directly without 60d public notice**, under the following exemption:

| 条件 / Condition | 当前满足? / Met? |
|---|---|
| Phase A solo founder(无第二签名方)/ Phase A solo founder (no second signer) | ✅ |
| 决策已在 phase A 起 implemented(LICENSE / CHARTER §4 / DCO / dep-policy)/ Decision already implemented since phase A inception | ✅ |
| 锁定方向**只能更严**(invariant lock,不可松绑)/ Lock direction is **only stricter** (invariant, cannot loosen) | ✅ |
| 公开披露此豁免**不构成先例** / Public disclosure that this exemption is **not a precedent** | ✅ 见下 / see below |

**⚠️ 不构成先例 / NOT a precedent**:

- phase A 唯一性产物:无第二 maintainer 可签,故 60d 公示无第二人参与意义 / Phase-A artifact: no second maintainer exists to sign, so 60d public notice has no second party
- **phase B+(≥ 2 maintainer)起,所有 meta-rule track RFC 强制走 60d 公示 + 多签,无 founder 豁免** / **Phase B+ (≥ 2 maintainers): all meta-rule RFCs must follow 60d notice + multisig, no founder exemption**
- 任何未来 RFC 引用 "RFC-001 也是 founder 拍的" 作豁免依据 = **直接 reject**(对应 [`META-RULES-FULL.md`](../META-RULES-FULL.md) #5 不偏袒 + #6 不滥用)/ Any future RFC citing "RFC-001 was founder-ratified" as justification = **direct reject** (per [`META-RULES-FULL.md`](../META-RULES-FULL.md) #5 + #6)

→ 这条豁免本身是 #4 不撒谎的应用:**透明披露**例外情况比假装走完流程更诚实。
→ This exemption itself is an application of #4 (no lies): **transparent disclosure of the exception** is more honest than faking process compliance.

---

## Meta-rule impact / 元规则影响

- **#1 当一切可见 / Visibility**: ✅ 增强 — license 文本公开,Change Date 公开,Additional Use Grant 公开,RFC 公开记录决策过程
- **#2 代码即规则 / Code = rule**: ✅ 增强 — LICENSE 在 repo 根目录,生效自动,无需另外宣告
- **#3 不偷数据 / No data theft**: n/a — license 是法律层,与数据无关
- **#4 不撒谎 / No lies**: ✅ 增强 — Change Date 硬编码不是"将会"是"已是";本 RFC 显式声明 founder 也不能改(防"以后再改"的隐性承诺)
- **#5 不偏袒 / No favoritism**: ✅ 增强 — 所有 user / contributor / fork 同样 license 条款;商业 licensing 单独走 [`licensing@webaz.xyz`](mailto:licensing@webaz.xyz)(透明价格 / 标准合同)
- **#6 不滥用 / No abuse**: ✅ 增强 — CHARTER §4 I-2 invariant 让 founder 无法用 license 控制 community;2030 后自动放手
- **#7 不操纵 / No manipulation**: n/a — license 不涉及操纵
- **#8 最小介入 / Minimal intervention**: ✅ 维持 — license 是法律层 enforce,非协议层 hardcode 介入
- **#9 算法即协议 / Algorithm = protocol**: ✅ 增强 — Change Date 虽不在 `protocol_params`(法律绑定,非 runtime tunable),但通过 CI invariant check(规划中 `scripts/license-invariant-check.ts`,见 §8 Test plan)**机械 enforce** LICENSE / CHARTER / DCO 三处日期一致,违反即 CI 红 → 等价于"算法保证 license 承诺不被偷改",这正是 #9 在法律层的落地 / ✅ enhanced — Change Date is not in `protocol_params` (legally bound, not runtime-tunable), but **mechanically enforced** via planned CI invariant check (see §8) that verifies date consistency across LICENSE / CHARTER / DCO; violation = CI red. This is "algorithm guarantees license commitment can't be silently mutated" — the legal-layer manifestation of #9
- **#10 参与者即 webazer / Participant = webazer**: ✅ 增强 — 2030 后任何 webazer 可自由 fork / 改 / redistribute(MIT)
- **Iron-Rule 技术边界**: n/a — license 是文档层,不触碰 Iron-Rule 7 路径

---

## Alternatives / 替代方案

### Alt 1: MIT / Apache-2.0 day-one

**理由 / Rationale**: 经典 permissive 开源,OSI 直接认可,enterprise procurement 友好,社区采用门槛 0。
**为何不选 / Rejected because**: phase 0-4 年 hyperscaler 风险 — AWS / Azure / GCP 可直接 fork → 用销售网络 + 规模优势碾压;WebAZ 还没建社区/品牌 → 死亡螺旋。MIT 在 mature project(Linux / Postgres)上 OK,在 **brand-establishment phase** 上是自杀。

### Alt 2: AGPL-3.0

**理由 / Rationale**: viral copyleft,任何网络服务用 AGPL 库必须开源 → 阻止 hyperscaler 闭源 fork。
**为何不选 / Rejected because**: enterprise 全线 reject(法律 review 风险太高,Google / Microsoft / Apple 公司政策禁止接 AGPL);WebAZ 的 agent-native 定位需要 enterprise agent 自由接入 → AGPL 直接断这条路。

### Alt 3: BSL + Apache-2.0 Change License

**理由 / Rationale**: 跟 Alt 4(MIT)路径相同,但 Apache 带专利 grant + 更强 attribution。
**为何不选 / Rejected because**: 2030 后的 WebAZ 应是 "**maximally simple to use**" 状态;Apache 的 NOTICE retention / patent termination clause / explicit grant 在 mature 阶段是 friction,MIT 在那个阶段简洁优先。BSL 期间的专利 grant 由 BSL 1.1 base + Additional Use Grant 已覆盖。

### Alt 4: BSL + 更长 Change Date(例如 5-6 年)

**理由 / Rationale**: 多 1-2 年 brand-establishment 时间。
**为何不选 / Rejected because**: **4 年是 BSL 业界惯例**(MariaDB / Sentry / CockroachDB 等多家采用 4 年作为 stated Change Date);拖长降低 community trust("会不会一直拖?会不会再延一次?")。WebAZ 选 2030-05-18 stated Change Date 作为 **hard ceiling**;BSL "fourth-anniversary whichever comes first" 条款让真实 effective date 可能更早(详 §3.1.1) — **承诺密度最高**(stated 不能拉长,任何 effective 日只能更早或等于 stated)。

### Alt 5: Custom license

**理由 / Rationale**: 完全按 WebAZ 需求定制条款。
**为何不选 / Rejected because**: 法律 review 风险(BSL 经 multiple 大公司 audit + MariaDB plc 起草,custom license 没人 audit);user / enterprise 看不懂 → 采用门槛飙升。**用经过 audit 的标准 license 是 #4 不撒谎 + #8 最小介入的 license-层应用**。

---

## Migration & compatibility / 迁移与兼容

### 现状(2026-06-01)

- LICENSE 文件已存在 BSL 1.1 模板,Change Date 字段 = 2030-05-18(stated 上限;effective 日见 §3.1.1)
- NOTICE 文件已有 Additional Use Grant 摘要 + 商业咨询联系
- CHARTER §4 I-2 已锁定 invariant
- DCO.md / dep-license-policy.md / BRAND-GUIDE / CODE_OF_CONDUCT / RFC-001 本身全部对齐
- → **本 RFC 不需要任何文件修改,仅作为决策的正式记录**

### Change Date 当日(effective TBD per §3.1.1 / stated cutoff 2030-05-18)/ On Change Date (effective TBD per §3.1.1 / stated cutoff 2030-05-18)

- LICENSE 自动**法律生效**为 MIT(BSL 1.1 第 4 条机制 + "whichever comes first" 取早者)
- 任何在 Change Date 前的 commit / fork / use 仍受 BSL 1.1 约束(对当时的状态)/ Commits / forks / uses **before** Change Date remain bound by BSL 1.1 (as-of state)
- Change Date 后的任何 commit / fork / use 受 MIT 约束 / Commits / forks / uses **after** Change Date are governed by MIT
- **不需要任何 PR / 改 LICENSE 文件**(BSL 1.1 自带转换机制)/ No PR or LICENSE edit needed (BSL self-transitions)
- 建议届时:加一行 NOTICE 标注"Change Date reached on YYYY-MM-DD, license now MIT"(冗余 documentation,法律不需要)/ Recommend NOTICE annotation at that time (redundant documentation, not legally required)

### Compatibility with existing forks / 已有 fork 兼容性

**Change Date 字段由原始 Licensor(WebAZ Pte Ltd / @seasonkoh)在 LICENSE 中设定**;fork 者**无权修改基于 WebAZ release 部分的 Change Date 字段** — 那会构成对原始 BSL grant 的违反(BSL 标准条款:"Not to modify this License in any other way")。

The **Change Date is set by the original Licensor (WebAZ Pte Ltd / @seasonkoh) in LICENSE**; forks **may not alter the Change Date field for the WebAZ-derived portion** — doing so violates the original BSL grant (BSL standard text: "Not to modify this License in any other way").

具体行为 / Specific behaviors:

- **BSL 1.1 期间 fork 的 WebAZ 代码**:继续受 **原始 Licensor 设定的 Change Date** 约束直到该日期 / **Forks of WebAZ during BSL period**: bound by **original Licensor's Change Date** until that date
- **fork 者新增的代码**(non-WebAZ-derived):fork 者可另选 license(MIT / Apache / 等),与 WebAZ 代码不冲突 / **Fork's own new code** (non-WebAZ-derived): fork can pick any license, no conflict with WebAZ portion
- **Change Date 后**:任何人(包括 fork)使用 BSL 期 WebAZ source 自动获得 MIT 权利 / **After Change Date**: anyone (including forks) using BSL-period WebAZ source auto-gains MIT rights
- BSL 设计核心:**所有 WebAZ-derived 代码共享同一个 Change Date**(由 Licensor 设定,不可被 fork 单方面延后)/ BSL design core: **all WebAZ-derived code shares the same Change Date** (set by Licensor, cannot be unilaterally postponed by forks)

> ⚠️ **法律层细节**:本段表述基于 BSL 1.1 标准文本理解;若 fork 出现复杂情况(嵌套 fork / 重写部分声称 non-derivative / 跨辖区 enforcement),**建议律所确认**。phase A pre-launch 阶段尚无真实 fork case,此段为前瞻性指引,**正式 enforcement 时以律所意见为准**。
> ⚠️ **Legal nuance**: This section's reading is based on BSL 1.1 standard text; complex fork cases (nested forks / rewritten portions claimed non-derivative / cross-jurisdiction enforcement) **should be confirmed with legal counsel**. As phase A pre-launch has no real fork cases yet, this is forward-looking guidance; **legal counsel opinion controls at enforcement time**.

---

## Risks / 风险

| 风险 / Risk | 概率 / Likelihood | 影响 / Impact | 缓解 / Mitigation |
|---|---|---|---|
| BSL 不被 OSI 认可,某些 package registry / aggregator flag | 高(已发生于其他 BSL 项目)| 中(SEO / 发现性受影响) | 在 README + NOTICE 显式说明 Change Date,链 RFC-001 解释 |
| Enterprise procurement 拒绝 non-OSI | 中 | 中-高(限制 phase A 采用) | Additional Use Grant 允许大部分非商业用法;BSL 1.1 已有 MariaDB / Sentry 等先例,法律可援引 |
| BSL "commercial use" 边界模糊 | 中 | 低-中(case-by-case 咨询)| Additional Use Grant 列正例;模糊场景走 `licensing@webaz.xyz` 个案咨询,响应记入 audit log |
| Change Date 后某些 hyperscaler 立刻 fork | 高(2030 后必然发生)| 低(那时品牌 + 社区已建立)| 4 年是 brand-establishment 窗口,2030 后 fork 是健康现象 |
| Founder 私下"非正式承诺"延期 Change Date | 低(CHARTER §4 I-2 invariant)| 严重(若发生,违反 #4 + #6)| 本 RFC 显式声明 invariant,任何延期尝试 = 公开违反元规则 → community fork 兜底 |
| Change Date 当日(effective TBD per §3.1.1 / stated cutoff 2030-05-18)发生不可预见的法律变化 | 极低 | 高 | **优先维持 invariant 精神(无条件开源承诺);若法律强制冲突,走 CHARTER §6 紧急流程 + 公开披露,在合法框架内寻找最接近原承诺的方案。承诺受所在辖区法律约束 — 不承诺"违法守约",承诺"尽最大努力守约"。** / **Prioritize the invariant's spirit (unconditional open-source commitment); if law mandates a conflict, invoke CHARTER §6 emergency process + public disclosure, seek the closest-to-original solution within legal framework. Commitment is subject to jurisdiction law — we do NOT pledge "lawbreaking compliance"; we pledge "best-effort compliance".** |

---

## Test plan / 测试计划

License 决策不是 runtime 代码,但有以下**可验证 invariant**:

License decision is not runtime code, but the following invariants are **independently verifiable**:

- [x] `grep -E "Change Date.*2030-05-18" LICENSE` returns exactly 1 match — verified 2026-06-01 ✓
- [x] `grep -E "Change License.*MIT" LICENSE` returns exactly 1 match — verified 2026-06-01 ✓
- [x] CHARTER §4 I-2 中 Change Date 数字与 LICENSE 一致(机械可验)— verified 2026-06-01,见 CHARTER L181 ✓ / CHARTER §4 I-2 Change Date matches LICENSE (verified, L181)
- [x] DCO.md §"License Evolution Compatibility" 4 row table 中所有 BSL/MIT 引用与本 RFC §3.3 一致 — verified 2026-06-01 ✓
- [x] `licensing@webaz.xyz` 邮件转发可达(Cloudflare Email Routing alias verified 2026-06-01)— verified ✓
- [x] dep-license-policy.md 白名单含 MIT (post-Change-Date 兼容);BSL 期间通过 Additional Use Grant 单独走 — verified 2026-06-01 ✓
- [ ] CI script `scripts/license-invariant-check.ts` 自动 enforce 上 6 项 — **未实现**,规划 W4+ / **Not yet implemented**, planned for W4+

→ 上述 6 项全部**人工 verify 通过**(2026-06-01);自动化(CI script)是 §4 #9 "算法即协议"的最终实现,planned W4+。
→ All 6 above **manually verified passing** (2026-06-01); automation (CI script) is the final implementation of §4 #9 "algorithm = protocol", planned W4+.

---

## Pre-flight checklist / 提交前自查

- [x] 我已读 [`CHARTER.md §6`](../CHARTER.md) (修改流程)和 [`§3.2`](../CHARTER.md) (多签矩阵)
- [x] 我已对照 [`META-RULES-FULL.md`](../META-RULES-FULL.md) 全部 10 条,不只是表面相关的
- [x] 我理解【绕过 ≠ 修改】 Iron-Rule — 本 RFC 不通过技术手段绕过 Iron-Rule 的 7 条真人 Passkey 路径(license 是文档层)
- [x] 本 RFC 锁定 CHARTER §4 I-2 invariant,选了 "meta-rule" track(constitutional 级)
- [x] 至少列了 2 个替代方案并说明为什么不选(实际列了 5 个)

---

## Implementation tracking / 实现追踪

本 RFC 是**追溯式正式化**(retroactive ratification),决策本身已在 phase A 启动时通过 LICENSE / NOTICE / CHARTER 在 repo 中实现。

This RFC is a **retroactive ratification** — the decision was implemented at phase A inception via LICENSE / NOTICE / CHARTER.

**关联 commits / Related commits**(本 RFC 之前已存在):

- LICENSE 首次提交 — BSL 1.1 模板 + Change Date + Change License
- CHARTER §4 invariants 段(锁定 I-2)
- DCO.md(W3 batch 3 第 1 文件)— DCO + License Evolution 表
- dep-license-policy.md(W3 batch 3 第 2 文件)— BSL/MIT 双层兼容矩阵
- BRAND-GUIDE §2 / §9(W1 + W3 batch 3 P1)— Additional Use Grant + fork sovereignty
- CODE_OF_CONDUCT.md(W3 batch 3 第 4 文件)— 商业 licensing 引用 [`licensing@webaz.xyz`](mailto:licensing@webaz.xyz)

- **PR**: (n/a — direct commit per phase A founder authority)
- **Commit**: 本 RFC 文件本身 / This RFC file itself
- **Closes issue**: (n/a — retroactive)

---

## Status history / 状态变更

- **2026-05-14**: LICENSE 首次写入 repo,commit `8f512da`(`chore: 项目开放贡献基础`);**同日 repo 由 public 切换为 private**(两个事件相对顺序未保留)。BSL 1.1 + stated Change Date 2030-05-18 + MIT 决策实施;**effective 起算时钟当前 undetermined**(详 §3.1.1)/ LICENSE first written + repo went private same day; BSL 1.1 + stated 2030-05-18 + MIT decision implemented; **effective clock currently undetermined** (see §3.1.1)
- 2026-05-30~31: CHARTER §4 invariants 段写入,I-2 锁定 license 演化 / CHARTER §4 invariants written, I-2 locks license evolution
- 2026-06-01: 本 RFC 起草,作为追溯式正式化(retroactive ratification);6 项 test plan invariant 人工 verify 全过 / This RFC drafted as retroactive ratification; 6 test-plan invariants manually verified
- 2026-06-01: **ratified**(phase A founder authority,见 §3.5 豁免条款 — **不构成先例**)/ **ratified** (phase A founder authority per §3.5 — **NOT a precedent**)
- **W8 re-launch + 4 yr**(预期 effective Change Date,严格解释下;TBD pending W8 date)/ **W8 re-launch + 4 yr** (projected effective Change Date under strict interpretation; TBD pending W8 date): 若严格解释胜出,license 自动转 MIT / If strict interpretation prevails, license auto-MITs
- **2030-05-18**(stated Change Date,hard ceiling / hard ceiling): 无论 effective 解释怎么落定,本日是 license 转 MIT 的**绝对上限**(CHARTER §4 I-2 invariant 锁定)/ Regardless of effective interpretation, this is the **absolute upper bound** for MIT transition (locked by CHARTER §4 I-2 invariant)
