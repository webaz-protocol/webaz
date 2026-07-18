# WebAZ Cross-Host MCP Compatibility Audit

> Date: 2026-07-18 · Baseline: contract v29, software 0.1.33, production webaz.xyz (post PR-1..7 + USDC + ProductResults/QuoteAndApproval/OrderTimeline)
> Scope: audit + measurement + gap analysis only. **No business logic changed, no adapters implemented, no PR beyond this document.**
>
> Evidence labels used throughout:
> **DOC** official documentation · **CODE** repository inspection · **LOCAL TEST** in-repo automated tests (in-memory MCP SDK client) · **PRODUCTION TEST** read-only probes against `https://webaz.xyz/mcp` · **HUMAN VISUAL** Holden's live client verification · **COMMUNITY** credible secondary sources · **NOT VERIFIED** could not confirm

---

## 1. Executive Summary

**WebAZ 的核心购物链路(工具 + structuredContent + 文本降级 + OAuth + Passkey 深链)是标准 MCP 通用能力,今天即可被所有主流 Host 消费;但三个 UI 组件目前只对 ChatGPT 可见** —— 因为组件元数据只发 OpenAI 遗留键(`openai/outputTemplate` + `text/html+skybridge`),而 **MCP Apps 已于 2026-01-26 成为 Stable 官方扩展**(SEP-1865,标准键 `_meta.ui.resourceUri` + `text/html;profile=mcp-app`),**claude.ai / Claude Desktop / VS Code 已经用标准键渲染 MCP Apps,Goose 实验性支持**(DOC)。

- **最大兼容优势**:架构分层正确 —— ChatGPT 专属字段全部隔离在 L1 MCP server 层(CODE),业务/钱路/OAuth/Passkey 零 host 分支;所有经济动作以 `https://webaz.xyz` Passkey 深链收口,连纯消息通道 agent(OpenClaw/Hermes)都能走完整交易(链接由真人点开)。
- **最大限制**:UI 组件元数据未发标准键 → Claude/VS Code/Goose 只能文本降级;widget 内部绑定 `window.openai` 桥(ChatGPT 扩展层),标准宿主用 `ui/*` postMessage JSON-RPC 桥。
- **推荐下一步**:一个小 PR(PR-A,标准 MCP Apps 元数据双发 + widget 桥薄抽象)即可能把 UI 渲染面从 1 个 Host 扩展到 4 个,零业务改动。这是全审计最高价值差距。

---

## 2. Capability Matrix

