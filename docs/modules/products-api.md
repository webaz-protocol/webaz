# `/api/products` — Role-Aware Discovery API

WebAZ 协议级的商品发现 API。三种 mode 服务不同调用方，单一 endpoint 通过 query 参数切换。

## 调用方式

```
GET /api/products?mode=<pwa|agent|raw>&sort=<key>&limit=N&cursor=<opaque>&...filters
Authorization: Bearer <api_key>   (raw mode 必须；其它可选)
```

## Mode 对比

| | `pwa` (默认) | `agent` | `raw` |
|---|---|---|---|
| 默认 limit | 30 | 50 | 100 |
| limit 上限 | 30 | 200 | 500 |
| 响应形态 | 数组 (legacy) | `{ products, cursor, ... }` | `{ products, signature, generated_at, ... }` |
| 字段集 | 精简 UI 字段 | + metrics + score_breakdown | + raw metrics + signature |
| Jitter (trending 排序) | ±0.5 随机 | 关闭（确定性） | 关闭 |
| 单卖家 cap | 3 | 3 | 3（可被 `seller_id=` 旁路） |
| 新卖家 slot 保护 | 2/页 | 2/页 | 2/页 |
| HMAC 签名 | 无 | 无 | `X-Signature` + `X-Signature-Algo: HMAC-SHA256` |
| 鉴权 | 可匿名 | 推荐（计 agent reputation） | 必须 + trust_score ≥ 30 |

## Sort 模式（共 6 种）

| sort | 含义 | 支持 cursor |
|---|---|---|
| `trending` (默认) | 综合 score 排序 | ✅ |
| `newest` | 创建时间倒序 | ✅ |
| `rating` | 卖家信誉点降序 | ❌ |
| `price_asc` / `price_desc` | 价格升/降 | ❌ |
| `random` | SQLite RANDOM() | ❌ |

## Trending Score 公式

```
score =
  completion_count × 0.5
+ rep_points × 0.1
+ unique_sharer_count × 2.0
+ <阶梯新鲜度>  (基于 last_sold_at)
+ <14d 首单 boost>  (基于 first_sold_at)
- dispute_loss_count × 5.0
```

**阶梯新鲜度（last_sold_at 距今）**：
- `<30 天` → +10
- `30-90 天` → 线性衰减 10 → 0
- `90-180 天` → −5
- `≥180 天` → −15

**14 天首单 boost**：商品首单后 14 天内 +5。

## Cursor 分页

Cursor 为 base64-url 编码的 `score:id` 字段：
- `trending`: 用 raw `trending_score` + `id`
- `newest`: 用 `julianday(created_at)` + `id`

下一页：`?cursor=<opaque>` —— 服务端 anchor 用 **rows 最低分** 而非 buffer 末尾，保证不丢被 seller-cap 跳过的候选。

Cursor 在响应头 `X-Next-Cursor` 返回；agent / raw mode 同时在 body 的 `cursor` 字段。

## Raw Mode 签名验证

```js
const crypto = require('node:crypto')
const payload = await res.json()
const expected = crypto.createHmac('sha256', MASTER_SEED)
  .update(JSON.stringify(payload))
  .digest('hex')
const ok = expected === res.headers.get('X-Signature')
```

`MASTER_SEED` 由 WebAZ 节点运营方持有，仅授权 agent 能验证。

## 反操纵

- `unique_click_count` 维度（6h 窗口同 IP+UA 仅算 1 次）
- `shareables.flag_new_account`（owner 注册 <3 天）
- `commission_audit_log`（同支自动入审计）
- `agent_call_log`（API 调用统计，影响 agent reputation）

## 示例

```bash
# PWA discover
curl /api/products?has_sales=true&limit=10

# Agent 按价格升序，带 cursor
curl /api/products?mode=agent&sort=price_asc&limit=20&cursor=$CUR \
  -H "Authorization: Bearer $KEY"

# Raw mode（需要 trust ≥ 30）
curl /api/products?mode=raw&limit=100 \
  -H "Authorization: Bearer $TRUSTED_KEY"
```
