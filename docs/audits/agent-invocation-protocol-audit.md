# WebAZ Agent 商品调用机制审计(Invocation Protocol Audit)

> 日期:2026-07-18 · 基线:main(contract v29,0.1.33)· **只分析,零代码修改**
> 事故样本:「使用 WebAZ 帮我找底部抽纸,推荐一款,并显示商品卡片」(ChatGPT,2026-07-18 13:37)
> 证据等级:**CODE**(仓库实现)· **PROD LEDGER**(生产 demand_signals 台账,已授权只读)· **DOC**(工具描述/文档)· **尚未确认**

---

## 1. 当前真实调用链(逐层还原)

### webaz_discover 链

```
MCP tool webaz_discover(descriptor: server.ts:1913)
→ handleDiscover(server.ts:2972)——纯透传 wrapper,allowlist 转发 category/keywords/max_price/ship_to_region/quantity
→ POST /api/agent/discover(agent-grants.ts:293,scope buyer_discover)
→ 文本形状校验 smells()(≤40字符/拒邮箱/URL/电话形态;agent-grants.ts:303-310)
→ SQL(agent-grants.ts:337-343):
   WHERE status='active' AND stock>=?
     AND LOWER(category) = LOWER(?)          ← category 是【等值】匹配
     AND LOWER(title) LIKE '%kw1%'           ← 每个 keyword 都要命中【标题】子串
     AND LOWER(title) LIKE '%kw2%'           ← 多 keyword 是【AND 合取】
   ORDER BY created_at DESC LIMIT 30
→ 目的地过滤 effectiveSaleRegionsRule → slice(0,10)
→ demand_signals INSERT(无条件落库,含 result_count;agent-grants.ts:356-360)
→ 响应:candidates[] 或 { no_candidates:true, note:'…RFQ/PWA #discover' }
```

**不查 description、不查 alias、不查 external_title、无分词、无 OR、无同义词展开**(CODE)。无独立索引 —— discover 与 search 用同一张 products 表(不存在"索引不同步"问题)。

### webaz_search 链

```
MCP tool webaz_search(descriptor: server.ts:663)
→ handleSearch(server.ts:~2650)→ GET /api/products?mode=agent(products-list.ts:65+)
→ 命中判定 = findProductsByAlias(query)(strict:精确标题/external_title/≥6字符 alias;fuzzy 已退役)
→ 命中 → Model Projection 信封(webaz.product_search.model.v1:products+sellers+next_cursor+result_handle+fx)
→ 0命中且有 query → handleSearch 组装 recovery(server.ts:2717-2733):
   { reason:'strict_no_match', catalog_sample(真实浏览 5 件,标注非匹配),
     next_step: { tool:'webaz_search', arguments:{sort:'newest',limit:5,…}, description:'browse the catalog with filters and NO query' } }
→ 无 query = 浏览模式:全目录翻页(products-list 公开谓词:active+stock>0+卖家未暂停+外链治理+blocklist)
→ 详情:result_handle + selected_ids(≤5)→ /api/products/result-fetch(products-list.ts:422+,活读同源公共谓词)
→ 卡片:CallTool wrapper 发 structuredContent → ChatGPT 渲染 ui://widget/webaz-products.html(读 toolOutput;v1 刻意无图)
```

### 生产台账实锤(PROD LEDGER:demand_signals,本次事故与历史)

| 时间(UTC) | 实际 intent | result_count | 死因(CODE 对照) |
|---|---|---|---|
| 07-18 13:37:11(本次)| `{category:"household", keywords:["底部抽纸","抽纸"], SG, qty 1}` | **0** | `category="household"` 等值匹配中文类目键 `家庭清洁/纸品` → 整个 AND 归零。**keywords 本来都能命中标题** —— 是 category 杀掉的 |
| 07-18 06:41:04 | `{keywords:["底部抽","悬挂式抽纸"]}` | 0 | AND 合取:"悬挂式抽纸"不是标题「悬挂式**底部**抽纸」的连续子串 |
| 07-18 06:38:13 | `{keywords:["抽纸","纸巾"]}` | 0 | AND 合取:同义词扩展被当作合取约束,"纸巾"不在任何标题 |
| 07-17 ×3 | `{keywords:["手机支架"]}` | 0 | 标题不含该词(在售手机支架标题为英文/别名)→ **供给存在却被记录为无供给,demand signal 已被假阴性污染** |

