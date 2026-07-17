# 导航架构 · 角色化 tab + #me 私人 hub + #discover 商务横条

最近更新：2026-05-19
相关 commits：`249b714` `994802b`
代码位置：`src/pwa/public/app.js` 函数 `shell()` (L591-L695) + `renderMyHome()` + route table

## 一、设计原则

| 原则 | 落地 |
|---|---|
| 核心业务流不能动 | AI找同款 / 订单 / 店铺 / 钱包 保留 tab |
| 业务子流应在商务上下文 | 拍卖 / RFQ / 跟卖 / P2P 进 `#discover` hub |
| 个人化功能应集中 | 私信 / 慈善 / Skill / 分享 全进 `#me` 一处 |
| 角色差异化 | RFQ 买家是发起方 → 买家 tab；RFQ 卖家是抢单方 → 卖家 tab |
| 公私分离 | `#me` = 我自己看；`#u/:id` = 别人看我 |
| `#discover` 升级 | "AI 推荐"太局限，升级为商务 hub 容纳所有业务子流 |

## 二、6 角色 tab bar 矩阵

| 角色 | tab 1 | tab 2 | tab 3 | tab 4 | tab 5 |
|---|---|---|---|---|---|
| buyer | 🔎 AI找同款 | 🔍 发现 | 💬 求购 | 📦 订单 | 👤 我的 |
| seller | 🏪 店铺 | 💎 抢单 | 📦 订单 | 💰 钱包 | 👤 我的 |
| logistics | 🚚 配送任务 | 📋 历史 | 🔔 通知 | 💰 钱包 | — |
| arbitrator | ⚖️ 仲裁台 | 📋 记录 | 🔔 通知 | 💰 钱包 | — |
| verifier | 🔍 审核任务 | 📋 记录 | 🔔 通知 | 💰 钱包 | — |
| admin | 📊 概览 | 👥 用户 | 📜 审计 | 🔔 通知 | 💰 钱包 |

后 4 角色专职功能强，5 tab 已用完。`#me` 通过**右上角 profile 按钮**进入。

## 三、`#me` 私人 hub 三段式

### 头部
```
👤 用户名
@handle · 角色
[编辑] → #profile
```

### 通用 6 卡（所有角色）
```
💰 钱包          🔔 通知（含 unread badge）
💬 私信          🌸 慈善许愿（含 prestige + pending repay badge）
🏦 慈善基金      🏆 排行榜
```

### 角色专区

**买家专区**
```
📡 分享管理      🤖 AI 推荐
🛒 购物车        🤝 我关注
```

**卖家专区**
```
💎 我的拍卖      🌐 P2P 原生商店
⚡ Skill 市场    🤖 自动报价（auto_bid）
```

### 账户卡（所有角色）
```
👁 公开主页 (#u/:id)
⚙️ 设置 / 角色 (#profile)
```

## 四、`#discover` 商务 hub

```
[找同款头 tab 行：AI找同款/发现/雷达/新品]
─────────────────────────────────────
[6 板块横条 (3×2 grid)]:
💎 拍卖      💬 求购市场    🏪 跟卖
🌐 P2P       🏆 排行榜      🌸 慈善
─────────────────────────────────────
[sort chips: 热门/最新/信誉/价格↑/随机]
[type chips: 零售/批发/服务/数字]
─────────────────────────────────────
[商品 grid (trending sort)]
[加载更多 / shareables strip]
```

## 五、卖家店铺页快捷发布

```
─────────────────────────────────────
[3 个发布按钮 (3-col grid)]:
💎 发起拍卖   🏪 发起跟卖   🌐 P2P 上架
─────────────────────────────────────
[商品管理: 在售 / 仓库 / 回收箱]
[Skill 市场]
```

## 六、通知双通道