| Host | Remote MCP | OAuth | structuredContent | MCP Apps | Interactive UI | Deep Link | Full Flow | Evidence |
|---|---|---|---|---|---|---|---|---|
| ChatGPT Web/Desktop | ✅ Streamable HTTP | ✅ PKCE;偏好 CIMD,支持 DCR | ✅ 模型可读 | ✅(openai/* 遗留键 + 标准键双轨) | ✅ callTool/openExternal | ✅ openExternal→系统浏览器 | **FULL\***(两项残留点验:单订单时间线模式、联系商家按钮 G3)| HUMAN VISUAL(渲染)+ DOC |
| claude.ai / Claude Desktop | ✅ Streamable HTTP | ✅ PKCE + DCR + CIMD | ⚠️ 文档未列(NOT VERIFIED) | ✅ **标准键**(2026-01-26 GA,全 plan)| ✅(UI 发起工具调用需用户确认)| ✅ | **TEXT/TOOLS 今天;PR-A 后或 FULL** | HUMAN VISUAL(纯文本)+ DOC |
| Claude Code (CLI) | ✅ HTTP/stdio/WS | ✅ PKCE + DCR + CIMD(loopback)| ⚠️ 社区报告被忽略(COMMUNITY)| ❌ 终端不渲染 | ❌ | ✅ 文本链接 | **TOOLS-ONLY** | DOC + COMMUNITY |
| VS Code / Copilot | ✅ Streamable HTTP | ✅ 自动 OAuth 流 | ✅(1.103+,2025-06-18 spec)| ✅ **stable**(2026-01/02,标准键)| ✅ | ✅ | **PR-A 后或 FULL;未实测** | DOC;NOT VERIFIED live |
| Goose | ✅ stdio + Streamable HTTP | ✅ OAuth 2.1(预期 DCR;体验粗糙)| ⚠️ NOT VERIFIED | ⚠️ 实验性 | ⚠️ 实验性 | ✅ 浏览器 | **TOOLS;UI 实验性** | DOC + COMMUNITY;NOT VERIFIED live |
| OpenClaw | ⚠️ 非原生 client:CLI bridge(`openclaw mcp` 注册表 + exec/skill 桥)| ✅ `openclaw mcp login`(bridge 层)| ❌ 桥出来是 CLI 文本 | ❌(UI=WhatsApp/Telegram 等消息通道)| ❌ | ✅ 链接发进聊天由真人点 | **TOOLS-ONLY(bridge)** | DOC + COMMUNITY;NOT VERIFIED live |
| Hermes Agent (Nous Research) | ✅ stdio + remote HTTP | ✅ `auth: oauth`(细节 NOT VERIFIED)| ⚠️ NOT VERIFIED | ❌ 未提及(TUI/消息通道)| ❌ | ✅ 链接文本 | **TOOLS-ONLY** | DOC;NOT VERIFIED live |
| Generic SDK client / Inspector / headless | ✅ SDK 原生 | ✅ SDK 提供 PKCE 管线 | ✅ 送达(是否喂给模型由嵌入方定)| ❌(扩展是可选的)| ❌ | ⚠️ 嵌入方决定 | **TOOLS-ONLY** | LOCAL TEST(本仓 62+31+23+38 asserts)+ DOC |

**不把"支持 MCP"等同"支持 MCP Apps"**:八类 Host 全部支持前者,今天真正渲染我们组件的只有 ChatGPT(HUMAN VISUAL);标准键渲染方(Claude/VS Code/Goose)对我们不可见,原因在我们侧(见 §5)。

## 3. Component Matrix

| Host | ProductResults | QuoteAndApproval | OrderTimeline | Text Fallback |
|---|---|---|---|---|
| ChatGPT | ✅ HUMAN VISUAL | ✅ HUMAN VISUAL | ✅ HUMAN VISUAL(列表模式;单订单点验中)| ✅(structuredContent+摘要)|
| claude.ai / Desktop | ❌ 今天(缺标准键)| ❌ 同左 | ❌ 同左 | ✅ HUMAN VISUAL(spike 实测纯文本)|
| Claude Code | ❌ | ❌ | ❌ | ⚠️ structuredContent 或被忽略 → 只剩一行摘要(见 §8)|
| VS Code / Copilot | PR-A 后可望 ✅ | 同左 | 同左 | ✅ 预期(structuredContent 支持 DOC)|
| Goose | 实验性,PR-A 后待验 | 同左 | 同左 | ⚠️ NOT VERIFIED |
| OpenClaw / Hermes / Generic | ❌ | ❌ | ❌ | ✅ 文本 + 深链(交易仍可走完)|

## 4. Evidence Log(关键结论逐条溯源)

| # | 结论 | 证据级别 |
|---|---|---|
| E1 | 生产 `/mcp` initialize:protocol 2025-06-18,serverInfo dcp-protocol 0.1.33,capabilities {tools,resources,prompts},instructions 空 | PRODUCTION TEST |
| E2 | 匿名 tools/list = 21 工具,45,588 B(≈11.4k tok);7 个审计对象工具的 per-tool schema 尺寸见 §9 | PRODUCTION TEST |
| E3 | 5 个资源在列:`webaz://protocol/manifest`、3 个 `ui://widget/*.html`(均 `text/html+skybridge` + `openai/widgetCSP` 空域 + `openai/widgetDomain`)、`webaz://guide/info` | PRODUCTION TEST |
| E4 | `webaz_search`(匿名只读)命中 1 件:USDC price/decision_flags/estimated_days/return_days/stock_status/summary 全在 structuredContent;fx 表带 `display-only conversion — never a settlement path`;0 命中走 recovery(catalog_sample + next_step);envelope 含 result_handle;零 WAZ | PRODUCTION TEST |
| E5 | `webaz_search`/`webaz_quote_order`/`webaz_order_draft`/`webaz_submit_order_request`/`webaz_buyer_orders` 均带 outputSchema + `openai/outputTemplate`;`webaz_order_chat`/`webaz_connection_status` 无 UI 模板(工具型)| PRODUCTION TEST |
| E6 | ChatGPT 渲染三组件;Claude(claude.ai)同期实测纯文本 | HUMAN VISUAL(2026-07-18 及 spike/PR-4/5 验证)|
| E7 | MCP Apps 扩展 spec **Stable 2026-01-26**(SEP-1865;`io.modelcontextprotocol/ui`;`_meta.ui.resourceUri`(扁平 `ui/resourceUri` 已弃用)+ `_meta.ui.csp/domain/visibility/prefersBorder`;MIME `text/html;profile=mcp-app`;sandboxed iframe + `ui/*` postMessage JSON-RPC 桥)| DOC |
| E8 | claude.ai + Claude Desktop 自 2026-01-26 起 GA 渲染 MCP Apps(标准键;UI 发起的工具调用需用户确认;Team/Enterprise 可org级关闭)| DOC |
| E9 | OpenAI 文档已迁移到标准键双轨:`_meta.ui.*` + `text/html;profile=mcp-app` 为主,`openai/outputTemplate`/`text/html+skybridge` 标注为 legacy/compatibility | DOC |
| E10 | VS Code:MCP Apps stable(2026-01 Insiders → 一周后 stable);structuredContent 自 1.103;Copilot 用户 20M+ | DOC |
| E11 | Goose:MCP Apps 实验性;OAuth DCR 预期;structuredContent NOT VERIFIED | DOC + COMMUNITY |
| E12 | OpenClaw:非原生 MCP client(bridge 架构,native 支持是长期 open issue);383k stars | DOC + COMMUNITY |
| E13 | Hermes Agent = NousResearch/hermes-agent(216k stars);stdio+remote HTTP,`auth: oauth`;Tool Search 渐进式工具披露;UI 面=TUI/消息通道 | DOC |
| E14 | ChatGPT:tools/list 快照缓存,developer-mode 需手动 Refresh;widget 模板以资源 URI 为缓存键;token 留在 host 侧不暴露给模型;widget `callTool` 不经模型直达 server;写动作默认逐次确认(respect `readOnlyHint`)| DOC |
| E15 | claude.ai:回调固定 `https://claude.ai/api/mcp/auth_callback`;出口 IP 段 160.79.104.0/21;工具结果上限 ~150k chars;no-auth 远程 server 允许;token 主动续期 | DOC |
| E16 | Claude Code:结果上限默认 25k tok;`notifications/tools/list_changed` 自动刷新;headless 无法跑 OAuth 流(需预登录)| DOC |
| E17 | 本仓 in-memory SDK client 套件(remote-mcp 62 / quote-approval-ui 31 / order-timeline-ui 23 / model-projection 38 asserts)全绿 = generic SDK client 消费路径的行为证据 | LOCAL TEST |
| E18 | ChatGPT widget API 参考文档写 `sendFollowUpMessage`;本仓三组件调用 `sendFollowupTurn`(capability-probed,不匹配则按钮无操作而非报错)。ChatGPT 实渲染时该按钮是否真发消息 **NOT VERIFIED** —— 需 HUMAN VISUAL 点验(列入 PR-A 验证清单)| DOC + CODE,行为 NOT VERIFIED |
| E19 | ChatGPT per-tool schema ~5k token 上限、大响应截断:COMMUNITY(无官方文档);我方最大单工具 6,658 B(webaz_search)远低于该线 | COMMUNITY + PRODUCTION TEST |
| E20 | npm 包 @seasonkoh/webaz 0.1.32 = generic stdio 全工具面入口(local key 模式)| CODE(memory:npm 状态)|

## 5. 标准路径与 Host 专属路径审计(§五 反模式清单)

架构分层核对(CODE):

```
WebAZ MCP Core(host 无关)                      现状
├── domain logic(layer0/pwa)                  ✅ 零 host 分支
├── OAuth / permissions(RFC-023/024)          ✅ 通用 PKCE+DCR;无 host 写死
├── Passkey approval                           ✅ https://webaz.xyz 深链,universal
├── idempotency(RFC-026)                      ✅
├── Model Projection(agent-model-projection)  ✅ 单一真相源
├── UI Projection                              ⚠️ 与 Model Projection 同一投影(见 A7)
├── structuredContent + outputSchema           ✅ 标准字段
└── text fallback                              ✅ 每工具一行可行动摘要(见 §8 局限)
MCP Apps 组件(3 个)                           ⚠️ 仅 openai/* 遗留键 + window.openai 桥
Host Adapters                                  ✅ 不存在(也不需要,见 §6)
```

逐项结论(风险级别:HIGH/MED/LOW/none):

| # | 反模式 | 结论 | 位置与建议边界 |
|---|---|---|---|
| A1 | 组件必须依赖 `openai/outputTemplate` 才能工作 | **MED,成立** | `src/layer1-agent/L1-1-mcp-server/server.ts` 工具描述符 `_meta` 块(webaz_search / quote / draft / submit / buyer_orders 五处)。修复边界=PR-A:同一 `_meta` 内**追加**标准 `ui.resourceUri`/`ui.visibility`,遗留键保留(ChatGPT 双轨已文档化)|
| A2 | 标准 `_meta.ui.resourceUri` 缺失 | **MED,成立**(全仓 `ui.resourceUri`/`mcpui`/`io.modelcontextprotocol` 零命中,CODE)| 同 A1;资源侧同时补 `_meta.ui.csp/ui.domain`(camelCase 域数组)与 MIME `text/html;profile=mcp-app`(以**新增资源或内容协商**方式,不动现有 skybridge 资源,防回归 ChatGPT)|
| A3 | ChatGPT 专属字段混入业务逻辑 | **none** | `openai/` 字面量在 **TypeScript 源**中仅命中 `L1-1-mcp-server/server.ts`(MCP 层);`src/pwa/public/app-ai.js:185,200` 另有两处命中,是前端 AI 助手的 Groq OpenAI-兼容 endpoint 与 OpenRouter model id,与 MCP host 元数据无关。pwa 层其余 host 词命中均为 Anthropic API model id(AI 描述生成)与 OAuth 同意页"已验证连接方"徽章清单(`oauth-verified-connectors.ts:21-22`,展示信任 UX,非状态机)|
| A4 | OAuth 流写死某个 Host | **none** | RFC-023/024 通用;claude.ai 固定回调 `https://claude.ai/api/mcp/auth_callback` 应能通过 ASCII canonical-prefix 校验(**未与 claude.ai 实连验证,NOT VERIFIED**);CIMD 未支持是**增强项**非违规(ChatGPT 偏好 CIMD 但支持 DCR)|
| A5 | deep link 写死某个客户端 | **LOW** | widget 内 `openExternal` 是 `window.openai` API(Apps 桥固有);文本降级路径始终是裸 `https://webaz.xyz/...` URL,universal。修复边界=PR-A 的桥抽象顺带覆盖 |
| A6 | UI 无法在不支持 MCP Apps 的环境降级 | **none** | structuredContent + 文本摘要是主路径,widget 纯增强(HUMAN VISUAL:Claude 文本可用)|
| A7 | Model Projection 和 UI Projection 混在一起 | **LOW(观察项,非缺陷)** | 当前 widget 读 `toolOutput` = structuredContent,即 UI 投影 ≡ Model 投影。字段全部消费者安全(零 PII/零 WAZ),无泄露;代价是"给 UI 加字段=给模型加 token"。暂不拆分;若未来 UI 需要富字段(图片等),用 ChatGPT 已支持的 widget-only `_meta`(`toolResponseMetadata`)承载,不动 Model Projection |
| A8 | 组件按钮直接调用生产高风险动作 | **部分成立(LOW,Codex R1 纠正)** | CODE(`ui-widgets.ts:93,129,220,237,313,323,352`):widget `callTool` 目标共 4 个 —— `webaz_search`(翻页/详情)与 `webaz_buyer_orders`(读)之外,QuoteAndApproval 还直接调用 **`webaz_order_draft`(create)与 `webaz_submit_order_request`** 两个工作流写操作。**终局仍 Passkey-gated**:draft 不扣款不锁库存,submit 只创建审批请求(幂等 + 重复购买保护),真实订单只能由 Passkey 批准创建;widget 无任何触达资金/订单执行的路径。词元级回归锁只禁外联请求与 DOM sink,**不构成"只读调用"证明** —— PR-A 的 visibility 映射必须逐工具落表(见 PR-A 范围)|
| A9 | Host 名称参与订单状态机 | **none** | grep 零命中(layer0 状态机无 host 词)|
| A10 | 为不同 Host 复制商品/报价/订单逻辑 | **none** | 单一 handler + wrapper 投影 seam(PR-5 架构)|

## 6. HostCapabilities 设计建议(仅设计,不实现)

**结论:不建议建 §六示例那样的服务端 HostCapabilities 大层;capability-driven 的正确落点有三处,全部轻量:**

1. **协议层(唯一需要新代码的地方)**:MCP Apps 的标准协商就是 initialize 时 `capabilities.extensions['io.modelcontextprotocol/ui']`(含 mimeTypes)。服务端**读**这个即可知道宿主是否渲染 UI —— 但因 `_meta.ui.*` 对不渲染的宿主是无害噪音(几百字节),**v1 可以无条件双发,连协商都不必做**;协商读取 + `clientInfo` 遥测作为 PR-C 观察项(为后续决策收集真实宿主分布)。
2. **widget 内(已存在,扩一层)**:现有 `typeof oai.callTool === 'function'` 探测模式是对的;PR-A 把它抽象成 3 方法小桥(`getToolOutput/callTool/openLink/sendMessage`),优先探 `window.openai`,否则探标准 `ui/*` postMessage 桥。**能力优先于品牌**:桥里不出现任何 host 名。
3. **不做的**:User-Agent 猜测;`if host === 'chatgpt'` 式分支;每 host 一套组件。OpenClaw/Hermes 不需要任何适配器 —— 它们消费的就是标准工具+文本+链接,**按 DOC 架构推断即可工作(实连 NOT VERIFIED,见 §13)**。

`hostSpecificOutputTemplate` 一项:保留 `openai/*` 遗留键即是它的全部实现,无需字段建模。

## 7. 完整用户流程(L7)评估

```
搜索 → ProductResults → 报价 → QuoteAndApproval → 草稿 → 提交审批 → Passkey 批准 → 唯一订单 → OrderTimeline → 联系商家
```

| Host | 判定 | 说明 |
|---|---|---|
| ChatGPT | **FULL\*** | 主链 HUMAN VISUAL;**未点验残留:OrderTimeline 单订单模式、联系商家按钮(G3)、widget 发起的 draft/submit 按钮(openai/widgetAccessible 未设置,ChatGPT 文档要求 widget 可调工具显式标记 —— 按钮可能静默失败,NOT VERIFIED,列 PR-A 验收)**;Passkey 经 openExternal 出站、回站后"刷新"callTool 拉新状态(无回调依赖)|
| claude.ai / Desktop | **PARTIAL(TEXT+TOOLS)** | 工具经文本可用(HUMAN VISUAL spike);**OAuth 回调过校验与 structuredContent 是否喂模型均 NOT VERIFIED(G4),"工具链全通"是 DOC 推断非实测**;Passkey 深链在聊天中可点;PR-A 后有望 FULL(需 HUMAN VISUAL 复验)|
| Claude Code | **TOOLS-ONLY** | structuredContent 消费不确定(COMMUNITY 报忽略)→ 依赖一行摘要,详情字段可能丢失(§8);交易仍可完成(摘要含 approval_url/quote_token 等最小可行动字段,CODE)|
| VS Code / Copilot | **NOT VERIFIED(推断 PARTIAL→FULL after PR-A)** | 未实测 |
| Goose | **NOT VERIFIED(推断 TOOLS+实验 UI)** | 未实测 |
| OpenClaw | **TOOLS-ONLY(bridge)** | 深链发进消息通道由真人手机点开 → Passkey 流天然成立;未实测 |
| Hermes | **TOOLS-ONLY** | 同上;未实测 |
| Generic/headless | **TOOLS-ONLY** | LOCAL TEST 全链模拟(quote→draft→submit→approval_url)绿 |

关键架构事实:**Passkey 审批不依赖任何宿主回调** —— 批准发生在 webaz.xyz,宿主侧靠再次调用 `webaz_buyer_orders`/审批读工具拉状态(RFC-026 幂等保护重复提交)。这使 L6/L7 在无 openExternal 的宿主也只降级为"用户手动打开链接",不阻断。

## 8. UI 降级(text fallback)审计

现状机制(CODE `src/agent-model-projection.ts` summarize*):**成功路径 text = 一行可行动摘要,完整字段在 structuredContent;错误路径 text = 完整 minified JSON**(PR-1 刻意设计,保 recovery 字段)。

对 §八 要求字段逐项核对:

| 组件 | 一行摘要含 | structuredContent 补齐 | 缺口 |
|---|---|---|---|
| ProductResults | 件数、id、USDC 价、next_cursor | 名称/约合法币(fx 表)/发货时间/预计送达/退货期/decision_flags 风险标签/summary/next_step(recovery)| 摘要不含标题与法币;**"Details in structuredContent" 对忽略 structuredContent 的宿主是死引用** |
| QuoteAndApproval | quote_id、payable USDC、rail、过期时间、quote_token、"不扣款不锁库存" | 数量/分项 amounts/法币参考/配送/三条披露/审批 approval_url(submit 摘要含)| 摘要不含法币参考与配送摘要 |
| OrderTimeline | order_id、状态标签、USDC、next_actor、事件数 | deadline/payment_rail/退款状态/时间线/联系与订单链接 | 摘要不含 deadline/rail/退款 |

**评估**:对消费 structuredContent 的宿主(ChatGPT/VS Code/SDK)零缺口;对忽略它的宿主(Claude Code COMMUNITY 报告、OpenClaw/Hermes bridge 文本),§八字段清单不满足 —— 这是 **PR-B 的确切范围**(在 token 预算内加厚摘要或提供 `?fallback=full` 内容协商)。零 WAZ / 零 PII 在两条路径均已由回归锁保证(LOCAL TEST + PRODUCTION TEST E4)。

## 9. Token 与性能

| 项 | 当前值(实测)| 目标 | 差距/建议 |
|---|---|---|---|
| 匿名 21 工具 tools/list | 45,588 B ≈ 11.4k tok(PROD)| ≤48k B(budget guard)| 达标;Claude Code 2KB 描述截断线注意(E16)|
| full 54 工具 | 107,061 B ≈ 26.8k tok(LOCAL)| — | 仅 api_key/?surface=full 显式选择 |
| OAuth 后增量 | buyer 面不变(可见性=21;call-through 不占 list)| — | 达标 |
| 单工具最大 schema | webaz_search 6,658 B(PROD)| < ChatGPT ~5k tok 社区线 | 达标(≈1.7k tok)|
| ProductResults 模型可见 | 1 命中 sc 1,624 B;0 命中(含 recovery)2,975 B;text 178 B(PROD)| ≤3,000 B | 达标 |
| Quote 投影 | 1,253 B(LOCAL 38-assert 套件)| ≤1,400 B | 达标 |
| OrderTimeline 单订单 | ≤2,000 B 锁(LOCAL)| ≤500 tok | 达标 |
| Orders 列表 | ≤2,800 B 锁;up_to_date 增量 <400 B | ≤700 tok | 达标 |
| Widget HTML(host 侧,不进模型)| products 8,658 / quote 6,909 / timeline 6,010 B(PROD)| — | 模板按 URI 缓存(E14)|
| 本地 UI 交互 | 排序/展开/对比零模型调用;widget callTool 直达 server 不经模型(DOC E14)| — | 结果进后续上下文的 token 记账 NOT VERIFIED |
| 无 UI fallback 额外 token | 0(text+sc 本来就是主路径)| — | — |

动态暴露支持面:ChatGPT=手动 Refresh 快照;Claude Code=`list_changed` 自动;claude.ai=断连重连(COMMUNITY);Hermes=Tool Search 渐进披露(我们的 21 工具瘦面直接受益);VS Code=server 重启刷新。**结论:现有 surface bundle(匿名 buyer 21)+ per-tool 预算已经是各宿主缓存/截断行为下的正确姿态,无需新机制。**

## 10. Gap Analysis(按优先级)

- **P0(高价值,低工作量,零业务风险)**
  - G1:标准 MCP Apps 元数据缺失(A1/A2)→ Claude/VS Code/Goose 渲染面全部不可达。
  - G2:widget 桥绑定 `window.openai`,无标准 `ui/*` 桥探测(A5 连带)。
  - G3:`sendFollowupTurn` vs 文档 `sendFollowUpMessage` 命名疑漂移(E18)—— ChatGPT 内"联系商家/报价"回会话按钮可能静默无操作,需实测确认。
- **P1(确认型)**
  - G4:claude.ai 实连验证(OAuth 回调过校验、structuredContent 是否喂模型、PR-A 后渲染)—— 全部 NOT VERIFIED,是 PR-A 的验收内容。
  - G5:VS Code / Goose 实测(安装即测,零代码)。
- **P2(增强型)**
  - G6:structuredContent-盲宿主的文本降级不满足 §八字段清单(§8)→ PR-B。
  - G7:CIMD(Client ID Metadata Documents)未支持;ChatGPT/claude.ai 均偏好但都兼容 DCR → 可缓。
  - G8:initialize 能力协商读取 + clientInfo 遥测(为适配决策收集真实分布)→ PR-C。
- **P3(等待/不做)**
  - G9:OpenClaw/Hermes 专属适配 —— 不做;它们的正确消费面就是工具+文本+深链(DOC 推断,实连 NOT VERIFIED —— 该推断成立与否不改变"不建适配器"的结论,因为无论如何无 UI 面可适配)。
  - G10:MIME 迁移收敛(skybridge → profile=mcp-app 单轨)—— 等 ChatGPT 双轨稳定与 PR-A 实测后再定。

## 11. Minimal Adapter Proposal(仅设计)

**不建 Host Adapter 层。** 三个薄改动,全部 capability-driven:

1. **元数据双发**(server.ts,~30 行):五个 UI 工具 `_meta` 追加 `ui: { resourceUri, visibility: ['model','app'] }`;三个 widget 资源 `_meta` 追加 `ui: { csp: { connectDomains: [], resourceDomains: [] }, domain: 'https://webaz.xyz' }`;资源以标准 MIME `text/html;profile=mcp-app` 提供(新增 URI 或经内容协商,**保留现有 skybridge 资源与 openai/* 键不动**,ChatGPT 回归零风险)。
2. **widget 桥 shim**(ui-widgets.ts 内联 ~40 行/组件共享):`resolveBridge()` 探测顺序 window.openai → 标准 `ui/*` postMessage 桥;暴露 `getOutput/callTool/openLink/sendMessage` 四方法;顺带双探 `sendFollowupTurn|sendFollowUpMessage`(G3)。
3. **协商遥测**(PR-C,可选):记录 initialize 的 clientInfo + extensions 到 mcp_tool_calls 旁表,只读观察。

## 12. Recommended PR Plan

| PR | 范围 | 前置 | 判定依据 |
|---|---|---|---|
| **PR-A:标准 MCP Apps 元数据一致性 + 桥 shim** | §11 的 1+2;验收=ChatGPT 回归(HUMAN VISUAL)+ claude.ai 渲染实测(HUMAN VISUAL)| 无 | G1/G2/G3;审计最高价值 |
| **PR-B:Generic fallback 强化** | summarize* 在预算内补 §八缺口字段(标题/法币/deadline/rail)| PR-A 后(不冲突可并行)| G6;仅当确认目标宿主确实忽略 structuredContent 才做全量,否则只补摘要 |
| **PR-C:能力协商遥测** | initialize extensions + clientInfo 只读记录 | 无 | G8;为 P2/P3 决策供数 |
| **PR-D:CIMD 支持** | oauth-register 增加 client_id=URL 元数据文档路径 | 需求触发 | G7;DCR 已工作,不紧急 |
| ~~PR-E OpenClaw 适配~~ / ~~PR-F Hermes 适配~~ | **不建**(审计结论:无 UI 面可适配;文本+深链是其固有消费形态 — DOC 推断,实连未测)| — | G9 |

## 13. Test Matrix(每 Host 的验证路径)

| Host | 安装/连接 | 账号 | 测试步骤 | 预期 | 实际 | 未验证原因 |
|---|---|---|---|---|---|---|
| ChatGPT | Settings→Apps/Connectors,URL `https://webaz.xyz/mcp` | Holden(已连)| 搜索→报价→审批→订单时间线 | 三组件渲染 | ✅ 渲染(列表模式;单订单点验中);"联系商家"按钮行为待点验(G3)| — |
| claude.ai | Settings→Connectors→Custom,同 URL(OAuth 或匿名)| Holden | 同上;先验文本,PR-A 后复验渲染 | 今天文本;PR-A 后渲染 | 文本 ✅(spike)| 渲染:待 PR-A |
| Claude Desktop | 同 claude.ai(远程连接同源)| 同上 | 同上 | 同上 | NOT VERIFIED | 未单独测(与 web 同源,低增量)|
| Claude Code | `claude mcp add --transport http webaz https://webaz.xyz/mcp` | 本机 | search + buyer_orders 文本链 | 一行摘要可行动 | NOT VERIFIED | 待跑(低风险,只读)|
| VS Code | mcp.json `{"type":"http","url":".../mcp"}` | 本机 | 同上 + Apps 渲染 | PR-A 后渲染 | NOT VERIFIED | 未安装测试 |
| Goose | Remote extension 指向 /mcp | 本机 | 同上 | 工具通;UI 实验性 | NOT VERIFIED | 未安装测试 |
| OpenClaw | `openclaw mcp` 注册 + login | 无 | bridge 调 search;深链发消息通道 | 文本+链接 | NOT VERIFIED | 未安装;非原生 client |
| Hermes | config `auth: oauth` + remote HTTP | 无 | 同上 | 文本+链接 | NOT VERIFIED | 未安装测试 |
| Generic SDK | 本仓 InMemory/Streamable client | fixture | 62+31+23 asserts | 全绿 | ✅ LOCAL TEST | — |

生产测试全部只读(connection_status / 公开 search / manifest / 资源读),符合 §七边界;quote/draft/approval 交互仅在本地 fixture 环境验证。

## 14. Go / No-Go 建议

- **值得现在做跨 Host 适配吗?** —— **值得,但只值得做 PR-A 这一个**:MCP Apps 标准已 Stable 半年、三个大宿主已渲染,我们缺的只是元数据 + 40 行桥 shim;错过等于把 Claude(全 plan GA)/VS Code(20M+ 用户)的渲染面白白让掉。
- **立即适配**:PR-A(标准键双发 + 桥 shim)→ 验收对象 claude.ai(Holden 有账号,HUMAN VISUAL 成本最低)。
- **先保持文字模式**:Claude Code、OpenClaw、Hermes、generic/headless —— 文本+深链已是它们的正确形态,PR-B 视实测再定。
- **等待宿主成熟**:Goose(Apps 实验性)、CIMD(G7)、MIME 单轨收敛(G10)。

---

### 附:本轮停止条件核对(§十二)

仓库审计 ✅ / 生产 manifest 审计 ✅ / 三组件标准字段审计 ✅ / 可实测 Host 实测(生产只读 + 本地 LOCAL TEST;其余如实 NOT VERIFIED)✅ / 兼容矩阵 ✅ / 差距清单 ✅ / 最小适配架构 ✅ / PR 拆分 ✅ / 本文档 ✅。未修改业务代码、未实现适配器、未合并、未部署、未创建真实交易、未宣布未实测宿主"完全兼容"。
