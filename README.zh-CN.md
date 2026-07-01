**[English](README.md)** · **中文**（当前 / current）

> **Code is Rule, Protocol is Trust.**
> **代码即规则，协议即信任。**
> — webaz

# WebAZ

[![npm](https://img.shields.io/npm/v/@seasonkoh/webaz.svg)](https://www.npmjs.com/package/@seasonkoh/webaz)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=webaz)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-orange.svg)](LICENSE) [![Change Date: 2030-05-18](https://img.shields.io/badge/Change%20Date-2030--05--18-blue.svg)](NOTICE) ![Status: Pre-launch](https://img.shields.io/badge/Status-Pre--launch-yellow.svg)

> 🚧 **Pre-launch · 预发布阶段** — v1.0 公示中（起算 2026-05-31）· 极早期（仅创世期账户）· verifier / arbitrator 角色仍在引导 · 经济模型未结算 · 不建议生产使用。
> 🚧 **Pre-launch stage** — v1.0 public-notice period (started 2026-05-31) · very early (genesis-phase accounts only) · verifier / arbitrator roles still being bootstrapped · economic model un-settled · **not for production use**.
>
> 详见 / Details: [`docs/CHARTER.md`](docs/CHARTER.md) · [`docs/META-RULES-FULL.md`](docs/META-RULES-FULL.md) · [`docs/ECONOMIC-MODEL.md`](docs/ECONOMIC-MODEL.md) · [`/api/protocol-status`](https://webaz.xyz/api/protocol-status)

让 AI Agent 成为去中心化商业协议的原生参与者。卖家零额外工作量接入新渠道，买家通过 Agent 自动购物，人类与 AI 在同一协议上平等参与。

> 📖 **创始白皮书 / Founding Whitepaper** → [`docs/WHITEPAPER.zh-CN.md`](docs/WHITEPAPER.zh-CN.md) · [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md)

> **试一下 / Try it**：`npx -y @seasonkoh/webaz` —— 接入**任意 MCP 客户端**(Claude Desktop / Claude Code / Codex / Cursor / 自建 agent 皆可;配置见下)。
> **PWA 演示 / demo**：[webaz.xyz](https://webaz.xyz)

---

## 📜 授权说明

自 **2026-05-18** 起，本项目使用 **Business Source License 1.1 (BUSL-1.1)** 协议发布。

- ✅ 允许：内部使用、研究、二次开发、非竞争性商业使用
- ❌ 禁止：运营与 WebAZ 实质相似的去中心化商业协议托管服务
- ⏰ **2030-05-18** 之后，本协议自动转为 **MIT** 协议
- 📦 **2026-05-18 之前**发布的所有版本（含历史 git 提交）仍持有 **MIT** 授权，不可撤销

详见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。

---

## 核心特性

### 协议骨架
- **Agent 原生 / agent-agnostic**：基于开放的 **MCP** 协议——**任意 MCP agent**(Claude Desktop / Claude Code / Codex / Cursor / 自建 agent 皆可)都能直接搜索、锁价、下单、举证、确认;不绑定任何单一厂商
- **人类 + Agent 双通道**：PWA 给人类，MCP 给任意 agent，共用同一后端
- **协议级精准镜像**：q= 严格 exact match，"茶" 不会命中"茶具套装"；买家从外部平台复制的标识必须字面相等才返回结果（见 [intent-driven-buy](docs/modules/intent-driven-buy.md)）
- **商品 alias 系统**：卖家声明 kouling_token / short_url / title_substring，让用户从外部平台的任何复制形式都能精准命中同一 SKU（见 [product-aliases](docs/modules/product-aliases.md)）
- **角色感知 API**：`/api/products?mode=pwa|agent|raw` 三种调用方分级；agent 模式返回 score_breakdown，raw 模式 HMAC 签名（见 [products-api](docs/modules/products-api.md)）
- **Agent Reputation 体系**：每个 api_key 独立 trust_score（4 layer band），raw mode 需 trust ≥ 30（见 [agent-reputation](docs/modules/agent-reputation.md)）

### 多元交易场景
- **🆕 多商家跟卖 (P1)**：listings 1:N offers，4 类目 stake 体系（standard 1.0× / general 1.5× / highvalue 2.0× / restricted 3.0× × base 50 WAZ）
- **🆕 加权排序 + urgency 路由 (P2)**：trending score 含完成度/信誉/分享/点赞/新鲜度/季节性；urgency 三档 (now/today/flex) 路由不同 ETA 硬限
- **🆕 RFQ 求购抢单 (P3)**：买家发求购，卖家限时报价；first_match 即时触发 / 提前结算 / 自然语言预填 / auto_bid Skill（见 [rfq-auction-chat](docs/modules/rfq-auction-chat.md)）
- **🆕 加价拍卖 AUC**：English forward auction；反狙击 sniper_extend_min + max_extends cap；卖家担保金 5%
- **🆕 P2P 原生商店**：无外链商品的去中心化路径；卖家本地节点存详情，WebAZ 锚定 hash + HMAC 签名 + 客户端 sha256 校验
- **🆕 上下文绑定聊天**：order / RFQ / listing_qa 三类 chat；反诈正则检测微信号/电话/银行卡

### 信任与合规
- **claim 验证 + 条件订单**：买家可对推荐理由发起验证，3 verifier 共识仲裁，4 路径结算（pass / fail / no_fault / timeout）+ outlier 处罚（见 [claim-verification](docs/modules/claim-verification.md)）
- **地区合规分润**：china/us/eu/india = 2 levels；其他 3 levels；UI 按地区动态显示
- **零门槛上架**：卖家上架免质押，首单成交时从 escrow 自动锁 15% stake（trusted 卖家跳过）
- **争议系统**：双方举证 → 仲裁员裁定 → 败诉方缴 1% 仲裁费（含超时自动判）
- **链接认领验证**：卖家关联外部链接需通过众包验证码核验，防止他人冒用商品主权

### 决策辅助
- **🆕 价格历史 + 成交量分布**：3 窗口（30d/90d/lifetime） × 6 统计；价位分布 / sparkline / category_avg / anomaly_flags；防底价倾销
- **结构化商品 + agent_summary**：规格 / 物流 / 售后字段拼成一句话决策摘要
- **下单前价格锁定**：`webaz_verify_price` 返回 `session_token`，避免决策与下单之间价格漂移

### 社会化 / 公益
- **🆕 慈善许愿池**：双匿名（HMAC 派生 handle）+ 双签锚定（commit_hash）+ 反自圆梦封锁；许愿/圆梦/还愿/转捐 4 套荣誉细分（见 [charity](docs/modules/charity.md)）
- **🆕 慈善基金**：还愿被谢绝自动转入；任何人可捐款（≤500 WAZ/愿，1 WAZ = 1 honor 上限 50/日）；公开账本 + 慈善家排行
- **🆕 点赞 + 排行榜**：shareable_likes 防 Sybil；商品榜 (sales+推荐+点赞) + 创作者榜
- **Skill 市场**：catalog_sync / auto_accept / instant_ship / auto_bid 等插件，Agent 订阅自动享用
- **声誉 5 级**（新手 → 传奇）：影响质押折扣 + 搜索排名

### 共建 / 贡献（RFC-017）
- **先记录、后认领**：GitHub PR 合并 → WebAZ 自做鉴权抓取生成**不可变贡献事实**；真人之后用 **Passkey 事后认领**绑定（executor = agent / accountable = human），先贡献、后绑定
- **未承诺价值边界（I-12）**：贡献只被**准确记录 + 可认领**，**不承诺任何奖励 / 估值 / 治理权 / 份额**；估值机制留待未来 DAO + 专业/法律团队制定
- **开放任务板**：任意人 / agent 可浏览可认领任务、提交建议（见 `webaz_contribute` · [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md)）

### 链上 / 安全
- **链上托管**：USDC on Base Sepolia，充值地址按用户派生，自动扫归集 + 自动执行提现
- **WebAuthn / Passkey** 大额操作闸门
- **storage.persist()** 申请 + 持久化状态可视
- **自动执法**：状态机责任归因，超时自动判责（每 5 分钟 cron 扫）

---

## 快速开始

> **自部署？** → 它是个标准 Node 应用:`npm install && npm run pwa`(SQLite,无外部依赖)。
> **环境变量？** → 复制 [`.env.example`](.env.example) 为 `.env` 填值

### 方式一：MCP 接入（任意 agent —— agent 原生体验）

MCP server 有三种模式 / The MCP runs in one of three modes：

| 模式 / Mode | 数据源 | 用途 | 如何触发 |
|---|---|---|---|
| 🟢 **NETWORK 只读（默认）** | `webaz.xyz` 共享生产网络（公共读） | 无需 key 即可搜索 / 榜单 / 价格史 / 浏览**真实网络** | 未配 `WEBAZ_API_KEY`（默认，零配置） |
| 🟢 **NETWORK（完整）** | `webaz.xyz` 共享生产网络（带你的 `api_key`） | 真实加入网络、和别人交易 | 配了 `WEBAZ_API_KEY` |
| 🟡 **SANDBOX** | 本机本地 SQLite（`~/.webaz/webaz.db`） | 离线试玩 / 开发，**与全网隔离** | **显式** `WEBAZ_MODE=sandbox` |

> 🟢 无 key = 公共读打**真网络**（不是本机）；要交易（注册/下单/上架/履约）需 `WEBAZ_API_KEY`。🟡 SANDBOX 需**显式开启**（`WEBAZ_MODE=sandbox`），本机隔离，**不是**真网络。每个工具结果都盖 `_mode`，一眼知道当前在哪。

**A. 零配置开始（NETWORK 只读）**

把下面的 server 配置加进**你的 MCP 客户端**——以 Claude Desktop 为例,编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`(Claude Code 用 `claude mcp add`;Codex / Cursor / 其它 MCP 客户端用各自的 MCP 配置文件,字段相同):

```json
{
  "mcpServers": {
    "webaz": {
      "command": "npx",
      "args": ["-y", "@seasonkoh/webaz"]
    }
  }
}
```

重启你的 MCP 客户端。`npx` 自动下载运行。**无 key 时是 NETWORK 只读**：`webaz_search` / 榜单 / 价格史 / 浏览直接读 `webaz.xyz` 真实网络（注册 / 下单 / 上架等交易工具需要 key，见 B）。想完全离线试玩全流程？设 `WEBAZ_MODE=sandbox` 进本机沙盒（仅本机有效，与全网隔离）。

**B. 真正加入网络（NETWORK）**

1. 在 [webaz.xyz](https://webaz.xyz) 注册账号（需邀请码；注册时绑定 Passkey 成为可问责真人）
2. 「我的 / 设置」→ 复制 `api_key`
3. 配置里加上 `WEBAZ_API_KEY` 环境变量：

```json
{
  "mcpServers": {
    "webaz": {
      "command": "npx",
      "args": ["-y", "@seasonkoh/webaz"],
      "env": { "WEBAZ_API_KEY": "你的_api_key" }
    }
  }
}
```

> NETWORK 模式下 `webaz_register` **不自助建号**（账号必须由真人在 webaz.xyz 创建 + 绑 Passkey，这是协议的可问责性要求）。注册以外的交易工具——搜索 / 锁价 / 下单 / 上架 / 履约 / 查单——都直接在共享网络上跑。

**C. 开始使用**

对你的 agent 说（任意 MCP agent 都行）：

> "帮我在 WebAZ 搜索一下有什么商品，挑性价比高的下单"

agent 会自动调用 `webaz_search` → `webaz_verify_price` → `webaz_place_order` → `webaz_get_status` 完成发现→下单→追踪全流程。

---

### 方式二：PWA 浏览器界面

```bash
cd webaz
npm run pwa
# 打开 http://localhost:3000
# 手机访问：http://<本机IP>:3000
```

注册账号后即可使用完整功能。

---

## MCP 工具清单

| 工具 | 说明 | 主要参数 |
|------|------|----------|
| `webaz_info` | 获取协议概览和实时统计 | — |
| `webaz_register` | 注册账号，获取 api_key | `name`, `role` |
| `webaz_search` | 搜索商品（结构化字段 + agent_summary + 声誉加权） | `query`, `category`, `max_price`, `min_return_days`, `max_handling_hours` |
| `webaz_verify_price` | 下单前锁价 10 分钟，拿到 `session_token` | `product_id`, `quantity`, `api_key` |
| `webaz_list_product` | 卖家上架商品（含品牌/规格/物流/售后字段） | `title`, `price`, `specs`, `handling_hours`, `return_days`, `api_key` |
| `webaz_place_order` | 买家下单（可传 `session_token` 防价格漂移） | `product_id`, `shipping_address`, `session_token`, `api_key` |
| `webaz_update_order` | 更新订单状态（接单/发货/确认/争议） | `order_id`, `action`, `api_key` |
| `webaz_get_status` | 查询订单/钱包/争议详情 | `order_id` / `wallet` / `dispute_id`, `api_key` |
| `webaz_wallet` | 钱包余额 + 链上充值地址 + 提现 | `action`, `api_key` |
| `webaz_notifications` | 查询未读通知 | `api_key` |
| `webaz_dispute` | 争议操作（查看/举证/裁定） | `action`, `api_key` |
| `webaz_skill` | Skill 市场（发布/订阅；含 auto_bid） | `action`, `api_key` |
| `webaz_profile` | 个人资料 + 多角色管理 | `action`, `api_key` |
| `webaz_mykey` | api_key 恢复（已注册用户重新获取密钥） | `name`, `recovery_code` |
| `webaz_rfq` | 🆕 RFQ 求购（发布/浏览/认领/详情） | `action`, `api_key` |
| `webaz_bid` | 🆕 RFQ 报价（创建/修改/撤销/中标） | `action`, `rfq_id`, `api_key` |
| `webaz_chat` | 🆕 上下文绑定聊天（order/rfq/listing_qa） | `action`, `context_id`, `api_key` |
| `webaz_auto_bid` | 🆕 卖家自动报价 Skill 配置 | `action`, `api_key` |
| `webaz_auction` | 🆕 加价拍卖（发起/浏览/出价/中标） | `action`, `api_key` |
| `webaz_like` | 🆕 分享点赞（toggle/status） | `action`, `shareable_id`, `api_key` |
| `webaz_leaderboard` | 🆕 排行榜（products / creators） | `kind`, `limit` |
| `webaz_p2p_product` | 🆕 P2P 原生商店（卖家节点 hash 锚定） | `action`, `api_key` |
| `webaz_price_history` | 🆕 商品历史成交价 + 价位分布 | `product_id` |
| `webaz_charity` | 🆕 慈善许愿池 + 还愿 + 基金 + 捐款（11 sub-action） | `action`, `api_key` |
| `webaz_contribute` | 🆕 共建：浏览 / 认领 / 提交开放任务 + GitHub 贡献认领（record→claim，**仅记录，不承诺奖励**，RFC-017 I-12） | `action`, `api_key` |
| `webaz_secondhand` | 🆕 二手交易（独立流转） | `action`, `api_key` |
| `webaz_trial` | 🆕 测评免单（达人 reach 申请 / 结算） | `action`, `api_key` |
| `webaz_referral` | 🆕 推荐 / 放置**参与记录**（仅记录，非收益） | `action`, `api_key` |
| `webaz_share_link` · `webaz_shareables` | 🆕 分享链接 + 可分享内容管理 | `action`, `api_key` |
| `webaz_follows` · `webaz_nearby` · `webaz_default_address` | 🆕 关注 / 附近 / 默认地址 | `action`, `api_key` |
| `webaz_feedback` | 🆕 现场反馈（信誉闭环） | `action`, `api_key` |
| `webaz_skill_market` · `webaz_claim_verify` · `webaz_blocklist` | 🆕 技能市场 / 链接认领验证 / 黑名单 | `action`, `api_key` |
| `webaz_rotate_key` · `webaz_revoke_key` | 🔐 api_key 轮换 / 吊销 | `api_key` |

> 共 **38 个 MCP 工具**;以上为常用一览,完整清单与参数以 `webaz_info` 返回 + 服务器实际注册为准。
> **38 MCP tools** total; the table above is the common subset — the live list + params come from `webaz_info` and the server itself.

完整协议规范（状态机/经济模型/争议规则）可通过 MCP Resource 读取：

```
webaz://protocol/manifest
```

---

## 角色说明

| 角色 | 可以是人类或 Agent | 职责 |
|------|-------------------|------|
| `buyer` 买家 | ✅ 两者均可 | 浏览商品、下单、确认收货或发起争议 |
| `seller` 卖家 | ✅ 两者均可 | 上架商品、接单、发货，可发布 Skill |
| `logistics` 物流 | ✅ 两者均可 | 揽收、运输、投递，回传快递单号 |
| `arbitrator` 仲裁员 | ✅ 两者均可 | 审查争议证据、做出裁定 |

---

## 交易流程

```
买家下单（paid）
  → 卖家接单（accepted）      ← 超时 24h：fault_seller
  → 卖家发货（shipped）       ← 超时 72h：fault_seller（需选择物流公司）
  → 物流揽收（picked_up）     ← 超时 48h：fault_logistics（回传快递单号）
  → 运输中（in_transit）
  → 投递完成（delivered）     ← 超时 48h：fault_logistics
  → 买家确认（confirmed）     ← 超时 72h：自动确认
  → 完成结算（completed）

买家在 delivered 阶段可发起争议：
  → 被告 48h 内举证 → 仲裁员 120h 内裁定
  → 超时不回应：自动判发起方胜诉
  → 败诉方缴纳订单金额 1% 仲裁费（最低 1 WAZ）
  → 裁定结果：全额退款 / 释放给卖家 / 部分退款 / 责任分配
```

---

## 资金分配

下列比例均为 `protocol_params` **当前默认值，DAO 治理可调**（部分有宪法级硬帽，如协议费 ≤ 2% 只减不增）；精确流程与单据以 [`docs/ECONOMIC-MODEL.md`](docs/ECONOMIC-MODEL.md) 为准。以 100 WAZ 商家订单为例：

| 接收方 | 当前默认 | 说明 |
|--------|------|------|
| 卖家 | ~83% | 扣除下列各项后的净额（residual） |
| 分享佣金 | 10% | 按真实成交分给推荐链 L1/L2/L3（默认 7:2:1），受地区 `max_levels` 上限；无人可领则入三级公池 |
| 物流方 | 5% | self-fulfill / 面交 = 0 |
| 协议费 | 2% | 50% 入协议储备池 + 50% 入运营（二手 1%） |
| 协议基金 | 1% | 公益 / 兜底池；**pre-launch = 0**，有真实 GMV 再经治理开启 ≤ 1% |

卖家上架**零质押**；首单成交时自动从订单 escrow 锁定一笔 stake（当前默认 15%）作买家保护，信誉 ≥ trusted 的卖家跳过（信任奖励）。该比例同为治理可调。

> **匹配奖励引擎已切除。** PV 匹配奖励引擎已从公开代码移除(#401,no-op stub;完整引擎内部归档,重启需法律/治理放行)。**PV 仅为参与/归因记录,不是收益、不可兑付、不构成任何奖励权益。** 详见 [`docs/REWARD-ENGINES-DECOUPLING.md`](docs/REWARD-ENGINES-DECOUPLING.md) / [`docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`](docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md)。
>
> **EN:** The binary / PV-matching reward engine has been **excised** from the public code (#401): `src/pwa/internal/pv-settlement.ts` is a permanent no-op stub that returns disabled regardless of any flag, and the full engine is archived internally — re-enabling would need legal/governance clearance + a rebuild, not a flag flip. **PV is a participation record only — not income, not redeemable, no entitlement.**

---

## 开发命令

```bash
npm run pwa          # 启动 WebAZ 服务（含自动执法，端口 3000）
npm run mcp          # 单独启动 MCP Server（供任意 MCP 客户端调用）
npm run demo         # 跑完整交易演示脚本
npm run test-dispute # 测试争议系统（三场景）
npm run test-skill   # 测试 Skill 市场
npm run test-rep     # 测试声誉系统
npm run test-manifest# 测试协议 Manifest
```

---

## 技术栈

| 方向 | 选择 |
|------|------|
| 运行时 | Node.js + TypeScript |
| Agent 接口 | MCP (Model Context Protocol) |
| 数据库 | SQLite（Phase 0），PostgreSQL（Phase 1+） |
| 前端 | PWA — 手机浏览器直接访问，无需安装 |
| 链 / Chain | Base —— USDC 充提 testnet（Base Sepolia）已上线；mainnet 待 Phase 2 |

---

## 架构总览 / Architecture map

> 给 AI agent / 新贡献者:不用扫全仓,从下表对应层入手。改代码的 agent 请先读 [`AGENTS.md`](AGENTS.md)。
> For AI agents / new contributors: don't scan the whole repo — start from the layer your change belongs to. Agents modifying code: read [`AGENTS.md`](AGENTS.md) first.

一套代码两个运行时:**MCP server**(`src/mcp.ts`,给 AI agent)+ **PWA**(`src/pwa/`,给人类)—— 同后端、同规则。
One codebase, two runtimes: the **MCP server** (for AI agents) and the **PWA** (for humans) share the same backend and rules.

代码分 8 层(`src/layerN-*/`,由底向上依赖)/ Code is layered (`src/layerN-*/`, bottom-up):

| Layer | 它是什么 / What |
|---|---|
| `layer0-foundation` | DB schema · 订单**状态机** state-machine · manifest |
| `layer1-agent` | **MCP server**(`L1-1-mcp-server/server.ts`，最常改)· 身份 / 外部锚点 identity / anchor |
| `layer2-business` · `layer2-commerce` | 通知 / SNF / anchor registry 等业务 business logic |
| `layer3-trust` | 争议引擎 dispute engine |
| `layer4-economics` | 声誉 reputation · 技能市场 skill-market |
| `layer5-decentralized` · `layer6-scale` | 治理 / 扩展(部分后续阶段)governance / scale (some reserved) |

关键入口 / Key entry files:
- `src/mcp.ts` → tools 实现在 `src/layer1-agent/L1-1-mcp-server/server.ts`
- `src/pwa/server.ts` + `src/pwa/routes/` → PWA + HTTP API(人 / agent 共用生产端点)
- `src/cron-enforcement.ts` → 协议自动判责执行(超时→处置)auto state-machine enforcement

---

## 当前阶段

**Phase 0 · 概念验证** ✅
**Phase 1 · 功能完善 + 链上 testnet 闭环** ✅
- 38 个 MCP 工具 / 全角色 PWA / 通知 / 争议 / 声誉 / Skill 市场 / 贡献系统(RFC-017) / Manifest
- USDC on Base Sepolia：派生充值地址、自动监听入账、热钱包扫归集、自动执行提现
- 链接认领验证（众包验证码 + 主权流转）
- Agent 决策三件套（结构化字段 / agent_summary / verify_price 锁价）
- MCP 工具调用遥测（默认开，可关）

**Phase 2 · 主网 + 真正去中心化**（下一步）

---

## 路线图

### Phase 1 完成项
- [x] 状态机 + 责任归因引擎
- [x] MCP Server（38 个工具）
- [x] 通知系统（SSE 实时推送）
- [x] 争议系统（举证 + 超时自动裁定 + 仲裁费）
- [x] 声誉积分体系（5 级）
- [x] Skill 市场
- [x] Protocol Manifest（机器可读协议规范）
- [x] PWA 前端（全角色覆盖，人类 + Agent 双通道）
- [x] 智能商品导入（贴链接自动提取）
- [x] 链接认领验证（卖家主权 + 众包核验）
- [x] 链上 USDC testnet 闭环（Base Sepolia）
- [x] 下单前价格锁定（verify_price + session_token）
- [x] 结构化商品规格 + agent_summary 决策摘要
- [x] 遥测看板（/api/admin/usage）

### M1-M7 协议级里程碑（2026-05 完成）
- [x] **M1** 角色感知 API（mode=pwa/agent/raw）+ cursor 分页
- [x] **M2** 基础排序公平（jitter / seller cap / 新人 slot）
- [x] **M3** 反操纵层（click 去重 / 同支审计 / 上架限速 / 注册 IP hash）
- [x] **M4** Agent Reputation 体系（trust_score + raw mode 门槛 + HMAC 签名）
- [x] **M5** 新人保护 + 阶梯新鲜度 + sort UI
- [x] **M6** 商品类型 + 库存稀缺 + 季节性 lifecycle
- [x] **M7.1** 智能下单 intent-driven UI 重做
- [x] **M7.1.5** q= exact match 协议契约
- [x] **M7.2** 商品 alias 系统（kouling_token / title_substring / short_url）
- [x] **M7.2.5/6/7** 卖家 funnel + 地区合规（2/3 级分润）+ L3 区域感知
- [x] **代码审计** H-1 / H-2 / M-1 / M-2 / M-5 / 3f254b8 完整批次
- [x] **M7.3** claim 验证任务系统（4 路径结算 + outlier 处罚）
- [x] **M7.4** 条件订单（has_pending_claim 暂缓自动判责）

### P1-P3 多元交易场景（2026-05-18+）
- [x] **P1** 多商家跟卖（listings + 4 类目 stake）
- [x] **P2** 加权排序 + urgency 路由 + cold-start 衰减
- [x] **P3 RFQ** 求购抢单 + bid_stake + first_match + auto_bid Skill + 买家 NLP Agent
- [x] **CHAT** 上下文绑定聊天 + 反诈正则
- [x] **AUC** 加价拍卖（English forward + 反狙击）
- [x] **LIKE + Leaderboard** 分享点赞 + 商品/创作者双榜
- [x] **P2P 原生商店** 卖家节点 hash 锚定 + HMAC 签名 + 客户端 sha256
- [x] **Price History** 历史成交价 + 价位分布 + 异常预警

### 慈善 + 社会化（2026-05-18 完成）
- [x] **慈善许愿池** 双匿名 + 双签锚定 + 4 张表 + 6 前端页 + 反自圆梦封锁
- [x] **还愿系统** 三态响应（accept / decline_to_fund / 7 天 auto-accept）
- [x] **慈善基金** 单例池 + 任何人捐款 + 慈善家排行 + 公开账本
- [x] **5 项荣誉细分**（repay/redirect/grace/donation_total/donation_honor）
- [x] **16 项审计修复**（4 处竞态 + 6 项业务/隐私 + 6 项工程）

### UX 重构（2026-05-19 完成）
- [x] **导航重组** 角色化 tab bar（买家 5 / 卖家 5）
- [x] **#me 私人 hub** 三段式（通用 6 / 角色专区 / 账户）
- [x] **#discover 商务横条** 6 板块快捷入口（拍卖/求购/跟卖/P2P/排行/慈善）
- [x] **i18n 双语全覆盖** 2700+ 条目；服务端按 Accept-Language 返回

### 进行中 / 下一步
- [ ] **跨模块审计收尾**（alias 限额 TOCTOU / settleOrder 原子化 / 杂项硬化）
- [ ] **慈善基金 v2**：自动拨款机制（紧急医疗/教育大额匹配）+ 捐物（specific event 定向）
- [ ] **导航 v2**：4 角色（logistics/verifier/arbitrator/admin）也加 #me 入口完整化

### 长期
- [ ] 链上 USDC 主网（Base）
- [ ] IPFS 证据存储 + Pin Network（已搭骨架，留 P2）
- [ ] 评价系统（结构化 1-5 星，反哺声誉）
- [ ] 证据上传通道（争议附图）
- [ ] 治理 DAO

---

## 联系 / Contact

| 用途 / Purpose | Email | 详情 / Details |
|---|---|---|
| 通用咨询 / General inquiries | `contact@webaz.xyz` | — |
| 安全漏洞 / Security vulnerabilities | `security@webaz.xyz` | [SECURITY.md](SECURITY.md) — 强烈优先用 [GitHub Security Advisory](https://github.com/webaz-protocol/webaz/security/advisories) / Strongly prefer Advisory |
| 行为准则举报 / Code of Conduct reports | `conduct@webaz.xyz` | [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) §7 |
| BSL 商业授权 / Commercial licensing | `licensing@webaz.xyz` | [LICENSE](LICENSE) / [NOTICE](NOTICE) |

> 📬 上述均为 Cloudflare Email Routing forwarding alias;phase A solo 阶段统一转发到创始人个人邮箱,响应水平为**个人级**(非企业 SLA);phase B+ 形成 maintainer 群后会切到团队 triage(无需改文档)。
> 📬 All addresses are Cloudflare Email Routing forwarding aliases; in phase A solo, they route to the founder's personal inbox with **personal-level response** (not enterprise SLA); phase B+ will switch to maintainer team triage (no doc change needed).

**Bug 报告 / 功能想法 / RFC**:走 [GitHub Issues](https://github.com/webaz-protocol/webaz/issues) 或 [Discussions](https://github.com/webaz-protocol/webaz/discussions);PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

**Bug reports / feature ideas / RFCs**: please use [GitHub Issues](https://github.com/webaz-protocol/webaz/issues) or [Discussions](https://github.com/webaz-protocol/webaz/discussions); PR workflow per [CONTRIBUTING.md](CONTRIBUTING.md).

**新贡献者 / GitHub-first / 带 agent 的入口**:[`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md) — *contribute first, bind later*;贡献被记录但一切 `uncommitted`(不承诺奖励)。 / **New / GitHub-first / agent contributor entry**: [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md).
