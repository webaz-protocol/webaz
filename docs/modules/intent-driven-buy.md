# Intent-Driven Buy — AI找同款页设计

`#buy` 页是 WebAZ 的精准找货入口。设计原则：**已经知道想买什么，先找到同款，再决定是否下单**。
不主动推荐分发，不做浏览引导，也不把找到候选表述成已经下单。

## 协议级承诺

- 不做模糊推测（"茶" 不会命中 "茶具套装"）
- 不主动推荐分发（页面不展示"为你推荐"）
- 严格按字面匹配（详见 [product-aliases.md](product-aliases.md)）

## 三态 UI

### ① 空状态（无搜索）

```
[搜索框 + 4-tab nav]
🔍 AI找同款
  · 输入完整商品标题 → 精准查找同款
  · 粘贴其他平台链接 → 识别并比价
  · 输入 P2P 内容 hash → 验证内容来源
协议级承诺：不做模糊推测，不主动推荐分发

🛒 你也想让你的商品出现在这里？     上架商品 →
```

### ② 有匹配（三段式 result card）

```
┌─[图片]─ 商品标题
│       商品类型 badge / ⚡ 仅剩 N 件 / 99 WAZ
│       @SellerName · N 单完成
├──────────────────────────────────────
│  🎯 推荐理由（核心 3 永显）
│    ✓ 比外部平台省 N WAZ (N% 优惠)
│    ✓ 分享后可得 L1 佣金 ≈ N WAZ
│    ✓ 资金托管 + 仲裁 + 卖家质押保障
│  ▸ 更多理由 (N)        ← 折叠：信誉 / 退货 / 质保 / 发货
│  [🔍 对推荐理由发起验证] (M7.3 启用)
├──────────────────────────────────────
│  [👁 详情]                  [🛒 查看并下单]
└──────────────────────────────────────
```

### ③ 无匹配（严格诚实 + 卖家 funnel）

```
⚠️ 未找到精准匹配的商品
WebAZ 协议不做模糊推测：
  · 你的关键词没有精确对应的商品名
  · 外链也没有匹配到已认领的 SKU

🎯 让你的商品也出现在这里
这件商品还没在 WebAZ 上架。把它带进来 — 让买家在精准搜索时也能找到你。

✨ 为什么上架到 WebAZ
  · 协议费仅 2%
  · 分享成交拿 commission（分润多级，按地区合规自动拆分）
  · 买家按卖家收款方式直接付款，WebAZ 不代持本金
  · Agent 自动比价推荐 + alias 精准命中

📋 上架只需 3 步
  ① 注册或登录
  ② 粘贴外部链接 → 系统自动提取标题、价格、alias
  ③ 设你的 WebAZ 价 → 一键上架（首单成交时自动锁定 stake）

[🛒 我也要上架商品 →]
零月费 · 零上架成本 · 协议级买家保护（托管 + 仲裁 + 卖家信誉公开）
```

## 客户端推荐理由计算

`computeBuyReasons(p)` 基于商品已有字段拼装，返回 `Array<{icon, color, text}>`：

### 核心理由（永显）

| 理由 | 来源 | 触发条件 |
|---|---|---|
| 💰 比外部平台省 N WAZ | `source_price > price` | source_price 填了 |
| 🔗 分享后可得 L1 佣金 ≈ N WAZ | `price × commission_rate × 0.70` | commission_rate > 0 |
| 🛡 资金托管 + 仲裁 + 卖家质押保障 | 固定 | 永显 |

### 详情（折叠）

- 🔥 N 人真实购买（sales_count > 0）
- ⭐ 卖家信誉 X（rep_level）
- ↩️ N 天无理由退货（return_days）
- 🔧 N 天质保（warranty_days）
- ⏱ N 小时内发货（handling_hours）
- ⚡ 仅剩 N 件 · 快速决策（low_stock）

## 商品入口路径

| 用户路径 | 命中机制 |
|---|---|
| 粘贴 `https://item.taobao.com/item.htm?id=xxx` | URL 解析 → external_id 精准 |
| 输入完整商品名 | product.title 完全相等 |
| 粘贴含 substring 的随意文本 | 卖家声明的 `title_substring` 包含 |
| 粘贴淘口令 | 卖家声明的 `kouling_token` 包含 |
| 输入单字 / 部分关键词 | 0 命中（协议契约严格）|

## 删除的反模式

- ❌ filter 条件面板（filter 是浏览工具，与 intent 冲突）
- ❌ 批量粘贴 details（批量场景去 MCP / agent SDK）
- ❌ 模糊匹配 LIKE `%q%`
- ❌ "试试浏览模式：" + 3 浏览功能 cards

## 路由

- `#buy` → renderBuy(app) → 空 / 匹配 / 无匹配 三态自动切换
- Header `sbh-search-inp` 输入 + 回车 → `smartHeaderSearch()` → `smartSearchExec(raw)`
- URL 比价 → `/api/agent-buy`
- 关键词 → `searchByKeyword(q)` → `/api/products?q=` + `ship_to=` filter
- hex hash → `openNativeReview(hash)`

## 后续扩展（M7.3 + M7.4）

- 「🔍 对推荐理由发起验证」按钮启用：
  - 买家质押 10 WAZ 启动 verification task
  - 3 verifier 接单共识
  - 验证通过 / 失败 / 双方无责 三路径结算
- 条件订单：订单状态扩展 `paid_pending_verification`
- Insights endpoint：把客户端 `computeBuyReasons` 升级为后端真实计算
  （含跨平台对标 / 历史最低价 / 个人化 / 创作者贡献等）
