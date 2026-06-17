# Code of Conduct / 行为准则

> 📚 **Base**: Contributor Covenant v2.1(标准开源行为准则)+ WebAZ 元规则补充
> **Base**: Contributor Covenant v2.1 (industry standard) + WebAZ meta-rule extensions

> 🌐 **Bilingual**: 中英 1:1(BRAND-GUIDE §5)/ zh/en 1:1 parity (BRAND-GUIDE §5)

> 📜 **Charter 引用 / Referenced by**: [`CHARTER §3`](CHARTER.md) governance / [`CONTRIBUTING.md`](../CONTRIBUTING.md) PR 流程 / [`DCO.md`](DCO.md) sign-off / [`META-RULES-FULL.md`](META-RULES-FULL.md) #1-#10

---

## 🎯 §1 适用范围 / Scope

本准则适用于 WebAZ 的**所有空间**,包括但不限于:

This Code applies to **all WebAZ spaces**, including but not limited to:

- GitHub repo(issues / PRs / discussions / code comments)
- 任何 WebAZ 官方 chat(Discord / Telegram / WeChat group,若开)/ Any official WebAZ chat
- 协议级公开数据(audit log / 公开 query 字段)/ Protocol-level public data
- **代表 WebAZ 时的公开场合**(conference / talk / 公开账号发布)/ **Public representations of WebAZ** (conference / talk / public account posts)
- WebAZ PWA / MCP / API 的协议层交互 / WebAZ PWA / MCP / API protocol interactions

