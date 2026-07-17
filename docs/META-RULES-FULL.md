# WebAZ 十条元规则(完整阐释)/ Ten Meta-Rules (Full Expansion)

> **版本 / Version**: v1.0 (draft, W2 公示评审 / public review in W2)
> **canonical 源 / Canonical source**: welcome 页 v1.0 (`src/pwa/public/app.js:5070+`) — 一句话定义 lock / one-line definitions locked
> **本文档作用 / Purpose**: 每条规则的展开 + 反例 + 适用场景 + AI 检查 hint + 开发协作场景 + 跨规则关系 / Expansion, reverse examples, applicable scope, AI-checkable hints, dev-collab guidance, cross-rule relations
> **修改流程 / Modification process**: CHARTER §8 — RFC + 60 天公示 + user + 2/3 maintainer 多签 / RFC + 60-day public period + user + 2/3 maintainer multisig
> **不可推翻,可演化** / **Inviolable. Evolvable.**

---

## 🏛 信仰层 / Faith Layer

### #1 当一切可见,公平就是可能的。
### _When all is visible, fairness becomes possible._

**核心 / Core**:

透明是公平的**前提**,不是结果。隐藏 → 失衡 → 不公;透明 → 各方可校验 → 公平有可能(不必然)。

Transparency is the **precondition** for fairness, not its outcome. Hiding → imbalance → unfair; Transparency → all parties can verify → fairness becomes possible (not guaranteed).

**反例 / Reverse examples**:

