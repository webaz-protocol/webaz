> **Code is Rule, Protocol is Trust.**
> **代码即规则，协议即信任。**
> — webaz

# WebAZ Agent 治理规范 · v1.0

> **建立日期**：2026-05-23
> **状态**：v1.0（初版 · 部分条目"已实现" / 部分"声明但未执行" / 部分"roadmap"）
> **覆盖**：buyer / seller / verifier / arbitrator / promoter / charity-fulfiller / admin 七角色
> **目的**：让外部 agent 能合规、安全、友好地接入 WebAZ；同时把恶意 agent 挡在门外

---

## 1. 定义

**Agent** = 任何通过 MCP 工具 (32 个 `webaz_*`) 或 HTTP API 替真实自然人执行操作的程序。

不算 agent：
- 用户自己在 PWA Web 端的交互
- WebAZ 协议内部的 cron / watcher

所有 agent 都对应一个 `api_key`，而 api_key 必然挂在一个 `users` 行下。用户对自己 api_key 下的 agent 行为负主要责任。**但协议保留"恶意 agent 一票否决"的兜底权**（见 §9）。

---

## 2. Agent 身份与声明

### 2.1 自声明（required for trust > new）

任何想升 trust 等级（trusted/quality/legend）的 agent，必须在 `agent_declarations` 表登记：

| 字段 | 说明 | 强制 |
|---|---|---|
| `operator_name` | 运营方 / 公司 / 个人开发者 | ✅ |
| `operator_contact` | email / handle / DID | ✅ |
| `purpose` | 一句话用途（≤200 字）| ✅ |
| `declared_scope` | JSON：`{roles: ['buyer'], actions: ['search','place_order'], regions: ['*']}` | ✅ |
| `attestations` | JSON：`{no_pii_export: true, gdpr_compliant: true, kids_safe: false, ...}` | ⚠ 弱审计 |
| `repo_url` | 源代码 / 文档（提高信任）| ❌ |
| `homepage` | 落地页 | ❌ |

**实现**：✅ `agent_declarations` 表（commit X）
**注意**：声明是自报，verify 留给社区 + 用户 + 实际行为审计。第三方声明 GDPR 合规但实际 PII 泄漏 → §9 strike。

### 2.2 用户授权（bilateral attestation · roadmap）

第一次 agent 替用户做"敏感动作"（place_order > $50 / 撤销其他 agent / 发布笔记等）前，**用户必须主动 approve agent 的 declared_scope**。

```
agent 声明：「我会帮你买 ≤$50 的咖啡 / 不会下大单」
用户 PWA 上看到：「Agent ABC 想要 [scope_a, scope_b]，授权？」
用户点击 approve → 写入 agent_attestations(api_key, user_id, approved_scope, granted_at)
```

**实现**：roadmap（P6 commit）

---

## 3. Trust 阶梯 × 能力矩阵

基于现有 `agent_reputation.level`：

**trust_score 评分公式**（见 `computeAgentTrust` · server.ts:3056）：
```
raw = agePts (≤45) + orderPts (≤25) + sharePts (≤20) + diversityPts (≤10)
       - disputeLoss·10 - max(0,sybilSize-3)·5 - crossHits·3 - ratelimitHits·2
trust_score = max(0, round(raw, 2))   # 实际范围 0–100
```

**等级阈值**（与代码 server.ts:3105 一致）：

| 等级 | trust_score | 协议 rate cap (per min · 当前 protocol_param 默认值) | 可做 | 不可做 |
|---|---|---|---|---|
| **new** | < 20 | 120 | search / view / get_status / leaderboard | place_order / list_product / vote / arbitrate |
| **trusted** | ≥ 20 | 300 | + place_order (≤user-approved cap) / list_product / charity.donate | + vote (verifier) / arbitrate |
| **quality** | ≥ 50 | 600 | + 批量操作 / claim_verify (人工辅助) / auto_bid skill | arbitrate（永远人工）|
| **legend** | ≥ 80 | 1200 | 全 32 MCP tools | 仍受 §4 铁律节点限制 |

**实现**：trust_score 公式 ✅；level 字段 ✅；分档 rate limit 中间件 ✅（2026-05-23 P4 ship）

---

## 4. 铁律节点：必须真实人工，agent 不可代操作

> **第一原理**：协议信任骨架的下限。如果这些节点被 agent 自动化，整套去中心化共识就崩了。

