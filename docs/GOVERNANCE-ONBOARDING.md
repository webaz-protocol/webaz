# Governance Onboarding / 治理上岗规范

> **Status**: phase A draft v1.0(等用户 review)
> **Track**: meta-rule application(非新元规则,是 #1 / #5 / #6 / #7 / #10 的执行实现)
> **Author**: @seasonkoh
> **Created**: 2026-06-02
> **关联** / **Related**: [`SECURITY.md`](../SECURITY.md)(安全报告 + 致谢机制)· [`GOVERNANCE-LEADERBOARD-SPEC.md`](GOVERNANCE-LEADERBOARD-SPEC.md)· [`ARBITRATION-PLAYBOOK.md`](ARBITRATION-PLAYBOOK.md)· [`rfcs/RFC-002-rewards-opt-in.md`](rfcs/RFC-002-rewards-opt-in.md)(反诱导设计借鉴)· [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md)

---

## §0 顶层立场 / Position statement

⚠️ **本规范是 phase A 治理岗位上岗程序,目标是让 launch 当天有合格的 arbitrator + verifier 就位接第一笔 dispute / claim,避免死锁**。

⚠️ **This is phase A governance onboarding to ensure qualified arbitrators + verifiers are seated by launch day to handle the first dispute / claim, avoiding deadlock**.

| 维度 / Dimension | phase A | phase B+(需 RFC)|
|---|---|---|
| 现金 / WAZ 报酬 | ❌ 无 / None | ⏳ 由 RFC 决议 |
| 履职数据公示 | ✅ leaderboard(GOVERNANCE-LEADERBOARD-SPEC.md)| ✅ 保持 |
| Hall of Fame / 永久履职记录 | ✅ 关系层(framework §3)| ✅ 保持 |
| dev_contribution 加分 | ⏳ phase A 暂无(仅 security bounty 走加分;治理待评估)| ⏳ RFC 决议 |
| 卸任 / 切换冷却 | ✅ 30 天(类比 region) | ✅ 保持 |

**为什么 phase A 不引入报酬**:
- 经济流尚未真实结算
- 治理是公共贡献,非雇佣关系(framework §4)
- 防"为报酬上岗"的扭曲激励(违 #5 不偏袒)

**Why no compensation in phase A**: economic flow not real yet; governance is public contribution not employment (framework §4); avoiding "in-it-for-the-pay" misalignment (Rule #5).

---

## §1 角色范围 / Roles in scope

本规范覆盖 / Covers:

| 角色 / Role | 协议职责 / Protocol duty | 铁律节点 / Iron-Rule |
|---|---|---|
| **arbitrator** | 仲裁纠纷 — `webaz_dispute(action=arbitrate)` | ✅ 真人 Passkey 必备(SECURITY.md §Iron-Rule #1) |
| **verifier** | 验证 claim — `webaz_claim_verify(action=vote)` | ✅ 真人 Passkey 必备(SECURITY.md §Iron-Rule #2) |

**不在本规范范围 / Out of scope**:
- ❌ **admin / maintainer**(走 CHARTER §3.2 多签矩阵,不是申请制)
- ❌ **logistics**(物流方,业务角色,走自助 add-role)
- ❌ **buyer / seller**(基础角色,注册即得)
- ❌ **regulatory contributors**(W3.5-C `docs/REGULATORY-CONTRIBUTORS.md`,招募制,不走本规范申请)

---

## §2 资格门槛 / Eligibility

### 2.1 硬性 / Hard requirements(全部满足)

**以下为当前代码硬编码门槛(ground truth)。两个角色独立**:

| # | 条件 | arbitrator 实际 | verifier 实际 | 代码来源 |
|---|---|---|---|---|
| 1 | **Passkey 已绑** | ✓ (申请 ceremony) | ✓ (投票 ceremony) | Iron-Rule 7 paths(`SECURITY.md`) |
| 2 | **账户年龄 / 注册天数** | **≥ 90 天** | **≥ 60 天** | `server.ts:6374` (arb) / `claim_verify eligibility` (verif) |
| 3 | **完成订单数** | **≥ 50 笔** | **≥ 20 笔** | `server.ts:6377` (arb) / claim_verify (verif) |
| 4 | **reputation** | **≥ 300** | **≥ 110** | `server.ts:6391` (arb) / claim_verify (verif) |
| 5 | **email 验证** | ✓ 必须 | ✓ 必须 | `server.ts:6375` (arb) / claim_verify (verif) |
| 6 | **wallet 余额** | **≥ 500 WAZ** | **≥ 200 WAZ** | `server.ts:6389` (arb) / claim_verify (verif) |
| 7 | **0 仲裁判输**(作为 initiator / defendant) | ✓ | ✓ | `server.ts:6378-6384` (arb) / claim_verify (verif) |
| 8 | **从未被暂停**(`user_moderation` 无记录) | ✓ | ✓ | `server.ts:6385-6386` (arb) / claim_verify (verif) |
| 9 | **角色互斥**:不能同时持有 buyer/seller 与 arbitrator | ✓ | ✓ | 防利益冲突(参 CHARTER §权责分离)|

**arbitrator 实际校验入口**: `GET /api/arbitrator/eligibility` → `checkArbitratorEligibility(userId)` (`server.ts:6369-6393`)
**verifier 实际校验入口**: `webaz_claim_verify(action=eligibility)` 协议层

⚠️ **关于 `governance_onboarding.*` protocol_params 当前状态**(诚实声明 — 2026-06-02 实测发现):

| 维度 | 现状 |
|---|---|
| protocol_params 表里**定义** | ✅ `server.ts:788-794` 7 个 params(min_registration_days=30 / min_completed_orders=5 / arbitrator_min_reputation=95 / verifier_min_reputation=90 / role_switch_cooldown=30 / consent_delay=8 / quiz_pass=80) |
| **代码 enforce**(arbitrator.ts apply 是否真读取) | ❌ **未读取** — `checkArbitratorEligibility(server.ts:6369)` 是硬编码 90/50/300/500/email/0/never_suspended,完全无视上述 params |
| **PWA 显示**(`/governance-onboarding` 引导页) | ⚠️ 当前仍按 params 显示 30/5/95 — **与代码实际值不符,会误导用户**(本 PR 同步修复,改读真实值) |
| **诊断** | 🔴 **当前 params 是装饰性的**:定义了,没 enforce,UI 显示了臆造值 |

**对齐路径**:

| 阶段 | 动作 |
|---|---|
| **现在(本 PR)** | 文档值 = 代码 ground truth(本表已是);PWA 显示同步对齐;`governance_onboarding.*` 默认值调到代码值,明示装饰性 |
| **task #1093 实施** | `checkArbitratorEligibility` + claim_verify eligibility 改为**真读 protocol_params**;params 由装饰性 → 真 enforce;文档 / UI / 代码三方由同一 param 驱动 |
| **phase B+ DAO** | 想调门槛走 RFC + 多签;`30/5/95` 这种历史臆造值**不作为默认值复用**,需明确决定新 default |

**为什么不直接把代码硬编码改回 30/5/95**:
- 30/5/95 是**纯文档臆造**(无人决定来源,无 RFC 决议)
- 代码 90/50/300/email/wallet 500 是**实际治理风控值**(防滥用)
- 把代码降到臆造值 = 削弱风控,违 #6 不滥用
- 正确路径是**文档对齐代码**(#2 代码即规则),不是反向

**角色权责分离**(类似既有 trusted 角色规则):
- arbitrator 不能同时持有 buyer / seller(防利益冲突,代码已 enforce 见 `profile-identity.ts`)
- 上岗激活会自动 add role,但已有 buyer/seller 历史需先 retire

### 2.2 软性(可选,phase A 不强制)/ Soft (optional in phase A)

- KYC(法律辖区强约束的为 arbitrator 上岗后规则,非申请前置)
- 历史推荐质量(framework §4 contribution signal — phase A 仅观察)
- 邮件验证

### 2.3 阈值参数化 / Tunable thresholds

所有 hard threshold 进 `protocol_params`,DAO 可调:

```sql
INSERT INTO protocol_params (key, value, ...) VALUES
  ('governance_onboarding.min_registration_days', '30', 'int', ...),
  ('governance_onboarding.min_completed_orders', '5', 'int', ...),
  ('governance_onboarding.arbitrator_min_reputation', '95', 'int', ...),
  ('governance_onboarding.verifier_min_reputation', '90', 'int', ...),
  ('governance_onboarding.role_switch_cooldown_days', '30', 'int', ...);
```

---

## §3 申请流程(借鉴 RFC-002 §3.3 反诱导设计)/ Application flow (anti-manipulation, per RFC-002 §3.3)

### 3.1 流程图

```
User 点 [申请治理岗位] in #me
   ↓
Backend pre-check(strict,**自动代码 gate,非人肉**)
   arbitrator 申请 → 自动调 GET /api/arbitrator/eligibility
                   (checkArbitratorEligibility, server.ts:6369)
                   校验 §2.1 全部 9 条
   verifier 申请 → 自动调 webaz_claim_verify(action=eligibility)
                  校验 §2.1 全部 9 条
   ⚠️ §2.1 各条**叠加**(全部需 true),阈值类(rep / wallet / age / orders)按代码值,
      §2.1 独有条件(Passkey 已绑 / 角色互斥)由其他代码路径 enforce
      (Passkey:申请 ceremony / 角色互斥:arbitrator.ts:58 if role!=='buyer')
   ↓ (任一 fail → response 含 'missing_requirements' 数组 + 引导链接)
   ↓
PWA shows disclosure page (cannot skip):

   📌 顶部置顶提示(强制可见,不能折叠):
      "本流程是治理岗位申请,不是赚钱机会。
       phase A 不发放任何现金 / WAZ 报酬。
       治理是公共贡献 — 误以为是 income 来源会失望。
       This is a governance application, not an income opportunity.
       Phase A pays NO cash / WAZ. Governance is a public contribution —
       misunderstood as income will disappoint."

   - 角色职责(arbitrator/verifier 各自的协议责任,见 SECURITY.md §Iron-Rule)
   - phase A 状态:无报酬 / 仅 leaderboard 公示 / 永久履职记录(关系层)
   - 申请通过 ≠ 立即上岗 — 还要完成 onboarding(§4)
   - 卸任路径(§6)+ 30 天切换冷却
   - 上岗后违规处理(暂停 / 申诉路径)
   - 信任锚:Iron-Rule 真人 Passkey 是协议唯一不可调和的底线
   ↓
[ ] I have read and understood the above
[ ] 我自愿申请,无人收买 / 诱导 / I am applying voluntarily, not bribed / induced
       ↑ 第二个勾选项强制延迟(参 RFC-002 §3.3,默认 8s,server-side first-render timestamp)
       ↑ 不预勾,必须人工触发 input event
   ↓
[Sign with Passkey to submit application]
   ↓
Backend re-validates pre-check(防 TOCTOU)
   ↓
   - INSERT INTO governance_applications(append-only)
   - status = 'pending_onboarding'
   - 通知 maintainer(站内 + 邮件)
   ↓
进入 §4 Onboarding 阶段
```

### 3.2 反诱导措施 / Anti-manipulation safeguards

(借鉴 [`RFC-002 §3.3 + R2`](rfcs/RFC-002-rewards-opt-in.md)):

1. **顶部置顶提示**:"治理是贡献,不是赚钱" — 强制可见
2. **双勾选,第二个强制延迟 8s**(`protocol_params.governance_onboarding.consent_delay_seconds`,server-side first-render timestamp)
3. **不预勾**:checkbox 必须人工触发,programmatic 校验失败
4. **Pre-check 天然门槛**:30 天 + 5 订单 + 高 reputation — 攻击者难快速达成
5. **披露文本明示"phase A 无收入"**:第二个勾选项明确否定收买 / 诱导
6. **maintainer 通知**:申请提交即 surface 给 maintainer 群,可人工质疑

---

## §4 Onboarding 阶段 / Onboarding phase

申请通过(`status = pending_onboarding`)后,**不立即上岗**。必须完成:

### 4.1 学习包 / Study pack

强制阅读 + 测试题:

| # | 材料 / Material | 学习目标 |
|---|---|---|
| 1 | [`META-RULES-FULL.md`](META-RULES-FULL.md) | 10 元规则,特别是 #5 不偏袒 / #6 不滥用 |
| 2 | [`CHARTER.md`](CHARTER.md) §3.2 多签 + §6 修改流程 | 权力边界 |
| 3 | [`SECURITY.md`](../SECURITY.md) §Iron-Rule | 真人 Passkey 7 条路径 |
| 4 | [`ECONOMIC-MODEL.md §11`](ECONOMIC-MODEL.md) | 经济博弈原则 + 关系层估值层 |
| 5 | [`ARBITRATION-PLAYBOOK.md`](ARBITRATION-PLAYBOOK.md)(arbitrator 必读)| 案例决策树 + 4 种结算路径 |
| 6 | [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](PARTICIPATION-ATTRIBUTION-COMPLIANCE.md) | 合规边界 |

### 4.2 历史案例 / Historical cases(arbitrator 5 个,verifier 3 个)

- 从 `disputes` / `verify_tasks` 表挑 phase A 已结案的 5/3 个案例(脱敏)
- 申请者写"我会怎么判 + 理由"(每个 ≥ 200 字)
- maintainer 对比实际 verdict,评估申请者的判断方向(不要求完全一致,但要看 reasoning)

### 4.3 Onboarding 题目 / Quiz

10 道选择题 + 5 道 short-answer,涵盖:
- 元规则识别(给 scenario,问违反哪条)
- Iron-Rule 边界(哪些 action 必须 Passkey)
- 4 种 dispute 结算路径(release_seller / partial_refund / liability_split / refund_buyer)
- 反 outlier 机制(verifier 投票偏离多数 → 信誉惩罚)
- 关系层 vs 估值层(本人不能因为是 arbitrator 而拿额外 WAZ)

合格分数线:**80%**(`protocol_params.governance_onboarding.quiz_pass_score`)

### 4.4 上岗签字 / Activation signing

- 通过学习包 + 案例 + 题目后,maintainer 在 PWA #admin/governance 创建 "activation" intent
- ⚠️ **代码自动 re-gate**(activation 接口必须自动二次调 eligibility,**不依赖 maintainer 人肉记得查**):
  - arbitrator 激活 → 自动调 `checkArbitratorEligibility(targetUserId)` (`server.ts:6369`)
  - verifier 激活 → 自动调 `claim_verify eligibility` 协议层
  - 任一 fail → activation 接口 return 4xx + `missing_requirements` 数组,UI 显示原因,**不进入** Passkey ceremony
  - 不是 "maintainer 应该记得查";phase A maintainer = solo founder,手忙时会忘 → **代码硬把关**
- **Iron-Rule Passkey ceremony**(maintainer 真人签发,前置代码 gate 通过后)
- 写入 `governance_applications.status = 'active'`
- 用户角色加 arbitrator / verifier(在 users.roles JSON 数组)
- 通知用户 + 公开通知(站内 + 可选邮件)

---

## §5 上岗后行为约束 / Post-activation conduct

### 5.1 履职最低频率 / Minimum activity

phase A 不强制(用户志愿)。phase B+ 可由 RFC 引入"X 周内 ≥ N 次履职"机制,逾期自动转 inactive。

### 5.2 利益冲突回避 / COI recusal

- arbitrator 不能审涉及自己 buyer/seller 历史交易对手的 dispute
- verifier 不能投自己 claim_verify 任务
- 系统自动检测 + 拒绝接案(已实现,本规范文档化)

### 5.3 Outlier 惩罚 / Outlier penalty

⚠️ **核心原则:罚的是"判错"(被事实/复核证明),不是"判得跟多数不一样"**(防羊群效应)。详 [`ARBITRATION-PLAYBOOK §6`](ARBITRATION-PLAYBOOK.md)。

⚠️ **Core principle: penalty for being **proven wrong** (by facts / review), NOT for "deviating from majority"** (anti-herd-effect). See [`ARBITRATION-PLAYBOOK §6`](ARBITRATION-PLAYBOOK.md).

| 信号 / Signal | 触发后果 / Trigger |
|---|---|
| verifier 投票偏离多数 / arbitrator 偏离同案多人平均 | **仅标记 outlier(信号)**,不直接降 reputation |
| verifier 投票被事实查证确认错(后续证据 / 复核)| reputation 微降 |
| arbitrator 判决被申诉复核推翻 | reputation 显著降 |
| 被复核确认判错累计达 N 次 / ≥30% 比例 | 自动转 inactive,需重走 onboarding;申诉路径 §7.2 |

`verifier_stats` 表的 `outlier_count` 字段仅作公示信号,**不直接进 reputation 公式** — 真正的惩罚锚 `confirmed_wrong_count`(按 ARBITRATION-PLAYBOOK §6.2 protocol_params)。

### 5.4 leaderboard 公示 / Leaderboard publication

- 履职数据(case_count / accuracy / fairness / response_time)进 [`GOVERNANCE-LEADERBOARD-SPEC.md`](GOVERNANCE-LEADERBOARD-SPEC.md)(PR #9 merge 后激活)observation-only 维度
- ⚠️ **不附加 composite score / 权重排名 / "best/worst" 价值判断**(framework §4 phase A 边界)
- UI 显式 banner 标注"非 reward distribution"(LEADERBOARD §6.1)

⚠️ **Forward-ref 风险声明**:
- accuracy / fairness 4 维度公式来自 GOVERNANCE-LEADERBOARD-SPEC v0.x,该 spec phase A 仍 review(已识别 evidence_balance 易伪造等议题)
- §5.3 outlier 惩罚 + ARBITRATION-PLAYBOOK §6 deactivate 阈值实施,**需在 leaderboard fairness 公式定稿后才 freeze**
- 本 doc + ARBITRATION-PLAYBOOK + LEADERBOARD-SPEC 三方互锁,任一变更需同步

---

## §6 卸任 / 切换 / Stepping down

### 6.1 主动卸任 / Voluntary resignation

```
User 在 #me 点 [卸任 <role>]
   ↓
Modal 1:Disclosure
   - 卸任后历史履职记录保留(关系层,permanent)
   - 卸任不影响 reputation / dev_contribution
   - 30 天内不能重新申请同一角色(冷却,反频繁切换)
   - 已 assigned 但未完成的 case 必须先完成 / 转交其他 arbitrator
   ↓
Modal 2:type-to-confirm
   "Type '卸任 <role>' / 'RESIGN <role>'"
   ↓
Second-factor: Passkey OR Password(类比 RFC-002 §3.4)
   ↓
Backend:
   - 检查 active cases — 有 → block,要求先 transfer
   - INSERT INTO governance_applications(action='resign')
   - UPDATE users SET roles = exclude <role>
   - 设 cooldown_until = now + 30d
```

### 6.2 自动卸任 / Auto-deactivation

⚠️ **核心原则:锚 `confirmed_wrong`(被复核证明判错),不是 `outlier`(偏离多数)**
— per [`ARBITRATION-PLAYBOOK.md`](ARBITRATION-PLAYBOOK.md) §6.1 标记 vs 触发分离。
outlier 仅作 leaderboard 信号,不直接触发 deactivate。

**Core principle: anchored to `confirmed_wrong` (verified-wrong upon review),
NOT `outlier` (deviation from majority)** — outlier is a leaderboard signal only,
never a deactivate trigger.

触发条件 / Trigger conditions:

| 触发 / Trigger | Phase | Status |
|---|---|---|
| `confirmed_wrong_count` ≥ threshold(默认 5)**AND** `confirmed_wrong / tasks_done` ≥ threshold_pct(默认 30%)**AND** `tasks_done` ≥ min_sample(默认 10) | A | ✅ 已实施(verifier;阶段 5 cron) |
| Arbitrator 同等机制 | B | ⏳ 待 `arbitrator_stats` 表 + verdict overturn 信号 |
| 利益冲突频繁 `coi_violation_threshold` 超阈值 | B+ | ⏳ 待 COI tracking 实施 |
| 长期 inactive | B+ | ⏳ 待 RFC 决议 |

实施参数 / Protocol params(均 `governance.*` namespace,phase A solo maintainer 可调,phase B+ DAO 治理):
```
governance_auto_deactivate_threshold_count   default 5
governance_auto_deactivate_threshold_pct     default 0.3
governance_auto_deactivate_min_sample        default 10
governance_auto_deactivate_cron_hours        default 24
```

自动卸任**不算用户主动行为**,跳过 type-to-confirm + 二次验证(类比 RFC-002 §3.10 auto_downgrade),但触发强通知 + 14d 申诉路径(§7.2)。
Auto-deactivation is **not user-initiated**, so it bypasses type-to-confirm + second-factor (analogous to RFC-002 §3.10 auto_downgrade), but triggers strong notification + 14-day appeal window (§7.2).

审计可见 / Audit visibility: `GET /api/admin/governance/auto-deactivations` 列出所有 auto_deactivate 行 + trigger reason + 申诉状态(元规则 #1 当一切可见)。

### 6.3 30 天冷却(类比 region 切换)

- `cooldown_until` 期间不能重新申请同一角色
- 可申请不同角色(arbitrator → verifier 或反向)— 各自冷却独立
- 冷却理由:防止 farming 切换洗票 / 防误操作反复 / 历史声誉断层

---

## §7 申诉路径 / Appeal channel

### 7.1 申请被拒 / Application rejection

- pre-check 不过 → 显示缺什么 + 引导补
- maintainer 评估时认为不合格 → 给具体原因 + 30 天后可重申(无冷却,但要补缺)

### 7.2 上岗后被自动卸任

- 收到通知后 14 天内可提交申诉(`governance_applications` 表 + action='appeal')
- maintainer 群多签 review(参 CHARTER §3.2)
- 申诉通过 → 恢复 active + 抹除 outlier 记录(留 audit)
- 申诉驳回 → 公开理由(对应 #1 当一切可见)

---

## §8 关系层 vs 估值层 / Relationship vs Valuation

(对齐 [`framework`](CONTRIBUTOR-REWARD-FRAMEWORK.md) §3)

**关系层(永久记录,不可逆)/ Relationship layer (permanent, irreversible)**:
- 谁担任过 arbitrator / verifier(`governance_applications` 历史 + `users.roles_history`)
- 每个 case 的判决 actor + reasoning(`order_state_history`)
- 履职计数 / accuracy / 投票记录(verifier_stats / disputes 表)
- 即便用户卸任,这些数据永久保留

**估值层(由 phase D DAO 决定)/ Valuation layer (decided by phase D DAO)**:
- "履职得多少 reward" — phase A **不预设公式**
- composite score 加权 — phase A **不引入**(GOVERNANCE-LEADERBOARD-SPEC §3 明确)
- 治理投票权重 — 走 CHARTER §3.2 + phase D DAO 投票规则
- 经济回报(WAZ / cash)— phase B+ RFC 决议

→ phase A 治理上岗 = 关系层数据采集 + 公共贡献意愿表达,**不预设估值层**。

---

## §9 Schema(完整)/ Schema (complete)

```sql
CREATE TABLE governance_applications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  role                TEXT NOT NULL,             -- 'arbitrator' | 'verifier'
  action              TEXT NOT NULL,             -- 'apply' | 'activate' | 'resign' | 'auto_deactivate' | 'appeal'
  status              TEXT NOT NULL,             -- 'pending_onboarding' | 'active' | 'inactive' | 'rejected' | 'cooldown'
  consent_hash        TEXT,                      -- apply 时申请披露 hash
  passkey_sig         TEXT,                      -- apply / activate / resign Passkey 签发证据
  iron_rule_method    TEXT,                      -- 'passkey' | 'password' | 'system_auto'
  quiz_score          INTEGER,                   -- 0-100(activate 时记录)
  case_review_text    TEXT,                      -- onboarding §4.2 案例分析
  cooldown_until      INTEGER,                   -- resign / auto_deactivate 后冷却到期
  appeal_reason       TEXT,                      -- appeal 时填写
  appeal_resolution   TEXT,                      -- maintainer 给出的处置 + 理由
  ip_hash             TEXT,
  ua_hash             TEXT,
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_gov_apps_user ON governance_applications(user_id, created_at DESC);
CREATE INDEX idx_gov_apps_role_status ON governance_applications(role, status, created_at DESC);
CREATE INDEX idx_gov_apps_cooldown ON governance_applications(user_id, role, cooldown_until);

-- protocol_params(5 阈值 + 1 反诱导延迟)
INSERT INTO protocol_params (key, value, value_type, description, category) VALUES
  ('governance_onboarding.min_registration_days', '30', 'int', '申请前最少注册天数', 'governance'),
  ('governance_onboarding.min_completed_orders', '5', 'int', '申请前最少完成订单数', 'governance'),
  ('governance_onboarding.arbitrator_min_reputation', '95', 'int', '申请 arbitrator 最低 reputation', 'governance'),
  ('governance_onboarding.verifier_min_reputation', '90', 'int', '申请 verifier 最低 reputation', 'governance'),
  ('governance_onboarding.role_switch_cooldown_days', '30', 'int', '卸任后再申请同角色冷却天数', 'governance'),
  ('governance_onboarding.consent_delay_seconds', '8', 'int', '同意勾选反诱导延迟秒数', 'governance'),
  ('governance_onboarding.quiz_pass_score', '80', 'int', 'onboarding 题目合格分数线', 'governance');
```

---

## §10 元规则映射 / Meta-rule mapping

```
#1 当一切可见:✅ governance_applications 公开可审计 + leaderboard 公示
#2 代码即规则:✅ pre-check / cooldown / COI 都由代码 enforce
#4 不撒谎:✅ phase A 明确无报酬,不画饼;卸任记录永久不抹除
#5 不偏袒:✅ 资格门槛对所有 user 一致;不能 admin 直接授予 arbitrator
#6 不滥用:✅ outlier + 申诉机制防内部滥权
#7 不操纵:✅ 8s 反诱导延迟 + maintainer 通知;agent 无法替用户提交申请
#9 算法即协议:✅ 阈值 protocol_params 化,DAO 可调
#10 参与者即 webazer:✅ 治理岗位是 webazer 内部贡献角色,关系层永久记录
```

**Iron-Rule 技术边界**:
- ✅ 上岗 activation 走 Iron-Rule Passkey(maintainer 签发)— 共用现有 7 条之外的"管理操作"族,不引新铁律
- ✅ arbitrator 履职(SECURITY.md Iron-Rule #1)+ verifier 履职(#2)已是铁律节点

---

## §11 关联文档 / Related docs

- [`META-RULES-FULL.md`](META-RULES-FULL.md) — 元规则 #1-#10
- [`CHARTER.md §3.2`](CHARTER.md) — 多签矩阵 + 权责分离
- [`SECURITY.md`](../SECURITY.md) — Iron-Rule 7 条路径
- [`SECURITY.md`](../SECURITY.md) §Recognition — phase A 致谢机制(类比模式)
- [`ARBITRATION-PLAYBOOK.md`](ARBITRATION-PLAYBOOK.md) — arbitrator 案例决策树(必读 §4.1)
- [`GOVERNANCE-LEADERBOARD-SPEC.md`](GOVERNANCE-LEADERBOARD-SPEC.md) — leaderboard observation-only spec(PR #9 merge 后激活)
- [`rfcs/RFC-002-rewards-opt-in.md`](rfcs/RFC-002-rewards-opt-in.md) — 反诱导设计(§3.3 + R2)
- [`CONTRIBUTOR-REWARD-FRAMEWORK.md`](CONTRIBUTOR-REWARD-FRAMEWORK.md) — 4 类贡献(§4)+ 关系/估值分离(§3)
- [`ECONOMIC-MODEL.md §11`](ECONOMIC-MODEL.md) — 经济博弈原则 + 非经济维度回报
- [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](PARTICIPATION-ATTRIBUTION-COMPLIANCE.md) — 合规边界

---

**Last reviewed**: 2026-06-02
**Status**: draft v1.0
**Next**:
- review 后落 schema(`governance_applications` 表 + 7 protocol_params)
- 落 `docs/ARBITRATION-PLAYBOOK.md`(arbitrator 案例决策树,W3.5-B deliverable 2)
- 落 `/governance` PWA 页(public leaderboard + onboarding entry,W3.5-B deliverable 3,依赖 PR #9 self-merge)
