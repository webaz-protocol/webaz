> **Code is Rule, Protocol is Trust.**
> **代码即规则，协议即信任。**
> — webaz

# WebAZ — 是什么 / 能做什么

> 文档版本：2026-05-22  
> 项目代码版本：v0.1.8（公开 npm）+ v0.4.14（内部 CHANGELOG 标记）  
> 总代码量：54,000+ 行 / 142 张数据库表 / 509 个 API endpoint / 32 个 MCP 工具

---

## 一句话定位

> **让 AI Agent 成为去中心化商业协议的原生参与者。**
> **卖家零额外工作量接入新渠道，买家通过 Agent 自动购物，人类与 AI 在同一协议上平等参与。**

不是"新平台要用户迁移"，而是"给现有 Agent 增加商业能力"——通过 MCP 协议让 Claude / GPT 等 AI 助手直接搜索、锁价、下单、举证、确认。同时通过 PWA 给人类买卖家完整可视界面，两端共用同一后端。

---

## 1️⃣ WebAZ 是什么

### 协议骨架（不是平台）

WebAZ 不像淘宝/Amazon 那样"中心化平台 + 用户依赖"，而是**协议层 + 应用层分离**：

| 层 | 职责 | 示例 |
|---|---|---|
| **协议层** | 资金托管 / 仲裁 / 信誉 / 分润 / 合规 | settleOrder / disputes / commission / region_config |
| **应用层** | UI / Agent SDK / 内容呈现 | PWA / MCP server / 笔记 / 收藏 |

任何人/AI 可在协议层之上构建应用，类似 Web3 中协议 vs DApp。

### 三种参与者，同一协议

```
        ┌─────────────────────────────────────────┐
        │       WebAZ 协议层（链下 + Sepolia 锚）   │
        │   settleOrder / commission / 仲裁 / PV   │
        └─────────────────────────────────────────┘
              ↑              ↑              ↑
        ┌─────┴────┐    ┌────┴────┐    ┌────┴────┐
        │  人类     │    │ AI Agent│    │ 卖家    │
        │  PWA UI  │    │ MCP/SDK │    │  混合   │
        └──────────┘    └─────────┘    └─────────┘
        (微信级体验)    (API key)    (Claude 直连)
```

---

## 2️⃣ WebAZ 能做什么（功能全景）

### 🛒 商业核心
| 模块 | 描述 |
|---|---|
| **AI找同款** | 协议级 exact match（"茶"≠"茶具套装"）+ 4 种输入方式：商品标题 / 外链（自动比价）/ 口令（@user xxxx）/ P2P 内容 hash；找到后由买家决定是否下单 |
| **多商家跟卖**（listings）| 1 个商品池 N 个商家 offer，类目分级 stake（标品 1× / 普通 1.5× / 高价 2× / 受限 3× × base 50 WAZ）|
| **RFQ 求购抢单** | 买家发求购单，卖家限时报价；first_match 即触发；自然语言预填；auto_bid Skill 自动竞标 |
| **加价拍卖（AUC）** | English forward；反狙击 sniper_extend；卖家担保金 5% |
| **P2P 原生商店** | 详情存卖家节点，WebAZ 锚 hash + 签名；零中心化存储 |
| **二手市场（M8）** | 协议费 1%（vs 商家 2%）鼓励个人发布 |

### 💬 信任 / 仲裁
| 模块 | 描述 |
|---|---|
| **争议系统** | 双方举证 → 仲裁员裁定 → 4 路径结算（release_seller / partial_refund / liability_split / refund_buyer）→ 资金事务化（v0.4.14 修） |
| **Claim 验证 + 条件订单** | 买家对卖家推荐理由发起验证，3 verifier 共识 → 4 路径（pass / fail / no_fault / timeout）+ outlier 处罚 |
| **链接认领** | 卖家关联外站链接需通过众包验证，防冒用 |
| **W1-W9 对话窗** | 统一时间线 + 跨窗反诈一致性（37/37 smoke）|
| **KYC 强制**（v0.4.12 修）| 食药婴幼品类 listing 必通过 KYC 审批；提现 ≥ 1000 WAZ 强制 KYC |

