# WebAZ 经济模型公开说明 / Economic Model (Public)

> 更新:2026-07-16 · 已公开发布
> Status: publicly launched
>
> 本文档面向公众,解释协议层金钱如何流转、谁拿走多少、什么情况下会改。
> 所有数字都是 `protocol_params` 表里的当前默认值,DAO 治理可调。运营状态(GMV / 用户数)按惯例不公开。

> **当前支付边界**:Direct Pay 已支持真实场外付款,本金在买家与卖家之间直接流转,WebAZ 不代持。本文中的 WAZ / escrow 流程是协议的模拟托管经济模型,不是当前真实支付轨。其他支付方式持续接入。

---

## 1. 一句话模型 / TL;DR

> **协议本身不赚利差**:Direct Pay 由买家直接付给卖家,WebAZ 不经手本金。协议记录订单状态、授权与证据;佣金和费率规则由 `protocol_params` 参数化管理。
> 协议运营方(`sys_protocol`)只在以下两种场景拿钱:① 平台费(默认 1-2%);② 风险事件罚没(争议失败方押金 / 失效推荐链尾款回收)。
> 任何一笔"协议拿的"钱都有去向公告——大部分回流公益基金(`charity_fund`),小部分覆盖基础设施(域名 / 服务器 / CDN)。

> The protocol does **not** profit from spreads. All cash flows are parameterized in `protocol_params`. The operator (`sys_protocol`) only earns from (1) explicit platform fee 1-2%, and (2) risk-event slashing (dispute losers / dead-end commission chains). Everything taken is published — most rerouted to the public-good fund (`charity_fund`).

---

## 2. 三种"钱"

| 名称 | 定义 | 1:1 锚 | 流动性 |
|---|---|---|---|
| **WAZ** | escrow 模拟轨的内部测试单位 | 1 WAZ ≈ 1 USDC(仅模拟基准) | 仅模拟流程 |
| **USDC**(Base) | 实验性链上托管集成 | 1 USDC = 1 USDC | 不是当前真实支付轨 |
| **charity_fund** | 公益基金池,治理决定用途(不可挪用作运营) | 累计 WAZ | 仅经治理流出 |

`waz_usdc_rate` 默认 = 1.0 仅作为 escrow 模拟流程的展示基准,不是真实汇率或兑付承诺。Direct Pay 以卖家选定的收款方式和币种完成。

---

## 3. Escrow 模拟经济流(100 WAZ 商品为例)

> 本节是 escrow 模型与状态机的测试说明,不代表当前 Direct Pay 的本金流向。Direct Pay 中本金由买家直接付给卖家。

假设买家下单一件 100 WAZ 商品,卖家在 china 区域,推荐链为 L1=Alice, L2=Bob, L3=Carol,三方物流(非自履行 / 非面交)。

| 步骤 | 资金流 | 金额 |
|---|---|---|
| ① 买家钱包余额扣 | buyer.balance -100 | -100 WAZ |
| ② 进托管(escrow) | escrow +100 | +100 WAZ |
| ③ 卖家发货 / 买家确认 | 触发 settlement | — |
| ④a 平台费 50%(`protocol_fee_rate_shop` × 0.5) | escrow → `protocol_reserve_pool` | 1 WAZ |
| ④b 平台费 50%(`protocol_fee_rate_shop` × 0.5) | escrow → `sys_protocol`.balance | 1 WAZ |
| ⑤ 物流费 5%(hardcoded) | escrow → logistics 账号 | 5 WAZ |
| ⑥ 协议基金费(`fund_base_rate` = 1%) | escrow → `global_fund`(PV 经济池) | 1 WAZ |
| ⑦ 分享佣金(`commission_rate` = 10%) | escrow → 推荐链 L1/L2/L3 | 10 WAZ |
| ⑧ 卖家净收 | escrow → seller.balance | 83 WAZ |

> **物流分支**:`logistics_id IS NULL`(self-fulfill)或 `fulfillment_mode=in_person`(面交) → 物流费 = 0,seller 净收 88 WAZ。
> **二手分支**:`source=secondhand` → 平台费率改 1%(对 2%),物流逻辑同上。

分享佣金 10 WAZ 怎么拆给 L1/L2/L3?

```
LEVEL_RATES = { L1: 70%, L2: 20%, L3: 10% }
→ Alice 拿 7 WAZ
→ Bob   拿 2 WAZ
→ Carol 拿 1 WAZ
```