**结论:discover 假阴性 100% 可由代码语义解释,不是索引/同步/分词玄学 —— 是「未发布的类目枚举 + AND 合取 + 仅标题子串」三件套。**

### "无约束目录浏览"的真相(重要,先纠偏)

事故里的全目录扫描**不是 agent 违规,而是 WebAZ 亲自教的**(DOC/CODE 双证):

- `webaz_search` 描述(server.ts:667):0 命中时 "**follow recovery.next_step to browse**";
- recovery.next_step 逐字给出 `{tool:'webaz_search', arguments:{sort:'newest',limit:5}, description:'browse the catalog with filters and NO query'}`(server.ts:2729);
- inputSchema 公开宣传 `limit … up to 200 per page`(server.ts:684)。

Agent 拿到 limit 50/100 的"授权"、拿到"无 query 浏览"的官方指引 —— 它是**遵守了现有契约**。契约本身把 0 命中导向了全目录扫描。这是本审计最核心的双侧结论。

---

## 2. Agent 侧根因(本次调用中属于编排问题的部分)

| # | 错误 | 规则存在吗?在哪? | 为何没被阻止 | 归属 |
|---|---|---|---|---|
| A1 | 没有先结构化意图/没设调用预算(≥6 次调用找 1 件商品)| **规则不存在**(无 skill/无协议文档)| 无从遵守 | 规则缺失 |
| A2 | category 填了 "household" 猜词 | 描述只说 "Listing category key" —— **键表从未发布** | agent 无法查证,只能猜 | **WebAZ 缺陷为主**(枚举不可发现) |
| A3 | keywords 塞同义词组(被 AND 干掉)| 描述说 "matched against listing titles" **没说 AND 合取** | 语义未声明;同义词扩展是 LLM 天性 | 双侧(语义未声明 + agent 未验证) |
| A4 | 0 命中后扩大为全目录浏览,拿无关商品充数 | **相反 —— recovery 明确指引 browse** | WebAZ 引导 | **WebAZ 契约缺陷** |
| A5 | limit 50/100 | schema 宣传 "up to 200" | 合法参数 | WebAZ 契约缺陷 |
| A6 | 拿到 result_handle + ids 却不用 selected_ids 拉详情,反而拿标题重搜 | 描述里有 detail 模式说明,但列表响应**没有** "渲染卡片前先拉详情" 的机器指引(无 detail_required/无 recommended_next_call)| 规则在描述里存在但埋在 1050 字符里;响应体不提醒 | 双侧(引导不足 + agent 未遵守已有说明) |
| A7 | 未做结果相关性检查(把手机支架当候选继续)| 规则不存在 | 无从遵守 | 规则缺失 |
| A8 | 详情未读就渲染"卡片"(缺图/规格/运费)| 规则不存在;v1 卡片本就无图(刻意)| 无从遵守 + 数据面确实缺 | 双侧 |

**判定**:A2/A4/A5 是"规则存在但规则本身错/缺"(服务端可强制修复,不应只改提示词);A6 是"规则已存在但 agent 未遵守"——原因是规则只活在一段 1050 字符的自然语言描述里、响应体不带机器可执行指引;A1/A7 是纯规则真空。

## 3. WebAZ 工具侧根因

