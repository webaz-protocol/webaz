# RFC-003: MCP Network Client — 从本地沙盒到生产 API 瘦客户端 / From Local Sandbox to Production-API Thin Client

**Status**: implemented — P0–P4 shipped 2026-06-05 (NETWORK_TOOLS = 8/37：search / verify_price / place_order / list_product / update_order / get_status / price_history / leaderboard 覆盖完整 发现→下单→履约→追踪 闭环；其余工具仍 SANDBOX，按需后续迁移)
**Author**: @seasonkoh
**Created**: 2026-06-05
**Track**: normal (14d) — 架构变更，非元规则修改；但**强化** #3(数据隔离) / #4(诚实) 的执行，且是 network-effect / launch 的前置 critical path
**Related issue**: task #1107
**Supersedes**: (n/a)
**Superseded by**: (n/a)

---

> **Amendment — current state (2026-07):** 实现已从本 RFC 原始「双模」细化为**三态**。**无 `api_key` 不再 fallback 到 SANDBOX**,而是 **NETWORK 只读**(`network_readonly`:公共读打 `webaz.xyz`,交易工具需 key)。**SANDBOX 仅由显式 `WEBAZ_MODE=sandbox` 触发**(本机隔离)。本文下方「双模 / 未配 key = sandbox」表述请按此修正理解;权威口径以 README + `server.ts` 的 MODE 解析 + `test-mcp-mode-honesty` 守卫为准。
> Implementation was refined from the original two-mode design into **three modes**: no key = **NETWORK read-only** (`network_readonly`), NOT a sandbox fallback; SANDBOX is **explicit** via `WEBAZ_MODE=sandbox`.

## Summary / 摘要

当前发布的 MCP server（`@seasonkoh/webaz`，`npx` 本地运行）所有**写操作**（注册 / 下单 / 上架 / 改单）都 `db.prepare` 写入本地 SQLite `~/.webaz/webaz.db`。每个安装 MCP 的用户因此是一个**私有单机沙盒**，彼此之间、以及与生产 `webaz.xyz` **完全隔离**。后果：**"装 MCP" ≠ "加入网络"** —— 网络效应（已被认定为本协议唯一护城河）无法形成。

本 RFC 提议把 MCP 改造为**双模客户端**：默认 **NETWORK 模式**（带 `api_key` 调 `webaz.xyz/api/*`，全网共享一个生产库），保留 **SANDBOX 模式**（本地 SQLite，离线试玩/开发，**全程显著标注**避免与真实网络混淆）。生产 API 已具备 `Authorization: Bearer <api_key>` agent 认证 + 责任制/信誉/限流，地基已在。

