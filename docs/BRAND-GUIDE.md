# WebAZ 品牌守则 / Brand Guide

> **版本 / Version**: v1.0 (draft, W3 末跟 CHARTER 同步 lock)
> **作用 / Purpose**: 保持 fork / 应用 / 协议方在视觉/语言上"看起来像 WebAZ",避免社区繁荣后认知碎片化 / Keep forks/apps/protocol implementations visually and linguistically aligned with WebAZ; prevent identity fragmentation as community grows
> **修改流程 / Modification process**: CHARTER §6 (RFC + 30 天公示 + 多签,user 作为一票 / RFC + 30-day public + multisig, user as one signer)
> **父级 / Parent**: CHARTER + META-RULES.md

---

## §1 名称 / Name

- **正式名 / Official name**: **WebAZ**(大小写敏感 / case-sensitive)
- **简称 / 程序名 / Short form / program ID**: `webaz`(全小写,代码 / package / domain 用 / lowercase, used in code / package / domain)
- **不允许 / Disallowed**: ~~Webaz~~ / ~~WEBAZ~~ / ~~Web AZ~~ / ~~Web-AZ~~
- **拼写来源 / Etymology**: web + AZ(A 到 Z,全光谱;agent-native 商业的全谱兼容 / a-to-z, full-spectrum compatibility for agent-native commerce)
- **参与者称谓 / Participant term**: **webazer**(全小写 / 复数 webazers)— 元规则 / Rule #10 身份层 / identity layer

## §2 Logo / 商标视觉

> **当前事实 / Current state**: 文字商标 "WebAZ" 已注册;图形商标(logo)设计中,emoji 🦞 临时占位。
> **Current**: Text trademark "WebAZ" registered; visual mark (logo) in design, emoji 🦞 as transitional placeholder.

### 2.1 商标状态 / Trademark Status

| 商标类型 / Mark type | 状态 / Status | 备注 / Notes |
|---|---|---|
| **WebAZ 文字商标 / "WebAZ" text trademark** | ✅ 已注册 / Registered | 商业使用须授权 / Commercial use requires licensing |
| **图形商标(logo)/ Visual trademark (logo)** | 🎨 设计中 / In design | emoji 🦞 临时占位;设计完成后单独注册 / Emoji 🦞 placeholder; will register after design finalizes |

### 2.2 临时占位 emoji 🦞 / Transitional Placeholder Emoji 🦞

**使用场景 / Allowed uses**:
- README 第一行 / README opening line
- PWA 首页顶部 / PWA homepage header
- 文档站 favicon / Docs site favicon
- 社交 avatar(个人 webazer 自用)/ Social avatars (individual webazers)

**已知限制 / Known limitations**(诚实披露 / honest disclosure):
- emoji 字符**不可注册为商标**(公共字符)/ Emoji characters **cannot be trademarked** (public chars)
- 在不同系统渲染不一致(Apple / Google / Windows 各异)— 已知,非缺陷 / Renders differently across systems — known, not a defect
- 仅是过渡使用,正式 logo 完成后会替换 / Transitional only; will be replaced once official logo finalizes

