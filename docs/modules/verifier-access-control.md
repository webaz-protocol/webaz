# Verifier 访问控制设计

**Status:** 第一期已规划，待实施
**Last updated:** 2026-05-14
**Owner:** holden (PM) · Claude (impl)

## 目的与背景

审核员（verifier）的工作是**核验商家提交的外部链接归属权**（验证码核对）— 这个判断**直接决定商品是否能挂在某个卖家名下**。错误的审核会让恶意卖家把别人的链接挂到自己商品上（劫持流量 / 误导买家）。因此审核员资格必须严格管控。

当前后端 `isEligibleVerifier()` 已硬性要求"必须在 `verifier_whitelist`"，但 PWA 注册时却开放选 `verifier` 角色 — 形成"装饰性角色"的不一致状态。本模块解决这个落差，建立完整的**申请 → 审批 → 试用 → 正式 → 处罚 → 申诉**闭环。

---

## 状态机

```
未申请
  │
  │ 用户主动申请（满足信誉指标 + 锁质押）
  ▼
pending ──── admin 拒绝 ────► rejected（30 天冷却后可重申）
  │
  │ admin 批准
  ▼
trial-1 ── trial-2 ── trial-3 ── active-1 ── active-2
                                                │
                                  ┌─────────────┘
                                  │
                          错 1 次 → suspended(7d) + 降一档
                          错 2 次 → suspended(30d) + 降两档
                          错 3 次 → revoked（3 个月冷却 + 没收 50% 质押）

任何状态 → admin 主动暂停 / 撤销
暂停期内 → 7 天内可申诉 1 次
```

---

## Tier 表（每日配额 — 全部封顶）

| Tier | 升级条件 | 每日配额 |
|---|---|---|
| trial-1 | admin 批准为试用 | 2 |
| trial-2 | 累计正确 ≥ 30 且正确率 ≥ 95% | 5 |
| trial-3 | 累计正确 ≥ 80 且正确率 ≥ 92% | 15 |
| active-1 | 累计正确 ≥ 200 且正确率 ≥ 90% 且 60 天活跃 | 30 |
| active-2 | 累计正确 ≥ 500 且正确率 ≥ 90% 且 180 天活跃 | **60** ← 满级封顶 |

**封顶 60 单/日的依据**：每单约 3 分钟（打开链接 → 找验证码 → 提交），60 × 3 = 180 分钟 ≈ 3 小时认真劳动。系统**不允许 ∞**，所有账户都有上限。

**计费颗粒度**：按"接单"扣，不按"提交"扣 — 防止占坑。未提交超时（24h）任务自动释放但当日配额不退。

---

## 信誉指标（申请门槛）

| 指标 | 阈值 | 数据源 |
|---|---|---|
| 账户年龄 | ≥ 60 天 | `users.created_at` |
| 邮箱已绑定 + 验证 | 必须 | `users.email_verified` |
| 完成订单（买 / 卖任一）| ≥ 20 笔 | `orders.status='completed'` |
| 零仲裁判输违约 | 必须 | `disputes.verdict` |
| 账户未曾被 admin 暂停 | 必须 | `user_moderation.suspended` |
| 钱包余额（不含质押）| ≥ 200 WAZ | `wallets.balance` |
| reputation 分 | ≥ 110 | `users.reputation`（初始 100） |
| 若有被告记录，按时响应率 | ≥ 80%（或无被告记录）| `disputes` |

---

## 质押

申请时锁定 **50 WAZ**（`wallets.balance` → `wallets.staked`）。
- demo / 早期：`env VERIFIER_STAKE_REQUIRED=0` 关闭
- 生产：50 WAZ
- 批准为 trial/active：质押保持
- 主动注销：1 个月后退回
- admin 撤销（严重违规）：没收 50%

---

## 处罚梯度

**触发条件**：每次任务结算时，verifier 提交内容与多数票最终结果不一致 → 1 次错误。

| 错误次数（180 天内）| 处罚 | 申诉窗口 |
|---|---|---|
| 第 1 次 | 暂停 7 天 + 降一档 Tier | 7 天内可申诉 1 次 |
| 第 2 次 | 暂停 30 天 + 降两档 Tier | 同上 |
| 第 3 次 | 撤销资格 + 3 个月冷却 + 没收 50% 质押 | 同上 |

**注**：内部审核员 `usr_iaudit_001` 标记 `system=1`，**不受**处罚梯度影响（系统兜底必须可靠）。

---

## 申诉机制（第一期必含）