The published MCP writes all mutations to a local SQLite, making every install an isolated single-player sandbox — so "installing the MCP" never means "joining the network", and network effects (the protocol's core moat) can't form. This RFC converts the MCP into a **dual-mode client**: default **NETWORK** (calls `webaz.xyz/api/*` with the user's `api_key`, one shared production DB) and an explicitly-labeled **SANDBOX** (local SQLite for offline trial/dev). Production API already supports Bearer api_key agent auth.

---

## Motivation / 动机

### 1. 现状事实（code-grounded，2026-06-05 查实）
- MCP `handleRegister` / `handlePlaceOrder` / `handleListProduct` 等核心写操作 = `db.prepare INSERT/UPDATE`，写本地 `~/.webaz/webaz.db`（`src/layer0-foundation/L0-1-database/schema.ts:14` 硬编码，无 env override）。
- 37 个工具中 ~14 个已用 `fetch`，但 `PWA_API_BASE` 默认 `http://localhost:3000/api`（指用户本地 PWA，非生产）。仅 `search-by-link` 等少数读 relay 到 `webaz.xyz`。
- 代码 disclaimer 已诚实标注此为本地沙盒（`network_state.disclaimer`：「本机 MCP 服务器的本地 SQLite，仅供 dev/demo，不代表协议全网真实状态」）。

### 2. 为什么不够 / Why insufficient
- **网络效应无法形成**：每个用户是孤岛，没有共享流动性/市场/对手方。宣传拉来的人 = 一堆互不相连的沙盒，不是社区。这与"网络=唯一护城河"的战略直接冲突。
- **对外叙事失真风险**：若把本地沙盒 demo 说成"agent 在 webaz.xyz 活网络上交易"，违反 #4(不撒谎)。当前 disclaimer 缓解了，但只要默认是沙盒，这个混淆面就一直在。
- **launch 阻塞**：没有这个，launch 无法把用户聚成网络；demo 也只能是本地单机。

### 3. 地基已在（降低工作量）
- 生产 API agent 认证：`server.ts:4239` `Authorization: Bearer <api_key>` → `WHERE api_key=?` + agent_call_log / agent_reputation / agent_declarations / 限流 / scope 全套。
- 已支持 api_key 的生产路由：orders-create / products-crud / products-list / p2p-products / shops / secondhand / notifications / agent-reputation。
- 核心写端点已存在：`POST /api/orders`、`POST /api/products`、`POST /api/agent-buy`。

---

## Design / 设计

### 3.1 三态 + 模式可见性（核心）
三种模式（原设计为双模；已按 no-key = read-only 修正，见文首 Amendment）。**无 key = NETWORK 只读，不再回落本机沙盒**：

| 模式 | DB / 数据源 | 用途 | 触发 |
|---|---|---|---|
| **NETWORK 只读**（默认）| `fetch(WEBAZ_API_URL=https://webaz.xyz/api/*)` **公共读**（无 Bearer） | 无需 key 搜索 / 榜单 / 价格史 / 浏览**真实网络** | **未配** `WEBAZ_API_KEY`（默认） |
| **NETWORK**（完整）| 同上 + Bearer `api_key`，**生产共享库** | 真实加入网络、真实交易 | 配了 `WEBAZ_API_KEY` |
| **SANDBOX**（显式）| 本地 `~/.webaz/webaz.db` | 离线试玩 / 开发 / demo | **仅** `WEBAZ_MODE=sandbox`（本机隔离） |

**显著区分（决策 ②的硬要求，防混淆）—— 三层强制标注**：
1. **启动 banner**（stderr）：`🟢 NETWORK mode — connected to webaz.xyz (live shared network)` 或 `🟡 SANDBOX mode — local-only, NOT the live network. Data is private to this machine.`
2. **每个工具返回**附 `_mode` 字段（`"network" | "network_readonly" | "sandbox"`）+ sandbox 时附 `_sandbox_warning`。
3. **`webaz_get_status` / `webaz_info`** 顶部显式声明当前模式 + 含义；sandbox 的所有计数明确标"仅本机，非全网"。
4. 工具 description 里凡涉及"全网/真实"语义的，按模式动态措辞（避免 agent 把 sandbox 当 live 汇报给用户）。

> 设计原则：**任何人/agent 在任何一个工具输出里，都不可能分不清现在是真网络还是沙盒。** 这是 #4(诚实) 的执行落地。

### 3.2 配置 / Config
```
WEBAZ_API_URL   默认 https://webaz.xyz      （NETWORK 端点；dev 可指 http://localhost:3000）
WEBAZ_API_KEY   用户的 api_key              （有=NETWORK 完整；无=NETWORK 只读 public reads，**不**回落本机沙盒）
WEBAZ_MODE      network | network_readonly | sandbox （sandbox 仅显式设置；默认无 key=network_readonly、有 key=network）
```
- 移除 `~/.webaz/webaz.db` 硬编码的隐式依赖（NETWORK 模式不开本地库）。

### 3.3 统一 helper
```ts
async function apiCall(path, { method='GET', body, idempotencyKey } = {}) {
  // NETWORK: fetch(WEBAZ_API_URL+path, { method, headers:{Authorization:`Bearer ${API_KEY}`, ...}, body })
  //   - 统一错误映射（401→"key 无效/未注册"、403→scope/邀请、429→限流、503→retry）
  //   - AbortSignal.timeout（参 feedback_post_refactor_browser_smoke）
  // SANDBOX: 走原 db.prepare 本地逻辑
}
```
所有工具 handler 改为：NETWORK 调 `apiCall`，SANDBOX 保留本地实现（共用一个 dispatch）。

### 3.4 注册模型（决策 ①）
**NETWORK 模式下 `webaz_register` 不自助建号**（agent 自助注册会绕过邀请/captcha 责任制；且 gated HTTP 路由 agent 也解不了 captcha）。改为：
- 返回引导：「在 https://webaz.xyz 注册(需邀请码)→ 设置里复制你的 api_key → 填进 MCP 配置 `WEBAZ_API_KEY`」。
- 对齐 CHARTER §4 I-5 AI 责任制：**agent 必须由已绑 Passkey 的真人(api_key 持有者)触发**。
- **SANDBOX 模式**：`webaz_register` 仍本地建号（试玩用），但**明确标注**"sandbox 账号，仅本机有效"。

### 3.5 逐工具迁移（P0 先出审计表）
把 37 工具分三类：
- **A. 已 fetch**（~14）：只需把 base 从 localhost 改为 `WEBAZ_API_URL` + 加 Bearer。
- **B. 有现成生产端点**（orders/products/notifications/p2p/shops/secondhand…）：改 `apiCall` 调之。
- **C. 缺端点**（verify_price 的 price-lock session、auction/bid、update_order 状态机、claim_verify、dispute、wallet 等 agent 写口）：**需在 PWA 侧补 api_key-authed HTTP 端点**。P0 审计产出精确缺口清单。

### 3.6 Rollout（serial PR，每段独立可 merge/验证）—— ✅ 全部完成 2026-06-05
- ✅ **P0**（PR #75）：config + `apiCall` helper + 模式可见性(3 层标注) + **37 工具审计表**（A/B/C 分类 + 缺口清单）。不改行为，先立骨架。
- ✅ **P1**（PR #76）：读工具(price_history / leaderboard) 指向生产。低风险，验证"连得上生产网络"。
- ✅ **P2 / P2b**（PR #77 / #78）：核心写(verify_price / place_order / list_product / update_order) 改调生产端点。本地 e2e 跑通完整交易+履约闭环。
- ✅ **P3**（PR #79）：注册重设计(§3.4) + sandbox 标注收尾(register / info / dispatch `_mode`)。
- ✅ **P4**（本 PR）：补 loop-critical 读工具(search / get_status) 让 network 模式真正可用 + README NETWORK/SANDBOX 文档。

**最终迁移集（8/37）**：search · verify_price · place_order · list_product · update_order · get_status · price_history · leaderboard —— 覆盖完整 发现→锁价→下单→履约→追踪 闭环。其余工具(wallet/notifications/profile/chat/rfq/auction/secondhand/skill 等)仍 SANDBOX，按真实需求后续逐个迁移；每个工具结果都有 `_mode` 戳，不会把 sandbox 误当 live。

### 3.7 附带收益
P2 完成后，demo 自动从"本地单机"升级为"**agent 在 webaz.xyz 活网络上真买**" —— 更震撼、且 #4-诚实。

---

## Meta-rule impact / 元规则影响

- **#1 当一切可见**：✅ 增强 — 模式三层标注让"现在是真网络还是沙盒"对所有人/agent 永远可见。
- **#2 代码即规则**：✅ 中性 — agent 走生产 API 即自动受生产 gate(邀请/captcha/责任制/限流)约束，而非本地裸跑。
- **#3 不偷数据**：✅ 增强 — NETWORK/SANDBOX 物理隔离明确化；本地沙盒数据不再被误当全网；prod 数据只经 api_key 授权访问。沿用既有 schema/数据约束。
- **#4 不撒谎**：✅ **核心动机** — 消除"沙盒被当 live 网络"的失真面（启动 banner + 每工具 `_mode` + status 声明）。
- **#5 不偏袒**：— 无影响。
- **#6 不滥用**：✅ 中性偏强 — agent 上生产受现有 agent 责任制/限流/scope 管;sandbox 滥用只影响自己本机。
- **#7 不操纵**：— 无影响。
- **#8/#9/#10**：协议/算法/参与者层无破坏性改动；#10 受益(参与者真正接入共享网络才成"webazer")。
- **Iron-Rule 边界**：注册 / 大额 / arbitration 等需真人 Passkey 的动作不变 —— NETWORK 模式恰好**强制**这些走生产 Passkey 路径(比本地沙盒更严)。

---

## Risks & open questions / 风险与未决

1. **C 类端点工作量**：部分 agent 写口(verify_price session / auction / dispute / wallet)生产侧可能没有 api_key-authed HTTP 端点，需新建。P0 审计才能定量。
2. **注册 UX 摩擦**：真人先去 PWA 注册(需邀请码)再回填 key —— 比"agent 一键注册"多一步。这是合规/责任制的必要代价；用清晰引导文案降摩擦。
3. **向后兼容**：现有(极少数)sandbox 用户行为不变(SANDBOX 仍在);默认变 NETWORK 不会破坏离线开发(fallback + WEBAZ_MODE)。
4. **生产滥用面**：agent 上生产即暴露写口给公网 key 持有者 —— 由现有 agent 责任制 + 邀请门 + 限流兜底;launch 前复测这套在"真有 agent 流量"下是否够。
5. **captcha 现状**：生产 `TURNSTILE_SECRET_KEY` 未设(查实);开放注册前需配上(独立 task，见 §future)。本 RFC 不依赖它(注册走 PWA 人工)。

## Future / 后续(本 RFC 不含)
- 开放注册(去邀请制)时配 `TURNSTILE_SECRET_KEY`。
- 远程托管 MCP(hosted) 选项(免本地 npx),作为更低门槛入口。

---

## Test plan / 测试计划
- P0：模式切换单测(有/无 key → network/sandbox)；启动 banner + 每工具 `_mode` 字段断言；审计表覆盖 37 工具。
- P1/P2：对本地 `npm run pwa` 起的实例跑 NETWORK 模式 e2e(注册引导 → 拿 key → search → verify_price → place_order → 订单出现)；守恒/鉴权/限流路径验证。
- 浏览器实测：静态扫描看不到接线漏/boot hang，必跑真实浏览器 smoke；await fetch 一律加 AbortSignal.timeout。
- schema:verify 绿 + build 绿。