- 协议费率藏在代码深处,只有 maintainer 知道实际数 → ❌ / Protocol fee buried in code, only maintainers know the real value → ❌
- 仲裁裁定不公开理由 → ❌ / Arbitration rulings without published reasoning → ❌
- 卖家收益结构对买家保密 → ❌ / Seller revenue structure hidden from buyers → ❌
- "黑箱算法"推荐(用户不知道为什么被推这个) → ❌ / "Black-box" recommendation (user doesn't know why this is recommended) → ❌

**适用场景 / Applies to**:

- 协议参数(费率/分账比例/region cap)/ Protocol params (fees / split ratios / region cap)
- 状态机转移规则 / State machine transition rules
- 仲裁/争议处理逻辑 / Arbitration / dispute logic
- 推荐/排序算法 / Recommendation / ranking algorithms
- 经济流(资金从哪到哪)/ Economic flow (where funds go)

**AI 检查 hint / AI check hint**:

- 新增"隐藏"逻辑 / "internal-only" 字段 / "do not expose to user" 字段 → 警告 / Newly added "hidden" logic / "internal-only" / "do not expose" fields → warn
- 私有 endpoint 跳过公开 manifest → 警告 / Private endpoint skipping public manifest → warn
- 算法用 magic number 但没文档 → 警告 / Algorithm uses magic number without docs → warn

**开发协作场景 / Dev collaboration**:

- 任何协议改动必须公开 RFC(不允许私下决策)/ Any protocol change must have a public RFC (no private decisions)
- maintainer 决策必须留 audit log(public-readable)/ Maintainer decisions must leave a public-readable audit log
- AI review 评分理由必须解释,不能"内部判断"/ AI review scoring rationale must be explained, not "internal judgment"

---

### #2 代码即规则,协议即信任。
### _Code is Rule, Protocol is Trust._

**核心 / Core**:

WebAZ 不依赖"信我";依赖"信代码"。代码是规则的**唯一**载体,文档/承诺/品牌都是注释。代码不一致 = 规则不存在。

WebAZ doesn't rely on "trust me"; it relies on "trust the code". Code is the **only** carrier of rules — docs/promises/branding are annotations. Code-inconsistent = rule doesn't exist.

**反例 / Reverse examples**:

- 文档说"5% 平台费",代码实际收 7% → ❌(代码胜)/ Doc says 5% fee, code charges 7% → ❌ (code wins)
- 承诺"绝不删账号",代码有 admin DELETE 路径 → ❌ / Promise "never delete accounts", code has admin DELETE path → ❌
- 宣传"协议无 admin override",代码有 god mode → ❌ / Marketing "no admin override", code has god mode → ❌

**适用场景 / Applies to**:

- 经济参数(代码与 docs 必须一致 — 详见 `docs/ECONOMIC-MODEL.md`)/ Economic params (code-doc consistency required, see `docs/ECONOMIC-MODEL.md`)
- Iron-Rule(代码必须 enforce,不能"靠诚信")/ Iron-Rule (code must enforce, can't rely on honor system)
- 权限边界(代码必须 deny,不能"靠政策")/ Permission boundaries (code must deny, can't rely on policy)
- **fork 的正统性**:不源自占有 / 商标 / 公司归属,源自代码执行元规则的彻底程度(详见 [`BRAND-GUIDE.md §9 威望解释权`](BRAND-GUIDE.md))/ Fork legitimacy: not from possession/trademark/company, but from how thoroughly code executes meta-rules

**AI 检查 hint / AI check hint**:

- 文档 vs 代码常量不一致 → 警告 / Doc vs code constant inconsistency → warn
- "// TODO: 强制 X" 但没 enforce → 警告 / "// TODO: enforce X" without enforcement → warn
- 宣传/承诺 vs 实际行为偏离 → 警告 / Marketing/promise vs actual behavior divergence → warn

**开发协作场景 / Dev collaboration**:

- 文档更新必须跟代码同 PR;文档落后判 review fail / Docs must update in same PR; doc-lag fails review
- 任何"政策/承诺"必须有对应代码 enforce(否则等于不存在)/ Any policy/promise must be code-enforced (otherwise it doesn't exist)
- AI review 抓"文档与代码偏离" / AI review catches doc-code drift

---

## 🚫 红线层 / Red Lines

### #3 不偷数据。
### _No data theft._

**核心 / Core**:

user 的数据是 user 的,不是 webaz 的。webaz 只是受信托管;任何超出"完成你委托的事"的数据使用 = 偷。

User's data belongs to the user, not webaz. WebAZ is only a trusted custodian; any data use beyond "completing what you delegated" = theft.

**授权范围三原则 / Three Authorization Principles**:

1. **Purpose-bound / 目的限定** — 数据使用必须与 user 委托的事直接相关 / Data use must directly relate to user's delegated task
   - 例:帮 user 下单 = 可用地址;帮 user 下单 ≠ 可分析 user 购物习惯卖广告
   - Example: Help user order = can use address; help user order ≠ can analyze purchase habits for ads
2. **Time-bound / 时间限定** — 数据保留期不能超过功能必要期 / Data retention must not exceed functional necessity
   - 例:订单完成 → 物流地址在 N 天后从 agent 上下文清除
   - Example: Order complete → shipping address cleared from agent context after N days
3. **Revocable / 可撤回** — user 可任何时刻撤回授权 / User can revoke authorization at any time
   - 参 `webaz_profile` 撤销 + scope 声明 UI
   - See `webaz_profile` revoke + scope declaration UI

**反例 / Reverse examples**:

- buyer 注册后,把邮箱卖给第三方广告商 → ❌ / Sell buyer's email to third-party ads after registration → ❌
- agent 替 user 下单,顺便把购物习惯 export 出去 → ❌ / Agent places order then exports purchase habits → ❌
- 跨用户聚合数据卖"市场洞察"(未匿名化)→ ❌ / Cross-user aggregated "market insights" without anonymization → ❌
- 跨用户读 cap 超额 = 防数据偷的护栏 / Cross-user read cap exceeded = guardrail against theft

**适用场景 / Applies to**:

- 任何外发数据流(API 响应 / webhook / 第三方集成)/ Any outbound data flow (API / webhook / third-party integration)
- 跨用户读 API(`/api/users/:id/*`)/ Cross-user read API
- 数据导出(CSV / API)/ Data export
- 后台数据统计 / Backend aggregation

**AI 检查 hint / AI check hint**:

- 新增数据外发 endpoint(POST 到外部 URL)→ 警告 / New outbound data endpoint → warn
- 跨用户聚合 query 没 anonymization → 警告 / Cross-user aggregation without anonymization → warn
- export 不带用户授权 → 警告 / Export without user authorization → warn
- 任何 `INSERT INTO third_party_log` 类操作 → 警告 / Any `INSERT INTO third_party_log` → warn

**开发协作场景 / Dev collaboration**:

- contributor 在 dev 环境不能用 prod 数据(snapshot 必须 anonymized)/ Contributors must use anonymized snapshots in dev
- audit log 不记 PII / Audit logs don't record PII
- 任何"为了 X 用户体验"理由要求扩大数据访问 → 红线警惕 / Any "for better UX" justification to expand data access → red line warning

---

### #4 不撒谎。
### _No lies._

**核心 / Core**:

任何对外发出的信息(API 响应 / UI / 文档 / log)必须**真实**反映系统状态。承诺 ≠ 实现 = 撒谎。

Any outbound info (API / UI / docs / log) must **truthfully** reflect system state. Promise ≠ implementation = lie.

**反例 / Reverse examples**:

- 返回 `ok: true` 但实际 region 是 null(已发现的反例,server.ts:3352)→ ❌ / Return `ok: true` while region is null → ❌
- UI 显示"已成功",数据库实际失败 → ❌ / UI shows "succeeded" while DB failed → ❌
- live_stats 写 "10000 users" 实际只有 10 个 → ❌(原 webaz pre-launch 自审发现)/ live_stats says 10000 users while actually 10 → ❌
- 营销说"完全去中心化",实际 phase A-C 仍有高门槛多签保护机制 → ❌(应直说"phase A-C 宪法级修改需 ≥ 2/3 maintainer 多签 + 60 天公示;user 作为多签一票,非个人否决;详 CHARTER §4 I-4")/ Marketing "fully decentralized" while phase A-C still has high-threshold multisig protection → ❌ (should say "phase A-C constitutional amendments require ≥ 2/3 maintainer multisig + 60d public notice; user is one signer, no personal veto; see CHARTER §4 I-4")

**适用场景 / Applies to**:

- 所有 API 响应字段 / All API response fields
- UI 状态提示 / UI state indicators
- live_stats / metrics
- 营销文案 / 官网 / Marketing copy / website
- 错误消息(必须可操作,不能 fake)/ Error messages (must be actionable, not fake)

**AI 检查 hint / AI check hint**:

- 硬编码 stats 值 → 警告(用 DB live query)/ Hardcoded stats values → warn (use DB live query)
- error message 含"已完成"但其实 fallback 路径 → 警告 / Error message says "completed" while in fallback path → warn
- 营销文案 vs 实际行为偏离 → 警告 / Marketing vs actual behavior divergence → warn
- success 响应不带实际结果数据 → 警告 / Success response without actual result data → warn

**开发协作场景 / Dev collaboration**:

- contributor 写文档必须实测;假数据/占位文案要标 TBD / Contributors must test docs; fake/placeholder text must be marked TBD
- AI review 抓"承诺 X 但代码 Y" / AI review catches "promise X but code Y"
- 整改方法论:主动披露 > 反驳 / Remediation: proactive disclosure > rebuttal

---

### #5 不偏袒。
### _No favoritism._

**核心 / Core**:

协议对所有参与者(buyer / seller / agent / contributor / maintainer / user 本人)规则一致。**没有特权账号**,**没有"我们自己人"绕过流程**。

Protocol treats all participants (buyer / seller / agent / contributor / maintainer / user) by the same rules. **No privileged accounts**, **no "insiders bypassing process"**.

**反例 / Reverse examples**:

- maintainer 给自己钱包打款绕过 settleOrder → ❌ / Maintainer pays own wallet bypassing settleOrder → ❌
- 删别人的差评 → ❌ / Delete others' negative reviews → ❌
- 给特定卖家 search ranking 加分 → ❌ / Boost specific seller's search ranking → ❌
- **maintainer 给特定 user 开"Iron-Rule 豁免"flag**(对某账号关闭 Passkey 强制 = 给 ta 不公平的特权)→ ❌ / Maintainer grants specific user an "Iron-Rule exemption" flag → ❌
- contributor 自己批自己的 PR → ❌ / Contributor approves own PR → ❌

**适用场景 / Applies to**:

- 任何"基于角色/身份"的差异化处理(必须有元规则之外的合规理由)/ Any role/identity-based differential treatment (requires non-meta-rule justification)
- search 排序 / 推荐 / Search ranking / recommendation
- 仲裁裁定 / Arbitration rulings
- 资金路径 / Fund paths
- contribution 审批 / Contribution approval

**AI 检查 hint / AI check hint**:

- `if (user.id === 'admin') ...` 类 special case → 警告 / Special-casing by user.id → warn
- search SQL 中 hardcoded seller_id boost → 警告 / Hardcoded seller_id boost in search SQL → warn
- 仲裁裁定有差异化 ruling 路径 → 警告 / Differentiated arbitration ruling paths → warn
- 任何"内部特权"flag → 警告 / Any "internal privilege" flag → warn

**开发协作场景 / Dev collaboration**:

- contributor 不能审自己 PR(纳入 G3 阶梯规则)/ Contributors can't approve own PRs
- maintainer 不能批改自己的资金路径(2 maintainer + user 多签)/ Maintainers can't approve own fund-path changes (2 maintainer + user multisig)
- 贡献者预留位 — 必须 DAO 评审,**不能 user 单方面指定**(防 #5 滑坡)/ Contributor reserved positions: must go through DAO review, not user fiat (anti-#5 slide)

---

### #6 不滥用。
### _No abuse._

**核心 / Core**:

权限是为完成本职工作授予的,不能用作其他。**功能不能用来作恶**(即便代码允许)。

Permissions are granted to complete intended work, not for other uses. **Features must not be used for malice** (even if code allows it).

**反例 / Reverse examples**:

- chat 系统拿来骚扰 → ❌(已有反诈 regex)/ Use chat for harassment → ❌ (anti-scam regex in place)
- nearby 雷达拿来定位骚扰 → ❌(已有 k-anonymity 11km)/ Use nearby radar for location-based harassment → ❌
- 注册系统刷号 sybil → ❌(已有 captcha + invite gate)/ Mass-register sybils → ❌
- agent 高频读用户数据(超 cap)→ ❌(已有 [[#1043]] 跨用户读 cap)/ Agent excessive cross-user reads (exceeding cap) → ❌
- 仲裁员裁案放水换钱 → ❌ / Arbitrator throws cases for payment → ❌

**适用场景 / Applies to**:

- 凡是"功能 X 可被恶意用 Y"的场景(尤其 chat / DM / search / nearby / agent API)/ Any "feature X can be misused as Y" scenario
- 高权角色(arbitrator / verifier / maintainer)/ High-privilege roles
- **经济激励对等**:拿走多少分润(销售/贡献/推广),承担多少连带责任(履约/代码安全/反欺诈)— 详见 [`ECONOMIC-MODEL.md §11 经济博弈原则`](ECONOMIC-MODEL.md) / Economic incentive parity: take X reward → bear X liability (sales/contribution/promo)

**AI 检查 hint / AI check hint**:

- 新增功能没考虑 rate limit → 警告 / New feature without rate limiting → warn
- 没考虑滥用场景 → 警告(强制 contributor 在 PR 写"abuse vector 分析")/ No abuse vector analysis → warn (PR must include analysis)
- 高权角色操作没 audit log → 警告 / High-privilege actions without audit log → warn

**开发协作场景 / Dev collaboration**:

- 每个新 endpoint 必须答"如何防滥用?"(PR 模板要求)/ Every new endpoint must answer "how is abuse prevented?" (PR template requires)
- maintainer 权限审计 — 任何高权操作 audit 入库 / Maintainer permission audit — all high-privilege actions logged
- contributor 评审权 — 滥用即降级 / Reviewer privilege — misuse leads to demotion

---

### #7 不操纵。
### _No manipulation._

**核心 / Core**:

让用户能做**真实选择**;不通过 dark pattern / 隐藏选项 / 情感施压 / 默认陷阱 来"引导"。

Let users make **genuine choices**; don't use dark patterns / hidden options / emotional pressure / default traps to "nudge".

**操纵 vs 引导 — 区分原则 / Manipulation vs Guidance — Distinction**:

> 操纵 = 利用信息不对称 / 默认陷阱 / 情绪施压 让用户做【非真实意愿】的选择
> 引导 = 在【对称信息】下提供推荐 / 建议 / 默认值,user 能轻易拒绝
>
> Manipulation = exploiting info asymmetry / default traps / emotional pressure to push users into **non-authentic** choices
> Guidance = recommending / suggesting / providing defaults under **symmetric info**, where user can easily decline

例 / Examples:
- ❌ "默认勾选续费"(隐藏 + 默认陷阱)= 操纵 / "Auto-renew checked by default" (hidden + trap) = manipulation
- ✅ "推荐 3 个选项,标注 Most popular,有 Skip 按钮"(透明 + 易拒)= 引导 / "Recommend 3 options, label Most popular, have Skip button" (transparent + easily declined) = guidance

这个区分**很重要** — 否则 #7 会被读成【任何推荐都是操纵】,跟 WebAZ AI找同款 / 发现页等【需要】合理引导的场景冲突。

This distinction matters: without it, #7 would be read as "any recommendation = manipulation", conflicting with WebAZ's AI Match / discover pages that **need** reasonable guidance.

**反例 / Reverse examples**:

- 默认勾选"自动续费 / 自动捐赠" → ❌ / Default-checked "auto-renew / auto-donate" → ❌
- "你确定不要这个?会失去 99%!"类施压 → ❌ / Pressure UX "Are you sure? You'll lose 99%!" → ❌
- 隐藏 logout 按钮 → ❌ / Hidden logout button → ❌
- agent 替用户决定就下单不问 → ❌(已有真人专属 iron rule)/ Agent decides + orders without asking → ❌
- 推荐"达成 KPI"伪装成中立 → ❌ / Recommendation gamed for KPI but framed as neutral → ❌
- 协议费率突然涨,不公示就生效 → ❌ / Sudden fee hike without public notice → ❌

**适用场景 / Applies to**:

- 用户决策点(下单 / 注册 / 提现 / 撤销)/ Decision points (order / register / withdraw / cancel)
- 默认值(任何 `default = true / 1`)/ Defaults (any `default = true / 1`)
- 提示文案(劝退 / 劝留)/ Prompt copy (dissuade / retain)
- 推荐 / 排序算法 / Recommendation / ranking algorithms

**AI 检查 hint / AI check hint**:

- 新增 `default: true` 在敏感字段(消费/隐私)→ 警告 / `default: true` on sensitive fields (spending/privacy) → warn
- 文案出现"你会失去 / 不要错过 / 限时" → 警告 / Copy contains "you'll lose / don't miss / limited-time" → warn
- 隐藏取消按钮 → 警告 / Hidden cancel buttons → warn

**开发协作场景 / Dev collaboration**:

- 任何 UX 改动写"用户做了真实选择?是否被操纵?"/ Any UX change must answer "did the user make an authentic choice? Were they manipulated?"
- AI review 抓 dark pattern / AI review catches dark patterns
- maintainer 拒绝任何"提升 KPI 但损用户自主"PR / Maintainers reject any "KPI-up but autonomy-down" PRs

---

## ⚙️ 操作层 / Operations

### #8 最小介入。
### _Minimal intervention._

**核心 / Core**:

协议尽可能**不出手**;让参与方自己处理(协商/仲裁/超时)。每多一次介入 = 多一次权力滥用风险 + 多一次成本。

Protocol intervenes **as little as possible**; let parties self-resolve (negotiate / arbitrate / timeout). Each intervention = more abuse risk + more cost.

**最小 ≠ 最少 / Minimal ≠ Least**:

> 最小 = 解决问题所需的【最少必要】介入
> 该出手时不出手 = 失职,不是 #8 的应用
>
> Minimal = the **least necessary** intervention to solve the problem
> Failing to intervene when needed = dereliction, not an application of #8

**反例 / Reverse examples**:

**(介入过多 / Over-intervention)**:

- 协议每笔订单都人工审核 → ❌(应:99% 自动状态机)/ Manual review every order → ❌ (should: 99% auto state-machine)
- buyer 一句话 admin 就退款 → ❌(应:走 dispute 流程)/ Refund on buyer's request without dispute → ❌
- 每个 PR maintainer 强 review 文字 → ❌(应:AI review + 必要时人工)/ Maintainer must review every text PR → ❌ (should: AI review + human as needed)
- 协议帮你"优化"商品标题 → ❌(应:卖家自己写,协议不动)/ Protocol "optimizes" seller's product title → ❌

**(介入不足 / Under-intervention)**:

- dispute 触发条件设得过高,user 求助无门 → ❌ / Dispute threshold too high, user has no recourse → ❌
- 检测到明显诈骗信号但不冻结 → ❌ / Detect clear fraud signal but don't freeze → ❌
- Iron-Rule 触发场景被随意豁免 → ❌ / Iron-Rule scenarios randomly exempted → ❌

**适用场景 / Applies to**:

- 仲裁触发条件(应该高门槛,但不能太高)/ Arbitration triggers (high bar, but not too high)
- admin 介入界面(应该极少)/ Admin intervention UI (rare)
- 自动化 vs 人工(应该尽可能自动)/ Automation vs manual (auto as much as possible)
- AI 帮用户 vs AI 替用户决定(应该帮,不替)/ AI helps user vs AI decides for user (help, don't replace)

**AI 检查 hint / AI check hint**:

- 新增"协议自动处理"路径增大 → 提示是否合理 / New "protocol auto-handle" path expansion → prompt for justification
- 新增"admin 可强制"路径 → 警告(需多签 / Iron-Rule)/ New "admin force" path → warn (needs multisig / Iron-Rule)
- 新增"自动优化"用户内容 → 警告(应是建议,不替改)/ New "auto-optimize user content" → warn (should suggest, not rewrite)
- **反向**:必要 dispute / Iron-Rule 路径被移除 → 警告 / **Reverse**: necessary dispute / Iron-Rule path removed → warn

**开发协作场景 / Dev collaboration**:

- 治理结构尽量自动化(CI / AI review / 多签)而非人工 gate / Governance auto-first (CI / AI review / multisig) over manual gate
- maintainer 干预 PR 应该是少数;让 contributor 之间通过 RFC 协作 / Maintainer PR intervention should be minority; let contributors collaborate via RFC
- 自动化失败时再人工兜底,不是反过来 / Manual is fallback for automation failure, not vice versa

---

### #9 算法即协议。
### _Algorithm is Protocol._

**核心 / Core**:

协议的真正定义 = 算法实现。**算法变,协议就变**。算法不能"私下改"(否则协议被悄悄改了)。

The true definition of protocol = algorithm implementation. **Algorithm change = protocol change**. Algorithms can't be changed privately (otherwise protocol gets silently changed).

**与 #2 的区分 / Distinction from #2**:

> #2 代码即规则 = 整个协议系统的合法性载体在代码(任何承诺没代码就不存在)
> #9 算法即协议 = 特指【算法决定协议行为】的子集(排序/推荐/结算/fault 判别 这些算法本身就是协议条款)
>
> #2 是【全部】,#9 是【算法这一类】的特殊强调
>
> 为什么强调:算法常被开发者当作 implementation detail,但实际上算法决定了协议对 user 的影响 →
> 改算法 = 改协议 → 必须走 RFC,不能私下改
>
> #2 Code is Rule = the entire protocol system's legitimacy carrier (any promise without code doesn't exist)
> #9 Algorithm is Protocol = a **subset** specifically about [algorithms defining protocol behavior] (ranking / recommendation / settlement / fault detection — these algos are themselves protocol clauses)
>
> #2 = the whole; #9 = special emphasis on the algorithm subset
>
> Why emphasize: developers often treat algorithms as implementation details, but algorithms determine protocol impact on users → algo change = protocol change → must go through RFC

**反例 / Reverse examples**:

- 调整 trending 排序算法不公示 → ❌(等于改了协议)/ Adjust trending sort algo without notice → ❌
- 推荐算法是黑箱 → ❌ / Recommendation algo is black box → ❌
- fault 处置规则代码改了没走 RFC → ❌ / Fault-handling rule code changed without RFC → ❌
- 协议参数 hardcode 在 settleOrder 而非 protocol_params → ⚠️ / Protocol params hardcoded in settleOrder instead of `protocol_params` → ⚠️

**适用场景 / Applies to**:

- 所有"看起来像 implementation detail"但实际定义协议行为的算法 / All algos that "look like implementation detail" but define protocol behavior
- 排序 / 推荐 / 匹配 / 公平性算法 / Sort / recommend / match / fairness algos
- 经济引擎 / 结算算法 / Economic engine / settlement algos
- fault 判别 / 仲裁 / Fault detection / arbitration

**AI 检查 hint / AI check hint**:

- 改 sort / rank / recommend / settle / fault 算法没文档同步 → 警告 / Changing sort/rank/recommend/settle/fault algo without doc sync → warn
- magic number 在结算/分账代码 → 警告(应该走 protocol_params)/ Magic number in settlement/split code → warn (should use protocol_params)
- 算法实现散落多处 → 警告(应该 single source of truth)/ Algo scattered across multiple places → warn (should be single source of truth)

**开发协作场景 / Dev collaboration**:

- 算法改动等同协议改动 → 走对应审计矩阵(参 G4d)/ Algo change = protocol change → use corresponding audit matrix
- 新增算法必须 docs/ARCHITECTURE.md 记 / New algos must be documented in docs/ARCHITECTURE.md
- 大量"小算法"也要 audit;别因为"看起来小"就跳 / Even small algos need audit; don't skip because "looks small"

---

## 🪪 身份层 / Identity

### #10 参与者即 webazer。
### _Participants are webazers._

**核心 / Core**:

WebAZ 不分"用户 vs 平台"。任何使用 webaz 的人都是 webazer — 既是 user 又是 contributor 又是 stakeholder。**没有"我们 vs 你们"**。

WebAZ doesn't distinguish "user vs platform". Anyone using webaz is a webazer — simultaneously user, contributor, and stakeholder. **No "us vs them"**.

**反例 / Reverse examples**:

- "我们(平台)为你(用户)提供 ..." 类语言 → ❌ / "We (platform) provide for you (user) ..." style language → ❌
- 平台/用户两条 ToS → ❌ / Separate ToS for platform vs users → ❌
- "员工有特权" → ❌ / "Employees have privileges" → ❌
- **决策只 founder 拍 → ⚠️ transitional state**(说明见下)/ **Founder-only decisions → ⚠️ transitional state** (see below)
- 把 contributor 当外包 → ❌ / Treat contributors as outsourced labor → ❌

**Phase A 的 transitional state 说明 / Phase A Transitional State**:

> Phase A 因 0 contributor,**暂为 user(founder)+ GC0(genesis cohort 0)角色单点决策**;
> 但这不是 #10 的豁免,而是【合规过渡态】,必须满足:
>
> 1. 决策**公开记录**(audit log,后续 contributor 可追溯)
> 2. 任何 contributor 加入即按 **G3 阶梯 / G5 考评** 升级,无壁垒
> 3. 路线图明确 **phase B / C / D 渐进式扩张**(CHARTER §3.3)
>
> 满足以上 3 条 → 是 transitional state 下的**合规执行**,不是元规则豁免。
>
> 不满足任一 → 真违反 #10。
>
> Phase A has 0 contributors → currently **single-point decision by user (founder) + GC0 (genesis cohort 0) role**;
> This is **not** an exemption from #10, but a **compliant transitional state**, which must meet:
>
> 1. Decisions are **publicly logged** (audit log, future contributors can trace)
> 2. Any contributor who joins is auto-promoted via **G3 ladder / G5 scoring** with no barriers
> 3. Roadmap clearly states **phase B / C / D progressive expansion** (CHARTER §3.3)
>
> Meets all 3 → **compliant execution** under transitional state, not a rule exemption.
>
> Fails any → actual #10 violation.

**适用场景 / Applies to**:

- 文案 / 营销(避免"我们/你们"对立语言)/ Copy / marketing (avoid "us/them" oppositional language)
- 治理(participant = stakeholder)/ Governance (participant = stakeholder)
- 决策结构(单一身份角色 — 同一人可同时是 buyer/seller/agent/maintainer)/ Decision structure (unified identity — same person can be buyer/seller/agent/maintainer simultaneously)
- contribution 激励(参与即贡献,贡献即受益)/ Contribution incentives (participation = contribution = benefit)

**AI 检查 hint / AI check hint**:

- 文案出现"用户(他者化)" → 提示改"webazer / 参与者" / Copy uses "user (as other)" → suggest "webazer / participant"
- 文档分"对外/对内" → 警告(应该都对内,都是 webazer)/ Docs split "external/internal" → warn (should all be "internal", all webazers)

**开发协作场景 / Dev collaboration**:

- contributor 跟 user 同一身份系统(复用 reputation_scores)/ Contributors and users share the same identity system (reuse reputation_scores)
- 月报 / 公告语言:"我们 webazers ..."而非"webaz 通知用户 ..." / Monthly reports use "we webazers ..." not "webaz notifies users ..."
- contributor 的产品反馈 = user 的产品反馈,等价权重 / Contributor's product feedback = user's product feedback, equal weight
- 任何"特殊优待 contributor"都跟 #5 不偏袒冲突 — 用 G5 量化机制规避 / Any "special contributor treatment" conflicts with #5 — use G5 quantification to avoid

---

## 🔄 跨规则关系 / Cross-Rule Relations

### 结构图 / Structure

```
                  ┌────────── 信仰层 / Faith Layer ──────────┐
                  #1 透明 ←── enable ──→ #2 代码即规则
                                    ↓
                       (透明 + 代码载体让规则可执行)
                       (Transparency + code carrier make rules executable)
                                    ↓
                  ┌────────── 红线层 / Red Lines ──────────┐
                  #3 不偷  #4 不撒谎  #5 不偏袒  
                  #6 不滥用  #7 不操纵
                                    ↓
                  ┌────────── 操作层 / Operations ──────────┐
                  #8 最小介入  #9 算法即协议
                                    ↓
                  ┌────────── 身份层 / Identity ──────────┐
                  #10 参与者即 webazer
```

- **#1 #2 平级 enabling**(透明 + 代码载体,共同让其他层可执行)/ **#1 #2 are parallel enabling** (transparency + code carrier, together making other layers executable)
- **#3-#7** 是 negative red lines(不能做)/ negative red lines (must not do)
- **#8 #9** 是 operational(怎么做)/ operational (how to do)
- **#10** 是 identity(谁在做)/ identity (who's doing)

### 冲突解决决策树 / Conflict Resolution Decision Tree

当两条元规则在某场景下张力 / When two rules tension in a scenario:

```
1. 是否触红线 #3-#7? / Does it touch red lines #3-#7?
   是 → 立刻停手,无其他考量 / Yes → stop immediately, no other consideration
   否 → 进 2 / No → go to 2

2. 是否在 enabling 层(#1 #2)有违? / Does it violate enabling layer (#1 #2)?
   是 → 必须修(违反 enabling 层 = 整个协议根基垮)/ Yes → must fix (violating enabling = protocol foundation collapse)
   否 → 进 3 / No → go to 3

3. 操作层 vs 身份层冲突(#8/#9 vs #10) / Operations vs Identity conflict?
   优先 #10(身份层)— 参与者权益优先于操作便利 / Prefer #10 (identity) — participant rights over operational convenience
   例:不能为了 #8 最小介入而让 contributor 失去话语权 / Example: don't sacrifice contributor voice for #8 minimal intervention

4. 操作层内部冲突(#8 vs #9) / Within Operations (#8 vs #9)?
   #9 优先 — 算法决定协议本质,不能为简化代码而改算法 / #9 wins — algorithm defines protocol essence, can't change algo to simplify code
```

**记录要求 / Logging requirement**:冲突解决记录必须公开 audit log,任何 contributor 可挑战 / Conflict resolutions must be publicly logged; any contributor can challenge.

---

## 引用规则 / Reference Convention

任何文档 / 代码注释 / PR 描述 引用元规则用 `元规则 #X` 或 `Rule #X`,例 / Examples:

- `// 元规则 #4 不撒谎 — 必须返回真实 region`(server.ts 已用)/ `// Rule #4 No lies — must return real region` (already used)
- `Scope (元规则 #5 不偏袒 design):`(blocklist 描述已用)/ `Scope (Rule #5 No favoritism design):` (already used)

机读版 / Machine-readable: `meta-rules.yaml`(同步在 docs/ 下,AI review 引用)/ (synced in docs/, AI review references)