| 通道 | 位置 | 触发条件 |
|---|---|---|
| 右上 bell badge | 顶部 navbar | 任何角色，未读 > 0 |
| `#me` tab badge | 底部 tabbar（仅 buyer/seller） | 同上 |

通过 `tabs[].badge = true` 让 shell() 渲染 badge：
```javascript
{ id: 'me', icon: '👤', label: t('我的'), badge: true }
```

## 七、URL 路由表（新增 + 修改）

| Route | 处理函数 | 说明 |
|---|---|---|
| `#me` | `renderMyHome` | **新增** — 私人 hub |
| `#discover` | `renderDiscover` | **扩展** — 顶部加 6 板块横条 |
| `#wishes` | `renderWishBoard` | 慈善许愿池 |
| `#wish/fund` | `renderCharityFund` | 慈善基金 |
| `#wish/mine` | `renderCharityMe` | 我的慈善档案（5 项荣誉细分）|
| `#wish/stories` | `renderCharityStories` | 公开故事板 |
| `#wish/leaderboard` | `renderCharityLeaderboard` | 慈善威望榜 |
| `#chats` / `#chat/:id` | `renderChatList` / `renderChatDetail` | 上下文绑定聊天 |
| `#auctions` 等 | AUC 系列 | 拍卖 |
| `#rfqs` / `#rfq/:id` 等 | RFQ 系列 | 求购 |
| `#listings` 等 | listings 系列 | 跟卖 |
| `#p2p-shop` 等 | P2P 系列 | P2P 原生 |
| `#leaderboard` | `renderLeaderboard` | 商品 + 创作者榜 |

## 八、`renderMyHome` 数据加载

```typescript
async function renderMyHome(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')

  // 1) 主动刷新 cart / unread（避免显示陈旧数据）
  refreshCartBadge()
  const n = await GET('/notifications?unread=1')
  if (n) state.unread = n.unread

  // 2) 并行拉 wallet + charity
  const [profile, charity] = await Promise.all([
    GET('/profile').catch(() => null),
    GET('/charity/me').catch(() => null),
  ])

  // 3) 数据兜底（防 NaN）
  const wal = { balance: Number(profile?.wallet?.balance || 0), ... }

  // 4) 加载错误显式提示
  if (loadErrors.length > 0) showErrBanner()

  // 5) 三段式 render
  app.innerHTML = shell(header + errBanner + commonGrid + roleGrid + settingsGrid, 'me')
}
```

## 九、错误处理

| 场景 | 处理 |
|---|---|
| 未登录 | renderLogin() |
| profile API 失败 | banner: "⚠ 部分数据加载失败: 钱包 · [重试]" |
| balance undefined | 显示 "0.00 WAZ"（不显示 NaN）|
| 长 sub 文本溢出 | white-space:nowrap + overflow:hidden + text-overflow:ellipsis |
| icon/badge 被挤压 | flex-shrink:0 |

## 十、可访问性 / 跨端

- 卡片 onclick → 同 navigate()，键盘可达
- 通知 badge 用 ARIA roles（待加）
- iOS Safari：cart count / unread 用 state global 维持，PWA 重新激活时刷新

## 十一、迁移指南（旧 tab → 新 tab）

| 旧位置 | 新位置 |
|---|---|
| 买家 tab "AI 推荐" | `#me` 买家专区 |
| 买家 tab "分享管理" | `#me` 买家专区 |
| 买家 tab "个人主页" (#u/:id) | `#me` 账户卡 → 公开主页 |
| 卖家 tab "商店" (#shop) | 删除（卖家不需逛商店）|
| 卖家 tab "通知" | 右上 bell + `#me` tab badge 双通道 |

## 十二、留 v2

- 4 角色（logistics/verifier/arbitrator/admin）也加 `#me` 进 tab bar
- `#me` 卡片右侧加趋势 (如"今日 +5 prestige")
- 卡片支持长按预览（mobile gesture）
- `#discover` 6 板块支持隐藏 / 重排（用户偏好）