**用户侧**：
- 暂停期内可点"📩 我要申诉"
- 写理由（≤ 500 字）+ 可附证据 URL（≤ 3 个）
- **同一处罚只能申诉 1 次**

**Admin 侧**：
- 概览页 KPI「待处理申诉」
- 申诉决策（第一期简化方案）：
  - **成立** → 解封 + 退还任务奖励 + 验证权 +2（误判补偿）+ 该次错误**不计入**累计
  - **不成立** → 维持原处罚（错误次数继续保留）
- **第一期不重新结算 task**（task 结果保持原状）。完整方案（重置该 verifier 在该 task 的 verdict + 让多数派担责）留到**第二期**。

---

## 关键设计决策记录

### D1. 严罚保留，忽略"心理压力"风险
- 用户决策（2026-05-14）：第 1 次错误暂停 7 天，不再用"正确率跌破 80%"作为软门槛
- 配套：必须有申诉机制兜底误判

### D2. 第一期申诉用简化方案
- 申诉成立 = 解封 + 验证权 +2 + 错误次数不计入
- **不动 task 结果**（实现简单，verifier 历史正确率会有"含冤"记录，但被申诉补偿覆盖）
- 完整重新结算留第二期

### D3. 内部审核员系统兜底
- `usr_iaudit_001` 标记 `system=1`：不受处罚梯度、不计配额、永久白名单
- 当活跃 verifier < 5 时 admin 概览红色警告
- `assignVerifiers()` 派单时若可用 verifier 不足，自动调用内部审核员补足

### D4. 拒绝"跨链接信任传递"
- 用户决策：每个链接独立众包验证，没有快速通道
- 卖家连续优质记录只反映在 reputation 分，不简化任何链接的验证流程
- 理由：链接归属权这种核心信号必须每次独立核实，否则可被铺路 + 钓鱼

### D5. 派单混采（第二期）
- 派单时强制满足：
  - 至少 1 个 active tier verifier
  - 不能 3 个 verifier 注册时间间隔都 < 7 天（防一次性开多号串谋）
- 第一期暂不实现（pool 小时强制混采可能派不出任务）

### D6. 现有 ENV `/admin/verifier-whitelist/*` 端点保留
- 作为根运维 fallback（如果 role-admin 系统出问题）

---

## 数据层 Schema

### 新表

```sql
CREATE TABLE verifier_applications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',   -- pending / approved / rejected / withdrawn
  applied_at      TEXT DEFAULT (datetime('now')),
  reviewed_at     TEXT,
  reviewed_by     TEXT,
  decision_note   TEXT,
  snapshot        TEXT                       -- JSON 信誉快照，决策依据
);

CREATE TABLE verifier_appeals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  task_id       TEXT,
  submission_id TEXT,
  reason        TEXT NOT NULL,
  evidence_urls TEXT DEFAULT '[]',
  status        TEXT DEFAULT 'pending',     -- pending / accepted / rejected
  admin_note    TEXT,
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

### 扩展 `verifier_whitelist`

```sql
ALTER TABLE verifier_whitelist ADD COLUMN tier            TEXT DEFAULT 'active';
ALTER TABLE verifier_whitelist ADD COLUMN daily_quota     INTEGER DEFAULT 60;
ALTER TABLE verifier_whitelist ADD COLUMN tasks_today     INTEGER DEFAULT 0;
ALTER TABLE verifier_whitelist ADD COLUMN quota_reset_at  TEXT;
ALTER TABLE verifier_whitelist ADD COLUMN granted_by      TEXT;
ALTER TABLE verifier_whitelist ADD COLUMN stake_amount    REAL DEFAULT 0;
ALTER TABLE verifier_whitelist ADD COLUMN cooldown_until  TEXT;
ALTER TABLE verifier_whitelist ADD COLUMN error_count_180d INTEGER DEFAULT 0;
ALTER TABLE verifier_whitelist ADD COLUMN is_system       INTEGER DEFAULT 0;
```

Tier → quota 映射在应用层：
```ts
const TIER_QUOTAS = { 'trial-1': 2, 'trial-2': 5, 'trial-3': 15, 'active-1': 30, 'active-2': 60 }
```

---

## API 端点

### 用户侧
| Endpoint | 用途 |
|---|---|
| `GET /api/verifier/eligibility` | 查我是否够申请条件 + 缺什么 |
| `POST /api/verifier/apply` | 提交申请 + 锁质押 |
| `GET /api/verifier/status` | 查申请 / 白名单 / 配额 / Tier |
| `POST /api/verifier/withdraw-application` | 撤回未审申请（退质押）|
| `POST /api/verifier/appeal` | 提交申诉 |

### Admin 侧
| Endpoint | 用途 |
|---|---|
| `GET /api/admin/verifier-applications` | 列表（按 status 筛选）|
| `POST /api/admin/verifier-applications/:id/approve` | 批准（含 tier 选择）|
| `POST /api/admin/verifier-applications/:id/reject` | 拒绝 + reason |
| `POST /api/admin/verifier-whitelist/:userId/promote` | 手动升 Tier |
| `POST /api/admin/verifier-whitelist/:userId/suspend` | 暂停 N 天 |
| `POST /api/admin/verifier-whitelist/:userId/revoke` | 撤销 + 冷却 + 没收质押 |
| `GET /api/admin/verifier-appeals?status=pending` | 待审申诉列表 |
| `POST /api/admin/verifier-appeals/:id/decide` | 决定（accepted / rejected + note）|

### isEligibleVerifier 升级
```
white-list 存在
  + cooldown_until is null 或已过
  + suspended_until is null 或已过
  + (tier startsWith 'trial' → tasks_today < daily_quota，自动重置每日)
  + 不是商品卖家