| 节点 | 为什么人工 | 当前防御 | 升级 |
|---|---|---|---|
| **Verifier 投票** (`/api/claim-tasks/:id/vote`) | agent 可被脚本批量投票 → 共识被算法操纵 | `isTrustedRole` 隔离交易 / Verifier 资格门槛 | ✅ **要求最近 10min 内有 WebAuthn / passkey 验证** |
| **Arbitrator 仲裁** (`/api/disputes/:id/ruling`) | agent 仲裁等于无仲裁 | 同上 | ✅ **同上 + KYC 双维度** |
| **大额提现** (≥ 1000 WAZ) | 防 api_key 泄漏后被洗劫 | WebAuthn 二次确认（已有）| ✅ 已实现 |
| **KYC 提交** | 身份证 + 个人信息 | manual review | ✅ 不允许 agent 调用 KYC 端点 |
| **撤销其他 agent** | 防 agent 互殴 | — | ✅ 仅人工操作 |
| **修改协议参数** (admin) | root admin 治理 | `requireRootAdmin` ✅ | + WebAuthn |

**实现**：列出 endpoints 加 `requireHumanPresence` middleware（P3 commit）

---

## 5. 各角色 agent 规则

### 5.1 Buyer agent
**最常见 use case**：「帮我找最划算的咖啡 → 比价 → 在 $50 预算内下单」

允许：
- `webaz_search` / `webaz_verify_price` / `webaz_place_order` (需 user-approved budget cap)
- `webaz_get_status` / `webaz_update_order(action=confirm)` — 收货后确认
- `webaz_charity` 捐赠 / `webaz_share_link` 分享商品
- 多语言 i18n 商品检索（S3 已支持）

不允许：
- 越过 user-approved budget cap
- 自动 `confirm` 没收到的货 → 防 agent 替买家放弃维权
- 自动 `dispute` 没触发的争议

UX 友好：
- 每次 place_order 后立刻 push 通知给真人买家（已有 SSE）
- /api/me/agents 列出本周 agent 替我做的事（P5）

### 5.2 Seller agent
**use case**：「自动接单 / 上架 / 库存预警」

允许：
- `webaz_list_product` 上架 / 改价 / 库存调整（S2/S3/S4 已支持）
- `webaz_update_order(action=accept|ship)` 接单发货（受 1h 上架 5 单限频保护）
- `webaz_auto_bid` skill 自动报 RFQ
- `webaz_skill` 发布 Skill

不允许：
- 价格欺诈：自动改价绕过 price-lock token（已有防御）
- 虚假发货：必须填 tracking number（HMAC 签名）
- 与平台代币对赌：协议级 staking 在卖家上架时自动扣留（已有）

UX 友好：
- `/api/admin/payment-methods` 由 root admin 配置，卖家无需关心
- 商家页面集成 W7 ticket 系统接收买家反馈

### 5.3 Verifier agent — **铁律：投票必须人工**
**use case**：agent 只能 **辅助** verifier（如：自动列出可投票任务、prefetch 证据），**不能投票**

允许：
- `webaz_claim_verify(action=available|view)` — 看任务 / 看证据
- `webaz_claim_verify(action=eligibility|verifier_status)` — 查资格 / quota

不允许：
- `webaz_claim_verify(action=vote)` — **必须人工 + 最近 10min WebAuthn**
- 自动 abstain — 用 abstain 逃避命中率影响也不行

### 5.4 Arbitrator agent — **铁律：判决必须人工**
**use case**：agent 可 **辅助** 仲裁员（列出相似案例 — A2 已实现），**不能裁决**

允许：
- `webaz_dispute(action=view|list_open|add_evidence)` — 看 / 取证
- 查相似判例（A2 已 ship）

不允许：
- `webaz_dispute(action=arbitrate)` — **必须人工 + 最近 10min WebAuthn + KYC 双维度**

### 5.5 Promoter agent
**use case**：「自动转发笔记 / 邀请新用户 / 收佣金」

允许：
- `webaz_share_link` 生成链接 / `webaz_shareables` 转发笔记
- `webaz_referral` 查推荐关系

不允许：
- 自动 mass-invite 真实手机号 / 邮箱（COP 禁 spam）
- 自动 fake-buy 刷分润（已有反 Sybil + KYC 双维度防御）

### 5.6 Charity-fulfiller agent
**use case**：「自动响应慈善许愿池 / 捐赠基金」

允许：
- `webaz_charity(action=list|detail|claim|proof|donate)`

不允许：
- 自动 `confirm` 还没真实交付的圆梦（许愿人确认是人工）
- mass-claim 不打算履约的愿望 → 触发 30 天封锁 + strike

