# 参与归因与合规边界 / Participation Attribution & Compliance Boundaries

> **WebAZ 的奖励只来自真实商品成交。** 零入会费、零购物门槛、对招募 / 拉人**不支付任何报酬**;PV 仅是参与与归因记录。
> 本文说明两套奖励系统的性质、默认状态与门控边界;详尽的逐辖区法律分析与任何受门控引擎的内部设计,
> 作为**内部法务工作材料**维护,**应监管 / 审计要求可提供**。
>
> **EN.** WebAZ rewards come **solely from real product sales** — no joining fee, no purchase threshold, and **nothing
> is ever paid for recruiting**; PV is only a participation & attribution record. This document describes the nature,
> default state, and gating boundaries of the two reward systems; the detailed per-jurisdiction legal analysis and the
> design of any gated engine are kept as **internal legal working material, available to regulators / auditors on request.**

---

## 立场要点 / Posture

1. **PV / 位置 = 参与记录、归因记录(participation / attribution record)。**
   它**不是**收益、兑付权、投资回报、所有权、entitlement 或任何承诺。
   *PV / position is a participation & attribution record — **not** income, a payout right, an investment return,
   ownership, an entitlement, or any promise.*

2. **两套语义独立的系统 / Two semantically independent systems:**
   - **系统 A · 推荐佣金 (commission)** — **零入会费、零购物门槛**,仅按**真实商品成交**分润的联盟营销 / revenue-sharing
     (类比 淘宝客 / Amazon Associates)。pre-launch 阶段层级**保守收紧**(见下「默认保守」)。
   - **系统 B · 匹配奖励 (matching rewards)** — **默认关闭(disabled by default)**。它由一个 **fail-closed 双闸**门控
     (`matching_rewards_active` + `matching_rewards_activation_cleared` — 运营开关 + **法律 / 治理放行**;缺一即关),
     结算路径**隔离**在 `src/pwa/internal/pv-settlement.ts`,公开 / 开源时**启用(须律师背书)或直接 excise**。
     **它当前不运行,不产生任何兑付。**

3. **默认保守 / Conservative by default.** 运营方对每个辖区采用**最严格**解释;默认配置取最保守档
   (pre-launch:佣金层级全局 clamp 至 ≤1;匹配奖励全局 OFF)。任何放宽都需**事前法律 / 治理放行**。

4. **协议层 vs 应用层 / Protocol vs application.** 协议层技术中性;运营某个 instance 的**应用层主体自行承担本地合规责任**
   (审计本地法律、配置区域参数、决定是否取得牌照)。

5. **中性参与记录 ≠ 奖励 / Neutral recording ≠ rewards.** PV 的计算 / 累积 / 放置树是中性参与记录(默认 ON);
   匹配奖励兑付是另一个独立闸门(默认 OFF)。二者互不耦合。

---

## 门控与诚实披露 / Gating & honest disclosure

- **代码层双闸**:`src/pwa/pv-kill-switch.ts` —— `participationRecordingActive`(默认 ON,中性记录)与
  `matchingRewardsActive`(默认 **OFF**,fail-closed)。
- **隔离 / 可摘除**:匹配结算路径集中在 `src/pwa/internal/pv-settlement.ts`,公开翻转时启用双闸或整体 excise。
- **界面层**:匹配奖励关闭时,promoter / 钱包 / MCP 接口只展示中性「参与记录」,不展示任何奖励 / 兑付指标。
- **无兑付路径**:匹配奖励引擎已切除(#401),公开代码无兑付逻辑、无资金拨付。

> 我们选择**主动、公开地披露**"存在一个默认关闭、fail-closed、可摘除的引擎",而不是把它藏起来 —— 透明本身是合规姿态的一部分。
> *We deliberately disclose that a disabled, fail-closed, excisable engine exists, rather than concealing it — transparency is part of the posture.*

相关 / Related: [`REWARD-ENGINES-DECOUPLING.md`](REWARD-ENGINES-DECOUPLING.md) · [`LEGAL-DISCLOSURES.md`](LEGAL-DISCLOSURES.md) · [`ECONOMIC-MODEL.md`](ECONOMIC-MODEL.md)

---

*详细的逐辖区合规矩阵、案例分析与受门控引擎的内部设计参数不在本公开文档内;它们作为内部法务工作材料维护,可应监管 / 审计要求提供。*
*The detailed per-jurisdiction matrix, case analysis, and gated-engine design parameters are not in this public document; they are maintained as internal legal working material and available to regulators / auditors on request.*