### 🌐 内容 / 社交
| 模块 | 描述 |
|---|---|
| **笔记发布**（小红书风格，v0.4.13）| 多图横向 scroll + 拖拽重排 + 字数计数 + 草稿 localStorage + 发布前预览 |
| **流量口令（anchor）** | 创作者从外站引流回 WebAZ：`@handle + 4 字符 middle` 全网唯一精准指向（不重名）|
| **三层归属**（dozer + atomic）| 一买带三方分润：L1 直接推荐 / L2 间接 / L3 远 — 地区差异化截断 |
| **收藏 / 赞过 / 已转发**（v0.4.13-14）| 4 tabs：笔记（原创）/ 🔁 已转发 / ❤ 赞过 / ★ 收藏 |
| **个人主页**（小红书风格，v0.4.13）| 居中大头像 + 3 KPI（关注/粉丝/获赞）+ 双列瀑布流 |
| **粉丝 / 关注系统** | follows 表 + feed 流可见性开关 |

### 💰 经济 / 合规
| 模块 | 描述 |
|---|---|
| **commission / 匹配奖励 解耦**（v0.4.8）| 协议层完全解耦：两套系统互不挤占同一笔订单的钱 |
| **按辖区合规配置** | region_config 按辖区差异化；默认取**最保守**档（放宽需事前法律 / 治理放行）|
| **PV 系统** | PV = 中性参与 / 归因记录（默认 ON）；匹配奖励兑付默认**关闭**、须法律放行 |
| **WAZ 钱包 + 链上锚** | balance / escrowed / staked / earned；USDC 充值（Base Sepolia）+ HMAC 提现白名单 + 24h 冷却 + WebAuthn UV gate |
| **慈善基金**（双匿名）| HMAC 派生 handle + 双签锚定；许愿/圆梦/还愿/转捐 4 套荣誉细分 |
| **协议费** | 2%（商家）/ 1%（二手）；50% 入协议储备池（protocol_reserve_pool）/ 50% 入运营 |

### 🤖 Agent 友好
| 模块 | 描述 |
|---|---|
| **32 个 MCP 工具** | register / search / place_order / dispute / charity / RFQ / auction / chat / 等 |
| **Agent Reputation** | 每 api_key 独立 trust_score（4 layer band）；raw mode 需 trust ≥ 30 |
| **角色感知 API** | `?mode=pwa\|agent\|raw` 三档：raw 模式 HMAC 签名响应 |
| **价格锁定** | `webaz_verify_price` 返 session_token，防决策与下单之间漂移 |
| **OpenAPI 端点目录**（v0.4.12）| `docs/api-endpoints.md`（509 endpoints）+ `/openapi.json`（agent SDK import）|

---

## 3️⃣ 协议设计理念

### 三大原则

1. **责任方自举证**：每个状态转移都由责任方自举证，协议自动判责（不依赖中心化客服）
2. **零额外工作量接入**：卖家不用学新工具，PWA + MCP 共用同一后端
3. **手机即可参与**：所有角色（买/卖/物流/仲裁员/审核员/admin）仅需手机

### 协议级硬约束

- **commission 路径必关联订单**：所有 `shareables` 必有 `related_order_id` 或 `related_product_id`（v0.4.14 修补漏洞）
- **每个 anchor 全局唯一**：`@handle + middle` 不重名、不模糊（ASCII-only）
- **资金事务化**：settleOrder + dispute hooks 全部 `db.transaction` 包裹（v0.4.14 audit 修）
- **TOCTOU 保护**：anchor 配额检查 + INSERT 同一事务（v0.4.14 修）
- **3 重防误操作**：取消分享 = 视觉警告 + 默认聚焦取消 + 密码 gate

### 地区差异化呈现（合规）