### 5.7 Admin — 不是 agent 用例
管理员账号严禁挂 agent。
- 协议参数变更 / KYC 审核 / 仲裁 / 退款裁决 都需 human + WebAuthn
- root admin 全权操作 → §4 铁律

---

## 6. 用户控制

### 6.1 透明度
- `GET /api/me/agents` — 列出本账号 api_key 下所有 agent 调用记录（聚合：endpoint + count + last_seen）— **P5**
- `GET /api/me/agents/:apiKey/log` — 单个 agent 的完整调用历史（30d）— **P5**
- 每个 agent 操作的订单 / 笔记 / 评论 → 元数据带 `acted_by_agent: <api_key>` 标记 — **roadmap**

### 6.2 撤销
- `POST /api/me/agents/:apiKey/revoke` — 撤销单个 agent — **P5**
- `POST /api/operators/:operator_name/revoke` — 撤销同 operator 所有 agent（如发现 ABC operator 集体作恶）— **P5**
- 撤销 = api_key 标记 `revoked_at`，后续所有调用 403
- 撤销操作本身 = 铁律节点（人工 + WebAuthn · §4）

### 6.3 范围调整
- bilateral attestation 流程允许用户事后**收紧** approved_scope（不能扩，扩需重新 approve）

---

## 7. 反滥用 / 安全

### 7.1 Rate Limits（按 trust level 分档）— ✅ P4 已实现
默认值（DAO 治理可调）：

| level | per-minute |
|---|---|
| new | 120 |
| trusted | 300 |
| quality | 600 |
| legend | 1200 |

实际值由 `protocol_params.agent_rate_<level>_per_min` 控制 — 透明 + 可治理。

超限：响应 429 `error_code: AGENT_RATE_LIMITED` + 调用计入 `agent_call_log.status_code=429`（trust_score 扣分）

