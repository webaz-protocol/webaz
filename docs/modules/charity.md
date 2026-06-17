# 慈善许愿池 + 还愿 + 慈善基金

最近更新：2026-05-19
相关 commits：`6219b35` `6e5f3e8` `32d3063` `aae2ae4` `87443af`
代码位置：`src/pwa/server.ts` (L13110-L13700)；`src/pwa/public/app.js` (charity 段)；`src/layer1-agent/L1-1-mcp-server/server.ts`

## 一、目的

让用户在商业场景之外，能匿名互助：
- 许愿（实物 / 服务 / 现金救助）
- 圆梦（任何人可认领并完成）
- 还愿（圆梦后被帮助者可自愿回报；圆梦人可谢绝转入基金）
- 捐款（任何人随时可向基金注入）

**完全隔离于商业 reputation**，prestige 不影响商品排序。

## 二、数据模型

### 4 张主表

```sql
wishes (
  id, user_id, wisher_handle, category, title, content,
  target_kind, target_waz, escrow_locked, commit_hash,
  allow_public, status, fulfiller_user_id, claimed_at,
  completed_at, expires_at, created_at
)

wish_fulfillments (
  id, wish_id, fulfiller_user_id, fulfiller_handle,
  proof_hash, proof_note, fulfiller_sig, wisher_sig,
  status, confirmed_at, disclose_wisher, disclose_fulfiller,
  disclosed_at, created_at
)

charity_reputation (
  user_id PRIMARY KEY,
  prestige_score, wishes_made, wishes_fulfilled, badge_tier,
  repay_honor, redirect_honor, grace_honor,
  donation_total, donation_honor,
  last_active, last_decay_at, created_at
)

charity_blocklist (
  user_id, reason, until, created_at
)
```

### 3 张基金表

```sql
charity_fund (
  id='main' (单例),
  balance, total_donated, total_disbursed, total_redirected,
  updated_at
)

charity_fund_txns (
  id, kind ('donation'|'repay_redirect'|'disburse'),
  from_user_id, to_user_id, amount,
  related_wish_id, related_repay_id, note, created_at
)

wish_repayments (
  id, wish_id, fulfillment_id,
  wisher_user_id, fulfiller_user_id, amount, note,
  status ('offered'|'accepted'|'declined_to_fund'|'expired_auto_accept'),
  responded_at, auto_expire_at, locked, created_at
)
```

### 1 张举报表

```sql
wish_reports (
  id, wish_id, reporter_id, reason ('spam'|'fraud'|'inappropriate'|'other'),
  note, status ('pending'|'dismissed'|'actioned'),
  created_at,
  UNIQUE(wish_id, reporter_id)
)
```

## 三、关键设计

### 双匿名

```typescript
const CHARITY_ANON_SEED = process.env.CHARITY_ANON_SEED || (MASTER_SEED + ':charity:anon:v1')
function charityAnonHandle(userId, wishId, role) {
  return createHmac('sha256', CHARITY_ANON_SEED)
    .update(`charity:${role}:${userId}:${wishId}`)
    .digest('hex').slice(0, 12)
}
```

- `wisher_handle` / `fulfiller_handle` 每个 wish_id 不同
- 前端 GET 端点**永不返回** raw user_id
- 独立 `CHARITY_ANON_SEED`：MASTER_SEED 单独泄露 ≠ 全员去匿名化

### 双签锚定（事件可验证不暴露身份）

```typescript
// 圆梦人签名
fulfiller_sig = HMAC(api_key_B, `${wish_id}|${proof_hash}`)

// 许愿人签名
wisher_sig = HMAC(api_key_A, `${wish_id}|${proof_hash}|confirm`)
```

任何第三方都能验证 "事情发生了"（用 sig 比对 proof_hash + 公开的 commit_hash），但拿不到 raw user_id。

### 反自圆梦

claim 时检测 `w.user_id === user.id` → 立刻插入 `charity_blocklist`，封锁 30 天，错误返回 `blocklist_reason: 'self_fulfill_fraud'`。

### 月度上限

- 每用户每月最多 **5 个许愿** / **10 次圆梦**
- 防 prestige 刷量

### 现金类托管

- `target_kind === 'cash'` 时强制 `target_waz ≤ 500 WAZ`
- 可选 `escrow_self`：锁仓全额到 staked
- confirm 时自动从 `wisher.staked` → `fulfiller.balance`
- 14 天 wisher 不 confirm → 自动 confirm（防 escrow 永锁）

## 四、状态机

### Wish 状态

```
open ─→ claimed ─→ completed (双方签名)
  │       │
  │       ├─→ expired (48h 无人交证据 → 回 open)
  │       └─→ (14 天 wisher 不 confirm → auto confirm)
  │
  ├─→ cancelled (wisher 主动取消)
  ├─→ expired (有效期满)
  └─→ disputed (3 个不同举报人 → 自动隐藏)
```

### Repayment 状态

```
offered ─→ accepted (fulfiller 主动)
  │
  ├─→ declined_to_fund (fulfiller 主动转基金)
  └─→ expired_auto_accept (7 天 fulfiller 不响应 → 自动 accept)
```

## 五、荣誉公式

| 触发 | 受益人 | 荣誉细分 | prestige |
|---|---|---|---|
| 圆梦确认 | fulfiller | wishes_fulfilled+1 | +10 |
| 圆梦确认 | wisher | — | +1（鼓励 confirm）|
| 还愿 accept | fulfiller | repay_honor +5 | +5 |
| 还愿 decline_to_fund | wisher | redirect_honor +3 | +8（5+3）|
| 还愿 decline_to_fund | fulfiller | grace_honor +2 | +2 |
| 捐款 (per WAZ) | donor | donation_honor +1（日上限 50） | +n |
| 14 天 auto-confirm | fulfiller | wishes_fulfilled+1 | +10 |
| 48h 超时回收 | (前) fulfiller | — | −1 |

