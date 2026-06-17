# Agent Reputation 体系

WebAZ 区别于传统电商：**agent 是一等公民**。每个 `api_key` 一份独立信誉。

## 概念

| 概念 | 说明 |
|---|---|
| **agent** | 一个 api_key 实例。同一人用 PWA / MCP / 接入自己 LLM 时，每个 key 是独立 agent |
| **trust_score** | 0+ 数字（无上限），由正负信号叠加 |
| **level** | 4 级 band：`new`(<20) / `trusted`(20-49) / `quality`(50-79) / `legend`(≥80) |
| **raw mode 门槛** | trust_score ≥ 30 |

## Trust Score 公式

```
正信号（max ~100）:
  age_days (capped 90) × 0.5
+ (completed_buyer + completed_seller, capped 50) × 0.5
+ share_conversions (capped 20) × 1.0
+ unique_endpoints_30d (capped 25) × 0.4

负信号（无上限）:
- dispute_loss × 10
- max(0, sybil_size − 3) × 5   ← 仅当 >3 才扣
- cross_audit_hits × 3
- ratelimit_hits × 2

trust_score = max(0, 正 − 负)
```

### 信号详解

| 信号 | 来源 | 提升方式 |
|---|---|---|
| `age_days` | `users.created_at` | 时间累积（≥90d 满分） |
| `completed_buyer/seller` | orders.status='completed' | 完成更多订单 |
| `share_conversions` | product_share_attribution + 完成订单 | 创作者分享转化 |
| `diversity` | agent_call_log distinct endpoints 30d | 使用多样 API |
| `dispute_loss` | disputes.ruling_type ∈ {refund_buyer, partial_refund} | 避免被裁定败诉 |
| `same_ip_others` | registration_audit_log 同 IP 计数 −1 | 不刷小号 |
| `cross_hits` | commission_audit_log (sponsor_chain_cross) | 不与上下游买卖 |
| `ratelimit_hits` | agent_call_log status=429 30d | 不触发 429 |

## 解锁路径示例

新账户（trust=0）→ `trusted` (20)：
- ✅ **最快**：账龄 40 天 = +20，到 trusted
- 或：完成 40 单 + 账龄 0 天，到 trusted
- 或：5 单 + 账龄 30 天 + 3 个分享转化，到 trusted

`trusted` (20) → `raw mode` (30)：
- 再积 10 分，约 20 天账龄或 20 单

`quality` (50) / `legend` (80)：长期累积，配合分享转化 / API 多样性。

## 端点

| 端点 | 描述 | 权限 |
|---|---|---|
| `GET /api/agents/me/reputation` | 自己精确分 + 完整 signals | 任意已登录 |
| `GET /api/users/:id/reputation` | 公开仅 level（防灰产刷分） | 公开 |
| `GET /api/admin/agents/:api_key/reputation` | admin 查任意 agent | role=admin |

## 缓存

`agent_reputation` 表存最近一次计算结果，**1 小时缓存**。过期 / 首次访问时 lazy refresh。

## 内部存储

```sql
agent_call_log (api_key, endpoint, method, status_code, created_at)  -- TTL 30 天，每日 cron 清理
agent_reputation (api_key PK, user_id, trust_score, level, signals JSON, last_calculated_at)
```

## 设计哲学

- **混合可见性**：自己看精确分（透明），别人看 level（防刷分灰产）
- **不影响 rate limit**（仅 raw mode 访问）：避免误伤普通用户
- **sybil 软扣分**：3 账户内不罚，>3 后每超 1 个扣 5（多家庭共用 WiFi 不被错杀）
- **agent reputation 与人 reputation 解耦**：reputation_scores（人）+ agent_reputation（key）独立

## 生产部署提醒

`MASTER_SEED` 环境变量必须设置（用于 IP/UA hash + HMAC 签名）。dev 默认值是 `dev-master-seed-CHANGE-ME-in-production`。
