# RFC-002: Rewards Opt-In — 共建身份申请制 / Community-Builder Application Mode

> **命名澄清(2026-06-13)/ Naming clarification.** 用户面文案现统一为 **「分享分润开通 / share-commission
> opt-in」**(consent text v1.1,latest `change_class='major'`)。本 RFC 标题与正文保留原始 **「共建身份 /
> Builder Identity」** 措辞仅作历史/治理记录,**以 UI 当前措辞为准**。**重要边界**:本"分享分润 opt-in"是
> commission / PV / escrow 的**经济关系登记**,**不是**「共建贡献系统」(`#contribute/tasks` / GitHub 贡献认领 /
> 建设信誉,见 RFC-017)的资格,二者语义独立。佣金层级按地区合规配置生效,**当前预发布期全局上限为 1 级**,
> 文中"三级 / 二元配对树"为协议**最大设计**,非当前固定承诺。consent v1.0(原 Builder Identity 措辞)按版本
> 不可变原则**冻结保留**,v1.1 为新的 major 版本。

**Status**: **implemented / live**(2026-06-03 — 已跨多个 PR 上线生产;原 blocking 依赖 ECONOMIC-MODEL §11 "Mersenne tree 位置=分润"未决表述已由 task #1089 修正闭环)。实现:`src/pwa` rewards opt-in 申请 / escrow / auto-downgrade 流程 + `protocol_params.rewards_opt_in.*`
**Author**: @seasonkoh
**Created**: 2026-06-02
**Last revised**: 2026-06-02 (v2 — P0×4 + P1×6 + P2 review fixes,见末尾 Changelog)
**Track**: **meta-rule (60d)** — 实质修复元规则 #3 / #4 / #7 的执行实现(默认 enroll → 默认 opt-out);且本 RFC 创建的 `protocol_params.rewards_opt_in.require_passkey=1` 享 meta-rule 级保护(下调需 60d track),上锁动作本身必须同等级别公示。**P0-4 已闭环**:本 RFC §3.6 同步实施 `requires_meta_rule_change` 列 + CI lint(非"留待后续治理 RFC")
**Related issue**: (n/a — pre-launch 主动提案 / pre-launch proactive proposal)
**Supersedes**: (n/a — first economic-gate RFC)
**Superseded by**: (n/a)

---

## Summary / 摘要

WebAZ 用户注册时 **默认不参与奖励体系**(`rewards_opted_in = 0`),仅作为普通消费者使用协议。用户若想参与 commission / PV / referral 奖励,**必须主动申请**;申请前置条件为 **Passkey 已绑 + 已完成订单 ≥ 1 笔**(防女巫,protocol_param 可调)。激活需 Passkey 签名 + 双勾选同意 + 完整披露;关闭需 type-to-confirm + 二次验证(Passkey 或 Password)。本 RFC 不改变现有 commission / PV 计算逻辑,仅在「credit to recipient」前加一个 gate。

Users registering on WebAZ are **opted-out of rewards by default** (`rewards_opted_in = 0`) — they can use the protocol as ordinary consumers. To participate in commission / PV / referral rewards, users must **explicitly apply**. Application prerequisites: **Passkey bound + ≥1 completed order** (Sybil defense; tunable via `protocol_params`). Activation requires Passkey signature + dual-checkbox consent + full disclosure. Deactivation requires type-to-confirm + second-factor verification (Passkey or Password). This RFC does not change existing commission / PV computation logic; it only adds a gate before "credit to recipient".

---

## Motivation / 动机

### 1. Compliance 张力 / Compliance tension

WebAZ 的三级 commission(7:2:1)+ 二元 PV 配对树 + 邀请链结构 **在多数司法辖区可能与 MLM 法律定义重叠**(见 [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](../PARTICIPATION-ATTRIBUTION-COMPLIANCE.md) + [`ECONOMIC-MODEL.md`](../ECONOMIC-MODEL.md) + [`LEGAL-DISCLOSURES.md`](../LEGAL-DISCLOSURES.md))。**(历史动机)** 本 RFC 之前,注册路径默认让所有用户进入完整奖励体系,等同于:**未取得用户明确知情同意,即将其纳入可能受 MLM 法规管辖的经济关系**。**本 RFC 已修正此问题**:注册默认 `rewards_opted_in = 0`(opt-in / default-off),奖励须主动申请(见 §3);此外匹配奖励另受 Category C 全局双闸默认关闭(见 `PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`)。

WebAZ's 3-tier commission + binary-PV pairing + invitation chain may **overlap with MLM legal definitions** in many jurisdictions. The current registration path defaults all users into the full reward system — i.e., **enrolling them into a potentially MLM-regulated economic relationship without explicit informed consent**.

### 2. 与既有元规则的张力 / Conflict with existing meta-rules

- **#3 不偷数据**:默认 enroll = 默认采集 / 处理用户的经济关系数据;若用户实际不想参与,默认 ON 等同于隐性强制
- **#4 不撒谎**:对外披露说"参与是自愿的",代码层却默认所有人参与 — 文档与行为不一致
- **#7 不操纵 / agent 不替用户决定**:agent 注册新用户后**不应**默认替用户加入奖励;现有 MCP `webaz_register` 不询问 = 隐式替用户决定

→ #3 / #4 / #7 三条直指**默认 ON 的合规缺陷**。

### 3. 与 Iron-Rule(真人专属)一致性 / Iron-Rule symmetry

铁律已将 7 条真人 Passkey 路径锁死("require_human_presence_*=1"),但这 7 条覆盖的是**已 enrolled 用户的关键操作**(arbitrate / vote / agent_revoke 等)。**进入奖励体系本身**这一**根因事件**目前不需要真人签名 — 这是铁律设计的盲点:**入口比执行更需要真人**(没真人,后面 7 条都是错的根上)。

The Iron-Rule locks 7 paths to human-Passkey, but those cover **operations of already-enrolled users**. The **act of enrolling into the reward system itself** — the root event — currently requires no human signature. This is a blind spot: **the entry point matters more than the execution paths** (without a real human at entry, all 7 downstream protections are built on sand).

### 4. 防女巫(Sybil)入口 / Sybil defense at entry

奖励体系的滥用攻击面 = 大量假账号刷邀请链 / PV 树。当前注册端已有(继承:#1041 D1b 邀请制 + Turnstile),但奖励参与是更高价值的攻击靶,需更强 entry gate(Passkey + 行为信号)。

The reward system is a higher-value attack surface than registration. Current registration-level Sybil defense (invite-required + Turnstile) is insufficient as the gate for **economic participation**.

---

## Design / 设计

### 3.0 设计原则:关系层 vs 估值层 / Design principle: relation layer vs valuation layer

本 RFC 的所有 gate **统一归为「估值层 gate」语义**:

| 层 / Layer | 内容 / Content | 行为 / Behavior | opt-in 是否 gate |
|---|---|---|---|
| **关系层 / Relation layer** | 谁带来谁(referral chain)、Binary PV 树节点位置、attribution 记录 | **如实记录,永久不变,所有用户全员入** | ❌ 不 gate |
| **估值层 / Valuation layer** | commission 结算、PV 配对结算、share_link 生成、奖励资金流转 | 受 `rewards_opted_in` flag gate | ✅ gate |

**核心规则**:
1. **关系层数据完整性**:所有 webazer(无论 opt-in 状态)都进 Binary PV 树、都被记录 attribution。**事实记录不可逆,不被 opt-in 状态影响**
2. **估值层 gate**:钱的流转才看 opt-in。opted-in 时按原逻辑结算;opted-out 时,根据本 RFC §3.5b 的 pending_commission_escrow 机制处理(留出激活后追溯窗口)
3. **互斥不变量**:关系层永远 ≥ 估值层。任何 gate 都不能擦除关系层数据

这条原则解决了 P0-2 (binary tree 不应被 opt-in gate) + P1-1 (大V 翻车) 的根因。

**有意识的 trade-off**(§3.5 `webaz_share_link` hard-fail):

share_link 严格说不是"钱的流转",从分类上似乎该属于关系层入口工具。但本 RFC 选择 **hard-fail opt-out 用户**,而非"允许生成但带警告"。理由:

| 选项 | 优点 | 缺点 |
|---|---|---|
| **A:hard-fail(本 RFC 采用)** | UX 清晰("先 opt-in 才能要奖励"信号强);防止"先生成再说"的滑坡;减少 escrow 队列长度 | 阻断了从 share_link 通道做关系层数据采集 |
| B:允许生成 + 警告 | 关系层数据更全;用户可保留分享行为不绑定经济意图 | UX 混乱(分享了但拿不到钱,后置 escrow 反而让用户更困惑) |

→ 选 A。**关系层完整性靠 `bindReferralAttribution`(始终记录,无论用户是否 opt-in)+ Binary PV 树落树(全员入位)兜底,不依赖 share_link**。这是有意识 trade-off,非疏漏。

### 3.1 核心 flag 与默认值 / Core flag + default

```sql
ALTER TABLE users ADD COLUMN rewards_opted_in INTEGER DEFAULT 0;
```

- 注册路径 / register API / MCP `webaz_register` **零改动** — flag 自动默认 0
- 所有 fixture 用户 + 现有 pre-launch 数据 = 0(无需 backfill)

### 3.2 申请前置条件 / Application prerequisites

| 条件 / Condition | 信号强度 / Signal | 来源 / Source |
|---|---|---|
| Passkey 已绑(WebAuthn 真人证明) | ★★★ | `passkeys` 表 count > 0 |
| 完成订单 ≥ 1 笔 | ★★ | `orders` 表 status='completed' count ≥ 1 |
| (继承)注册时邀请制 | ★★ | #1041 D1b 已上线 |
| (继承)Turnstile captcha | ★ | welcome 路径已有 |

**参数化** / **Tunable**:

```sql
INSERT INTO protocol_params (key, value, ...) VALUES
  ('rewards_opt_in.min_completed_orders', '1', ...),
  ('rewards_opt_in.require_passkey', '1', ...);
```

DAO 上线后可调阈值;**原则永久(必须真人 + 行为)/ 阈值可调(`1` 可改 `3`)** — 遵循原则 / 机制分层。

### 3.3 申请流程 / Application flow

```
User clicks [申请加入共建身份] in #me
   ↓
Backend pre-check(全部 strict):
   ✓ Passkey exists for user
   ✓ completed_orders ≥ protocol_params.rewards_opt_in.min_completed_orders
   ↓ (任一 fail → response 含 'missing_requirements' 数组 + 引导链接)
   ↓
PWA shows disclosure page (cannot skip):

   📌 顶部置顶提示(强制可见,不能折叠 / sticky, non-collapsible):
      "本流程与购物无关,你可以随时退出,不影响任何已下单或未来订单。
       本流程涉及经济关系登记,请仔细阅读全部条款。
       This flow is not part of shopping. You can leave anytime without
       affecting any past or future orders. This is an economic-relationship
       registration — please read all terms carefully."

   - Protocol nature + pre-launch state
   - 3-tier referral commission + binary-PV structure
   - 多辖区合规披露(详细法律术语见 [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](../PARTICIPATION-ATTRIBUTION-COMPLIANCE.md) + [`LEGAL-DISCLOSURES.md`](../LEGAL-DISCLOSURES.md))/
     Multi-jurisdictional compliance notice (full legal terms — incl. MLM-overlap analysis —
     in PARTICIPATION-ATTRIBUTION-COMPLIANCE.md + LEGAL-DISCLOSURES.md)
   - Earnings are not promises; WAZ is simulated
   - Tax / jurisdictional compliance is user's own responsibility
   - Deactivation path (can opt out anytime → future commission to escrow,
     then charity_fund if not re-activated within escrow window)
   - Consent text version (e.g. v1.0) displayed
   ↓
[ ] I have read and understood the above terms
[ ] I am applying voluntarily, not solicited / induced by agent / 3rd party
       ↑ This checkbox is locked for the first N seconds (protocol_params.rewards_opt_in.consent_delay_seconds, default 8s)
       ↑ Never pre-checked. Must be manually clicked by user. (Anti-agent-railroad — see R2)
       ↑ N 秒计时器在页面打开后启动;若用户切换 tab / 浏览器最小化,计时器**不暂停**(避免给"agent 模拟切换"留 bypass);
         计时基于 server-side first-render timestamp,前端篡改无效
   ↓
[Sign with Passkey to submit application]
   ↓
Backend re-validates pre-check (防 TOCTOU)
   ↓
   - INSERT INTO rewards_applications (..., action='activate', consent_hash, passkey_sig, ts)
   - UPDATE users SET rewards_opted_in = 1
   - Audit log: rewards_opt_in_activated
   - Notify commission/PV settlement gate (cache invalidate)
```

### 3.4 关闭流程 / Deactivation flow

关闭的语义 = 「让出未来奖励 → redirect 到 charity_fund」,**不要求 Passkey 强度**,但要求二次验证防误操作 + 防被盗号。

Deactivation = "yield future rewards → redirect to charity_fund". Does not need full Passkey ceremony (no new financial commitment), but requires second-factor + misclick protection.

```
User clicks [关闭共建身份]
   ↓
Modal 1: Disclosure of consequences (must read all 4 bullets):
   - **Future commissions go DIRECTLY to charity_fund** (NOT to escrow).
     Deactivation = explicit waiver of future rewards, not a pause.
     **关闭即明确放弃未来奖励**,直接进慈善池,不进 escrow
   - **Already settled WAZ unaffected, withdrawable as usual.** 已结算 WAZ 不受影响,可正常提取
   - **⚠️ Commissions redirected to charity_fund during the deactivated period
     are PERMANENT — not refundable on re-activation. Re-activation only
     affects orders settled AFTER re-activation.**
     **关闭期间进入慈善池的 commission 永久不可追溯。重新激活仅对激活后的订单生效**
   - You can re-apply anytime (no cooldown). 可随时重新申请,无冷却
   ↓
[Continue]
   ↓
Modal 2: type-to-confirm
   "Type '关闭共建身份' / 'DISABLE BUILDER' to confirm (anti-misclick)"
   ↓
Second-factor: Passkey OR Password (whichever user has bound)
   ↓
Backend:
   - INSERT INTO rewards_applications (..., action='deactivate', verification_method, ts)
   - UPDATE users SET rewards_opted_in = 0
   - Audit log
```

**冷静期 / Cooling-off period**:不加。激活才需要冷静(承诺新关系);关闭是单方让利,反向 — 加冷静期反而妨碍用户行权。

### 3.5 Gate 接入点 / Gate insertion points

**5 个接入点 ─ 4 处估值层 gate(受 opt-in 控制)+ 1 处关系层操作(始终执行)**。所有都遵循 §3.0 的「关系记录,估值 gate」原则:

| 位置 / Location | 层 / Layer | 行为 / Behavior |
|---|---|---|
| `settleOrder` commission 分配 | 估值层 | recipient(L1/L2/L3 promoter)未 opted-in → **进入 pending_commission_escrow**(见 §3.5b),不直接 redirect charity |
| **Binary PV 落树时刻** | **关系层** | **所有用户进树**(关系层完整记录"谁带来谁",不可逆)。**树节点位置永久保留,与 opt-in 状态无关** |
| Binary PV 配对结算 | 估值层 | 节点的配对收益分配,recipient 未 opted-in → 进入 pending_commission_escrow;opt-in 后立即恢复参与未来配对结算(无需补建关系) |
| `bindReferralAttribution`(`webaz_place_order` 的 `promoter_api_key`) | 关系层 | **始终记录 attribution**,与 opt-in 状态无关(关系层完整) |
| `webaz_share_link` / PWA 生成分享链接 | 估值层 | 未 opted-in 时**拒绝生成**(明确错误 + 引导申请) |

### 3.5b Pending commission escrow / 待激活 commission 托管

**问题**:opted-out promoter 通过非 share_link 渠道(口碑 / 线下 / 截图)带来订单时,attribution 已记录,但若直接 redirect charity,promoter 会发现"我推广了一分没拿到全捐了"→ 强烈负面体验(P1-1)。

**机制**:

```
settlement 时,若 recipient.rewards_opted_in = 0:
   1. 不直接 redirect charity_fund
   2. 写入 pending_commission_escrow 表:
      { recipient_user_id, order_id, amount, attribution_path, expires_at }
   3. expires_at = now + protocol_params.rewards_opt_in.escrow_days (默认 30 天)
   4. promoter 登录时显著提示:
      "你有 X WAZ 待激活领取,Y 天后过期 → [立即激活]"
   5. promoter 在到期前完成 opt-in:
      → escrow 中所有未过期 entries 立即 settle 给 promoter(批量)
   6. 过期未激活:
      → redirect charity_fund(此时不可逆,记入 audit)
```

**escrow 仅用于「从未激活」状态**,**不用于「主动关闭」状态**:

| 状态 / State | recipient 是 opt-out 时 commission 流向 |
|---|---|
| **从未激活**(rewards_opted_in=0,无 activate 记录) | → pending_commission_escrow(30d 追溯窗口,给从未激活的 promoter 一次激活机会) |
| **主动关闭**(rewards_opted_in=0,有 deactivate 记录在 active 之后)| → **直接 charity_fund**(明确放弃,不可追溯;与 §3.4 关闭语义一致) |
| **major consent 未重新确认而自动降级**(§3.10) | → pending_commission_escrow(给用户重新确认机会;非"主动关闭") |

**区分依据**:`rewards_applications` 表中该用户最近一条记录的 `action` 字段:
- 无记录或最近为 `activate` 但 flag=0 不存在(系统从未发生过) → 未激活
- 最近为 `deactivate` → 主动关闭(直接 charity)
- 最近为 `auto_downgrade`(§3.10) → 自动降级(走 escrow)

**为什么 30 天**:够 promoter 看到通知 + 完成订单(若 1 笔订单门槛未达成)+ 完成 Passkey 绑定的反应时间;不长到造成 charity_fund 流入不可预测。

### 3.6 Schema(完整)/ Schema (complete)

```sql
-- 1. users 加列
ALTER TABLE users ADD COLUMN rewards_opted_in INTEGER DEFAULT 0;

-- 2. 申请留痕表
CREATE TABLE rewards_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,                  -- 'activate' | 'deactivate' | 'auto_downgrade' (see §3.10) | 'reconfirm' (re-confirm after major consent change)
  consent_version TEXT,                  -- e.g. '1.0', '2.0' — links to rewards_consent_texts(version); activate / reconfirm 必填
  consent_hash TEXT,                     -- sha256 of versioned disclosure text (activate / reconfirm 必填; deactivate / auto_downgrade 可空)
  passkey_sig TEXT,                      -- WebAuthn signature blob (activate / reconfirm required; deactivate optional; auto_downgrade 系统侧无签名)
  verification_method TEXT NOT NULL,     -- 'passkey' | 'password' | 'system_auto'
  ip_hash TEXT,                          -- anonymized IP (audit only; system_auto 可空)
  ua_hash TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (consent_version) REFERENCES rewards_consent_texts(version)
);

CREATE INDEX idx_rewards_apps_user ON rewards_applications(user_id, created_at DESC);
CREATE INDEX idx_rewards_apps_action ON rewards_applications(user_id, action, created_at DESC); -- for "最近一条 action" 区分(见 §3.5b)

-- 3. pending commission escrow(opt-out promoter 待激活领取队列,见 §3.5b)
CREATE TABLE pending_commission_escrow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_user_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount REAL NOT NULL,                  -- WAZ amount
  attribution_path TEXT NOT NULL,        -- 'L1' | 'L2' | 'L3' | 'pv_pair' | etc.
  status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'settled' | 'expired'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,                    -- nullable
  expired_to_charity_at INTEGER,         -- nullable
  FOREIGN KEY (recipient_user_id) REFERENCES users(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX idx_escrow_recipient ON pending_commission_escrow(recipient_user_id, status, expires_at);
CREATE INDEX idx_escrow_expiry ON pending_commission_escrow(status, expires_at);

-- 4. 同意文本版本表(见 §3.10)
CREATE TABLE rewards_consent_texts (
  version TEXT PRIMARY KEY,              -- e.g. '1.0', '1.1', '2.0'
  hash TEXT NOT NULL,                    -- sha256 of canonical text
  change_class TEXT NOT NULL,            -- 'major' | 'minor'
  effective_at INTEGER NOT NULL,
  text_zh TEXT NOT NULL,
  text_en TEXT NOT NULL,
  changelog TEXT                         -- human-readable diff summary
);

-- 5. protocol_params 加 meta-rule lock 列(P0-4 闭环)
ALTER TABLE protocol_params ADD COLUMN requires_meta_rule_change INTEGER DEFAULT 0;
-- 任何 value=1 的参数,DAO 调整必须走 60d meta-rule track 而非普通参数变更流程。
-- 由 governance layer 强制执行(参数变更 RFC 提交时 CI lint:若涉及 requires_meta_rule_change=1 的 key,
-- 必须 track=meta-rule;否则 PR 阻塞)。

-- 6. protocol_params 数据
INSERT INTO protocol_params (key, value, value_type, description, requires_meta_rule_change) VALUES
  ('rewards_opt_in.min_completed_orders', '1', 'int', 'Minimum completed orders to apply for rewards opt-in', 0),
  ('rewards_opt_in.require_passkey', '1', 'int', 'Whether Passkey is required (1=on, 0=off). META-RULE LOCKED: lowering requires 60d meta-rule track.', 1),
  ('rewards_opt_in.escrow_days', '30', 'int', 'Days a pending commission stays in escrow before redirecting to charity_fund (see §3.5b)', 0),
  ('rewards_opt_in.consent_delay_seconds', '8', 'int', 'Mandatory delay before user can check the "voluntary, not solicited" consent box (anti-agent-railroad, see §3.3 + R2)', 1),
  ('rewards_opt_in.reconfirm_grace_days', '14', 'int', 'After a major consent text update, grace period users have to re-confirm before flag is auto-downgraded to 0 (see §3.10)', 0);
```

**Note**: `requires_meta_rule_change` 列同步在本 RFC 内生效(非"留待后续治理 RFC")。CI lint 强制 — 调整任一 `=1` 参数的 PR 必须以 meta-rule track(60d)提交 RFC,否则阻塞合并。这是 P0-4 闭环 — 把声明保护转为执行保护。

### 3.7 MCP 工具改动 / MCP tool updates

- `webaz_register`:**零改动**(默认 0)
- `webaz_share_link`:opted-out 用户调用返回 `{ error: 'rewards_opt_in_required', missing_requirements: [...], next_steps: [...] }`
- `webaz_referral`:对所有用户可调,返回数据中新增 `rewards_opted_in: bool` + `pending_escrow: { total_amount, expiring_soon: [...] }`;opted-out 时附加 `note`,区分两种状态:
  - **从未激活**:`'Rewards inactive — attributions recorded; commission held in pending_commission_escrow (30d window) until you activate'`
  - **主动关闭**:`'Rewards deactivated — attributions recorded; commission redirects DIRECTLY to charity_fund (permanent, non-refundable per §3.4)'`
- MCP `webaz_info` 合规披露:新增一行 "**Reward participation is opt-in**; default = off. Users must apply (Passkey + completed orders); see [`RFC-002`](RFC-002-rewards-opt-in.md)"(法律全文见 [`PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](../PARTICIPATION-ATTRIBUTION-COMPLIANCE.md) / [`LEGAL-DISCLOSURES.md`](../LEGAL-DISCLOSURES.md))

### 3.8 PWA 改动 / PWA updates

- `#me` 区域新增 entry:
  - 未 opted-in:**「申请加入共建身份」**(按钮);若 pre-check 不过,显示 disabled + 缺什么清单
  - 已 opted-in:**「共建身份(已激活)」**+ 链接到 `#rewards-status`(显示历史申请 + [关闭] 按钮)
- 新增页面 `#rewards-apply`(申请详情 + 披露 + Passkey ceremony)
- 新增页面 `#rewards-deactivate`(关闭流程)
- 既有 `#share` / referral UI:opted-out 时显示引导卡片("先申请共建身份才能生成分享链接")

### 3.9 文档同步 / Doc sync

- [`ECONOMIC-MODEL.md`](../ECONOMIC-MODEL.md) 加一节 §X "Opt-In Participation Model"
  **前置依赖**:必须先完成 §11 "Mersenne tree 位置=分润"未决表述修正(见 Status 顶部 Blocked-by)。§11 修正后 §X 才能写入,避免内部 §X / §11 口径冲突(#4 不撒谎)
- [`/welcome`](../../src/pwa/public/welcome.html) 公开页加一段:"普通用户默认仅消费,不参与奖励体系;参与需主动申请"
- [`META-RULES-FULL.md`](../META-RULES-FULL.md) §3 / §4 / §7 解释段落更新(列举本 RFC 作为入口侧落地)
- [`CHARTER.md §4`](../CHARTER.md) invariants 章节登记 `protocol_params.rewards_opt_in.require_passkey=1` 为 meta-rule-locked param

### 3.10 同意文本版本化与重新确认 / Consent text versioning & re-confirmation

**问题**:如果披露文本(commission 结构 / MLM 风险 / 合规相关声明)在用户激活后实质变更,基于旧版本同意继续参与新结构 = 知情同意可能失效,违反 #4 不撒谎。

**机制**:

```
consent_text 数据结构:
  version: <major>.<minor>(e.g. "1.0", "1.1", "2.0")
  hash: sha256 of canonical text
  change_class: 'major' | 'minor'
  effective_at: timestamp
  changelog: human-readable diff summary
  (存在 rewards_consent_texts 表 — 见 §3.6)
```

**major 变更触发条件**(穷举,任一即触发):
1. Commission 结构变化(7:2:1 比例 / L1/L2/L3 定义 / chain_gap 规则 / 新增佣金层)
2. MLM 风险披露文本实质修改(措辞、覆盖辖区、法律 framing)
3. 合规相关声明变化(辖区列表 / 监管态度披露 / 税务承担方)
4. 关闭路径 / charity redirect 规则变化(escrow 窗口 / 是否可追溯 / 不可逆性)
5. Iron-Rule 相关边界变化(Passkey 要求 / 真人验证条件)
6. 申请前置条件实质变化(min_completed_orders / require_passkey 等参数)

**minor 变更**(不触发,仅升 minor + 留 changelog):
- 文案润色 / 排版 / 错别字
- i18n 完善 / 新增翻译
- 链接更新 / 引用版本号

**Major 变更生效流程**:

```
1. 新 consent_text 写入 rewards_consent_texts,标 version major+1
2. 所有 rewards_opted_in=1 用户立即收到强提示(站内 + 邮件 + MCP notification)
3. 用户须在 PWA 重新阅读完整披露页 + 双勾选 + Passkey 签名
   (本动作记录为 action='reconfirm',与 'activate' 区分)
4. 宽限期 = protocol_params.rewards_opt_in.reconfirm_grace_days(默认 14 天)
5. 宽限期内未重新确认 → 系统自动降级:
   → flag 自动降为 0
   → 写入 rewards_applications 记录,**action='auto_downgrade'**(与用户主动
     'deactivate' 严格区分),verification_method='system_auto',无 Passkey 签名
   → 该状态下新 commission 进入 pending_commission_escrow(走"系统降级"语义,
     不走"主动关闭"的 charity 直通)— 给用户保留重新确认机会
   → 此降级**跳过 §3.4 的 type-to-confirm + 二次验证**:这是协议主动行为
     而非用户行为,要求用户验证反而违反 #8 最小介入(系统不应要求用户
     验证系统自己的强制动作)
6. 用户随时可补做确认(action='reconfirm')→ 即时恢复 flag = 1 + escrow 中
   未过期 entries 自动批量 settle
7. 所有 rewards_applications 记录关联 consent_version(可审计追溯)
```

> **⚠️ 实现状态 + 部署门(2026-06-13, Codex #354 P2).** 上面的【reconfirm 流程(步骤 2–3:站内提示 →
> PWA 重新阅读 → Passkey 签名 → `action='reconfirm'`)尚未接线】:`POST /api/rewards/apply` 对已 opted-in
> 用户返回 `ALREADY_OPTED_IN`,前端 `status.opted_in` 早返回,没有 reconfirm 入口。因此发布一个新的
> `change_class='major'` consent 会武装 auto-downgrade(rewards-auto-downgrade.ts),但 opted-in 用户**无法
> 在宽限期内签署新版本**。**部署门**:在 reconfirm 路径实现之前,新 major consent **仅当目标库 opted-in 用户
> 为 0 时才可部署** —— 部署前必须只读核验:
> ```
> SELECT COUNT(*) FROM users WHERE rewards_opted_in = 1;   -- 必须为 0
> ```
> 若 >0:先实现 reconfirm 路径,或不要以 major 发布。v1.1 已于 2026-06-13 核验生产 opted_in=0(安全)。

**用户视角的 4 种 opt-out 状态**(关键区分,影响 commission 流向):

| 状态 | rewards_applications 最近 action | commission 流向 |
|---|---|---|
| 从未激活 | (无记录) | escrow(30d 后 charity) |
| 已 reconfirm | reconfirm | flag=1, 正常 settle |
| 主动关闭 | deactivate | **直接 charity_fund**(永久) |
| 系统自动降级 | auto_downgrade | escrow(30d 后 charity;给重新确认机会) |

**Pre-launch 实施**:RFC-002 实施时 consent_text v1.0 写入;v1.x → v2.x 升级仅在内容确实 major 变更时触发。

**为什么从 Open question 提升为 Design**:这是合规底线;不能 launch 后再想。变更后老用户基于旧条款继续参与新结构 = 法律意义上的「知情同意失效」。

---

## Meta-rule impact / 元规则影响

逐条对照 [`META-RULES-FULL.md`](../META-RULES-FULL.md):

- **#1 当一切可见**:✅ 强化。`rewards_applications` 表留痕(consent_hash 版本化 + ts + verification_method),申请 / 关闭事件完全透明可审计
- **#2 代码即规则**:✅ 强化。gate 行为完全由 `rewards_opted_in` flag + protocol_params 决定,无任何 admin override
- **#3 不偷数据**:✅✅ **核心修复点**。从「默认采集所有用户的经济关系数据」改为「明确同意后采集」
- **#4 不撒谎**:✅✅ **核心修复点**。披露页与代码行为一致:文档说"是 opt-in",代码就 default 0
- **#5 不偏袒**:✅ 强化。不开 admin 白名单 bootstrap,创始用户也走完整 pre-check(Passkey + 订单)
- **#6 不滥用**:✅ 强化。pre-check 防大批量伪账号申请;阈值参数化由 DAO 调
- **#7 不操纵**:✅✅ **核心修复点**。agent 注册新用户后**不能**默认替用户加入;MCP 必须引导用户去 PWA 主动申请
- **#8 最小介入**:✅ 强化。注册路径零变,仅 4 处 gate;关闭流程不带"挽留"骚扰
- **#9 算法即协议**:✅ 中性 → 强化。阈值进 `protocol_params`,可被 DAO 治理;关闭不需人工干预
- **#10 参与者即 webazer**:✅ 强化。本 RFC 第一次明确**把"普通消费者(opted-out)承认为完整 webazer"**,而非"未激活待激活者" — 之前的默认 ON 模型隐含"参与=必入经济关系",opt-in 模型把"仅消费"作为完整一类参与者,扩大了 webazer 定义边界,符合 #10 把"参与者"宽泛定义为"所有协议使用者"的本意

**Iron-Rule 技术边界 / Iron-Rule technical boundary**:

- ✅ 申请 = Passkey 签名 → 等同于 "require_human_presence" 在入口侧的延伸(填补盲点:入口本身现在也是真人路径)
- ✅ 关闭 = Passkey OR Password 二次验证 → 不下调 Iron-Rule 现有 7 条强度,只补充入口
- ⚠️ 不引入新铁律节点(避免膨胀),但**事实上**将"入口"纳入真人保护范围。若 DAO 认为需提至铁律级别,可后续走 meta-rule 60d track

---

## Alternatives / 替代方案

### Alt 1: 默认 ON,关闭走申请

注册即默认 enrolled,用户若不想参与去申请 opt-out。

**为什么不选**:违反 #3 / #4 / #7。"默认采集"= 没取得知情同意就纳入经济关系 = compliance 上风险更大,且与"参与是自愿的"对外披露不一致。

### Alt 2: 注册时弹窗询问

注册路径中加一步"是否加入奖励体系"勾选。

**为什么不选**:
1. 注册流程是用户最匆忙、最不读条款的环节 → 同意≠知情同意
2. 在注册流推销奖励 = 触发 #7 操纵风险(agent 替用户注册时极易勾上)
3. **入口与申请混在一起** → 用户没看够商品就被要求做经济决策,顺序错

### Alt 3: 不做 opt-in,加强对外 disclaimer

继续默认 ON,只在 `webaz_info` 文档加强披露,要求 agent 在调用前告知用户。

**为什么不选**:#4 不撒谎要求**代码与文档一致**。仅靠文档披露而不改默认值 = 给纸面声明,代码仍在默认 enroll → 第三方尽调 agent 戳穿是迟早的事。整改方法论已明确:**披露不能替代行为修正**。

### Alt 4: 申请门槛更高(Passkey + 完成订单 ≥ 3 笔 + 注册 ≥ 7 天)

提高 Sybil 防御。

**为什么不选**(暂不):pre-launch 阶段 0 真用户,初始门槛过高会让早期用户**永远进不来**;先用 `1 笔` 作为起步,留 `protocol_params` 可调,真攻击发生时 DAO 上调即可。

---

## Migration & compatibility / 迁移与兼容

### 数据 / Data

- pre-launch 0 真用户 → 所有 fixture 用户统一默认 0,无 backfill 决策
- 现有 commission / PV 测试数据 / fixture 流程:测试用户需先用 dev 接口把自己 flag 翻 1 才能跑奖励路径(测试 helper 加一行 `setRewardsOptedIn(user_id, 1)`)
- production 部署 = ALTER TABLE 一次,无 downtime

### Agent 行为 / Agent behavior

- 注:pre-launch 0 真用户,无"已部署"agent。以下针对 W8 launch 后陆续对接的 agent 行为
- 未来对接的 MCP agent:`webaz_share_link` 返回 error 后,agent 看到 `next_steps` 自动告知用户去 PWA 申请(graceful degradation)
- 第三方 agent:对接 schema 需感知新增字段 — `webaz_referral` 返回 `rewards_opted_in`/`pending_escrow` 字段(additive,不破坏)

### API 兼容性 / API back-compat

- 无破坏性变更:新增字段都是 additive,新增 endpoints(`/api/rewards/apply` / `/api/rewards/deactivate` / `/api/rewards/status`)是全新路径

---

## Risks / 风险

### R1 — 早期用户增长障碍 / Early user growth friction

「必须完成 1 笔订单」可能成为早期增长障碍 — 没人买东西,就没人能开共建身份。

**缓解 / Mitigation**:
- 阈值低(1 笔),pre-launch 仅作意愿门槛
- 真实启动期可临时通过 protocol_params 改 `min_completed_orders=0`(只要 Passkey 就行),启动稳定后回升
- 创始期用户在 PWA 自然路径:逛 → 买一笔 → 申请(顺序自然)

### R2 — 申请页面被 agent 诱导真人完成 / Agent rails user through application

理论上,过度积极的购物 agent 可以把"加入奖励赚钱"包装成购物流的下一步,诱导用户稀里糊涂完成 Passkey 签名。**这恰是 #7 不操纵要防的核心场景**,不是"通用 Passkey 风险":别的 Passkey 操作(arbitrate / withdraw)是"用户本来就想做的事";唯独"加入奖励体系"是 agent 有动机替用户主动推动的事(尤其当 agent 被设计成"帮用户赚钱")。

**缓解 / Mitigation(本 RFC 直接处理,不留 future)**:
1. **顶部置顶提示**(§3.3):"本流程与购物无关,你可以随时退出"— 强制可见,不能折叠
2. **双勾选,第二个强制延迟**:`protocol_params.rewards_opt_in.consent_delay_seconds` 默认 8s。第二个勾选项("我自愿申请,非被诱导")在页面打开后 8 秒内 disabled,8 秒后才能勾。**绝不预勾**
3. **type-to-confirm 等价**:勾选必须人工触发,programmatic check 被前端拒绝(checkbox 加 input event 真实性校验)
4. **Pre-check 自然门槛**:必须 Passkey 已绑 + 完成 ≥1 笔订单(§3.2)— agent 没法在用户"零行为"状态下一键推到激活
5. **consent_hash 版本化**(§3.10):每次申请绑定 consent_version + 真人 Passkey 签名 → 审计可追溯是哪一版条款被同意
6. **披露文本明示反诱导**:"如果是被 agent / 第三方推销才来到这里,请关闭页面";第二个勾选项文本明确否定"被诱导"

**为什么不"future RFC"**:#7 操纵风险是本 RFC 元规则锚点,**入口必须自己负责**。把它推给 future = 把元规则修复推迟。

### R3 — 关闭通道被滥用恶意瘫痪用户奖励 / Deactivation channel abused

攻击者盗号后,即使没法转账(铁律保护),也可能恶意关闭目标用户的共建身份让其失去未来 commission。

**缓解 / Mitigation**:
- type-to-confirm 防一键关闭
- 二次验证(Passkey 或 Password):仅有 api_key 不够
- 关闭事件强通知(站内 + 邮件)→ 用户察觉异常立即重新激活(再来一次 Passkey 即可)
- 关闭不会触发已结算 WAZ 退出,损失仅限"未来还没发生的 commission"(可控)

### R4 — 与现有 fixture / 测试数据脱节 / Fixture data desync

现有测试假设所有 user 都能拿 commission;改动后,fixture 跑奖励测试都会失败。

**缓解 / Mitigation**:
- 测试 helper 加 `setRewardsOptedIn(user_id, true)` 一行
- e2e 测试明确分两类:opted-out 用户行为 / opted-in 用户行为
- 此点列入测试计划 §test plan T5

### R5 — opted-out 大V 翻车场景 / Opted-out top-promoter resentment

**更恶劣的子场景**(原文遗漏):A 是大V,opt-out 状态下 `webaz_share_link` 被 hard-fail,但 A 可以通过**别的方式**(口碑 / 线下 / 截图 / 评论区文字)带来真实成交。`bindReferralAttribution`(§3.5)始终记录 attribution(关系层完整),但若 commission 直接 redirect charity → A 事后发现"我明明带来了 N 单,一分没拿,全捐了" → 强烈负面 → 劝退最想要的传播者。

**缓解 / Mitigation(P1-1 加强)**:

1. **核心机制:Pending commission escrow**(§3.5b):未 opt-in promoter 的 commission 不直接 redirect charity,先进 escrow 队列,30 天追溯窗口
2. **登录强提示**:promoter 登录时显著条幅"你有 N 笔推广(共 X WAZ)待激活领取,Y 天后过期 → [立即激活]"
3. **MCP 提示**:`webaz_referral` 返回新增 `pending_escrow: { total_amount, expiring_soon: [...] }` 字段
4. **激活流程整合**:激活成功后,前端自动跳"已自动结算 X WAZ"提示页(把负面体验转正面)
5. **披露页明示**:申请页 + 关闭页都明确写"escrow 窗口 30 天;过期不可追溯"
6. **过期 redirect 时不可逆**:expires_at 触发后 status='expired' + 进 charity_fund;不允许后续追讨(避免无限追溯的法律 / 财务复杂度)

**为什么 30 天**:够 promoter 看到通知 + 完成订单门槛(若不达成)+ 完成 Passkey 绑定的反应时间;不长到造成 charity_fund 流入不可预测。`protocol_params.rewards_opt_in.escrow_days` 可调。

### R6 — 申请门槛被 DAO 调到 0 / DAO lowers threshold to 0

未来 DAO 可能为了拉新把 `min_completed_orders` 调到 0、`require_passkey` 调到 0 → 等同于默认 ON 倒退。

**缓解 / Mitigation(本 RFC 内闭环,见 §3.6 P0-4 修订)**:
- `protocol_params` 表新增 `requires_meta_rule_change` 列;`require_passkey` 和 `consent_delay_seconds` 标 1
- CI lint 强制:任何 `=1` 参数的变更 PR 必须以 meta-rule track(60d)提交 RFC,否则阻塞
- 这把"声明保护"转为"执行保护",闭合 P0-4 漏洞
- `min_completed_orders` / `escrow_days` / `reconfirm_grace_days` 标 0(允许普通参数 RFC 调整,因为门槛/窗口是运营参数而非合规底线)

### R7 — 真人小额 Sybil farming / Real-person low-stakes Sybil farming

Pre-check「Passkey + 1 笔订单」对**真人海战术**防御不足:攻击者可以雇真人(或自己跨设备/账号)+ 真实小额订单(几 WAZ 即可),低成本完成 pre-check 后批量做 commission farming + PV 树位置占坑。

**为什么 P1 而非 P0**:
- Pre-launch 0 真用户,攻击窗口未开
- 关系层完整性原则(§3.0)兜底:即使账号被 farm,他们的 attribution / PV 位置照实记录,DAO 后续可追溯异常并 ex-post 处理
- 估值层不在本 RFC 内实施(commission/PV 真实结算依赖 W3.5-0 经济决策);farming 收益当前 = 0

**缓解 / Mitigation**:
- **本 RFC 内**:门槛参数化(`min_completed_orders` 可被普通 RFC 上调到 3-5 笔),`require_passkey` meta-rule 锁,launch 后真攻击发生时 DAO 调参即可
- **依赖其他 task**:
  - Agent passport 体系(#1038/#1039)— custodian_fp 共指纹检测(同监护人下批量账号)
  - 异常 PV 树结构监测(规划中,launch 后真用户 ≥ 1k 触发实施)
  - 邀请链 graph 分析(异常 fan-out / 短路径密集触发审查)
- 本 RFC 不重复造防御工具,只确保关系层数据完整以供后续工具消费

**Iron-Rule 关联**:本风险不归本 RFC 单独负责,但要求:本 RFC 不引入"绕过 Passkey 即可申请"的快捷路径(已满足)。

---

## Test plan / 测试计划

### T1 — Schema migration / 模式迁移

- ALTER 在 fresh DB + 现有 DB 都成功
- 默认值 0 应用于所有现有 + 新增用户
- `schema:verify` script 验证

### T2 — Pre-check matrix / 前置检查矩阵

| 用户状态 | Passkey | 订单 | 期望 |
|---|---|---|---|
| 新注册 | 无 | 0 | application API → 拒,缺 2 项 |
| 绑 Passkey 但无订单 | 有 | 0 | 拒,缺 1 项 |
| 无 Passkey 但有订单 | 无 | 1 | 拒,缺 1 项 |
| 全齐 | 有 | 1 | 通过,进披露页 |
| 全齐 | 有 | 100 | 通过 |

### T3 — Activation flow / 激活流程

- 双勾选未全打 → 提交按钮 disabled
- Passkey 取消 → 申请回滚,flag 不翻
- Passkey 成功 → DB 写 `rewards_applications` + flag = 1 + audit log

### T4 — Deactivation flow / 关闭流程

- type-to-confirm 输错 → 按钮 disabled
- Passkey OR Password 二次验证矩阵
- 关闭后 → flag = 0,但已有 WAZ 余额不变
- 已 attributed 但未结算的订单 → 等结算时 redirect 到 charity_fund(T6 验证)

### T5 — Reward gate behavior / 奖励 gate 行为

| 场景 | 期望 |
|---|---|
| B(opted-in)买 A(opted-in)推荐的商品 | A 拿 commission(原有逻辑) |
| B 买 A(opted-out)推荐 | commission redirect charity_fund |
| B(opted-out)买 A(opted-in)推荐 | A 拿 commission(B 状态不影响 A 收益) |
| C 通过 ref URL 注册后买 A 推荐 | L2 chain 看 C / A 各自 opt-in 状态分别 redirect |
| opted-out 用户 `webaz_share_link` 调用 | 返回 error + missing_requirements |

### T6 — Idempotency / 幂等性

- 同一用户连续 100 次"激活"调用 → 仅第一次写 rewards_applications(action=activate);后续 no-op + 返回 already_active
- 激活 → 关闭 → 激活循环 → 每个事件都留痕,flag 状态正确

### T7 — MCP smoke / MCP 烟雾测试

- `webaz_referral` 对 opted-out 用户返回 status 字段 + `pending_escrow` 字段
- `webaz_share_link` 对 opted-out 用户 hard-fail
- MCP `webaz_info` 合规披露含 opt-in 一行存在

### T8 — UI e2e / 前端端到端

- `#me` 页对 opted-out 显示申请按钮
- 申请按钮在 pre-check 不过时 disabled + 显示缺什么
- 申请详情页:顶部"非购物必要步骤"提示存在 + 不可折叠
- 第二个勾选项 8 秒内 disabled,8 秒后才能勾;**不预勾**
- programmatic checkbox.checked = true 被前端拒绝(input event 真实性)
- 关闭流程 type-to-confirm + 二次验证矩阵

### T9 — Pending escrow / 待激活托管(新)

- opted-out promoter 收到 commission → 写 pending_commission_escrow,不直接 charity
- 30 天前 promoter 完成 opt-in → escrow 中 entries 自动批量 settle
- 30 天到期未激活 → status='expired' + 进 charity_fund + 不可追溯
- 重新激活后,**已 expired 的不补**(只 settle 仍 pending 的)
- `webaz_referral` 显示 pending_escrow 总额 + 最近到期 entries

### T10 — Binary PV 树关系完整性 / Relation layer integrity(新)

- opted-out 用户注册 → 仍进 PV 树(关系层完整)
- 后续 opt-in → 节点位置不变,opt-in 后立即参与未来配对结算
- 节点位置永久 — 多次 opt-in/out 切换不重建关系
- attribution(referral chain)在用户 opt-in 状态切换时不变

### T11 — Consent 版本化 / Consent versioning(新)

- 写入 v1.0 consent_text,所有激活记录关联此 version
- 引入 v1.1 minor 变更 → 现有 opted-in 用户不受影响
- 引入 v2.0 major 变更 →
  - 所有 opted-in 用户收到强提示(站内 + 邮件 + MCP notification)
  - 14 天宽限期内补做确认 → flag 保持 1
  - 14 天后未确认 → flag = 0 + 新 commission 进 escrow(给未来激活机会)
  - 补做确认后,escrow 中未过期 entries 自动 settle
- consent_hash 篡改测试(任何文本字节修改 → hash 变 → 验证失败)

### T12 — Compliance copy / 文案合规

- 披露文本 hash 化 + 版本化 + change_class 标 major/minor
- 任何披露文本 PR 变更必须升 version + changelog 记录(CI lint 强制)
- consent_delay_seconds 参数生效:前端实际 disabled 8 秒(不能 JS 绕)
- `requires_meta_rule_change=1` 参数变更 PR 必须以 meta-rule track 提交,CI lint 阻塞普通 track 提交

### T13 — Deactivation abuse / 关闭通道滥用(R3)

- 攻击者持 api_key(无 Passkey / Password):
  - 关闭 API 调用 → 二次验证失败 → 拒绝,flag 不变,审计日志记录失败尝试
- 攻击者持 api_key + 拿到 Password(钓鱼):
  - type-to-confirm 必须人工输入"关闭共建身份"完整字符串(防 1-click)
  - 二次验证通过后关闭成功 → **强通知**(站内 + 邮件 + MCP webaz_notifications)→ 真人察觉异常立即重新激活(Passkey 重做即可)
- 已 settle WAZ 余额在关闭前后不变(损失仅限关闭期间产生的 commission → 全 charity 永久)

### T14 — auto_downgrade flow / 系统自动降级流程(P1-5)

- v2.0 consent 发布,opted-in 用户 14 天内不重新确认
  - day 14 末:cron 触发 → 写 action='auto_downgrade' + flag=0,**不要求 type-to-confirm / 二次验证**
  - 之后产生的 commission → 进 escrow(走"系统降级"语义,不是 charity 直通)
  - 用户做 reconfirm:flag=1 立即恢复 + escrow 中未过期 entries 批量 settle
- 区分性测试:`rewards_applications` 表中 deactivate vs auto_downgrade 必须严格区分(commission 流向不同)

---

## Open questions / 待决问题

1. ~~同意文本版本化策略~~ — **已 resolved**:从 Open question 提升为 §3.10 Design,major 变更强制重新确认 + 14 天宽限期降级回 escrow
2. **是否对 opted-out 用户进行"参与度提醒"**(进入门槛达成时通知"现在可以申请了"):草案默认 — 不通知(避免变相推广);用户自己来问才告知
3. **关闭后再激活的冷却期**:草案默认 — 无冷却。频繁切换看作用户自主权范围。
   **abuse 防护**:N 天内切换 ≥M 次 → 触发审计标志(不阻断,留痕供后期 DAO review)。
   M/N 阈值(候选 7d/3 次)待 launch 后观察决定;此条不在本 RFC v2 实施范围,留待 W3.5+
4. **激活时是否要求绑邮箱**:草案默认 — 不强制(已有 Passkey 真人证明 + 订单行为信号足够);邮箱仅 advisory

---

## Pre-flight checklist / 提交前自查

- [x] 我已读 [`CHARTER.md §6`](../CHARTER.md)(修改流程)和 [`§3.2`](../CHARTER.md)(多签矩阵)
- [x] 我已对照 [`META-RULES-FULL.md`](../META-RULES-FULL.md) 全部 10 条 — 见 §Meta-rule impact
- [x] 我理解【绕过 ≠ 修改】 Iron-Rule — 本提案不绕过 Iron-Rule 7 条,而是**补入口侧真人证明**(扩展而非弱化)
- [x] **本提案为 meta-rule track(60d)** — 实质修复元规则 #3 / #4 / #7 执行实现,且创建 `require_passkey` 这一 meta-rule-locked 参数,上锁动作本身需同级别公示
- [x] 本提案明确**阻塞**于 ECONOMIC-MODEL §11 修正 — 见 Status,task #1089;§11 修正未完成前本 RFC 不能进入正式审议期
- [x] 至少列了 2 个替代方案并说明为什么不选 — 见 §Alternatives(列了 4 个)
- [x] 关系层 vs 估值层 原则贯穿(§3.0)— 所有 gate 仅 gate 估值层,关系层永不被 opt-in 影响
- [x] R2 操纵风险本 RFC 直接处理(8s 延迟 + 反预勾 + 顶部反诱导提示)— 不留 future
- [x] **v2 自审**:P0×4 + P1×6 + P2 修订完成,见末尾 Changelog;关闭语义与 escrow 一致 / consent_version FK 完整 / `requires_meta_rule_change` CI lint 闭环

---

## Implementation tracking / 实现追踪

- **Blocking task**: #1089 ECONOMIC-MODEL §11 修正(前置)
- **Implementation task**: #1090 RFC-002 实施: rewards opt-in 共建身份申请制(blocked by #1089)
- **v2 draft task**: #1091 RFC-002 v2 草案 — P0×4 + P1×6 + P2 修订
- **Implementation PR**: TBD(blocked by #1089 完成 + 本 RFC 60d meta-rule track 通过)
- **Closing issues**: (n/a)

### 实施分解(参考)/ Implementation breakdown (reference)

| 项 | 时间 |
|---|---|
| 项 | 时间 |
|---|---|
| Schema(1 列 + 3 新表 + protocol_params 加 `requires_meta_rule_change` 列 + 5 参数) | 45 min |
| 4 处估值层 gate(关系层不动)+ "最近 action" 判定逻辑(区分主动关闭 / 自动降级 / 从未激活) | 1.5h |
| Pending commission escrow(写入 + 激活时批量 settle + 过期 cron + 主动关闭直通 charity 分支) | 1.5h |
| PWA 申请入口 + 详情披露页 + 顶部反诱导提示 + 8s server-side 延迟勾选 + Passkey ceremony | 3.5h |
| PWA 关闭流程 + type-to-confirm + 二次验证 + 4 项披露文案 + 强通知 | 1h |
| Consent 版本化基础设施 + major change 重新确认流程 + auto_downgrade cron | 2h |
| CI lint(`requires_meta_rule_change=1` 参数变更必须 meta-rule track) | 30 min |
| MCP 工具更新(`webaz_share_link` hard-fail / `webaz_referral` 加 pending_escrow + 4 状态 note / `webaz_info`) | 1h |
| 文档同步(ECONOMIC-MODEL §X / welcome 段落 / META-RULES 解释段 / CHARTER §4 invariant 登记) | 1h |
| 测试(T1-T14) | 2.5h |
| **总计** | **~15h** |

注:v2 增量 ~2h(P0-4 闭环 CI lint / auto_downgrade 流程 / T13+T14 新增)。可拆 3-4 个 PR 渐进合入:
1. Schema + 估值层 gate + escrow(基础设施)
2. PWA 申请/关闭流程 + 反诱导措施
3. Consent 版本化 + auto_downgrade + CI lint
4. MCP 工具 + 文档同步

---

## Changelog / 修订记录

### v2 (2026-06-02) — Review fixes

**P0(逻辑矛盾修复)**:
- P0-1:统一关闭语义。§3.4 明示「主动关闭 → 直接 charity_fund(永久,不可追溯)」;§3.5b 区分 4 种 opt-out 状态(从未激活 / 主动关闭 / 自动降级 / 已 reconfirm),commission 流向各异
- P0-2:`webaz_referral` note 修正描述,区分"从未激活(进 escrow)"vs"主动关闭(直通 charity)"
- P0-3:`rewards_applications` 表加 `consent_version` 列 + FK 到 `rewards_consent_texts(version)`,补全审计追溯链
- P0-4:`protocol_params` 表加 `requires_meta_rule_change` 列(本 RFC 内同步实施,**非"留待后续"**)+ CI lint 强制;`require_passkey` / `consent_delay_seconds` 标 1;闭合"声明保护无执行机制"漏洞

**P1(逻辑明确化)**:
- P1-1:§3.0 加 share_link hard-fail 的有意识 trade-off 说明(选 A 而非 B 的理由)
- P1-2:§3.5 标题改"5 个接入点 ─ 4 处估值层 gate + 1 处关系层操作",清晰准确
- P1-3:Meta-rule #10 改 ✅ 强化(首次承认 opted-out 用户为完整 webazer)
- P1-4:新增 §R7 真人小额 Sybil farming(P1 优先级,关系层完整性兜底 + 依赖 agent passport 等其他工具)
- P1-5:§3.10 明示 auto_downgrade 跳过 §3.4 type-to-confirm + 二次验证(系统动作非用户动作,符合 #8 最小介入)+ 新增 4 状态 commission 流向表
- P1-6:Implementation tracking 填入 #1089 / #1090 / #1091 task IDs

**P2(文案完善)**:
- §3.3 8s 延迟措辞:基于 server-side first-render timestamp,tab 切换不暂停,防 agent 模拟切换 bypass
- §Migration "已部署 MCP agent" → "未来对接的 MCP agent"(pre-launch 0 真用户事实诚实化)
- 新增 T13 关闭通道滥用测试(R3 覆盖)
- 新增 T14 auto_downgrade 流程测试(P1-5 覆盖)
- Open Q3 加 abuse 防护说明(候选 7d/3 次审计阈值,W3.5+ 决定)

### v1 (2026-06-02) — 初稿

最初草案 + 用户首轮 review 7 处修订(track meta-rule / Binary tree 全员入树 / blocked-by §11 / escrow / 关闭不可逆披露 / consent 版本化 / 反诱导)。