### 徽章阶梯

```
diamond  💎  prestige ≥ 1000
gold     🥇  prestige ≥ 200
silver   🥈  prestige ≥ 50
bronze   🥉  prestige ≥ 10
none     🌱  < 10
```

衰减：90 天无活动 → prestige × 0.95（鼓励持续）

## 六、API 端点

| 方法 | 路径 | 鉴权 | 限流 |
|---|---|---|---|
| POST | `/api/wishes` | yes | 10 req/min |
| GET | `/api/wishes` | 无 | — |
| GET | `/api/wishes/:id` | 无 | — |
| POST | `/api/wishes/:id/claim` | yes | 30 req/min |
| POST | `/api/wishes/:id/proof` | yes | 30 req/min |
| POST | `/api/wishes/:id/confirm` | yes | 30 req/min |
| POST | `/api/wishes/:id/disclose` | yes | — |
| POST | `/api/wishes/:id/cancel` | yes | — |
| POST | `/api/wishes/:id/report` | yes | 10 req/min |
| POST | `/api/wishes/:id/repay` | yes | 20 req/min |
| POST | `/api/wishes/:id/repay/:rid/respond` | yes | 20 req/min |
| GET | `/api/charity/me` | yes | — |
| GET | `/api/charity/stories` | 无 | — |
| GET | `/api/charity/leaderboard` | 无 | — |
| POST | `/api/charity/fund/donate` | yes | 20 req/min |
| GET | `/api/charity/fund` | 无 | — |

## 七、MCP 工具

`webaz_charity` 单工具 11 action：
- `list` / `detail` / `create` / `claim` / `proof` / `confirm` / `disclose` / `cancel`
- `me` / `stories` / `leaderboard` / `fund`
- `repay` / `repay_respond` / `donate`

## 八、前端 5 页 + 1 入口

| 路由 | 页面 | 说明 |
|---|---|---|
| `#wishes` | 许愿池主页 | 类目/形式筛选 + 列表 |
| `#wish/new` | 发布愿望 | 表单（含 cash 自托管选项）|
| `#wish/:id` | 愿望详情 | 状态推进 + 证据 + 还愿响应 + 举报 + 14 天 deadline 提示 |
| `#wish/mine` (= #charity/me) | 个人档案 | 5 项荣誉细分 + 我的愿望/圆梦 + 待响应还愿 |
| `#wish/stories` | 故事板 | 公开披露的圆梦故事 |
| `#wish/fund` | 慈善基金 | 余额 + 慈善家排行 + 流水 + 捐款入口 |
| `#wish/leaderboard` | 威望榜 | 全员慈善 prestige 排行 |

入口：
- 买家 + 卖家 tab bar 的 `#me` hub 通用区
- `#discover` 顶部 6 板块横条

## 九、运营风险防御

| 风险 | 对策 |
|---|---|
| 洗钱 | cash 单愿上限 500 WAZ；现金救助走第三方背书强制（v2 路线）|
| 不当愿望 | `wish_reports` 表 + 3 人自动 status='disputed' 隐藏 |
| 元数据泄露身份 | 不显示精确发布时间（精确到天）；不显示 IP/region |
| 信誉刷量 | 月度上限 5 愿/10 圆；同对手方仅算 1 次/月（v2 待加）|
| 卖惨欺诈 | 第三方背书档（v2）+ 高额强制走此档 |
| 自圆梦 | claim 时 user_id 比对，30 天封锁 |
| 现金类 escrow 永锁 | 14 天 fulfiller 兜底自动确认 |

## 十、审计修复批次（共 16 处 + 6 UI）

### 1 轮 P0 竞态（4 处）
- claim/confirm/repay_respond/auto-accept 全部 `UPDATE ... WHERE status=X` + `changes()` 守门

### 1 轮 P1 业务/隐私（6 处）
- disclose 后端兜底 `allow_public`
- GET `/api/wishes` 不再触发 expireCharityWishes（仅 enforcement 5min 扫）
- 48h 改判 `NOT EXISTS ANY wf`（不再误回收已交证据）
- 14 天 fulfiller 兜底自动确认
- 6 端点 rate-limit 20-30 req/min

### 1 轮 P2 工程（6 处）
- 删 secret_keep_safe 死字段
- blocklist reason 改 enum code
- `wish_reports` 表 + 3 人自动 disputed
- 5 事件写 `notifications`（带 wish_id 可跳转）
- 复合索引 `(from_user_id, kind, created_at DESC)`
- 独立 `CHARITY_ANON_SEED`

### 1 轮 UI 补完（6 处）
- 举报按钮 + 弹层
- 通知 `wish_id` 跳转 + 友好 body
- 14 天 deadline 提示给 wisher
- AUTO_CONFIRM 蓝色 badge
- blocklist reason 映射 label
- 13 条新 i18n

## 十一、留 v2

- 自动拨款（紧急医疗/教育大额匹配）
- 捐物（specific event 定向）
- 链上账本（基金 + repay 上链锚定）
- 第三方背书档（高额必走）
- 同对手方月度上限（防双方共谋刷信誉）

## 十二、E2E 验证

```
A 创建愿望 → wisher_handle=ce15e937e3ad
B 认领 (1:1 独占)
B 提交证据 (HMAC 签名)
A 确认 → wisher_sig + B 拿 +10 prestige
A 还愿 5 WAZ → staked 锁仓
B 谢绝 → fund balance +5 / A redirect_honor +3 / B grace_honor +2
A 捐款 10 WAZ → fund +10, A donation_honor +10
A 自圆梦尝试 → 30 天封锁
```