> **设计说明**：默认偏宽松，因为人类浏览 PWA 也走 /api/*。真正的安全靠 strike 系统（§7.2）+ 撤销机制（§6.2），不是死压速率。

### 7.2 3-Strike 状态机 — P4
| strike | 触发 | 后果 |
|---|---|---|
| 1 | 单个有效投诉 / 单次违规（如卖家拒发货 / 假声明）| Warning + 24h 限流减半 |
| 2 | 7 天内第 2 strike | 7 天暂停所有写操作 |
| 3 | 30 天内累计 3 strike | api_key 永久 revoke + operator 进观察名单 |

申诉：`POST /api/me/agents/:apiKey/appeal` — 30 天内可申诉，root admin 审核

### 7.3 KYC 阶梯（已有）
- 单笔提现 ≥1000 WAZ → 强制 KYC（`kyc_required_withdraw_waz` 协议参数）
- 24h 累计提现 ≥3000 WAZ → 强制 KYC（防 smurf 分拆）

### 7.4 Geo-fencing
- Agent 继承用户 region 限制（如某些地区禁 PV 匹配奖励 → agent 也禁）
- 跨境订单走 B1 关税提示

### 7.5 PII 边界
- Agent 看到的内容 ≤ 真人用户看到的内容（无权限提升）
- B2 隐私购物：anonymous_recipient → agent 看到 PR-XXXXX 代号，不知真名

---

## 8. 标准与版本

### 8.1 MCP 协议
- 当前 32 个 `webaz_*` tools，schema 见 `src/layer1-agent/L1-1-mcp-server/server.ts`
- 任何破坏性变更 → 主版本号 + 90 天废弃期 + 公告

### 8.2 Schema 版本兼容
- 新增字段 → 向后兼容（不强制）
- 删除字段 / 改语义 → 90 天废弃期
- enum 扩展（如 `vote` 加 `abstain`）→ 立即生效，旧值保留

### 8.3 OpenAPI 公开
- `/api/openapi.json` 公开 OpenAPI schema — ✅
- 持续同步代码与 spec

---

## 9. 恶意响应链

```
用户 / 自动检测举报
  ↓
入 audit log + agent_strikes 表
  ↓ (1 strike)
警告 + 限流减半（24h 自动恢复）
  ↓ (2 strike in 7d)
暂停 7 天 + 真人复核排队
  ↓ (3 strike in 30d)
api_key 永久 revoke + operator 进观察名单
  ↓
30 天申诉窗口 / root admin 审核
```

平行：
- **DAO 提议**：社区可发起 `agent_policy` 类提议，调整 strike 阈值 / 新增禁区动作（roadmap P7 + DAO Phase B）

---

## 10. 第三方开发者入口

### 10.1 SDK template — P7
- `@webaz/agent-sdk` (npm) — TS template
- 含：MCP client / api_key 管理 / declaration 模板 / 自动重试 / rate-limit 自适应

### 10.2 上手 5 步
1. 注册 buyer / seller / promoter 用户拿 api_key
2. 调 `POST /api/agents/declarations` 提交声明
3. 用户在 PWA approve scope（bilateral attestation）
4. 调 32 个 MCP tool 之一
5. 持续监控 `agent_reputation` + `agent_strikes`

### 10.3 兼容性承诺
- 任何 schema 变更走 §8.2
- Anchor / handle / 协议参数变更走 governance log（已有）

### 10.4 文档资源
- `/api/openapi.json` — 完整 schema
- `MCP_TOOL_PARAMS.md` — 工具速查（计划）
- 本文档 — agent 治理总章

---

## 11. Roadmap & 当前实现状态

| 项 | 实现状态 | 引用 |
|---|---|---|
| 32 MCP tools | ✅ | server.ts L1-1 |
| `agent_reputation` 表 + trust_score | ✅ | server.ts:2539 |
| `agent_call_log` + 30d TTL | ✅ | server.ts:2525 |
| `isTrustedRole` 角色隔离 | ✅ | server.ts:3767 |
| WebAuthn 大额提现门槛 | ✅ | server.ts:2584+ |
| `agent_declarations` 表 | 🚧 P2 | 待实现 |
| `agent_attestations` (bilateral) 表 | 🚧 P6 | 待实现 |
| `agent_strikes` 状态机 | 🚧 P4 | 待实现 |
| `agent_revocations` operator-level | 🚧 P5 | 待实现 |
| 人工铁律节点（verifier/arbitrator） | 🚧 P3 | **关键安全升级** |
| 分档 rate limit | 🚧 P4 | 当前是全局 |
| `/api/me/agents` 用户审计端点 | 🚧 P5 | 待实现 |
| Bilateral attestation UI | 🚧 P6 | 待实现 |
| `@webaz/agent-sdk` template | 🚧 P7 | 待实现 |
| DAO agent_policy 提议类型 | 🚧 P7 + DAO Phase B | 待 DAO B 启动 |

---

## 12. 召唤入口（下次接力）

下次接力时按顺序读：
1. 本文（agent 治理总章）
4. `MEMORY.md` 索引（含 `feedback_human_only_ops.md` — 关键安全约束）

---

## 13. 历史变更

- **2026-05-23 v1.0** — 初版
- **2026-05-30 v1.1** — Phase 1-4 + 3a/3b/3c/3d 全上线(见下方追加章节)

---

## 14. 2026-05-30 v1.1 追加 — Agent 护照 + 准入硬闸 + 公开诚实化

> 本节是对 v1.0 的增量,**已全部上线 prod**。

### 14.1 Agent 护照(Phase 1-4)

每个 api_key 现在都有 5 指标透明化(`computeAgentPassport`,src/layer1-agent/L1-2-identity/):

| 指标 | 含义 | 计算 |
|---|---|---|
| `risk_score` (0-100) | 综合风险 | 429 衰减(30d 半衰期,cap 40) + error rate(cap 15) + dispute_loss(cap 25) + sybil_excess(cap 20) |
| `engagement_depth` | 参与深度 | shallow / medium / deep / profound(按 30d 调用数 + 治理参与) |
| `behavior_profile` | 行为画像 | {query, transact, govern} 三维比例(基于 30d agent_call_log) |
| `custodian_fingerprint` | 监护人指纹 | `HMAC(MASTER_SEED, "custodian:" + owner_id).slice(0,16)`,可追溯不暴露身份 |
| `has_passkey` | 真人态(Phase 2) | webauthn_credentials 计数,绑了即真人 |

**展示**:
- `GET /api/me/agents` — 列出本账号所有 api_key + 各自护照 + custodian 总览
- `#my-agents` PWA 页:每个 agent 卡片显示风险/参与/行为/指纹 + 顶部"监护人总览"卡(已绑 Passkey · 真人监护人 / 旗下聚合 max_risk / high_risk_count 连带提示)

**护照可签名导出(Phase 4)**:
- `GET /api/me/agents/:apiKeyPrefix/passport` — owner 自取自己 agent 的凭证
- 协议签发(issuer)私钥经 `WalletSigner` seam(`internal/wallet-signer.ts` 的 issuer 角色，当前与热钱包同一把 key,Phase 0.5 拟分离)eip191 签 canonical 串
- 返回 `WebAZAgentPassport`: { type, issuer (did:webaz:0x...), issued_at, expires_at (7d), subject, claims, canonical, signature, verify }
- **任何协议方可独立 ecrecover 验真**:`verifyMessage(issuer_address, canonical, signature)`,改 1 bit 即失效
- 信任锚发布:`/.well-known/webaz-protocol.json` 的 `issuers.agent_passport[]`(支持轮换历史)

### 14.2 准入硬闸(Phase 3a-3d)

**Phase 3a 注册限频**:同 IP 5/小时 → 429。`registration_audit_log(user_id, ip_hash, created_at)` 记账。

**Phase 3b 声明者读约束**:
- `endpointToReadAction(path)` 映射敏感读 → scope token:
  - `/api/nearby` / `/api/search*` → `'search'`
  - `/api/users/:id/*` → `'profile'`(防跨用户画像剽窃)
- **只对有声明的 agent 生效**;真人 / 无声明者不受影响
- 有声明且非通配 `'*'` → 读写都按 `declared_scope.actions` 约束

**Phase 3c 风险写硬闸**:
- `agentRiskCache` 5min TTL,存 {risk, hasPasskey}
- risk ≥ 100 → 403 `AGENT_RISK_SUSPENDED`(可申诉)
- risk ≥ 70 → 429 `AGENT_RISK_THROTTLED`(Retry-After 30s)
- 只对 `endpointToAction` 映射的敏感写动作,读/低风险零影响

**Phase 3d D1b 注册需邀请**:
- `require_human_presence_for_delete_passkey` 默认 1(全球统一,**已取消 china 豁免**)
- 无 sponsor + 非已知角色 → 403 `INVITE_REQUIRED`
- 一次性 migration `migration_d1b_require_ref` 把存量 0→1,marker 防重翻

**Phase 3d D2b 无声明=只读(Passkey 真人豁免)**:
- 映射写动作 + 无声明 + 无 Passkey → 403 `AGENT_SCOPE_UNDECLARED`
- **绑 Passkey 的真人完全豁免**(D2b 模型核心)
- 声明 / 绑钥 / 申诉端点不在写映射表 → 天然豁免,无鸡生蛋

**Passkey 绑/解绑后 risk cache 立即失效**(`invalidateAgentRiskCacheForUser`)— 修了 5min stale 让刚绑钥真人继续被拦的潜在 UX bug。

### 14.3 delete_passkey iron-rule

`DELETE /api/webauthn/credentials/:id` 现在也需要 `webauthn_token`:
- 走标准 `requireHumanPresence('delete_passkey', token, 'require_human_presence_for_delete_passkey')`
- validate 强校 `purpose_data.credential_id === :id`(防"为删 A 拿的 token 被复用去删 B")
- 默认 1(可在 admin 后台关:`require_human_presence_for_delete_passkey=0` 提供紧急逃生口)
- 堵"失窃 Passkey 第一步删它断恢复路径"的逻辑漏洞

### 14.4 公开面诚实化(回应外部尽调 agent)

- `/.well-known/webaz-protocol.json` + `/api/protocol-status` 公开 manifest:
  - `network_state`: phase=launched、real_users_on_canonical(实时查 webauthn_credentials 数)、canonical_endpoint、economic_flow、disclaimer(zh+en)
  - `issuers.agent_passport[]`: 信任锚地址数组(支持轮换)
  - `roadmap`: 已完成 / 已知未做 / 故意延后 + "we do not commit to deadlines, only to honesty"
- webaz.xyz 首页 + welcome 顶部展示已发布的支付轨状态:Direct Pay 真实可用,escrow 仍为模拟
- MCP 工具描述诚实化:`webaz_info` 加 network_state + MLM 形态披露;`webaz_skill` 明确 NOT executable code;`webaz_register/share_link/referral` 加"AI agent 须显式同意才能拉新"

### 14.5 新协议参数

- `require_human_presence_for_delete_passkey` 默认 1
- `migration_d1b_require_ref` 一次性 migration 标记
- 现有 `require_human_presence_for_vote / arbitrate / agent_revoke` 默认仍 1

### 14.6 待续(进 backlog)

- #1043 跨用户读日 cap(Passkey 真人也罩,封画像剽窃)— post-launch 校准 N 值
- #1049 注册加邮件验证 / captcha(堵 sybil 最后一公里)
- #1050 公开经济模型说明文档
- #1052 商家上架 SEO/agent 友好度评分条
- Phase 5 隐私 L2 可挑战 + L3 ZK(远期)
- Model B 独立子 agent 委派(终点已锁,等真实多 agent 需求触发)