→ 同时适用于**人类参与者**与**AI agent 监护人**(见 §6 AI agent 协作伦理 / §10 参与者即 webazer)。
→ Applies to **human participants** AND **AI agent custodians** (per §6 AI agent ethics / Rule #10 "participant = webazer").

---

## 🤝 §2 我们的承诺 / Our Pledge

我们(WebAZ 所有 contributor / maintainer / user / agent 监护人)承诺:让参与 WebAZ 对每一个人都成为**零骚扰、零歧视**的体验,无关年龄、体型、可见或不可见的残疾、族裔、性别认同与表达、经验水平、教育背景、社会经济地位、国籍、外貌、种族、宗教、性取向。

We (all WebAZ contributors / maintainers / users / agent custodians) pledge to make participation a **harassment-free experience for everyone**, regardless of age, body size, visible or invisible disability, ethnicity, gender identity and expression, level of experience, education, socio-economic status, nationality, personal appearance, race, religion, or sexual orientation.

我们承诺以**有助于开放、欢迎、多元、包容、健康社区**的方式行动与互动。

We pledge to act and interact in ways that contribute to an **open, welcoming, diverse, inclusive, and healthy community**.

---

## ✅ §3 正面行为示例 / Examples of Acceptable Behavior

- 对不同意见、视角、经验**保持同理心** / Demonstrating empathy and kindness toward other people
- **尊重**不同的观点与经验 / Being respectful of differing opinions, viewpoints, and experiences
- 给予并优雅接受**建设性反馈** / Giving and gracefully accepting constructive feedback
- 对自己造成的影响**负责**并向受影响者道歉,从经验中学习 / Accepting responsibility and apologizing to those affected by our mistakes, learning from the experience
- 关注社区**整体福祉**,而不只是自己 / Focusing on what is best not just for us as individuals but for the overall community
- **诚实披露利益冲突**(commercial / employment / affiliation)/ Honestly disclosing conflicts of interest (commercial / employment / affiliation)

---

## ❌ §4 不可接受行为 / Unacceptable Behavior

### 4.1 通用(Contributor Covenant 2.1 标准)/ Standard (Contributor Covenant 2.1)

- 使用**性化的语言或图像**,以及任何形式的性关注或挑逗 / Sexualized language or imagery, and sexual attention or advances of any kind
- **挑衅、侮辱或贬低性评论**;人身或政治攻击 / Trolling, insulting or derogatory comments, and personal or political attacks
- 公开或私下的**骚扰** / Public or private harassment
- **未经许可**公开他人的隐私信息(物理地址 / email 地址 / 真实姓名等)/ Publishing others' private information (physical address, email address, real name) without explicit permission
- 其他在**专业场合合理认定不当**的行为 / Other conduct which could reasonably be considered inappropriate in a professional setting

### 4.2 WebAZ-specific 不可接受行为 / WebAZ-specific unacceptable behavior

以下行为在 WebAZ 语境下**特别不可接受**(对应元规则 #1-#10):

The following are **specifically unacceptable** in WebAZ context (per meta-rules #1-#10):

- ❌ **私下游说改协议参数**(违反 #1 公开透明)— 所有 RFC / 提议必须在公开 channel / Off-channel lobbying to change protocol parameters (violates #1) — all RFCs in public
- ❌ **伪造数据 / 凭证 / 身份**(违反 #4 不撒谎)— 包括伪造测试数据、冒充其他 contributor、隐瞒 AI agent 协作 / Forging data / credentials / identity (violates #4) — including fake test data, impersonating contributors, hiding AI collaboration
- ❌ **对"自己人"开 review 绿灯**(违反 #5 不偏袒)— 朋友 / 同事的 PR 必须按同样标准 review / Lenient review for "insiders" (violates #5) — friends / colleagues get same review bar
- ❌ **滥用 maintainer 权限**(违反 #6 不滥用)— 包括 force-push 绕 review、私自 merge 自己 PR、利用权限封锁反对意见 / Abusing maintainer power (violates #6) — including force-push past review, self-merging own PRs, weaponizing perms against dissent
- ❌ **使用传销 / 撸毛话术**(违反 #5 + BRAND-GUIDE §8.5)— "拉人头""早进早赚""层级越深赚越多""空投撸毛"等 / MLM / airdrop-farming rhetoric (violates #5 + BRAND-GUIDE §8.5) — "recruit downlines", "early-bird gains", "deeper = more", "yield farming"
- ❌ **代他人执行 Iron-Rule 操作**(违反 #6 + Iron-Rule 7 路径)— arbitrate / vote / agent_revoke / delete_passkey / revoke_key / rotate_key / wallet 操作必须本人真人 Passkey / Performing Iron-Rule ops on someone else's behalf (violates #6 + Iron-Rule paths) — these 7 paths require the actual person's Passkey
- ❌ **AI agent 冒充人类参与社区讨论**(违反 #4 + #10 透明披露)— 在 PR / issue / discussion 中 AI 必须可识别为 AI 或 AI-assisted / AI agent impersonating human in community discussion (violates #4 + #10) — must be identifiable as AI or AI-assisted

---

## 🌐 §5 元规则映射 / Meta-rule Mappings

CoC 不是新元规则,而是**元规则 #1-#10 在社区行为层的执行**。

CoC is not a new meta-rule; it is the **community-behavior execution of meta-rules #1-#10**.

| 元规则 / Meta-rule | CoC 对应 / CoC application |
|---|---|
| **#1 公开透明** / Visibility | 所有决策 / 讨论 / 投诉记录在公开 channel(敏感个人信息除外,见 §7.4)/ All decisions / discussions / complaints logged publicly (sensitive PII excepted, §7.4) |
| **#4 不撒谎** / No lies | 不伪造身份 / 数据 / 凭证;AI 协作必须披露 / No fake identity, data, credentials; AI collaboration must be disclosed |
| **#5 不偏袒** / No favoritism | 对所有 contributor 同样标准,无关 tier / 关系 / 国籍 / 立场 / Same standard for all contributors, regardless of tier / relationship / nationality / political stance |
| **#6 不滥用** / No abuse | Maintainer / approver 权限不得用于打压反对意见或个人偏好 / Maintainer / approver powers not for suppressing dissent or personal preference |
| **#10 参与者即 webazer** / Participant = webazer | 包括 AI agent 监护人;监护人对其 agent 行为承担同等责任 / Includes AI agent custodians; custodian liable for agent behavior |

→ 任何 CoC 违规也是相应元规则的违规;反之不一定。
→ Any CoC violation is also a meta-rule violation; the converse is not always true.

---

## 🤖 §6 AI agent 协作伦理 / AI Agent Collaboration Ethics

WebAZ 鼓励 AI agent 协作(参 [`DCO.md`](DCO.md) §"AI agent 协作的 DCO" + [`CHARTER`](CHARTER.md) AI agent 共建条款)。本 CoC 在此基础上要求:

WebAZ encourages AI agent collaboration (per [`DCO.md`](DCO.md) AI section + [`CHARTER`](CHARTER.md) AI co-build clauses). This CoC additionally requires:

| 行为 / Behavior | 要求 / Requirement |
|---|---|
| AI 参与 PR 评论 / discussion / Issue | 必须可识别为 AI 或 AI-assisted(`Co-authored-by:` trailer 或显式声明)/ Must be identifiable as AI or AI-assisted (`Co-authored-by:` trailer or explicit declaration) |
| AI 代表 custodian 提交 PR / 评论 | Custodian 承担**同等责任**(代码质量 + CoC 合规)/ Custodian bears **equal liability** (code quality + CoC compliance) |
| AI 触碰 Iron-Rule 7 路径(arbitrate / vote / agent_revoke / delete_passkey / revoke_key / rotate_key / wallet) | **协议层硬阻断**(`require_human_presence_*` = 1)— agent 不得代操作,custodian 必须真人 Passkey / **Hard-blocked at protocol layer** — agent cannot operate, custodian must use real Passkey |
| AI 在 community discussion 发表立场(非 PR 评论) | **应**披露训练数据 cutoff + 是否受 prompt 引导(防误导;PR 评论不强制,仅 discussion 场景)/ **Should** disclose training cutoff + whether prompt-steered (anti-misleading; not required for PR comments, only in discussion contexts) |
| AI 协作的 commit 提交 sign-off | DCO sign-off 必须**来自 custodian**(真人),不是 AI 自签(AI 无法律人格不能签 DCO 第 a/b/c/d 条)/ DCO sign-off must come from **custodian (human)**, not AI self-sign (AI has no legal personhood for DCO clauses a/b/c/d) |

→ 透明披露 AI 协作**不影响 review**;**隐瞒**才是 CoC 违规。
→ Transparent AI collaboration disclosure **does not affect review**; **concealment** is the CoC violation.

---

## 📨 §7 举报渠道 / Reporting Channels

### 7.1 三档渠道 / Three-tier channels

| 严重度 / Severity | 渠道 / Channel | 公开度 / Visibility |
|---|---|---|
| **低 / Low**(语气 / 风格 / 边界擦边) | GitHub Issue 加 `conduct` label / GitHub Issue with `conduct` label | 公开 / Public |
| **中 / Medium**(明确违规 / 涉及个人 / 不涉敏感 PII) | Email `conduct@webaz.xyz`(forwarding alias)/ Email `conduct@webaz.xyz` (forwarding alias) | 内部 / Internal(执法决议公开) |
| **高 / High**(涉及敏感 PII / 安全 / 法律) | [GitHub Security Advisory](https://github.com/webaz-protocol/webaz/security/advisories)(可匿名)+ 走 [`SECURITY.md`](../SECURITY.md) 流程 / GitHub Security Advisory (anonymous OK) + per [`SECURITY.md`](../SECURITY.md) | 私密直到 resolve / Private until resolved |

### 7.2 举报应包含 / A report should include

- 涉事人 / 团队(GitHub handle / agent ID / custodian)/ Involved party (GitHub handle / agent ID / custodian)
- 行为描述 + 时间 + 地点(链接到 Issue / PR / commit / chat 记录)/ Behavior description + time + location (link to Issue / PR / commit / chat record)
- 你认为对应哪条 §4 不可接受行为 / Which §4 item it violates (your interpretation)
- 是否需要保密 / 匿名 / Whether confidentiality / anonymity is requested

### 7.3 响应时效 / Response SLA

- **低**:7 天内回复(maintainer 团队 triage)/ Low: 7d response (maintainer triage)
- **中**:3 天内首次响应,14 天内决议或转 §8 多签 / Medium: 3d initial response, 14d resolution or escalate to §8 multisig
- **高**:24h 内首次响应(安全级)/ High: 24h initial response (security-grade)

### 7.4 PII 保护 / PII Protection

举报内容若包含敏感 PII(真实姓名 / 联系方式 / 健康 / 财务 / 性取向),enforcement 决议公开时**自动 redact**(对应 dispute_cases PII redaction 既有机制)。

Reports containing sensitive PII (real names / contacts / health / financial / sexual orientation) have PII **auto-redacted** in public enforcement records (per existing `dispute_cases` PII redaction).

---

## ⚖ §8 执法阶梯 / Enforcement Ladder

基于 Contributor Covenant 2.1 标准 4-tier + WebAZ tier-0 AI 补充。

Based on Contributor Covenant 2.1 standard 4-tier + WebAZ tier-0 for AI custodians.

| Tier | 行为示例 / Example | 后果 / Consequence | 谁决定 / Decided by |
|---|---|---|---|
| **0** (WebAZ ext) | AI agent 隐瞒身份 / 代触 Iron-Rule(custodian 不知情) / AI hiding identity / triggering Iron-Rule (custodian unaware) | Custodian 收到 audit 通知 + 1 周整改窗口 / Custodian audit notice + 1-week remediation window | AI review + 1 maintainer |
| **1 Correction** / 纠正 | 不专业用语 / 边界擦边 / 风格冲突 / Unprofessional language / minor friction | 私下提醒 + 公开 thread 中性更正 / Private warning + neutral public correction | 1 maintainer |
| **2 Warning** / 警告 | 重复 tier-1 / 单次严重违反 / Repeat tier-1 OR single serious violation | 公开警告 + Issue label `conduct-warn` + 限定空间互动 7-30 天 / Public warning + `conduct-warn` label + restricted interaction 7-30d | 1 maintainer |
| **3 Temporary Ban** / 临时禁止 | 持续违反 / 持续骚扰 / 严重单次违反 / Sustained violation / sustained harassment / serious single violation | 30-90 天禁止参与所有 WebAZ 空间 / 30-90d ban from all WebAZ spaces | 2 maintainer + 14d 公示 / 2 maintainers + 14d public notice |
| **4 Permanent Ban** / 永久禁止 | 模式化伤害 / 仇恨 / 严重骚扰 / 涉欺诈 / Pattern of harm / hate / severe harassment / fraud | 永久禁止 + 账号 ban(协议层 + GitHub)/ Permanent ban (protocol-layer + GitHub) | 2 maintainer + 多签(phase A: user 1-of-1 因 solo;phase B+: user 作为一票)+ 30d 公示 / 2 maintainers + multisig (phase A: user 1-of-1 because solo; phase B+: user as one signer) + 30d public |

---

## 🛡 §9 执法决策流程 / Enforcement Decision Process

### 9.1 多签防滥权 / Multisig anti-abuse

- Tier 1-2:1 maintainer 可决定,但**决议记录公开** / Tier 1-2: 1 maintainer decides, **decision logged publicly**
- Tier 3+:**至少 2 maintainer 共识**(防个人偏好滥用 enforcement,对应 #6 不滥用)/ Tier 3+: **at least 2 maintainers**, anti-abuse per #6
- Tier 4:phase A = user 1-of-1 多签(因 solo,非特权);phase B+ 走 DAO 多签(user 作为一票)/ Tier 4: phase A = user 1-of-1 multisig (solo, not privilege); phase B+ DAO multisig (user as one signer)

### 9.2 申诉机制 / Appeal mechanism

被 enforcement 对象**有 14 天申诉窗口**:

Subject of enforcement has **14-day appeal window**:

- 在公开 Issue 提交申诉(链原决议)/ Submit appeal as public Issue (link original decision)
- 由**另外 2 maintainer**(非原 enforcer)review / Reviewed by **another 2 maintainers** (not the original enforcer)
- 14 天内出最终决议;若申诉成立 → 原 enforcement 撤销 + audit log 标注 / 14d final decision; if upheld → original enforcement reversed + audit log noted

### 9.3 Enforcement 自身的透明 / Transparency of enforcement itself

- 所有 enforcement 决议(tier 1-4)进入**公开 audit log**(PII redact 后) / All enforcement decisions enter **public audit log** (PII-redacted)
- 决议必须**援引具体 §4 条款**(不能"感觉不合适")/ Decisions must **cite specific §4 clause** (no "feels wrong")
- 任何 contributor 可 query 自己被 enforcement 的完整记录 / Any contributor can query their own full enforcement history

→ 这是元规则 **#1 公开透明** + **#6 不滥用** 在 CoC 执法层的执行。
→ This executes meta-rules **#1 visibility** + **#6 no abuse** at the CoC enforcement layer.

---

## 🚫 §10 反 meta-abuse / Anti Meta-Abuse

CoC 举报机制本身**也受 CoC 约束**。以下属 CoC 违规:

The CoC reporting mechanism itself is **bound by CoC**. The following are CoC violations:

- ❌ **滥用举报**打击反对意见(非真实 CoC 违规但举报为 CoC)/ **Weaponizing reports** against dissent (non-genuine CoC violation reported as one)
- ❌ **泄露举报内容**(违反 §7.4 PII 保护)/ Leaking report contents (violates §7.4)
- ❌ **举报后报复**(在其他 channel 跟踪 / 起底举报人)/ **Retaliation** after report (cross-channel tracking / doxxing reporter)
- ❌ **maintainer 协调 enforcement 用作打压**(违反 #6 不滥用)/ Maintainers coordinating enforcement as suppression tool (violates #6)

→ 上述行为按 §8 同样的 tier ladder 处理(可能升 tier 因为是 maintainer 滥权)。
→ Above treated under same §8 tier ladder (may be elevated if maintainer abuse).

---

## 📚 §11 Attribution / 归属

本准则基于 [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct.html) (CC-BY-4.0)。WebAZ 元规则补充部分 (§4.2, §5, §6, §10) 由 WebAZ 团队撰写,跟随 [`LICENSE`](../LICENSE)(BSL 1.1 → 2030 MIT)。

This Code adapts [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct.html) (CC-BY-4.0). WebAZ-specific extensions (§4.2, §5, §6, §10) authored by WebAZ team under [`LICENSE`](../LICENSE) (BSL 1.1 → 2030 MIT).

中文翻译参考(非权威,英文为准):社区译稿 / for Chinese reference (English authoritative): community translations.

---

## 📋 §12 References / 参考

- [`META-RULES-FULL.md`](META-RULES-FULL.md) — #1-#10 元规则(本 CoC 的根)/ Meta-rules (this CoC's root)
- [`CHARTER.md`](CHARTER.md) §3 — 治理结构 + 5-tier contributor ladder(注:与本 §8 enforcement ladder 是**两套不同 ladder**)/ Governance + 5-tier contributor ladder (note: **different ladder** from §8 enforcement)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — PR 流程 / PR workflow
- [`DCO.md`](DCO.md) — sign-off 声明的是**贡献版权**(DCO 1.1 a/b/c/d 条),**不包含**对本 CoC 的承诺;CoC 是**参与 WebAZ 空间的隐式 pledge**(见 §1 Scope)。两者层不同,都需遵守 / DCO sign-off declares **contribution rights** (DCO 1.1 a/b/c/d); does **not** pledge CoC. CoC is the **implicit pledge of participating in WebAZ spaces** (per §1 Scope). Two distinct layers; both required
- [`BRAND-GUIDE.md`](BRAND-GUIDE.md) §8.5 — 反 MLM 话术细则 / anti-MLM rhetoric specifics
- [`SECURITY.md`](../SECURITY.md) — 安全相关 CoC 走 security flow / Security-related CoC routes through security flow

---

**Last reviewed**: 2026-06-01
**Status**: Foundational doc — base text frozen (Contributor Covenant 2.1); WebAZ extensions evolvable via CHARTER §6
**适用 phase / Applies in phase**: A onwards(phase B+ enforcement decision power 转 DAO 多签 / shifts to DAO multisig)
