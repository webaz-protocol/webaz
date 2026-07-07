# RFC-021: order_action_request — 委托代理"申请→人工 Passkey 批准→服务端执行"订单动作 + PII-最小化订单读

**Status**: APPROVED 2026-07-08(§15 决策已定案,见文末)。Phase 2 实现中:PR1 = 两个 SAFE scope + 最小化订单读(本 PR);PR2/PR3 未做。
**Author**: @seasonkoh (drafted with Claude)
**Track**: WebAZ 协议信任层 — agent delegation grant + Passkey human gate + approval 队列。触及订单状态机【触发面】(不改结算数学)。
**Related**: RFC-020(agent delegation grants)· `product_publish_request` 审批基建 · [[project_agent_auth_rfc020]] · [[feedback_human_only_ops]] · [[feedback_opensource_paradigm_comparison]]
**范式归类**: WebAZ 协议信任层(自研);复用现有 `agent_permission_requests` + `/approve` Passkey 基建(I9),非引入开源审批框架。

---

## 0. 前置结论(R1 第一步:orders-action.ts:499 是否共享执行器?)

**否。** `orders-action.ts:499` = `transition(db, id, toStatus, actorId, evidenceIds, notes)` —— 状态机【底层原语】(`engine.ts`),但 accept/ship 的**执行是路由内联组合**,不是可复用函数:

```
POST /api/orders/:id/action  (orders-action.ts:170)
  ├─ auth() 仅 api_key (server.ts:3704 → getUser:3659;gtk_ 在 :3499 被弹)
  ├─ isTrustedRole → 403 TRUSTED_ROLE_NO_TRADE (:173)
  ├─ 归属守卫 uid===sellerId → 403 NOT_ORDER_SELLER (:187)
  ├─ (一堆 early-return 特例:direct_p2p confirm :459 / pq_withdraw :481 / contest_decline / mark_paid …)
  ├─ actionMap[action] → toStatus  (accept→accepted, ship→shipped)  (:441)
  ├─ evidence 创建(evidence_description → detectFraud → INSERT evidence)  (:452)
  ├─ ship 物流绑定 logistics_company_id 存在性检查  (:275-279)
  ├─ result = transition(...)  ← :499  (状态机内部再校验 evidence 非空 engine.ts:107)
  └─ notifyTransition(...)  (:502)
```

→ **抽取 = 中等 blast radius**(非近乎零)。R1 接法:把 accept/ship 的【归属守卫 + 状态前置 + ship 物流绑定 + evidence + transition】组合抽成**窄共享函数** `executeSellerOrderAction`,守卫**内置**,由 api_key 路由与 Passkey approve handler **共调**。**只抽 accept+ship 两个 action**(不动通用尾部其余 action 的行为),把 blast radius 压到最小。

---

## 1. 范围与不可协商约束

**v1 = accept + ship ONLY。**
- **decline 完全排出 v1**:主观 decline 立即 `settleFault`(退款 + 罚没质押,orders-action.ts:331)—— 碰钱路。v1 **连 decline 的 request 提交都不提供**;decline 仅 PWA 人工。放宽走**独立后续 RFC**。
- accept = 纯状态(paid→accepted,不动钱);ship = 纯状态(accepted→shipped,不动钱)。两者都不触结算数学。
- agent 全程**零 api_key**:只能创建 pending request;**永不直接执行**;执行仅在人 Passkey 逐笔批准后由服务端在**人(seller 本人)授权下**跑共享执行函数。

**安全 invariant I1-I10 + 设计定档 D1/D2 见 §11 测试计划逐条映射。**

---

## 2. 数据模型(I9:扩 `agent_permission_requests`,不另起平行系统)

现表 `agent_permission_requests`(webaz-schema-helpers.ts:1691-1707)承载"申请扩展 scope"。**扩它承载 order-action**,复用同一 `/approve`、同一 TTL、同一 Passkey、同一审计。

**新增列(ALTER,均可空,ALTER-AFTER-CREATE 铁律 [[feedback_schema_alter_after_create]]):**