**Region cap**:如果 buyer 在 `region_config.max_levels = 1` 的国家(例如多数欧盟国),则只 Alice 拿钱,Bob/Carol 那部分**入 `commission_reserve`(三级公池)**。链断(`redirect_chain_gap`)/推荐人被封(`redirect_orphan_sponsor`)/区域截断(`redirect_region_cap`)/`max_levels=0` 整池 —— **所有没发出的佣金统一入 `commission_reserve`**(2026-06-04 三科目解耦后:佣金兜底不再进 `charity_fund` 或 `global_fund`)。`commission_reserve` 为独立科目,**只进不出**,用途由治理决定。

---

## 4. 关键费率一览(`protocol_params` 默认值)

| 参数 | 默认 | 上限 | 解释 |
|---|---|---|---|
| `protocol_fee_rate_shop` | 2% | 2% | 商家订单平台费（RFC-008 硬帽 2%,只减不涨,#112）|
| `protocol_fee_rate_secondhand` | 1% | 2% | 二手订单平台费（RFC-008 硬帽 2%,只减不涨,#112）|
| `default_commission_rate` | 5% | 50% | 参数表默认值(预留,商品当前未读此参数) |
| products.commission_rate(列默认) | 10% | 50% | **实际生效的新商品佣金率**(商家上架时可改;下单时快照入 orders.snapshot_commission_rate) |
| `fund_base_rate` | 0(当前费率)| 1% | 开启需治理决策,且 RFC-008 硬帽为 1% |
| `order_insurance_rate` | 1% | 10% | 买家自选保险费率 |
| `skill_fee_rate` | 5% | 30% | 技能市场销售费率(独立流转,不入 PV/佣金) |
| `waz_usdc_rate` | 1.0 | — | 1 USDC 兑换 WAZ |
| `usdc_min_withdraw_waz` | 10 | — | 最低提现额(防垃圾提现 gas 浪费) |
| `kyc_required_withdraw_waz` | 1000 | — | 单笔 ≥ 此值强制 KYC(反洗钱) |
| `kyc_daily_cumulative_waz` | 3000 | — | 24h 累计 ≥ 此值强制 KYC(防 smurf 分拆) |

---

## 5. 推荐(PV)经济池

PV(Personal Volume)在当前系统中是参与记录;分享佣金以真实商品成交为唯一触发条件:

- **L1=70% / L2=20% / L3=10%**,固定不变,仅按真实成交计酬,无升级费、无团队计酬、无静态收益
- **Region cap**:每个国家依监管设 max_levels(欧盟多为 1,部分亚洲为 3)
- **拿奖必须有 sponsor 关系**,孤儿用户(无 sponsor)拿不到推荐佣金(原始来源:商家分享链 `product_share_attribution`)
- **回流路径透明**:任何"没人拿"的佣金都进 `commission_reserve`(三级公池,独立科目,只进不出,治理决定用途);PV 资金池(`global_fund`)仅由每订单 1% base 注资

> ✅ **计酬只与真实价值创造挂钩**:① **零加入费**(免费参与)② 报酬**按真实商品成交**(非团队提成)③ **无静态 / 被动收益**(不参与不得利)。详见 `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`。

---

## 6. 三个独立资金科目(2026-06-04 解耦)

协议有三个互不流通的独立资金科目:

| 科目 | 注资来源 | 用途 | 出账 |
|---|---|---|---|
| **`charity_fund`** 慈善基金 | 主动捐赠 + 还愿转入 | **专款专用于慈善许愿板块** | DAO 治理拨付 |
| **`commission_reserve`** 三级公池 | 所有没发出的佣金(链断/无效 sponsor/区域截断/`max_levels=0`/opt-out 放弃/escrow 到期) | 协议储备,**只进不出** | 用途由治理决定(暂不出账) |
| **`global_fund`** PV 资金池 | 每订单 1% base(`fund_base_rate`) | 预留池(匹配奖励引擎已切除,当前无消费方) | — |

