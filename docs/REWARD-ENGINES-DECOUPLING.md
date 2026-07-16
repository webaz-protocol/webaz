# WebAZ 双奖励引擎解耦 / Two decoupled reward engines

> WebAZ 内部有两套**完全解耦**的奖励系统。本公开文档说明它们的**性质、默认状态、安全边界与门控**。
> 任一引擎的内部结算机制 / 参数作为**内部架构材料**维护,不在本公开文档内。
>
> ⚠️ **匹配奖励(系统 B)默认关闭,当前不是一条赚钱路径。** PV / 位置仅为参与记录,不是收益、不可兑付、不构成 entitlement 或 payout 承诺。
>
> **EN.** WebAZ has two **fully decoupled** reward systems; this public doc covers their nature, default state, safety
> boundary, and gating. Each engine's internal settlement mechanics / parameters are kept as internal architecture
> material, not in this public doc. **Matching rewards (System B) are disabled by default and are not an earning path.**

---

## 系统 A · 推荐佣金 (commission) — 默认运行,但守恒且当前保守收紧

- **性质**:消费即时确定的联盟佣金分账(zero-fee affiliate revenue-sharing),仅按**真实商品成交**计酬。
- **资金来源**:订单内的 `commission_pool`(商家自定义比例),**不**凭空印钱。
- **守恒**:`seller_net + protocol_fee + commission_pool + fund_base = total`,审计全程 sum-check 绿。
- **结算**:订单 confirm(真实收货)时同步分账,写 `commission_records`。
- **资格门**:L1 须 verified buyer(真实收货完成)才能领取,否则该份 redirect 进 `commission_reserve`(独立公池,只进不出)。
- **当前默认保守**:佣金层级全局 clamp 至 ≤1(放宽需事前法律 / 治理放行)。

## 系统 B · 匹配奖励 (matching rewards) — 默认关闭、fail-closed、可摘除

- **默认状态**:**关闭(OFF)**。
- **Category C 双闸**(`src/pwa/pv-kill-switch.ts`):仅当 `matching_rewards_active='1'` **且**
  `matching_rewards_activation_cleared='1'`(运营开关 + **法律 / 治理放行**)时才可能运行;缺参 / 读失败一律 **fail-closed**。

| 闸门 / Gate | 默认 | 控制 |
|---|---|---|
| `participationRecordingActive` | **ON**(fail-safe) | 中性参与记录:PV 计算 / 累积 / 放置树(非兑付) |
| `matchingRewardsActive` | **OFF**(fail-closed) | 匹配结算 / 兑付路径(须双闸同时为 `'1'`) |

- **隔离 / 可摘除**:整条匹配结算路径集中在 `src/pwa/internal/pv-settlement.ts`;公开 / 开源翻转时二选一 ——
  治理把双闸置 `'1'` **启用(须律师背书)**,或直接 **excise** 该模块(stub 工厂返回 disabled),不影响中性参与记录。
- **无兑付路径**:匹配奖励引擎已切除(#401),公开代码无兑付逻辑、无资金拨付。
- **界面层**:关闭时,promoter dashboard / 钱包收入 / MCP 接口只展示中性「参与记录」,隐藏一切兑付 / 奖励指标。

---

## 解耦:为什么两套互不挤占 / Decoupling

- **不同链、不同钱、不同触发**:系统 A 走推荐链、用订单内 `commission_pool`、settle 时即时分账;
  系统 B 是派生**积分**(不从订单金额扣减),与 A 不抢同一笔钱。
- **唯一连接点**:每单 1% `fund_base` 单向蓄进协议资金池(系统 B 启用后的现金来源)。这是**资金管道,非逻辑耦合** ——
  调一边不影响另一边。commission 的兜底 / 溢出统一进 `commission_reserve`(独立科目,只进不出)。

## 治理视图 / Governance view

- **Per-user**:`GET /api/wallet/income` —— 匹配奖励关闭时不读其记录、不计入总收入。
- **协议级(admin-gated)**:`GET /api/admin/economic-summary` —— 两引擎拨付量分别可查;运营财务仅 protocol admin 可见(隐私第一)。
- 三资金科目分离:`global_fund`(仅 1% fund_base 注资)/ `commission_reserve`(只进不出)/ `charity_fund`(纯净,仅慈善)。

---

*系统 B 的具体匹配机制与参数作为内部架构材料维护,可应审计要求提供;不在本公开文档内。*
*System B's specific matching mechanics and parameters are kept as internal architecture material (available on audit request), not in this public doc.*
