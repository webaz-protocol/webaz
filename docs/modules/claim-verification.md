# Claim Verification — 推荐理由验证系统

WebAZ 协议级保障：买家可对商品的推荐理由（`computeBuyReasons`
计算出的"为什么买这个"清单）发起第三方验证。3 verifier 共识仲裁
后按多数派结算资金。

## 设计哲学

> Agent / 平台告诉你"应该买"，但**可质疑、可仲裁**才是协议级保障。

verifier 系统替代"中心化客服仲裁"：
- 任何信誉 ≥ 200 或 verifier_whitelist 的用户都可接单
- 3 人共识，少数派记 outlier 积累惩罚
- 经济激励对齐（多数派得奖励 / 少数派付出 reputation 风险）

## 4 路径结算（M7.3b 实现）

| 路径 | 触发 | 买家 | 多数 voter | 卖家 | 协议池 |
|---|---|---|---|---|---|
| **pass** 通过 | 多数 pass | 退 50%（5 WAZ） | 拆 50%（5 WAZ）+ 卖家 fine 一半 | 扣 `stake_amount × 10%` fine | 卖家 fine 一半 |
| **fail** 失败 | 多数 fail | 全扣（0） | 拆 50%（5 WAZ） | — | 50%（5 WAZ） |
| **no_fault** 无责 | 多数 no_fault / 并列 | 全退（10 WAZ） | 协议池补贴每人 1 WAZ | — | -1 × N |
| **timeout_no_fault** | open + 0 票 + 过期 | 全退（10 WAZ） | — | — | — |

卖家 fine 若 product 未锁 stake（M7.2.6 deferred）：从 balance 扣 +
立即写 `stake_locked_at` 避免后续 settleOrder 二次扣。

## Schema

```sql
CREATE TABLE claim_verification_tasks (
  id, order_id UNIQUE, buyer_id, seller_id, product_id,
  claim_target ('price'|'commission'|'protection'|'return'|'warranty'|'handling'|'other'),
  claim_text (6-500 字), evidence_uri,
  stake_buyer (default 10), deadline_at (now+48h；卖家证据后 +24h),
  seller_evidence_uri, seller_evidence_at,
  status ('open'|'sealed'|'resolved_pass'|'resolved_fail'|'resolved_no_fault'|'timeout_no_fault'),
  majority_vote, resolved_at, created_at
)

CREATE TABLE claim_verification_votes (
  id, task_id, verifier_id, vote ('pass'|'fail'|'no_fault'),
  evidence_uri, note, voted_at, was_majority (1/0/NULL, settle 后填),
  UNIQUE(task_id, verifier_id)
)

CREATE TABLE claim_verifier_suspensions (
  id, user_id, type ('suspended'|'revoked'), until_at,
  reason, outlier_count, created_at
)
```

## 资格门槛

`isEligibleClaimVerifier(userId)`:
1. 先查 `claim_verifier_suspensions` — revoked 永封 / suspended 至 until 都拒
2. `verifier_whitelist` 一票通过（含内部审核员）
3. `reputation_scores.total_points ≥ 200`（trusted 等级）
4. 投票时额外校验：非 buyer / 非 seller / 同时活跃任务 ≤ 5

## API

| 端点 | 用途 |
|---|---|
| `POST /api/orders/:id/claim-verification` | 买家发起（锁 10 WAZ，1:1 绑订单，不可撤销） |
| `GET  /api/orders/:id/claim-task` | 订单详情页查关联 task |
| `GET  /api/claim-tasks/available` | verifier 看可接 |
| `POST /api/claim-tasks/:id/vote` | 投 pass/fail/no_fault；收齐 3 票即触发 `settleClaimTask` |
| `POST /api/claim-tasks/:id/seller-evidence` | 卖家证据 + 延期 24h；单次 |
| `GET  /api/claim-tasks/:id` | 当事人 / 已投票 verifier 可见 |
| `GET  /api/claim-tasks/mine` | 我相关（3 视角） |

## Outlier 处罚

- 180d 滚动窗口；`votes ≥ 2` 才触发计数
- ≥ 3 → 首次跨过插 `suspended` 30d
- ≥ 5 → 升级 `revoked` 永封

`/vote` 收齐 3 票就 inline 结算；`runEnforcement` 每 5 min 扫 sealed + 超时
（启动即触发一次）兜底。

## PWA UI

主入口：**个人主页**（`#u/<me>` = 底部 nav 的"个人主页"）→ 仅
`isOwner` 时看到一张"🔎 验证活动"卡（社交行为属性 — 别人看不到你的
verifier 行为以防止 doxxing）。

- 卡内容：资格状态 + 可接任务 + 我相关（3 tab：参与/发起/被诉），
  通过 `injectClaimVerifyPanel('claim-verify-inline')` 异步注入
- 任务详情 `renderClaimTaskDetail`（独立 `#claim-task/:id` 路由）：
  买家陈述 / 卖家证据 / 投票记录 / 结算结果
- 订单详情页加 claim 卡：
  - 买家 + 订单 paid+ + 无 task → "发起验证" CTA
  - 有 task → status badge + 进入详情
- 3 个 modal：发起 / 投票 / 卖家证据
- `#verify` 独立路由仍保留作为书签兼容 / 直访入口（不在底部 nav）

## 条件订单（M7.4 已实现）

claim 发起后订单进入"条件态"：

- 新列 `orders.has_pending_claim INTEGER DEFAULT 0`
- 发起 claim → `UPDATE orders SET has_pending_claim = 1`
- 结算 claim（任意路径）→ `UPDATE orders SET has_pending_claim = 0`
- `checkTimeouts()` 过滤 `has_pending_claim = 0` — 跳过所有自动判责 /
  自动确认，避免 claim 期间订单被错误判定
- 前端 `orderStatusBadges(order)`：在原 status badge 旁附加 "🔎 验证中"
  chip（订单详情 / 订单列表 / 仲裁台 / 物流台 全部应用）

注意：order.status 保持协议状态机不变；条件态通过 flag + UI 派生
实现，避免对其他子系统造成连锁影响。

## 后续扩展

- Insights endpoint：`computeBuyReasons` 升级为后端真实数据计算，让
  verifier 拿到更精确的对标基准
- 跨链证据 anchor：evidence_uri 支持 IPFS / Arweave hash
- 卖家"主动澄清"：claim 期内卖家可选择"立即承认"（自我惩罚减轻
  50%）跳过仲裁