| 地区 | max_levels | UI 显示 |
|---|---|---|
| GCC（沙特/UAE）| 0 | 完全隐 PV 系统，commission 入 charity |
| 中国 / 印度 / EU / US | 2 | 仅显示 L1+L2（去 L3 行）|
| 新加坡 / 日韩 / 拉美 | 3 | 完整 3 层显示 |

UI 按 `region_max_levels` 动态渲染，**同套代码全球部署**。

---

## 4️⃣ 技术架构

### 6 层架构

```
src/
├── layer0-foundation/        基础设施（DB / 加密 / SSRF / 签名）
├── layer1-agent/             Agent 接口
│   ├── L1-1-mcp-server/      32 个 MCP 工具
│   └── L1-2-external-anchor/ 外置存证锚
├── layer2-business/          业务模块
│   ├── L2-anchor-registry/   流量口令注册
│   ├── L2-notes/             笔记 + 防剽窃
│   ├── L2-6-notifications/   通知 / SSE
│   └── L2-7-snf/             skill 市场
├── layer3-trust/             仲裁 / 评分 / 信誉
├── layer4-economics/         分润 / PV / 钱包
└── pwa/                      Express 后端 + Vanilla JS SPA 前端
```

### 数据库

- **SQLite + better-sqlite3**（开发）/ 可平迁 PostgreSQL（生产）
- **142 张表**，含完整审计日志 + 索引（v0.4.12 加 3 个复合 COVERING INDEX）
- **WAL 模式** + 同进程事务串行化

### 测试矩阵（87 checks 全 PASS）

| 套件 | checks | 覆盖 |
|---|---|---|
| `audit-smoke.sh` | 18 | 基础端点 + LIKE 转义 + 索引 |
| `test-w1w9-smoke.sh` | 37 | W1-W9 对话窗 + 跨窗反诈 |
| `test-shares-dashboard.sh` | 10 | 分享中心 endpoint + SQL 索引命中 |
| `test-audit-2026-05-22.sh` | 16 | health / 错误上报 / KYC 拦截 / OpenAPI |
| `test-anchor-toctou.ts` | 6 | anchor 配额 TOCTOU 回归 |

---

## 5️⃣ 当前数据规模（实测）

```
注册用户：    234
完成订单：    89
活跃商品：    59
活跃笔记：    4
流量口令：    1
争议案例：    1
DB 表数：     142
API endpoint: 509（225 POST + 228 GET + 35 DELETE + 20 PATCH + 1 PUT）
MCP 工具：    32
```

> **注**：当前为开发测试期数据，非生产规模。

---

## 6️⃣ 关键里程碑（最近 3 周）

| 版本 | 日期 | 主题 | 关键交付 |
|---|---|---|---|
| v0.4.6 | 5/19 | W1-W9 对话窗统一时间线 | 跨窗反诈一致性 + 37/37 smoke |
| v0.4.7 | 5/20 | 详情页瘦身 + 三层归属共识 | dozer + atomic 协议层完整 |
| v0.4.8 | 5/20 | PV 合规 33 国 + commission/PV 解耦 | 同套代码全球合规 |
| v0.4.9 | 5/21 | 分享中心重构 + anchor 协议 | 流量口令 MVP |
| v0.4.10 | 5/21 | 观众侧口令入口 + 跳转修复 | 完整闭环 |
| v0.4.11 | 5/22 早 | 暗号→口令 + 分享中心打磨 | 109 处术语统一 + 4 个隐藏 bug |
| v0.4.12 | 5/22 晚 | **全面审计** + Code review 14 项 | KYC 真实 enforce + 错误上报 + OpenAPI + MASTER_SEED 强制 |
| v0.4.13 | 5/22 深夜 | 小红书风格改造 | 笔记发布 + 个人主页（瀑布流 + 4 tabs）|
| v0.4.14 | 5/22 深夜 | backlog 清理 + UX 闭环 | 收藏功能 / TOCTOU / 仲裁事务 / 创作协议关联 |

---

## 7️⃣ 商业模式