```sql
ALTER TABLE agent_permission_requests ADD COLUMN kind TEXT DEFAULT 'scope_grant';
  -- 'scope_grant'(现有,默认,零迁移)| 'order_action'(本 RFC)
ALTER TABLE agent_permission_requests ADD COLUMN order_id TEXT;          -- kind=order_action 必填
ALTER TABLE agent_permission_requests ADD COLUMN order_action TEXT;      -- 'accept' | 'ship'(v1 仅此二)
ALTER TABLE agent_permission_requests ADD COLUMN params_hash TEXT;       -- SHA-256(canonical(payload)) — I2 绑定键
ALTER TABLE agent_permission_requests ADD COLUMN action_params TEXT;     -- JSON:ship 的 {tracking, evidence_ref};accept 为 '{}' 或 NULL
ALTER TABLE agent_permission_requests ADD COLUMN executed_at TEXT;       -- I5 幂等:执行一次即置位
ALTER TABLE agent_permission_requests ADD COLUMN execution_result TEXT;  -- I7 审计:JSON {ok, from_status, to_status, error?}
```

**部分唯一索引(I5 幂等 + I2 无 blanket):同一 (order_id, order_action) 同时至多一条未终结的 order_action request:**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_order_action_req_active
  ON agent_permission_requests(order_id, order_action)
  WHERE kind='order_action' AND status IN ('pending','approved');
```

**`params_hash` 定义(I2):** `SHA-256(JSON.stringify({order_id, action, tracking:tracking||null, evidence_ref:evidence_ref||null}))`,字段固定顺序(canonical)。accept 的 payload 仅 `{order_id, action:'accept', tracking:null, evidence_ref:null}`。一次批准只授权这个精确三元组;换任何参数 = 新 params_hash = 新 request = 新 Passkey。**禁 blanket。**

**地址绝不入库(I6):** accept 的 request 只需 `order_id`;ship 只需 `tracking`+`evidence_ref`。地址/联系/gift_recipient **天然不进** `order_id`/`order_action`/`params_hash`/`action_params`/`execution_result` 任一列 —— §11 I6 显式断言 + 测试。

---

## 3. 两个 SAFE scope(agent-grant-scopes.ts)

注册进 `SAFE_SCOPES`(:26-40),自动获 `classifyScope`(:82)+ `validateRequestedCapabilities`(:99)覆盖:

```ts
// SAFE_SCOPES 追加:
'order_action_request',        // submit-only:把 {accept|ship} 请求塞进人的审批队列;绝不执行
'seller_orders_read_minimal',  // 最小化订单读(无地址/联系)
```

- `order_action_request`:**submit-only**,不 mount 到任何执行路由;仅 §4 的 request 提交路由消费。`riskLevelForScopes` 归 `'medium'`(对齐 `product_publish_request`,:218,注释"request-only, 仍人 Passkey gate")。
- `seller_orders_read_minimal`:read scope,mount 到 §6 的最小化读路由。
- 可选并入 `catalog_agent` bundle 或新建 `fulfillment_agent` bundle(设计决策,§10 标注)。
- **RISK 档不动**:`order_accept`/`order_ship`/`order_status`/`place_order` 仍在 RISK_SCOPES 硬拒(:46-57)。本 RFC **不下放**任何 RISK scope —— 走的是"safe 的 request-only 旁路 + 人执行",与 RFC-020 §3.1 一致。

---

## 4. request 提交路由(agent,grant-bearer 认证;写 pending,不执行)

复刻 `POST /api/agent-grants/permission-requests`(agent-grants.ts:231-252)的 grant-bearer 认证(`resolveActiveGrantByBearer`:83),新增 order-action 分支:

```
POST /api/agent/orders/:orderId/action-request
  ├─ requireAgentGrantScope('order_action_request')  (复用 agent-grants.ts:97-147 消费门 + 审计 + fail-closed)
  ├─ body: { action ∈ {accept, ship}, tracking?, evidence_ref? }   // ship 必带 tracking+evidence_ref(I4)
  ├─ 只读前置(不执行、不改状态):
  │    · 订单存在 + grant.human_id === order.seller_id(该 agent 的人是本单卖家)
  │    · action 合法性 pre-check(accept 要求 status=paid;ship 要求 status=accepted)—— 仅用于早失败,
  │      真授权/真校验在执行函数内重跑(I1:request 只是提议)
  │    · ship:tracking 非空 + evidence_ref 非空,否则 400 SHIP_TRACKING_REQUIRED(I4 提交侧)
  ├─ params_hash = SHA-256(canonical payload)
  ├─ INSERT agent_permission_requests (kind='order_action', order_id, order_action, params_hash, action_params,
  │      human_id=grant.human_id, grant_id, status='pending', expires_at=now+ORDER_ACTION_REQ_TTL)   // I5 短 TTL,建议 24h
  │      唯一索引撞 → 409 DUPLICATE_ACTION_REQUEST(已有活跃同 (order_id,action) 请求)
  └─ 200 { request_id, approval_url:'/#agent-approvals' }   // 不执行任何状态跃迁
