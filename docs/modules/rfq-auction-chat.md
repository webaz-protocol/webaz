# 多元交易 — RFQ / AUC / CHAT / P2P 商店

最近更新：2026-05-19
代码位置：`src/pwa/server.ts`；`src/pwa/public/app.js`；`src/layer1-agent/L1-1-mcp-server/server.ts`

> 把"商品 → 订单"单向流水扩展为 4 种交易场景：
> - 买家发求购 → 卖家抢单 (RFQ)
> - 卖家发拍品 → 买家加价 (AUC)
> - 上下文绑定聊天（防自由聊天滥用 + 反诈）(CHAT)
> - 无外链商品的去中心化路径 (P2P)

---

## 一、RFQ 求购抢单

相关 commits：`83a5390` `266787b` `f84734e` `1ec7125` `336ae64` `30120e4` `c9b4fde`

### 数据模型

```sql
rfqs (
  id, buyer_id, buyer_handle, title, description, category,
  qty, max_price, urgency ('now'|'today'|'flex'),
  award_mode ('manual'|'first_match'),
  budget_total, deadline_at, status,
  awarded_bid_id, awarded_at, completed_at, created_at
)

bids (
  id, rfq_id, seller_id, seller_handle,
  price, qty, eta_hours, terms, status,
  stake_locked, created_at, updated_at
)
```

### 经济参数

| 参数 | 值 | 说明 |
|---|---|---|
| `bid_stake` | 5% × price × qty | 卖家投标担保金 |
| `buyer_stake` | 2% × max_price × qty | 买家发求购担保金 |
| cancel forfeit | 30% × bid_stake | 中标后卖家弃单扣 30% |
| 标准 deadline | 17 天 | 普通 RFQ |
| urgency=now | 1 小时 | 立即响应 |
| urgency=today | 24 小时 | 当天 |
| urgency=flex | 7 天 | 弹性 |

### 关键 helper

`awardBidAndCreateOrder` — synthetic product lazy-creation：
1. award 一个 bid → 创建一个虚拟 product（标题取 rfq.title）
2. 用 placeOrder 走标准订单流程
3. orders.bid_stake_held 保留 bid_stake 到 order 完成
4. settleFault on fault_seller → 50/50 forfeit；fault_logistics/fault_buyer → 全退

### 子阶段

- **P3a/b**：核心流（schema + 9 端点 + 前端 RFQ list/detail/mine + auction-style bidding）
- **P3c.1**：`awardBidAndCreateOrder` bug 修复（原本只有 award API，没建 order）
- **P3c.2**：PATCH bid（卖家修改报价）
- **P3c.3**：提前结算（buyer 主动 award 选定 bid）
- **P3c.4**：first_match 即时触发（设定阈值 → 第一个达标 bid 自动 award）
- **P3d**：买家 NLP Agent（自然语言 → 预填 RFQ 表单）
- **P3e**：卖家 auto_bid Skill（RFQ 发布时自动评估 + 自动出价）

### 反作弊

- bid 必须 stake 锁仓（防灌水）
- buyer 必须 stake 锁仓（防钓鱼 RFQ）
- buyer_handle / seller_handle 都是脱敏 hex
- chat 限流防骚扰
- award 不可撤销（除非状态 'awarded'）

### MCP 工具

- `webaz_rfq` — list / detail / create / cancel / award
- `webaz_bid` — create / patch / cancel / mine
- `webaz_auto_bid` — Skill 配置

---

## 二、AUC 加价拍卖（English forward auction）

相关 commits：`bb811a9` `0ba62b9` `d35297f`

### 数据模型

```sql
auctions (
  id, seller_id, product_id, title, description, image_url,
  starting_price, current_price, min_increment,
  reserve_price, seller_stake_locked,
  deadline_at, sniper_extend_min, extends_used, max_extends,
  status ('open'|'closed'|'sold'|'no_bid'|'error'),
  winner_user_id, settled_at, created_at
)

auction_bids (
  id, auction_id, bidder_id, bidder_handle,
  bid_price, created_at
)
```

### 反狙击

- `sniper_extend_min`：最后 N 分钟内出价 → 自动延长 deadline
- `max_extends` 上限（默认 3 次）防无限延长
- TOCTOU 守门：UPDATE WHERE current_price = X

### 担保金

- 卖家：`5% × starting_price` 锁仓
- 买家弃单：触发 fault_buyer → 50/50 补偿卖家

### 结算

`settleAuctionInner` with:
- `concurrent_settle_skip` 标志：cron 重入幂等
- 失败 → status='error' fallback（不死循环）
- 成功 → 转 product.status 给 winner + 释放 seller stake

### MCP 工具

`webaz_auction` — create / browse / bid / settle / mine

---

## 三、CHAT 上下文绑定聊天