```

---

## UI 布局

### Verifier 角色用户

`#verify-tasks` 顶部根据状态分层显示：

| 状态 | UI |
|---|---|
| 未申请 | 紫色卡片「🛡 申请审核员资格」+ 信誉自检表（X/X 指标） |
| pending | 黄色卡片「⏳ 申请已提交」+ 可撤回 |
| rejected | 红色卡片「✗ 申请被拒绝」+ 原因 + 30 天冷却倒计时 |
| trial-N | 绿色卡片「🌱 试用期 Tier-N · 今日剩余 X/Y 单」+ 升级进度 |
| active-N | 蓝色卡片「✓ 正式审核员 active-N · 今日 X/Y」+ 累计统计 |
| suspended | 红色卡片「⏸ 暂停至 YYYY-MM-DD」+「📩 我要申诉」（如未申诉过）|

新页面 `#apply-verifier`：
- 信誉指标 checklist（含未达成的具体进度）
- 申请说明 + 质押提示
- 可选 note
- [提交申请] 按钮

新页面 `#verifier-appeal/:taskId`：
- 任务 ID + 当时提交内容（只读）
- 理由文本框（500 字）
- 证据 URL 输入（最多 3 个）
- [提交申诉] 按钮

### Admin 用户

- 概览页 KPI 加「待审申请」「待处理申诉」
- 新页面 `#admin/verifier-applications`：申请列表 + 决策
- 新页面 `#admin/verifier-appeals`：申诉审理
- 用户管理详情：审核员资格 section（提升 Tier / 暂停 N 天 / 撤销）

---

## 实施分期

### ✅ 第一期（已完成 2026-05-15）
- 数据层：applications + appeals + whitelist 扩展
- 用户侧 API：apply / eligibility / status / withdraw / appeal
- Admin 侧 API：applications + 提升 / 暂停 / 撤销 / 审申诉
- 处罚梯度：settleTask 错误 → 暂停 7/30/撤销 + 降档（依据 `error_count_180d`）
- 配额 enforcement + 每日 reset
- 前端：状态卡 + 申请页 + 申诉提交 + Admin 申请列表 + 申诉审理
- audit log
- 容量监控（admin 概览 < 5 红色警告）

### ✅ 第二期（已完成 2026-05-15）
- 自动 Tier 升级（`maybeAutoPromote` 在 settleTask correct 分支调用，只升不降）
- 派单混采（`assignVerifiers` 升级：必含 1 个 active / 限 2 个新号 / 系统兜底）
- 申诉完整重审（accepted 时翻转 verdict + 补发奖励 + tasks_correct +1 / tasks_wrong -1 + 验证权 +3）

### ⏳ 第三期（延后）
- 自动 demote（6 个月不活跃 → 降 Tier）
- top verifier 排行榜（按 tasks_correct 排序，激励向）
- 拓展容量监控：独立 `#admin/verifier-pool` 页面（各 tier 分布 + 利用率）

---

## 现有 verifier 过渡

- 审核A（role=verifier 但未在白名单）→ 登录后看到"申请审核员资格"卡片
- 不自动给 trial（流程一致：所有 verifier 都必须显式申请）
- 这样测试也能完整跑：审核A 申请 → 管理员A 批准 → 接任务 → 故意做错 → 暂停 → 申诉 → 解封
