# Arbitration Playbook / 仲裁手册

> **Status**: phase A draft v1.0(等用户 review)
> **Track**: meta-rule application(非新元规则,是 #2 / #5 / #6 / #8 / #9 的执行实现)
> **Audience**: arbitrators(已上岗)+ 申请者(onboarding §4.2 案例研读)
> **Author**: @seasonkoh
> **Created**: 2026-06-02
> **Parent**: [`GOVERNANCE-ONBOARDING.md`](GOVERNANCE-ONBOARDING.md)(申请 + 上岗规范)

---

## §0 立场 / Position

本手册是 arbitrator 履职时的 **决策框架** + **案例参照**,**不是机械算法**。

This is the arbitrator decision **framework** + **case reference**, **NOT a mechanical algorithm**.

⚠️ **每个 case 都是独立判决**;本手册提供常见模式的处理范式 + 必读注意事项,**不绑死你的判断**(framework §6 — 机制最终由 phase D DAO + 实践演化)。

⚠️ **Each case is an independent decision**. This playbook provides patterns + mandatory considerations, **does NOT bind your judgment**.

---

## §1 4 种结算路径 / 4 settlement paths

(对应 `webaz_dispute(action=arbitrate, ruling=...)`)

| 路径 / Path | 适用 / When | 资金 / Funds |
|---|---|---|
| **release_seller** | 卖家完全合规,买家恶意 / 误投 | escrow 全释放给卖家 |
| **refund_buyer** | 卖家完全违约 / 商品 fundamental defect / 假货 | escrow 全退买家;卖家押金 slash 入 charity_fund |
| **partial_refund** | 双方部分责任 / 商品有 partial issue 但非全废 | 按 `partial_refund_amount` 拆分,seller 得余,buyer 得退款部分 |
| **liability_split** | 第三方有责(物流 / 平台 bug)/ 多方责任 | 按 `liability_split` 数组分配(每项 user_id + amount) |

---

## §2 决策树 / Decision tree

```
case 进入仲裁
   ↓
Q1:证据是否充足?
   ├─ 不充足 → 要求 buyer / seller 补证据(72h),不立即裁决
   │           ⚠️ **必须显式调用 arbitrator_pause_auto_judge**(暂停 48h respondent 沉默自动判定时钟)
   │           否则被协议层 48h 自动判架空 — 见 §2.1
   └─ 充足 → Q2
       ↓
Q2:卖家是否完全违约?(假货 / fundamental defect / 长期 ghost)
   ├─ 是 → refund_buyer + slash seller stake
   └─ 否 → Q3
       ↓
Q3:买家是否完全恶意?(已确收 / 长期持有不退 / 撒谎证据)
   ├─ 是 → release_seller + slash buyer dispute deposit
   └─ 否 → Q4
       ↓
Q4:是否第三方有责(物流 / 协议 bug)?
   ├─ 是 → liability_split(写明每方金额,见 §4 Case 2 资金流分步)
   └─ 否 → partial_refund(按部分责任比例)
```

### 2.1 时钟冲突:arbitrator 补证据窗口 vs 协议自动判时钟 / Clock conflict

⚠️ **必读 — 协议层有 48h 自动判定时钟**:

`webaz_dispute` 工具规定:respondent 接案后 48h 沉默 → 协议自动 favor initiator(防 ghost arbitrator / 防滥用拖延)。

但本决策树 Q1 "补证据 72h" > 48h — 若 arbitrator 不显式暂停时钟,会出现:
- arbitrator 还在等 buyer/seller 补证据
- 协议层 48h 已到,自动判定 initiator 胜
- arbitrator 的"想等更多证据"被工具架空 → 错判

**正确做法**:
1. arbitrator 决定补证据时,**必须调用** `arbitrator_pause_auto_judge(dispute_id, reason, until_ts)`
2. `until_ts ≤ now + 168h`(7 天上限,防无限拖延)
3. 暂停期间协议层 48h 时钟冻结
4. 补证据期满 / 收到证据 → arbitrator 显式 resume(`arbitrator_resume_auto_judge` 或直接裁决)
5. 暂停 + resume 写 `disputes.audit_log`,可申诉时复审

**当前实施状态 / Current implementation status**(task #1093 stage 6,2026-06-02):

✅ **API 已实施 / API implemented**:
- `POST /api/disputes/:id/arbitrator-pause-auto-judge` — body: `{ reason, until_ts }`
- `POST /api/disputes/:id/arbitrator-resume-auto-judge`
- 时钟最大窗口:`protocol_params.arbitration_max_pause_hours`(default 168h = 7d,DAO 可调)
- 重复暂停允许(extend) — 每次写 `disputes.audit_log`(append-only JSON)
- 仅 `assigned_arbitrators` 可调用;无 Iron-Rule Passkey(routine arbitrator 动作,审计可追溯)
- `autoSettleExpiredDisputes` cron 已加 pause 检测:`auto_judge_paused_until > now` → skip auto-judge

时钟冻结的具体效果:
1. **deadline 真延后**:pause 时把 `respond_deadline` 和 `arbitrate_deadline` 都按 increment 秒数延后(increment = until_ts − now,repause 时 = until_ts − existing_paused_until,clamp 0)
2. **cron 跳过**:`dispute-engine.ts` 的 cron 在每个 dispute 循环开始检查 `auto_judge_paused_until`;若仍在暂停期则 `continue`
3. **respondent 提交反驳**:`/respond` 端点硬检查 `respond_deadline`,所以 deadline 延后后,respondent 仍能在暂停期内提交反驳(不会被旧 deadline 拒)
4. **暂停过期后自动恢复**:pause 过期后 cron 自然恢复正常处理(此时 deadline 已被延后,如果证据齐全则正常裁决,否则触发 auto-judge 但用的是新 deadline)

⚠️ **半语义**:resume(早期解冻)不回滚 deadline 延后 — 即如果 pause 7d 但 1d 后 resume,deadline 仍延后 7d。
理由:仲裁员既然选择延期就承担该延期的"超额给方"成本;repause 缩短无效果(只 audit_log 记)。

---

## §3 Phase A 案例参照 / Phase A case references

⚠️ **以下案例 phase A 暂无真实数据**(0 真用户 = 0 真争议)。本节将在 launch 后真实案例积累到 ≥ 5 时填充,留作 onboarding 学习材料。

⚠️ **Public precedent coverage is still limited.** This section will expand as eligible real disputes are resolved and publishable cases accumulate(≥ 5).

phase A 申请者参考 **模拟案例**(下方 §4),phase B+ 之后 onboarding §4.2 引用真实案例。

---

## §4 模拟案例(onboarding 用)/ Simulated cases (onboarding use)

### Case 1:商品与描述不符 / Item not as described

**事实**:
- 商品标题:"全新 iPhone 16 Pro 256GB"
- 买家收货后:开箱视频显示是 128GB 翻新机
- 卖家辩称:发错货,愿意换货
- 买家:已经退换太麻烦,要求全退

**关键证据**:
- ✅ 开箱视频(buyer 上传,timestamp + 包装完整性)
- ✅ 卖家 listing 截图(title 含 256GB)
- ✅ IMEI 查询(显示翻新)

**判决方向**(供参考,不绑死):
- 主要责任:**卖家**(fundamental product mismatch)
- 路径:**refund_buyer**
- 押金处置:slash seller listing stake(per ECONOMIC §11 履约责任)
- 理由模板:"商品 IMEI 与 listing 描述不符,构成 fundamental defect。卖家提议换货不被采纳,因 listing 本身违规(假冒新机)。escrow 退买家,卖家 stake slash 入 charity_fund 以警示。"

### Case 2:物流卡顿 / Logistics stuck

**事实**:
- 订单已 paid → shipped → 物流方接单后 5 天无更新
- 买家催件,物流方无回应
- 卖家提供发货凭证(快递单号有效)

**关键证据**:
- ✅ 物流单号查询(显示"已揽件"无后续)
- ✅ 卖家发货 timestamp + 包装照
- ❌ 物流方未在 evidence 应答

**判决方向**(资金流分两步,**不要把所有金额都塞 liability_split**):

**步骤 1 — 卖家正常结算**(卖家无责履约):
- escrow.total_amount → seller.balance(release_seller 子路径)
- 卖家 stake 不动

**步骤 2 — 物流方 stake 赔买家损失**:
- buyer 损失 = 商品未收到(等于 order.total_amount)
- logistics_user.stake → slash → buyer.balance
- 实际可赔金额 = `min(logistics_user.stake, order.total_amount)`

⚠️ **stake 不足兜底**(必须明示,protocol_params 待 DAO 决):
- 选项 A:`protocol_reserve_pool` 兜底差额(协议担)
- 选项 B:按比例(seller 让出部分货款补差)— 但卖家无责,违反 #5 不偏袒
- 选项 C:buyer 自担差额 — 也不公,buyer 无责
- **phase A 默认选项 A**(物流方治理失效,协议有连带责任改善 SLA)
- DAO 可调:`protocol_params.dispute_logistics_gap_coverage`(默认 'protocol_reserve_pool')

**关于 `protocol_reserve_pool` — 资金来源 + 防躺平追偿**:

| 维度 | 内容 |
|---|---|
| 来源 / Source | 协议费 50% 入此池(参 [`ECONOMIC-MODEL.md §3 ④a`](ECONOMIC-MODEL.md):每订单 `protocol_fee_rate_shop × 0.5` → protocol_reserve_pool)+ 失败活动罚没(测评免单 reach 不足卖家押金等)|
| 用途 / Use | 协议层兜底支出(本 Case 物流兜底 / 其他 SLA 失败兜底 / 治理小奖励)|
| 余额可查 / Balance | 公开 endpoint(待实施): `GET /api/protocol-reserve-pool/balance` |
| 池空时 / Empty pool | **兜底承诺不空头**:若池 < 差额 → arbitrator 走 §7 升级 maintainer 多签讨论(延迟兜底等池积累 / charity_fund 临时借调 / 协议参数调升降低再发生)|

**向物流方追偿规则**(防"协议兜底 → 物流躺平"反向激励):
- 兜底支出 = **物流方对协议的债务**(写 `users.debt_to_protocol` 字段)
- 物流方下次接单时 = 协议自动从其未来 stake/收益中**扣回**(优先于他自己提现)
- 累计债务 > 阈值(`protocol_params.logistics_debt_cap` 默认 1000 WAZ)= 物流方角色暂停,需偿清才能复职
- 申诉路径同 ONBOARDING §7.2:物流方有 14 天对债务有效性提出申诉(maintainer 多签 review)

→ 闭环:兜底 = **协议短期承担 + 长期追偿物流方**,非协议永远买单
→ 不鼓励物流方躺平(他失败一次,长期被扣回 + 角色风险)

**liability_split 数组写法**(正确)/ Correct format:
```js
const X = Math.min(logistics_user.stake, order.total_amount)  // 实际可赔
const Y = order.total_amount - X                              // 差额(协议兜底 + 物流方欠债)

liability_split: [
  { user_id: logistics_user_id, amount: X }   // 物流方现下立即赔
]
// Y > 0 时同步写:
//   protocol_reserve_pool → buyer.balance(立即补差额 Y)
//   users[logistics].debt_to_protocol += Y(物流方欠协议 Y,未来扣回)
```

理由模板(以 100 WAZ 订单 + 物流 stake 70 为例):
"卖家凭证充分(发货 + 包装),物流方接单后失联超 SLA(72h)。按 ECONOMIC §11 履约连带责任:
 (1) escrow 100 WAZ release 给卖家(完整履约);
 (2) logistics stake slash 70 WAZ → buyer 部分补偿(`X = min(stake=70, total=100) = 70`);
 (3) 差额 30 WAZ(`Y = total - X = 30`)由 protocol_reserve_pool 兜底,**同时记入物流方对协议债务 30 WAZ**(`debt_to_protocol`),下次接单收益自动扣回;
 (4) 协议兜底**不是免责通道** — 物流方欠债累计 > 1000 WAZ 角色暂停(`logistics_debt_cap`)。"

### Case 3:部分使用后申请退 / Partial use then return

**事实**:
- 买家购买耳机
- 使用 3 天后申请全退,理由"音质不满意"
- 卖家 listing 注明"主观满意度不在退货范围"
- 商品 ≥ 7 天退货政策

**关键证据**:
- ✅ 卖家 listing 退货政策截图(明确"主观满意度不退")
- ✅ 买家收货 timestamp(3 天前)
- ⚠️ 买家无客观 defect 证据

**判决方向**:
- 主要责任:**买家**(主观偏好,非协议保护范围)
- 路径:**release_seller**(7 天 in policy,但卖家声明涵盖此情形)
- buyer dispute deposit 不 slash(诉讼是 good-faith,无恶意)
- 理由模板:"协议级 7 天退货保护客观 defect,不保护主观偏好。卖家 listing 已声明 + 用户购买构成 informed consent。escrow 释放给卖家。买家 deposit 不 slash(无恶意),但本次 dispute 不成立。"

### Case 4:验证 claim 后发现造假 / Fake claim after verification

**事实**:
- 卖家声称商品"日本京都产 100% 棉 GOTS 认证"
- 买家发起 claim_verify
- 3 个 verifier 投票 → 2 个判 fake, 1 个判 pass
- 卖家提供"GOTS 证书"但 sha256 与官方 registry 不匹配

**关键证据**:
- ✅ 官方 GOTS registry 查询(显示卖家证书 hash 不存在)
- ✅ 2 个 verifier 上传比对截图
- ❌ 卖家无法提供有效溯源

**判决方向**:
- 主要责任:**卖家**(虚假声明,product attestation fraud)
- 路径:**refund_buyer + seller stake slash**(同 Case 1 模式)
- 额外:卖家 reputation 显著降 + 关联商品 listing 标"声明被推翻"(关系层永久记录)
- 理由模板:"GOTS 证书 hash 在官方 registry 中不存在,卖家 product attestation 虚假。退买家 + slash + 信誉降。"

⚠️ **关于投 pass 那位 verifier — 注意原则**:
- 该 verifier 偏离了**已查实的事实**(GOTS hash 造假已通过 official registry 客观证实)→ reputation 微降
- 惩罚依据 = **偏离已查实的事实**,**不是**"偏离多数票"
- 反例:若事实仍未定 + 投 pass 有合理依据(e.g. 卖家提供其他可信证书 + verifier 善意误判)→ **不罚**
- 教学要点:`outlier ≠ wrong`。少数派洞察 + 后被证实正确 = reputation 升;多数票 + 后被证实错误 = 集体微降(防羊群效应)
- 系统层 outlier 计数仅作**信号**,不直接触发惩罚(参 §6)

### Case 5:申诉之前的裁决 / Appeal of previous ruling

**事实**:
- 7 天前:arbitrator A 判 release_seller
- 今:buyer 提供新证据(开箱视频此前未上传),申请 appeal
- 新证据显示商品确实 defect

**关键证据**:
- ✅ 新视频 timestamp 早于原判决日(被 buyer 当时漏传)
- ✅ buyer 提供漏传理由(网络问题 / 操作失误)
- ⚠️ 原 arbitrator A 判决理由"证据不足"

**判决方向**:
- 主要责任:**新证据触发重审**
- 路径:**重新评估** → 若新证据成立:**refund_buyer** + 通知 arbitrator A(reputation 不变,因为原判决基于当时可用证据合规)
- 理由模板:"appeal 引入新证据,基于完整证据集重新裁定。原判决 arbitrator A 基于当时证据合规,无过错。新证据成立 → refund_buyer。"
- 注意:**不是 arbitrator A 判错**,而是证据补全后结论变 — arbitrator A 的 outlier 计数不增

---

## §5 必读注意事项 / Mandatory considerations

### 5.1 利益冲突 / COI

- ❌ 不能审涉及自己 buyer / seller 交易对手的 dispute(系统自动检测 + 拒绝接案)
- ❌ 不能审 verifier(自己投票过的关联 claim)
- ❌ 不能审 referral chain 直接关联用户(L1 / L2 / L3 promoter)
- ⚠️ 系统检测漏的 COI → arbitrator 主动 recuse + 通知 maintainer

### 5.2 真人 Passkey 铁律 / Iron-Rule

- 仲裁裁定 **必须** Iron-Rule Passkey 签发(SECURITY.md §Iron-Rule #1)
- 在 PWA 完成 `webaz_dispute(action=arbitrate)` ceremony
- agent 代签 = 协议级违规 = reputation 大幅降 + 自动 deactivate

### 5.3 4 种结算的选择标准 / Choosing among 4 paths

| 复杂度 / Complexity | 优先 | 备选 |
|---|---|---|
| **单方完全责任,清晰** | release_seller / refund_buyer | — |
| **双方都有责任** | partial_refund | liability_split(若有第三方) |
| **多方责任(物流 / 协议 / etc.)** | liability_split | — |
| **不确定** | 要求补证据(72h),不强行判 | 通知 maintainer 求助 |

### 5.4 押金 slash 标准 / Stake slashing criteria

- ✅ slash:**有意违规**(假货 / 假声明 / 长期 ghost / 恶意 dispute)
- ❌ 不 slash:**善意失误**(发错货 + 主动愿意纠正 / 物流延误 / 误投诉)
- 灰色:看 reputation 历史 + dispute 频次 + 主动纠正姿态
- slash 金额按 `protocol_params.dispute_slash_*` 系列(DAO 可调)

### 5.5 裁定理由 / Ruling reason

**MUST**:
- 永久记录在 `disputes.verdict_reason`(协议级公开)
- 中英双语(对应 #1 当一切可见)
- 引用具体 evidence(`evidence.id`)
- 引用元规则 / framework / SECURITY.md 章节(可追溯)

**MUST NOT**:
- ❌ 主观情绪(e.g. "我觉得 buyer 是坏人")
- ❌ 无证据论断(e.g. "推测 seller 一定是诚信的")
- ❌ 道德审判(e.g. "下次应该更小心")
- ❌ 暴露未涉案第三方 PII

---

## §6 Outlier 检测 / Outlier detection

### 6.1 标记 vs 触发(必须分离)/ Mark vs Trigger (must separate)

⚠️ **核心原则:outlier 标记锚"偏离平均",但 deactivate 触发必须锚"被复核证明判错"**。

⚠️ **Core principle: outlier flag is anchored to "deviation from average", but deactivate trigger MUST be anchored to "ruled wrong upon review"**.

| 层 / Layer | 锚定 / Anchored to | 后果 / Consequence |
|---|---|---|
| **outlier 标记**(信号)| arbitrator 裁决偏离同案多 arbitrator 平均 / verifier 投票偏离多数 | 仅作信号显示在 leaderboard;**不直接触发任何惩罚** |
| **deactivate 触发**(后果)| 申诉复核确认判错 / 事实查证后证明 reasoning 错误 | reputation 显著降;累计 N 次 → 自动 deactivate |

**为什么分离**(防羊群效应):
- 一个 arbitrator 总判正确但**常偏离多数** → 不该被 deactivate(否则正确独立判断者被多数挤掉)
- 一个 arbitrator 总判错但**总跟多数** → 应该被 deactivate(集体错也是错)
- outlier 标记可以告诉 ta "你跟多数不一样,请确认 reasoning";但 deactivate 必须等到**事实查证**后

### 6.2 阈值参数 / Threshold parameters

⚠️ 命名锚定:"confirmed_wrong" 不是 "outlier" — 触发 deactivate 的是"被证明判错"次数。
实际实施使用 `governance_auto_deactivate_*` namespace(适用 verifier + arbitrator;phase A solo maintainer 可调,phase B+ DAO 治理):

```
governance_auto_deactivate_threshold_count    default 5     被复核确认判错累计次数阈值
governance_auto_deactivate_threshold_pct      default 0.3   被确认判错比例阈值(≥30%)
governance_auto_deactivate_min_sample         default 10    最小样本数(防小样本误杀)
governance_auto_deactivate_cron_hours         default 24    cron 扫描间隔(小时)
```

触发条件(AND): `tasks_wrong ≥ threshold_count` **AND** `tasks_wrong / tasks_done ≥ threshold_pct` **AND** `tasks_done ≥ min_sample`

outlier 标记仅作 leaderboard 信号,无触发,无 protocol_params(由 leaderboard spec 计算)。

**Phase A status**: verifier auto-deactivate ✅(task #1093 stage 5);arbitrator deferred phase B(需先加 `arbitrator_stats` + verdict overturn 机制)。

### 6.3 与 onboarding §5.3 一致 / Consistent with onboarding §5.3

[`GOVERNANCE-ONBOARDING.md §5.3`](GOVERNANCE-ONBOARDING.md) outlier 惩罚条款已锁定同样原则:**罚的是判错,不是判得不一样**。两份 doc 必须同步演化,如有修改需双方同步。

---

## §7 升级 / 转交 / Escalation

### 7.1 单 arbitrator 不确定 → 多 arbitrator 联审

触发:
- arbitrator 主动申请 "需要联审"
- dispute_amount ≥ `protocol_params.arbitration.escalation_amount_threshold`(默认 1000 WAZ)
- 涉及法律 / 监管敏感(用户主动 flag)

机制:
- 系统随机指派 ≥ 2 个其他 arbitrator(扣除 COI)
- 多数派裁决(2/3 一致即可)
- 落 `disputes.assigned_arbitrators` 数组,每个裁决独立记录

### 7.2 协议级 bug 怀疑 → 通知 maintainer

若 arbitrator 怀疑 case 是协议 bug 触发(非用户责任):
- 不直接 release_seller / refund_buyer 任一方(防错判)
- 标 `disputes.status = 'protocol_review'`
- 通知 maintainer 群,期间冻结 escrow
- 若 maintainer 确认协议 bug → buyer + seller 各方均无责,escrow 退原方 + 协议方面打补丁
- 走 SECURITY.md 报告流程 + 入 Hall of Fame(per SECURITY-BOUNTY)

---

## §8 关系层记录 / Relationship layer recording

每次裁决:
- 入 `order_state_history`(`actor_id = arbitrator user_id`)— 永久不可逆
- 入 `disputes.verdict_reason` — 永久不可逆
- 即便 arbitrator 卸任 / 退出协议,**裁决记录永久保留**(对应 #1 当一切可见 + #2 代码即规则)

**这条原则** 保护 buyer + seller 的协议级正义:
- 历史裁决可被未来 DAO 审议(改判机制由 RFC 决定)
- 错判的 arbitrator 不能"删自己历史"(关系层不可写)

---

## §9 元规则映射 / Meta-rule mapping

```
#1 当一切可见:✅ 裁决理由 + evidence 公开可审计
#2 代码即规则:✅ 4 路径 + Iron-Rule + COI 检测全由代码 enforce
#5 不偏袒:✅ COI 强制 recuse;outlier 检测防系统性偏向
#6 不滥用:✅ slash 标准透明;arbitrator 滥用 outlier 触发自动 deactivate
#8 最小介入:✅ 不能审则要求补证据(72h)而非强判;升级机制防独断
#9 算法即协议:✅ 4 路径在代码;slash 阈值 + outlier 阈值 protocol_params 化
```

**Iron-Rule 技术边界**:
- ✅ 仲裁裁定本身就是 Iron-Rule #1 节点(已存在)
- ✅ 多 arbitrator 联审不引新铁律,沿用 #1

---

## §10 关联文档 / Related docs

- [`GOVERNANCE-ONBOARDING.md`](GOVERNANCE-ONBOARDING.md)(parent,资格 + 申请 + 卸任)
- [`SECURITY.md §Iron-Rule`](../SECURITY.md) — 真人 Passkey 7 条路径
- [`META-RULES-FULL.md`](META-RULES-FULL.md)
- [`CHARTER.md §3.2`](CHARTER.md) — 多签 + 权责分离
- [`ECONOMIC-MODEL.md §11`](ECONOMIC-MODEL.md) — 经济博弈原则(slash 标准底层)
- [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) — 关系层 vs 估值层
- [`GOVERNANCE-LEADERBOARD-SPEC.md`](GOVERNANCE-LEADERBOARD-SPEC.md)(PR #9 merge 后激活)— accuracy / response_time 4 维度

---

**Last reviewed**: 2026-06-02
**Status**: draft v1.0
**Next**:
- review 后落 schema(`arbitration.*` protocol_params)
- launch 后填充 §3 真实案例(≥ 5)
- onboarding §4.2 案例研读引用本手册 §4 模拟案例