**禁止 / Prohibited**(对临时占位)/ (For placeholder):
- 把 🦞 注册为商标 / Trademark registering 🦞
- 把 🦞 描述为 "WebAZ 官方 logo" — 这是过渡占位,不是正式 logo(元规则 #4 不撒谎)/ Describing 🦞 as "official WebAZ logo" — it's a placeholder, not the official logo (Rule #4 no lies)

### 2.3 正式 logo 设计 / Official Logo Design

**进展 / Progress**: 设计中,无强制时间表 / In design, no hard deadline.

理由 / Why no deadline:
- 对未完成功能不承诺投机性时间表 / Do not promise speculative dates for unfinished features
- 跟 community 成长同步;phase B 触发后设计稿可走 RFC 让 community review / Synced with community growth; design goes through RFC for community review after phase B trigger

**设计原则(高层 / High-level principles)** — 详细 brief 留给设计 RFC,不在本守则锁死 / Detailed brief belongs to design RFC, not locked here:
- visual 稳定 + 可缩放(SVG 矢量,任意尺寸不失真)/ Stable + scalable (SVG vector, any size)
- 符合元规则 #1 公开透明 + #10 身份层 / Aligned with Rule #1 + #10
- 中文 / 英文场景一致风格 / Consistent across Chinese / English contexts

**社区参与 / Community participation**:
- 设计稿完成后 → 公开 RFC + 14 天公示 / After draft → public RFC + 14-day notice
- 任何 webazer 可评论 / 提替代方案 / Any webazer can comment or submit alternatives
- 选定后走 CHARTER §6 程序 lock 进 brand-guide v2 / Selection follows CHARTER §6 to lock into brand-guide v2

### 2.4 正式 logo 启用后 / After Official Logo Goes Live

- 提 RFC-brand-v2 锁定本节 / Submit RFC-brand-v2 to lock this section
- 注册图形商标(SG IPOS / 其他司法辖区按需)/ Register visual trademark (SG IPOS / other jurisdictions as needed)
- README / PWA / docs / 社交账号 同步更新 / Sync update README / PWA / docs / social
- emoji 🦞 退出官方使用,但 fork / 个人 avatar 不强制收回 / 🦞 retires from official; forks / personal avatars not forcibly recalled

### 2.5 商业使用约束 / Commercial Use Constraints

适用于"WebAZ"文字商标 + 未来图形 logo / Applies to "WebAZ" text trademark + future visual logo:

| 使用类型 / Use type | 是否允许 / Allowed |
|---|---|
| 非商业 / 学术 / 教学 / 个人 / Non-commercial / academic / teaching / personal | ✅ |
| fork 后保留 attribution / Fork with attribution | ✅ |
| 文章 / 演讲 / 报道引用 / Articles / talks / reportage citation | ✅(需 attribution / require attribution) |
| 商业服务命名(用"WebAZ"做产品名)/ Commercial service naming | ⚠️ 须授权 / Requires licensing(licensing@webaz.xyz) |
| 商业使用 logo / Commercial logo use | ⚠️ logo 设计完成后须授权 / Requires licensing after logo finalizes |

## §3 配色 / Color Palette

**官方调色板 / Official Palette**:

| 用途 / Purpose | Hex | RGB | 用法 / Usage |
|---|---|---|---|
| **主橙 / Primary orange** | `#ea580c` | 234,88,12 | CTA / 强调 / 协议标识 / CTA / emphasis / protocol identity |
| **柔橙 bg / Soft orange bg** | `#fff7ed` | 255,247,237 | 高亮区背景 / 选中态 / Highlight bg / selected state |
| **协议黑 / Protocol black** | `#1f2937` | 31,41,55 | 主文字 / 高对比标题 / Body text / high-contrast titles |
| **次灰 / Secondary gray** | `#6b7280` | 107,114,128 | 副文字 / hint / Secondary text / hints |
| **极淡灰 / Lightest gray** | `#f3f4f6` | 243,244,246 | 卡片背景 / Card backgrounds |
| **成功绿 / Success green** | `#16a34a` | 22,163,74 | 完成 / 正向操作 / Success / positive ops |
| **警示红 / Alert red** | `#dc2626` | 220,38,38 | 错误 / 红线 / 删除 / Errors / red lines / delete |
| **慈善紫 / Charity purple** | `#7c3aed` | 124,58,237 | 慈善 / 仲裁等"公益"维度 / Charity / arbitration / public-good dimensions |

**禁用 / Prohibited**:
- 渐变 logo / 渐变 CTA(协议级风格保持 flat / Protocol-level style stays flat)
- 霓虹 / cyber 类高饱和(不符合"商业 trust"调性 / Doesn't fit "commercial trust" tone)
- 紫色不用于交易类按钮(留给慈善 / Reserved for charity)

## §4 字体 / Typography

- **正文 / Body**: 系统 sans-serif / System sans-serif
  - `-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, 系统默认 / system default`
- **monospace**: `Menlo, Monaco, Consolas, SF Mono, 等宽 / monospaced`(代码 / 数字 / hash / Code / numbers / hashes)
- **不引入 web font / No web fonts**(性能 + 离线友好;参元规则 #8 最小介入 / Performance + offline-friendly; Rule #8 minimal intervention)

## §5 语调 / Voice

### 做的 / Do
- ✅ **直说事实** / **State facts directly**: "我们不允许 X" 而不是"建议避免 X"(参元规则 #4 不撒谎)/ "We do not allow X" instead of "We suggest avoiding X" (Rule #4)
- ✅ **量化具体** / **Quantify**: "协议费 2%" 而不是"低协议费" / "Protocol fee 2%" instead of "Low protocol fee"
- ✅ **承认局限** / **Acknowledge limits**: "Direct Pay 已上线,escrow 仍为模拟" 而不是模糊宣称"所有支付都已完成" / "Direct Pay is live; escrow remains simulated" instead of implying every payment rail is complete
- ✅ **平等称谓** / **Equal address**: "你是 webazer" 而不是"作为用户你 ..."(元规则 #10)/ "You are a webazer" instead of "As a user ..." (Rule #10)
- ✅ **代码即权威** / **Code is authority**: "按 settleOrder() 的逻辑 ..." 而不是"通常情况下 ..."(元规则 #2)/ "Per settleOrder() logic ..." instead of "Typically ..." (Rule #2)

### 不做 / Don't
- ❌ 营销腔: "独家 / 限时 / 错过就没了"(元规则 #7 不操纵)/ Marketing speak: "Exclusive / limited time / don't miss" (Rule #7)
- ❌ web3 黑话: "to the moon / 通证 / 韭菜"(无价值)/ Web3 jargon (no value)
- ❌ 平台 vs 用户对立: "我们(平台)为你 ..."(元规则 #10)/ Platform-vs-user oppositional language (Rule #10)
- ❌ 暗示金融收益: "赚 X 倍 / 财富自由"(MLM 红线 + 元规则 #4)/ Implying financial returns (MLM red line + Rule #4)
- ❌ FOMO 词汇: "机会窗口 / 还剩 N 天"(操纵 / manipulation)

### 双语标准 / Bilingual Standards
- 中文优先(原始语言),英文 verified parity(每条都 native-quality 翻译)/ Chinese primary, English at native-quality parity
- 双语 1:1 — 不允许某语言独有功能宣传 / 1:1 — no language-exclusive feature claims
- 翻译走 i18n 系统,**不允许 hardcoded 中文 / 英文**(已是代码门槛,元规则 #1)/ Translations via i18n system; **no hardcoded Chinese/English** (already a code gate, Rule #1)

## §6 命名约定 / Naming Conventions

- **协议层概念 / Protocol concepts**: 小写中划线 / lowercase kebab — `protocol-status` / `agent-passport` / `share-link`
- **代码层 / Code**: 遵循 TypeScript 惯例 / TypeScript conventions — `camelCase` 函数 / functions / `PascalCase` 类型 / types / `SNAKE_CASE` 常量 / constants
- **状态机状态 / State machine states**: 小写下划线 / lowercase underscore — `created / paid / accepted / shipped / picked_up / in_transit / delivered / confirmed / disputed / completed`
- **角色 / Roles**: 全小写 / all lowercase — `buyer / seller / logistics / arbitrator / verifier / agent / webazer`
- **不允许 / Disallowed**: `Web3` / `decentralized AI` / 任何被滥用的 buzzword 当类目名 / any abused buzzword as category name

## §7 README badge 标配 / Standard Badges

每个 GitHub repo / docs 站首页应有这套 badge / Standard badge set for repos and docs:

```markdown
![License: BSL 1.1](https://img.shields.io/badge/license-BSL%201.1-blue.svg)
![npm](https://img.shields.io/npm/v/@seasonkoh/webaz)
![CI](https://github.com/webaz-protocol/webaz/workflows/CI/badge.svg)
![Contributors](https://img.shields.io/github/contributors/webaz-protocol/webaz)
![Status](https://img.shields.io/badge/status-live-brightgreen.svg)
![Made by webazers](https://img.shields.io/badge/made_by-webazers-ea580c)
```

**永远显式标注已上线与尚未完成的功能边界**(元规则 #4 不撒谎)/ **Always distinguish live capabilities from unfinished ones** (Rule #4)

## §8 对外宣传 / Outward Communication

### 允许 / Allowed
- 小红书(中文)/ Xiaohongshu (Chinese)
- 推特/X(英文)/ Twitter/X (English)
- HackerNews(技术 / technical)
- Reddit r/SideProject / r/typescript / r/decentralized
- 个人博客 / 演讲 / 播客 / Personal blog / talks / podcasts
- AMA / Discussion 等 community 互动 / Community AMA / Discussions

### 不允许 / Prohibited
- ❌ paid promotion / influencer marketing(操纵元规则 #7)/ Paid promotion / influencer marketing (Rule #7 manipulation)
- ❌ LinkedIn ads(商业感污染社区)/ LinkedIn ads (commercial feel pollutes community)
- ❌ 赞助 KOL 测评(诚信元规则 #4)/ Sponsored KOL reviews (Rule #4 integrity)
- ❌ "限时优惠 / 早鸟价"营销(操纵 #7)/ "Limited-time / early-bird" marketing (Rule #7)
- ❌ 代币 / 空投 / 撸毛宣传(MLM 红线)/ Token / airdrop / yield-farming promotion (MLM red line)
- ❌ **虚假 active user 数 / contributor 数 / 增长数据 / 任何 KPI**(元规则 #4 不撒谎)/ **Fake active user count / contributor count / growth metrics / any KPI** (Rule #4)
  - 包括 / Including: 把内测数字当公开数字 / Treating private beta as public counts
  - 包括 / Including: 把 demo / mock 数据当真实运营数据 / Treating demo / mock data as real ops data
  - 包括 / Including: "X 个 webazer" 这类宣传必须能 trace 到公开 audit log / Claims like "X webazers" must be traceable to public audit log

## §9 fork 行为约束 / Fork Behavior Constraints

任何 fork 必须 / Any fork must:
- ✅ 保留 LICENSE 文件(BSL 1.1)/ Keep LICENSE file (BSL 1.1)
- ✅ 保留 META-RULES.md / CHARTER.md 的存在(可注明自己的解读差异,但不能删原文)/ Keep META-RULES.md / CHARTER.md existing (can note interpretation diffs, but don't delete originals)
- ✅ **名字明显区分**(不能继续叫 webaz / WebAZ — 跟"WebAZ"文字商标冲突)/ **Visually distinct name** (cannot continue as webaz / WebAZ — conflicts with text trademark)
- ✅ **logo 不能用 WebAZ 正式图形商标**(设计完成后);emoji 占位期间 — emoji 字符谁都能用,fork 自由使用 / **Cannot use WebAZ official visual trademark** (post-finalization); during emoji placeholder phase — emoji chars are public, free fork use OK

fork 是**鼓励**的(参元规则 #1 公开透明 + BSL/Apache 期间 fork 自由),只需以上 4 条对外区分。
Fork is **encouraged** (Rule #1 + license allows free fork); only the 4 distinctions above are required.

### 威望解释权 / Fork Sovereignty & Legitimacy

> **fork 是 license 赋予的权利;威望是元规则赋予的认可。两者解耦。**
> Fork is a license-granted right; legitimacy is meta-rule-earned recognition. The two are decoupled.

任何人可以 fork,但 fork 不会自动 inherit "WebAZ" 的威望。判断哪个分支是"正统"的标准**只有一个**:
Anyone can fork, but a fork doesn't inherit "WebAZ" legitimacy. The **single criterion** for which branch is "正统 (legitimate)":

> **对 10 元规则的执行最彻底、最干净的那个分支,就是当下的 WebAZ 主干。**
> **The branch that executes the 10 meta-rules most thoroughly and cleanly IS the current WebAZ mainline.**

→ 即使创始人 @seasonkoh 的 commit 比某个 fork 更不符合元规则,**fork 也可以成为新的 WebAZ 道德正统继承者**(phase D 后 DAO 投票认可)。
→ Even if @seasonkoh's commits diverge from meta-rules more than a fork's, **the fork CAN become the new 道德正统 (moral-legitimate) inheritor** (DAO-recognized post-phase-D).

→ 这跟 **#2 代码即规则** + **#5 不偏袒** 一致 — 正统性不来自人 / 公司 / 占有,来自代码本身。
→ Consistent with **#2 (code is rule)** + **#5 (no favoritism)** — legitimacy isn't from a person/company/possession, but from code itself.

**⚠️ 关键界定:技术/道德正统 ≠ 商标使用权 / Crucial distinction: Technical legitimacy ≠ Trademark use rights**

DAO 投票认可的是【技术/道德正统继承】(对元规则执行最干净的分支),**不等于**【商标使用权】("WebAZ" 文字商标 + 图形商标归 WebAZ Pte Ltd,见 §9 fork 行为约束第 3-4 条 + LICENSE / CHARTER)。

What DAO recognizes = **technical/moral legitimate inheritance** (the branch executing meta-rules cleanest); **NOT** the right to use the "WebAZ" name (the WebAZ word + visual trademark are held by WebAZ Pte Ltd; see §9 fork constraints items 3-4 + LICENSE / CHARTER).

**实际后果 / Practical consequence**:

- 一个 fork 可以是【道德正统继承者】(meta-rule 执行最干净)— DAO 公开认可,主干 cherry-pick / RFC 合并 / A fork CAN be 道德正统继承者 — DAO recognizes publicly, mainline cherry-picks via RFC
- 但 fork 仍**不能称自己为 "WebAZ"** — 必须改名(§9 ✓ 名字明显区分)/ But the fork still **CANNOT call itself "WebAZ"** — must rename (§9 item 3 ✓)
- "主干变更"在协议层 = DAO 投票切换 reference repo;**在法律层 = 商标转让**(独立程序,受 CHARTER §4 license-invariant 约束)/ "Mainline switch" at protocol layer = DAO vote on reference repo; **at legal layer = trademark transfer** (separate process, bound by CHARTER §4 invariants)
- 两套机制并行:**道德正统** 由代码 / 元规则定;**商标权** 由法律 / 注册定。两者一致时无冲突;若冲突,phase D 后通过 RFC + 多签解决 / Two parallel mechanisms: **moral legitimacy** by code / meta-rules; **trademark** by law / registration. Aligned in normal case; conflicts resolved post-phase-D via RFC + multisig

→ 这条界定让 fork sovereignty 落地时不踩商标法红线 — 协议自由 + 商标边界 同时成立。
→ This distinction keeps fork sovereignty within trademark law — protocol freedom + trademark boundaries coexist.

**对当前 (phase A) 的实际影响 / Practical impact in phase A**:

- 鼓励 fork 实验(尤其元规则解释差异)/ Forks encouraged (especially meta-rule interpretation experiments)
- maintainer 团队**主动 audit** 重要 fork;若 fork 在某条元规则上做得更好 → 主干 cherry-pick 或开 RFC 讨论合并 / Maintainers audit major forks; better implementations → cherry-pick or RFC for merge
- 主干**不靠垄断捍卫地位**;靠"做得最干净"维持威望 / Mainline doesn't defend via monopoly; maintains legitimacy by "doing it cleanest"

---

> **品牌不是装饰,品牌是协议级承诺的视觉延伸**。任何违反本 guide 的 PR / 营销内容会被 maintainer 改回 / 标 `brand-violation`。
> **Branding is not decoration; it is the visual extension of protocol-level promises.** PRs / marketing content violating this guide will be reverted by maintainers / tagged `brand-violation`.