1. **discover 假阴性三件套**(见 §1 台账):类目枚举不可发现 + 多词 AND + 仅标题子串。同源同表,无索引问题。
2. **recovery 不完整**:discover 0 命中只回 no_candidates + 自然语言 note(RFQ/PWA)—— **无**原始约束回显、无类目建议、无 recommended_next_call;search 的 recovery 有 next_step 但它指向的是全目录浏览(方向错)。
3. **无约束浏览不但未被拒,还被推荐**(§1);服务端唯一约束是 discover 的 EMPTY_INTENT(至少一个 category/keyword)与文本形状校验。
4. **sort=rating**:`ORDER BY rep_points DESC`(products-list.ts:218)——**不过滤**无评分商品(用户猜想的过滤 bug 不成立),但语义漂移:按【卖家信誉分】排序,不是商品评分,枚举名误导。
5. **result_handle 引导不足**:列表响应含 result_handle 但无 `detail_required_for_card` / `recommended_next_call`;detail 模式错误路径有 next_steps(RESULT_HANDLE_* 三态),正向路径无引导。
6. **demand signal 污染**:假阴性(供给在、检索不到)被如实记为 result_count 0 —— 从供给情报角度,台账已被"检索缺陷"污染("手机支架"×3、"抽纸"×4 全是假信号)。
7. 卡片数据面缺口见 §9。

## 4. 双方调用契约现状(逐条审计 §三)

| 契约项 | 存在? | 位置 | 强制? |
|---|---|---|---|
| 结构化 intent 先行 | ❌ | — | — |
| 意图八分类(精确/SKU/链接/泛需求/浏览/相似/推荐一款/对比)| 部分 | search 描述区分 exact/URL/filters;discover 描述区分 discovery;**推荐一款/对比 无任何定义** | 否 |
| discover vs search 选择条件 | ✅(自然语言)| 两工具 description 互相指路 | 否 |
| 各参数使用时机 | 部分 | inputSchema 字段描述 | 仅类型校验 |
| 禁无约束浏览 | ❌(反向:被推荐)| recovery.next_step | 否 |
| 推荐一款 → limit≤8/detail=1/总调用≤2 | ❌ | — | — |
| result_handle 后必用 selected_ids | 半 | search 描述 + 错误路径 next_steps | 否(正向无引导) |
| 详情前不渲染卡片 | ❌ | — | — |
| 相关性/完整性验证 | ❌ | — | — |
| Agent conformance tests | ❌ | —(现有测试全是服务端行为测试) | — |

**Agent skill:不存在**(仓库无 ChatGPT/Claude 侧 skill 文件;工具描述是唯一的"协议载体")。**System prompt:不存在**(WebAZ 不控制宿主 prompt)。**代码强制:仅** EMPTY_INTENT、文本形状校验、selected_ids≤5、result_handle TTL、search limit clamp。其余全部是自然语言。

## 5. 推荐的 WebAZ Agent Invocation Protocol(设计)

### 5.1 Intent Normalization(§四)

定义 `webaz.commerce_intent.v1`(结构如任务书示例)。判定:

- **Agent 内部持有 + WebAZ 提供词表支撑**:intent 本体留在 agent 侧(强制服务端接收会破坏纯文本宿主兼容、抬高接入门槛,违背 Agent Adoption 主线"降门槛");但 **category/alias 必须由 WebAZ 发布**(新资源 `webaz://guide/categories`:类目键+中英文名+常见别名+每类关键约束),否则 A2 永远复发。
- 不建 intent normalization endpoint(多一跳调用;词表资源已够 agent 自行归一)。
- ship_to 缺失:有默认地址 → 用账户地区并在结果中声明;无 → 追问(§13)。
- 最小可调用集:意图类型 + (product_term|category|外链) 至少一项;推荐类意图必须有 result_count。

### 5.2 工具选择决策树(§五)