### 卖家激励
- **零额外工作量**：现有商品池零成本接入新渠道（Agent 自动发现）
- **零质押上架**：Direct Pay 本金不经过 WebAZ；平台托管与订单质押不作为当前真实支付能力
- **2% 协议费**（vs 平台 5-10%）

### 买家激励
- **协议级精准镜像**：搜索不被广告污染
- **Agent 自动购物**：Claude 直接代下单 + 锁价
- **三层归属奖励**：分享带来转化得 L1/L2/L3 分润

### Agent 激励
- **api_key trust_score**：长期积累信誉，raw mode 高级访问权
- **Skill 市场**：开发者发布 Skill，按使用量分成

### 协议自身
- **2% 协议费** → 50% 协议储备池 + 50% 运营
- **1% 基金池** → 慈善 / 兜底分润 / 仲裁补贴
- **0.5% pin rewards** → P2P 节点激励

---

## 8️⃣ 与其他模型对比

| 维度 | 传统电商（淘宝 / Amazon）| Web3 NFT 市场 | **WebAZ** |
|---|---|---|---|
| 中心化程度 | 完全中心化 | 完全去中心化 | **协议层 + 应用层分离** |
| Agent 支持 | API 后补，反爬严 | 钱包接 dApp | **MCP 原生** |
| 卖家成本 | 5-10% 平台费 + 推广 | 自建 storefront | **2% 协议费 + 零推广** |
| 争议解决 | 平台仲裁 | 智能合约 escrow | **共识仲裁 + 协议判责** |
| 合规适配 | 单地区 / 各地另起 | 难合规 | **同套代码 33 国差异化** |
| 数据归属 | 平台拥有 | 用户钱包 | **协议锚定 + 节点存储**（P2P 模式）|

---

## 9️⃣ 生产就绪状态

### ✅ 已就绪
- [x] PV 33 国合规审计
- [x] 资金事务化（settleOrder + dispute hooks）
- [x] KYC 真实 enforce（食药婴幼 + 大额提现）
- [x] MASTER_SEED 强制（boot 自检）
- [x] /api/health 端点（LB / 监控）
- [x] 错误上报（DB 持久化 + admin 看板）
- [x] OpenAPI 文档（509 endpoints）
- [x] 87/87 smoke checks 全 PASS
- [x] 反 TOCTOU（anchor / dispute）
- [x] modal a11y（dialog / aria-modal / ESC / focus）

### ⏳ 部署前必做
```bash
export WALLET_MASTER_SEED=$(openssl rand -hex 32)  # 必设
# LB 挂 /api/health 5s interval
# admin 看板查 /api/admin/errors
```

### 📋 长期 backlog（v0.4.14 整理）

**功能 P1**：
- 笔记 `#话题/标签` 系统（4-6h）
- 笔记 `@用户提及` + 推送（2-3h）
- 草稿列表管理（1-2h）

**生产 P1**：
- 部署文档（README deploy 章节）
- OpenAPI 补 request/response schema

**协议演进 P2**：
- 参数敏感度 review（ANCHOR_MAX_PER_USER / KYC_THRESHOLD）
- E2E Playwright（替代当前 shell smoke）

---

## 🎯 一句话总结

**WebAZ = 让 AI Agent 像人一样卖货买货的协议层。**

不抢任何平台的位置，给任何 Agent 增加商业能力。
人类用 PWA，AI 用 MCP，共用同一资金 / 仲裁 / 信誉系统。
全球 33 国合规差异化，同套代码部署。

代码 54K 行，142 张表，509 endpoint，32 个 MCP 工具，87/87 smoke PASS。
生产就绪状态 8/10（部署前补 1 个环境变量即可）。

---

> 📂 完整变更：[`CHANGELOG.md`](../CHANGELOG.md)（v0.1.0 → v0.4.14）  
> 📂 API 目录：[`docs/api-endpoints.md`](api-endpoints.md)（509 个 endpoint）  
> 📂 模块详解：[`docs/modules/`](modules/)（11 篇主题文档）  
