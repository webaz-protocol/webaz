# WebAZ API Endpoint Inventory

Auto-generated from `src/pwa/server.ts` + `src/pwa/routes/*.ts` (807 endpoints).

Regenerate: `npm run gen:api-docs` · drift-guarded in CI (`npm run check:api-docs-fresh`).

| Method | Path | Auth | Admin | Description | Source |
|---|---|---|---|---|---|
| GET | `/.well-known/did.json` |  |  | 任何标准 DID resolver(Veramo / SpruceID / KILT / web5 ...)可 GET → 解出 issuer key → 验  | src/pwa/routes/public-utils.ts:408 |
| GET | `/.well-known/oauth-authorization-server` |  |  | RFC 8414 — Authorization Server Metadata | src/pwa/routes/oauth-discovery.ts:54 |
| GET | `/.well-known/oauth-protected-resource` |  |  |  | src/pwa/routes/oauth-discovery.ts:50 |
| GET | `/.well-known/oauth-protected-resource/mcp` |  |  |  | src/pwa/routes/oauth-discovery.ts:51 |
| GET | `/.well-known/webaz-acp-feed.json` |  |  |  | src/pwa/routes/public-utils.ts:401 |
| GET | `/.well-known/webaz-capabilities.json` |  |  | 集成方 agent fetch 此端点即知"我要做的写需要声明哪个 scope / 哪些写无需 scope / 哪些读受约束"。 | src/pwa/routes/public-utils.ts:290 |
| GET | `/.well-known/webaz-economic.json` |  |  |  | src/pwa/routes/public-utils.ts:382 |
| GET | `/.well-known/webaz-entities.json` |  |  | RFC-011 §① — agent 可读实体字典(订单状态机 doc=code + 保守公开字段 + 可验证标注)。 | src/pwa/routes/public-utils.ts:300 |
| GET | `/.well-known/webaz-goals.json` |  |  | RFC-011 §① 目标索引 —— intent → action(②)+ endpoint + MCP 工具 + PWA 页(agent 自路由)。 | src/pwa/routes/public-utils.ts:310 |
| GET | `/.well-known/webaz-integration.json` |  |  | RFC-011 总入口 —— 集成方 agent 一次 fetch 拿到整份契约导航(按旅程组织,指向各维度 live 端点)。 | src/pwa/routes/public-utils.ts:344 |
| GET | `/.well-known/webaz-launch-pulse.json` |  |  |  | src/pwa/routes/public-utils.ts:278 |
| GET | `/.well-known/webaz-negative-space.json` |  |  |  | src/pwa/routes/public-utils.ts:390 |
| GET | `/.well-known/webaz-protocol.json` |  |  |  | src/pwa/routes/public-utils.ts:224 |
| GET | `/.well-known/webaz-verifiability.json` |  |  | RFC-011 §⑤ 可验证索引 —— "什么可验 + 怎么验"统一表(护照/锚/AP2/订单链),诚实分级。 | src/pwa/routes/public-utils.ts:354 |
| GET | `/api/addresses` | 🔐 |  |  | src/pwa/routes/addresses.ts:33 |
| POST | `/api/addresses` | 🔐 |  |  | src/pwa/routes/addresses.ts:41 |
| DELETE | `/api/addresses/:id` | 🔐 |  |  | src/pwa/routes/addresses.ts:92 |
| PATCH | `/api/addresses/:id` | 🔐 |  |  | src/pwa/routes/addresses.ts:63 |
| POST | `/api/admin/_dev/recompute-value-badges` | 🔐 |  |  | src/pwa/routes/admin-ops.ts:122 |
| GET | `/api/admin/admins` | 🔐 | 👑 | GET 全部 admin 列表 | src/pwa/routes/admin-admins.ts:39 |
| POST | `/api/admin/admins` | 🔐 | 👑 | POST 创建 admin（仅 root） | src/pwa/routes/admin-admins.ts:63 |
| DELETE | `/api/admin/admins/:id` | 🔐 | 👑 | DELETE 撤销 admin（root only；不能撤自己；至少保留 1 个 root） | src/pwa/routes/admin-admins.ts:126 |
| POST | `/api/admin/admins/:id/emergency-freeze` | 🔐 | 👑 | For incident response (e.g. a compromised / rogue admin). Atomic. Cannot freeze  | src/pwa/routes/admin-admins.ts:153 |
| PATCH | `/api/admin/admins/:id/permissions` | 🔐 | 👑 | PATCH 更新权限（root only） | src/pwa/routes/admin-admins.ts:104 |
| POST | `/api/admin/agent-strikes/:strikeId/decide` | 🔐 | 👑 | Admin: 审核 strike 申诉 | src/pwa/routes/agent-governance.ts:297 |
| POST | `/api/admin/agent-strikes/issue` | 🔐 | 👑 | P1 fix 4.3: admin 主动 issue strike | src/pwa/routes/agent-governance.ts:333 |
| GET | `/api/admin/agent-strikes/pending` | 🔐 | 👑 | Admin: 列出待审 strike 申诉 | src/pwa/routes/agent-governance.ts:324 |
| GET | `/api/admin/agents/:api_key/reputation` | 🔐 |  |  | src/pwa/routes/agent-reputation.ts:45 |
| POST | `/api/admin/ai/anomaly-check/:user_id` | 🔐 | 👑 |  | src/pwa/routes/admin-ops.ts:78 |
| POST | `/api/admin/announcements` | 🔐 | 👑 |  | src/pwa/routes/announcements.ts:37 |
| PATCH | `/api/admin/announcements/:id` | 🔐 | 👑 |  | src/pwa/routes/announcements.ts:62 |
| GET | `/api/admin/arbitrator-applications` | 🔐 | 👑 | Admin | src/pwa/routes/arbitrator.ts:167 |
| POST | `/api/admin/arbitrator-applications/:id/approve` | 🔐 | 👑 |  | src/pwa/routes/arbitrator.ts:180 |
| POST | `/api/admin/arbitrator-applications/:id/reject` | 🔐 | 👑 |  | src/pwa/routes/arbitrator.ts:206 |
| GET | `/api/admin/arbitrators` | 🔐 | 👑 | 名册(admin 只读,无需 Passkey)。含 active/suspended/revoked 全量 + 状态。 | src/pwa/routes/arbitrator.ts:78 |
| POST | `/api/admin/arbitrators/:user_id/reinstate` | 🔐 | 👑 |  | src/pwa/routes/arbitrator.ts:74 |
| POST | `/api/admin/arbitrators/:user_id/revoke` | 🔐 | 👑 |  | src/pwa/routes/arbitrator.ts:75 |
| POST | `/api/admin/arbitrators/:user_id/suspend` | 🔐 | 👑 |  | src/pwa/routes/arbitrator.ts:73 |
| POST | `/api/admin/arbitrators/grant` | 🔐 | 👑 |  | src/pwa/routes/arbitrator.ts:72 |
| POST | `/api/admin/atomic/process-ledger` | 🔐 | 👑 |  | src/pwa/routes/admin-atomic.ts:30 |
| POST | `/api/admin/auction-reminders/run` | 🔐 | 👑 | Admin 手动跑提醒派发 | src/pwa/routes/auction.ts:486 |
| GET | `/api/admin/audit-log` | 🔐 | 👑 |  | src/pwa/routes/admin-reports.ts:177 |
| GET | `/api/admin/auditor` | 🔐 | 👑 |  | src/pwa/routes/admin-analytics.ts:94 |
| GET | `/api/admin/build-feedback` | 🔐 | 👑 | ── maintainer triage ──────────────────────────────── | src/pwa/routes/build-feedback.ts:74 |
| POST | `/api/admin/build-feedback/:id` | 🔐 | 👑 |  | src/pwa/routes/build-feedback.ts:94 |
| POST | `/api/admin/build-feedback/triage` | 🔐 | 👑 | ⚠️ 必须在 /:id 之前声明,否则 'triage' 会被 :id 捕获。 | src/pwa/routes/build-feedback.ts:83 |
| GET | `/api/admin/build-task-drafts` | 🔐 | 👑 | admin list of UNPUBLISHED drafts (internal, open) + source proposal id | src/pwa/routes/task-proposals.ts:154 |
| GET | `/api/admin/build-task-drafts/:id` | 🔐 | 👑 | full stored body of ONE unpublished internal draft — for PRE-PUBLISH PREVIEW (pu | src/pwa/routes/task-proposals.ts:160 |
| POST | `/api/admin/build-task-drafts/:id/discard` | 🔐 | 👑 | Fail-closed: refuses a published / claimed draft or an already-converted source  | src/pwa/routes/task-proposals.ts:189 |
| POST | `/api/admin/build-task-drafts/:id/publish` | 🔐 | 👑 | PUBLISH a draft → public open task — explicit human/admin action; records the ac | src/pwa/routes/task-proposals.ts:168 |
| POST | `/api/admin/build-tasks/:id/resolve` | 🔐 | 👑 | 验收终态 —— 仅 admin/maintainer(验收=真人,RFC-006 不变量 2;不发奖励/不记信誉) | src/pwa/routes/build-tasks.ts:104 |
| POST | `/api/admin/build-tasks/:id/withdraw` | 🔐 | 👑 | draft can be built). Fail-closed: refuses a claimed task or a non-published task | src/pwa/routes/task-proposals.ts:202 |
| DELETE | `/api/admin/categories/:id/seasonal` | 🔐 | 👑 |  | src/pwa/routes/admin-catalog.ts:46 |
| POST | `/api/admin/categories/:id/seasonal` | 🔐 | 👑 | ─── 类目 季节性配置 ───────────────────────────────────── | src/pwa/routes/admin-catalog.ts:31 |
| GET | `/api/admin/charity/fund` | 🔐 | 👑 |  | src/pwa/routes/charity.ts:829 |
| POST | `/api/admin/charity/fund/disburse` | 🔐 | 👑 |  | src/pwa/routes/charity.ts:792 |
| GET | `/api/admin/dashboard` | 🔐 | 👑 |  | src/pwa/routes/admin-analytics.ts:242 |
| GET | `/api/admin/demand-signals` |  |  | 公开给商家 = 未来独立 gated PR(聚合阈值≥N + 脱敏,永不暴露单买家)。 | src/pwa/routes/admin-analytics.ts:36 |
| POST | `/api/admin/direct-receive/aml-flags` | 🔐 | 👑 |  | src/pwa/routes/admin-direct-receive-deposits.ts:290 |
| POST | `/api/admin/direct-receive/aml-flags/:id/review` | 🔐 | 👑 | route 只做 auth + gate + 参数校验 + 调 reviewAmlFlag(唯一 review writer,原子改 flag + 写 audi | src/pwa/routes/admin-direct-receive-deposits.ts:209 |
| GET | `/api/admin/direct-receive/bond-slash` | 🔐 | 👑 | ── B3:保证金罚没(人工铁律:仲裁裁定卖家责的直付争议 → 提案 → 冷静期 → ROOT+Passkey 执行;绝不自动)── | src/pwa/routes/admin-direct-receive-deposits.ts:72 |
| POST | `/api/admin/direct-receive/bond-slash/:id/cancel` | 🔐 | 👑 |  | src/pwa/routes/admin-direct-receive-deposits.ts:93 |
| POST | `/api/admin/direct-receive/bond-slash/:id/execute` | 🔐 | 👑 | 执行(ROOT + 真人 Passkey,purpose direct_pay_bond_slash 绑 proposal_id;冷静期由域内绝对截止校验)。 | src/pwa/routes/admin-direct-receive-deposits.ts:104 |
| POST | `/api/admin/direct-receive/bond-slash/propose` | 🔐 | 👑 | 提案(ROOT,审计留痕,不 Passkey —— 提案不动任何东西;执行才是终局动作)。通知卖家(冷静期=申诉窗)。 | src/pwa/routes/admin-direct-receive-deposits.ts:79 |
| GET | `/api/admin/direct-receive/deferrals` | 🔐 | 👑 | GET /api/admin/direct-receive/deferrals?status=pending — ROOT 审批队列(默认全部;可按 statu | src/pwa/routes/admin-direct-receive-deposits.ts:386 |
| POST | `/api/admin/direct-receive/deferrals/:id/adjust-quota` | 🔐 | 👑 | reduced_quota_factor(签 A 改 B / 改数值一律拒)。adjustGrantedDeferralQuota 是唯一 writer(CAS | src/pwa/routes/admin-direct-receive-deposits.ts:444 |
| POST | `/api/admin/direct-receive/deferrals/:id/approve` | 🔐 | 👑 | Passkey purpose_data 绑定【完整审批条款】(deferral_id + reduced_quota_factor + grace_days) | src/pwa/routes/admin-direct-receive-deposits.ts:395 |
| POST | `/api/admin/direct-receive/deferrals/:id/reject` | 🔐 | 👑 | POST /api/admin/direct-receive/deferrals/:id/reject — ROOT + 真人 Passkey 拒绝缓交。pur | src/pwa/routes/admin-direct-receive-deposits.ts:420 |
| GET | `/api/admin/direct-receive/deposits` | 🔐 | 👑 | GET /api/admin/direct-receive/deposits?status=pending — ROOT 只读:保证金申报队列(核对到账用)。B | src/pwa/routes/admin-direct-receive-deposits.ts:46 |
| POST | `/api/admin/direct-receive/deposits/:id/confirm-production` | 🔐 | 👑 | 当前恒 fail-closed(无 legal-cleared rail → assert 抛 → PRODUCTION_RAIL_NOT_CLEARED)。 | src/pwa/routes/admin-direct-receive-deposits.ts:158 |
| POST | `/api/admin/direct-receive/deposits/:id/execute-refund` | 🔐 | 👑 | unlock blockers(冷静期内可能新增退货/欠费等责任 —— 有任一即拒)。凭据必填;真实退款发生在协议外,此处只记录。 | src/pwa/routes/admin-direct-receive-deposits.ts:129 |
| POST | `/api/admin/direct-receive/deposits/:id/reject` | 🔐 | 👑 | 不 Passkey:驳回不授予/不移动任何东西(与缓交 reject 不同 —— 那是资格决定;这里只是"到账核不上"退回重报)。 | src/pwa/routes/admin-direct-receive-deposits.ts:60 |
| GET | `/api/admin/direct-receive/fee-account/:seller_id` | 🔐 | 👑 | 只读诊断,不写、无 Passkey(读不授权能力);卖家私密财务,买家/卖家拿不到此 admin 视图。 | src/pwa/routes/admin-direct-receive-deposits.ts:326 |
| POST | `/api/admin/direct-receive/fee-adjust` | 🔐 | 👑 | ≠ 退款(不动真钱,只调记账)。purpose_data 绑 seller_id+delta_units+reason。 | src/pwa/routes/admin-direct-receive-deposits.ts:309 |
| POST | `/api/admin/direct-receive/fee-prepay` | 🔐 | 👑 | 不碰 buyer wallet/escrow/order/settlement/refund;非买家 escrow/保证金/penalty。本轮无"余额退款"( | src/pwa/routes/admin-direct-receive-deposits.ts:300 |
| GET | `/api/admin/direct-receive/fee-prepay-requests` | 🔐 | 👑 | GET /api/admin/direct-receive/fee-prepay-requests?status=pending — ROOT 只读:预充值申请 | src/pwa/routes/admin-direct-receive-deposits.ts:332 |
| POST | `/api/admin/direct-receive/fee-prepay-requests/:id/approve` | 🔐 | 👑 | purpose_data 绑 request_id + seller_id + amount_units + method(把入账金额/对象钉进 Passkey | src/pwa/routes/admin-direct-receive-deposits.ts:341 |
| POST | `/api/admin/direct-receive/fee-prepay-requests/:id/reject` | 🔐 | 👑 | POST /api/admin/direct-receive/fee-prepay-requests/:id/reject — ROOT + Passkey(不 | src/pwa/routes/admin-direct-receive-deposits.ts:353 |
| POST | `/api/admin/direct-receive/fee-refund` | 🔐 | 👑 | amount ≤ 当前 available(helper 同事务校验)。append-only + audit。purpose_data 绑 seller_id | src/pwa/routes/admin-direct-receive-deposits.ts:317 |
| POST | `/api/admin/direct-receive/kyb-reviews` | 🔐 | 👑 | Passkey purpose_data 绑定【完整写入内容】(user_id+status+provider_ref+expires_at):签 A 写 B  | src/pwa/routes/admin-direct-receive-deposits.ts:271 |
| GET | `/api/admin/direct-receive/product-verifications` | 🔐 | 👑 | GET /api/admin/direct-receive/product-verifications?status=submitted — ROOT 审核队列 | src/pwa/routes/admin-direct-receive-deposits.ts:482 |
| POST | `/api/admin/direct-receive/product-verifications/:id/review` | 🔐 | 👑 | Passkey purpose_data 绑 verification_id + decision:签 A 用 B / 改结论一律拒。verify = 放行该产 | src/pwa/routes/admin-direct-receive-deposits.ts:491 |
| POST | `/api/admin/direct-receive/readiness` | 🔐 | 👑 | 含 KYB/sanctions/AML/base-bond/rail clearance 全细节)。只读诊断(不写库、不 flip launch);ROOT 专 | src/pwa/routes/admin-direct-receive-deposits.ts:364 |
| POST | `/api/admin/direct-receive/sanctions-screenings` | 🔐 | 👑 | purpose_data 绑定 user_id+status+provider_ref+expires_at。 | src/pwa/routes/admin-direct-receive-deposits.ts:280 |
| GET | `/api/admin/direct-receive/store-verifications` | 🔐 | 👑 | GET /api/admin/direct-receive/store-verifications?status=submitted — ROOT 审核队列(默 | src/pwa/routes/admin-direct-receive-deposits.ts:519 |
| POST | `/api/admin/direct-receive/store-verifications/:id/review` | 🔐 | 👑 | POST /api/admin/direct-receive/store-verifications/:id/review — ROOT + 真人 Passke | src/pwa/routes/admin-direct-receive-deposits.ts:527 |
| GET | `/api/admin/disputes` | 🔐 | 👑 |  | src/pwa/routes/admin-reports.ts:55 |
| POST | `/api/admin/disputes/:id/decline-contest-resolve` | 🔐 | 👑 | (dispute CAS + COI + 终态 completed + 结算 + 审计,单事务全回滚)。admin override 不占用 assigned_ | src/pwa/routes/admin-reports.ts:87 |
| GET | `/api/admin/economic-summary` | 🔐 | 👑 | 隐私第一：运营财务，仅 protocol admin 可见。 | src/pwa/routes/admin-reports.ts:127 |
| GET | `/api/admin/editor-picks` | 🔐 | 👑 |  | src/pwa/routes/admin-editor-picks.ts:60 |
| POST | `/api/admin/editor-picks` | 🔐 | 👑 |  | src/pwa/routes/admin-editor-picks.ts:29 |
| DELETE | `/api/admin/editor-picks/:id` | 🔐 | 👑 |  | src/pwa/routes/admin-editor-picks.ts:54 |
| GET | `/api/admin/email-subscriptions` | 🔐 | 👑 | 2026-05-25 admin 查邮箱订阅 — 独立端点，与建议分开 | src/pwa/routes/welcome.ts:81 |
| PATCH | `/api/admin/email-subscriptions/:id/status` | 🔐 | 👑 | 2026-05-29: admin 标记申请处理状态（pending→contacted→invited→done）— 不动 POST 提交逻辑 | src/pwa/routes/welcome.ts:115 |
| GET | `/api/admin/errors` | 🔐 | 👑 |  | src/pwa/routes/admin-ops.ts:144 |
| GET | `/api/admin/errors/aggregate` | 🔐 | 👑 | Tier 1 #5: 错误聚合 view（24h / 1h 趋势 + top by source + top messages + burst alert） | src/pwa/routes/admin-ops.ts:156 |
| GET | `/api/admin/events/recent` | 🔐 | 👑 |  | src/pwa/routes/admin-events.ts:35 |
| GET | `/api/admin/events/stream` |  |  |  | src/pwa/routes/admin-events.ts:56 |
| POST | `/api/admin/events/ticket` | 🔐 | 👑 |  | src/pwa/routes/admin-events.ts:48 |
| GET | `/api/admin/export/:kind` | 🔐 | 👑 |  | src/pwa/routes/admin-ops.ts:41 |
| GET | `/api/admin/feedback` | 🔐 |  | admin 列出工单 | src/pwa/routes/feedback.ts:106 |
| POST | `/api/admin/feedback/:id/reply` | 🔐 |  | admin 回复 + 切状态 | src/pwa/routes/feedback.ts:131 |
| GET | `/api/admin/finance/monthly` | 🔐 | 👑 |  | src/pwa/routes/admin-analytics.ts:101 |
| POST | `/api/admin/governance/activate` | 🔐 | 👑 | body: { application_id, webauthn_token, note? } | src/pwa/routes/governance-onboarding.ts:408 |
| GET | `/api/admin/governance/appeals` | 🔐 | 👑 | GET /api/admin/governance/appeals — maintainer 看待裁决申诉 | src/pwa/routes/governance-onboarding.ts:762 |
| GET | `/api/admin/governance/application/:id` | 🔐 | 👑 | GET /api/admin/governance/application/:id — 详情(含 expected_verdict 用于对比 — 仅 maint | src/pwa/routes/governance-onboarding.ts:377 |
| GET | `/api/admin/governance/applications` | 🔐 | 👑 | GET /api/admin/governance/applications — 列出 pending_onboarding(可筛 quiz_passed +  | src/pwa/routes/governance-onboarding.ts:360 |
| GET | `/api/admin/governance/auto-deactivations` | 🔐 | 👑 | spec §6.2 公示触发原因(透明 — 元规则 #1) | src/pwa/routes/governance-onboarding.ts:743 |
| POST | `/api/admin/governance/resolve-appeal` | 🔐 | 👑 | accept → 恢复 active(spec §7.2) ;reject → 维持 inactive,公开理由 | src/pwa/routes/governance-onboarding.ts:781 |
| POST | `/api/admin/governance/run-auto-deactivate` | 🔐 | 👑 | Useful for ops + testing. The scheduled cron also runs every N hours. | src/pwa/server.ts:5322 |
| GET | `/api/admin/health` | 🔐 | 👑 |  | src/pwa/routes/admin-health.ts:33 |
| GET | `/api/admin/hot-wallet` |  |  | Legacy x-admin-key 入口：仅余额 | src/pwa/routes/admin-wallet-ops.ts:74 |
| GET | `/api/admin/hot-wallet/status` | 🔐 | 👑 | P2-5: protocol 权限（区域 admin 看不到全局热钱包） | src/pwa/routes/admin-wallet-ops.ts:48 |
| POST | `/api/admin/kyc/:user_id/approve` | 🔐 | 👑 |  | src/pwa/routes/admin-moderation.ts:49 |
| POST | `/api/admin/kyc/:user_id/reject` | 🔐 | 👑 |  | src/pwa/routes/admin-moderation.ts:61 |
| GET | `/api/admin/kyc/pending` | 🔐 | 👑 | ─── KYC ────────────────────────────────────────────────────── | src/pwa/routes/admin-moderation.ts:39 |
| GET | `/api/admin/operator-claims` | 🔐 | 👑 | ── ROOT: review queue (all claims, optional ?status=) ── | src/pwa/routes/admin-operator-claims.ts:123 |
| POST | `/api/admin/operator-claims` | 🔐 | 👑 | ── admin proposes linking THEIR OWN seat to a contributor account ── | src/pwa/routes/admin-operator-claims.ts:73 |
| POST | `/api/admin/operator-claims/:approvedEventId/revoke` | 🔐 | 👑 | ── ROOT: revoke an APPROVED (active) claim ── | src/pwa/routes/admin-operator-claims.ts:170 |
| GET | `/api/admin/operator-claims/:claimedEventId` | 🔐 | 👑 | ── ROOT: claim detail ── | src/pwa/routes/admin-operator-claims.ts:130 |
| POST | `/api/admin/operator-claims/:claimedEventId/approve` | 🔐 | 👑 | ── ROOT: approve a proposed-or-confirmed claim ── | src/pwa/routes/admin-operator-claims.ts:154 |
| POST | `/api/admin/operator-claims/:claimedEventId/reject` | 🔐 | 👑 | ── ROOT: reject a still-proposed/confirmed claim ── | src/pwa/routes/admin-operator-claims.ts:162 |
| GET | `/api/admin/operator-claims/me` | 🔐 | 👑 | admin-seat owner can request/track unlink on their own active claims) ── | src/pwa/routes/admin-operator-claims.ts:93 |
| POST | `/api/admin/operator-claims/unlink/:requestEventId/approve` | 🔐 | 👑 | relationship/request, approval_kind + conflict_disclosure are required (governan | src/pwa/routes/admin-operator-claims.ts:222 |
| POST | `/api/admin/operator-claims/unlink/:requestEventId/reject` | 🔐 | 👑 | ── ROOT: reject an unlink request → claim stays active. Same self-or-related mar | src/pwa/routes/admin-operator-claims.ts:241 |
| GET | `/api/admin/operator-claims/unlink/requests` | 🔐 | 👑 | self_or_related flags each request the viewing root is a party to → the UI then  | src/pwa/routes/admin-operator-claims.ts:210 |
| GET | `/api/admin/orders` | 🔐 | 👑 |  | src/pwa/routes/admin-reports.ts:34 |
| GET | `/api/admin/payment-methods` | 🔐 | 👑 | ─── Admin payment_methods CRUD（root admin only · 基础设施变更需根权限）─ | src/pwa/routes/payments-governance.ts:136 |
| POST | `/api/admin/payment-methods` | 🔐 | 👑 |  | src/pwa/routes/payments-governance.ts:142 |
| DELETE | `/api/admin/payment-methods/:id` | 🔐 | 👑 |  | src/pwa/routes/payments-governance.ts:213 |
| PUT | `/api/admin/payment-methods/:id` | 🔐 | 👑 |  | src/pwa/routes/payments-governance.ts:173 |
| GET | `/api/admin/platform-receive-accounts` | 🔐 | 👑 | ── list(ROOT 读;含 inactive + qr_data_uri)── | src/pwa/routes/platform-receive-accounts.ts:77 |
| POST | `/api/admin/platform-receive-accounts` | 🔐 | 👑 | ── add(ROOT + Passkey)── | src/pwa/routes/platform-receive-accounts.ts:83 |
| DELETE | `/api/admin/platform-receive-accounts/:id` | 🔐 | 👑 | ── deactivate(ROOT + Passkey + 存在性)── | src/pwa/routes/platform-receive-accounts.ts:106 |
| PUT | `/api/admin/platform-receive-accounts/:id` | 🔐 | 👑 | ── update(ROOT + Passkey + 存在性)── | src/pwa/routes/platform-receive-accounts.ts:93 |
| GET | `/api/admin/products` | 🔐 | 👑 | ─── 商品 列表 + 强制下架 ─────────────────────────────── | src/pwa/routes/admin-catalog.ts:53 |
| POST | `/api/admin/products/:id/force-delist` | 🔐 | 👑 |  | src/pwa/routes/admin-catalog.ts:65 |
| GET | `/api/admin/protocol-kpi` | 🔐 | 👑 |  | src/pwa/routes/admin-analytics.ts:154 |
| GET | `/api/admin/protocol-params` | 🔐 | 👑 |  | src/pwa/routes/admin-protocol-params.ts:61 |
| PATCH | `/api/admin/protocol-params/:key` | 🔐 | 👑 | 2026-06-03 #1095: + constitutional only-increase 守护 | src/pwa/routes/admin-protocol-params.ts:70 |
| GET | `/api/admin/protocol-params/:key/history` | 🔐 | 👑 | A-3: 变更历史 | src/pwa/routes/admin-protocol-params.ts:201 |
| POST | `/api/admin/protocol-params/:key/reset` | 🔐 | 👑 |  | src/pwa/routes/admin-protocol-params.ts:151 |
| GET | `/api/admin/public-ideas` | 🔐 | 👑 | ─── admin 端 ───────────────────────────────────────────── | src/pwa/routes/welcome.ts:38 |
| PATCH | `/api/admin/public-ideas/:id` | 🔐 | 👑 |  | src/pwa/routes/welcome.ts:66 |
| GET | `/api/admin/quota-applications` | 🔐 | 👑 | Admin | src/pwa/routes/seller-quota.ts:226 |
| POST | `/api/admin/quota-applications/:id/approve` | 🔐 | 👑 |  | src/pwa/routes/seller-quota.ts:239 |
| POST | `/api/admin/quota-applications/:id/reject` | 🔐 | 👑 |  | src/pwa/routes/seller-quota.ts:256 |
| GET | `/api/admin/quota-requests` | 🔐 | 👑 | list quota requests (optional ?status=) | src/pwa/routes/build-task-quota.ts:74 |
| GET | `/api/admin/quota-requests/:id` | 🔐 | 👑 | detail of one request + the requester's live 24h create usage (reviewer context) | src/pwa/routes/build-task-quota.ts:82 |
| POST | `/api/admin/quota-requests/:id/approve` | 🔐 | 👑 | approve → time-boxed counted grant (self-approval rejected in the store) | src/pwa/routes/build-task-quota.ts:90 |
| POST | `/api/admin/quota-requests/:id/reject` | 🔐 | 👑 | reject (self-rejection also blocked by the store's SELF_DECISION guard) | src/pwa/routes/build-task-quota.ts:104 |
| POST | `/api/admin/quota-requests/:id/revoke` | 🔐 | 👑 | revoke an already-approved grant (root) | src/pwa/routes/build-task-quota.ts:113 |
| GET | `/api/admin/region-payment-methods` | 🔐 | 👑 | ─── region_payment_methods CRUD ────────────────────────── | src/pwa/routes/payments-governance.ts:227 |
| POST | `/api/admin/region-payment-methods` | 🔐 | 👑 |  | src/pwa/routes/payments-governance.ts:243 |
| DELETE | `/api/admin/region-payment-methods/:id` | 🔐 | 👑 |  | src/pwa/routes/payments-governance.ts:302 |
| PUT | `/api/admin/region-payment-methods/:id` | 🔐 | 👑 |  | src/pwa/routes/payments-governance.ts:274 |
| POST | `/api/admin/reputation/decay` | 🔐 |  |  | src/pwa/routes/admin-ops.ts:129 |
| GET | `/api/admin/rewards-health` | 🔐 | 👑 | 以及"在旧 major consent 上仍 opted-in"= 下次 auto_downgrade cron 的降级候选。 | src/pwa/routes/admin-analytics.ts:296 |
| POST | `/api/admin/risk/suspend/:user_id` | 🔐 | 👑 |  | src/pwa/routes/admin-moderation.ts:126 |
| GET | `/api/admin/risk/suspicious` | 🔐 | 👑 | ─── D-1 风控告警 ──────────────────────────────────────────── | src/pwa/routes/admin-moderation.ts:76 |
| POST | `/api/admin/risk/unsuspend/:user_id` | 🔐 | 👑 |  | src/pwa/routes/admin-moderation.ts:139 |
| POST | `/api/admin/skill-market/:id/audit` | 🔐 | 👑 | ─── Admin：审核 ──────────────────────────────────────────── | src/pwa/routes/skill-market.ts:172 |
| GET | `/api/admin/skill-market/pending` | 🔐 | 👑 | ─── Admin：待审列表 ──────────────────────────────────────── | src/pwa/routes/skill-market.ts:166 |
| GET | `/api/admin/task-proposals` | 🔐 | 👑 | admin list (maintainer only) | src/pwa/routes/task-proposals.ts:80 |
| POST | `/api/admin/task-proposals/:id/ai-assist` | 🔐 | 👑 | NEVER a decision: no auto-publish / auto-reject / hide / reward. A human admin m | src/pwa/routes/task-proposals.ts:103 |
| GET | `/api/admin/task-proposals/:id/ai-suggestions` | 🔐 | 👑 | stored AI suggestions (evidence) for a proposal | src/pwa/routes/task-proposals.ts:114 |
| POST | `/api/admin/task-proposals/:id/create-task-draft` | 🔐 | 👑 | No auto-publish (draft is internal/unclaimable until an explicit publish); no re | src/pwa/routes/task-proposals.ts:121 |
| POST | `/api/admin/task-proposals/:id/review` | 🔐 | 👑 | admin review (maintainer only): needs_info \| rejected \| converted — no build_tas | src/pwa/routes/task-proposals.ts:89 |
| GET | `/api/admin/tokenomics` | 🔐 | 👑 | Tokenomics 详细数据 + Tier 配置 + 高额榜 | src/pwa/routes/admin-tokenomics.ts:30 |
| POST | `/api/admin/tokenomics/require-ref/toggle` | 🔐 | 👑 | 注册必须 ref 开关 | src/pwa/routes/admin-tokenomics.ts:53 |
| POST | `/api/admin/trial/run-eval` | 🔐 | 👑 | Admin 手动触发测评评估（测试 + 紧急 + 立即生效） | src/pwa/routes/trial.ts:355 |
| GET | `/api/admin/usage` |  |  |  | src/pwa/routes/admin-analytics.ts:46 |
| GET | `/api/admin/users` | 🔐 | 👑 |  | src/pwa/routes/admin-users-query.ts:167 |
| POST | `/api/admin/users/:id/force-delist-all` | 🔐 | 👑 |  | src/pwa/routes/admin-users-lifecycle.ts:74 |
| POST | `/api/admin/users/:id/grant-role` | 🔐 | 👑 | P0.1: admin 角色提权必须 root；其他角色需 users + scope | src/pwa/routes/admin-users-lifecycle.ts:123 |
| POST | `/api/admin/users/:id/l1-share-override` | 🔐 | 👑 | L1 分享权限 override：0 auto / 1 强允 / -1 强禁 | src/pwa/routes/admin-users-lifecycle.ts:52 |
| POST | `/api/admin/users/:id/pause-listing` | 🔐 | 👑 |  | src/pwa/routes/admin-users-lifecycle.ts:214 |
| GET | `/api/admin/users/:id/profile` | 🔐 | 👑 | 完整档案聚合 | src/pwa/routes/admin-users-query.ts:244 |
| POST | `/api/admin/users/:id/reset-failed-attempts` | 🔐 | 👑 | 解除账号登录锁定：清零失败次数 + 解锁 | src/pwa/routes/admin-users-lifecycle.ts:66 |
| POST | `/api/admin/users/:id/resume-listing` | 🔐 | 👑 |  | src/pwa/routes/admin-users-lifecycle.ts:225 |
| POST | `/api/admin/users/:id/revoke-role` | 🔐 | 👑 | P0.3: revoke admin → root only | src/pwa/routes/admin-users-lifecycle.ts:183 |
| POST | `/api/admin/users/:id/set-product-quota` | 🔐 | 👑 |  | src/pwa/routes/admin-users-lifecycle.ts:201 |
| POST | `/api/admin/users/:id/set-roles` |  |  | P0.2: preview diff，含 admin 变更 → root only | src/pwa/routes/admin-users-lifecycle.ts:143 |
| POST | `/api/admin/users/:id/suspend` | 🔐 | 👑 | P0.4: users + scope；suspend admin → root only | src/pwa/routes/admin-users-lifecycle.ts:87 |
| GET | `/api/admin/users/:id/timeline` | 🔐 | 👑 | Wave F-3: 完整事件流 | src/pwa/routes/admin-users-query.ts:59 |
| POST | `/api/admin/users/:id/unsuspend` | 🔐 | 👑 |  | src/pwa/routes/admin-users-lifecycle.ts:110 |
| POST | `/api/admin/users/batch-action` | 🔐 | 👑 |  | src/pwa/routes/admin-users-query.ts:116 |
| GET | `/api/admin/users/lookup` | 🔐 | 👑 | P1-1: 按 handle / id 任意角色查找 | src/pwa/routes/admin-users-query.ts:47 |
| GET | `/api/admin/verifier-appeals` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-flow.ts:109 |
| POST | `/api/admin/verifier-appeals/:id/decide` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-flow.ts:127 |
| GET | `/api/admin/verifier-applications` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-flow.ts:35 |
| POST | `/api/admin/verifier-applications/:id/approve` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-flow.ts:54 |
| POST | `/api/admin/verifier-applications/:id/reject` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-flow.ts:83 |
| GET | `/api/admin/verifier-whitelist` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-whitelist.ts:40 |
| POST | `/api/admin/verifier-whitelist` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-whitelist.ts:51 |
| DELETE | `/api/admin/verifier-whitelist/:userId` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-whitelist.ts:68 |
| POST | `/api/admin/verifier-whitelist/:userId/promote` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-whitelist.ts:77 |
| POST | `/api/admin/verifier-whitelist/:userId/revoke` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-whitelist.ts:105 |
| POST | `/api/admin/verifier-whitelist/:userId/suspend` | 🔐 | 👑 |  | src/pwa/routes/admin-verifier-whitelist.ts:92 |
| GET | `/api/admin/verify-tasks` | 🔐 | 👑 |  | src/pwa/routes/admin-reports.ts:110 |
| GET | `/api/admin/wish-reports` | 🔐 | 👑 | ─── admin 慈善管理 ───────────────────────────────────────── | src/pwa/routes/charity.ts:740 |
| PATCH | `/api/admin/wish-reports/:id` | 🔐 | 👑 |  | src/pwa/routes/charity.ts:758 |
| POST | `/api/admin/wishes/:id/takedown` | 🔐 | 👑 |  | src/pwa/routes/charity.ts:771 |
| GET | `/api/admin/withdrawals` |  |  |  | src/pwa/routes/admin-wallet-ops.ts:88 |
| POST | `/api/admin/withdrawals/:id/approve` |  |  |  | src/pwa/routes/admin-wallet-ops.ts:98 |
| POST | `/api/agent-buy` | 🔐 |  |  | src/pwa/routes/agent-buy.ts:41 |
| GET | `/api/agent-grants` | 🔐 |  | "Connected agents" UI shows so a human can spot stale/unused or busy agents befo | src/pwa/routes/agent-grants.ts:1008 |
| POST | `/api/agent-grants` | 🔐 |  | agent delegation"的安全叙事。零消费方(前端/MCP/测试均不用),故降级为不可用,统一走 pairing。 | src/pwa/routes/agent-grants.ts:997 |
| POST | `/api/agent-grants/:grant_id/revoke` | 🔐 |  | ── Revoke (online, one-click). ── | src/pwa/routes/agent-grants.ts:1033 |
| GET | `/api/agent-grants/connection` | 🎫 grant:read_public |  | address, or any other PII (E-node requirement). Backs webaz_connection_status. | src/pwa/routes/agent-grants.ts:193 |
| GET | `/api/agent-grants/my-permission-requests` |  |  | grant_id: an agent sees ONLY its own requests, never the human's other agents'.  | src/pwa/routes/agent-grants.ts:707 |
| POST | `/api/agent-grants/pair/:pairing_id/retrieve` |  |  | (pair 4) Agent retrieves the credential ONCE via PKCE verifier — UNAUTHENTICATED | src/pwa/routes/agent-grants.ts:960 |
| GET | `/api/agent-grants/pair/:user_code` | 🔐 |  | (pair 2) Human reviews the server-generated consent — human-authenticated. | src/pwa/routes/agent-grants.ts:892 |
| POST | `/api/agent-grants/pair/:user_code/approve` | 🔐 |  | (pair 3) Human approves — human-authenticated. Issues the grant (token_hash fill | src/pwa/routes/agent-grants.ts:901 |
| POST | `/api/agent-grants/pair/:user_code/reject` | 🔐 |  | 拒绝是保护性动作,无需 Passkey(不签发任何凭证)。幂等:仅 pending 可拒。 | src/pwa/routes/agent-grants.ts:949 |
| POST | `/api/agent-grants/pair/start` |  |  | (pair 1) Agent starts a pairing — UNAUTHENTICATED (agent has no credential yet). | src/pwa/routes/agent-grants.ts:851 |
| GET | `/api/agent-grants/permission-requests` | 🔐 |  | GET list this human's PENDING permission requests (for #agent-approvals). Human- | src/pwa/routes/agent-grants.ts:683 |
| POST | `/api/agent-grants/permission-requests` |  |  | NOT grantable (they need a per-action live Passkey, not a persistent grant) → st | src/pwa/routes/agent-grants.ts:659 |
| POST | `/api/agent-grants/permission-requests/:id/approve` | 🔐 |  | POST approve — human-authed + live Passkey; expands the bound grant (union scope | src/pwa/routes/agent-grants.ts:722 |
| POST | `/api/agent-grants/permission-requests/:id/reject` | 🔐 |  | POST reject — human-authed. Terminal 'rejected'; nothing is granted. | src/pwa/routes/agent-grants.ts:830 |
| GET | `/api/agent-grants/verify` |  |  | Audited (acceptance #8: every grant use logs). Never returns the raw token/api_k | src/pwa/routes/agent-grants.ts:646 |
| GET | `/api/agent-grants/whoami` | 🎫 grant:read_public |  | end-to-end on a brand-new read-only endpoint that touches NO existing route and  | src/pwa/routes/agent-grants.ts:184 |
| GET | `/api/agent/acp-feed` |  |  |  | src/pwa/routes/public-utils.ts:402 |
| POST | `/api/agent/address/change-request` | 🎫 grant:address_change_request |  |  | src/pwa/routes/agent-grants.ts:421 |
| GET | `/api/agent/address/masked` | 🎫 grant:address_read_masked |  | RFC-026 PR-5 — 地址:masked 读(region+存在性,绝不截取子串)/ 变更请求(全文进 PII 专表,Passkey 批准才写) | src/pwa/routes/agent-grants.ts:417 |
| GET | `/api/agent/approval-requests` | 🎫 grant:approval_requests_read |  | RFC-026 PR-2 — 审批状态只读(safe scope approval_requests_read;只看本人;零 PII) | src/pwa/routes/agent-grants.ts:458 |
| GET | `/api/agent/approval-requests/:id` | 🎫 grant:approval_requests_read |  |  | src/pwa/routes/agent-grants.ts:462 |
| GET | `/api/agent/buyer/orders` | 🎫 grant:buyer_orders_read_minimal |  | recipient_code 连取都不取(I6 同强度)。纯只读,零执行、零资金 —— 买家写动作(place_order 等)仍 RISK 硬拒。 | src/pwa/routes/agent-grants.ts:243 |
| GET | `/api/agent/buyer/orders/:id` | 🎫 grant:buyer_orders_read_minimal |  |  | src/pwa/routes/agent-grants.ts:276 |
| GET | `/api/agent/buyer/orders/:id/case-draft` | 🎫 grant:buyer_case_prepare |  |  | src/pwa/routes/agent-grants.ts:469 |
| GET | `/api/agent/buyer/orders/:id/full` | 🎫 grant:buyer_orders_read |  | RFC-026 PR-3 — 订单全量只读(safe scope buyer_orders_read;时间线/条款快照/物流/截止/退款/动作面;零 PII) | src/pwa/routes/agent-grants.ts:445 |
| GET | `/api/agent/capabilities` |  |  |  | src/pwa/routes/public-utils.ts:294 |
| GET | `/api/agent/changes` |  |  | 指纹由 tests/test-contract-fingerprint.ts + docs/CONTRACT-LOCK.json 守住(静默改契约不可 merg | src/pwa/routes/public-utils.ts:338 |
| POST | `/api/agent/discover` | 🎫 grant:buyer_discover |  | allowlist 字段(category/keywords≤5/max_price/ship_to_region/quantity);文本入口做形状校验(超长 | src/pwa/routes/agent-grants.ts:291 |
| GET | `/api/agent/economic-participation` |  |  |  | src/pwa/routes/public-utils.ts:383 |
| GET | `/api/agent/entities` |  |  |  | src/pwa/routes/public-utils.ts:304 |
| GET | `/api/agent/events` | 🔐 |  | 结构性事件 + 哈希链字段(验链防篡改),完整 payload 仍走 party-gated /chain。 | src/pwa/routes/orders-read.ts:162 |
| GET | `/api/agent/goals` |  |  |  | src/pwa/routes/public-utils.ts:330 |
| GET | `/api/agent/integration` |  |  |  | src/pwa/routes/public-utils.ts:348 |
| GET | `/api/agent/negative-space` |  |  |  | src/pwa/routes/public-utils.ts:391 |
| POST | `/api/agent/order-draft` | 🎫 grant:draft_order |  | 草稿不可变(无 update),cancel 终态幂等安全;get/list 仅本人。提交/批准/建单全在 PR-5a。 | src/pwa/routes/agent-grants.ts:379 |
| GET | `/api/agent/order-drafts` | 🎫 grant:draft_order |  |  | src/pwa/routes/agent-grants.ts:391 |
| GET | `/api/agent/order-drafts/:id` | 🎫 grant:draft_order |  |  | src/pwa/routes/agent-grants.ts:395 |
| POST | `/api/agent/order-drafts/:id/cancel` | 🎫 grant:draft_order |  |  | src/pwa/routes/agent-grants.ts:385 |
| POST | `/api/agent/order-drafts/:id/submit` | 🎫 grant:order_submit_request |  |  | src/pwa/routes/agent-grants.ts:476 |
| GET | `/api/agent/orders` | 🎫 grant:seller_orders_read_minimal |  | 纯只读,无任何执行(order_action_request 在 PR2/PR3 才有提交/执行)。 | src/pwa/routes/agent-grants.ts:223 |
| GET | `/api/agent/orders/:id` | 🎫 grant:seller_orders_read_minimal |  |  | src/pwa/routes/agent-grants.ts:230 |
| POST | `/api/agent/orders/:id/buyer-action-request` | 🎫 grant:buyer_action_request |  | RFC-026 PR-6 — 买家动作请求(confirm_receipt/cancel/request_return;提交-审批-回环执行) | src/pwa/routes/agent-grants.ts:408 |
| GET | `/api/agent/orders/:id/chat` | 🎫 grant:order_chat_read |  | RFC-026 PR-4 — 订单上下文聊天(仅订单双方;发送回环走生产反诈/限频;无自由私信) | src/pwa/routes/agent-grants.ts:430 |
| POST | `/api/agent/orders/:id/chat` | 🎫 grant:order_chat_send |  |  | src/pwa/routes/agent-grants.ts:436 |
| POST | `/api/agent/orders/:orderId/action-request` | 🎫 grant:order_action_request |  | 同 (order_id,action) 双 pending 被唯一索引拒。执行(accept/ship)在 PR3 经人 Passkey 批准后由服务端跑。 | src/pwa/routes/agent-grants.ts:486 |
| POST | `/api/agent/quote` | 🎫 grant:price_quote |  | subject 恒 = grant human(agent 无法传 human_id/代表他人)。 | src/pwa/routes/agent-grants.ts:369 |
| GET | `/api/agent/seller/products` | 🎫 grant:seller_products_read |  | The consumption (allow AND the permission_required deny) is audited by the middl | src/pwa/routes/agent-grants.ts:211 |
| POST | `/api/agent/seller/products` | 🎫 grant:seller_product_draft |  |  | src/pwa/routes/agent-grants.ts:502 |
| PATCH | `/api/agent/seller/products/:id/draft` | 🎫 grant:seller_product_draft |  |  | src/pwa/routes/agent-grants.ts:531 |
| POST | `/api/agent/seller/products/:id/images` | 🎫 grant:seller_product_draft |  |  | src/pwa/routes/agent-grants.ts:584 |
| GET | `/api/agent/verifiability` |  |  |  | src/pwa/routes/public-utils.ts:358 |
| GET | `/api/agent/wallet` | 🎫 grant:wallet_read_minimal |  | RFC-026 PR-3 — 钱包最小只读(safe scope wallet_read_minimal;OAuth 钱包面永远只读) | src/pwa/routes/agent-grants.ts:452 |
| GET | `/api/agents/me/reputation` | 🔐 |  |  | src/pwa/routes/agent-reputation.ts:28 |
| POST | `/api/ai/generate-description` | 🔐 |  | G-1: AI 文案生成（卖家发品辅助） | src/pwa/routes/ai.ts:86 |
| POST | `/api/ai/price-suggestion` | 🔐 |  | G-2: AI 价格建议 | src/pwa/routes/ai.ts:30 |
| GET | `/api/anchor/:code/lookup` |  |  | GET /api/anchor/:code/lookup — 公开（无需 auth） | src/pwa/routes/anchors.ts:59 |
| POST | `/api/anchor/:code/retire` | 🔐 |  |  | src/pwa/routes/anchors.ts:166 |
| POST | `/api/anchor/:code/touch` | 🔐 |  | POST /api/anchor/:code/touch — 写 attribution（first-touch + 30d） | src/pwa/routes/anchors.ts:115 |
| POST | `/api/anchor/generate` | 🔐 |  | POST /api/anchor/generate | src/pwa/routes/anchors.ts:40 |
| GET | `/api/anchor/me` | 🔐 |  |  | src/pwa/routes/anchors.ts:176 |
| POST | `/api/announcements/:id/read` | 🔐 |  |  | src/pwa/routes/announcements.ts:112 |
| GET | `/api/announcements/active` | 🔐 |  | 列出对当前用户可见的活跃公告（按角色 + 区域过滤） | src/pwa/routes/announcements.ts:79 |
| POST | `/api/arbitrator/apply` | 🔐 |  |  | src/pwa/routes/arbitrator.ts:93 |
| GET | `/api/arbitrator/eligibility` | 🔐 |  |  | src/pwa/routes/arbitrator.ts:83 |
| GET | `/api/arbitrator/me/kpi` | 🔐 |  | Arbitrator KPI（仲裁累计 + 裁决分布 + pending） | src/pwa/routes/trusted-kpi.ts:70 |
| GET | `/api/arbitrator/pending-count` | 🔐 |  | 非仲裁员返回 0(不报错,前端 badge 拉取对所有人无害)。 | src/pwa/routes/disputes-read.ts:56 |
| GET | `/api/arbitrator/status` | 🔐 |  |  | src/pwa/routes/arbitrator.ts:88 |
| POST | `/api/arbitrator/withdraw-application` | 🔐 |  |  | src/pwa/routes/arbitrator.ts:144 |
| GET | `/api/auctions` |  |  | 看板：浏览公开拍卖（匿名可访问） | src/pwa/routes/auction.ts:221 |
| POST | `/api/auctions` | 🔐 |  | 卖家发起拍卖 | src/pwa/routes/auction.ts:110 |
| DELETE | `/api/auctions/:id` | 🔐 |  | 卖家：取消（仅未出价时） | src/pwa/routes/auction.ts:468 |
| GET | `/api/auctions/:id` | 🔐 |  | 详情：含 bid 历史（buyer 身份脱敏；卖家+出价人本人 可见全名） | src/pwa/routes/auction.ts:260 |
| POST | `/api/auctions/:id/bids` | 🔐 |  | 买家：出价 | src/pwa/routes/auction.ts:327 |
| DELETE | `/api/auctions/:id/remind` | 🔐 |  |  | src/pwa/routes/auction.ts:314 |
| GET | `/api/auctions/:id/remind` | 🔐 |  |  | src/pwa/routes/auction.ts:320 |
| POST | `/api/auctions/:id/remind` | 🔐 |  | 拍卖「⏰ 提醒我」(#959) | src/pwa/routes/auction.ts:291 |
| GET | `/api/auctions/mine` | 🔐 |  | 我的：买家=我出过价的，卖家=我发起的 | src/pwa/routes/auction.ts:246 |
| POST | `/api/auth/logout-all` | 🔐 |  | 要求密码二次验证（防 api_key 被盗后攻击者锁死真用户） | src/pwa/routes/auth-sessions.ts:69 |
| GET | `/api/auth/sessions` | 🔐 |  |  | src/pwa/routes/auth-sessions.ts:34 |
| POST | `/api/auth/sessions/:id/revoke` | 🔐 |  | 远程吊销某个会话（不影响当前 session） | src/pwa/routes/auth-sessions.ts:56 |
| DELETE | `/api/bids/:id` | 🔐 |  | 卖家：撤回 bid（释放 stake） | src/pwa/routes/rfqs.ts:450 |
| PATCH | `/api/bids/:id` | 🔐 |  | 卖家：修改 bid（仅 active；stake 差额自动结算） | src/pwa/routes/rfqs.ts:373 |
| GET | `/api/blocklist` | 🔐 |  | D-2: 列表 | src/pwa/routes/blocklist.ts:51 |
| DELETE | `/api/blocklist/:user_id` | 🔐 |  |  | src/pwa/routes/blocklist.ts:44 |
| POST | `/api/blocklist/:user_id` | 🔐 |  |  | src/pwa/routes/blocklist.ts:31 |
| GET | `/api/blocklist/:user_id/status` | 🔐 |  |  | src/pwa/routes/blocklist.ts:74 |
| GET | `/api/blocklist/me` | 🔐 |  |  | src/pwa/routes/blocklist.ts:64 |
| POST | `/api/build-feedback` | 🔐 |  | ── 提交 ────────────────────────────────────────────── | src/pwa/routes/build-feedback.ts:36 |
| GET | `/api/build-feedback/:id` | 🔐 |  |  | src/pwa/routes/build-feedback.ts:65 |
| GET | `/api/build-feedback/mine` | 🔐 |  | ── 闭环:我的反馈进度 ──(必须在 /:id 之前声明)────────── | src/pwa/routes/build-feedback.ts:60 |
| GET | `/api/build-reputation/me` | 🔐 |  | BUILD reputation (coordination layer) only and promise no economic value. | src/pwa/routes/build-reputation.ts:26 |
| GET | `/api/build-tasks` | 🔐 |  | uncommitted value_boundary; member scope hides restricted/internal. Bad filter → | src/pwa/routes/build-tasks.ts:45 |
| POST | `/api/build-tasks` | 🔐 |  |  | src/pwa/routes/build-tasks.ts:35 |
| GET | `/api/build-tasks/:id` | 🔐 |  |  | src/pwa/routes/build-tasks.ts:54 |
| POST | `/api/build-tasks/:id/claim` | 🔐 |  | task → claim respects auto_claimable. Success appends value_boundary + canonical | src/pwa/routes/build-tasks.ts:64 |
| POST | `/api/build-tasks/:id/release` | 🔐 |  |  | src/pwa/routes/build-tasks.ts:94 |
| POST | `/api/build-tasks/:id/submit` | 🔐 |  |  | src/pwa/routes/build-tasks.ts:76 |
| GET | `/api/cart` | 🔐 |  |  | src/pwa/routes/cart.ts:45 |
| POST | `/api/cart` | 🔐 |  |  | src/pwa/routes/cart.ts:60 |
| DELETE | `/api/cart/:product_id` | 🔐 |  |  | src/pwa/routes/cart.ts:127 |
| PATCH | `/api/cart/:product_id` | 🔐 |  |  | src/pwa/routes/cart.ts:75 |
| POST | `/api/cart/checkout` | 🔐 |  | C-1: 购物车批量下单（每个选中商品独立订单） | src/pwa/routes/cart.ts:84 |
| GET | `/api/charity/fund` |  |  | GET 基金概况 + 最近流水 | src/pwa/routes/charity.ts:696 |
| POST | `/api/charity/fund/donate` | 🔐 |  | 任何人捐款给慈善基金 | src/pwa/routes/charity.ts:654 |
| GET | `/api/charity/leaderboard` |  |  | 慈善排行 | src/pwa/routes/charity.ts:843 |
| GET | `/api/charity/me` | 🔐 |  | GET /api/charity/me — 我的慈善档案 | src/pwa/routes/charity.ts:499 |
| GET | `/api/charity/stories` |  |  | GET /api/charity/stories — 公开披露的故事板 | src/pwa/routes/charity.ts:521 |
| GET | `/api/check-url` | 🔐 |  |  | src/pwa/routes/search.ts:175 |
| POST | `/api/checkin` | 🔐 |  |  | src/pwa/routes/checkin-tasks.ts:78 |
| GET | `/api/checkin/status` | 🔐 |  |  | src/pwa/routes/checkin-tasks.ts:38 |
| GET | `/api/checkout/tax-preview` | 🔐 |  |  | src/pwa/routes/checkout-helpers.ts:30 |
| GET | `/api/claim-tasks/:id` | 🔐 |  | 任务详情 | src/pwa/routes/claim-verify.ts:603 |
| POST | `/api/claim-tasks/:id/seller-evidence` | 🔐 |  | 卖家提交证据 → 延期 24h；状态保持 open | src/pwa/routes/claim-verify.ts:622 |
| POST | `/api/claim-tasks/:id/vote` | 🔐 |  | verifier 投票 — 铁律 §4 | src/pwa/routes/claim-verify.ts:448 |
| GET | `/api/claim-tasks/available` | 🔐 |  | 列出可接的 open 任务 | src/pwa/routes/claim-verify.ts:422 |
| GET | `/api/claim-tasks/mine` | 🔐 |  | 我相关的任务（必须在 /:id 之前注册，否则被 /:id 截获） | src/pwa/routes/claim-verify.ts:510 |
| POST | `/api/claim-url` | 🔐 |  |  | src/pwa/routes/url-claim.ts:81 |
| GET | `/api/claims/public` |  |  | 公开 #claims 广场（无 auth — 透明性是验证声明信任的前提） | src/pwa/routes/claim-verify.ts:541 |
| GET | `/api/contribution-facts/me` | 🔐 |  | ── READ-ONLY: the caller's OWN attributable contribution facts (GitHub + admin c | src/pwa/routes/contribution-facts.ts:28 |
| POST | `/api/contribution-identity/github/claim-challenge` | 🔐 |  | ── 1) issue a publication challenge ──────────────────────────────────────────── | src/pwa/routes/contribution-identity.ts:80 |
| POST | `/api/contribution-identity/github/claim-complete` | 🔐 |  | ── 2) complete the claim (human gate → re-fetch gist proof → atomic consume+bind | src/pwa/routes/contribution-identity.ts:111 |
| GET | `/api/contribution-identity/github/claimable` | 🔐 |  | carries the uncommitted-value boundary, and errors never leak SQL/stack. | src/pwa/routes/contribution-identity.ts:207 |
| GET | `/api/contribution-identity/github/me` | 🔐 |  | metering/display surface can never read as a payout promise — facts + attributio | src/pwa/routes/contribution-identity.ts:193 |
| GET | `/api/contribution-score/evidence/me` | 🔐 |  | always the session user. Output is component evidence wrapped in the uncommitted | src/pwa/routes/contribution-score.ts:30 |
| GET | `/api/conversations` | 🔐 |  | 我的会话列表 | src/pwa/routes/chat.ts:121 |
| GET | `/api/conversations/:id` | 🔐 |  | 会话详情 + 消息分页 | src/pwa/routes/chat.ts:143 |
| POST | `/api/conversations/:id/archive` | 🔐 |  | 归档（仅自己侧） | src/pwa/routes/chat.ts:271 |
| POST | `/api/conversations/:id/block` | 🔐 |  | 拉黑（双向屏蔽） | src/pwa/routes/chat.ts:281 |
| POST | `/api/conversations/:id/messages` | 🔐 |  | 发消息 | src/pwa/routes/chat.ts:186 |
| POST | `/api/conversations/:id/read` | 🔐 |  | 标记已读 | src/pwa/routes/chat.ts:256 |
| POST | `/api/conversations/:id/report` | 🔐 |  | 举报（人工审核） | src/pwa/routes/chat.ts:291 |
| POST | `/api/conversations/start` | 🔐 |  | 开会话（idempotent — 已存在则返回 id） | src/pwa/routes/chat.ts:107 |
| POST | `/api/coupons` | 🔐 |  |  | src/pwa/routes/coupons.ts:77 |
| PATCH | `/api/coupons/:id` | 🔐 |  |  | src/pwa/routes/coupons.ts:164 |
| GET | `/api/coupons/available` | 🔐 |  | buyer 视角：全平台 + 已购卖家店铺/单品券 + 历史 | src/pwa/routes/coupons.ts:116 |
| GET | `/api/coupons/mine` | 🔐 |  |  | src/pwa/routes/coupons.ts:156 |
| GET | `/api/coupons/preview` | 🔐 |  |  | src/pwa/routes/search.ts:40 |
| GET | `/api/creator/stats` | 🔐 |  | 里程碑 L3：创作者贡献仪表盘 | src/pwa/routes/shareables.ts:216 |
| GET | `/api/direct-pay/availability` | 🔐 |  | GET /api/direct-pay/availability?product_id=... — 该商品(以 qty=1 计)当前是否可直付 + 不可用原因( | src/pwa/routes/direct-pay-availability.ts:40 |
| POST | `/api/direct-pay/disclosure-acks` | 🔐 |  | stage:'both' —— 单 stage token 冒充不了 both,both token 也重放不了单 stage(一次性消费 + validate | src/pwa/routes/direct-pay-disclosure-acks.ts:53 |
| GET | `/api/direct-pay/disclosure-acks/:orderId` | 🔐 |  | GET — 查询某单两次 ack 状态 + 买家视角披露文案(无卖家机制)。只读(本人),不需 gate token。 | src/pwa/routes/direct-pay-disclosure-acks.ts:75 |
| GET | `/api/direct-receive/accounts` | 🔐 |  | ── list（本人;不返回 raw QR,只含 qr_image_ref)── | src/pwa/routes/direct-receive-accounts.ts:59 |
| POST | `/api/direct-receive/accounts` | 🔐 |  | ── add(Passkey)── | src/pwa/routes/direct-receive-accounts.ts:76 |
| DELETE | `/api/direct-receive/accounts/:id` | 🔐 |  | ── deactivate(Passkey + owner)── | src/pwa/routes/direct-receive-accounts.ts:106 |
| PUT | `/api/direct-receive/accounts/:id` | 🔐 |  | ── update(Passkey + owner)── | src/pwa/routes/direct-receive-accounts.ts:90 |
| GET | `/api/direct-receive/accounts/:id/qr` | 🔐 |  | ── QR preview(owner-only read;硬化转发;不存在/非本人 → 404)── | src/pwa/routes/direct-receive-accounts.ts:131 |
| PUT | `/api/direct-receive/accounts/:id/qr` | 🔐 |  | ── upload / replace QR(Passkey + owner;immutable content-addressed store)── | src/pwa/routes/direct-receive-accounts.ts:120 |
| POST | `/api/direct-receive/bond-deposit` | 🔐 |  |  | src/pwa/routes/bond-seller.ts:87 |
| POST | `/api/direct-receive/bond-deposit/:id/cancel` | 🔐 |  |  | src/pwa/routes/bond-seller.ts:148 |
| POST | `/api/direct-receive/bond-refund-request` | 🔐 |  | ── B2:退出退还 —— 申请(§5 blockers fail-closed)→ 冷静期 → admin 执行;申请期间直付资格暂停,可撤销 ── | src/pwa/routes/bond-seller.ts:123 |
| POST | `/api/direct-receive/bond-refund-request/cancel` | 🔐 |  |  | src/pwa/routes/bond-seller.ts:139 |
| GET | `/api/direct-receive/bond-status` | 🔐 |  |  | src/pwa/routes/bond-seller.ts:54 |
| GET | `/api/direct-receive/deferral` | 🔐 |  | GET /api/direct-receive/deferral — 卖家本人缓交状态:最新一条申请(脱敏:不含 admin 身份)+ 是否当前生效(activ | src/pwa/routes/direct-pay-availability.ts:96 |
| POST | `/api/direct-receive/deferral` | 🔐 |  | POST /api/direct-receive/deferral — 卖家申请缓交。helper 强制:单一活跃、periodDays 正整数、id 唯一。 | src/pwa/routes/direct-pay-availability.ts:86 |
| POST | `/api/direct-receive/fee-prepay-request` | 🔐 |  | ── 提交预充值申请(不 Passkey;凭据必填)── | src/pwa/routes/fee-prepay-requests.ts:39 |
| POST | `/api/direct-receive/fee-prepay-request/:id/cancel` | 🔐 |  | ── 卖家撤销自己的 pending 申请 ── | src/pwa/routes/fee-prepay-requests.ts:67 |
| GET | `/api/direct-receive/fee-prepay-requests` | 🔐 |  | ── 卖家看自己的申请(全状态)── | src/pwa/routes/fee-prepay-requests.ts:61 |
| GET | `/api/direct-receive/my-fee-account` | 🔐 |  | 仅本人(requireSeller),买家拿不到;只读、不碰任何资金动作。供 seller fee center 展示。 | src/pwa/routes/direct-pay-availability.ts:109 |
| DELETE | `/api/direct-receive/payment-instruction` | 🔐 |  | DELETE — 停用卖家当前 active 收款说明(软停用,留历史为 inactive)。停用后 create route fail-closed。 | src/pwa/routes/direct-receive-payment-instructions.ts:55 |
| GET | `/api/direct-receive/payment-instruction` | 🔐 |  | GET — 卖家本人当前 active 收款说明;无则 instruction:null(200,显式空状态,便于 UI 渲染“尚未设置”)。 | src/pwa/routes/direct-receive-payment-instructions.ts:37 |
| PUT | `/api/direct-receive/payment-instruction` | 🔐 |  | PUT — 设置/替换卖家当前 active 收款说明。instruction 必填、trim、长度上限;label 可选、trim、长度上限。 | src/pwa/routes/direct-receive-payment-instructions.ts:43 |
| GET | `/api/direct-receive/platform-receive-accounts` | 🔐 |  | ── 卖家看平台收款方式(active;含 instruction + qr_data_uri —— 平台公开收款明细,据此付款)── | src/pwa/routes/fee-prepay-requests.ts:33 |
| POST | `/api/direct-receive/product-verification` | 🔐 |  | POST /api/direct-receive/product-verification — 卖家为某产品申领验证码(单一活跃 per product)。 | src/pwa/routes/direct-pay-availability.ts:129 |
| PUT | `/api/direct-receive/product-verification` | 🔐 |  | PUT /api/direct-receive/product-verification — 卖家为某产品提交外部商品链接(链接仅存储,WebAZ 不抓取)。 | src/pwa/routes/direct-pay-availability.ts:139 |
| GET | `/api/direct-receive/product-verifications` | 🔐 |  | GET /api/direct-receive/product-verifications — 卖家本人所有产品的认证状态(逐产品)。 | src/pwa/routes/direct-pay-availability.ts:150 |
| GET | `/api/direct-receive/readiness` | 🔐 |  | 绝不下发 raw blocker / KYB·制裁·AML 分项(见 sellerDirectPayReadinessView)。只读 self(auth 用户 | src/pwa/routes/direct-pay-availability.ts:76 |
| GET | `/api/direct-receive/selectable-accounts` | 🔐 |  | ⚠️ 只下发元数据 method/currency/label —— instruction 原文与 QR 受披露门保护,D1/D2 ack 后才随订单快照给买 | src/pwa/routes/direct-receive-accounts.ts:66 |
| GET | `/api/direct-receive/store-verification` | 🔐 |  | GET /api/direct-receive/store-verification — 卖家本人店铺认证状态(脱敏 DTO,含豁免位)。 | src/pwa/routes/direct-pay-availability.ts:178 |
| POST | `/api/direct-receive/store-verification` | 🔐 |  | POST /api/direct-receive/store-verification — 卖家申领店铺验证码(单一活跃 per seller)。 | src/pwa/routes/direct-pay-availability.ts:159 |
| PUT | `/api/direct-receive/store-verification` | 🔐 |  | PUT /api/direct-receive/store-verification — 卖家提交店铺外链(仅存储,不抓取)。 | src/pwa/routes/direct-pay-availability.ts:168 |
| GET | `/api/disputes` | 🔐 |  | 仲裁员：查看所有开放争议 | src/pwa/routes/disputes-read.ts:43 |
| GET | `/api/disputes/:id` | 🔐 |  | 详情聚合（含 W4 timeline + chain ruling） | src/pwa/routes/disputes-read.ts:129 |
| POST | `/api/disputes/:id/add-evidence` | 🔐 |  | 参与方主动举证（text）+ SNF 信封分发 | src/pwa/routes/disputes-write.ts:389 |
| POST | `/api/disputes/:id/arbitrate` | 🔐 |  | 仲裁员裁定 | src/pwa/routes/disputes-write.ts:131 |
| POST | `/api/disputes/:id/arbitrator-pause-auto-judge` | 🔐 |  |  | src/pwa/routes/disputes-write.ts:602 |
| POST | `/api/disputes/:id/arbitrator-resume-auto-judge` | 🔐 |  |  | src/pwa/routes/disputes-write.ts:699 |
| POST | `/api/disputes/:id/evidence-blob` | 🔐 |  | N: limit 精确 = EVIDENCE_MAX_BYTES | src/pwa/routes/disputes-write.ts:450 |
| GET | `/api/disputes/:id/evidence-list` | 🔐 |  | 当事人 + 仲裁员可查（meta only，blob 单独拉） | src/pwa/routes/disputes-read.ts:388 |
| GET | `/api/disputes/:id/parties` | 🔐 |  | 涉案三方（仲裁员选择发证据请求的对象） | src/pwa/routes/disputes-read.ts:400 |
| POST | `/api/disputes/:id/request-evidence` | 🔐 |  | 仲裁员：请求某方补证 | src/pwa/routes/disputes-write.ts:535 |
| POST | `/api/disputes/:id/respond` | 🔐 |  | 被诉方反驳 | src/pwa/routes/disputes-write.ts:107 |
| GET | `/api/disputes/:id/similar-cases` | 🔐 |  | A2 同类判例推荐 | src/pwa/routes/disputes-read.ts:64 |
| GET | `/api/disputes/cases` |  |  | 公开列表（全网）— 判例库总览 | src/pwa/routes/dispute-cases.ts:53 |
| GET | `/api/disputes/cases/:case_id` |  |  | 案件详情（含评论 + 评论者身份标签） | src/pwa/routes/dispute-cases.ts:109 |
| POST | `/api/disputes/cases/:case_id/comment` | 🔐 |  | 写评论 — 当事人禁评，一人一案一次 | src/pwa/routes/dispute-cases.ts:175 |
| POST | `/api/disputes/cases/:case_id/comments/:comment_id/reply` | 🔐 |  | W5 子回复 — 任意人可对顶层评论回复多次（不受"一人一案一次"限制） | src/pwa/routes/dispute-cases.ts:213 |
| POST | `/api/disputes/cases/:case_id/fairness` | 🔐 |  | 公正度投票（👍 / 👎）— 一人一案一票 | src/pwa/routes/dispute-cases.ts:246 |
| GET | `/api/disputes/cases/by-product/:product_id` |  |  | 公开列表（按商品） | src/pwa/routes/dispute-cases.ts:96 |
| GET | `/api/editor-picks` |  |  |  | src/pwa/routes/public-utils.ts:445 |
| POST | `/api/email-subscriptions` |  |  | 2026-05-26 加 role_preference + note 字段（welcome 表单丰富化） | src/pwa/routes/welcome.ts:162 |
| POST | `/api/email-subscriptions/unsubscribe` |  |  |  | src/pwa/routes/welcome.ts:212 |
| POST | `/api/error-report` |  |  |  | src/pwa/routes/public-utils.ts:525 |
| POST | `/api/evidence-requests/:requestId/submit` | 🔐 |  | 当事人提交补充证据响应（仲裁员 request 后用） | src/pwa/routes/evidence.ts:83 |
| DELETE | `/api/evidence/:id` | 🔐 |  | 撤回证据（仅上传者，争议未结案时） | src/pwa/routes/evidence.ts:58 |
| GET | `/api/evidence/:id/blob` | 🔐 |  | 下载证据 blob（仅参与方/仲裁员） | src/pwa/routes/evidence.ts:35 |
| GET | `/api/evidence/:id/verify` | 🔐 |  | 验签 — 任意参与方 | src/pwa/routes/evidence.ts:73 |
| POST | `/api/external-anchors` | 🔐 |  |  | src/pwa/routes/external-anchors.ts:38 |
| GET | `/api/external-anchors/:id` |  |  |  | src/pwa/routes/external-anchors.ts:90 |
| POST | `/api/external-anchors/:id/distribute-rewards` | 🔐 |  | 白名单(isEligibleArbitrator),不认 legacy user.role(否则已 suspend/revoke 但 role 未同步的账号仍可 | src/pwa/routes/external-anchors.ts:75 |
| POST | `/api/external-anchors/:id/issue-token` | 🔐 |  |  | src/pwa/routes/external-anchors.ts:107 |
| POST | `/api/external-anchors/:id/revoke` | 🔐 |  |  | src/pwa/routes/external-anchors.ts:100 |
| GET | `/api/external-anchors/:id/rewards` |  |  | 透出推荐 fee + anchor 的奖励情况 | src/pwa/routes/external-anchors.ts:56 |
| POST | `/api/external-anchors/:id/verify` | 🔐 |  | verifier 提交独立验证（任何已登录用户可做） | src/pwa/routes/external-anchors.ts:115 |
| GET | `/api/external-anchors/:id/verify-sig` | 🔐 |  |  | src/pwa/routes/external-anchors.ts:96 |
| GET | `/api/external-anchors/by-product/:id` |  |  |  | src/pwa/routes/external-anchors.ts:82 |
| GET | `/api/external-anchors/by-seller/:id` |  |  |  | src/pwa/routes/external-anchors.ts:86 |
| GET | `/api/feed` | 🔐 |  |  | src/pwa/routes/buyer-feeds.ts:128 |
| POST | `/api/feedback` | 🔐 |  |  | src/pwa/routes/feedback.ts:41 |
| GET | `/api/feedback/:id` | 🔐 |  | 工单详情 + timeline | src/pwa/routes/feedback.ts:160 |
| POST | `/api/feedback/:id/messages` | 🔐 |  | 工单内追加消息（user 或 admin） | src/pwa/routes/feedback.ts:241 |
| GET | `/api/feedback/mine` | 🔐 |  |  | src/pwa/routes/feedback.ts:81 |
| POST | `/api/feedback/seen` | 🔐 |  |  | src/pwa/routes/feedback.ts:98 |
| DELETE | `/api/flash-sales/:id` | 🔐 |  | 取消（仅 seller 自己，且未开始） | src/pwa/routes/flash-sales.ts:122 |
| GET | `/api/flash-sales/live` |  |  | buyer 视角：当前全平台正在进行的 flash sales（首屏 discovery） | src/pwa/routes/flash-sales.ts:135 |
| DELETE | `/api/follows/:user_id` | 🔐 |  |  | src/pwa/routes/follows.ts:53 |
| POST | `/api/follows/:user_id` | 🔐 |  |  | src/pwa/routes/follows.ts:35 |
| GET | `/api/follows/:user_id/status` | 🔐 |  |  | src/pwa/routes/follows.ts:27 |
| GET | `/api/follows/feed` | 🔐 |  | Wave D-1: 关注卖家动态 feed — new_product + restock 合并 + 去重 | src/pwa/routes/follows.ts:75 |
| GET | `/api/follows/me` | 🔐 |  |  | src/pwa/routes/follows.ts:59 |
| GET | `/api/fx/rates` |  |  |  | src/pwa/routes/fx.ts:19 |
| GET | `/api/governance/onboarding-stats` |  |  | 无 auth — agent / 用户 / 第三方都可读;不暴露 PII | src/pwa/routes/public-utils.ts:473 |
| POST | `/api/governance/onboarding/appeal` | 🔐 |  | 必须:source 行 action='auto_deactivate' + window 内 + 未已 appeal + reason 长度 | src/pwa/routes/governance-onboarding.ts:684 |
| POST | `/api/governance/onboarding/apply` | 🔐 |  |  | src/pwa/routes/governance-onboarding.ts:78 |
| POST | `/api/governance/onboarding/case-review` | 🔐 |  | 不立即评分 — maintainer 上岗签字前(阶段 3 #1093)对比 expected_verdict | src/pwa/routes/governance-onboarding.ts:300 |
| GET | `/api/governance/onboarding/cases` | 🔐 |  | 实施 docs/GOVERNANCE-ONBOARDING.md §4.2 案例研读 | src/pwa/routes/governance-onboarding.ts:285 |
| GET | `/api/governance/onboarding/my` | 🔐 |  |  | src/pwa/routes/governance-onboarding.ts:189 |
| GET | `/api/governance/onboarding/progress` | 🔐 |  | 返回 onboarding 整体进度(spec §4):申请状态 + 学习包(client localStorage) + 题目分数 + 案例(后续) | src/pwa/routes/governance-onboarding.ts:881 |
| GET | `/api/governance/onboarding/quiz` | 🔐 |  | 实施 docs/GOVERNANCE-ONBOARDING.md §4.3 题目 | src/pwa/routes/governance-onboarding.ts:207 |
| POST | `/api/governance/onboarding/quiz-submit` | 🔐 |  | body: { role, answers: [{question_id, answer}] } | src/pwa/routes/governance-onboarding.ts:220 |
| POST | `/api/governance/onboarding/resign` | 🔐 |  | confirm_text 必须等于 'RESIGN arbitrator' 或 'RESIGN verifier'(type-to-confirm 防误触) | src/pwa/routes/governance-onboarding.ts:554 |
| GET | `/api/governance/params` |  |  | ─── 治理参数 ──────────────────────────────────────────────── | src/pwa/routes/payments-governance.ts:52 |
| GET | `/api/governance/params/:key/history` |  |  |  | src/pwa/routes/payments-governance.ts:75 |
| POST | `/api/group-buys` | 🔐 |  | 卖家开团 | src/pwa/routes/group-buys.ts:110 |
| GET | `/api/group-buys/:id` |  |  | 详情 + participants | src/pwa/routes/group-buys.ts:152 |
| POST | `/api/group-buys/:id/join` | 🔐 |  | 加入团购 | src/pwa/routes/group-buys.ts:172 |
| DELETE | `/api/group-buys/:id/leave` | 🔐 |  | 离开团购 | src/pwa/routes/group-buys.ts:204 |
| GET | `/api/group-buys/live` |  |  | 公开列表 | src/pwa/routes/group-buys.ts:137 |
| GET | `/api/growth/tasks` | 🔐 |  |  | src/pwa/routes/growth.ts:201 |
| POST | `/api/growth/tasks/:id/claim` | 🔐 |  |  | src/pwa/routes/growth.ts:207 |
| POST | `/api/growth/tasks/:id/reset` | 🔐 |  |  | src/pwa/routes/growth.ts:229 |
| POST | `/api/growth/tasks/:id/skip` | 🔐 |  |  | src/pwa/routes/growth.ts:218 |
| GET | `/api/health` |  |  |  | src/pwa/routes/public-utils.ts:52 |
| POST | `/api/import-product` | 🔐 |  |  | src/pwa/routes/import-product.ts:35 |
| GET | `/api/kyc/me` | 🔐 |  |  | src/pwa/routes/kyc.ts:51 |
| POST | `/api/kyc/submit` | 🔐 |  |  | src/pwa/routes/kyc.ts:29 |
| GET | `/api/launch-pulse` |  |  |  | src/pwa/routes/public-utils.ts:282 |
| GET | `/api/leaderboard` |  |  |  | src/pwa/routes/leaderboard.ts:73 |
| POST | `/api/link-challenges/:id/verify` | 🔐 |  |  | src/pwa/routes/url-claim.ts:33 |
| GET | `/api/listings` |  |  | 列表搜索（公开） | src/pwa/routes/listings.ts:82 |
| POST | `/api/listings` | 🔐 |  | 创建 listing（首创者） | src/pwa/routes/listings.ts:205 |
| GET | `/api/listings/:id` |  |  | 详情 + offers 加权排序 | src/pwa/routes/listings.ts:131 |
| POST | `/api/listings/:id/offers` | 🔐 |  | 跟卖：为已有 listing 创建本卖家的 product（即一个 offer） | src/pwa/routes/listings.ts:261 |
| GET | `/api/listings/mine` | 🔐 |  | 我的跟卖 | src/pwa/routes/listings.ts:110 |
| POST | `/api/login` |  |  |  | src/pwa/routes/auth-login.ts:31 |
| GET | `/api/logistics/companies` |  |  |  | src/pwa/routes/logistics.ts:26 |
| GET | `/api/logistics/me/performance` | 🔐 |  | 物流绩效卡 (Wave B-4) | src/pwa/routes/analytics.ts:36 |
| GET | `/api/logistics/orders` | 🔐 |  |  | src/pwa/routes/logistics.ts:33 |
| GET | `/api/logistics/return-pickups` | 🔐 |  |  | src/pwa/routes/returns.ts:450 |
| GET | `/api/manifest` |  |  |  | src/pwa/routes/public-utils.ts:467 |
| POST | `/api/manifests` | 🔐 |  |  | src/pwa/routes/manifests.ts:52 |
| GET | `/api/manifests/:hash` | 🔐 |  |  | src/pwa/routes/manifests.ts:101 |
| PATCH | `/api/manifests/:hash/takedown` | 🔐 |  |  | src/pwa/routes/manifests.ts:162 |
| GET | `/api/manifests/:hash/thumb` |  |  | Only the low-res thumbnail is exposed (never full-res / metadata / other columns | src/pwa/routes/manifests.ts:123 |
| GET | `/api/manifests/by-anchor/:anchor` | 🔐 |  |  | src/pwa/routes/manifests.ts:151 |
| GET | `/api/manifests/by-product/:pid` | 🔐 |  |  | src/pwa/routes/manifests.ts:140 |
| GET | `/api/manifests/me` | 🔐 |  |  | src/pwa/routes/manifests.ts:90 |
| POST | `/api/mcp-telemetry` |  |  |  | src/pwa/routes/public-utils.ts:74 |
| GET | `/api/me` | 🔐 |  |  | src/pwa/routes/auth-read.ts:29 |
| GET | `/api/me/agents` | 🔐 |  | /api/me/agents — 列出本账号所有 agent + declaration / strikes | src/pwa/routes/agent-governance.ts:61 |
| GET | `/api/me/agents/:apiKeyPrefix/log` | 🔐 |  |  | src/pwa/routes/agent-governance.ts:180 |
| GET | `/api/me/agents/:apiKeyPrefix/passport` | 🔐 |  | issuer 同时给 did:web:webaz.xyz(标准 DID method)+ 原 did:webaz:0x... 地址(向后兼容)。 | src/pwa/routes/agent-governance.ts:108 |
| POST | `/api/me/agents/:apiKeyPrefix/revoke` | 🔐 |  | 用户撤销 agent（铁律 §4 human presence） | src/pwa/routes/agent-governance.ts:238 |
| POST | `/api/me/agents/attestations` | 🔐 |  | bilateral attestation（用户批准某 agent 的 scope） | src/pwa/routes/agent-governance.ts:358 |
| POST | `/api/me/agents/declarations` | 🔐 |  |  | src/pwa/routes/agent-governance.ts:194 |
| POST | `/api/me/agents/operators/:operator_name/revoke` | 🔐 |  | 撤销同 operator 名下所有 agent（仅撤销本用户给 operator 旗下 agent 的 attestation） | src/pwa/routes/agent-governance.ts:259 |
| POST | `/api/me/agents/strikes/:strikeId/appeal` | 🔐 |  | P0 audit fix 4.2: 申诉 strike | src/pwa/routes/agent-governance.ts:280 |
| POST | `/api/me/delete-cancel` | 🔐 |  |  | src/pwa/routes/account-deletion.ts:58 |
| POST | `/api/me/delete-request` | 🔐 |  |  | src/pwa/routes/account-deletion.ts:33 |
| GET | `/api/me/delete-status` | 🔐 |  |  | src/pwa/routes/account-deletion.ts:70 |
| GET | `/api/me/export` | 🔐 |  | COP P0-1: 数据导出（用户主权） | src/pwa/routes/me-data.ts:69 |
| GET | `/api/me/note-prompts` | 🔐 |  | COP 飞轮: 完成订单 7d 引导发笔记 | src/pwa/routes/me-data.ts:30 |
| GET | `/api/me/notify-claim-tasks` | 🔐 |  |  | src/pwa/routes/claim-verify.ts:534 |
| POST | `/api/me/notify-claim-tasks` | 🔐 |  | 通知偏好 | src/pwa/routes/claim-verify.ts:528 |
| GET | `/api/me/operator-claim-confirmations` | 🔐 |  | ── contributor: claims pointing at ME awaiting my confirmation ── | src/pwa/routes/admin-operator-claims.ts:99 |
| POST | `/api/me/operator-claim-confirmations/:claimedEventId` | 🔐 |  | ── contributor accepts/rejects a claim pointing at them ── | src/pwa/routes/admin-operator-claims.ts:105 |
| GET | `/api/me/operator-claims` | 🔐 |  | ── contributor self-view: ALL relationships pointing at me (pending/confirmed/ap | src/pwa/routes/admin-operator-claims.ts:179 |
| POST | `/api/me/operator-claims/:approvedEventId/request-unlink` | 🔐 |  | ── EITHER PARTY requests UNLINK of an active approved claim — passkey-gated (not | src/pwa/routes/admin-operator-claims.ts:185 |
| GET | `/api/me/quota-requests` | 🔐 |  | list my own requests + current remaining temporary quota | src/pwa/routes/build-task-quota.ts:66 |
| POST | `/api/me/quota-requests` | 🔐 |  | submit a quota-increase request | src/pwa/routes/build-task-quota.ts:49 |
| GET | `/api/me/seller/trial-campaigns` | 🔐 |  | 卖家：我的测评活动列表（含每个的 claims 计数） | src/pwa/routes/trial.ts:329 |
| GET | `/api/me/task-proposals` | 🔐 |  | proposer-facing read: the caller's OWN proposals + status + public_reply (agent- | src/pwa/routes/task-proposals.ts:72 |
| GET | `/api/me/trial-claims` | 🔐 |  | 买家：我的测评列表 | src/pwa/routes/trial.ts:316 |
| GET | `/api/my-products` | 🔐 |  |  | src/pwa/routes/search.ts:51 |
| GET | `/api/nearby` | 🔐 |  | window: 24h / 7d / 30d | src/pwa/routes/buyer-feeds.ts:183 |
| GET | `/api/notes` |  |  | sort=following: 需登录，仅显示 follows.followee_id 的笔记 | src/pwa/routes/shareables.ts:322 |
| POST | `/api/notes/photo` | 🔐 |  | Phase C2 笔记图片上传 — raw blob，sha256 重算，返回 hash + dedup | src/pwa/routes/shareables.ts:51 |
| GET | `/api/notes/photo/:hash` |  |  | 笔记图片下载 — 公开（笔记 landing page 公开可读，图也得公开） | src/pwa/routes/shareables.ts:78 |
| GET | `/api/notifications` | 🔐 |  |  | src/pwa/routes/notifications.ts:57 |
| POST | `/api/notifications/read` | 🔐 |  |  | src/pwa/routes/notifications.ts:65 |
| GET | `/api/notifications/stream` |  |  | SSE 实时推送流（EventSource 不支持自定义 header，URL ?key= 也兼容） | src/pwa/routes/notifications.ts:30 |
| DELETE | `/api/offers/:id` | 🔐 |  | 撤回 offer（status=warehouse + 释放 stake；不真删 product） | src/pwa/routes/offers.ts:70 |
| PATCH | `/api/offers/:id` | 🔐 |  |  | src/pwa/routes/offers.ts:33 |
| POST | `/api/offers/:id/refresh` | 🔐 |  | 刷新 freshness（卖家点 "现货确认"） | src/pwa/routes/offers.ts:105 |
| GET | `/api/orders` | 🔐 |  |  | src/pwa/routes/orders-read.ts:48 |
| POST | `/api/orders` | 🔐 |  |  | src/pwa/routes/orders-create.ts:119 |
| GET | `/api/orders/:id` | 🔐 |  |  | src/pwa/routes/orders-read.ts:174 |
| POST | `/api/orders/:id/action` | 🔐 |  | 通用状态机 action — accept/ship/pickup/transit/deliver/confirm/dispute | src/pwa/routes/orders-action.ts:174 |
| GET | `/api/orders/:id/cancel-refund` | 🔐 |  |  | src/pwa/routes/direct-pay-cancel-refund.ts:48 |
| POST | `/api/orders/:id/cancel-refund/confirm` | 🔐 |  |  | src/pwa/routes/direct-pay-cancel-refund.ts:93 |
| POST | `/api/orders/:id/cancel-refund/decline` | 🔐 |  |  | src/pwa/routes/direct-pay-cancel-refund.ts:65 |
| POST | `/api/orders/:id/cancel-refund/mark-refunded` | 🔐 |  |  | src/pwa/routes/direct-pay-cancel-refund.ts:74 |
| POST | `/api/orders/:id/cancel-refund/request` | 🔐 |  |  | src/pwa/routes/direct-pay-cancel-refund.ts:55 |
| POST | `/api/orders/:id/cancel-refund/withdraw` | 🔐 |  |  | src/pwa/routes/direct-pay-cancel-refund.ts:84 |
| GET | `/api/orders/:id/chain` | 🔐 |  | 订单签名链 — 当事人 + 白名单仲裁员(涉争议订单) + admin 可查 | src/pwa/routes/orders-read.ts:143 |
| GET | `/api/orders/:id/claim-task` | 🔐 |  | 通过 order_id 查关联 task | src/pwa/routes/claim-verify.ts:409 |
| POST | `/api/orders/:id/claim-verification` | 🔐 |  | 买家发起 claim 验证任务（绑定 paid 及之后的订单） | src/pwa/routes/claim-verify.ts:331 |
| POST | `/api/orders/:id/confirm-in-person` | 🔐 |  | 买家确认面交完成 → 直接 completed + settleOrder | src/pwa/routes/orders-action.ts:142 |
| GET | `/api/orders/:id/direct-pay-qr` | 🔐 |  | 取【当时那一版】图字节。未 ack / 非买家 / 无 QR / 非 direct_p2p → 统一 404(不枚举,不泄露)。图字节不入 order JSON | src/pwa/routes/orders-read.ts:282 |
| POST | `/api/orders/:id/force-timeout-check` | 🔐 |  | 手动触发超时判责（当事人） | src/pwa/routes/orders-action.ts:732 |
| GET | `/api/orders/:id/mutual-cancel` | 🔐 |  |  | src/pwa/routes/mutual-cancel.ts:35 |
| POST | `/api/orders/:id/mutual-cancel/accept` | 🔐 |  |  | src/pwa/routes/mutual-cancel.ts:50 |
| POST | `/api/orders/:id/mutual-cancel/decline` | 🔐 |  |  | src/pwa/routes/mutual-cancel.ts:61 |
| POST | `/api/orders/:id/mutual-cancel/propose` | 🔐 |  |  | src/pwa/routes/mutual-cancel.ts:42 |
| POST | `/api/orders/:id/mutual-cancel/withdraw` | 🔐 |  |  | src/pwa/routes/mutual-cancel.ts:68 |
| POST | `/api/orders/:id/pending-accept/accept` | 🔐 |  | 卖家确认接单 → 开付款窗口(deadline 此刻起表;收款信息此刻起买家可见 —— orders-read 状态门放行) | src/pwa/routes/direct-pay-pending-accept.ts:83 |
| POST | `/api/orders/:id/pending-accept/cancel` | 🔐 |  | 买家撤单(接单前反悔)→ 无责取消 + 回补库存 | src/pwa/routes/direct-pay-pending-accept.ts:179 |
| POST | `/api/orders/:id/pending-accept/confirm-quote` | 🔐 |  | CAS:仅 pending_accept 且已报价;总额变更与状态转移同一 db.transaction(要么全生效要么全回滚)。 | src/pwa/routes/direct-pay-pending-accept.ts:153 |
| POST | `/api/orders/:id/pending-accept/decline` | 🔐 |  | 卖家谢绝(无法发货/物流不可达等;理由可选,买家可见)→ 无责取消 + 回补库存 | src/pwa/routes/direct-pay-pending-accept.ts:105 |
| POST | `/api/orders/:id/pending-accept/quote` | 🔐 |  | 可重复报价(买家确认前修正);每次报价重置响应窗(param direct_pay.quote_confirm_hours,默认 48h)。 | src/pwa/routes/direct-pay-pending-accept.ts:127 |
| GET | `/api/orders/:order_id/buyer-rating` | 🔐 |  | 查 seller → buyer 评价（双盲遮蔽：buyer 看不到，除非自己也评过 OR 窗口到期） | src/pwa/routes/ratings.ts:113 |
| POST | `/api/orders/:order_id/buyer-rating` | 🔐 |  | seller → buyer 反向评价 | src/pwa/routes/ratings.ts:83 |
| GET | `/api/orders/:order_id/rating` | 🔐 |  | 查 buyer → seller 评价（双盲遮蔽：seller 视角同样） | src/pwa/routes/ratings.ts:132 |
| POST | `/api/orders/:order_id/rating` | 🔐 |  | buyer → seller 评价（一单一评，仅 completed 订单可评） | src/pwa/routes/ratings.ts:50 |
| POST | `/api/orders/:order_id/rating/followup` | 🔐 |  | W3 买家追问 — 在卖家 reply 后可追问一次 | src/pwa/routes/ratings.ts:169 |
| POST | `/api/orders/:order_id/rating/reply` | 🔐 |  |  | src/pwa/routes/ratings.ts:150 |
| GET | `/api/orders/:order_id/return-request` | 🔐 |  | P1-5: 订单级直查 | src/pwa/routes/returns.ts:194 |
| POST | `/api/orders/:order_id/return-request` | 🔐 |  | buyer 发起退货 | src/pwa/routes/returns.ts:127 |
| POST | `/api/orders/batch-ship` | 🔐 |  | C-4: 卖家批量发货 | src/pwa/routes/orders-action.ts:91 |
| GET | `/api/orders/export` | 🔐 |  | Wave D-2: 订单导出 CSV | src/pwa/routes/orders-read.ts:79 |
| GET | `/api/p2p-products` |  |  | 公开：列表 | src/pwa/routes/p2p-products.ts:177 |
| POST | `/api/p2p-products` | 🔐 |  | 发布 / 重发 P2P 商品 | src/pwa/routes/p2p-products.ts:48 |
| DELETE | `/api/p2p-products/:id` | 🔐 |  | 下架（保留行 + status='warehouse'，在途订单 hash 仍可证） | src/pwa/routes/p2p-products.ts:165 |
| GET | `/api/p2p-products/:id` |  |  | 公开：详情（含 hash + peer_endpoint） | src/pwa/routes/p2p-products.ts:192 |
| PATCH | `/api/p2p-products/:id` | 🔐 |  | 更新（重发 hash + signature，价格/库存/标题可改；旧 hash 给在途订单保留） | src/pwa/routes/p2p-products.ts:105 |
| GET | `/api/payment-methods` |  |  | ─── 公共支付方法 ─────────────────────────────────────────── | src/pwa/routes/payments-governance.ts:89 |
| GET | `/api/payment-methods/for-region` |  |  | 某地区可用方法（fallback 到 global） | src/pwa/routes/payments-governance.ts:98 |
| GET | `/api/payment-methods/log` |  |  | 公共变更审计日志（COP transparency） | src/pwa/routes/payments-governance.ts:125 |
| DELETE | `/api/peers/:hash` | 🔐 |  |  | src/pwa/routes/peers.ts:46 |
| POST | `/api/peers/heartbeat` | 🔐 |  |  | src/pwa/routes/peers.ts:25 |
| POST | `/api/pin-receipts` | 🔐 |  |  | src/pwa/routes/pin-receipts.ts:29 |
| GET | `/api/pin-receipts/mine` | 🔐 |  |  | src/pwa/routes/pin-receipts.ts:53 |
| POST | `/api/product-share/touch` | 🔐 |  | 商品分享归因落库（前端登录后首次进入带 share_id 时调用） | src/pwa/routes/share-redirects.ts:129 |
| GET | `/api/products` |  |  |  | src/pwa/routes/products-list.ts:58 |
| POST | `/api/products` | 🔐 |  |  | src/pwa/routes/products-create.ts:307 |
| DELETE | `/api/products/:id` | 🔐 |  | 硬删（仅 deleted 状态 + 无进行中订单） | src/pwa/routes/products-crud.ts:71 |
| GET | `/api/products/:id` |  |  | 卖家可查看自己的非上架商品（编辑页用），其他人只能看 active | src/pwa/routes/products-crud.ts:33 |
| PUT | `/api/products/:id` | 🔐 |  |  | src/pwa/routes/products-update.ts:44 |
| GET | `/api/products/:id/aliases` | 🔐 |  | M7.2-7: alias CRUD（仅商品 owner） | src/pwa/routes/products-aliases.ts:46 |
| POST | `/api/products/:id/aliases` | 🔐 |  |  | src/pwa/routes/products-aliases.ts:56 |
| DELETE | `/api/products/:id/aliases/:aliasId` | 🔐 |  |  | src/pwa/routes/products-aliases.ts:118 |
| GET | `/api/products/:id/can-share` | 🔐 |  | 分享许可：是否真实收货完成该商品(经过 confirmed,排除退款/违约/争议终态) | src/pwa/routes/products-meta.ts:174 |
| POST | `/api/products/:id/claim` | 🔐 |  |  | src/pwa/routes/products-claims.ts:39 |
| GET | `/api/products/:id/claims` |  |  | 公开：列出某商品的全部声明（含已结算） | src/pwa/routes/products-claims.ts:95 |
| GET | `/api/products/:id/external-links` | 🔐 |  | array the seller workbench consumes; that stays untouched). Only public-safe col | src/pwa/routes/products-links.ts:51 |
| POST | `/api/products/:id/get-or-create-share` | 🔐 |  | 获取或创建商品 shareable（被 sharePromoLink 用，走 /s/<id> 短链） | src/pwa/routes/products-meta.ts:185 |
| GET | `/api/products/:id/links` | 🔐 |  |  | src/pwa/routes/products-links.ts:39 |
| POST | `/api/products/:id/links` | 🔐 |  | 新链接（无人认领）直接 verified=1；已被他人认领则发起众包验证任务 | src/pwa/routes/products-links.ts:62 |
| DELETE | `/api/products/:id/links/:linkId` | 🔐 |  |  | src/pwa/routes/products-links.ts:194 |
| GET | `/api/products/:id/preview` |  |  | 公开预览：未登录可调，返回最小公开信息（分享 banner 用） | src/pwa/routes/products-meta.ts:162 |
| GET | `/api/products/:id/price-history` |  |  |  | src/pwa/routes/products-meta.ts:58 |
| GET | `/api/products/:id/shipping-options` |  |  | 公开读:买家下单前查配送范围。生效 = 单品覆盖 ?? 店铺默认;template=null → 不按地区计费(下单不要求选地区)。 | src/pwa/routes/shipping-templates.ts:144 |
| PATCH | `/api/products/:id/status` | 🔐 |  | 状态切换（active / warehouse / deleted） | src/pwa/routes/products-crud.ts:49 |
| GET | `/api/products/:product_id/flash-sale` |  |  | 公开：商品当前生效的 flash sale | src/pwa/routes/flash-sales.ts:102 |
| POST | `/api/products/:product_id/flash-sale` | 🔐 |  |  | src/pwa/routes/flash-sales.ts:58 |
| GET | `/api/products/:product_id/qa` |  |  |  | src/pwa/routes/wishlist-qa.ts:125 |
| POST | `/api/products/:product_id/qa` | 🔐 |  | ─── Wave A-2: 商品 Q&A ───────────────────────────────── | src/pwa/routes/wishlist-qa.ts:88 |
| POST | `/api/products/:product_id/qa/:qa_id/answer` | 🔐 |  |  | src/pwa/routes/wishlist-qa.ts:108 |
| POST | `/api/products/:product_id/qa/:qa_id/helpful` | 🔐 |  |  | src/pwa/routes/wishlist-qa.ts:137 |
| GET | `/api/products/:product_id/ratings` |  |  | 公开：商品评价 + 聚合（仅展示双盲已揭晓的） | src/pwa/routes/ratings.ts:184 |
| DELETE | `/api/products/:product_id/trial-campaign` | 🔐 |  | 卖家关闭活动（仍允许 pending claims 完成评估） | src/pwa/routes/trial.ts:199 |
| GET | `/api/products/:product_id/trial-campaign` |  |  | 公开查询商品的活动状态（任何人） | src/pwa/routes/trial.ts:209 |
| POST | `/api/products/:product_id/trial-campaign` | 🔐 |  | 卖家：开/更新活动 | src/pwa/routes/trial.ts:159 |
| POST | `/api/products/:product_id/trial-claim` | 🔐 |  | P1: 新账号 < 3 天禁申请；IP/UA 与卖家 session 重叠 → 标 account_link 审计 flag | src/pwa/routes/trial.ts:221 |
| GET | `/api/products/:product_id/variants` |  |  | 公开列出（含 buyer 下单页查可选项） | src/pwa/routes/variants.ts:39 |
| POST | `/api/products/:product_id/variants` | 🔐 |  |  | src/pwa/routes/variants.ts:56 |
| DELETE | `/api/products/:product_id/variants/:variant_id` | 🔐 |  |  | src/pwa/routes/variants.ts:133 |
| PATCH | `/api/products/:product_id/variants/:variant_id` | 🔐 |  |  | src/pwa/routes/variants.ts:90 |
| DELETE | `/api/products/:product_id/waitlist` | 🔐 |  |  | src/pwa/routes/waitlist.ts:50 |
| POST | `/api/products/:product_id/waitlist` | 🔐 |  |  | src/pwa/routes/waitlist.ts:35 |
| GET | `/api/products/:product_id/waitlist/check` | 🔐 |  |  | src/pwa/routes/waitlist.ts:71 |
| GET | `/api/products/:product_id/waitlist/count` | 🔐 |  | seller 查 waitlist count（决定备多少货） | src/pwa/routes/waitlist.ts:78 |
| POST | `/api/products/extract-aliases` | 🔐 |  | M7.2-5: 从外部原文提取候选 alias | src/pwa/routes/products-aliases.ts:36 |
| GET | `/api/profile` | 🔐 |  |  | src/pwa/routes/auth-read.ts:48 |
| PATCH | `/api/profile` | 🔐 |  | 通用 profile patch（search_anchor / bio / feed_visible） | src/pwa/routes/profile-prefs.ts:99 |
| POST | `/api/profile/add-role` | 🔐 |  |  | src/pwa/routes/profile-identity.ts:41 |
| POST | `/api/profile/bind-email` | 🔐 |  | 绑定邮箱 — 步骤 1：发码 | src/pwa/routes/profile-credentials.ts:87 |
| POST | `/api/profile/bind-placement` | 🔐 |  |  | src/pwa/routes/profile-placement.ts:55 |
| POST | `/api/profile/change-handle` | 🔐 |  | 改 handle：累进式冷却 — 第 N 次改需距上次 N × 12 月 | src/pwa/routes/profile-identity.ts:142 |
| POST | `/api/profile/change-name` | 🔐 |  |  | src/pwa/routes/profile-identity.ts:129 |
| POST | `/api/profile/clear-location` | 🔐 |  |  | src/pwa/routes/profile-location.ts:56 |
| POST | `/api/profile/confirm-email` | 🔐 |  | 绑定邮箱 — 步骤 2：确认验证码 | src/pwa/routes/profile-credentials.ts:109 |
| POST | `/api/profile/default-address` | 🔐 |  | 默认地址（结构化 + 兼容旧 text/region） | src/pwa/routes/profile-prefs.ts:31 |
| PATCH | `/api/profile/feed-visible` | 🔐 |  | 隐私开关（旧 API，向后兼容；新代码用 PATCH /api/profile） | src/pwa/routes/profile-prefs.ts:91 |
| POST | `/api/profile/placement-pref` | 🔐 |  |  | src/pwa/routes/profile-placement.ts:88 |
| GET | `/api/profile/placement-status` | 🔐 |  |  | src/pwa/routes/profile-placement.ts:40 |
| POST | `/api/profile/region` | 🔐 |  |  | src/pwa/routes/profile-identity.ts:97 |
| POST | `/api/profile/remove-password` | 🔐 |  | 移除密码（恢复只用 API Key 模式） | src/pwa/routes/profile-credentials.ts:74 |
| POST | `/api/profile/set-location` | 🔐 |  |  | src/pwa/routes/profile-location.ts:37 |
| POST | `/api/profile/set-password` | 🔐 |  | 设置 / 修改密码 | src/pwa/routes/profile-credentials.ts:43 |
| POST | `/api/profile/switch-role` | 🔐 |  |  | src/pwa/routes/profile-identity.ts:79 |
| POST | `/api/profile/verify-password` | 🔐 |  | 验证密码（显示 API Key 前的二次确认） | src/pwa/routes/profile-credentials.ts:62 |
| GET | `/api/promoter/dashboard` | 🔐 |  |  | src/pwa/routes/promoter.ts:39 |
| GET | `/api/promoter/team` | 🔐 |  | 直推 L1 列表 | src/pwa/routes/promoter.ts:207 |
| GET | `/api/protocol-status` |  |  |  | src/pwa/routes/public-utils.ts:228 |
| POST | `/api/public-ideas` |  |  | 反 bot：honeypot 字段 + 单 IP+UA 联合 rate limit 5/h + 内容 hash 去重 1h | src/pwa/routes/welcome.ts:135 |
| GET | `/api/public/build-tasks` |  |  |  | src/pwa/routes/public-build-tasks.ts:24 |
| GET | `/api/public/build-tasks/:id` |  |  |  | src/pwa/routes/public-build-tasks.ts:31 |
| POST | `/api/public/task-proposals` |  |  | public submit — anonymous; proposer_account_id is never taken from the body (ant | src/pwa/routes/task-proposals.ts:56 |
| GET | `/api/push/status` | 🔐 |  |  | src/pwa/routes/push.ts:74 |
| DELETE | `/api/push/subscribe` | 🔐 |  |  | src/pwa/routes/push.ts:63 |
| POST | `/api/push/subscribe` | 🔐 |  |  | src/pwa/routes/push.ts:44 |
| GET | `/api/push/vapid-public-key` | 🔐 |  |  | src/pwa/routes/push.ts:39 |
| GET | `/api/qr` |  |  | 二维码生成（24h cache + ETag） | src/pwa/routes/share-redirects.ts:52 |
| GET | `/api/recommendations/me` | 🔐 |  |  | src/pwa/routes/buyer-feeds.ts:31 |
| POST | `/api/recover-key` |  |  |  | src/pwa/routes/recover-key.ts:51 |
| POST | `/api/recover-key/confirm` |  |  | 安全等价:本端点本就返回完整 api_key(最高凭证),允许同时重置密码不扩大权限面 —— 验证码已是同等门槛。 | src/pwa/routes/recover-key.ts:134 |
| POST | `/api/recover-key/start` |  |  | 步骤 1：发送验证码到已绑定邮箱（防泄露：找没找到都同响应） | src/pwa/routes/recover-key.ts:101 |
| GET | `/api/referral/me` | 🔐 |  | B-1: 个人邀请 dashboard | src/pwa/routes/referral.ts:27 |
| POST | `/api/register` |  |  |  | src/pwa/routes/auth-register.ts:103 |
| POST | `/api/register/send-code` |  |  | 注册场景需明确告知"邮箱已占用"(无法防枚举,标准取舍),但限流 + captcha 兜底。 | src/pwa/routes/auth-register.ts:71 |
| GET | `/api/reputation` | 🔐 |  |  | src/pwa/routes/reputation.ts:29 |
| GET | `/api/reputation/:userId` |  |  |  | src/pwa/routes/reputation.ts:44 |
| GET | `/api/return-requests` | 🔐 |  |  | src/pwa/routes/returns.ts:211 |
| DELETE | `/api/return-requests/:id` | 🔐 |  |  | src/pwa/routes/returns.ts:298 |
| GET | `/api/return-requests/:id` | 🔐 |  | ─── W2 售后协商时间线 ─────────────────────────────── | src/pwa/routes/returns.ts:309 |
| POST | `/api/return-requests/:id/confirm-refund` | 🔐 |  |  | src/pwa/routes/direct-pay-returns.ts:50 |
| POST | `/api/return-requests/:id/decide` | 🔐 |  |  | src/pwa/routes/returns.ts:237 |
| POST | `/api/return-requests/:id/escalate` | 🔐 |  | buyer 升级到争议（仅 rejected 后或 pending ≥ 7 天） | src/pwa/routes/returns.ts:497 |
| POST | `/api/return-requests/:id/mark-refunded` | 🔐 |  |  | src/pwa/routes/direct-pay-returns.ts:40 |
| POST | `/api/return-requests/:id/messages` | 🔐 |  |  | src/pwa/routes/returns.ts:467 |
| POST | `/api/return-requests/:id/picked-up` | 🔐 |  | L3 Phase 2: 物流揽收 | src/pwa/routes/returns.ts:398 |
| POST | `/api/return-requests/:id/received` | 🔐 |  | L3 Phase 2: 卖家确认收到 → refunded | src/pwa/routes/returns.ts:421 |
| POST | `/api/reviews/:type/:id/claim` | 🔐 |  |  | src/pwa/routes/reviews.ts:54 |
| GET | `/api/reviews/:type/:id/claims` |  |  |  | src/pwa/routes/reviews.ts:113 |
| GET | `/api/reviews/recent` |  |  |  | src/pwa/routes/reviews.ts:38 |
| POST | `/api/rewards/apply` | 🔐 |  | POST /api/rewards/apply — activate (or reconfirm) opt-in + drain escrow | src/pwa/routes/rewards-apply.ts:112 |
| POST | `/api/rewards/deactivate` | 🔐 |  | POST /api/rewards/deactivate — flip off; subsequent commissions → charity | src/pwa/routes/rewards-apply.ts:220 |
| GET | `/api/rewards/status` | 🔐 |  | GET /api/rewards/status — current state + escrow tally | src/pwa/routes/rewards-apply.ts:58 |
| GET | `/api/rfqs` | 🔐 |  | 卖家 RFQ 看板 | src/pwa/routes/rfqs.ts:166 |
| POST | `/api/rfqs` | 🔐 |  | 买家：创建 RFQ | src/pwa/routes/rfqs.ts:79 |
| DELETE | `/api/rfqs/:id` | 🔐 |  |  | src/pwa/routes/rfqs.ts:237 |
| GET | `/api/rfqs/:id` | 🔐 |  |  | src/pwa/routes/rfqs.ts:208 |
| POST | `/api/rfqs/:id/award` | 🔐 |  | 买家：选定 winning bid | src/pwa/routes/rfqs.ts:477 |
| POST | `/api/rfqs/:id/bids` | 🔐 |  |  | src/pwa/routes/rfqs.ts:270 |
| GET | `/api/rfqs/mine` | 🔐 |  |  | src/pwa/routes/rfqs.ts:195 |
| POST | `/api/search-by-link` |  |  |  | src/pwa/routes/search.ts:66 |
| GET | `/api/search-fuzzy` |  |  |  | src/pwa/routes/search.ts:118 |
| GET | `/api/secondhand` |  |  | 2. 列表（市场入口） | src/pwa/routes/secondhand.ts:78 |
| POST | `/api/secondhand` | 🔐 |  | 1. 发布 | src/pwa/routes/secondhand.ts:56 |
| GET | `/api/secondhand/:id` |  |  | 4. 详情（view_count++）+ 同卖家其他在售 | src/pwa/routes/secondhand.ts:138 |
| PATCH | `/api/secondhand/:id` | 🔐 |  | 5. 编辑（仅 owner；可改 price / description / negotiable / status / fulfillment） | src/pwa/routes/secondhand.ts:155 |
| POST | `/api/secondhand/:id/order` | 🔐 |  | 6. 下单（CAS 锁库存）— money/escrow + pragma FK-OFF 窗口,保持同步,Phase 3 随资金路径迁移 | src/pwa/routes/secondhand.ts:193 |
| GET | `/api/secondhand/mine` | 🔐 |  | 3. 我的二手发布 | src/pwa/routes/secondhand.ts:116 |
| POST | `/api/seller/accept-mode` | 🔐 |  |  | src/pwa/routes/direct-pay-pending-accept.ts:59 |
| POST | `/api/seller/apply-quota-increase` | 🔐 |  |  | src/pwa/routes/seller-quota.ts:194 |
| GET | `/api/seller/insights` | 🔐 |  | 数据中心（30d GMV / 7d 曲线 / Top 5 / 客户洞察 / 状态分布） | src/pwa/routes/seller-quota.ts:71 |
| GET | `/api/seller/quota-status` | 🔐 |  | 配额状态 | src/pwa/routes/seller-quota.ts:45 |
| GET | `/api/seller/shipping-settings` | 🔐 |  | 卖家读自己的店铺级设置(设置 UI 回显):接单模式 + 运费模板 + 询价开关。 | src/pwa/routes/shipping-templates.ts:127 |
| POST | `/api/seller/shipping-template` | 🔐 |  |  | src/pwa/routes/shipping-templates.ts:28 |
| POST | `/api/seller/withdraw-quota-application` | 🔐 |  |  | src/pwa/routes/seller-quota.ts:217 |
| GET | `/api/sellers/:seller_id/ratings` |  |  | 公开：卖家评价聚合（卖家主页）。注册在 /me 之后(见上面注释)。 | src/pwa/routes/ratings.ts:258 |
| GET | `/api/sellers/me/analytics` | 🔐 |  | 卖家销售分析 (Wave C-5) | src/pwa/routes/analytics.ts:155 |
| GET | `/api/sellers/me/direct-pay-report` | 🔐 |  | from/to 均可选(闭区间,按日期比较 substr(created_at,1,10));返回汇总 + 按月 + 逐单(含平台费明细)。 | src/pwa/routes/seller-directpay-report.ts:39 |
| GET | `/api/sellers/me/flash-sales` | 🔐 |  | seller 自己的 flash sales（全部状态） | src/pwa/routes/flash-sales.ts:109 |
| GET | `/api/sellers/me/ratings` | 🔐 |  | ⚠️ 必须注册在 /api/sellers/:seller_id/ratings 【之前】,否则 'me' 会被 :seller_id 参数路由抢匹配。 | src/pwa/routes/ratings.ts:212 |
| GET | `/api/sellers/me/return-stats` | 🔐 |  | 卖家退货仪表盘 | src/pwa/routes/analytics.ts:287 |
| GET | `/api/share-link` | 🔐 |  | pre-public 去左右码:不再接受/返回 side,放置侧别由注册时系统自动决定。 | src/pwa/routes/referral.ts:67 |
| POST | `/api/shareables` | 🔐 |  | 创建 shareable — 双路径：笔记模式 / 外链或 native_text 模式 | src/pwa/routes/shareables.ts:93 |
| DELETE | `/api/shareables/:id` | 🔐 |  |  | src/pwa/routes/shareables.ts:449 |
| GET | `/api/shareables/:id` |  |  | Phase C 笔记公开读 — 任何人可读 | src/pwa/routes/shareables.ts:380 |
| PATCH | `/api/shareables/:id` | 🔐 |  |  | src/pwa/routes/shareables.ts:415 |
| POST | `/api/shareables/:id/bookmark` | 🔐 |  | POST 切换：未收藏 → 加 / 已收藏 → 删（toggle 模式） | src/pwa/routes/shareables-interactions.ts:175 |
| GET | `/api/shareables/:id/bookmark-status` | 🔐 |  | 查 bookmark 状态 | src/pwa/routes/shareables-interactions.ts:191 |
| POST | `/api/shareables/:id/click` |  |  |  | src/pwa/routes/shareables-interactions.ts:43 |
| GET | `/api/shareables/:id/comments` |  |  | W6 笔记评论 — 楼中楼 1 层（root + replies） | src/pwa/routes/shareables-interactions.ts:91 |
| POST | `/api/shareables/:id/comments` | 🔐 |  |  | src/pwa/routes/shareables-interactions.ts:122 |
| POST | `/api/shareables/:id/like` | 🔐 |  | LIKE 系统：toggle 点赞（每用户对每 shareable 一票；不能给自己点） | src/pwa/routes/shareables-interactions.ts:50 |
| GET | `/api/shareables/:id/like-status` | 🔐 |  | 查询单个 shareable 我是否点赞过（用于 UI 状态） | src/pwa/routes/shareables-interactions.ts:166 |
| GET | `/api/shareables/by-anchor/:anchor` | 🔐 |  |  | src/pwa/routes/shareables.ts:307 |
| GET | `/api/shareables/by-product/:pid` | 🔐 |  | 策展引用：按 click*1 + like*3 + induced_orders*10 加权排序，取 top 10 | src/pwa/routes/shareables.ts:285 |
| GET | `/api/shareables/me` | 🔐 |  |  | src/pwa/routes/shareables.ts:204 |
| GET | `/api/shares/dashboard` | 🔐 |  |  | src/pwa/routes/dashboards.ts:65 |
| POST | `/api/shop-referral/touch` | 🔐 |  |  | src/pwa/routes/shop-referral.ts:27 |
| GET | `/api/shops/:identifier` |  |  |  | src/pwa/routes/shops.ts:36 |
| PATCH | `/api/shops/me` | 🔐 |  | 卖家更新自己店铺装饰 | src/pwa/routes/shops.ts:101 |
| GET | `/api/signaling/poll` | 🔐 |  |  | src/pwa/routes/signaling.ts:40 |
| POST | `/api/signaling/send` | 🔐 |  |  | src/pwa/routes/signaling.ts:28 |
| GET | `/api/skill-market` |  |  | ─── 公开列表 ─────────────────────────────────────────────── | src/pwa/routes/skill-market.ts:62 |
| POST | `/api/skill-market` | 🔐 |  | ─── 发布（任意登录用户）──────────────────────────────────── | src/pwa/routes/skill-market.ts:95 |
| GET | `/api/skill-market/:id` |  |  | ─── 公开详情 ─────────────────────────────────────────────── | src/pwa/routes/skill-market.ts:87 |
| PATCH | `/api/skill-market/:id` | 🔐 |  | ─── 修改 ─────────────────────────────────────────────────── | src/pwa/routes/skill-market.ts:117 |
| POST | `/api/skill-market/:id/delist` | 🔐 |  | ─── 下架 ─────────────────────────────────────────────────── | src/pwa/routes/skill-market.ts:138 |
| POST | `/api/skill-market/:id/purchase` | 🔐 |  | ─── 购买 / 解锁（free \| one_time）────────────────────────── | src/pwa/routes/skill-market.ts:152 |
| POST | `/api/skill-market/:id/read` | 🔐 |  | ─── 读取正文（per_use 按次扣费）──────────────────────────── | src/pwa/routes/skill-market.ts:159 |
| POST | `/api/skill-market/:id/resubmit` | 🔐 |  | ─── 重新提交审核 ─────────────────────────────────────────── | src/pwa/routes/skill-market.ts:145 |
| GET | `/api/skill-market/library` | 🔐 |  | ─── 我的技能库 ───────────────────────────────────────────── | src/pwa/routes/skill-market.ts:81 |
| GET | `/api/skill-market/mine` | 🔐 |  | ─── 我发布的（须在 /:id 之前注册）─────────────────────────── | src/pwa/routes/skill-market.ts:75 |
| GET | `/api/skills` |  |  | 公开浏览 | src/pwa/routes/skills.ts:57 |
| POST | `/api/skills` | 🔐 |  | 发布 | src/pwa/routes/skills.ts:79 |
| PATCH | `/api/skills/:id` | 🔐 |  | 卖家：修改 Skill | src/pwa/routes/skills.ts:147 |
| POST | `/api/skills/:id/disable` | 🔐 |  | 卖家：停用 | src/pwa/routes/skills.ts:166 |
| DELETE | `/api/skills/:id/subscribe` | 🔐 |  | 取消订阅 | src/pwa/routes/skills.ts:187 |
| POST | `/api/skills/:id/subscribe` | 🔐 |  | 订阅 | src/pwa/routes/skills.ts:176 |
| GET | `/api/skills/mine` | 🔐 |  |  | src/pwa/routes/skills.ts:68 |
| GET | `/api/skills/subscriptions` | 🔐 |  |  | src/pwa/routes/skills.ts:73 |
| GET | `/api/snf/:id/verify` | 🔐 |  | 验签（仅当事人或 arbitrator/admin） | src/pwa/routes/snf.ts:123 |
| POST | `/api/snf/ack` | 🔐 |  | 显式 ack（无 ids → ack 全部未读） | src/pwa/routes/snf.ts:105 |
| GET | `/api/snf/dead-letter` | 🔐 |  |  | src/pwa/routes/snf.ts:87 |
| GET | `/api/snf/designate` | 🔐 |  |  | src/pwa/routes/snf.ts:143 |
| POST | `/api/snf/designate` | 🔐 |  |  | src/pwa/routes/snf.ts:136 |
| GET | `/api/snf/inbox` | 🔐 |  | 只读列表（不消费） | src/pwa/routes/snf.ts:61 |
| GET | `/api/snf/inbox/pull` | 🔐 |  | 协议级 pull — 一次性消费，agent / 内部组件用 | src/pwa/routes/snf.ts:70 |
| POST | `/api/snf/nack` | 🔐 |  | Agent 处理失败 → nack 回放（超 5 次自动死信化） | src/pwa/routes/snf.ts:78 |
| GET | `/api/snf/pending` | 🔐 |  |  | src/pwa/routes/snf.ts:117 |
| POST | `/api/snf/revive/:id` | 🔐 |  |  | src/pwa/routes/snf.ts:94 |
| POST | `/api/snf/send` | 🔐 |  |  | src/pwa/routes/snf.ts:40 |
| GET | `/api/system-flags` |  |  |  | src/pwa/routes/public-utils.ts:101 |
| GET | `/api/tags/:tag/notes` |  |  | db 已全量走 RFC-016 异步 seam(dbOne/dbAll),不再用 deps.db | src/pwa/routes/tags.ts:23 |
| GET | `/api/tags/trending` |  |  | 热门标签：24h + 总数综合排序 | src/pwa/routes/tags.ts:51 |
| POST | `/api/tasks/:key/claim` | 🔐 |  |  | src/pwa/routes/checkin-tasks.ts:110 |
| GET | `/api/tokenomics/status` |  |  |  | src/pwa/routes/dashboards.ts:26 |
| GET | `/api/trial-campaigns/:campaign_id/claims` | 🔐 |  | 卖家：查看某活动的 claims 详情 | src/pwa/routes/trial.ts:343 |
| POST | `/api/trial-claims/:claim_id/link-note` | 🔐 |  | 买家关联笔记 | src/pwa/routes/trial.ts:287 |
| GET | `/api/users/:id/auctions` |  |  | 用户进行中拍卖（公开：open） | src/pwa/routes/users-public.ts:155 |
| GET | `/api/users/:id/bookmarked-shareables` | 🔐 |  | 我收藏过的 shareables（仅 owner 自己可见） | src/pwa/routes/shareables-interactions.ts:198 |
| GET | `/api/users/:id/liked-shareables` | 🔐 |  | 用户赞过的 shareables（仅 owner 可见） | src/pwa/routes/users-public.ts:196 |
| GET | `/api/users/:id/products` |  |  | 用户在售商品（公开：卖家 active 商品） | src/pwa/routes/users-public.ts:183 |
| GET | `/api/users/:id/public-card` |  |  | 公开卡（未登录可调，分享 banner 用） | src/pwa/routes/users-public.ts:223 |
| GET | `/api/users/:id/pv-summary` | 🔐 |  | PV 简报：组织图点击节点用 | src/pwa/routes/users-public.ts:71 |
| GET | `/api/users/:id/reputation` | 🔐 |  | 公开 reputation — 仅 level | src/pwa/routes/users-public.ts:49 |
| GET | `/api/users/:id/reviews` |  |  | 用户写的测评（公开：作为买家给出的评价） | src/pwa/routes/users-public.ts:168 |
| GET | `/api/users/:id/secondhand` |  |  | 用户在售二手（公开：available + reserved） | src/pwa/routes/users-public.ts:142 |
| GET | `/api/users/:id/shareables` |  |  | 用户公开 shareables | src/pwa/routes/users-public.ts:110 |
| GET | `/api/users/:user_id` | 🔐 |  | 公开用户主页 + D2 信誉徽章墙 | src/pwa/routes/users-public.ts:253 |
| POST | `/api/verifier/appeal` | 🔐 |  |  | src/pwa/routes/verifier-user.ts:154 |
| POST | `/api/verifier/apply` | 🔐 |  |  | src/pwa/routes/verifier-user.ts:70 |
| GET | `/api/verifier/eligibility` | 🔐 |  |  | src/pwa/routes/verifier-user.ts:47 |
| GET | `/api/verifier/me/kpi` | 🔐 |  | Verifier KPI（白名单 tier / 配额 / 准确率 / 窗口奖励） | src/pwa/routes/trusted-kpi.ts:27 |
| GET | `/api/verifier/status` | 🔐 |  |  | src/pwa/routes/verifier-user.ts:52 |
| POST | `/api/verifier/withdraw-application` | 🔐 |  |  | src/pwa/routes/verifier-user.ts:132 |
| POST | `/api/verify-price` | 🔐 |  |  | src/pwa/routes/checkout-helpers.ts:70 |
| GET | `/api/verify-stats` | 🔐 |  |  | src/pwa/routes/verify-tasks.ts:151 |
| POST | `/api/verify-tasks/:id/confirm` | 🔐 |  | 卖家确认：已在原平台添加验证码 → 任务进入分配池 | src/pwa/routes/verify-tasks.ts:36 |
| POST | `/api/verify-tasks/:id/submit` | 🔐 |  | 验证者：提交验证结果（填入式） | src/pwa/routes/verify-tasks.ts:96 |
| GET | `/api/verify-tasks/by-product/:productId` | 🔐 |  | 卖家：查询某商品的进行中验证任务（供编辑页展示验证码） | src/pwa/routes/verify-tasks.ts:51 |
| GET | `/api/verify-tasks/mine` | 🔐 |  |  | src/pwa/routes/verify-tasks.ts:80 |
| GET | `/api/verify-tasks/my-claims` | 🔐 |  | 卖家：查询我发起的所有认领任务（用于"查看任务进度"页） | src/pwa/routes/verify-tasks.ts:64 |
| GET | `/api/verify-tasks/open` | 🔐 |  | 公开验证大厅 — 仅显示分配给我的未提交任务 | src/pwa/routes/verify-tasks.ts:136 |
| GET | `/api/waitlist` | 🔐 |  |  | src/pwa/routes/waitlist.ts:56 |
| GET | `/api/wallet` | 🔐 |  | 钱包状态 | src/pwa/routes/wallet-read.ts:51 |
| POST | `/api/wallet/connect/challenge` | 🔐 |  |  | src/pwa/routes/wallet-write.ts:55 |
| POST | `/api/wallet/connect/verify` | 🔐 |  |  | src/pwa/routes/wallet-write.ts:66 |
| GET | `/api/wallet/deposit-qr` | 🔐 |  | 充值地址 QR — SVG（轻量 + 矢量，移动端扫码体验最佳） | src/pwa/routes/wallet-read.ts:66 |
| GET | `/api/wallet/deposits` | 🔐 |  |  | src/pwa/routes/wallet-read.ts:175 |
| GET | `/api/wallet/income` | 🔐 |  | 收入构成:销售 / 分享归因 / PV 记录(若适用) | src/pwa/routes/wallet-read.ts:201 |
| GET | `/api/wallet/rate` |  |  | 公开汇率 | src/pwa/routes/wallet-read.ts:84 |
| POST | `/api/wallet/topup` | 🔐 |  |  | src/pwa/routes/wallet-read.ts:242 |
| GET | `/api/wallet/whitelist` | 🔐 |  | 白名单 GET / POST / DELETE | src/pwa/routes/wallet-read.ts:98 |
| POST | `/api/wallet/whitelist` | 🔐 |  |  | src/pwa/routes/wallet-read.ts:115 |
| DELETE | `/api/wallet/whitelist/:id` | 🔐 |  |  | src/pwa/routes/wallet-read.ts:144 |
| POST | `/api/wallet/withdraw` | 🔐 |  | 保持整体同步,Phase 3 随资金路径整体迁 pg(BEGIN + SELECT...FOR UPDATE 行锁),不在此引入 await 间隙。 | src/pwa/routes/wallet-write.ts:116 |
| POST | `/api/wallet/withdraw/:id/confirm` | 🔐 |  | 大额提现：邮件验证码确认 | src/pwa/routes/wallet-write.ts:233 |
| GET | `/api/wallet/withdrawals` | 🔐 |  | 我的提现记录 | src/pwa/routes/wallet-read.ts:153 |
| POST | `/api/wallet/withdrawals/:id/cancel` | 🔐 |  | 用户取消尚未 approve 的 withdrawal — 余额自动退回 | src/pwa/routes/wallet-write.ts:261 |
| POST | `/api/webauthn/auth/finish` | 🔐 |  | 4. 认证：finish — 验证签名 + 颁发短 gate token | src/pwa/routes/webauthn.ts:144 |
| POST | `/api/webauthn/auth/start` | 🔐 |  | 3. 认证：start — 生成 challenge（指定 purpose + 业务数据；同一 challenge 不可复用） | src/pwa/routes/webauthn.ts:119 |
| GET | `/api/webauthn/credentials` | 🔐 |  | 列出 / 删除 credential | src/pwa/routes/webauthn.ts:189 |
| DELETE | `/api/webauthn/credentials/:id` | 🔐 |  |  | src/pwa/routes/webauthn.ts:196 |
| POST | `/api/webauthn/register/finish` | 🔐 |  | 2. 注册：finish — 验证 + 入库 | src/pwa/routes/webauthn.ts:83 |
| POST | `/api/webauthn/register/start` | 🔐 |  | 1. 注册：start — 生成 challenge + 选项 | src/pwa/routes/webauthn.ts:63 |
| POST | `/api/webauthn/settings` | 🔐 |  |  | src/pwa/routes/webauthn.ts:214 |
| GET | `/api/webhooks` | 🔐 |  | GET 我的订阅 | src/pwa/routes/webhooks.ts:125 |
| POST | `/api/webhooks` | 🔐 |  | POST 订阅 | src/pwa/routes/webhooks.ts:103 |
| DELETE | `/api/webhooks/:id` | 🔐 |  | DELETE | src/pwa/routes/webhooks.ts:133 |
| PATCH | `/api/webhooks/:id` | 🔐 |  | PATCH active toggle | src/pwa/routes/webhooks.ts:141 |
| POST | `/api/webhooks/test` | 🔐 |  | P2.4 测试端点：subscribe 前先验 endpoint 可达 + 不私网 | src/pwa/routes/webhooks.ts:150 |
| GET | `/api/wishes` |  |  | GET /api/wishes — 浏览（匿名可访问） | src/pwa/routes/charity.ts:258 |
| POST | `/api/wishes` | 🔐 |  | POST /api/wishes — 发布愿望 | src/pwa/routes/charity.ts:190 |
| GET | `/api/wishes/:id` |  |  | GET /api/wishes/:id — 详情 | src/pwa/routes/charity.ts:292 |
| POST | `/api/wishes/:id/cancel` | 🔐 |  | POST /api/wishes/:id/cancel — 许愿人取消（仅 open 状态） | src/pwa/routes/charity.ts:474 |
| POST | `/api/wishes/:id/confirm` | 🔐 |  | POST /api/wishes/:id/confirm — 许愿人确认 | src/pwa/routes/charity.ts:390 |
| POST | `/api/wishes/:id/disclose` | 🔐 |  | POST /api/wishes/:id/disclose — 申请公开（双方同意才公开） | src/pwa/routes/charity.ts:445 |
| POST | `/api/wishes/:id/fulfill` | 🔐 |  | /claim 让 fraud-claim 独占（与 secondhand/auctions 三垂类对称） | src/pwa/routes/charity.ts:326 |
| POST | `/api/wishes/:id/proof` | 🔐 |  | POST /api/wishes/:id/proof — 提交证据 | src/pwa/routes/charity.ts:358 |
| POST | `/api/wishes/:id/repay` | 🔐 |  | 还愿：许愿人发起 | src/pwa/routes/charity.ts:540 |
| POST | `/api/wishes/:id/repay/:rid/respond` | 🔐 |  | 施善人响应还愿（accept / decline_to_fund） | src/pwa/routes/charity.ts:595 |
| POST | `/api/wishes/:id/report` | 🔐 |  | P2.3 — 举报愿望 | src/pwa/routes/charity.ts:715 |
| GET | `/api/wishlist` | 🔐 |  |  | src/pwa/routes/wishlist-qa.ts:58 |
| DELETE | `/api/wishlist/:product_id` | 🔐 |  |  | src/pwa/routes/wishlist-qa.ts:52 |
| POST | `/api/wishlist/:product_id` | 🔐 |  | ─── Wave A-1: 心愿单 ──────────────────────────────────── | src/pwa/routes/wishlist-qa.ts:40 |
| GET | `/api/wishlist/:product_id/check` | 🔐 |  |  | src/pwa/routes/wishlist-qa.ts:81 |