```
精确标题 / SKU / 外链粘贴            → webaz_search(strict;外链走 external_link/paste_text)
泛商品词 + 类目可从词表确定           → webaz_discover{ category(词表键), keywords(≤2 个【必现词】,想 OR 就拆两次调用) }
泛商品词 + 类目不明                  → webaz_discover{ keywords:[单个核心词] }(单词,防 AND 陷阱)
已有 result_handle + 候选 id         → webaz_search{ result_handle, selected_ids }(渲染卡片的唯一合法前置)
用户明确要求"逛逛/看看全部"          → webaz_search 浏览模式(sort+limit≤20)
其余情况                            → 禁止无 query 浏览(现 recovery 指引需反转,见 §7-G2)
```

与现代码的偏差:①现 recovery 把 0 命中导向浏览 —— 需反转为导向 discover(带词表建议);②discover 的 AND 语义必须在描述里声明或改语义(§7);③limit 200 宣传必须撤。落点:决策树进 **tool description(压缩版)+ 新资源 `webaz://guide/agent-protocol`(全文)**;红线(无约束浏览/limit)**服务端强制**。

## 6. 服务端 guardrails(§七/§八逐项判定)

| # | Guardrail | 判定 | 兼容性 |
|---|---|---|---|
| G1 | discover:多词 ≥2 时改为「AND 于必现词 + OR 扩展词」或至少在 0 命中响应回显 `matched_semantics:'AND'` + 逐词命中数(`per_keyword_hits`)| **P0** — 三连败全在这 | 加字段,兼容 |
| G2 | search recovery 反转:0 命中 next_step 改为「查词表→discover」;浏览只在用户明确要求时建议 | **P0** | 改 recovery 内容,兼容 |
| G3 | 发布类目词表资源(`webaz://guide/categories`)+ discover 收到未知 category → 400 `UNKNOWN_CATEGORY` + 近似键建议(而非静默 0)| **P0** | 新资源+新错误码,兼容 |
| G4 | limit 治理:schema 撤 200 宣传;无 query 浏览 limit>20 → 400 `UNBOUNDED_CATALOG_BROWSE` + recommended_next_call | **P1** | schema 文案改+新错误码;老 agent 若真传 >20 会破,但生产未见此类合法用例 |
| G5 | 列表响应加 `detail_required_for_card:true` + `recommended_next_call:{tool,arguments:{result_handle,selected_ids}}` | **P1** | 加字段,兼容 |
| G6 | demand signal 防污染:discover 0 命中时先做一次「无 category、单核心词」的宽松复检;宽松复检命中 → 不落 no-supply 信号(改记 `false_negative_suspect`)| **P1** | 落库语义变化,内部表,兼容 |
| G7 | 同会话重复搜同标题 → 提示用 result_handle | P2(需会话态,MCP stateless — 只能靠响应内提示) | 兼容 |
| G8 | `constraint_pass/match_score/matched_by/data_completeness/missing_fields` | P2 — matched_by 已有(外链路径),扩全量需 schema 小版本 | 半兼容 |
| G9 | 推荐类 candidate limit 自动 8 | 服务端不知道"这是推荐"(意图在 agent 侧)→ 只能进协议文档,不强制 | — |
| G10 | rating 语义修正:枚举改名 `seller_reputation` 或描述如实声明;不引入过滤 | P2 | 描述改,兼容 |

## 7. 商品卡片完整性(§九字段逐项)