相关 commit：`ecf4660`

### 设计原则

- **无自由聊天**：必须绑定 context_id (order_id / rfq_id / listing_id)
- **三类 chat**：
  - `order` — 买家 ↔ 卖家（已下单关系）
  - `rfq` — 买家 ↔ 投标卖家
  - `listing_qa` — 买家 ↔ 卖家（pre-purchase 问答）

### 反诈正则

```typescript
// 检测：微信号 / 电话 / 银行卡 / 外链跳转
const fraud_patterns = [
  /微信[:：]?\s*[a-zA-Z0-9_-]{4,}/,
  /\d{11}/,  // 手机号
  /\d{16,19}/,  // 银行卡
  /https?:\/\/[^webaz]/,  // 外链
]
```

匹配则 chat message 加 `flag_fraud=1` + 顶部 banner 提醒。

### 数据模型

```sql
chats (id, context_type, context_id, last_message_at, ...)
chat_messages (id, chat_id, sender_id, body, flag_fraud, created_at)
```

### 限流

- 同一 chat 1 分钟最多 10 条
- 同一 user 1 分钟最多 50 条（跨 chat）

### MCP 工具

`webaz_chat` — list / send / read

---

## 四、P2P 原生商店

相关 commits：`e6fdd7c` `49fe914`

### 目的

让没有外链 / 没在任何平台开店的卖家，也能在 WebAZ 上架商品。

详情存在卖家本地节点；WebAZ 只锚定 hash + 关键字段。

### 信任模型

```
卖家本地节点 (peer_endpoint)
    ↓ stores
JSON 详情 (sorted keys, drop nulls)
    ↓ sha256
content_hash
    ↓ HMAC(api_key, hash|signed_at)
content_signature

WebAZ DB:
products.p2p_mode = 1
products.peer_endpoint = "https://..."
products.content_hash
products.content_signature
products.content_signed_at
```

### 客户端验证

```typescript
// browser 端 crypto.subtle
const raw = await fetch(peer_endpoint, { signal: AbortSignal.timeout(5000) })
const canonical = canonicalize(raw) // sort keys, drop nulls
const computed = sha256(canonical)
if (computed !== product.content_hash) reject()

const expectedSig = hmac(api_key, computed + '|' + signed_at)
if (expectedSig !== product.content_signature) reject()

if (now - signed_at > 24h || signed_at > now + 5min) reject()
```

### 防御

- URL 白名单：仅 `https://...`
- 5s timeout：peer 不响应直接拒绝
- 时间窗：`[now − 24h, now + 5min]` 防签名重放
- 修改详情必须重签

### MCP 工具

`webaz_p2p_product` — list / detail / publish / verify

### 留 P2

- Pin Network（多节点冗余 + IPFS）
- 非对称密钥（替代 HMAC，无需共享 secret）

---

## 五、跨模块审计要点

| 风险 | 防御 |
|---|---|
| RFQ stake 双扣 | `orders.bid_stake_held` 字段 + settleFault 50/50 |
| AUC 高频出价 TOCTOU | UPDATE WHERE current_price = X |
| AUC 无限延长 | max_extends 上限 |
| AUC 死循环 | concurrent_settle_skip + status='error' fallback |
| Chat 撞库骚扰 | 多层限流（1min / 1 chat / 1 user）|
| Chat 反诈 | 4 正则 + flag_fraud + banner |
| P2P 重放攻击 | signed_at 24h+5min 时间窗 |
| P2P 假节点 | URL 白名单 + sig 验证 + hash 校验 |

## 六、E2E 验证

### RFQ
```
买家 A 发求购 "iPhone 15 Pro 256GB" max_price=8000 qty=1 urgency=today
卖家 B C D 抢单（B:7950 / C:7900 / D:7800）
A award D → 自动 createOrder
D 发货 → A confirm → completed
B C bid_stake 全额返还（未中标）
D bid_stake_held 保留到 order completed → 释放
```

### AUC
```
卖家 A 发拍 "限量手办" starting=100 increment=10
买家 B 100 → C 110 → B 120
deadline 前 5min B 130 → 触发 sniper_extend +5min
最终 B 140 中标 → 转 product → 退 A stake
```

### CHAT
```
买家 A 下单 → /chat/order/{id} 自动创建
A 发送 "微信 my_id_123" → 系统 flag_fraud=1 + banner "⚠ 检测到可疑词，请勿离开 WebAZ 交易"
```

### P2P
```
卖家 A 在本地 node 发布商品 JSON
计算 sha256 → 上传 hash 到 WebAZ
买家 B 在 PWA 看到 P2P 商品标识
点击详情 → 浏览器 fetch peer_endpoint
sha256 客户端校验 → 通过 → 显示商品详情
不通过 → 拒绝交易（详情拒载）
```