```

**地址永不出现在此路由的 request/response/日志(I6):** 入参只有 action+tracking+evidence_ref;出参只有 request_id。

---

## 5. Passkey `/approve`(人逐笔批;validate 绑三元组;单事务 CAS)

复刻 `POST /api/agent-grants/permission-requests/:id/approve`(agent-grants.ts:281-335)。区别:kind='order_action' 的 approve **不做 grant-union,而是触发执行 landing(§6b)**。

```
POST /api/agent-grants/permission-requests/:id/approve   (同一端点,按 kind 分流)
  ├─ auth()(人类 session)+ 归属(request.human_id===user.id)+ pending + 未过期
  ├─ Passkey 门(对齐 admin fallback 严格绑定模式,agent-grants.ts:290-292 / RFC-021 §此):
  │    requireHumanPresence(user.id, 'order_action_approve', webauthn_token,
  │       'require_human_presence_for_order_action_approve',
  │       validate: d => d != null && typeof d==='object'
  │          && d.request_id === :id
  │          && d.order_id === request.order_id
  │          && d.action === request.order_action
  │          && d.params_hash === request.params_hash)      // I2:绑 (request_id, order_id, action, params_hash);fail-closed 拒 null/错绑
  │    失败 → 412
  ├─ 单事务:
  │    ① CAS status='pending'→'approved'(WHERE status='pending')— 0 行→409 竞态
  │    ② executeSellerOrderAction(...)  ← 执行 landing,§6b(在同一 db.transaction 内)
  │    ③ CAS executed_at=now, execution_result=JSON, status='executed'
  │       (WHERE executed_at IS NULL)— 0 行→已执行,回滚,幂等 I5
  │    任一步 throw → 整体回滚(request 回 pending 可重批;订单未动)
  ├─ (事务外)notifyTransition + 审计写入 agent_grant_auth_log(执行结果,I7)
  └─ 200 { executed:true, order_status:<toStatus> }  或  4xx/5xx(执行 guard 失败,request 保持 pending)
```

**前端 UI(app-agent-approvals.js 已有审批面,复用):** order_action request 卡片显式展示"这是对订单 <order_id> 的 <accept|ship> 操作 + tracking(若 ship)",人 Passkey 逐笔批。**不展示地址**(I6)。

---

## 6a. seller_orders_read_minimal 最小化投影读

新只读路由,挂 reader-guard(scripts/direct-pay-order-reader-guard.ts)+ 复用投影门语义:

```
GET /api/agent/orders            (list)   requireAgentGrantScope('seller_orders_read_minimal')
GET /api/agent/orders/:id        (detail) 同上
  ├─ 认证:grant bearer;grant.human_id === order.seller_id(仅本人卖家的单)
  ├─ 投影 minimalOrderView(o, addressRevealed):仅
  │    { order_id, status, next_actor(currentResponsible engine.ts:264),
  │      deadline(getActiveDeadline engine.ts:265), amount(total_amount), item_ref(product_id),
  │      ship_to_region(结构化地区,非自由文本地址) }
  │    以 MCP get_status(mcp server.ts:3036-3061)为原型,补 amount + item_ref。
  ├─ 地址揭示(D1,§7):addressRevealed=true 时【才】附 shipping_address;否则整体不含。
  └─ 断言:shipping_address / notes / gift_recipient_name / gift_recipient_phone / recipient_code / buyer_name
        绝不进投影(除非 D1 揭示后的 shipping_address)。经 projectDirectPayTargetForViewer(direct-pay-order-redaction.ts:51)
        或平行 minimal 投影 + reader-guard 强制。