> **Category C(2026-06-16):匹配奖励引擎已切除(#401)。** PV 匹配奖励的兑付路径已从公开代码移除(no-op stub);完整引擎内部归档,重启需法律/治理放行 + 重接,非翻 flag。**中性的【参与记录】**(PV 计算 / 累积 / 放置树,`participationRecordingActive` 默认 ON)保留不受影响。**PV 仅为参与记录,不是收益、不可兑付、不构成 entitlement 或 payout 承诺。** 详见 [`REWARD-ENGINES-DECOUPLING.md`](REWARD-ENGINES-DECOUPLING.md)。
>
> **EN:** PV-pairing **payout** is gated OFF by default (`matchingRewardsActive`: requires both the operational switch and the legal/governance-clearance flag; fail-closed). The matching-settlement path is quarantined in `src/pwa/internal/pv-settlement.ts` (enabled or excised at the public flip). Neutral participation recording (`participationRecordingActive`, default ON) is a separate gate. **PV is a participation record only — not income, not redeemable, no entitlement.**

### `charity_fund` 来源(进项)

| 进项 | 触发场景 | 落点科目 |
|---|---|---|
| 主动捐赠 | 买家下单时勾选 0.5% / 1% / 2% / 5% | `charity_fund` |
| 还愿转入 | 受助人还愿,不可达原施善人或主动选基金 | `charity_fund` |

> 注:佣金兜底(链断/orphan/region cap/`max_levels=0`)2026-06-04 起**全部入 `commission_reserve`**,不再进 `charity_fund`。
> **测评免单 + 争议结算不入任何协议科目**:测评 reach 退款 = 商家↔达人点对点(达标退、不达标商家留为销售收入);争议判决(refund_buyer/release_seller/partial_refund/liability_split) = 买卖双方按责对等再分配。两者均无"罚没入慈善"机制。

### 出账规则(治理决定)

- **不能挪作运营**(协议运营靠平台费,基金严格分账)
- 流出需按当前治理和审批规则执行;未启用的自动化流转不得被宣称为已生效
- 实时余额公开:`GET /api/charity/fund/balance`

---

## 7. 协议运营方(`sys_protocol`)账户

### 进项

- 平台费(`protocol_fee_rate_shop` 2% / `protocol_fee_rate_secondhand` 1%)
- 技能市场协议费(`skill_fee_rate` 5%)
- **不**包含分享佣金、不**包含**公益基金

### 出项(覆盖基础设施)

- 域名 / SSL / Cloudflare
- Railway 服务器
- USDC gas 中继(用户充提 USDC 时,协议代付部分 gas)

### 当前透明度承诺

- 所有 `sys_protocol` → 外部地址的转账写 `audit_logs`,可查
- 季度公开账目(待报告流程完成后启用)

---

## 8. 不承诺什么(risk disclosure)

- ❌ 协议不承诺 WAZ 价格稳定(虽 1:1 锚 USDC,但合约层面是托管模型,不是稳定币 LP)
- ❌ 协议不承诺推荐收益(取决于真实交易,不是邀请人数)
- ❌ 协议不承诺基金池每年都能分红(基金用途由治理决定,可能全部用于公益项目)
- ❌ 协议不做投资建议(分享佣金 ≠ 投资回报)
- ⚠️ 明确标记为 SANDBOX / 本地开发的数据库可以重置;线上生产网络不得被当作沙盒

---

## 9. 治理(参数怎么改)

所有费率/上限都在 `protocol_params` 表,由 admin 调整,改动写入 `protocol_params_log`(append-only)。

- 当前阶段:经授权的 operator 调整,所有改动写入 append-only 日志
- 渐进治理阶段:参数改动按公告期 → 投票 → 生效的流程迁移
- 宪法级参数和分佣合规边界需多签 + 长公告期

公开端点:
- `GET /api/governance/params` — 当前所有参数 + 来源
- `GET /api/governance/params/:key/history` — 单参数历史改动
- `GET /.well-known/webaz-protocol.json` — 协议 manifest(含信任锚 / roadmap / network state)

---

## 10. 验证你看到的数字

任何用户都可以验证以下事实:

| 想验证什么 | 怎么验 |
|---|---|
| 当前协议费率 | `GET /api/governance/params?key=protocol_fee_rate_shop` |
| 我这笔订单分给谁了 | `GET /api/orders/:id/chain`(订单事件链) |
| 公益基金当前余额 | `GET /api/charity/fund/balance` |
| 协议运营方进出账 | `GET /api/wallets/sys_protocol/transactions`(launch 后启用) |
| 我的推荐链 | `GET /api/me/sponsor-path` |

---

## §11 经济博弈原则 / Economic Game-Theory Principle

> **贡献与收益对等,风险与质押挂钩。**
> Reward equals contribution; risk scales with stake.

WebAZ 不靠道德约束长尾市场。纯道德 = 0 enforcement;博弈 = 用经济成本让作弊不划算。
WebAZ doesn't rely on morality; it uses economic cost to make cheating uneconomic.

### 原则 vs 机制:必须分层 / Principle vs Mechanism: must be layered

以下每一处应用,**原则**(贡献与收益对等)是 **永久承诺**(改它 = 违反元规则);**机制**(具体公式、阈值、权重)是 **永远 DAO 可调的协议参数**(落 `protocol_params` 表,走 RFC + 多签)。

把未决机制写成既成事实 = 双重违规(**#4 不撒谎** + **#9 算法即协议**)。本节严格遵循该分层 — 具体公式 / 曲线 / 阈值见 [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §6(由 phase D DAO + 专业团队制定)。

For each application below: the **principle** ("reward = liability") is a **permanent commitment** (changing it = meta-rule violation); the **mechanism** (concrete formula / threshold / weight) is **always DAO-tunable protocol parameters** (in `protocol_params` table, via RFC + multisig).

Writing an undecided mechanism as fait-accompli = double violation (**#4 no-lies** + **#9 algorithm-as-protocol**). This section strictly observes that layering — concrete formulas / curves / thresholds defined in [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §6 (decided by phase-D DAO + professional team).

### 三处具体应用 / Three concrete applications

1. **卖家 stake : 销售红利对等** / Seller stake : sales upside
   - 商品分类越高风险(restricted)→ stake 倍数越高(3.0× base)
   - 想要免佣金的流量 → 必须先质押"数字履约保证金"
   - 设计原则:卖家拿走多少销售红利 → 承担多少买家保护责任

2. **贡献者 stake : 贡献红利对等** / Contributor stake : contribution upside
   - 拿高回报的贡献者 → 承担高连带责任(同 PR 关联的 bug 按贡献追溯)
   - 设计原则:贡献者拿走多少回报 → 承担多少相应责任
   - ⚠️ **具体的贡献度量与回报机制,不在本节定义**。
     回报锚定"真实贡献的累积量 × 生命周期衰减",**不锚定关系网络中的位置**。
     完整框架见 [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md)。
     具体维度 / 权重 / 曲线 / 形式由 phase D DAO + 专业团队制定并持续演化。
   - ⚠️ **贡献类型 ≠ 身份特权**(详 framework §2.1④ + §4.2):
     立项(把协议从零立起来)+ 维护性贡献(审核合并 / 定方向 / 答疑 / 运维)是
     **真实贡献类型**(类型 5、6),按"做了什么 × 被依赖度 × 衰减"计入,
     **不是创始人身份保底**。任何"凭创始人 / 早期身份的收益底线"违反 #5 不偏袒。
     创始人若因同时做了立项+维护+代码而累积量很高 → 是【算出来的】,
     晚来者做同等贡献获同等回报,尺子对所有人一致。

3. **推广者 stake : 流量贡献对等** / Promoter stake : referral upside
   - 推广者的回报锚定其"真实带来的成交"(per-order 显式归因),**不锚定下线人头**
   - 设计原则:推广者拿走多少流量分润 → 承担多少反欺诈连带责任
   - 合规边界见 [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](PARTICIPATION-ATTRIBUTION-COMPLIANCE.md)(反纯撸毛、地区门控、深度上限)/ Compliance bounds: see [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](PARTICIPATION-ATTRIBUTION-COMPLIANCE.md)
   - 奖励参与为 **opt-in**(默认不参与,主动申请 + 知情同意,见 [`RFC-002`](rfcs/RFC-002-rewards-opt-in.md))

### 关系层 / 估值层分离 / Relationship vs Valuation separation

WebAZ 的关系网络(二叉树)是 **关系层**:如实记录"谁在网络中的什么位置、谁通过谁而来",
不可逆。如何把关系层的事实换算成回报,是 **估值层**,
由 DAO 持续演化(见 [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §3)。

**关于位置的双层精确化**(详 framework §3.1 + §3.2):

> **§3.1 位置 ≠ 收益权**:位置不能是独立收益源;"占位就有钱"违反贡献锚定原则。
> **§3.2 位置可作收益公式的修饰参数**(乘法,非加法):
> `reward = f(contribution) × g(position) × h(decay) × ...`
> base 必须 > 0(零贡献 × 任何位置 = 零回报);position_weight 由 DAO 定,不能压过 base;非可继承(占位但不贡献的后代节点不分配)。

> **位置只是记录,不是独立收益权;但可作为乘法修饰参数。** 早行动者因累积时间长而贡献基数大,自然回报多;但回报的因是真实贡献,不是位置或来得早。零贡献的占位者,零回报(无视位置高低)。

WebAZ's network (binary tree) is the **relationship layer**: it records faithfully who sits where and who arrived through whom — immutable. Converting relationship-layer facts into reward is the **valuation layer**, evolved continuously by DAO (see [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §3).

**Position — two-layer precision** (see framework §3.1 + §3.2):

> **§3.1 Position ≠ entitlement**: position is NOT an independent income source; "holding a position → get income" violates contribution-anchoring.
> **§3.2 Position MAY be a modifier in the reward formula** (multiplicative, not additive):
> `reward = f(contribution) × g(position) × h(decay) × ...`
> base must be > 0 (zero contribution × any position = zero); position_weight set by DAO, cannot dominate base; non-inheritable (occupants without contribution don't pre-allocate).

> **Position is record, not independent entitlement — but may serve as a multiplicative modifier.** Zero-contribution placeholders earn zero (regardless of position).

### 非经济维度回报 / Non-economic dimensions of reward

本节**聚焦经济维度对等**(销售红利 / 贡献红利 / 流量分润)。WebAZ 同时通过**非经济维度**回报贡献,这些维度有各自的"对等机制"在独立文档中约束,本节不重复:

This section **focuses on economic-dimension parity** (sales / contribution / referral upside). WebAZ also rewards contribution via **non-economic dimensions**, each with its own parity mechanisms in separate docs:

| 维度 / Dimension | 约束文档 / Constraining doc |
|---|---|
| Reputation(信誉评分 / 评级) | reputation 系统(协议层) / Reputation system (protocol layer) |
| 治理权重(投票权 / RFC 影响力) | [`CHARTER §3`](CHARTER.md)(多签矩阵)+ phase D DAO 投票规则 / Multisig matrix + DAO voting rules |
| 永久 co-author 署名(贡献历史 / 公开可验) | [`DCO.md`](DCO.md)(sign-off 留痕)+ git 历史不可篡改 / DCO sign-off + immutable git history |
| Anchor handle(协议级身份) | 协议层 anchor 系统(独立稀缺资源)/ Protocol-layer anchor system |

→ 经济维度只是 reward 的**一个**面。把 §11 当成"贡献回报的全部"会窄化 **#10 参与者即 webazer** 的内涵(监管 / 安全 / 治理 / 社区贡献者同样是 webazer,见 [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §4.1 末段)。
→ Economic dimension is **one** facet of reward. Treating §11 as the totality of contribution reward would narrow **#10 (participant = webazer)** — regulatory / security / governance / community contributors are equally webazers.

### 对照元规则 / Maps to meta-rules

此原则是 **#5 不偏袒 + #6 不滥用 + #9 算法即协议 + #10 参与者即 webazer** 的经济学具体化,
**不是新元规则**(元规则 10 条 lock,见 [`META-RULES-FULL.md`](META-RULES-FULL.md))。
This is the economic concretization of **#5 + #6 + #9 + #10**, **not a new meta-rule** (10 meta-rules locked).

---

## English Summary

WebAZ is an agent-native commerce protocol with **parameterized fees and audit-logged cash flows**. The operator earns only from (1) explicit platform fee 1-2%, and (2) slashing of bad actors in disputes. The public-good fund (`charity_fund`) is funded by 1% per order + chain-gap rerouting + voluntary donations, and is governed separately from operations. Three-tier sharing (L1 70% / L2 20% / L3 10%) is affiliate-style revenue sharing on real sales, capped per-region according to local regulation.

The binary/PV-pairing reward engine ships **disabled by default** (Category C two-switch `matchingRewardsActive`: operational on-switch + legal/governance clearance, fail-closed) and its settlement path is **quarantined** in `src/pwa/internal/pv-settlement.ts`, to be enabled or excised at the public flip. Neutral participation recording (PV ledger / placement tree) is on by default but is a **participation record only — not income, not redeemable, no entitlement**. All numbers in `protocol_params` table, DAO-tunable post-launch.

---

> **Source of truth**: `src/pwa/server.ts` `DEFAULT_PARAMS` array + `protocol_params` table.
> **Last reviewed**: 2026-05-30
> **Owner sign-off**: holden (current operating model)