| 组 | 现状(CODE) |
|---|---|
| 商品 | title/category/stock_status/summary ✅(搜索页);description/specs 仅 detail 投影(≤900B/800B);brand/变体/包装参数(提数/层数)❌ 无结构化字段(埋在标题/描述文本里) |
| 媒体 | **全无**(v1 刻意:widget CSP 空域,图片面已立项延后 —— 见 MCP-TOKEN-AND-UI-OPTIMIZATION §7) |
| 价格 | USDC 主价 + fx(display-only,as_of/stale)✅;运费/税/total 在 **quote 阶段**才有(刻意:搜索页价≠应付价);单位价(每提/每千抽)❌ 无数据基础 |
| 配送 | estimated_days/handling_hours ✅;origin(ship_from)部分;承运方式 ❌ |
| 售后 | return_days/warranty_days ✅;条件/除外/退款条款 → detail 投影 terms ✅ |
| 卖家信任 | sellers map(名称)+ decision_flags(NEW_SELLER/NO_SALES_HISTORY 等)+ sales_count ✅;等级/账龄/信誉分在 flags 里体现但非结构化字段 |
| 操作 | 报价(回会话流)/详情/对比 ✅;收藏/直接下单 ❌(经济动作必经 quote→draft→submit→Passkey,**协议刻意**) |

**建议**:不建 `webaz.product_card.model.v1` 新 schema(会分裂单一真相源),**扩展 product_detail.model.v1** 增补 `media(hash 缩略图端点)`、`unit_price(结构化包装参数存在时)`、`seller_trust{level,account_age_days,rep_points}`;搜索页投影维持轻量。图片依赖已立项的 UI Projection 图片面(CSP resource_domains 决策)。

## 8. 是否需要 webaz_recommend(§十)

**不建,理由**:①"推荐"是主观排序判断 —— 协议侧做推荐 = WebAZ 为推荐结果背书,与「确定性>覆盖面」、「description 低承诺」原则冲突;②两次调用(discover/search → detail)在 G5 的 recommended_next_call 引导下已是确定性两步,token 成本可控;③recommend 输出"推荐理由"必然引入服务端自由文本生成面。**替代**:协议文档定义"推荐一款"的标准两步编排(候选≤8 → detail 1 件),conformance test 锁住。透明度/可调试性上两步方案每步均可审计,优于黑盒单调用。

## 9. 双方责任矩阵(§十一)

- **Agent**:意图理解与结构化;澄清判断(§13);调用预算(推荐类 ≤2 次);工具选择按决策树;keywords 用必现词不用同义词组;相关性验证(候选类目≠意图类目即停);详情后才渲染卡片;推荐理由生成。
- **WebAZ**:发布类目/别名词表;声明匹配语义(AND/子串/仅标题);0 命中给机器可执行 recovery(含逐词命中数);拒绝/收敛无约束浏览;detail 引导字段;结构化详情与卡片数据;demand signal 防假阴性污染;错误码全进 orderErrorLookup 类通道。
- **共同**:协议版本(`webaz://guide/agent-protocol` 带版本号);schema;conformance tests(服务端跑"标准 agent 编排脚本"当集成测试);trace(mcp_tool_calls 已有 tool/latency/bytes,**缺 args 摘要** —— 本次全靠 demand_signals 侧写还原,search 类调用无台账,建议 telemetry 加 args 白名单摘要);向后兼容。

## 10. 需求澄清机制(§十三设计)

### 三态判定(采纳)

`READY_TO_CALL / NEEDS_CLARIFICATION / SAFE_TO_INFER`,判定输入 = intent 完备度 × 类目关键约束表(由 `webaz://guide/categories` 每类目声明 `critical_fields` 与 `safe_defaults`):

- 日用品(纸品/清洁):safe_defaults={品牌不限,推荐一款,candidate≤8};critical={ship_to(无默认地址时)}
- 电子:critical={兼容性/接口,ship_to};尺码类:critical={尺码,对象};高价值(>S$200):critical={预算,用途}
- **判据**:缺失字段的不同取值会改变「类目/可售性/合规/成交可能」→ NEEDS_CLARIFICATION;只改变排序偏好 → SAFE_TO_INFER(调用时声明假设)。

### 追问 UX(采纳任务书原则)

单轮最多 1 个最高价值问题(附具体选项);已提供信息不重复问;SAFE_TO_INFER 时不问,在结果中披露假设("已按:品牌不限、送 SG、推荐 1 款")。

