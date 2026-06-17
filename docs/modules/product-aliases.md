# Product Aliases — 协议级精准匹配

让买家从任何外部平台复制的混乱文本（淘口令 / 短链 / 标题片段）能精准命中
WebAZ 上的同一 SKU，而不依赖模糊推测。

## 设计哲学

> WebAZ ≠ 新平台。WebAZ = 外部平台成交的**精准镜像**。

买家在外部看到一个具体 SKU → 来 WebAZ 输入相同标识 → 必须精准命中。

**关键反直觉**：服务器不去解析"任意文本 → external_id" 这个开放问题。
让**卖家**声明他的 SKU 所有合法 identifier，服务器只做"包含 / 相等"判定。

## Schema

```sql
CREATE TABLE product_aliases (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL,
  alias_type      TEXT NOT NULL,            -- 5 种 type
  alias_value     TEXT NOT NULL,
  min_match_chars INTEGER DEFAULT 6,
  created_at      TEXT,
  challenged_at   TEXT,                     -- M7.4 verifier 挑战时间钩子
  status          TEXT DEFAULT 'active',    -- 'active' | 'revoked' | 'challenged'
  UNIQUE(alias_type, alias_value, product_id)
);
```

## 5 种 alias type

| type | 示例 | 何时命中 |
|---|---|---|
| `external_id` | `taobao:123456789` | 用户文本包含该 ID |
| `external_title` | `云南建水紫陶 茶具套装 三件套 礼盒装` | 用户文本完全等于该 title |
| `short_url` | `e.tb.cn/abc` | 用户文本包含该短链 host+path |
| `kouling_token` | `B3rN2hyHKWi` | 用户文本包含该 token |
| `title_substring` | `云南建水紫陶 茶具套装` | 用户文本包含该子串（≥ 6 字符） |

## 匹配算法

`findProductsByAlias(userInput)` 返回 product_id 集合：

1. **product.title 完全相等** （兜底）
2. **任一 external_title 完全相等** （product_external_links）
3. **alias_value 出现在用户文本中**（仅 active 且长度 ≥ 6）

```typescript
function findProductsByAlias(userInput: string): Set<string> {
  const text = userInput.trim()
  const matched = new Set<string>()
  if (!text) return matched

  // ① product.title exact
  rowsBy('SELECT id FROM products WHERE title = ? AND status="active"', text)
    .forEach(r => matched.add(r.id))

  // ② external_title exact
  rowsBy('SELECT product_id FROM product_external_links WHERE external_title = ?', text)
    .forEach(r => matched.add(r.product_id))

  // ③ alias substring containment
  for (const a of activeAliases(text.length)) {
    if (text.includes(a.alias_value)) matched.add(a.product_id)
  }
  return matched
}
```

## 卖家如何声明 alias

### 上架时引导

`POST /api/products` 接收 `aliases[]` 数组，与商品一并入库。

上架页加「外部平台 alias 声明」details：
1. 卖家粘贴外部原文（淘口令 / 短链 / 完整商品页）
2. `POST /api/products/extract-aliases` 自动提取候选
3. 卖家勾选确认后保存

### 自动提取算法

`extractCandidateAliases(text)` 返回候选列表：

- **URL 解析** → external_id / short_url
- **`¥xxxxxx¥` 正则** → kouling_token（8-20 字母数字）
- **清洗噪音后取连续 6+ 字片段** → title_substring（前 3 个最长）

噪音词：复制此条信息 / 打开手机淘宝 / 复制本条信息 / 抖音商城 / 京东 /
拼多多 / 小红书 / 【淘宝】 / 【天猫】 / 链接 / ￥ / ¥ 等

## 后续 CRUD

- `GET /api/products/:id/aliases` — 卖家看自己的 alias 列表（owner-only）
- `POST /api/products/:id/aliases` — 添加（数量上限 20）
- `DELETE /api/products/:id/aliases/:aliasId` — 撤销（设 status='revoked'）

## 反作弊（M7.2 基础 + M7.4 钩子）

- **min_match_chars ≥ 6**：硬阻断"茶具" / "礼盒" 等通用词抢流量
- **alias_value 长度 ≤ 200**：防 spam
- **UNIQUE(type, value, product_id)**：同一 alias 不能重复入
- **每商品 active alias ≤ 20**
- **challenged_at + status='challenged'**：M7.4 verifier 系统对接钩子

### 冲突处理路径

1. 同一 alias 被 2 个卖家声明 → **优先 verifier 任务挑战**（M7.3 上线后）
2. Verifier 共识失败 → **进 dispute 仲裁**
3. 卖家败诉 → stake 扣 + alias status='revoked' + 累计 3 次强制下架

## 测试验证

```bash
# 完整 title → 命中
curl '/api/products?q=云南建水紫陶 茶具套装 三件套 礼盒装'  → 1 命中

# 含 title_substring 的自由文本 → 命中（卖家声明过 substring "云南建水紫陶 茶具套装"）
curl '/api/products?q=我在淘宝看到 云南建水紫陶 茶具套装 这个不错'  → 命中同一 SKU

# 淘口令模拟 → 命中（卖家声明过 token "B3rN2hyHKWi"）
curl '/api/products?q=8￥B3rN2hyHKWi￥/CZ378 中阮民族乐器初学入门专业演奏 复制此条信息后打开手机淘宝'  → 命中

# 单字符"茶" → 0 命中（< 6 字符，alias 不可能匹配）
curl '/api/products?q=茶'  → 0
```

## 与 MCP webaz_search 一致

MCP server 同步实现 alias 引擎，`matched_by` 字段新增：

- `external_id` (Level 1)
- `external_title_exact` (Level 2)
- `product_title_exact` (Level 3)
- `alias_kouling_token`（M7.2 新增）
- `alias_title_substring`（M7.2 新增）
- `alias_short_url`（M7.2 新增）
- `none` ← 协议级"无匹配"信号

## 性能注意

当前 MVP 阶段全表扫 `product_aliases` 做包含判定。500 万行后需要：

- SQLite FTS5 全文索引（首选）
- Trie 索引
- 或 ElasticSearch 外置