```

## 6b. 执行 landing —— `executeSellerOrderAction`(R1 核心,新建共享函数)

**位置**:抽到 `src/pwa/routes/order-action-exec.ts`(或 orders-action 同域),由 orders-action 路由(accept/ship 分支)与 §5 approve handler **共调 —— 单一执行真相源**。

```ts
// 守卫全内置:Passkey 路径绕开 api_key,必须与 api_key 路径【同等设防】,否则即新绕过面(R1)。
export function executeSellerOrderAction(db, opts: {
  orderId: string; action: 'accept' | 'ship'; actorId: string;   // actorId = seller 本人(api_key uid 或 grant.human_id)
  tracking?: string; evidenceRef?: string; logisticsCompanyId?: string;
}): { ok: boolean; fromStatus?: string; toStatus?: string; error?: string; error_code?: string } {
  // ① 订单存在
  // ② 归属守卫:actorId === order.seller_id      (等价 orders-action.ts:187)
  // ③ trusted-role 拦                            (等价 :173)
  // ④ 状态前置:accept 要求 status='paid';ship 要求 status='accepted'（否则 WRONG_STATUS）
  // ⑤ ship:logistics_company_id 存在性(若传);tracking 内容重校验(I4,§见下)+ evidence 落库
  //    accept:无 evidence 要求
  // ⑥ result = transition(db, orderId, action==='accept'?'accepted':'shipped', actorId, evidenceIds, notes)
  //    （transition 内部再校验 ship evidence 非空 engine.ts:107）
  // ⑦ 绝不 UPDATE accept_deadline / ship_deadline（I3）
  // return {ok, fromStatus, toStatus} | {ok:false, error, error_code}
}
```

**调用方改造:**
- orders-action.ts:accept/ship 分支改为 `executeSellerOrderAction(db, {orderId, action, actorId:user.id, ...})`(api_key 路径);其余 action 保持通用尾部不动(窄抽取)。
- §5 approve handler:`executeSellerOrderAction(db, {orderId:request.order_id, action:request.order_action, actorId:request.human_id, tracking, evidenceRef})`。
- **I1 不可达保证**:`executeSellerOrderAction` 只被这两处 import;**任何 agent-bearer 路径不 import 它**;agent 持有的 token 仅能命中 §4 request 提交(写 pending)。负向 grep 守卫锁死(§11 I1 测试)。

**失败/回滚语义**:执行在 approve 的单事务内;transition 失败 → throw → 回滚 → request 回 pending(可重批)、订单零变化、executed_at 不置位。notify 在事务外(失败不回滚已成功的状态跃迁)。

---

## 7. 地址揭示策略 `address_reveal_policy`(D1)

配置项 `address_reveal_policy ∈ { after_accept(默认), never }`(建议 per-seller 设置,存 users 或 seller settings;RFC 标为设计决策 §10)。

- **after_accept(默认)**:accept **获批前**,§6a 投影不含 `shipping_address`;accept **获批后**(order.status 已 accepted,由 approve 执行推进),投影揭示 `shipping_address` 供 agent 备 PDD 采购。**揭示点绑定"order.status ∈ 已 accept 之后的状态"**,不是 request/approval 时刻。
- **never**:PDD 采购全程由人执行,`shipping_address` 对 agent **永不揭示**;agent 投影任何阶段都无地址。
- 揭示判定放进 §6a 投影函数:`addressRevealed = (policy==='after_accept') && orderPastAccept(order.status)`。

---

## 8. SLA 文案(全 RFC 统一,勿再偏离)

- `accept_deadline` = **订单创建时** `now + 48h`(index.ts:45-50;注释"付款后 24h 内接单"编码为创建时绝对偏移)。
- `ship_deadline` = **订单创建时** `now + 120h`(注释"接单后 72h 内发货"编码为绝对偏移)。
- **两列均绝对、创建时定、无任何路径重写**(engine.ts:531 只读存储列;transitions.ts:181/197)。`checkTimeouts` 读存储列判超时。
- **request/approve/execute 任何一步都不得 UPDATE 这两列**(I3)。

## 9. I3 测试规格

断言:走完 request→approve→execute(accept 与 ship)全程,`orders.accept_deadline` 与 `orders.ship_deadline` 两列**值不变**(前后快照相等)。负向:全仓 grep 新增代码无 `UPDATE ... accept_deadline` / `ship_deadline`。

## 10. I4:ship tracking 重校验

- **提交侧(§4)**:ship 的 request 必须带 `tracking` 非空 + `evidence_ref` 非空,否则 400。
- **执行侧(§6b)**:`executeSellerOrderAction` 对 ship **重校验 tracking 内容**(非仅 evidence 非空)。**现状:执行只校验 evidence 非空(engine.ts:107-115),tracking 内容不校验、可选** → 本 RFC **新增 tracking 内容校验**(格式/非占位/长度下限)。**⚠️ 这会触及 ship 执行逻辑** —— 放进 `executeSellerOrderAction`,PR3(钱路相邻 PR)内做,单独测试。校验规则细节(什么算合法 tracking)= 设计决策,PR3 前定。

## 11. I5:显式幂等键

- **提交侧**:唯一索引 `ux_order_action_req_active` 防同 (order_id,action) 并发双 pending。
- **执行侧**:`executed_at` 列 + CAS `WHERE executed_at IS NULL`(§5 ③)——批准后**恰执行一次**;重放/竞态双执行被 0-行 CAS 挡。
- **叠加自然幂等**:transition 状态守卫(paid→accepted 仅从 paid 有效)= 第二重。
- 幂等键 = request_id(一 request 一执行);同订单同 action 再提交 = 新 request(经唯一索引/人重新批)。

## 12. 迁移 / 回滚

- 迁移:§2 的 6 个 ALTER(可空,默认 kind='scope_grant')+ 1 部分唯一索引 —— **零现存数据影响**(旧行 kind 默认 scope_grant,行为不变)。写进 `initAgentPermissionRequestsSchema`(webaz-schema-helpers.ts:1689),fresh-DB bridge 自动获得。
- 回滚:两个 SAFE scope 从 SAFE_SCOPES 移除即禁新 grant 携带;已发 grant 的该 scope 消费门返回 SCOPE_NOT_GRANTED;request 提交路由可 feature-flag 关。列保留(可空,无害)。

---

## 13. 测试计划(I1-I10 + D1/D2 逐条)

| Inv | 断言 | PR |
|---|---|---|
| **I1** submit≠execute | ①agent bearer 调 §4 只写 pending、订单零变化;②`executeSellerOrderAction` 仅被 route+approve import(负向 grep);③任何 gtk_ 路径不可达执行函数 | PR2/PR3 |
| **I2** 绑三元组无 blanket | 错 order_id/错 action/错 params_hash 的 Passkey token → 412、不执行;一次批准不授权第二个 (order_id,action,hash) | PR2 |
| **I3** SLA 不被重置 | request→approve→execute 全程 accept_deadline/ship_deadline 值不变;负向 grep 无 UPDATE 两列 | PR3 |
| **I4** ship tracking+evidence 重校验 | 提交无 tracking→400;执行侧无效/占位 tracking→拒;evidence 非空仍强制 | PR3 |
| **I5** TTL+幂等防重放 | 过 TTL 的 request 不可批;approve 后重放/并发双 approve → 恰一次执行、executed_at CAS 挡第二次 | PR2/PR3 |
| **I6** PII 不入 request/audit | request params/response/execution_result/agent_grant_auth_log 均无 address/联系/gift_recipient;§6a 投影 pre-reveal 无地址 | PR1/PR2 |
| **I7** 全链路审计 | 谁请求(grant_id)、参数(params_hash)、TTL(expires_at)、谁批(Passkey assertion)、执行结果(execution_result)可追溯;fail-closed | PR2/PR3 |
| **I8** 不碰钱/结算/auth 核心 | v1 无 decline(不碰 settleFault);执行只调 transition(状态跃迁),无 settle*;auth 核心 getUser 不改 | 全程 |
| **I9** 复用不另起 | 同 agent_permission_requests 表、同 /approve、同 TTL、同 Passkey、同 agent_grant_auth_log;无平行审批表 | PR2 |
| **I10** 无 auto-accept/根 key | 无自动执行路径;agent 无常驻执行权;仅人 Passkey 逐笔 | 全程 |
| **D1** address_reveal_policy | after_accept:accept 批准前投影无地址、批准后有;never:任何阶段无地址 | PR1(投影)/PR2(揭示点) |
| **D2** decline 排除 v1 | §4 拒 action='decline'(400 DECLINE_NOT_DELEGATED);agent 无 decline 提交路径 | PR2 |

---

## 14. Phase 2 拆 PR 计划(仅描述,不建 PR;每 PR 附 I1-I10/D1/D2 自检)

- **PR1 = 两个 SAFE scope + 最小化投影读**(纯 SAFE,无执行,**低风险**)。
  - 内容:SAFE_SCOPES 加两 scope;`GET /api/agent/orders(/:id)` minimal 投影(挂 reader-guard);地址剥离断言。
  - 不碰:队列、执行、Passkey。自检:I6/D1(投影侧)/I8/I9/I10 ✅;I1-I5/I7 N/A(无执行面)。
- **PR2 = 队列扩列 + request 提交 + Passkey /approve(到 approved/executed 前的编排,不含执行函数抽取)**。
  - 内容:§2 迁移;§4 request 提交路由;§5 approve handler(Passkey 绑三元组 + CAS);审计;TTL;D2 拒 decline。
  - **执行调用**先桩成"调 executeSellerOrderAction"(PR3 提供),或 PR2 只到 approved、PR3 接执行 —— 二选一(设计决策,建议 PR2 到 approved 为止、execute 在 PR3,避免 PR2 提前碰执行)。
  - 自检:I2/I5(提交侧)/I6/I7/I9/D2 ✅。
- **PR3 = 执行 landing(抽 `executeSellerOrderAction` + 守卫内置 + 幂等 CAS + I4 tracking 重校)** —— **钱路相邻(动订单状态机触发面),单独 PR,用户盯**。
  - 内容:§6b 抽取(orders-action accept/ship 改调共享函数,窄抽取);approve 接执行;I3/I4/I5 执行侧;I1 不可达负向 grep。
  - **⚠️ blast radius**:改 orders-action.ts accept/ship 路径 + 新增 tracking 校验;必须 browser smoke(真实卖家 accept/ship)+ 全订单动作回归。
  - 自检:I1/I3/I4/I5(执行侧)/I8 ✅。

---

## 15. 设计决策(等用户在批 RFC 时一并定)
1. **bundle 归属**:两 scope 并入现有 `catalog_agent` 还是新建 `fulfillment_agent` bundle?
2. **address_reveal_policy 存储位置**:users 列 / seller settings / 协议参数?默认 after_accept。
3. **ship tracking 合法性规则**(I4):什么算有效 tracking(长度/格式/非占位)?
4. **PR2/PR3 边界**:PR2 只到 approved(execute 全在 PR3),还是 PR2 含 execute 桩?建议前者。
5. **`order_action` v1 是否只 accept+ship**,ship 是否 v1 就含 tracking 重校验(I4 触执行)还是 accept 先行、ship 次之拆更细?

## 16. §15 决策定案(2026-07-08 用户批,PR1-3 全程遵守)
1. **新建 `fulfillment_agent` bundle** 承载两 scope,**不并入 catalog_agent**(独立授予/撤销/TTL)。
2. `address_reveal_policy` 存 **seller settings**(卖家级),默认 `after_accept`。
3. **ship tracking 判定(PR3 用)**:非空 + trim 后长度 ≥8 + `^[A-Za-z0-9-]+$` + 占位符黑名单(`N/A`、`无`、`test`、全 0、纯重复字符);从严,宁可误拒。
4. **PR2 只到 approved,execute 全在 PR3**(硬边界)。
5. **ship I4 tracking 重校随 ship execute 一起在 PR3**,不再拆。

**RFC 已批准。Phase 2 实现中。**