### "先搜索再理解"防线

当前 search 描述的 recovery-browse 指引恰是这个反模式的制度化(§1)——G2 反转后,协议文档明文:**搜索结果不得替代意图确认;模糊需求不得用扩大检索范围解决**。服务端辅助(G3/G4):未知类目 400、无约束浏览 400,使"先扫目录再猜意图"在物理上不经济。

### 服务端支持

词表资源含每类目 critical_fields/safe_defaults/建议澄清问句;`needs_clarification` 形态的响应(任务书 §六示例)**只建议用于 discover 的 UNKNOWN_CATEGORY/EMPTY_INTENT 错误体扩展**,不做成通用状态(服务端不知道用户对话,过度介入会造成机械追问)。

### Conformance 场景(§九测试,采纳全部 6 条)

落点:`scripts/test-agent-invocation-conformance.ts` —— 服务端可测的部分(G1-G6 行为、错误码、recovery 形状、词表资源存在性)+ 协议文档内的 agent 侧场景清单(1 充电器先问接口 / 2 抽纸安全推断 / 3 鞋先问尺码 / 4 约束充分不追问 / 5 无名词先问 / 6 歧义单问)。

## 11. 最小兼容修改方案 + 实施顺序(§十二.11/12)

- **P0(修检索契约,全部向后兼容)**:G1(discover 语义声明+逐词命中数)/ G2(recovery 反转)/ G3(类目词表资源 + UNKNOWN_CATEGORY)/ 工具描述同步(AND 语义、必现词、limit 宣传撤 200)
- **P1**:G4(UNBOUNDED_CATALOG_BROWSE)/ G5(detail_required + recommended_next_call)/ G6(demand signal 防污染)/ `webaz://guide/agent-protocol` 协议资源(决策树+预算+澄清规范)+ conformance suite
- **P2**:G8(match_score/data_completeness)/ G10(rating 改名)/ detail 投影扩 media+seller_trust(依赖图片面决策)/ telemetry args 摘要
- **P3**:观察真实 agent 行为后再议(webaz_recommend 重评、会话级重复检索提示)

## 12. 最终回答(§十二特别要求)

**最合理的解决方式是双方共同建立协议,但修复权重在 WebAZ 侧先行**:本次事故中可归为"agent 乱调"的部分,细看多数是 WebAZ 契约造成的(类目枚举不可发现、AND 语义未声明、recovery 亲自指引全目录浏览、limit 200 官方宣传)——这些**必须服务端修**,改提示词无济于事。纯 agent 侧责任(意图结构化、调用预算、相关性验证、澄清判断)无法由 WebAZ 强制,但 WebAZ 能通过协议资源 + 机器可执行 recovery + 错误码把"正确的路"变成"最省力的路"。规则已存在但未被遵守的仅 A6(detail 模式)一项,其原因也是引导埋没 —— 用 G5 的响应内引导修复,而非指望 agent 读完 1050 字符描述。

### 尚未确认清单

- ChatGPT 侧 webaz_search 各次调用的具体参数(telemetry 无 args;仅 discover 有台账)—— limit 50/100、sort 取值、是否真用过 result_handle 均来自用户观察,代码侧不可复核
- 事故会话中卡片实际渲染所用的数据形态(搜索页投影 vs 曾否触发 detail)
- Hermes/OpenClaw 真实调用行为(二者无实连记录;本审计结论按 DOC 推断适用)

### 证据索引

agent-grants.ts:293-372(discover 全链)· server.ts:1913/2972(discover 描述/透传)· server.ts:663-700(search 描述+schema,limit 200 宣传:684)· server.ts:2717-2733(recovery 组装+browse 指引)· products-list.ts:131-141(公开谓词)/:218(sort=rating=rep_points 不过滤)/:422+(result-fetch)· 生产 demand_signals 7 行(§1 表)· ui-widgets.ts(卡片字段面)
