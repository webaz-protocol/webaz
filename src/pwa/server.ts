/**
 * PWA HTTP Server — WebAZ 的人类入口 + 生产 HTTP API（端口 3000）
 *
 * 作用 / What:
 *   - 服务 PWA 静态前端(src/pwa/public/*)给手机/桌面浏览器(人类)
 *   - 暴露 /api/* HTTP API —— **人 + agent 共用的生产端点**(MCP NETWORK 模式也打这里,见 RFC-003)
 *
 * 本文件做什么 / Structure(这是最大的文件,改动前先定位区块):
 *   - 启动:initDatabase() + 各 initXxxSchema(db) + 内联 CREATE TABLE(部分表直接建在这里)
 *   - 鉴权:auth()/getUser()(统一 `Authorization: Bearer <api_key>`)、requireAdmin/requireAdminPermission
 *   - 中间件:api_key 速率/封禁 + agent 声明 scope 门(getDeclaredActions/getAgentRiskInfo)
 *   - 路由:大部分按主题拆到 src/pwa/routes/*,在文件下半部 registerXxxRoutes(app, deps) 接线;
 *           少数端点仍内联在本文件
 *
 * 关联 / Related: AGENTS.md(项目地图) · 元规则 #2 代码即规则 / #3 不偷数据 / #6 不滥用 ·
 *   RFC-003(MCP NETWORK 共用这些端点) · CHARTER §3.2(改动审批分档)
 */

import express, { Request, Response, NextFunction } from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

import { initDatabase, generateId } from '../layer0-foundation/L0-1-database/schema.js'
import { setSeamDb } from '../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { initSystemUser, transition, getOrderStatus, checkTimeouts, settleFault } from '../layer0-foundation/L0-2-state-machine/engine.js'
import { endpointToAction, endpointToReadAction } from './endpoint-actions.js'
import { AGENT_RATE_PER_MIN_DEFAULTS, CROSS_USER_READ_DAILY_CAP, MASS_ACTION_TYPES, MASS_ACTION_DAILY_CAPS } from './limits.js'
// #420 P1-2/P1-3/P1-4 — 反滥用阈值单一真相源（governance-adjustable protocol_params）+ 纯决策函数
import { ANTI_ABUSE_PARAMS, readAntiAbuseThresholds, agentTrustLevel, agentSybilPenalty, agentStrikeSeverity, verifierOutlierBand } from './anti-abuse-thresholds.js'
import { initOrderChainSchema, appendOrderEvent, getOrderChain, verifyOrderChain } from '../layer0-foundation/L0-2-state-machine/order-chain.js'
import { initVerifierWhitelistSchema, initMcpToolCallsSchema, initNotePhotoIndexSchema, initUserWishlistSchema, initProductQaSchema, initCouponsSchema, initAnnouncementsSchema, initProductWaitlistSchema, initFlashSalesSchema, initPublicIdeasSchema, initAuctionRemindersSchema, initEmailSubscriptionsSchema, initFeedbackTicketsSchema, initFeedbackMessagesSchema, initDisputeCasesSchema, initDisputeCommentsSchema, initDisputeCommentRepliesSchema, initShareableCommentsSchema, initDisputeFairnessVotesSchema, initOrderRatingsSchema, initBuyerRatingsSchema, initUserAddressesSchema, initP2pShopsSchema, initShareableLikesSchema, initShareableBookmarksSchema, initShareableTagsSchema, initManifestRegistrySchema, initPeerDirectorySchema, initSignalingQueueSchema, initConversationsSchema, initMessagesSchema, initChatReportsSchema, initQuotaIncreaseApplicationsSchema, initVerifierApplicationsSchema, initArbitratorReviewSchema, initVerifierAppealsSchema, initUserModerationSchema, initAdminAuditLogSchema, initVerificationCodesSchema, initAgentCallLogSchema, initAgentReputationSchema, initAgentDeclarationsSchema, initAgentAttestationsSchema, initAgentStrikesSchema, initAgentRevocationsSchema, initProductAliasesSchema, initRegionChangeLogSchema, initCartItemsSchema, initFollowsSchema, initPushSubscriptionsSchema, initUserSessionsSchema, initUserBlocklistSchema, initImportLogsSchema, initErrorLogSchema, initSecondhandItemsSchema, initProductTrialCampaignsSchema, initProductTrialClaimsSchema, initReturnRequestsSchema, initReturnMessagesSchema, initProductVariantsSchema, initEditorPicksSchema, initKycRecordsSchema, initWebauthnSchema, initClaimVerificationBaseSchema, initClaimVerifierSuspensionsSchema, initProductClaimSchema, initReviewClaimSchema, initSecondhandClaimSchema, initAuctionClaimSchema, initWishClaimSchema, initShareableClickLogSchema, initCommissionAuditLogSchema, initRegistrationAuditLogSchema, initProductExternalLinksBaseSchema, initLinkChallengesSchema, initVerifyTasksSchema, initVerifySubmissionsSchema, initVerifierStatsSchema, initRegisterListSearchColumns } from './server-schema.js'
// RFC-014 PR4 — 正常成交结算走整数 base-units + allocate + 绝对值落库。
import { toUnits, toDecimal, mulRate, allocate } from '../money.js'
import { applyWalletDelta, creditColumns } from '../ledger.js'
import { computeSettlementSplit } from '../settlement-math.js'
import { initSnfSchema, snfSend, snfPullInbox, snfListInbox, snfAck, snfPendingCount, snfVerify, snfDesignate, snfGetDesignation, snfCleanup, snfNack, snfListDeadLetter, snfRevive } from '../layer2-business/L2-7-snf/snf-engine.js'
import { initExternalAnchorSchema, createAnchor, verifyAnchorSignature, revokeAnchor, issueOwnershipToken, submitVerification, getAnchor, listAnchorsByProduct, listAnchorsBySeller, distributeAnchorRewards, ANCHOR_VERIFICATION_FEE_RECOMMENDED } from '../layer1-agent/L1-2-external-anchor/anchor-engine.js'
import {
  ensureEvidenceColumns, uploadEvidence, readEvidenceBlob, withdrawEvidence,
  listEvidence as listEvidenceFiles, verifyEvidenceSig, markEvidenceExpiry, cleanupExpiredEvidence,
  EVIDENCE_MAX_BYTES, EVIDENCE_ALLOWED_MIME,
} from '../layer3-trust/L3-1-dispute-engine/evidence-storage.js'
import {
  writeNotePhoto, readNotePhoto, noteBlobExists,
  cleanupOrphanNotePhotos,
  NOTE_PHOTO_MAX_BYTES, NOTE_PHOTO_ALLOWED_MIME,
} from '../layer2-business/L2-notes/note-photo-storage.js'
import {
  initAnchorRegistrySchema, generateAnchor, lookupAnchor, retireAnchor,
  retireAnchorsByTarget, reclaimRetiredAnchors, retireIdleAnchors,
  userReferralVolume, computeTierLetter, userAnchorQuotaStats,
  TIER_THRESHOLDS, ANCHOR_HANDLE_MAX_FOR_USE,
  type AnchorTargetKind,
} from '../layer2-business/L2-anchor-registry/anchor-registry.js'
import {
  initDisputeSchema, createDispute, respondToDispute, arbitrateDispute,
  getOrderDispute, getDisputeDetails, getOpenDisputes, checkDisputeTimeouts,
  initEvidenceRequestSchema, requestEvidence, submitEvidenceForRequest, getEvidenceRequests,
  addPartyEvidence,
  type EvidenceType, type LiabilityEntry,
} from '../layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import {
  initNotificationSchema,
  notifyTransition,
  getNotifications,
  getUnreadCount,
  markRead,
  setPushCallback,
  scanDeadlineReminders,
  type Notification,
} from '../layer2-business/L2-6-notifications/notification-engine.js'
import { initSkillMarketSchema } from '../layer4-economics/L4-4-skill-market/skill-listing-engine.js'
import { computeAgentPassport } from '../layer1-agent/L1-2-identity/agent-passport.js'
import {
  initSkillSchema,
  publishSkill,
  listSkills,
  getMySkills,
  subscribeSkill,
  unsubscribeSkill,
  getMySubscriptions,
  shouldAutoAccept,
  type SkillType,
} from '../layer4-economics/L4-4-skill-market/skill-engine.js'
import {
  initReputationSchema,
  recordOrderReputation,
  recordViolationReputation,
  recordDisputeReputation,
  recordRatingReputation,
  recordRepEvent,
  getReputation,
  getSearchBoost,
  getStakeDiscount,
  applyDecayIfDue,
} from '../layer4-economics/L4-3-reputation/reputation-engine.js'
import { generateManifest } from '../layer0-foundation/L0-5-manifest/manifest.js'
import Anthropic from '@anthropic-ai/sdk'
import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi, parseEther, verifyMessage, type Log } from 'viem'
import { baseSepolia, base } from 'viem/chains'
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import QRCode from 'qrcode'
import { isPrivateOrInternalHost, safeFetch } from './security/ssrf.js'
import {
  deliverVerificationCode,
  emailDeliveryNotConfigured,
  isVerificationEmailReady,
  type IssueCodeResult,
} from './email-delivery.js'
// @simplewebauthn/server 已迁出到 src/pwa/routes/webauthn.ts (#1013 Phase 1)
import { registerWebauthnRoutes } from './routes/webauthn.js'
import { createHumanPresence } from './human-presence.js'
// welcome 域（#991 /welcome 落地页 + #1005 反 bot）已迁出 (#1013 Phase 2)
import { registerWelcomeRoutes } from './routes/welcome.js'
// 测评免单 (#978-#988) 域 + 评估 cron 已迁出 (#1013 Phase 3)
import { registerTrialRoutes, evaluateTrialClaims } from './routes/trial.js'
// chat 域（上下文绑定私聊）已迁出 (#1013 Phase 4)
// detectFraud 同步迁出但 server.ts 其它端点（listing Q&A / 评论等）仍引用 → re-import
import { registerChatRoutes, detectFraud } from './routes/chat.js'
// auction 域（拍卖 + 提醒）已迁出 (#1013 Phase 5)
// settleAuction* 留 server.ts（深耦合 transition / checkStockAndMaybeDelist）
import { registerAuctionRoutes, fireDueAuctionReminders } from './routes/auction.js'
// 慈善许愿池 (#1013 Phase 6) — 17 endpoints + 2 cron 函数
// ensureCharityRep 跨域共享（订单 B5 下单捐赠路径仍在 server.ts 引用）
import { registerCharityRoutes, expireCharityWishes, autoAcceptExpiredRepayments, ensureCharityRep } from './routes/charity.js'
// Webhooks (#1013 Phase 7) — 5 endpoints + fireWebhooks 跨域 API
// fireWebhooks 被 charity / 未来 RFQ + orders 等通过 deps 注入调用
import { registerWebhookRoutes, fireWebhooks } from './routes/webhooks.js'
// Dispute cases (#1013 Phase 8) — 公开判例 6 endpoints
// publishDisputeCase / piiSanitize 留 server.ts（被多域复用），通过 deps 注入
import { registerDisputeCasesRoutes } from './routes/dispute-cases.js'
// Claim verify (#1013 Phase 9) — 8 endpoints + 三路径结算 cron + 铁律 §4
// requireHumanPresence 仍在 server.ts（arbitrate / agent_revoke / vote 3 处用），通过 deps 注入
// settleClaimTask + 多个内部 helper 已 export 供 server.ts 其它路径调用（如 product-claims）
import {
  registerClaimVerifyRoutes, processClaimTaskQueue,
  isEligibleClaimVerifier as isEligibleClaimVerifierRaw,
  activeClaimTaskCountForVerifier as activeClaimTaskCountForVerifierRaw,
  settleClaimTask as settleClaimTaskRaw,
  notifyEligibleVerifiers as notifyEligibleVerifiersRaw,
  CLAIM_VERIFIERS_NEEDED, CLAIM_TARGET_LABEL_ZH,
  CLAIM_DEADLINE_HOURS, CLAIM_SELLER_EXTENSION_HOURS,
  // #420 P1-3:verifier outlier 阈值改由 protocol_params 驱动(见 anti-abuse-thresholds.ts),
  // checkVerifierOutlier 不再 import claim-verify 的 CLAIM_*_THRESHOLD 常量。
} from './routes/claim-verify.js'
// Follows (#1013 Phase 10) — 4 endpoints (status/post/delete/me)
// /api/follows/feed 留 server.ts（依赖 products 跨域，待商品域拆分时一并处理）
import { registerFollowsRoutes } from './routes/follows.js'
// Leaderboard (#1013 Phase 11) — 单 endpoint 8 kinds（products/creators/buyers/sellers/value/agents/arbitrators/verifiers）
import { registerLeaderboardRoutes } from './routes/leaderboard.js'
// Shareables 互动 (#1013 Phase 12) — click/like/comments/bookmark 8 endpoints
import { registerShareablesInteractionsRoutes } from './routes/shareables-interactions.js'
// Shareables CRUD (#1013 Phase 13) — 11 endpoints (notes-photo + create + me + creator-stats + by-* + feed + detail + PATCH + DELETE)
import { registerShareablesRoutes } from './routes/shareables.js'
// 治理参数 + 支付方法管理 (#1013 Phase 14) — 13 endpoints
import { registerPaymentsGovernanceRoutes } from './routes/payments-governance.js'
// 心愿单 + 商品 Q&A (#1013 Phase 15) — 9 endpoints
import { registerWishlistQaRoutes } from './routes/wishlist-qa.js'
// 优惠券 (#1013 Phase 16) — 5 endpoints + applyCouponToOrder 跨域 helper
import { registerCouponsRoutes, applyCouponToOrder as applyCouponToOrderRaw } from './routes/coupons.js'
// 公告 (#1013 Phase 17) — 4 endpoints
import { registerAnnouncementsRoutes } from './routes/announcements.js'
// 商品 variants CRUD (#1013 Phase 18) — 4 endpoints
import { registerVariantsRoutes } from './routes/variants.js'
// 多收货地址簿 (#1013 Phase 19) — 4 endpoints
import { registerAddressesRoutes } from './routes/addresses.js'
// 买家评价 / 评分 (#1013 Phase 20) — 8 endpoints
import { registerRatingsRoutes } from './routes/ratings.js'
// 客服 / 反馈通道 (#1013 Phase 21) — 7 endpoints + W7 ticket-thread
import { registerFeedbackRoutes } from './routes/feedback.js'
// Trusted 角色 KPI 仪表盘 (#1013 Phase 22) — 2 endpoints
import { registerTrustedKpiRoutes } from './routes/trusted-kpi.js'
// 限时促销 (#1013 Phase 23) — 5 endpoints + getActiveFlashSale 跨域 helper
import { registerFlashSalesRoutes, getActiveFlashSale as getActiveFlashSaleRaw } from './routes/flash-sales.js'
// 预售 / waitlist (#1013 Phase 24) — 5 endpoints
import { registerWaitlistRoutes } from './routes/waitlist.js'
// 退货请求 + W2 timeline + L3 物流取件 (#1013 Phase 25) — 11 endpoints
import { registerReturnsRoutes } from './routes/returns.js'
// 分析仪表盘 (#1013 Phase 26) — 3 endpoints (logistics 绩效 + seller 销售 + return-stats)
import { registerAnalyticsRoutes } from './routes/analytics.js'
// M8 二手板块 (#1013 Phase 27) — 6 endpoints
import { registerSecondhandRoutes } from './routes/secondhand.js'
// B-3 群组团购 (#1013 Phase 28) — 5 endpoints + settleGroupBuy + sweep cron
import { registerGroupBuysRoutes, sweepExpiredGroupBuys as sweepExpiredGroupBuysRaw } from './routes/group-buys.js'
// 购物车 (#1013 Phase 29) — 5 endpoints
import { registerCartRoutes } from './routes/cart.js'
// 成长任务 (#1013 Phase 30) — 4 endpoints
import { registerGrowthRoutes } from './routes/growth.js'
// PWA Push 订阅 (#1013 Phase 31) — 4 endpoints
import { registerPushRoutes } from './routes/push.js'
// A2 用户黑名单 (#1013 Phase 32) — 5 endpoints
import { registerBlocklistRoutes } from './routes/blocklist.js'
// Skill 市场 (#1013 Phase 33) — 8 endpoints（卖家自动化插件）
import { registerSkillsRoutes } from './routes/skills.js'
// 技能市场（知识技能，内容型可购买）— 12 endpoints
import { registerSkillMarketRoutes } from './routes/skill-market.js'
// 商家店铺主页 (#1013 Phase 34) — 2 endpoints
import { registerShopsRoutes } from './routes/shops.js'
// 通知 API (#1013 Phase 36) — 3 endpoints (SSE + list + read)
import { registerNotificationsRoutes } from './routes/notifications.js'
// 账号注销 (#1013 Phase 37) — 3 endpoints (COP P0-2 GDPR)
import { registerAccountDeletionRoutes } from './routes/account-deletion.js'
// Agent 治理 (#1013 Phase 38) — 10 endpoints (7 user + 3 admin)
import { registerAgentGovernanceRoutes } from './routes/agent-governance.js'
// 用户自我数据 (#1013 Phase 39) — note-prompts + export
import { registerMeDataRoutes } from './routes/me-data.js'
// Manifest Registry (#1013 Phase 40) — 6 endpoints (L0-5 P2P 原生内容)
import { registerManifestsRoutes } from './routes/manifests.js'
// Store-and-Forward (#1013 Phase 41) — 11 endpoints (L2-7 SNF)
import { registerSnfRoutes } from './routes/snf.js'
// External Anchor (#1013 Phase 42) — 10 endpoints (L1-2)
import { registerExternalAnchorsRoutes } from './routes/external-anchors.js'
// E1 流量口令注册中心 (#1013 Phase 43) — 5 endpoints
import { registerAnchorsRoutes } from './routes/anchors.js'
// 仲裁员申请 (#1013 Phase 44) — 4 user + 3 admin endpoints
import { registerArbitratorRoutes } from './routes/arbitrator.js'
// Governance onboarding (W3.5-B 实施 #1093 阶段 1) — 2 user endpoints
import { registerGovernanceOnboardingRoutes } from './routes/governance-onboarding.js'
import { startAutoDeactivateCron, runAutoDeactivateSweep } from './routes/governance-auto-deactivate.js'
import { startEscrowExpireCron, runEscrowExpireSweep } from './routes/rewards-escrow-expire.js'
import { startAutoDowngradeCron, runAutoDowngradeSweep } from './routes/rewards-auto-downgrade.js'
import { registerRewardsApplyRoutes } from './routes/rewards-apply.js'
// 卖家配额 + 数据中心 (#1013 Phase 45) — 4 user + 3 admin
import { registerSellerQuotaRoutes } from './routes/seller-quota.js'
// 验证员用户侧 (#1013 Phase 46) — 5 endpoints
import { registerVerifierUserRoutes } from './routes/verifier-user.js'
// 公开用户主页 (#1013 Phase 47) — 6 endpoints
import { registerUsersPublicRoutes } from './routes/users-public.js'
// 会话管理 (#1013 Phase 48) — 3 endpoints
import { registerAuthSessionsRoutes } from './routes/auth-sessions.js'
// 找回密钥 (#1013 Phase 49) — 3 endpoints
import { registerRecoverKeyRoutes } from './routes/recover-key.js'
// 话题 / 标签 (#1013 Phase 50) — 2 endpoints
import { registerTagsRoutes } from './routes/tags.js'
// 跟卖 offers 管理 (#1013 Phase 51) — 3 endpoints
import { registerOffersRoutes } from './routes/offers.js'
// 多商家跟卖 listings (#1013 Phase 52) — 5 endpoints
import { registerListingsRoutes } from './routes/listings.js'
// 证据 evidence (#1013 Phase 53) — 4 endpoints
import { registerEvidenceRoutes } from './routes/evidence.js'
// 分享 / 重定向 / QR (#1013 Phase 54) — 4 endpoints
import { registerShareRedirectsRoutes } from './routes/share-redirects.js'
import { registerShopReferralRoutes } from './routes/shop-referral.js'
// Profile 凭据 (#1013 Phase 55) — 5 endpoints (密码 + 邮箱绑定)
import { registerProfileCredentialsRoutes } from './routes/profile-credentials.js'
// Profile 放置挂靠 (#1013 Phase 56) — 3 endpoints
import { registerProfilePlacementRoutes } from './routes/profile-placement.js'
// Profile 位置 (#1013 Phase 57) — 2 endpoints
import { registerProfileLocationRoutes } from './routes/profile-location.js'
// Profile 偏好 (#1013 Phase 58) — 3 endpoints
import { registerProfilePrefsRoutes } from './routes/profile-prefs.js'
// Profile 身份 (#1013 Phase 59) — 5 endpoints (角色 + 区域 + 昵称 + handle)
import { registerProfileIdentityRoutes } from './routes/profile-identity.js'
// Admin 协议参数 (#1013 Phase 60) — 4 endpoints (Wave F-2)
import { registerAdminProtocolParamsRoutes } from './routes/admin-protocol-params.js'
// Admin 分级管理 (#1013 Phase 61) — 4 endpoints
import { registerAdminAdminsRoutes } from './routes/admin-admins.js'
// Admin Tokenomics (#1013 Phase 62) — 6 endpoints
import { registerAdminTokenomicsRoutes } from './routes/admin-tokenomics.js'
// Admin Verifier 白名单 (#1013 Phase 63) — 6 endpoints
import { registerAdminVerifierWhitelistRoutes } from './routes/admin-verifier-whitelist.js'
// Admin Verifier 申请+申诉 (#1013 Phase 64) — 5 endpoints
import { registerAdminVerifierFlowRoutes } from './routes/admin-verifier-flow.js'
// Admin 原子操作 (#1013 Phase 65) — 3 endpoints
import { registerAdminAtomicRoutes } from './routes/admin-atomic.js'
// Admin Editor Picks (#1013 Phase 66) — 3 endpoints
import { registerAdminEditorPicksRoutes } from './routes/admin-editor-picks.js'
// Admin Events Stream (#1013 Phase 67) — 3 endpoints (SSE + ticket)
import { registerAdminEventsRoutes } from './routes/admin-events.js'
// Admin Moderation (#1013 Phase 68) — KYC 3 + Risk 3 = 6 endpoints
import { registerAdminModerationRoutes } from './routes/admin-moderation.js'
// Admin 钱包运维 (#1013 Phase 69) — hot-wallet 2 + withdrawals 2 = 4 endpoints
import { registerAdminWalletOpsRoutes } from './routes/admin-wallet-ops.js'
import { resolveBearerProtocolAdmin } from './admin-bearer-auth.js'
// Admin Catalog (#1013 Phase 70) — categories 2 + products 2 = 4 endpoints
import { registerAdminCatalogRoutes } from './routes/admin-catalog.js'
// Reputation 公开查询 (#1013 Phase 71) — 2 endpoints
import { registerReputationRoutes } from './routes/reputation.js'
// WebRTC Signaling (#1013 Phase 71) — 2 endpoints
import { registerSignalingRoutes } from './routes/signaling.js'
// Pin receipts 双签 (#1013 Phase 71) — 2 endpoints
import { registerPinReceiptsRoutes } from './routes/pin-receipts.js'
// Verify-tasks 验证任务 (#1013 Phase 72) — 7 endpoints
import { registerVerifyTasksRoutes } from './routes/verify-tasks.js'
// Reviews 公开 + claim (#1013 Phase 73) — 3 endpoints
import { registerReviewsRoutes } from './routes/reviews.js'
// Claim 撤回 5 垂类 (#1013 Phase 74) — 5 endpoints
import { registerClaimWithdrawalsRoutes } from './routes/claim-withdrawals.js'
// Claim 投票 5 垂类 (#1013 Phase 75) — 10 endpoints
import { registerClaimVotingRoutes } from './routes/claim-voting.js'
// Claim 发起 3 垂类 (#1013 Phase 76) — 6 endpoints
import { registerClaimInitiatorsRoutes } from './routes/claim-initiators.js'
// Promoter 推土机轨道 (#1013 Phase 77) — 2 endpoints
import { registerPromoterRoutes } from './routes/promoter.js'
// Admin 用户生命周期 (#1013 Phase 78) — 12 endpoints
import { registerAdminUsersLifecycleRoutes } from './routes/admin-users-lifecycle.js'
// Admin 用户查询 (#1013 Phase 79) — 5 endpoints (lookup/timeline/batch/list/profile)
import { registerAdminUsersQueryRoutes } from './routes/admin-users-query.js'
// Wallet 用户钱包读 (#1013 Phase 80) — 10 endpoints
import { registerWalletReadRoutes } from './routes/wallet-read.js'
// Wallet 用户钱包写 (#1013 Phase 81) — 5 endpoints (connect + withdraw)
import { registerWalletWriteRoutes } from './routes/wallet-write.js'
// RFQ + Bid (#1013 Phase 82) — 9 endpoints (7 rfqs + 2 bids)
import { registerRfqsRoutes } from './routes/rfqs.js'
// Orders 读端点 (#1013 Phase 83) — 4 endpoints (list/export/chain/detail)
import { registerOrdersReadRoutes } from './routes/orders-read.js'
// Orders 动作端点 (#1013 Phase 84) — 4 endpoints (batch-ship/confirm-in-person/action/force-timeout)
import { registerOrdersActionRoutes } from './routes/orders-action.js'
// Orders 下单端点 (#1013 Phase 85) — 1 endpoint (338-line POST /api/orders)
import { registerOrdersCreateRoutes } from './routes/orders-create.js'
// Disputes 读端点 (#1013 Phase 86) — 5 endpoints (list/similar/detail/evidence-list/parties)
import { registerDisputesReadRoutes } from './routes/disputes-read.js'
// Disputes 写端点 (#1013 Phase 87) — 5 endpoints (respond/arbitrate/add-evidence/evidence-blob/request-evidence)
import { registerDisputesWriteRoutes } from './routes/disputes-write.js'
// Products 声明 (#1013 Phase 88) — 2 endpoints (POST claim + GET claims)
import { registerProductsClaimsRoutes } from './routes/products-claims.js'
// Products aliases (#1013 Phase 89) — 4 endpoints
import { registerProductsAliasesRoutes } from './routes/products-aliases.js'
// Products meta (#1013 Phase 90) — 4 endpoints (price-history/preview/can-share/get-or-create-share)
import { registerProductsMetaRoutes } from './routes/products-meta.js'
// Products external links (#1013 Phase 91) — 3 endpoints
import { registerProductsLinksRoutes } from './routes/products-links.js'
// Products CRUD lighter (#1013 Phase 92) — 3 endpoints (GET :id / PATCH status / DELETE)
import { registerProductsCrudRoutes } from './routes/products-crud.js'
// Products PUT update (#1013 Phase 93) — 1 endpoint (123 行)
import { registerProductsUpdateRoutes } from './routes/products-update.js'
// Products POST create (#1013 Phase 94) — 1 endpoint (232 行)
import { registerProductsCreateRoutes } from './routes/products-create.js'
// Products GET list (#1013 Phase 95) — 1 endpoint (399 行)
import { registerProductsListRoutes } from './routes/products-list.js'
// P2P 商品 (#1013 Phase 96) — 5 endpoints
import { registerP2pProductsRoutes } from './routes/p2p-products.js'
// KYC 用户端 (#1013 Phase 97) — 2 endpoints
import { registerKycRoutes } from './routes/kyc.js'
// 邀请码 (#1013 Phase 98) — 3 endpoints
import { registerReferralRoutes } from './routes/referral.js'
// 签到 + 任务 (#1013 Phase 99) — 3 endpoints
import { registerCheckinTasksRoutes } from './routes/checkin-tasks.js'
// AI 卖家辅助 (#1013 Phase 100) — 2 endpoints
import { registerAiRoutes } from './routes/ai.js'
// Admin 读表盘 (#1013 Phase 101) — 4 endpoints
import { registerAdminReportsRoutes } from './routes/admin-reports.js'
// Peer directory (#1013 Phase 102) — 2 endpoints
import { registerPeersRoutes } from './routes/peers.js'
// 物流 (#1013 Phase 103) — 2 endpoints
import { registerLogisticsRoutes } from './routes/logistics.js'
// 搜索/查询 (#1013 Phase 104) — 5 endpoints
import { registerSearchRoutes } from './routes/search.js'
// Admin 分析看板 (#1013 Phase 105) — 5 endpoints
import { registerAdminAnalyticsRoutes } from './routes/admin-analytics.js'
// Admin 运维杂项 (#1013 Phase 106) — 5 endpoints
import { registerAdminOpsRoutes } from './routes/admin-ops.js'
// 公开工具小端点 (#1013 Phase 107) — 6 endpoints
import { registerPublicUtilsRoutes } from './routes/public-utils.js'
// Agent reputation (#1013 Phase 108) — 2 endpoints
import { registerAgentReputationRoutes } from './routes/agent-reputation.js'
// Checkout helpers (#1013 Phase 109) — 2 endpoints
import { registerCheckoutHelpersRoutes } from './routes/checkout-helpers.js'
// 公开 dashboards (#1013 Phase 110) — 2 endpoints
import { registerDashboardsRoutes } from './routes/dashboards.js'
// Admin 系统健康 (#1013 Phase 111) — 1 endpoint
import { registerAdminHealthRoutes } from './routes/admin-health.js'
// Buyer feeds (#1013 Phase 112) — 3 endpoints
import { registerBuyerFeedsRoutes } from './routes/buyer-feeds.js'
// URL 认领/验证 (#1013 Phase 113) — 2 endpoints
import { registerUrlClaimRoutes } from './routes/url-claim.js'
// Import product (#1013 Phase 114) — 1 endpoint
import { registerImportProductRoutes } from './routes/import-product.js'
// Agent buy (#1013 Phase 115) — 1 endpoint
import { registerAgentBuyRoutes } from './routes/agent-buy.js'
// Auth 读 (#1013 Phase 116) — 2 endpoints
import { registerAuthReadRoutes } from './routes/auth-read.js'
// Auth login (#1013 Phase 117) — 1 endpoint
import { registerAuthLoginRoutes } from './routes/auth-login.js'
// Auth register (#1013 Phase 118) — 1 endpoint
import { registerAuthRegisterRoutes } from './routes/auth-register.js'
import { registerBuildFeedbackRoutes } from './routes/build-feedback.js'
import { initBuildFeedbackSchema } from '../layer2-business/L2-8-feedback/build-feedback-engine.js'
import { registerBuildTasksRoutes } from './routes/build-tasks.js'
import { registerPublicBuildTasksRoutes } from './routes/public-build-tasks.js'
import { initBuildTasksSchema } from '../layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildTaskAgentMetadataSchema } from '../layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'
import { initTaskProposalSchema } from '../layer2-business/L2-9-contribution/task-proposal-store.js'
import { initTaskProposalAiSchema } from '../layer2-business/L2-9-contribution/task-proposal-ai-store.js'
import { initTaskProposalDraftLinkSchema } from '../layer2-business/L2-9-contribution/task-proposal-draft.js'
import { initBuildTaskQuotaSchema } from '../layer2-business/L2-9-contribution/build-task-quota.js'
import { registerBuildTaskQuotaRoutes } from './routes/build-task-quota.js'
import { registerAdminOperatorClaimRoutes } from './routes/admin-operator-claims.js'
import { registerTaskProposalsRoutes } from './routes/task-proposals.js'
import { participationRecordingActive, matchingRewardsActive } from './pv-kill-switch.js'   // Category C: participation recording (default ON) vs matching-rewards payout (default OFF)
import { createPvSettlementEngine } from './internal/pv-settlement.js'   // matching-rewards engine EXCISED — no-op stub (see internal/pv-settlement.ts)
import { createLocalSeedSigner, type WalletSigner } from './internal/wallet-signer.js'   // Phase 0: hot-wallet custody signer seam (docs/HOT-WALLET-CUSTODY-MIGRATION.md)
import { createCfOriginGuard } from './cf-origin-guard.js'   // Cloudflare-only origin guard (off by default)
import { createSlidingWindowLimiter } from './rate-limit.js'
import { registerBuildReputationRoutes } from './routes/build-reputation.js'
import { initBuildReputationSchema } from '../layer2-business/L2-9-contribution/build-reputation-engine.js'
import { initGithubCredentialStoreSchema } from '../layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../layer2-business/L2-9-contribution/identity-binding-store.js'
import { initIdentityClaimChallengeSchema } from '../layer2-business/L2-9-contribution/identity-claim-challenge-store.js'
import { initAdminCoordinationSchema } from '../layer2-business/L2-9-contribution/admin-coordination-store.js'
import { registerContributionIdentityRoutes } from './routes/contribution-identity.js'
import { registerContributionScoreRoutes } from './routes/contribution-score.js'
import { registerContributionFactsRoutes } from './routes/contribution-facts.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── 链上地址派生 ──────────────────────────────────────────────
const MASTER_SEED = process.env.WALLET_MASTER_SEED ?? 'webaz-dev-seed-changeme'
const NODE_ENV = process.env.NODE_ENV || 'development'
const IS_PROTECTED_ENV = ['production', 'staging', 'preview'].includes(NODE_ENV)

// Wave H-1 P0-2 + 2026-05-22 audit P0：MASTER_SEED 安全检测
// 1) 默认 seed → 在受保护环境（production/staging/preview）强制退出
// 2) 非默认 seed 但长度 < 32 → 也拒（防设了弱 seed）
// 3) dev 环境警告但允许（开发体验）
if (MASTER_SEED === 'webaz-dev-seed-changeme') {
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.warn('⚠⚠⚠ MASTER_SEED 使用默认值！')
  console.warn('⚠ 此模式下 HOT_WALLET 私钥可被任何人推导。')
  console.warn(`⚠ 当前 NODE_ENV = "${NODE_ENV}"`)
  console.warn('⚠ 生产部署必须设：export WALLET_MASTER_SEED=<32+ 字符随机串>')
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (IS_PROTECTED_ENV) {
    console.error(`🛑 拒绝在 ${NODE_ENV} 环境使用默认 MASTER_SEED — 进程退出。`)
    process.exit(1)
  }
} else if (MASTER_SEED.length < 32) {
  console.error(`🛑 MASTER_SEED 太短（${MASTER_SEED.length} 字符）— 至少 32 字符。进程退出。`)
  console.error('   建议生成：openssl rand -hex 32')
  process.exit(1)
}

// Wave H-1 P0-1: 安全 api_key 生成（替代 generateId 的 Math.random，提供 256 位密码学熵）
function generateSecureKey(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('hex')}`
}

// Phase 0 (docs/HOT-WALLET-CUSTODY-MIGRATION.md): all USDC-custody key derivation / signing goes
// through the WalletSigner seam. LocalSeedSigner reproduces the historical HMAC-SHA256(MASTER_SEED, role)
// derivation EXACTLY — addresses + signatures unchanged. Phase 1+ swaps in KMS / multisig signers
// (HOT_WALLET_SIGNER env) behind the same interface, no call-site changes.
const walletSigner: WalletSigner = createLocalSeedSigner(MASTER_SEED)

function deriveDepositAddress(userId: string): string {
  return walletSigner.depositAddress(userId)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const db = initDatabase()
setSeamDb(db)  // RFC-016 Phase 0:注入异步 DB seam(本进程)

// #1013 Phase 9: claim-verify helpers 预绑 db（routes/claim-verify.ts 已 export 多签名版本）
// 让 product-claims / review-claims / etc 跨域调用零侵入（无需改 callsite signature）
const isEligibleClaimVerifier = (userId: string) => isEligibleClaimVerifierRaw(db, userId)
const activeClaimTaskCountForVerifier = (userId: string) => activeClaimTaskCountForVerifierRaw(db, userId)
const settleClaimTask = (taskId: string) => settleClaimTaskRaw(db, generateId, taskId)
const notifyEligibleVerifiers = (args: Parameters<typeof notifyEligibleVerifiersRaw>[2]) => notifyEligibleVerifiersRaw(db, generateId, args)
initSystemUser(db)
initDisputeSchema(db)
initNotificationSchema(db)
initSkillSchema(db)
initSkillMarketSchema(db)
initReputationSchema(db)
initOrderChainSchema(db)
initBuildFeedbackSchema(db)   // RFC-004 build_feedback
initBuildTasksSchema(db)      // RFC-006 build_tasks(协调层)
initBuildTaskAgentMetadataSchema(db) // PR9B — agent-ready task metadata satellite(schema only;FUTURE-TASK-BOARD-V1-DESIGN #326)
initTaskProposalSchema(db)    // Task Proposal Inbox v1 — suggestion inbox(maintainer review;never auto build_task)
initTaskProposalAiSchema(db)  // Task Proposal AI-assist — assistant-only recommendation/evidence(human decides)
initTaskProposalDraftLinkSchema(db) // Task Proposal draft links — source proposal ↔ draft task(converted at publish)
initBuildTaskQuotaSchema(db)  // PR #18 — build_task create quota-increase requests(non-root request → root grant)
initBuildReputationSchema(db) // RFC-006 build_reputation(独立池 + 贡献者看板)
initGithubCredentialStoreSchema(db) // PR 3B-3a — GitHub credential store + RFC-017 fact layer (schema only)
initIdentityBindingSchema(db) // PR 4a — GitHub identity → WebAZ account binding (append-only events + active projection)
initIdentityClaimChallengeSchema(db) // PR-F1 — identity-claim publication-challenge state (server-side nonce hash; schema only)
// NB: initAdminCoordinationSchema is intentionally NOT called here — it FKs admin_audit_log, which is
// created later; it runs right after the admin_audit_log block below (search initAdminCoordinationSchema).
initSnfSchema(db)
initExternalAnchorSchema(db)
// 启动时检查月衰减（last_decay_at ≥25 天才触发，重启幂等）
try {
  const r = applyDecayIfDue(db)
  if (r.applied) console.log(`[rep-decay] applied rate=${r.rate} affected=${r.affected}`)
} catch (e) { console.warn('[rep-decay] startup tick failed:', (e as Error).message) }
initEvidenceRequestSchema(db)
ensureEvidenceColumns(db)
initAnchorRegistrySchema(db)

// boot-order fix（2026-05-26）：anchor migration 引用 users.handle / search_anchor，
// 但对应 ALTER TABLE 在 735+/958+ 行才跑。旧 DB（v3 era）触发 prepare 失败 → 此处 catch
// 后 warn 不阻塞 server，但日志噪音 → 预热那两列让 migration 真正能跑。
// handle 现由 initRegisterListSearchColumns 在此预热(与 MCP runtime schema 同源,见
// src/runtime/webaz-schema-helpers.ts)；该 helper 同时建 permanent_code/region + 11 个
// products 结构化字段(纯非钱列,从下方各 inline 块单点收口到此处,CREATE-before-ALTER 不变)。
initRegisterListSearchColumns(db)
try { db.exec("ALTER TABLE users ADD COLUMN search_anchor TEXT") } catch {}

// E1 一次性迁移：把 users.search_anchor 旧数据搬进 anchor_registry（target_kind='user'）
// handle ≤ 12 字 + 至少有 search_anchor 的用户才搬；旧 search_anchor 当 middle 取首 4 位（位数不足补 0）
try {
  const oldAnchors = db.prepare(`SELECT id, handle, search_anchor FROM users WHERE search_anchor IS NOT NULL AND search_anchor != ''`).all() as Array<{ id: string; handle: string | null; search_anchor: string }>
  let migrated = 0
  for (const u of oldAnchors) {
    if (!u.handle || u.handle.length < 3 || u.handle.length > 12) continue
    // 把 search_anchor 字符 normalize → 取前 4 个 alphanumeric
    const middle = (u.search_anchor.toLowerCase().match(/[a-z0-9]/g) || []).slice(0, 4).join('').padEnd(4, '0')
    // 必须含数字：若不含则替换最后位为 '1'
    const finalMiddle = /[0-9]/.test(middle) ? middle : middle.slice(0, 3) + '1'
    const vol = userReferralVolume(db, u.id)
    const tier = computeTierLetter(vol)
    const anchor = `${u.handle.toLowerCase()}${finalMiddle}${tier.toLowerCase()}`
    // 已存在则跳过
    const exists = db.prepare(`SELECT 1 FROM anchor_registry WHERE anchor = ?`).get(anchor)
    if (exists) continue
    try {
      db.prepare(`INSERT INTO anchor_registry (anchor, prefix, middle, tier_letter, owner_id, target_kind, target_id, status) VALUES (?,?,?,?,?,?,?, 'active')`)
        .run(anchor, u.handle.toLowerCase(), finalMiddle, tier, u.id, 'user', u.id)
      migrated++
    } catch { /* 唯一性冲突 — 跳过 */ }
  }
  if (migrated > 0) console.log(`[anchor-registry] migrated ${migrated} legacy search_anchor → anchor_registry (target=user)`)
} catch (e) { console.warn('[anchor-registry] migration:', (e as Error).message) }

// ─── 验证员白名单表 ───────────────────────────────────────────────
initVerifierWhitelistSchema(db)

// ─── MCP 工具调用埋点表（远程上报）─────────────────────────────────
initMcpToolCallsSchema(db)

// ─── 内部审核账号（固定 ID，密钥由 MASTER_SEED 派生，幂等）────────
const INTERNAL_AUDITOR_ID  = 'usr_iaudit_001'
const INTERNAL_AUDITOR_KEY = 'key_iaudit_' + createHmac('sha256', MASTER_SEED).update('internal_auditor_v1').digest('hex').slice(0, 32)
;(() => {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(INTERNAL_AUDITOR_ID)
  if (!existing) {
    db.prepare('INSERT INTO users (id, name, role, roles, api_key) VALUES (?,?,?,?,?)')
      .run(INTERNAL_AUDITOR_ID, '内部审核员', 'buyer', JSON.stringify(['buyer']), INTERNAL_AUDITOR_KEY)
    db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?,0)').run(INTERNAL_AUDITOR_ID)
    console.log(`[WebAZ] 内部审核账号已创建，API Key: ${INTERNAL_AUDITOR_KEY}`)
  }
  db.prepare('INSERT OR IGNORE INTO verifier_whitelist (user_id, note) VALUES (?,?)').run(INTERNAL_AUDITOR_ID, '内部审核员')
})()

// 永久测试账户：HMAC 派生密钥（68 字符），即使 db 重建也能稳定复现。
// 注意：role 'admin' 是协议外管理身份，仅这两个 bootstrap 账户能直接拿到。
const PERMANENT_ACCOUNTS = [
  {
    id: 'usr_admin_a_001',     name: '管理员A', role: 'admin',    roles: ['buyer', 'admin'],
    seed: 'admin_a_v1',        balance: 1000,
  },
  {
    id: 'usr_verifier_a_001',  name: '审核A',   role: 'verifier', roles: ['verifier'],
    seed: 'verifier_a_v1',     balance: 1000,
    whitelist: { tier: 'trial-1', daily_quota: 2 },
  },
] as const

// boot-order fix（2026-05-26）：PERMANENT_ACCOUNTS bootstrap 原本在此处运行，
// 但引用了 users.email_verified / verifier_whitelist.tier 等 ALTER 列 + verifier_stats 表，
// 这些 schema 在下方更晚才建/加 → 旧 DB（v3 era）boot 时 crash。
// 修复：把 bootstrap IIFE 整体后移到所有 schema setup 完成之后（紧贴 const app = express() 之前）。
// 见文件末尾搜索 "PERMANENT_ACCOUNTS bootstrap (moved here)"。

// ─── Schema 迁移（幂等）──────────────────────────────────────────
try { db.exec('ALTER TABLE wallets ADD COLUMN deposit_address TEXT') } catch {}

// 账户管理 P0/P1 字段
for (const stmt of [
  'ALTER TABLE users ADD COLUMN email          TEXT',
  'ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN phone          TEXT',
  'ALTER TABLE users ADD COLUMN phone_verified INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN password_hash  TEXT',
  'ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN locked_until   TEXT',
]) { try { db.exec(stmt) } catch {} }

// 邮箱唯一性（partial index — 仅约束非 NULL）
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL') } catch {}

// Tokenomics 推土机轨道 — Phase 1（分享现金分润）
for (const stmt of [
  'ALTER TABLE users ADD COLUMN sponsor_id   TEXT',
  'ALTER TABLE users ADD COLUMN sponsor_path TEXT',
  // users.region moved to initRegisterListSearchColumns (single source, shared w/ MCP) — see ~line 494.
  // Admin 分级：root 全权 / regional 按 admin_scope 区域受限
  "ALTER TABLE users ADD COLUMN admin_type   TEXT",   // root | regional
  "ALTER TABLE users ADD COLUMN admin_scope  TEXT",   // global | china | us | eu | india | singapore
  // Admin 权限维度（JSON 数组）— users / content / arbitration / protocol / verifier_mgmt；root 隐式 = all
  "ALTER TABLE users ADD COLUMN admin_permissions TEXT",
  'ALTER TABLE products ADD COLUMN commission_rate REAL DEFAULT 0.10',
  'ALTER TABLE orders ADD COLUMN l1_uid TEXT',
  'ALTER TABLE orders ADD COLUMN l2_uid TEXT',
  'ALTER TABLE orders ADD COLUMN l3_uid TEXT',
  'ALTER TABLE orders ADD COLUMN snapshot_commission_rate REAL',
  'ALTER TABLE orders ADD COLUMN settled_commission_at TEXT',
  // H-2 fix migration（M7.3a 发现）：老 DB 没有该列，CREATE TABLE IF NOT EXISTS 不会补
  'ALTER TABLE orders ADD COLUMN buyer_region TEXT',
  // M7.4：claim 验证发起期间，订单自动判责 / 自动确认 暂缓（has_pending_claim=1）
  'ALTER TABLE orders ADD COLUMN has_pending_claim INTEGER DEFAULT 0',
  // M8 二手板块：source = 'shop' (商家商品) / 'secondhand' (个人闲置)；
  // fulfillment_mode = 'shipping' (三方物流) / 'in_person' (面交)
  "ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'shop'",
  "ALTER TABLE orders ADD COLUMN fulfillment_mode TEXT DEFAULT 'shipping'",
  // settleOrder 写入 settled_pv_at 但老 schema 缺失（独立 bug，二手验收时发现）
  'ALTER TABLE orders ADD COLUMN settled_pv_at TEXT',
  // Bug-B fix：fault_*→completed 资金处置幂等标记（settleFault 写入）
  'ALTER TABLE orders ADD COLUMN settled_fault_at TEXT',
  // P0.1：RFQ 路径的卖家 bid_stake 保留到 completed，fault 时没收（防中标后弃单）
  'ALTER TABLE orders ADD COLUMN bid_stake_held REAL DEFAULT 0',
  // Wave B-5: 配送时间窗 — 买家下单时指定偏好（JSON: { day_type, time_range, flexible }）
  'ALTER TABLE orders ADD COLUMN delivery_window TEXT',
  // Wave C-1: variants Phase 2 — 关联购买的具体 SKU（null = 该商品无 variant）
  'ALTER TABLE orders ADD COLUMN variant_id TEXT',
  'ALTER TABLE orders ADD COLUMN variant_options_snapshot TEXT',
  // C-2: 礼物订单 — 收件人与付款人分离 + 礼物消息（卖家发货时按礼物模式打包，不显示付款人）
  'ALTER TABLE orders ADD COLUMN gift_recipient_name TEXT',
  'ALTER TABLE orders ADD COLUMN gift_recipient_phone TEXT',
  'ALTER TABLE orders ADD COLUMN gift_message TEXT',
  // C-3: 订单保险 — 已支付保费（默认 1%，争议时若卖家余额不足由保险池补足）
  'ALTER TABLE orders ADD COLUMN insurance_premium REAL DEFAULT 0',
  // RFC-008 stage 1：每单【赔付背书】快照 = 该单实际背书的卖家质押额。
  //   起步免赔付阶段(require_seller_stake=0)= 0;违约结算只按此数没收,绝不扣未背书的钱 → 根治印钱 bug。
  'ALTER TABLE orders ADD COLUMN stake_backing REAL DEFAULT 0',
  // RFC-007 stage 2：卖家【主动拒单】记录(vs 沉默超时)。reason_code 供 stage 3/5 判定客观/主观。
  'ALTER TABLE orders ADD COLUMN decline_reason_code TEXT',
  'ALTER TABLE orders ADD COLUMN declined_at TEXT',
  // RFC-007 stage 3：客观理由拒单 → 【临时判责】(provisional)。先不结算,给卖家举证窗口(stage 5 仲裁翻案)。
  //   pending=1 + deadline 到期仍无人仲裁 → checkTimeouts 终结为违约(settleFault)。stage 5 仲裁维持则翻 declined_nofault。
  'ALTER TABLE orders ADD COLUMN decline_objective_pending INTEGER DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN decline_contest_deadline TEXT',
  // RFC-007 stage 5：卖家已就临时判责发起仲裁举证 → 暂停 checkTimeouts 自动终结,等人工仲裁裁决。
  'ALTER TABLE orders ADD COLUMN decline_contested INTEGER DEFAULT 0',
]) { try { db.exec(stmt) } catch {} }

// M8 二手板块：独立表，避免污染 products 商家货架
// 关键差异：1 件即 1 件（无库存）、个人卖家无需 seller 角色、无质保、协议费 1%（vs 商家 2%）
try {
  initSecondhandItemsSchema(db)
} catch (e) { console.error('[secondhand schema]', e) }

db.exec(`
  CREATE TABLE IF NOT EXISTS commission_records (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL,
    beneficiary_id  TEXT,
    source_buyer_id TEXT NOT NULL,
    level           INTEGER NOT NULL,
    amount          REAL NOT NULL,
    rate            REAL NOT NULL,
    region          TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(order_id, level)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_commission_beneficiary ON commission_records(beneficiary_id, created_at)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_commission_source ON commission_records(source_buyer_id, created_at)') } catch {}

// ─── 商品分享归因 (product_share_attribution) ─────────────────
// 与 PV 系统完全独立的"商品级"分享链。每次 receipient 点击 shareable 时记录 first-touch（30 天锁定）。
// 下单时 L1/L2/L3 完全从此表反推：L1 = 谁分享了该商品给 buyer，L2 = 谁分享了该商品给 L1，依此类推。
// 注意：与 users.sponsor_id (PV 关系) 解耦 — PV 下线给 PV 上线分享商品，PV 上线在该商品里就是 L1。
db.exec(`
  CREATE TABLE IF NOT EXISTS product_share_attribution (
    product_id    TEXT NOT NULL,
    recipient_id  TEXT NOT NULL,
    sharer_id     TEXT NOT NULL,
    shareable_id  TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL,
    PRIMARY KEY (product_id, recipient_id)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_psa_sharer ON product_share_attribution(sharer_id, product_id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_psa_recipient ON product_share_attribution(recipient_id, product_id)') } catch {}
// provenance (additive, audit-only — does NOT change commission math): how this attribution was created.
//   source_type = 'direct_share'(商品/笔记直接分享) | 'shop_referral_verified_purchase'(店铺推荐懒升级)
try { db.exec("ALTER TABLE product_share_attribution ADD COLUMN source_type TEXT") } catch {}
try { db.exec("ALTER TABLE product_share_attribution ADD COLUMN source_ref TEXT") } catch {}
try { db.exec("ALTER TABLE product_share_attribution ADD COLUMN source_shop_seller_id TEXT") } catch {}
try { db.exec("ALTER TABLE product_share_attribution ADD COLUMN source_qualified_order_id TEXT") } catch {}

// ─── 店铺推荐锚定 (shop_referral_attribution) ─────────────────
// 店铺推荐【只】锚定推荐关系 + 二叉树位置 + 店铺来源,first-touch 30 天锁;它【不是】全店佣金权。
// 仅当被推荐人后来真实下单店铺里的某商品、且推荐人自己也 completed 买过同款时,才在下单时被【懒升级】
// 为该商品的 product_share_attribution(见 orders-create maybePromoteShopReferralToProductAttribution)。
db.exec(`
  CREATE TABLE IF NOT EXISTS shop_referral_attribution (
    seller_id     TEXT NOT NULL,
    recipient_id  TEXT NOT NULL,
    referrer_id   TEXT NOT NULL,
    ref_code      TEXT NOT NULL,
    side          TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL,
    source        TEXT DEFAULT 'shop_referral',
    PRIMARY KEY (seller_id, recipient_id)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sra_referrer ON shop_referral_attribution(referrer_id, seller_id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sra_recipient ON shop_referral_attribution(recipient_id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sra_expires ON shop_referral_attribution(expires_at)') } catch {}

// 商品分享链反推：buyer 买商品 P 时 → L1=谁分享 P 给 buyer → L2=谁分享 P 给 L1 → ...
// 与 sponsor_path / placement_path 完全无关。某层断链 → 该层 null（佣金回流协议池）。
function getProductShareChain(productId: string, buyerId: string, depth = 3): (string | null)[] {
  const chain: (string | null)[] = []
  let recipient = buyerId
  const seen = new Set<string>([buyerId])  // 防环路
  for (let i = 0; i < depth; i++) {
    const row = db.prepare(`
      SELECT sharer_id FROM product_share_attribution
      WHERE product_id = ? AND recipient_id = ? AND expires_at > datetime('now')
    `).get(productId, recipient) as { sharer_id: string } | undefined
    if (!row || !row.sharer_id || seen.has(row.sharer_id)) {
      while (chain.length < depth) chain.push(null)
      return chain
    }
    chain.push(row.sharer_id)
    seen.add(row.sharer_id)
    recipient = row.sharer_id
  }
  return chain
}

db.exec(`
  CREATE TABLE IF NOT EXISTS region_config (
    region          TEXT PRIMARY KEY,
    max_levels      INTEGER NOT NULL,   -- 0=完全禁 MLM / 1=仅 L1 / 2=L1+L2 / 3=全三级（仅控佣金层级）
    active          INTEGER DEFAULT 1,
    mlm_ui_visible  INTEGER DEFAULT 1,  -- 0=UI 全面隐藏推土机/分润链/佣金展示
    pv_enabled      INTEGER DEFAULT 0   -- 区域级 PV 开关（独立于佣金层级 max_levels）。默认 0=关
  )
`)
// Phase B 迁移：加 mlm_ui_visible 列
try { db.exec('ALTER TABLE region_config ADD COLUMN mlm_ui_visible INTEGER DEFAULT 1') } catch { /* 已存在 */ }
// 2026-06-04 解耦迁移：加 pv_enabled 列（区域级 PV 开关，与佣金层级 max_levels 分离）
try { db.exec('ALTER TABLE region_config ADD COLUMN pv_enabled INTEGER DEFAULT 0') } catch { /* 已存在 */ }
// Phase B 初始值：max_levels=0 或 =1 的地区同时隐藏 MLM UI
// 目前所有已配置地区 ≥2，不自动降为 0（由 admin 手动配置真正禁 MLM 的地区）
// mlm_ui_visible=1 保持默认，只有 max_levels=0 时前端才完全隐藏
try { db.exec("UPDATE region_config SET mlm_ui_visible = 0 WHERE max_levels = 0") } catch {}

// 2026-05-22 B1：跨境税费估算字段（仅"进口到此 region"的估算关税 %）
// 这是粗略估算 — 实际由海关认定。设计目的是让买家心理预期，避免"被扣关震惊"
try { db.exec('ALTER TABLE region_config ADD COLUMN est_import_duty_pct REAL DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE region_config ADD COLUMN est_import_threshold_waz REAL DEFAULT 0') } catch {}
// 初始值（粗略，admin 可调）：
// 中国 13% VAT + 阈值 50 WAZ；US ~7% sales tax + 800 阈值；EU 19% VAT + 0；其他地区暂 0
;[
  ['china',         0.13,  50],
  ['us',            0.07, 800],
  ['eu',            0.19,   0],
  ['india',         0.18,   0],
  ['singapore',     0.09, 100],
  ['ae',            0.05,   0],
  ['qa',            0.05,   0],
  ['sa',            0.05,   0],
  ['global',        0.10,   0],   // 兜底
  ['global_north',  0.10,   0],
].forEach(([region, pct, threshold]) => {
  try {
    db.prepare(`UPDATE region_config SET est_import_duty_pct = ?, est_import_threshold_waz = ?
                WHERE region = ? AND est_import_duty_pct = 0`).run(pct, threshold, region)
  } catch {}
})

// P13: 购物车 / P14: 关注关系（社交电商）→ server-schema.ts
initCartItemsSchema(db)
initFollowsSchema(db)

// P14: 用户 feed 可见性开关（默认公开）
try { db.exec("ALTER TABLE users ADD COLUMN feed_visible INTEGER DEFAULT 1") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN search_anchor TEXT") } catch {}   // P14.5：用户可填的"流量口令"（TikTok/小红书 引流回搜）
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT") } catch {}             // P14.5：一句话简介
// Wave F-2: 协议参数配置（admin 可调，不改代码）
db.exec(`
  CREATE TABLE IF NOT EXISTS protocol_params (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL,        -- JSON 编码（统一存字符串）
    type         TEXT NOT NULL,        -- 'number' | 'string' | 'boolean'
    description  TEXT,
    category     TEXT DEFAULT 'general', -- 'fee' | 'reward' | 'limit' | 'general'
    default_value TEXT,
    min_value    REAL,                  -- P0-2: number 类型才用
    max_value    REAL,                  -- P0-2: number 类型才用
    updated_at   TEXT DEFAULT (datetime('now')),
    updated_by   TEXT
  )
`)
try { db.exec('ALTER TABLE protocol_params ADD COLUMN min_value REAL') } catch {}
try { db.exec('ALTER TABLE protocol_params ADD COLUMN max_value REAL') } catch {}
// A-3: 协议参数变更审计日志
db.exec(`
  CREATE TABLE IF NOT EXISTS protocol_params_log (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    changed_by  TEXT,
    action      TEXT,                  -- 'update' | 'reset' | 'constitutional_reject_patch' | 'constitutional_reject_reset'
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_pp_log_key ON protocol_params_log(key, created_at DESC)') } catch {}

// 已注册默认参数（首次启动 seed） — P0-2 加 min/max 边界
const DEFAULT_PARAMS: Array<{ key: string; value: string; type: string; description: string; category: string; min?: number; max?: number }> = [
  // Category C:参与记录 vs 奖励兑付,分开两套开关。
  //  · 参与记录默认 ON:PV 是参与/贡献记录(非收益/非兑付/非权益),默认允许记录(只在显式 =0 时关)。
  //  · 匹配奖励引擎已切除(#401):该标志保留但只门控一个 no-op stub,无兑付路径;
  //    matching_rewards_activation_cleared = 法律/治理放行、matching_rewards_active = 运营开关。pre-launch 均 0。
  { key: 'participation_recording_active', value: '1', type: 'number', description: '参与记录开关:PV 生成+聚合(参与记录,非收益/非兑付);默认 1=开。置 0 才停止记录。', category: 'system', min: 0, max: 1 },
  { key: 'matching_rewards_active', value: '0', type: 'number', description: '匹配奖励运营开关(引擎已切除 #401,现仅门控 no-op stub;无兑付);默认 0=关。', category: 'system', min: 0, max: 1 },
  { key: 'matching_rewards_activation_cleared', value: '0', type: 'number', description: '奖励兑付法律/治理放行标志(开启奖励前必须经合规+治理审批置 1);默认 0。', category: 'system', min: 0, max: 1 },
  // RFC-008:平台费硬帽 2%(=当前稳态 → 治理只能在 0–2% 减免、永不涨)。合计封顶 = 平台费2% + fund_base1% = 3%。宪法级合法性见 CHARTER 修订(单独治理步)。
  { key: 'protocol_fee_rate_shop', value: '0.02', type: 'number', description: '商家订单平台费率(RFC-008 硬帽 2%,只减不涨;前期可减免)', category: 'fee', min: 0, max: 0.02 },
  { key: 'protocol_fee_rate_secondhand', value: '0.01', type: 'number', description: '二手订单平台费率(RFC-008 硬帽 2%,只减不涨)', category: 'fee', min: 0, max: 0.02 },
  { key: 'default_commission_rate', value: '0.05', type: 'number', description: '新商品默认分享佣金（对齐小红书 5-10%）', category: 'fee', min: 0, max: 0.50 },
  // RFC-008:fund_base 硬帽 1%;pre-launch 减免到 0(社区基金按真实 GMV 注入,0 GMV 时是无回报的税)。有真实 GMV 再由治理开启(≤1%)。
  { key: 'fund_base_rate', value: '0', type: 'number', description: '协议基金池基础费率（RFC-008 硬帽 1%;pre-launch 减免=0,有真实 GMV 再由治理开启 ≤1%）', category: 'fee', min: 0, max: 0.01 },
  // RFC-008:起步免赔付门槛。0 = bootstrap(新商家零质押、违约免赔付只退款+掉信誉,降进入门槛);1 = 要求卖家质押(下单锁 stake、违约真没收)。上轨道后由治理开启。
  // ⚠️ Codex #111:stake-required 模式(=1)【尚未实现】—— 下单不锁 stake、settleFault 仍按 stake_backing=0 不没收,
  //   开启会给出虚假"真没收"协议语义。故 max 锁 0(不可开启);待 Phase 3 钱路径迁移实现真锁(下单原子锁 balance→staked)再放开。
  { key: 'require_seller_stake', value: '0', type: 'number', description: 'RFC-008 是否要求卖家质押(0=起步免赔付/零门槛)。⚠️ stake-required(=1)未实现、暂锁 0 不可开启,见 Phase 3', category: 'fee', min: 0, max: 0 },
  // RFC-008 stage 2:违约罚没率,【与质押率解耦】(低质押=低摩擦 + 高罚没=强威慑,单一费率做不到)。
  //   背书订单:penalty = fault_penalty_rate × total,先扣 staked(封顶背书)再扣自由 balance(责任自负,真可执行)。
  //   起步免赔付(stake_backing=0):仍 0 没收,绝不碰新商家自由余额。settleFault 按订单 stake_backing 判定。
  { key: 'fault_penalty_rate', value: '0.30', type: 'number', description: 'RFC-008 违约罚没率(与质押率解耦;背书订单 staked 不足扣自由 balance;起步免赔付订单不适用)', category: 'fee', min: 0, max: 0.50 },
  // RFC-007 stage 3：客观理由拒单的【举证窗口】小时数。卖家声称客观无责拒单 → 临时判责,此窗口内可开仲裁(stage 5)举证;
  //   到期无人仲裁 → 自动终结为违约。窗口内买家 escrow 暂不退(随终结/翻案一次性结算),0=不给窗口(直接违约)。
  { key: 'decline_contest_window_hours', value: '24', type: 'number', description: 'RFC-007 客观拒单举证窗口(小时);到期未仲裁则终结为违约', category: 'limit', min: 0, max: 168 },
  { key: 'checkin_base_reward', value: '0.5', type: 'number', description: '每日签到基础奖励 WAZ', category: 'reward', min: 0, max: 10 },
  { key: 'streak_bonus_7', value: '5', type: 'number', description: '7 天里程碑额外奖励', category: 'reward', min: 0, max: 100 },
  { key: 'streak_bonus_30', value: '20', type: 'number', description: '30 天里程碑额外奖励', category: 'reward', min: 0, max: 500 },
  { key: 'streak_bonus_100', value: '50', type: 'number', description: '100 天里程碑额外奖励', category: 'reward', min: 0, max: 1000 },
  { key: 'max_addresses_per_user', value: '20', type: 'number', description: '单用户最多收货地址数', category: 'limit', min: 1, max: 100 },
  { key: 'max_compare_items', value: '4', type: 'number', description: '商品对比最多件数', category: 'limit', min: 2, max: 10 },
  { key: 'feedback_rate_per_hour', value: '5', type: 'number', description: '反馈工单每小时上限', category: 'limit', min: 1, max: 100 },
  { key: 'max_quota_extra_count', value: '50', type: 'number', description: 'PR#18 build_task 扩容申请:单次最多额外任务数', category: 'limit', min: 1, max: 500 },
  { key: 'max_quota_duration_hours', value: '72', type: 'number', description: 'PR#18 build_task 扩容授权:最长有效期(小时)', category: 'limit', min: 1, max: 2160 },
  { key: 'export_csv_limit', value: '5000', type: 'number', description: '订单导出 CSV 行数上限', category: 'limit', min: 100, max: 50000 },
  { key: 'return_window_extension_days', value: '0', type: 'number', description: '退货窗口全局延长天数', category: 'general', min: 0, max: 90 },
  // Wave G-2: USDC / 链上配置
  { key: 'waz_usdc_rate', value: '1.0', type: 'number', description: '1 USDC 兑换多少 WAZ', category: 'fee', min: 0.0001, max: 1000 },
  { key: 'usdc_min_deposit', value: '0.01', type: 'number', description: '最低充值 USDC（小于忽略）', category: 'limit', min: 0, max: 1000 },
  { key: 'usdc_min_withdraw_waz', value: '10', type: 'number', description: '最低提现 WAZ', category: 'limit', min: 0, max: 100000 },
  { key: 'kyc_required_withdraw_waz', value: '1000', type: 'number', description: '单次提现 ≥ 此值时强制 KYC（防洗钱）', category: 'limit', min: 0, max: 100000 },
  { key: 'kyc_daily_cumulative_waz', value: '3000', type: 'number', description: '24h 内累计提现 ≥ 此值时强制 KYC（防 smurf 分拆）', category: 'limit', min: 0, max: 100000 },
  { key: 'usdc_required_confirmations', value: '12', type: 'number', description: '充值需要的链上区块确认数', category: 'general', min: 1, max: 200 },
  // C-3: 订单保险费率
  { key: 'order_insurance_rate', value: '0.01', type: 'number', description: '订单保险费率（buyer opt-in）', category: 'fee', min: 0.001, max: 0.10 },
  // 2026-05-29 Skill 市场（知识技能）：销售协议费率 — 入 sys_protocol 运营池，不进 PV/佣金
  { key: 'skill_fee_rate', value: '0.05', type: 'number', description: '技能市场销售协议费率（作者净得 = 售价 × (1−费率)）', category: 'fee', min: 0, max: 0.30 },
  // S5：极致性价比认证 — daily batch 算法参数（公开框架，参数可调）
  { key: 'value_badge_top_pct', value: '0.20', type: 'number', description: '同类目价格前 X% 获得 💎 性价比认证', category: 'general', min: 0.05, max: 0.50 },
  { key: 'value_badge_min_sample', value: '5', type: 'number', description: '类目内最少 N 个商品才计算认证（防小样本）', category: 'general', min: 2, max: 50 },
  // 2026-05-23 Agent 治理 — 铁律节点开关（默认关，DAO Phase B 启用）
  { key: 'require_human_presence_for_vote', value: '1', type: 'number', description: 'Verifier 投票需 WebAuthn 一次性 token（1=强制 / 0=不强制）— spec §4 铁律', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_arbitrate', value: '1', type: 'number', description: 'Arbitrator 仲裁需 WebAuthn 一次性 token（1=强制 / 0=不强制）— spec §4 铁律', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_agent_revoke', value: '1', type: 'number', description: '用户撤销 agent 需 WebAuthn 一次性 token — spec §4 铁律', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_delete_passkey', value: '1', type: 'number', description: '删除 Passkey 自身需 WebAuthn 一次性 token — 防失窃 Passkey 不需 Passkey 就可删它,堵死自我无效化漏洞', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_identity_claim', value: '1', type: 'number', description: 'GitHub 身份认领绑定(claim commit)需 WebAuthn 一次性 token — 4b 身份认领的真人铁律门(PR-F0 plumbing;claim endpoint 尚未开放)。默认强制,与 vote/arbitrate/agent_revoke/delete_passkey 同级。', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_governance_apply', value: '1', type: 'number', description: '治理岗位申请(apply)需 WebAuthn 一次性 token — spec §3.1 Iron-Rule 反诱导 + 真人门', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_governance_activate', value: '1', type: 'number', description: 'maintainer 激活治理岗位(activate)需 WebAuthn 一次性 token — spec §4.4 Iron-Rule 真人签发', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_governance_resign', value: '1', type: 'number', description: '主动卸任治理岗位(resign)需 WebAuthn 一次性 token — spec §6.1 二次验证', category: 'security', min: 0, max: 1 },
  { key: 'require_human_presence_for_governance_appeal_resolve', value: '1', type: 'number', description: 'maintainer 裁决申诉(resolve appeal)需 WebAuthn 一次性 token — spec §7.2 Iron-Rule', category: 'security', min: 0, max: 1 },
  // ⚠️ Codex #100:提现真人在场是【铁律】,锁死 min=max=1 不可关闭(防 protocol admin PATCH 设 0 绕过)。
  //   且 wallet-write.ts 已【无条件】执行 Passkey gate(不读此 param),此处仅作诚实展示 + PATCH 防线。
  { key: 'require_human_presence_for_withdraw', value: '1', type: 'number', description: '提现(资金转出)需 WebAuthn 一次性 token — 真人在场【铁律,锁死不可关闭】;wallet-write 无条件执行', category: 'security', min: 1, max: 1 },
  { key: 'governance_resign_cooldown_days', value: '30', type: 'number', description: '主动卸任后冷却期(天)— 防止 farming 切换洗票 / 误操作反复', category: 'governance', min: 7, max: 365 },
  { key: 'governance_appeal_window_days', value: '14', type: 'number', description: '收到 auto_deactivate 通知后申诉窗口(天)— spec §7.2', category: 'governance', min: 7, max: 90 },
  { key: 'governance_appeal_min_reason_chars', value: '100', type: 'number', description: '申诉理由最少字符数(防空 appeal)', category: 'governance', min: 30, max: 2000 },
  // 2026-06-02 task #1093 阶段 5:auto-deactivate cron(per playbook §6.2 anchor=confirmed_wrong,not outlier)
  { key: 'governance_auto_deactivate_threshold_count', value: '5', type: 'number', description: '被复核确认判错累计次数阈值(触发 auto_deactivate)— playbook §6.2', category: 'governance', min: 1, max: 100 },
  { key: 'governance_auto_deactivate_threshold_pct', value: '0.3', type: 'number', description: '被确认判错比例阈值(0.3 = 30% 案件被推翻)— playbook §6.2', category: 'governance', min: 0.05, max: 1.0 },
  { key: 'governance_auto_deactivate_min_sample', value: '10', type: 'number', description: '最小样本数(tasks_done ≥ N 才参与判定)— 防小样本误杀', category: 'governance', min: 3, max: 1000 },
  { key: 'governance_auto_deactivate_cron_hours', value: '24', type: 'number', description: 'auto-deactivate cron 扫描间隔(小时)', category: 'governance', min: 1, max: 168 },
  // 2026-06-02 task #1093 stage 6:arbitrator pause/resume auto-judge clock(playbook §2.1)
  { key: 'arbitration_max_pause_hours', value: '168', type: 'number', description: 'arbitrator 暂停自动判定时钟的最大窗口(小时)— playbook §2.1 防无限拖延', category: 'governance', min: 24, max: 720 },
  // 2026-05-23 Agent 治理 — Trust 阶梯 rate limit（per minute）
  // 默认值偏宽松（人类正常浏览也走 /api/*）；DAO 治理可逐档收紧
  { key: 'agent_rate_new_per_min', value: '120', type: 'number', description: 'new 级 agent 速率：每分钟最多调用次数', category: 'limit', min: 10, max: 1000 },
  { key: 'agent_rate_trusted_per_min', value: '300', type: 'number', description: 'trusted 级 agent 速率：每分钟最多调用次数', category: 'limit', min: 30, max: 2000 },
  { key: 'agent_rate_quality_per_min', value: '600', type: 'number', description: 'quality 级 agent 速率：每分钟最多调用次数', category: 'limit', min: 100, max: 5000 },
  { key: 'agent_rate_legend_per_min', value: '1200', type: 'number', description: 'legend 级 agent 速率：每分钟最多调用次数', category: 'limit', min: 200, max: 20000 },
  // 2026-05-24 #958：雷达扫描 cell 大小 + k-匿名阈值 — DAO 可调节隐私 vs 实用性
  // cell_precision_deg: 经纬度截断精度（0.1° ≈ 11km × 11km；0.05° ≈ 5.5km；0.5° ≈ 55km）
  { key: 'nearby_cell_precision_deg', value: '0.1', type: 'number', description: '雷达扫描 cell 精度（度）— 越小越精细但匹配人数变少。0.1=11km / 0.05=5.5km / 0.5=55km', category: 'privacy', min: 0.05, max: 1.0 },
  { key: 'nearby_k_anonymity',        value: '3',   type: 'number', description: '雷达扫描 k-匿名阈值（≥ N 人才显示聚合数据）', category: 'privacy', min: 3, max: 50 },
  // 2026-06-02 W3.5-B:治理岗位上岗参数（docs/GOVERNANCE-ONBOARDING.md §2 + §6）
  { key: 'governance_onboarding.min_registration_days',     value: '30', type: 'number', description: '申请治理岗位前最少注册天数', category: 'governance', min: 0, max: 365 },
  { key: 'governance_onboarding.min_completed_orders',      value: '5',  type: 'number', description: '申请前最少完成订单数', category: 'governance', min: 0, max: 100 },
  { key: 'governance_onboarding.arbitrator_min_reputation', value: '95', type: 'number', description: '申请 arbitrator 最低 reputation', category: 'governance', min: 0, max: 100 },
  { key: 'governance_onboarding.verifier_min_reputation',   value: '90', type: 'number', description: '申请 verifier 最低 reputation', category: 'governance', min: 0, max: 100 },
  { key: 'governance_onboarding.role_switch_cooldown_days', value: '30', type: 'number', description: '卸任后再申请同角色冷却天数', category: 'governance', min: 0, max: 365 },
  { key: 'governance_onboarding.consent_delay_seconds',     value: '8',  type: 'number', description: '同意勾选反诱导延迟秒数（借鉴 RFC-002 §3.3）', category: 'governance', min: 0, max: 60 },
  { key: 'governance_onboarding.quiz_pass_score',           value: '80', type: 'number', description: 'onboarding 题目合格分数线（百分制）', category: 'governance', min: 50, max: 100 },
  // 2026-06-02 #1094 audit: arbitration.outlier_threshold_count/pct DELETED — playbook §6.2 明确
  // "outlier 标记仅作信号,无触发,无 protocol_params"。两个 key 直接违反 spec(stage 5 阶段已用
  // governance_auto_deactivate_* 取代,锚 confirmed_wrong 而非 outlier)。完整 audit 见
  // docs/PROTOCOL-PARAMS-AUDIT.md。
  { key: 'arbitration.escalation_amount_threshold',         value: '1000',type: 'number', description: '触发多 arbitrator 联审的 dispute_amount 阈值（WAZ）— phase B 实施,phase A 装饰', category: 'governance', min: 100, max: 100000 },
  // 2026-06-03 task #1095:CHARTER §4 I-4 宪法级修改保护(去人格化)
  // category='constitutional' 的 param 触发 only-increase 锁(防"先松保护再改一切")
  // 假设:这两个 param 都满足"increase = more protection"语义(见 admin-protocol-params.ts 头部注释)
  { key: 'constitutional_supermajority_ratio', value: '0.667', type: 'number', description: 'CHARTER §4 I-4:宪法级修改超级多数比例(phase A: user solo 1-of-1;phase B+: maintainer 多签 ratio)— only-increase 防绕过', category: 'constitutional', min: 0.5, max: 1.0 },
  { key: 'constitutional_notice_days', value: '60', type: 'number', description: 'CHARTER §4 I-4:宪法级修改 RFC 公示期(天)— only-increase 防绕过', category: 'constitutional', min: 30, max: 365 },
  // #420 P1-2/P1-3/P1-4:反滥用阈值(agent 信任公式 / strike 阶梯 / verifier outlier)→ 治理可调。
  // 默认值 === 抽取前硬编码字面量(单一真相源在 anti-abuse-thresholds.ts;测试强制校验一致)。
  ...ANTI_ABUSE_PARAMS,
]
for (const p of DEFAULT_PARAMS) {
  try { db.prepare(`INSERT OR IGNORE INTO protocol_params (key, value, type, description, category, default_value, min_value, max_value) VALUES (?,?,?,?,?,?,?,?)`)
    .run(p.key, p.value, p.type, p.description, p.category, p.value, p.min ?? null, p.max ?? null) } catch {}
  // 升级路径：对已存在但无 min/max 的行回填
  try { db.prepare(`UPDATE protocol_params SET min_value = COALESCE(min_value, ?), max_value = COALESCE(max_value, ?) WHERE key = ?`)
    .run(p.min ?? null, p.max ?? null, p.key) } catch {}
}
// 2026-06-02 #1094 audit:清除 spec violation 的遗留 keys(stage 5 用 governance_auto_deactivate_* 取代)
// playbook §6.2:"outlier 标记仅作信号,无触发,无 protocol_params"
try { db.prepare(`DELETE FROM protocol_params WHERE key IN ('arbitration.outlier_threshold_count', 'arbitration.outlier_threshold_pct')`).run() } catch {}

// 2026-06-03 task #1097: boot guard — 所有 category='constitutional' 的 param 必须 type='number'
// 理由:admin-protocol-params.ts only-increase hook 假设 "increase = more protection",
// 当前仅对 type='number' 生效。若有 bool 或 string constitutional param 被加入但未显式 override,
// only-increase 锁会**静默失效**,导致 CHARTER §4 I-4 防绕过被绕过。
// 这里 boot 时主动 assert,迫使加 param 的人 evaluate semantics 或显式扩展 hook。
;(() => {
  const offenders = DEFAULT_PARAMS.filter(p => p.category === 'constitutional' && p.type !== 'number')
  if (offenders.length > 0) {
    const list = offenders.map(p => `${p.key}(type=${p.type})`).join(', ')
    throw new Error(
      `[#1097 boot guard] constitutional params must be type='number' for only-increase hook to apply. ` +
      `Offenders: ${list}. ` +
      `Either change type to 'number', or move to a non-constitutional category, or extend the hook in admin-protocol-params.ts to cover this type.`
    )
  }
})()

// 2026-05-25 #1006：三个铁律节点默认值从 0 升级到 1（spec §4）
// 幂等迁移：仅对 admin 未显式调整过的行（updated_by IS NULL）启用强制
// 已有 admin 显式设置 0 的不覆盖（防意外覆写明确的关闭决策）
try {
  const ironRuleKeys = ['require_human_presence_for_vote', 'require_human_presence_for_arbitrate', 'require_human_presence_for_agent_revoke']
  const migrated = db.prepare(`UPDATE protocol_params
    SET value = '1', default_value = '1', updated_at = datetime('now')
    WHERE key IN (${ironRuleKeys.map(() => '?').join(',')})
      AND value = '0' AND updated_by IS NULL`).run(...ironRuleKeys)
  if (migrated.changes > 0) {
    console.log(`[migration #1006] 升级 ${migrated.changes} 个铁律节点默认值: 0 → 1`)
    // 写入 protocol_params_log 留痕
    for (const k of ironRuleKeys) {
      try { db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action)
                         VALUES (?,?,?,?,?,'migrate')`).run(generateId('ppl'), k, '0', '1', 'migration_#1006') } catch {}
    }
  }
} catch (e) { console.error('[migration #1006]', e) }

// RFC-008 迁移:费帽收紧 + fund_base pre-launch 减免。bounds 是协议护栏 → 无条件强制收窄(幂等)。
//   平台费帽 → 2%(=稳态,只减不涨);fund_base 帽 → 1%;合计封顶 3%。fund_base 值减免到 0(仅原始 0.01、未被治理改过)。
try {
  const feeCap = db.prepare(`UPDATE protocol_params SET max_value = 0.02, updated_at = datetime('now')
    WHERE key IN ('protocol_fee_rate_shop','protocol_fee_rate_secondhand') AND max_value > 0.02`).run()
  if (feeCap.changes > 0) console.log(`[migration RFC-008] 平台费硬帽收紧 ${feeCap.changes} 项 → max 2%`)
  const fbCap = db.prepare(`UPDATE protocol_params SET max_value = 0.01, updated_at = datetime('now')
    WHERE key = 'fund_base_rate' AND max_value > 0.01`).run()
  if (fbCap.changes > 0) console.log(`[migration RFC-008] fund_base 硬帽收紧 → max 1%`)
  // Codex #112 P1:仅收紧 max_value 不够 —— 历史 value > 新 cap 的行(如曾被治理调到 0.05)在 runtime
  //   getProtocolParam 直接读 value,仍按超帽费率收费,硬帽形同虚设。逐 key 把超帽 value clamp 回 cap,
  //   并记 protocol_params_log。先于下面 fund_base 的 pre-launch 减免(减免只针对未被治理改过的原始 0.01)。
  const clampFeeValue = (key: string, cap: number) => {
    const cur = db.prepare('SELECT value FROM protocol_params WHERE key = ? AND CAST(value AS REAL) > ?').get(key, cap) as { value: string } | undefined
    if (!cur) return
    db.prepare(`UPDATE protocol_params SET value = ?, updated_at = datetime('now') WHERE key = ? AND CAST(value AS REAL) > ?`).run(String(cap), key, cap)
    console.log(`[migration RFC-008] ${key} value ${cur.value} → ${cap}(clamp 回硬帽)`)
    try { db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action)
                       VALUES (?,?,?,?,?,'migrate')`).run(generateId('ppl'), key, cur.value, String(cap), 'migration_RFC-008') } catch {}
  }
  clampFeeValue('protocol_fee_rate_shop', 0.02)
  clampFeeValue('protocol_fee_rate_secondhand', 0.02)
  clampFeeValue('fund_base_rate', 0.01)
  const fb = db.prepare(`UPDATE protocol_params SET value = '0', default_value = '0', updated_at = datetime('now')
    WHERE key = 'fund_base_rate' AND value = '0.01' AND updated_by IS NULL`).run()
  if (fb.changes > 0) {
    console.log(`[migration RFC-008] fund_base_rate 0.01 → 0 (pre-launch 减免)`)
    try { db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action)
                       VALUES (?,?,?,?,?,'migrate')`).run(generateId('ppl'), 'fund_base_rate', '0.01', '0', 'migration_RFC-008') } catch {}
  }
} catch (e) { console.error('[migration RFC-008]', e) }

// Codex #111 P1:require_seller_stake 当前是【假开关】—— 即使=1,下单仍写 stake_backing=0、不锁 stake,
//   settleFault 仍按 backing=0 不没收;开启只会给出虚假"真没收"语义。stake-required 真锁留待 Phase 3。
//   在此之前:max 锁 0(不可开启)+ 若历史 DB 被设为 1 则降回 0(中和假开关),并记 protocol_params_log。
try {
  const cap = db.prepare(`UPDATE protocol_params SET max_value = 0, updated_at = datetime('now')
    WHERE key = 'require_seller_stake' AND max_value > 0`).run()
  if (cap.changes > 0) console.log(`[migration RFC-008] require_seller_stake max → 0(stake-required 未实现,锁关)`)
  const rss = db.prepare(`SELECT value FROM protocol_params WHERE key = 'require_seller_stake' AND CAST(value AS REAL) > 0`).get() as { value: string } | undefined
  if (rss) {
    db.prepare(`UPDATE protocol_params SET value = '0', updated_at = datetime('now') WHERE key = 'require_seller_stake'`).run()
    console.log(`[migration RFC-008] require_seller_stake value ${rss.value} → 0(假开关中和)`)
    try { db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action)
                       VALUES (?,?,?,?,?,'migrate')`).run(generateId('ppl'), 'require_seller_stake', rss.value, '0', 'migration_RFC-008') } catch {}
  }
} catch (e) { console.error('[migration require_seller_stake lock]', e) }

// Codex #100 P1:提现真人 Passkey 是【铁律】,绝不可被 protocol param 关闭。
//   旧默认 min=0/max=1 让 protocol admin PATCH 设 0 即可绕过(wallet-write 旧代码 if(param===1))。
//   双重防线:wallet-write 已改无条件执行 Passkey gate(不再读此 param);此处把 param 锁死 value/min/max=1
//   (PATCH 校验 min/max → 再不能设 0),并把历史 DB 的 value=0 / 放开的 min/max clamp 回 1,记 protocol_params_log。
try {
  const wkey = 'require_human_presence_for_withdraw'
  const lockBounds = db.prepare(`UPDATE protocol_params SET min_value = 1, max_value = 1, updated_at = datetime('now')
    WHERE key = ? AND (min_value != 1 OR max_value != 1)`).run(wkey)
  if (lockBounds.changes > 0) console.log(`[migration Codex#100] ${wkey} min/max → 1(铁律,锁死不可关闭)`)
  const hp = db.prepare(`SELECT value FROM protocol_params WHERE key = ? AND CAST(value AS REAL) != 1`).get(wkey) as { value: string } | undefined
  if (hp) {
    db.prepare(`UPDATE protocol_params SET value = '1', default_value = '1', updated_at = datetime('now') WHERE key = ?`).run(wkey)
    console.log(`[migration Codex#100] ${wkey} value ${hp.value} → 1(提现真人铁律,历史绕过值 clamp 回)`)
    try { db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action)
                       VALUES (?,?,?,?,?,'migrate')`).run(generateId('ppl'), wkey, hp.value, '1', 'migration_Codex-100') } catch {}
  }
} catch (e) { console.error('[migration require_human_presence_for_withdraw lock]', e) }

// Wave G-2: USDC ↔ WAZ 转换助手
function usdcToWaz(usdc: number): number {
  const rate = getProtocolParam<number>('waz_usdc_rate', 1.0)
  return Math.round(usdc * rate * 1e6) / 1e6  // 6 位小数对齐 USDC 精度
}
function wazToUsdc(waz: number): number {
  const rate = getProtocolParam<number>('waz_usdc_rate', 1.0)
  if (rate <= 0) return 0
  return Math.round((waz / rate) * 1e6) / 1e6
}

// 助手：读参数（cached 不实现，直接查 — admin 调整后立即生效）
function getProtocolParam<T = string | number | boolean>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value, type FROM protocol_params WHERE key = ?').get(key) as { value: string; type: string } | undefined
  if (!row) return fallback
  try {
    if (row.type === 'number') return Number(row.value) as unknown as T
    if (row.type === 'boolean') return (row.value === 'true' || row.value === '1') as unknown as T
    return row.value as unknown as T
  } catch { return fallback }
}

// PR-F0: 人工铁律 gate(consumeGateToken / requireHumanPresence)抽到 ./human-presence.ts 以便单测
// (behavior-zero)。必须在【首个使用点】(下方 arbitrate/vote/claim-verify/webauthn 等路由注册)之前
// 实例化 —— 故置于 db + getProtocolParam 定义之后。原为 hoisted 函数声明,现为工厂返回的 const。
const { consumeGateToken, requireHumanPresence } = createHumanPresence(db, getProtocolParam)

// Wave E-4 audit P1-3: 平台奖励发放审计 — 记录所有 platform → user 的免费 WAZ 拨付
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_reward_log (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    amount       REAL NOT NULL,
    source       TEXT NOT NULL,    -- 'daily_checkin' | 'task_<key>' | 'milestone_<n>'
    ref          TEXT,             -- 任务 key / streak day 等元信息
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_prl_user ON platform_reward_log(user_id, created_at DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_prl_source ON platform_reward_log(source, created_at DESC)') } catch {}

// 助手：从 sys_protocol 扣 + 给 user 加 + 记日志（事务内调用）
// sys_protocol 余额允许负（表示协议对用户的负债 — 后续协议费流入抵消）
function disbursePlatformReward(userId: string, amount: number, source: string, ref?: string | null): void {
  if (amount <= 0) return
  // 确保 sys_protocol wallet 存在
  db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (\'sys_protocol\', 0)').run()
  db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = \'sys_protocol\'').run(amount)
  db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(amount, amount, userId)
  db.prepare(`INSERT INTO platform_reward_log (id, user_id, amount, source, ref) VALUES (?,?,?,?,?)`)
    .run(generateId('prl'), userId, amount, source, ref || null)
}

// Wave E-5: PWA Push 订阅
// 注：实际 push 投递需要 web-push 库（npm i web-push）+ VAPID 私钥签名；
// 当前实现只做订阅层 + SW push 事件处理，留待 web-push 接入后即可发送
initPushSubscriptionsSchema(db)

// 2026-05-22 V2：verifier 新任务通知偏好（默认开，可关）
try { db.exec('ALTER TABLE users ADD COLUMN notify_claim_tasks INTEGER DEFAULT 1') } catch {}

// 2026-05-22 B2：隐私购物 — 买家可选匿名收货（用代号 PR-XXXX 替代真实姓名/电话）
// shipping_address 由买家自己输入"中介点"地址（快递柜/自提点），物流送到那里
// 取件时凭 recipient_code 取货 — seller / logistics 不知道买家真实身份
try { db.exec('ALTER TABLE orders ADD COLUMN anonymous_recipient INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN recipient_code TEXT') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_orders_recipient_code ON orders(recipient_code) WHERE recipient_code IS NOT NULL') } catch {}

// 2026-05-22 B5：下单时主动捐赠 — 在订单总额之外加捐赠（落 charity_fund + 订单关联记录）
try { db.exec('ALTER TABLE orders ADD COLUMN donation_amount REAL DEFAULT 0') } catch {}
const DONATION_VALID_PCTS = new Set([0, 0.005, 0.01, 0.02, 0.05])   // 0 / 0.5 / 1 / 2 / 5 %

// 生成代号 — 5 位 [A-HJ-NP-Z2-9]（排除 I/O/0/1 防混淆）
const RECIPIENT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generateRecipientCode(): string {
  const buf = crypto.randomBytes(8)
  let s = ''
  for (let i = 0; i < 5; i++) s += RECIPIENT_CODE_ALPHABET[buf[i] % RECIPIENT_CODE_ALPHABET.length]
  return 'PR-' + s
}

// Wave E-4: 签到 / 每日任务
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_checkins (
    user_id      TEXT NOT NULL,
    checkin_date TEXT NOT NULL,     -- YYYY-MM-DD
    reward       REAL DEFAULT 0,
    streak       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, checkin_date)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_checkin_user ON daily_checkins(user_id, checkin_date DESC)') } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS task_completions (
    user_id      TEXT NOT NULL,
    task_key     TEXT NOT NULL,     -- 'first_order' | 'five_orders' | 'first_rating' | 'follow_three' | 'first_review_received'
    completed_at TEXT DEFAULT (datetime('now')),
    claimed_at   TEXT,              -- null = 未领奖
    reward       REAL DEFAULT 0,
    PRIMARY KEY (user_id, task_key)
  )
`)

// Wave E-1: 卖家店铺主页装饰
try { db.exec("ALTER TABLE users ADD COLUMN shop_banner_url TEXT") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN shop_intro TEXT") } catch {}    // 完整店铺介绍（多段）

// ─── 4 层身份模型 ─────────────────────────────────────────
// id (内部 usr_xxx, 永不可改) + permanent_code (6 位 Crockford base32, 永不可改, 对外短码)
// + handle (@username, 可改 7天1次/年3次) + name (昵称, 可重复可改)
// permanent_code / handle + 其唯一索引已上移到 initRegisterListSearchColumns(~line 494,
// 与 MCP runtime schema 同源);此处仅保留 handle 的附属列(不在 register/list/search 路径上)。
try { db.exec("ALTER TABLE users ADD COLUMN handle_last_created_at TEXT") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN handle_change_log TEXT") } catch {}  // JSON: [{at, from}], 保留近 365 天
// P15 雷达扫描：粗粒度地理位置（0.1° ≈ 11km × 11km，QVOD 风格匿名聚合）
try { db.exec("ALTER TABLE users ADD COLUMN geo_lat REAL") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN geo_lng REAL") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN geo_updated_at TEXT") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_geo ON users(geo_lat, geo_lng)") } catch {}

// Commission source_type（#7 笔记/分享区分）— 区分 commission 来自哪种 channel
// 'note'    — 笔记带来的成交（attribution 来自 type=note 的 shareable）
// 'link'    — 普通链接/native_text shareable 带来的
// 'sponsor' — 没有 attribution，回退到 sponsor 链/孤儿（默认）
try { db.exec("ALTER TABLE commission_records ADD COLUMN source_type TEXT DEFAULT 'sponsor'") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_comm_src_type ON commission_records(beneficiary_id, source_type, created_at)") } catch {}

// [DEPRECATED 2026-05] P-DynL1 动态关系重组已废弃 — 改用 product_share_attribution（per-product）
// 表 + 字段保留仅为历史数据兼容；不再有任何读写。新订单 L1/L2/L3 走商品分享链反推。
// 历史 commission_records.source = 'dynamic' 数据保留，新数据全部 'static'
try { db.exec("ALTER TABLE commission_records ADD COLUMN source TEXT DEFAULT 'static'") } catch {}

// ─── 提现地址白名单 (24h 冷却) + 大额邮件确认 ──────────────────
// 防偷手机/泄露 key 后攻击者直接提现到自己地址：
//   ① 必须先把地址加白名单
//   ② 白名单地址 24h 冷却期后才生效
//   ③ 单笔 > 100 WAZ 还要邮件二次确认
db.exec(`
  CREATE TABLE IF NOT EXISTS withdrawal_whitelist (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    address       TEXT NOT NULL,
    label         TEXT,
    added_at      TEXT DEFAULT (datetime('now')),
    activates_at  TEXT NOT NULL,
    revoked_at    TEXT,
    UNIQUE (user_id, address)
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wl_user ON withdrawal_whitelist(user_id, revoked_at)") } catch {}
// (withdrawal_requests status_detail / email_confirmed_at migrations moved to where the table is created — see ~L3782)
// Wave G-1: 链上签名证明地址归属 → 免 24h 冷却
try { db.exec("ALTER TABLE withdrawal_whitelist ADD COLUMN signature_verified_at TEXT") } catch {}
try { db.exec("ALTER TABLE withdrawal_whitelist ADD COLUMN chain_id INTEGER") } catch {}
// P0-1 migration: 一次性 lowercase 所有地址（idempotent，已是小写不会变）
try {
  // 先查可能冲突的对（同 user 同 lower 但不同 case）
  const conflicts = db.prepare(`
    SELECT user_id, lower(address) as la, COUNT(*) as cnt FROM withdrawal_whitelist
    GROUP BY user_id, lower(address) HAVING cnt > 1
  `).all() as Array<{ user_id: string; la: string; cnt: number }>
  if (conflicts.length > 0) {
    console.warn(`[wl-migration] ${conflicts.length} duplicate (user_id, lower(addr)) pairs — keeping earliest, revoking rest`)
    for (const c of conflicts) {
      // 保留 added_at 最早的，其余 revoke
      const rows = db.prepare(`SELECT id, added_at FROM withdrawal_whitelist WHERE user_id = ? AND lower(address) = ? ORDER BY added_at ASC`).all(c.user_id, c.la) as Array<{ id: string; added_at: string }>
      for (let i = 1; i < rows.length; i++) {
        db.prepare(`UPDATE withdrawal_whitelist SET revoked_at = datetime('now') WHERE id = ?`).run(rows[i].id)
      }
    }
  }
  db.prepare(`UPDATE withdrawal_whitelist SET address = lower(address) WHERE address != lower(address)`).run()
} catch (e) { console.error('[wl-migration]', (e as Error).message) }

// 大额提现阈值（WAZ）— 超过此值需邮件确认
const LARGE_WITHDRAW_THRESHOLD = 100

// ─── 活跃会话 (user_sessions) — 多设备审计 + 远程登出 ─────────────
// 用途：防 api_key 泄露后无法吊销的根本问题。每个 api_key 关联一个 session 行；
// 用户可在 "活跃会话" 页查看 IP/UA/最后活跃，单点吊销或一键全登出。
// "一键全登出" = rotate users.api_key（所有旧 key 即刻 401，新 key 在 session 表里）。
initUserSessionsSchema(db)

// A4 智能下单：用户默认地址（搜索时自动过滤不可达商品 + 下单时预填）
try { db.exec("ALTER TABLE users ADD COLUMN default_address_text TEXT") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN default_address_region TEXT") } catch {}
// P-Polish 2：结构化地址（JSON 存储）— line1/line2/country/state/city/recipient/phone1/phone2/postal
try { db.exec("ALTER TABLE users ADD COLUMN default_address_json TEXT") } catch {}

// A2 黑名单（精准匹配护栏）：买家可拉黑卖家，搜索时自动过滤
initUserBlocklistSchema(db)

// P-Distrib β：分布式内容层（外链 shareables + P2P 原生 manifests + pin 经济）
// shareables = 外链分享（YouTube/TikTok/小红书 等外部内容）— 仅索引 URL，零内容存储
db.exec(`
  CREATE TABLE IF NOT EXISTS shareables (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL,
    type                TEXT NOT NULL,
    external_url        TEXT,
    external_platform   TEXT,
    external_video_id   TEXT,
    thumbnail_url       TEXT,
    title               TEXT,
    description         TEXT,
    native_text         TEXT,
    related_product_id  TEXT,
    related_anchor      TEXT,
    click_count         INTEGER DEFAULT 0,
    status              TEXT DEFAULT 'active',
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_owner ON shareables(owner_id, status)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_product ON shareables(related_product_id, status)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_anchor ON shareables(related_anchor, status)") } catch {}
// 2026-05-22: 复合索引 — GET /api/shares/dashboard bought_products 5 子查询性能优化
// note_count / first_note_id 用：owner_id + related_order_id + type + status
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_owner_order_type ON shareables(owner_id, related_order_id, type, status)") } catch {}
// product_share_count 用：owner_id + related_product_id + status（避免回表）
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_owner_product ON shareables(owner_id, related_product_id, status)") } catch {}
// owner_code: 创建时的 permanent_code 快照（owner 改 handle 不影响溯源 + 链接更短）
try { db.exec("ALTER TABLE shareables ADD COLUMN owner_code TEXT") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_owner_code ON shareables(owner_code) WHERE owner_code IS NOT NULL") } catch {}

// LIKE 系统：他人对 shareable 点赞 → 计入 trending score（用户原话："越多人评价可以排越前面"）
try { db.exec('ALTER TABLE shareables ADD COLUMN like_count INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN total_likes INTEGER DEFAULT 0') } catch {}

// Phase C 笔记系统：shareables 升级支持"笔记"模式（type='note'）
//   photo_hashes      — JSON 数组的 sha256，至少 1 张；blob 由 note-photo-storage 持久化
//   parent_id         — 转发链 (FK 自指 shareables.id；NULL = 原创)
//   related_order_id  — 必须是创建者自己的 completed 订单（buyer-only 门禁的依据）
for (const stmt of [
  'ALTER TABLE shareables ADD COLUMN photo_hashes TEXT',          // JSON ["sha256_a","sha256_b"]
  'ALTER TABLE shareables ADD COLUMN parent_id TEXT',
  'ALTER TABLE shareables ADD COLUMN related_order_id TEXT',
]) { try { db.exec(stmt) } catch { /* 已存在 */ } }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_parent ON shareables(parent_id) WHERE parent_id IS NOT NULL") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_share_order ON shareables(related_order_id) WHERE related_order_id IS NOT NULL") } catch {}

// 笔记图片 hash 索引 / Wave A 购物表（心愿单 · 商品Q&A · 优惠券）→ server-schema.ts
// 纯幂等建表/建索引 DDL，原位调用保持 boot 顺序不变
initNotePhotoIndexSchema(db)
initUserWishlistSchema(db)
initProductQaSchema(db)
initCouponsSchema(db)
// Orders 表加 coupon 字段（记录使用了哪张券、折扣多少）
for (const stmt of [
  'ALTER TABLE orders ADD COLUMN coupon_id TEXT',
  'ALTER TABLE orders ADD COLUMN coupon_discount REAL DEFAULT 0',
]) { try { db.exec(stmt) } catch {} }

// Wave A-4 公告+阅读 / Wave B-2 预售waitlist / Wave D-4 限时促销 → server-schema.ts
// 纯幂等建表/建索引 DDL，原位调用保持 boot 顺序不变
initAnnouncementsSchema(db)
initProductWaitlistSchema(db)
initFlashSalesSchema(db)

// 公共助手：拿商品（含 variant 选项）当前生效的 flash sale
// #1013 Phase 23: 已迁出到 routes/flash-sales.ts，本地 wrapper 让 orders 流程签名不变
const getActiveFlashSale = (productId: string, variantId?: string | null) =>
  getActiveFlashSaleRaw(db, productId, variantId)

// 2026-05-24 #978: 测评免单 (Trial Review Refund)
// 卖家发新品时可开启「测评免单」计划：买家以原价正常下单，发笔记达 reach 阈值后系统自动退款
// reach_score = views * 0.1 + shares * 1 + conversions * 10
// 测评免单计划 + 认领 → server-schema.ts；claims 的 snap/audit ALTER 刻意留原位（紧跟下方）
initProductTrialCampaignsSchema(db)
initProductTrialClaimsSchema(db)
// 审计 P0-1：claim 时快照 campaign 配置，cron 评估按快照而非当前活动（防卖家中途上调阈值白嫖）
for (const col of [
  'ALTER TABLE product_trial_claims ADD COLUMN snap_reach_threshold INTEGER',
  'ALTER TABLE product_trial_claims ADD COLUMN snap_min_chars INTEGER',
  'ALTER TABLE product_trial_claims ADD COLUMN snap_min_days_live INTEGER',
  // 审计 P1：申请时记录买家 IP/UA hash，cron / audit 可回溯做账号关联检测
  'ALTER TABLE product_trial_claims ADD COLUMN buyer_ip_hash TEXT',
  'ALTER TABLE product_trial_claims ADD COLUMN buyer_ua_hash TEXT',
  // 审计标记：account_link_flag / sybil 怀疑
  'ALTER TABLE product_trial_claims ADD COLUMN audit_flags TEXT',
]) { try { db.exec(col) } catch { /* 已存在 */ } }

// 邮箱订阅独立表（GDPR-ready）→ server-schema.ts；后续 ALTER 列扩展刻意留原位（紧跟下方）
initEmailSubscriptionsSchema(db)
// 2026-05-26: 用户期望身份 + 备注（welcome 表单丰富化）
try { db.exec("ALTER TABLE email_subscriptions ADD COLUMN role_preference TEXT") } catch {}
try { db.exec("ALTER TABLE email_subscriptions ADD COLUMN note             TEXT") } catch {}
// 2026-05-29: 申请处理状态（admin 跟进漏斗）— pending/contacted/invited/done
try { db.exec("ALTER TABLE email_subscriptions ADD COLUMN handle_status TEXT DEFAULT 'pending'") } catch {}
try { db.exec("ALTER TABLE email_subscriptions ADD COLUMN handled_at    TEXT") } catch {}
try { db.exec("ALTER TABLE email_subscriptions ADD COLUMN handled_by    TEXT") } catch {}

// 首屏「我有建议」公开收集 / #959 拍卖「⏰ 提醒我」 → server-schema.ts
// 纯幂等建表/建索引 DDL，原位调用保持 boot 顺序不变（email_subscriptions 仍留原位）
initPublicIdeasSchema(db)
initAuctionRemindersSchema(db)

// Wave D-3: 用户反馈 / 客服工单（buyer-to-platform，独立于 disputes）→ server-schema.ts
// 后续 ALTER 列扩展刻意留原位（紧跟下方）
initFeedbackTicketsSchema(db)
// G-4: AI 建议回复
try { db.exec('ALTER TABLE feedback_tickets ADD COLUMN ai_suggested_reply TEXT') } catch {}
try { db.exec('ALTER TABLE feedback_tickets ADD COLUMN ai_generated_at TEXT') } catch {}
try { db.exec('ALTER TABLE feedback_tickets ADD COLUMN user_seen_reply_at TEXT') } catch {}
// W7: admin 上次读取时间（用于 admin 端未读计数）
try { db.exec('ALTER TABLE feedback_tickets ADD COLUMN admin_seen_at TEXT') } catch {}

// W7 客服 ticket-thread — 多轮消息（user ↔ admin）→ server-schema.ts
// 后续 ALTER 列扩展刻意留原位（紧跟下方）
initFeedbackMessagesSchema(db)
// 跨窗反诈一致性：所有 thread 消息表加 flagged + flag_reasons
try { db.exec('ALTER TABLE feedback_messages ADD COLUMN flagged INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE feedback_messages ADD COLUMN flag_reasons TEXT') } catch {}

// ─── 公开仲裁判例 (P1) ─────────────────────────────────────
// 公开判例（裁决后脱敏版本，disputes 是当事人/仲裁员私域）→ server-schema.ts
initDisputeCasesSchema(db)

// 公开判例评论 → server-schema.ts；anonymous ALTER + idx_dcom_case 刻意留原位
initDisputeCommentsSchema(db)
try { db.exec('ALTER TABLE dispute_comments ADD COLUMN anonymous INTEGER DEFAULT 0') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_dcom_case ON dispute_comments(case_id, created_at DESC)') } catch {}

// W5 仲裁公开评论楼中楼 — 单层子回复 → server-schema.ts；后续 ALTER 刻意留原位
initDisputeCommentRepliesSchema(db)
// 跨窗反诈一致性
try { db.exec('ALTER TABLE dispute_comment_replies ADD COLUMN flagged INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE dispute_comment_replies ADD COLUMN flag_reasons TEXT') } catch {}
// dispute_comments 已有 flagged，但缺 flag_reasons
try { db.exec('ALTER TABLE dispute_comments ADD COLUMN flag_reasons TEXT') } catch {}

// W6 笔记评论 — 原生 parent_id 楼中楼（仅 1 层）→ server-schema.ts；flag_reasons ALTER 刻意留原位
initShareableCommentsSchema(db)
try { db.exec('ALTER TABLE shareable_comments ADD COLUMN flag_reasons TEXT') } catch {}

// 公开判例公平性投票 → server-schema.ts；idx_feedback_open 刻意留原位（非本表索引，不相邻）
initDisputeFairnessVotesSchema(db)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_open ON feedback_tickets(status, created_at DESC) WHERE status IN (\'open\', \'in_progress\')') } catch {}

// Wave C-3: 买家评价 / 评分 → server-schema.ts；后续结构化维度 ALTER + 跨表 orders 索引刻意留原位
initOrderRatingsSchema(db)
// P2 hot-path：覆盖 sales_count 子查询（COUNT WHERE product_id=? AND status=completed）—— orders 表索引，留原位
try { db.exec('CREATE INDEX IF NOT EXISTS idx_orders_product_status ON orders(product_id, status)') } catch {}

// L2-5 评价系统升级 — 结构化维度 + 双盲 + 反向评价
try { db.exec('ALTER TABLE order_ratings ADD COLUMN dim_quality INTEGER') } catch {}
try { db.exec('ALTER TABLE order_ratings ADD COLUMN dim_speed INTEGER') } catch {}
try { db.exec('ALTER TABLE order_ratings ADD COLUMN dim_service INTEGER') } catch {}
try { db.exec('ALTER TABLE order_ratings ADD COLUMN hidden_until TEXT') } catch {}
// W3 评价两回合：买家在 seller reply 后可追问一次（限 200 字），追完锁
try { db.exec('ALTER TABLE order_ratings ADD COLUMN buyer_followup TEXT') } catch {}
try { db.exec('ALTER TABLE order_ratings ADD COLUMN buyer_followup_at TEXT') } catch {}

// 反向评价：卖家给买家评分（双盲）→ server-schema.ts
initBuyerRatingsSchema(db)

// Wave C-2: 多收货地址簿 → server-schema.ts
initUserAddressesSchema(db)

// Wave B-3: 退货请求 → server-schema.ts；pickup ALTER 刻意留原位（紧跟下方）
initReturnRequestsSchema(db)

// 2026-05-22 L3+B3：退货上门取件（MVP — 仅声明阶段）
// 完整状态机（accepted_pickup_pending → picked_up → refunded）留 Phase 2
try { db.exec('ALTER TABLE return_requests ADD COLUMN pickup_requested INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE return_requests ADD COLUMN pickup_address TEXT') } catch {}

// W2 售后协商时间线 — 多轮消息（buyer ↔ seller）→ server-schema.ts；flagged/flag_reasons ALTER 刻意留原位（紧跟下方）
initReturnMessagesSchema(db)
// 跨窗反诈一致性
try { db.exec('ALTER TABLE return_messages ADD COLUMN flagged INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE return_messages ADD COLUMN flag_reasons TEXT') } catch {}

// Wave B-1 Phase 1: 商品 variants（同款多 SKU — 颜色/尺寸/规格组合）
// schema + CRUD 端点；Phase 2 再集成订单/购物车
// Wave B-1: 商品 variants → server-schema.ts；has_variants/options_key ALTER + 回填 + uniq 索引刻意留原位（紧跟下方）
initProductVariantsSchema(db)
// 给 products 加 has_variants 标记（避免每次查 join 检查）
try { db.exec('ALTER TABLE products ADD COLUMN has_variants INTEGER DEFAULT 0') } catch {}
// P2-1: variants 唯一性 — options 的 canonical key (sorted keys) 用于防止同 product 内重复 SKU
try { db.exec('ALTER TABLE product_variants ADD COLUMN options_key TEXT') } catch {}
// 回填历史行的 options_key（一次性，新行在 POST/PATCH 时写入）
try {
  const rows = db.prepare('SELECT id, options_json FROM product_variants WHERE options_key IS NULL').all() as Array<{ id: string; options_json: string }>
  const upd = db.prepare('UPDATE product_variants SET options_key = ? WHERE id = ?')
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.options_json || '{}') as Record<string, unknown>
      const key = Object.keys(obj).sort().map(k => `${k}=${String(obj[k])}`).join('|')
      upd.run(key, r.id)
    } catch {}
  }
} catch {}
// 唯一性索引（同 product + 同 options 组合不可有两条 active 行）
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_pv_product_options ON product_variants(product_id, options_key) WHERE is_active = 1') } catch {}

// Sprint 4 — claim_loss_count (历史被验证不实次数 — 用于搜索降权 + 公开 badge)
for (const stmt of [
  'ALTER TABLE products ADD COLUMN claim_loss_count INTEGER DEFAULT 0',
  'ALTER TABLE secondhand_items ADD COLUMN claim_loss_count INTEGER DEFAULT 0',
  'ALTER TABLE auctions ADD COLUMN claim_loss_count INTEGER DEFAULT 0',
]) { try { db.exec(stmt) } catch {} }

// P2P 原生商店 — 卖家本地节点存详情，WebAZ 只锚定 hash + 关键字段
for (const stmt of [
  'ALTER TABLE products ADD COLUMN p2p_mode INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN content_hash TEXT',                  // sha256 of canonical detail JSON
  'ALTER TABLE products ADD COLUMN peer_endpoint TEXT',                 // WS/HTTPS 拉取点
  'ALTER TABLE products ADD COLUMN content_signature TEXT',             // HMAC(api_key, hash + signed_at)
  'ALTER TABLE products ADD COLUMN content_signed_at TEXT',
  'ALTER TABLE orders   ADD COLUMN content_hash_at_order TEXT',         // 下单时锚定的 hash 版本（争议证据）
]) { try { db.exec(stmt) } catch {} }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_p2p ON products(p2p_mode, status)') } catch {}

// P2P 店铺 / 笔记点赞·收藏·标签 / manifest·peer·signaling（原生 P2P 内容层）→ server-schema.ts
// 纯幂等建表/建索引 DDL，原位调用保持 boot 顺序不变
initP2pShopsSchema(db)
initShareableLikesSchema(db)
initShareableBookmarksSchema(db)
initShareableTagsSchema(db)
initManifestRegistrySchema(db)
initPeerDirectorySchema(db)
initSignalingQueueSchema(db)

// pin_receipts = 服务证明（pinner 给 recipient 传输 N bytes 时双签的回执）
// recipient 之后下单同商品 → settlePinRewards 从 basin 拨 0.5% 订单额分给最近 5 个 pinners
db.exec(`
  CREATE TABLE IF NOT EXISTS pin_receipts (
    id                TEXT PRIMARY KEY,
    manifest_hash     TEXT NOT NULL,
    pinner_id         TEXT NOT NULL,
    recipient_id      TEXT NOT NULL,
    bytes_served      INTEGER NOT NULL,
    served_at         TEXT NOT NULL,
    pinner_sig        TEXT NOT NULL,
    recipient_sig     TEXT NOT NULL,
    related_order_id  TEXT,
    rewarded_waz      REAL DEFAULT 0,
    rewarded_at       TEXT,
    created_at        TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_pin_recipient ON pin_receipts(recipient_id, rewarded_at)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_pin_manifest ON pin_receipts(manifest_hash, rewarded_at)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_pin_order ON pin_receipts(related_order_id)") } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN settled_pin_at TEXT") } catch {}

// ============================================================
// 慈善许愿池 (CHARITY) — 双匿名 + 双签锚定 + 隔离的 prestige 体系
// ============================================================
// 角色词典（统一术语，2026-05-21）：
//   许愿人 (wisher)        — 发起 wish 的人；DB: wishes.user_id / wisher_handle
//   施善人 (benefactor)    — 实现他人愿望的人；DB 字段叫 fulfiller_user_id（历史遗留）
//                           UI / 通知 / 文档 一律用"施善人"，不再用"圆梦人"
//   还愿人 (repayer)       — 愿望成真后回馈系统/原施善人；
//                           DB: wish_repayments.wisher_user_id（同一人之前是许愿人）
//   被还愿人 (repay_target) — 接受还愿的原施善人；
//                           DB: wish_repayments.fulfiller_user_id（同一人之前是施善人）
//   捐款人 (donor)         — 直接向基金池捐款，不关联具体愿望
//
// 注：DB 字段名 fulfiller_user_id 是早期英文直译"完成者"，语义偏弱。
//     重命名风险大（涉及所有 query），保留字段名 + 用注释 + UI 文案统一。
db.exec(`
  CREATE TABLE IF NOT EXISTS wishes (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,                -- 服务端持有；前端永不返回
    wisher_handle      TEXT NOT NULL,                -- 仅许愿方 anon 显示串
    category           TEXT NOT NULL,
    title              TEXT NOT NULL,
    content            TEXT NOT NULL,
    target_kind        TEXT NOT NULL CHECK (target_kind IN ('item','service','cash')),
    target_waz         REAL,                         -- cash 模式必填
    escrow_locked      REAL DEFAULT 0,               -- cash 模式锁仓金额
    commit_hash        TEXT NOT NULL,                -- sha256(user_id||secret||created_at)
    allow_public       INTEGER DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'open', -- open / claimed / completed / expired / cancelled / disputed
    fulfiller_user_id  TEXT,
    claimed_at         TEXT,
    completed_at       TEXT,
    expires_at         TEXT NOT NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wishes_status ON wishes(status, created_at DESC)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wishes_user ON wishes(user_id)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wishes_fulfiller ON wishes(fulfiller_user_id, status)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wishes_expires ON wishes(expires_at) WHERE status IN ('open','claimed')") } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS wish_fulfillments (
    id                  TEXT PRIMARY KEY,
    wish_id             TEXT NOT NULL,
    fulfiller_user_id   TEXT NOT NULL,
    fulfiller_handle    TEXT NOT NULL,
    proof_hash          TEXT NOT NULL,
    proof_note          TEXT,
    fulfiller_sig       TEXT NOT NULL,               -- HMAC(api_key, wish_id||proof_hash)
    wisher_sig          TEXT,                         -- 确认签名
    status              TEXT NOT NULL DEFAULT 'proof_pending',  -- proof_pending / confirmed / disputed
    confirmed_at        TEXT,
    disclose_wisher     INTEGER DEFAULT 0,
    disclose_fulfiller  INTEGER DEFAULT 0,
    disclosed_at        TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wf_wish ON wish_fulfillments(wish_id)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wf_fulfiller ON wish_fulfillments(fulfiller_user_id, status)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wf_disclosed ON wish_fulfillments(disclosed_at) WHERE disclosed_at IS NOT NULL") } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS charity_reputation (
    user_id            TEXT PRIMARY KEY,
    prestige_score     REAL DEFAULT 0,
    wishes_made        INTEGER DEFAULT 0,
    wishes_fulfilled   INTEGER DEFAULT 0,
    badge_tier         TEXT DEFAULT 'none',          -- none/bronze/silver/gold/diamond
    last_active        TEXT,
    last_decay_at      TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS charity_blocklist (
    user_id     TEXT PRIMARY KEY,
    reason      TEXT,
    until       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// 慈善基金（单例 id='main'）
// 2026-06-04 起【纯净】：仅服务慈善许愿板块（捐款/还愿/拨款），不再承接任何佣金兜底。
//   total_donated         — 用户主动捐款
//   total_redirected      — 还愿转入（原义保留）
//   total_disbursed       — 累计已 disburse（出金）
//   total_chain_gap / total_orphan_sponsor / total_region_cap 三列为历史遗留（解耦前佣金兜底曾入此），
//   现已停写、仅作历史审计；新佣金兜底全部入 commission_reserve（三级公池，见下）。
db.exec(`
  CREATE TABLE IF NOT EXISTS charity_fund (
    id              TEXT PRIMARY KEY,
    balance         REAL DEFAULT 0,
    total_donated   REAL DEFAULT 0,
    total_disbursed REAL DEFAULT 0,
    total_redirected REAL DEFAULT 0,    -- 由还愿转入的累计
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.prepare("INSERT OR IGNORE INTO charity_fund (id) VALUES ('main')").run()
// 后置 ALTER 加科目列（已有库无痛升级）
for (const stmt of [
  'ALTER TABLE charity_fund ADD COLUMN total_chain_gap REAL DEFAULT 0',
  'ALTER TABLE charity_fund ADD COLUMN total_orphan_sponsor REAL DEFAULT 0',
  'ALTER TABLE charity_fund ADD COLUMN total_region_cap REAL DEFAULT 0',  // Phase B: max_levels=0 整池
]) { try { db.exec(stmt) } catch { /* 已存在 */ } }

// 资金流水（2026-06-04 起 charity 纯净，仅以下 3 类；redirect_* 历史 kind 不再新写）：
//   donation              — 用户主动捐款
//   repay_redirect        — 还愿转入（不可达原施善人或主动选 fund）
//   disburse              — 出金（拨付/还愿 grant 等）
db.exec(`
  CREATE TABLE IF NOT EXISTS charity_fund_txns (
    id                   TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL,
    from_user_id         TEXT,
    to_user_id           TEXT,
    amount               REAL NOT NULL,
    related_wish_id      TEXT,
    related_repay_id     TEXT,
    related_order_id     TEXT,
    note                 TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_cft_kind ON charity_fund_txns(kind, created_at DESC)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_cft_from ON charity_fund_txns(from_user_id)") } catch {}
try { db.exec('ALTER TABLE charity_fund_txns ADD COLUMN related_order_id TEXT') } catch { /* 已存在 */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_cft_order ON charity_fund_txns(related_order_id)") } catch {}

// ─── 三级公池 / 佣金储备（commission_reserve，单例 id='main'）─────────────
// 2026-06-04：佣金兜底科目从 charity_fund 拆出，慈善科目自此【纯净】只服务慈善许愿板块。
// 三级佣金中【无资格人 / 无资格 / 区域档位截断 / max=0 整池 / opt-out 放弃 / escrow 到期】
// 的部分，统一入此【独立科目】。定位 = 协议储备，**只进不出**，用途由治理(DAO/创始人)决定。
// 与 global_fund(由 1% base 注资的预留池;匹配奖励引擎已切除,当前无消费方) 互不流通 —— 三套科目彻底独立。
// 命名注意：本表是【持久储备科目】，区别于每单的 commission_pool/commissionPool（= total×rate 预算变量）。
//   total_chain_gap        — L2/L3 空缺（自发现/上家断链）
//   total_orphan_sponsor   — sponsor 被封/无资格 + opt-out 主动放弃 + escrow 到期（无合格受益人桶）
//   total_region_cap       — level>maxLevels 区域档位截断 + max_levels=0 整池
db.exec(`
  CREATE TABLE IF NOT EXISTS commission_reserve (
    id                   TEXT PRIMARY KEY,
    balance              REAL DEFAULT 0,
    total_chain_gap      REAL DEFAULT 0,
    total_orphan_sponsor REAL DEFAULT 0,
    total_region_cap     REAL DEFAULT 0,
    total_disbursed      REAL DEFAULT 0,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.prepare("INSERT OR IGNORE INTO commission_reserve (id) VALUES ('main')").run()
db.exec(`
  CREATE TABLE IF NOT EXISTS commission_reserve_txns (
    id                   TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL,
    from_user_id         TEXT,
    amount               REAL NOT NULL,
    related_order_id     TEXT,
    note                 TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_crt_kind ON commission_reserve_txns(kind, created_at DESC)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_crt_order ON commission_reserve_txns(related_order_id)") } catch {}

// 还愿记录
db.exec(`
  CREATE TABLE IF NOT EXISTS wish_repayments (
    id                  TEXT PRIMARY KEY,
    wish_id             TEXT NOT NULL,
    fulfillment_id      TEXT NOT NULL,
    wisher_user_id      TEXT NOT NULL,
    fulfiller_user_id   TEXT NOT NULL,
    amount              REAL NOT NULL,
    note                TEXT,
    status              TEXT NOT NULL DEFAULT 'offered',  -- offered / accepted / declined_to_fund / expired_auto_accept
    responded_at        TEXT,
    auto_expire_at      TEXT NOT NULL,                     -- 7 天未响应 → 自动 accept
    locked              REAL NOT NULL DEFAULT 0,           -- 锁仓金额
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_repay_wish ON wish_repayments(wish_id)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_repay_fulfiller ON wish_repayments(fulfiller_user_id, status)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_repay_auto ON wish_repayments(auto_expire_at) WHERE status='offered'") } catch {}

// charity_reputation 扩展荣誉细分
for (const stmt of [
  'ALTER TABLE charity_reputation ADD COLUMN repay_honor      REAL DEFAULT 0',
  'ALTER TABLE charity_reputation ADD COLUMN redirect_honor   REAL DEFAULT 0',
  'ALTER TABLE charity_reputation ADD COLUMN grace_honor      REAL DEFAULT 0',
  'ALTER TABLE charity_reputation ADD COLUMN donation_total   REAL DEFAULT 0',
  'ALTER TABLE charity_reputation ADD COLUMN donation_honor   REAL DEFAULT 0',
]) { try { db.exec(stmt) } catch {} }

// 通知表加 wish_id 让前端能跳转到 #wish/:id
try { db.exec('ALTER TABLE notifications ADD COLUMN wish_id TEXT') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_notif_wish ON notifications(wish_id) WHERE wish_id IS NOT NULL') } catch {}
// W9 通知行动按钮：actions = JSON 数组 [{ kind: 'navigate'|'api_post', label, href?, url?, body?, style? }]
try { db.exec('ALTER TABLE notifications ADD COLUMN actions TEXT') } catch {}

// 2026-05-24 关键 bug 修：notifications.type NOT NULL 但 16+ 历史 INSERT 缺该列
// → 全部静默失败（被 try/catch 吞）。补救：重建表给 type 加 DEFAULT 'system'
// 仅在 type 列 NOT NULL 且无默认时执行（一次性 migration）
try {
  const hasDefault = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'`).get() as { sql: string } | undefined
  if (hasDefault && hasDefault.sql.includes('type       TEXT NOT NULL') && !hasDefault.sql.includes("type       TEXT NOT NULL DEFAULT")) {
    console.log('[notif-schema] 修 type 列：加 DEFAULT \'system\' 让 16+ 历史静默失败的 INSERT 重新生效')
    // 关掉 FK 检查再 migrate（迁移期间 user_id REFERENCES 会触发 FK 错误）
    db.exec(`PRAGMA foreign_keys = OFF`)
    try {
      db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE notifications_new (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id),
          order_id   TEXT REFERENCES orders(id),
          type       TEXT NOT NULL DEFAULT 'system',
          title      TEXT NOT NULL,
          body       TEXT NOT NULL,
          read       INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          wish_id    TEXT,
          actions    TEXT
        );
        INSERT INTO notifications_new (id, user_id, order_id, type, title, body, read, created_at, wish_id, actions)
          SELECT id, user_id, order_id, type, title, body, read, created_at, wish_id, actions FROM notifications;
        DROP TABLE notifications;
        ALTER TABLE notifications_new RENAME TO notifications;
        CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notif_wish ON notifications(wish_id) WHERE wish_id IS NOT NULL;
        COMMIT;
      `)
    } finally {
      db.exec(`PRAGMA foreign_keys = ON`)
    }
  }
} catch (e) { console.error('[notif-schema migration]', e) }

// 📡 Webhook 订阅（D2 批） — Agent-native 事件订阅
db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    event_type    TEXT NOT NULL,  -- order.* / wish.* / repay.* / rfq.* / bid.*
    target_url    TEXT NOT NULL,  -- HTTPS endpoint
    secret        TEXT,           -- HMAC 共享密钥（用户提供，可空）
    active        INTEGER DEFAULT 1,
    last_fired_at TEXT,
    fire_count    INTEGER DEFAULT 0,
    fail_count    INTEGER DEFAULT 0,
    last_error    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wh_user ON webhook_subscriptions(user_id, active)") } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wh_event ON webhook_subscriptions(event_type, active)") } catch {}

// P2.3 — 不当愿望举报表
db.exec(`
  CREATE TABLE IF NOT EXISTS wish_reports (
    id              TEXT PRIMARY KEY,
    wish_id         TEXT NOT NULL,
    reporter_id     TEXT NOT NULL,
    reason          TEXT NOT NULL,            -- spam / fraud / inappropriate / other
    note            TEXT,
    status          TEXT DEFAULT 'pending',   -- pending / dismissed / actioned
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wish_id, reporter_id)
  )
`)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_wreport_wish ON wish_reports(wish_id, status)") } catch {}

// P2.5 — 复合索引：donation 日榆量查询用
try { db.exec("CREATE INDEX IF NOT EXISTS idx_cft_from_kind_time ON charity_fund_txns(from_user_id, kind, created_at DESC)") } catch {}

// 放置树 / PV 参与记录数据层(中性参与记录;匹配奖励引擎已切除)
for (const stmt of [
  'ALTER TABLE users ADD COLUMN placement_id    TEXT',
  "ALTER TABLE users ADD COLUMN placement_side  TEXT",
  'ALTER TABLE users ADD COLUMN placement_path  TEXT',
  'ALTER TABLE users ADD COLUMN placement_depth INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN left_child_id   TEXT',
  'ALTER TABLE users ADD COLUMN right_child_id  TEXT',
  'ALTER TABLE users ADD COLUMN total_left_pv   REAL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN total_right_pv  REAL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN pv_dirty_at     TEXT',
  // 二叉树左右【整棵子树】人数 — 增量维护(joinPowerLeg 上溯 +1), pickPreferredSide team_count O(1) 读
  'ALTER TABLE users ADD COLUMN left_count      INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN right_count     INTEGER DEFAULT 0',
  // V3 用户成长等级（基于历史累积 score = 历史累积 WAZ 收益）
  'ALTER TABLE users ADD COLUMN lifetime_score  REAL DEFAULT 0',
]) { try { db.exec(stmt) } catch {} }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_placement ON users(placement_id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_pv_dirty ON users(pv_dirty_at)') } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS pv_ledger (
    id          TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL,
    buyer_id    TEXT NOT NULL,
    pv          REAL NOT NULL,
    processed   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_pv_ledger_processed ON pv_ledger(processed, created_at)') } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS binary_score_records (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    tier            INTEGER NOT NULL,
    score           REAL NOT NULL,
    consumed_left_pv  REAL NOT NULL,
    consumed_right_pv REAL NOT NULL,
    period_start    TEXT NOT NULL,
    period_end      TEXT NOT NULL,
    settled_at      TEXT,
    waz_amount      REAL,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_score_user_pending ON binary_score_records(user_id, settled_at)') } catch {}

// 成长任务日志（领取/跳过/完成状态）— 任务目录在代码层维护，本表只记录用户互动
db.exec(`
  CREATE TABLE IF NOT EXISTS growth_task_log (
    user_id      TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    status       TEXT NOT NULL,
    claimed_at   TEXT,
    completed_at TEXT,
    PRIMARY KEY (user_id, task_id)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_growth_task_user ON growth_task_log(user_id)') } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS global_fund (
    id INTEGER PRIMARY KEY CHECK(id=1),
    pool_balance       REAL DEFAULT 0,
    total_scores_pending REAL DEFAULT 0,
    current_n          REAL DEFAULT 0,
    last_settled_at    TEXT,
    daily_threshold_multiplier REAL DEFAULT 1.0
  )
`)
try { db.prepare('INSERT OR IGNORE INTO global_fund (id) VALUES (1)').run() } catch {}
// 2026-06-04 (#1106)：PV escrow 隔离负债账。结算时给"已承诺但 opt-out 待激活"的 PV 奖励
// 从 pool_balance 移入此列（不再留在可分配池中被后续周期发给别人）；
// 兑付(opt-in)从此列出，到期退回 pool_balance。守恒：pool + pv_escrow_reserve + wallets = 常量。
try { db.exec('ALTER TABLE global_fund ADD COLUMN pv_escrow_reserve REAL DEFAULT 0') } catch { /* 已存在 */ }

// 迁移:management_bonus_pool → protocol_reserve_pool(中性标识,去 comp-plan;保留既有余额)。
// RENAME 必须在 CREATE IF NOT EXISTS 之前:旧库重命名保余额;新库无旧表→ALTER 抛错被吞,由下方 CREATE 建新表。
try { db.exec('ALTER TABLE management_bonus_pool RENAME TO protocol_reserve_pool') } catch { /* 已迁移 / 全新库 */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS protocol_reserve_pool (
    id INTEGER PRIMARY KEY CHECK(id=1),
    balance REAL DEFAULT 0
  )
`)
try { db.prepare('INSERT OR IGNORE INTO protocol_reserve_pool (id) VALUES (1)').run() } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS binary_tier_config (
    tier            INTEGER PRIMARY KEY,
    pv_threshold    REAL NOT NULL,
    score_per_hit   REAL NOT NULL,
    active          INTEGER DEFAULT 1
  )
`)
// binary_tier_config 保留为【预留空表 / dormant structure】—— 不 seed 任何档位 / 阈值 / 分数参数。
// 匹配奖励引擎已切除(#401);若未来经法律 / 治理放行重启奖励功能,再按届时合规设计填充。
// (base_score / discount_coef 列仅为历史 schema 兼容保留,不写入)
for (const stmt of [
  'ALTER TABLE binary_tier_config ADD COLUMN base_score REAL',
  'ALTER TABLE binary_tier_config ADD COLUMN discount_coef REAL DEFAULT 1.0',
]) { try { db.exec(stmt) } catch {} }
try { db.exec("CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT)") } catch {}

// 商品类目（PV 乘数 = 资金/PV 解耦核心）
db.exec(`
  CREATE TABLE IF NOT EXISTS product_categories (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    pv_multiplier REAL NOT NULL DEFAULT 1.0,
    note          TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  )
`)
;([
  ['cat_high',    '高毛利（美妆/保健/小众）',     1.0, '1 元 = 1 PV'],
  ['cat_mid',     '中毛利（家居/服饰/数码周边）', 0.5, '1 元 = 0.5 PV'],
  ['cat_low',     '低毛利（粮油/大牌3C/家电）',   0.1, '1 元 = 0.1 PV'],
  ['cat_default', '默认（未分类，按 1.0 兜底）',   1.0, '兼容旧数据'],
] as [string, string, number, string][]).forEach(([id, name, mpv, note]) => {
  try { db.prepare("INSERT OR IGNORE INTO product_categories (id, name, pv_multiplier, note) VALUES (?,?,?,?)").run(id, name, mpv, note) } catch {}
})

try { db.exec("ALTER TABLE products ADD COLUMN category_id TEXT DEFAULT 'cat_default'") } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)') } catch {}

// P1 — 多商家跟卖（listing × product 共享身份）
// 设计：products 是单卖家所有；listings 是多卖家共享的"商品身份"
// 一个 products 行可挂到 listing（成为该 listing 的一个 offer），也可保持独立
// → 所有 product/order 现有逻辑（库存/纠纷/销量/分享归属）原样工作
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id              TEXT PRIMARY KEY,
    external_id     TEXT,
    category        TEXT NOT NULL DEFAULT 'general',
    category_path   TEXT,
    title           TEXT NOT NULL,
    spec            TEXT,
    cover_image     TEXT,
    description     TEXT,
    created_by      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    merged_into     TEXT,
    trust_score     REAL DEFAULT 0,
    total_offers    INTEGER DEFAULT 0,
    total_sales     INTEGER DEFAULT 0,
    dispute_count   INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_external ON listings(external_id) WHERE external_id IS NOT NULL") } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_listings_cat_status ON listings(category, status)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_listings_path ON listings(category_path)') } catch {}

// 把产品挂到 listing：保留 products 原有结构 + 加挂 7 个跟卖元字段
for (const stmt of [
  'ALTER TABLE products ADD COLUMN listing_id TEXT',
  "ALTER TABLE products ADD COLUMN fulfillment_type TEXT DEFAULT 'standard'",  // instant_pickup|same_day|next_day|standard
  'ALTER TABLE products ADD COLUMN eta_hours REAL',
  'ALTER TABLE products ADD COLUMN freshness_ts TEXT',
  'ALTER TABLE products ADD COLUMN is_clearance INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN clearance_until TEXT',
  'ALTER TABLE products ADD COLUMN cold_start_remaining INTEGER DEFAULT 30',
  'ALTER TABLE products ADD COLUMN listing_stake_locked REAL DEFAULT 0',
]) { try { db.exec(stmt) } catch {} }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_listing ON products(listing_id, status, price)') } catch {}

// P3 — RFQ 抢单（买家发需求 + 卖家限时报价）
db.exec(`
  CREATE TABLE IF NOT EXISTS rfqs (
    id                    TEXT PRIMARY KEY,
    buyer_id              TEXT NOT NULL,
    listing_id            TEXT,
    title                 TEXT NOT NULL,
    spec_json             TEXT,
    qty                   INTEGER NOT NULL DEFAULT 1,
    category              TEXT NOT NULL DEFAULT 'general',
    region_required       TEXT,
    urgency               TEXT NOT NULL DEFAULT 'flex',
    max_price             REAL,
    fulfillment_required  TEXT,
    award_mode            TEXT NOT NULL DEFAULT 'time_window',
    award_window_min      INTEGER NOT NULL DEFAULT 15,
    deadline_at           TEXT NOT NULL,
    buyer_stake_locked    REAL NOT NULL DEFAULT 0,
    status                TEXT NOT NULL DEFAULT 'open',
    winning_bid_id        TEXT,
    awarded_at            TEXT,
    bid_count             INTEGER NOT NULL DEFAULT 0,
    notes                 TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rfqs_buyer ON rfqs(buyer_id, status, created_at DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rfqs_board ON rfqs(status, category, region_required, urgency, deadline_at)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rfqs_deadline ON rfqs(status, deadline_at)') } catch {}
// P3c：award 自动建单需要收货地址（创建时快照）
try { db.exec('ALTER TABLE rfqs ADD COLUMN shipping_address TEXT') } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS bids (
    id                TEXT PRIMARY KEY,
    rfq_id            TEXT NOT NULL,
    seller_id         TEXT NOT NULL,
    offer_id          TEXT,
    price             REAL NOT NULL,
    qty_offered       INTEGER NOT NULL DEFAULT 1,
    eta_hours         REAL,
    fulfillment_type  TEXT NOT NULL DEFAULT 'standard',
    note              TEXT,
    stake_locked      REAL NOT NULL DEFAULT 0,
    auto_bid_skill    INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'active',
    submitted_at      TEXT DEFAULT (datetime('now')),
    resolved_at       TEXT,
    UNIQUE(rfq_id, seller_id)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_bids_rfq ON bids(rfq_id, status, price)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_bids_seller ON bids(seller_id, status, submitted_at DESC)') } catch {}

// AUC — 加价拍卖（forward English auction）
db.exec(`
  CREATE TABLE IF NOT EXISTS auctions (
    id                    TEXT PRIMARY KEY,
    seller_id             TEXT NOT NULL,
    listing_id            TEXT,
    product_id            TEXT,
    title                 TEXT NOT NULL,
    spec_json             TEXT,
    qty                   INTEGER NOT NULL DEFAULT 1,
    category              TEXT NOT NULL DEFAULT 'general',
    starting_price        REAL NOT NULL,
    current_price         REAL NOT NULL,
    min_increment         REAL NOT NULL DEFAULT 1,
    reserve_price         REAL,
    buyer_stake_pct       REAL DEFAULT 0.05,
    deadline_at           TEXT NOT NULL,
    sniper_extend_min     INTEGER NOT NULL DEFAULT 5,
    seller_stake_locked   REAL NOT NULL DEFAULT 0,
    status                TEXT NOT NULL DEFAULT 'open',
    winning_bid_id        TEXT,
    bid_count             INTEGER NOT NULL DEFAULT 0,
    awarded_at            TEXT,
    notes                 TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller_id, status, created_at DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_auctions_board ON auctions(status, category, deadline_at)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_auctions_deadline ON auctions(status, deadline_at)') } catch {}
// AUC P1：反狙击延长上限
try { db.exec('ALTER TABLE auctions ADD COLUMN max_extends INTEGER DEFAULT 10') } catch {}
try { db.exec('ALTER TABLE auctions ADD COLUMN extends_used INTEGER DEFAULT 0') } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS auction_bids (
    id                TEXT PRIMARY KEY,
    auction_id        TEXT NOT NULL,
    buyer_id          TEXT NOT NULL,
    price             REAL NOT NULL,
    stake_locked      REAL NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'active',
    submitted_at      TEXT DEFAULT (datetime('now')),
    resolved_at       TEXT
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_aucbids_auction ON auction_bids(auction_id, status, price DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_aucbids_buyer ON auction_bids(buyer_id, status, submitted_at DESC)') } catch {}

// CHAT — 上下文绑定聊天（order / rfq / listing_qa）→ server-schema.ts
initConversationsSchema(db)

// 聊天消息 → server-schema.ts；kind/meta ALTER 刻意留原位（紧跟下方）
initMessagesSchema(db)
// W1 私信结构化消息：kind = 'text' | 'offer' | 'tracking'；meta = JSON payload
try { db.exec("ALTER TABLE messages ADD COLUMN kind TEXT DEFAULT 'text'") } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN meta TEXT') } catch {}

// 反诈举报表（chat report → 人工审核）→ server-schema.ts
initChatReportsSchema(db)

// 基金池入池流水（depositToFund 审计 + 4 周历史均值数据源）
db.exec(`
  CREATE TABLE IF NOT EXISTS fund_deposits (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL,
    amount_base   REAL NOT NULL,
    amount_l3     REAL DEFAULT 0,
    buyer_region  TEXT,
    deposited_at  TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_fund_deposits_order ON fund_deposits(order_id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_fund_deposits_time ON fund_deposits(deposited_at)') } catch {}

// 结算周期日志（幂等保障 + 4 周历史均值数据源）
db.exec(`
  CREATE TABLE IF NOT EXISTS settlement_periods (
    period_id             TEXT PRIMARY KEY,
    started_at            TEXT NOT NULL,
    completed_at          TEXT,
    fund_balance_start    REAL NOT NULL,
    deposited_this_period REAL DEFAULT 0,
    history_average       REAL DEFAULT 0,
    payout_rate           REAL,
    pool_to_distribute    REAL,
    total_scores          REAL,
    n_value_cash          REAL,
    effective_unit_cash   REAL,
    cash_distributed      REAL DEFAULT 0,
    cash_retained         REAL DEFAULT 0,
    settled_users         INTEGER DEFAULT 0,
    status                TEXT DEFAULT 'pending',
    note                  TEXT
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_settle_periods_status ON settlement_periods(status, started_at)') } catch {}

// 休眠:管理津贴 payout 已随匹配引擎切除(#401);列 + state 作为休眠结构保留(可逆,默认关闭、无消费方)。
try { db.exec("ALTER TABLE users ADD COLUMN mgmt_bonus_eligible INTEGER DEFAULT 0") } catch {}
try { db.prepare("INSERT OR IGNORE INTO system_state (key, value) VALUES ('mgmt_bonus_enabled', '0')").run() } catch {}

// 推土机 L1 分享权限：默认按 verified buyer 判定，admin 可 override
// 0 = auto (按 verified 自动判定)   1 = 强制允许   -1 = 强制禁止
try { db.exec("ALTER TABLE users ADD COLUMN l1_share_override INTEGER DEFAULT 0") } catch {}

// 原子能挂靠偏好：决定不带 side 的链接如何自动选边
// 当前 2 档：team_count (default) / pv_count（近 90 天）
// Legacy: left / right —— 启动时静默迁移为 team_count，不再支持长期强偏；要强偏请用左/右码（一次性）
try { db.exec("ALTER TABLE users ADD COLUMN placement_pref TEXT DEFAULT 'team_count'") } catch {}
try { db.prepare("UPDATE users SET placement_pref = 'team_count' WHERE placement_pref IN ('left','right')").run() } catch {}

// 增量计数 backfill（一次性，幂等）：从现有 placement 树重算 left_count/right_count。
// 新装 / 空树 = no-op。有历史 placement 的库（local/已运行）首次启动重算一次。
// 2026-06-04 引入 left_count/right_count 增量字段时的迁移。
try {
  const done = (db.prepare("SELECT value FROM system_state WHERE key = 'placement_count_backfilled'").get() as { value: string } | undefined)?.value === '1'
  if (!done) {
    const placed = db.prepare("SELECT id, placement_id, placement_side FROM users WHERE placement_id IS NOT NULL").all() as { id: string; placement_id: string; placement_side: 'left' | 'right' }[]
    const bf = db.transaction(() => {
      db.exec("UPDATE users SET left_count = 0, right_count = 0")
      for (const p of placed) {
        let upParent: string | null = p.placement_id
        let upSide: 'left' | 'right' = p.placement_side
        let safety = 10_000
        while (upParent && safety-- > 0) {
          const col = upSide === 'left' ? 'left_count' : 'right_count'
          db.prepare(`UPDATE users SET ${col} = ${col} + 1 WHERE id = ?`).run(upParent)
          const pr = db.prepare("SELECT placement_id, placement_side FROM users WHERE id = ?").get(upParent) as { placement_id: string | null; placement_side: 'left' | 'right' | null } | undefined
          if (!pr?.placement_id) break
          upSide = pr.placement_side || 'left'
          upParent = pr.placement_id
        }
      }
    })
    bf()
    db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('placement_count_backfilled', '1')").run()
    console.log(`[placement_count] backfill 完成,重算 ${placed.length} 个已挂载节点`)
  }
} catch (e) { console.error('[placement_count backfill]', (e as Error).message) }

// ─── 身份码派生 helpers ─────────────────────────────────
// permanent_code：6 位 Crockford base32（去歧义字符 I L O U），永久唯一，不可改
// 32 字母表：0-9 + ABCDEFGHJKMNPQRSTVWXYZ
const PERMA_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function generatePermanentCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = ''
    for (let i = 0; i < 6; i++) code += PERMA_ALPHABET[Math.floor(Math.random() * 32)]
    const exists = db.prepare("SELECT 1 FROM users WHERE permanent_code = ?").get(code)
    if (!exists) return code
  }
  // 极小概率走 7 位兜底
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = ''
    for (let i = 0; i < 7; i++) code += PERMA_ALPHABET[Math.floor(Math.random() * 32)]
    const exists = db.prepare("SELECT 1 FROM users WHERE permanent_code = ?").get(code)
    if (!exists) return code
  }
  throw new Error('permanent_code generation exhausted')
}

// handle：公开用户名（ASCII，可改）；从 name 清洗派生，冲突加数字后缀
function deriveHandle(name: string, excludeUserId?: string): string {
  // 标准化 + 拆掉组合标记 + 只留 [a-z0-9_.]
  let base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  base = base.replace(/[^a-zA-Z0-9._]/g, '').toLowerCase()
  // 去掉开头/结尾的 . _
  base = base.replace(/^[._]+|[._]+$/g, '')
  if (base.length < 3) base = 'user' + Math.random().toString(36).slice(2, 7)  // 中文/特殊昵称兜底
  if (base.length > 18) base = base.slice(0, 18)
  // 保留前缀：避免与系统占用碰撞
  if (/^(usr|sys|admin|webaz|anonymous|null)/.test(base)) base = 'u_' + base
  // 唯一性检测，冲突加数字后缀
  let candidate = base
  let i = 1
  while (true) {
    const row = db.prepare("SELECT id FROM users WHERE handle = ?").get(candidate) as { id: string } | undefined
    if (!row || row.id === excludeUserId) return candidate
    candidate = base.slice(0, 16) + i.toString()
    i++
    if (i > 9999) throw new Error('handle generation exhausted: ' + base)
  }
}

// 用户引用解析：接受 usr_xxx / VKSF9P / @handle 三态，返回内部 id 或 null
function resolveUserRef(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const ref = raw.trim()
  if (!ref) return null
  // 1) usr_xxx 直接 id 查
  if (/^usr_[A-Za-z0-9_]+$/.test(ref)) {
    const r = db.prepare("SELECT id FROM users WHERE id = ?").get(ref) as { id: string } | undefined
    return r?.id || null
  }
  // 2) permanent_code（纯字母数字 6-7 位，大小写不敏感）
  if (/^[A-Z0-9]{6,7}$/i.test(ref) && !ref.startsWith('@')) {
    const r = db.prepare("SELECT id FROM users WHERE permanent_code = ?").get(ref.toUpperCase()) as { id: string } | undefined
    if (r) return r.id
  }
  // 3) handle（去 @ 前缀小写）
  const h = ref.replace(/^@/, '').toLowerCase()
  if (/^[a-z0-9._]+$/.test(h)) {
    const r = db.prepare("SELECT id FROM users WHERE handle = ?").get(h) as { id: string } | undefined
    if (r) return r.id
  }
  return null
}

// Invite-code-ONLY resolver — for registration sponsor + /i short links. Accepts a 6-7 char permanent_code
// with an optional -L/-R side suffix; rejects usr_xxx / @handle / bare handle (anti-ambiguity, narrows the
// public invite surface). Excludes sys_protocol + the internal auditor. Distinct from resolveUserRef, which
// stays for personal-page / non-invite lookups.
function resolveInviteCodeRef(raw: string | null | undefined): { userId: string; code: string; side: 'left' | 'right' | null } | null {
  if (!raw || typeof raw !== 'string') return null
  const m = raw.trim().match(/^([A-Za-z0-9]{6,7})(?:-([LRlr]))?$/)
  if (!m) return null
  const code = m[1].toUpperCase()
  const side: 'left' | 'right' | null = m[2] ? (m[2].toLowerCase() === 'l' ? 'left' : 'right') : null
  const r = db.prepare("SELECT id FROM users WHERE permanent_code = ? AND id NOT IN ('sys_protocol', ?) LIMIT 1").get(code, INTERNAL_AUDITOR_ID) as { id: string } | undefined
  if (!r) return null
  return { userId: r.id, code, side }
}

// 一次性回填：现有用户补齐 permanent_code + handle（启动时跑）
try {
  const rows = db.prepare("SELECT id, name FROM users WHERE permanent_code IS NULL OR handle IS NULL").all() as { id: string; name: string }[]
  let backfilled = 0
  for (const r of rows) {
    const code = db.prepare("SELECT permanent_code, handle FROM users WHERE id = ?").get(r.id) as { permanent_code: string | null; handle: string | null }
    const upd: { permanent_code?: string; handle?: string } = {}
    if (!code.permanent_code) upd.permanent_code = generatePermanentCode()
    if (!code.handle) upd.handle = deriveHandle(r.name, r.id)
    if (Object.keys(upd).length > 0) {
      db.prepare(`UPDATE users SET permanent_code = COALESCE(?, permanent_code), handle = COALESCE(?, handle) WHERE id = ?`)
        .run(upd.permanent_code ?? null, upd.handle ?? null, r.id)
      backfilled++
    }
  }
  if (backfilled > 0) console.log(`[WebAZ] 4-layer identity: backfilled permanent_code + handle for ${backfilled} users`)
} catch (e) { console.warn('[WebAZ] identity backfill', e) }

// 一次性回填：清理孤儿 placement FK（指向已删除用户）— 防止组织图渲染空指针
try {
  const r1 = db.prepare("UPDATE users SET left_child_id = NULL WHERE left_child_id IS NOT NULL AND left_child_id NOT IN (SELECT id FROM users)").run()
  const r2 = db.prepare("UPDATE users SET right_child_id = NULL WHERE right_child_id IS NOT NULL AND right_child_id NOT IN (SELECT id FROM users)").run()
  const r3 = db.prepare("UPDATE users SET placement_id = NULL WHERE placement_id IS NOT NULL AND placement_id NOT IN (SELECT id FROM users)").run()
  const total = (r1.changes || 0) + (r2.changes || 0) + (r3.changes || 0)
  if (total > 0) console.log(`[WebAZ] cleaned ${total} orphan placement FK references`)
} catch (e) { console.warn('[WebAZ] orphan FK cleanup', e) }

// 一次性回填：shareables.owner_code（必须在 users.permanent_code 回填之后）
try {
  const upd = db.prepare(`UPDATE shareables SET owner_code = (SELECT permanent_code FROM users WHERE id = shareables.owner_id) WHERE owner_code IS NULL AND owner_id IS NOT NULL`).run()
  if (upd.changes > 0) console.log(`[WebAZ] shareables: backfilled owner_code for ${upd.changes} rows`)
} catch (e) { console.warn('[WebAZ] shareables backfill', e) }

// Phase 9 / Phase 3d-1（D1b）— 注册门控（强制邀请码）：默认开启（需邀请），admin 可切换
try { db.prepare("INSERT OR IGNORE INTO system_state (key, value) VALUES ('require_ref_to_register', '1')").run() } catch {}
// D1b 一次性 migration：把存量库里仍为默认 '0' 的值翻成 '1'（marker 防重翻，admin 之后可自由改回 0 不被覆盖）
try {
  const d1bDone = db.prepare("SELECT value FROM system_state WHERE key = 'migration_d1b_require_ref'").get() as { value: string } | undefined
  if (!d1bDone) {
    const r = db.prepare("UPDATE system_state SET value = '1' WHERE key = 'require_ref_to_register' AND value = '0'").run()
    db.prepare("INSERT OR IGNORE INTO system_state (key, value) VALUES ('migration_d1b_require_ref', '1')").run()
    if (r.changes > 0) console.log('[D1b] require_ref_to_register 0→1（注册默认需邀请）')
  }
} catch (e) { console.warn('[D1b] migration', e) }
// 让 sys_protocol 可作为公库 sponsor（孤儿注册时分润自动归公库）
try { db.prepare("UPDATE users SET l1_share_override = 1 WHERE id = 'sys_protocol'").run() } catch {}
// M7.2.6 + 2026-05-21 PV 合规扩展：按全球各国监管态度分档
// 详细法律依据 + 风险评估见 docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md
//
// max_levels=0（完全禁 MLM，整池入 commission_reserve）：
//   GCC 国家 / 伊朗 / 朝鲜 / 缅甸 — 法律完全禁止任何下线计酬
// max_levels=1（仅 L1，类联盟营销）：
//   越南 / 印尼 / 菲律宾 — 严格 license 制度，多级风险高
// max_levels=2（L1+L2）：
//   中国（《禁止传销条例》三级判定为传销）
//   美国（FTC 70% retail rule + 多州 pyramid law）
//   欧盟（UCPD + 各国具体）
//   英国 / 加拿大 / 澳新 / 日本 / 韩国 / 印度
// max_levels=3（全三级允许）：
//   新加坡（DSAS）/ 马来（DSA license）/ 泰国 / 巴西 / 墨西哥
//   global_north / global = fallback 兜底；下方 getRegionMaxLevels 已改保守
;['sa','ae','qa','bh','kw','om','ir','kp','mm'].forEach(r => {
  try { db.prepare("INSERT OR IGNORE INTO region_config (region, max_levels, mlm_ui_visible) VALUES (?, 0, 0)").run(r) } catch {}
})
;['vn','id','ph'].forEach(r => {
  try { db.prepare("INSERT OR IGNORE INTO region_config (region, max_levels) VALUES (?, 1)").run(r) } catch {}
})
;['china','us','eu','gb','ca','au','nz','jp','kr','india'].forEach(r => {
  try { db.prepare("INSERT OR IGNORE INTO region_config (region, max_levels) VALUES (?, 2)").run(r) } catch {}
})
;['singapore','my','th','br','mx'].forEach(r => {
  try { db.prepare("INSERT OR IGNORE INTO region_config (region, max_levels) VALUES (?, 3)").run(r) } catch {}
})
// P0 关键修：global / global_north 兜底地区改为 1（之前 3 是漏洞 — 大量历史
// 用户 region='global' 直接拿到完整 3 级体验，绕过 fallback=1 安全网）
// P1 补：de / fr EU 内最严两国 + bd / pk 严管国家 → 1
;['global','global_north','de','fr','bd','pk'].forEach(r => {
  try { db.prepare("INSERT OR IGNORE INTO region_config (region, max_levels) VALUES (?, 1)").run(r) } catch {}
})
// 已有的 global/global_north=3 强制降级到 1
;['global','global_north'].forEach(r => {
  try { db.prepare("UPDATE region_config SET max_levels = 1 WHERE region = ? AND max_levels > 1").run(r) } catch {}
})
// 现有 DB 中可能已存在 max_levels=3 但应该降级的，强制更新
;['us','eu','gb','ca','au','nz','jp','kr','india'].forEach(r => {
  try { db.prepare("UPDATE region_config SET max_levels = 2 WHERE region = ? AND max_levels > 2").run(r) } catch {}
})
;['vn','id','ph','de','fr','bd','pk'].forEach(r => {
  try { db.prepare("UPDATE region_config SET max_levels = 1 WHERE region = ? AND max_levels > 1").run(r) } catch {}
})
;['sa','ae','qa','bh','kw','om','ir','kp','mm'].forEach(r => {
  try { db.prepare("UPDATE region_config SET max_levels = 0, mlm_ui_visible = 0 WHERE region = ? AND max_levels > 0").run(r) } catch {}
})

// ─── P0-2 PRE-LAUNCH 全局 clamp:max_levels ≤ 1（2026-06-03 user decision B）───
// 上方按辖区分档的 seed(0/1/2/3)是【知识/基础设施】,保留不删。
// 但 pre-launch 阶段【未请律师】,operator 明确"max_levels ≤ 1 everywhere 是不请律师
// 也安全的唯一前提"。因此强制把所有地区压到 ≤ 1(0 保持 0,更严不动)。
// 这是【唯一的 pre-launch 合规闸门】—— 单点可逆:
//   re-trigger(见 docs/LEGAL-DISCLOSURES.md §7):真实用户 > 100 / GMV > $10k /
//   首次监管 inquiry / 进入新辖区 / Phase D 上线 —— 届时【请律师背书后】删除本块,
//   即按上方 seed 的辖区分档自动放开。
// display == enforcement:clamp DB 值(而非仅运行时 cap),admin/UI 显示值 = 实际生效值。
try { db.exec("UPDATE region_config SET max_levels = 1 WHERE max_levels > 1") } catch {}
try { db.exec("UPDATE region_config SET mlm_ui_visible = 0 WHERE max_levels = 0") } catch {}

// 卖家发新品配额（模块 A）
for (const stmt of [
  'ALTER TABLE users ADD COLUMN max_products      INTEGER DEFAULT 200',
  'ALTER TABLE users ADD COLUMN listing_paused    INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN listing_paused_reason TEXT',
  'ALTER TABLE users ADD COLUMN listing_paused_by TEXT',
  'ALTER TABLE users ADD COLUMN listing_paused_at TEXT',
]) { try { db.exec(stmt) } catch {} }

// 配额提升申请 → server-schema.ts
initQuotaIncreaseApplicationsSchema(db)

// Verifier 申请记录 → server-schema.ts
initVerifierApplicationsSchema(db)

// Arbitrator 申请 + 白名单（外部仲裁员路径）→ server-schema.ts
// legacy 内部仲裁员 → 白名单的 migration INSERT 刻意留原位（紧跟下方）
initArbitratorReviewSchema(db)
// Migration：legacy 内部仲裁员 (role='arbitrator') → 自动加入白名单（is_system=1）
try {
  db.prepare(`
    INSERT OR IGNORE INTO arbitrator_whitelist (user_id, note, is_system, granted_by)
    SELECT id, '内部仲裁员（migration）', 1, 'system' FROM users WHERE role = 'arbitrator'
  `).run()
} catch (e) { console.warn('[arb migration]', (e as Error).message) }

// Verifier 申诉记录 → server-schema.ts
initVerifierAppealsSchema(db)

// 扩展 verifier_whitelist
for (const stmt of [
  "ALTER TABLE verifier_whitelist ADD COLUMN tier             TEXT DEFAULT 'active-2'",  // 旧数据兼容：当满级
  "ALTER TABLE verifier_whitelist ADD COLUMN daily_quota      INTEGER DEFAULT 60",
  "ALTER TABLE verifier_whitelist ADD COLUMN tasks_today      INTEGER DEFAULT 0",
  "ALTER TABLE verifier_whitelist ADD COLUMN quota_reset_at   TEXT",
  "ALTER TABLE verifier_whitelist ADD COLUMN granted_by       TEXT",
  "ALTER TABLE verifier_whitelist ADD COLUMN stake_amount     REAL DEFAULT 0",
  "ALTER TABLE verifier_whitelist ADD COLUMN cooldown_until   TEXT",
  "ALTER TABLE verifier_whitelist ADD COLUMN error_count_180d INTEGER DEFAULT 0",
  "ALTER TABLE verifier_whitelist ADD COLUMN is_system        INTEGER DEFAULT 0",
]) { try { db.exec(stmt) } catch {} }

// 系统兜底标记 + 永不限流（兜底用，可靠性优先）
try { db.prepare("UPDATE verifier_whitelist SET is_system = 1, tier = 'active-2', daily_quota = 9999 WHERE user_id = ?").run(INTERNAL_AUDITOR_ID) } catch {}

// 用户暂停状态（admin 管理）→ server-schema.ts
initUserModerationSchema(db)

// admin 操作审计日志 → server-schema.ts（initAdminCoordinationSchema FK 依赖本表，须先建）
initAdminAuditLogSchema(db)
// admin/agent coordination contribution — operator-claim + agent-mandate event logs + fact-source link
// (schema only). Placed HERE because it FKs users + contribution_facts (both created above) AND
// admin_audit_log (created just above). No ingestion runs at boot.
initAdminCoordinationSchema(db)

// Bootstrap admin（env BOOTSTRAP_ADMIN_NAME → 该用户升为 admin，幂等）
;(() => {
  const bootName = process.env.BOOTSTRAP_ADMIN_NAME
  if (!bootName?.trim()) return
  const u = db.prepare(
    "SELECT id, name, role, roles FROM users WHERE name = ? AND id NOT IN ('sys_protocol', ?) LIMIT 1"
  ).get(bootName.trim(), INTERNAL_AUDITOR_ID) as { id: string; name: string; role: string; roles: string } | undefined
  if (!u) { console.log(`[WebAZ] BOOTSTRAP_ADMIN_NAME=${bootName} 用户不存在，跳过引导`); return }
  let roles: string[] = []
  try { const parsed = JSON.parse(u.roles || '[]'); if (Array.isArray(parsed)) roles = parsed as string[] } catch {}
  if (!roles.includes('admin')) roles.push('admin')
  db.prepare("UPDATE users SET role = 'admin', roles = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(roles), u.id)
  console.log(`[WebAZ] ✓ ${u.name} 已升级为 admin (bootstrap)`)
})()

// 验证码表（邮箱绑定 / 找回密钥 / 改密码 等共用）→ server-schema.ts
initVerificationCodesSchema(db)

const NEW_PRODUCT_COLS = [
  // specs/brand/model/source_price/ship_regions/handling_hours/estimated_days/
  // fragile/return_days/return_condition/warranty_days moved to
  // initRegisterListSearchColumns (single source, shared w/ MCP) — see ~line 494.
  'ALTER TABLE products ADD COLUMN source_url TEXT',
  'ALTER TABLE products ADD COLUMN source_price_at TEXT',
  'ALTER TABLE products ADD COLUMN weight_kg REAL',
  'ALTER TABLE products ADD COLUMN excluded_regions TEXT',
  'ALTER TABLE products ADD COLUMN commitment_hash TEXT',
  'ALTER TABLE products ADD COLUMN description_hash TEXT',
  'ALTER TABLE products ADD COLUMN price_hash TEXT',
  'ALTER TABLE products ADD COLUMN hashed_at TEXT',
  'ALTER TABLE products ADD COLUMN updated_at TEXT',
  // Tier 7 metrics（角色感知 API + 后续排序公平化）
  'ALTER TABLE products ADD COLUMN last_sold_at TEXT',
  'ALTER TABLE products ADD COLUMN completion_count INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN dispute_loss_count INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN unique_sharer_count INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN metrics_backfilled_at TEXT',
  // 里程碑 5：新成交 14 天 boost
  'ALTER TABLE products ADD COLUMN first_sold_at TEXT',
  // 里程碑 6：商品类型标签（retail / wholesale / service / digital）
  `ALTER TABLE products ADD COLUMN product_type TEXT DEFAULT 'retail'`,
  // M7.2.6 方案 3：免质押上架 — stake 在首单成交时锁定
  'ALTER TABLE products ADD COLUMN stake_locked_at TEXT',
  // 2026-05-22 S4 商品溯源：结构化 origin claims（JSON）
  // 格式：{ country, manufacturer, materials: [...], certs: [{ name, sha256, link }] }
  // 任何字段可空；非空字段成为可被 product_claim_tasks 'origin' 类目挑战的标的
  'ALTER TABLE products ADD COLUMN origin_claims TEXT',
  // 2026-05-22 S3 跨境上架：多语言文案
  // 格式：{ en: "Title", ja: "...", ko: "..." }，默认 title 始终是 zh 版（fallback）
  'ALTER TABLE products ADD COLUMN i18n_titles TEXT',
  'ALTER TABLE products ADD COLUMN i18n_descs TEXT',
  // 2026-05-23 S5 极致性价比认证（协议级 daily batch 算法）
  // value_badge: 1 = 💎 认证（同 category 价格前 20%）；0 = 未认证
  // value_badge_rank: 同 category 第 N 名（升序，1 最便宜）
  // value_badge_pct: 相对中位价的折扣百分比（如 0.30 = 比中位低 30%）
  'ALTER TABLE products ADD COLUMN value_badge INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN value_badge_at TEXT',
  'ALTER TABLE products ADD COLUMN value_badge_rank INTEGER',
  'ALTER TABLE products ADD COLUMN value_badge_pct REAL',
  // 库存预警 + 自动下架（每商品可定制）
  'ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER DEFAULT 3',
  'ALTER TABLE products ADD COLUMN auto_delist_on_zero INTEGER DEFAULT 1',
  'ALTER TABLE products ADD COLUMN low_stock_alerted_at TEXT',     // 上次低库存通知时间（去重，24h 内不重发）
  'ALTER TABLE products ADD COLUMN auto_delisted_at TEXT',         // 上次自动下架时间（让卖家看到原因）
]
for (const sql of NEW_PRODUCT_COLS) { try { db.exec(sql) } catch {} }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_last_sold ON products(last_sold_at)') } catch {}

// Tier 7 backfill — 仅对未填的 product 跑一次，幂等
;(() => {
  try {
    const need = (db.prepare(`SELECT COUNT(1) as n FROM products WHERE metrics_backfilled_at IS NULL`).get() as { n: number }).n
    if (need === 0) return
    console.log(`[Tier7-backfill] backfilling product metrics for ${need} rows…`)
    const rows = db.prepare(`SELECT id FROM products WHERE metrics_backfilled_at IS NULL`).all() as { id: string }[]
    const upd = db.prepare(`UPDATE products SET
      last_sold_at = (SELECT MAX(COALESCE(updated_at, created_at)) FROM orders WHERE product_id = ? AND status = 'completed'),
      first_sold_at = (SELECT MIN(COALESCE(updated_at, created_at)) FROM orders WHERE product_id = ? AND status = 'completed'),
      completion_count = (SELECT COUNT(1) FROM orders WHERE product_id = ? AND status = 'completed'),
      dispute_loss_count = (
        SELECT COUNT(1) FROM disputes d JOIN orders o ON o.id = d.order_id
        WHERE o.product_id = ? AND d.ruling_type IN ('refund_buyer','partial_refund')
      ),
      unique_sharer_count = (
        SELECT COUNT(DISTINCT owner_id) FROM shareables
        WHERE related_product_id = ? AND status = 'active'
      ),
      metrics_backfilled_at = datetime('now')
    WHERE id = ?`)
    const tx = db.transaction(() => { for (const { id } of rows) upd.run(id, id, id, id, id, id) })
    tx()
    console.log(`[Tier7-backfill] done (${rows.length} rows)`)
  } catch (e) { console.error('[Tier7-backfill]', e) }
})()

// 里程碑 6-d：季节性 lifecycle schema（应季月份 CSV：例如 "9,10,11" = 秋季）
try { db.exec(`ALTER TABLE product_categories ADD COLUMN seasonal_months TEXT`) } catch {}

// 里程碑 5：first_sold_at 补刷（已 metrics_backfilled 的行也需要补一次）
;(() => {
  try {
    const r = db.prepare(`UPDATE products SET first_sold_at = (
      SELECT MIN(COALESCE(updated_at, created_at)) FROM orders
      WHERE product_id = products.id AND status = 'completed'
    ) WHERE first_sold_at IS NULL AND completion_count > 0`).run()
    if (r.changes > 0) console.log(`[M5-backfill] first_sold_at filled for ${r.changes} products`)
  } catch (e) { console.error('[M5-backfill first_sold_at]', e) }
})()

// ─── 里程碑 3：反操纵层 schema ─────────────────────────────────
try {
  initShareableClickLogSchema(db)
} catch (e) { console.error('[M3 schema scl]', e) }

// shareables ALTER 刻意留原位（scl init 之后、cal init 之前）
try {
  db.exec('ALTER TABLE shareables ADD COLUMN unique_click_count INTEGER DEFAULT 0')
} catch {}
try {
  db.exec('ALTER TABLE shareables ADD COLUMN flag_new_account INTEGER DEFAULT 0')
} catch {}

try {
  initCommissionAuditLogSchema(db)
} catch (e) { console.error('[M3 schema cal]', e) }

try {
  initRegistrationAuditLogSchema(db)
} catch (e) { console.error('[M3 schema ral]', e) }

// ─── 里程碑 4：Agent observability/reputation schema → server-schema.ts ─
try {
  initAgentCallLogSchema(db)
} catch (e) { console.error('[M4 schema acl]', e) }

try {
  initAgentReputationSchema(db)
} catch (e) { console.error('[M4 schema ar]', e) }

// ─── 2026-05-23 Agent 治理（spec: docs/AGENT-GOVERNANCE.md）→ server-schema.ts ─
// 顺序须保持：declarations → attestations → strikes →（ALTER skills 留原位）→ revocations
try {
  initAgentDeclarationsSchema(db)
  initAgentAttestationsSchema(db)
  initAgentStrikesSchema(db)
  // 2026-05-23 P1 fix 5.3：skills 加 disabled_by_strike_at（被 strike 自动停用后可恢复）—— 留 server.ts 原位
  try { db.exec(`ALTER TABLE skills ADD COLUMN disabled_by_strike_at TEXT`) } catch {}
  initAgentRevocationsSchema(db)
} catch (e) { console.error('[agent_governance schema]', e) }

// ─── 里程碑 7.2：商品 alias 系统 schema ─────────────────────────
// 协议级精准匹配：卖家声明该 SKU 的多种 alias（外部 id / 标题 / 短链 / 淘口令 token / 标题片段）
// 服务端用 findProductsByAlias 做"完全相等 + 包含"判定。alias 至少 6 字符，反通用词。
try {
  initProductAliasesSchema(db)
} catch (e) { console.error('[M7.2 schema product_aliases]', e) }

// M-5：region 切换 audit log + 24h 限流 → server-schema.ts
try {
  initRegionChangeLogSchema(db)
} catch (e) { console.error('[M-5 schema region_change_log]', e) }

// WebAuthn / Passkey — 大额提现 等敏感操作的二次确认（commit B）→ server-schema.ts
// users.webauthn_required_for_withdraw ALTER 刻意留原位（init 后、同一 try 内）
try {
  initWebauthnSchema(db)
  // 用户 opt-in 设置
  try { db.exec("ALTER TABLE users ADD COLUMN webauthn_required_for_withdraw INTEGER DEFAULT 0") } catch {}
} catch (e) { console.error('[webauthn schema]', e) }

// RP 配置：开发模式 localhost，生产域名通过 env 覆盖
const WEBAUTHN_RP_ID   = process.env.WEBAUTHN_RP_ID || 'localhost'
const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || 'WebAZ'
// L-3: 允许多 origin（PWA installed standalone + browser tab 可能 origin 一致，但生产可能同时挂主域和 www）
// WEBAUTHN_ORIGIN env 接 "https://a.com,https://www.a.com" 形式即可
const WEBAUTHN_ORIGIN_RAW = process.env.WEBAUTHN_ORIGIN || `http://${WEBAUTHN_RP_ID}:3000`
const WEBAUTHN_ORIGIN_LIST = WEBAUTHN_ORIGIN_RAW.split(',').map(s => s.trim()).filter(Boolean)
const WEBAUTHN_ORIGIN: string | string[] = WEBAUTHN_ORIGIN_LIST.length > 1 ? WEBAUTHN_ORIGIN_LIST : WEBAUTHN_ORIGIN_LIST[0]
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000   // 5 分钟
const WEBAUTHN_GATE_TTL_MS      = 90 * 1000       // 90 秒

// M7.3：claim 验证任务系统 — 买家对推荐理由发起验证，3 verifier 共识仲裁
try {
  initClaimVerificationBaseSchema(db)

  // M7.3b 结算扩展 — 刻意留 server.ts 原位（base init 之后，按原顺序）
  try { db.exec(`ALTER TABLE claim_verification_tasks ADD COLUMN majority_vote TEXT`) } catch {}
  try { db.exec(`ALTER TABLE claim_verification_votes ADD COLUMN was_majority INTEGER`) } catch {}

  // verifier 禁言 / 永封记录 → server-schema.ts
  initClaimVerifierSuspensionsSchema(db)
  // Sprint 1: 商品声明验证 → server-schema.ts
  initProductClaimSchema(db)
  // Sprint 2-A: 测评真实性验证 → server-schema.ts
  initReviewClaimSchema(db)
  // Sprint 2-B: 二手成色验证 → server-schema.ts
  initSecondhandClaimSchema(db)
  // Sprint 3-A: 拍卖声明 → server-schema.ts
  initAuctionClaimSchema(db)
  // Sprint 3-B: 慈善许愿声明 → server-schema.ts
  initWishClaimSchema(db)
} catch (e) { console.error('[M7.3 schema claim_verification]', e) }

// 从用户粘贴的外部原文提取候选 alias — 让卖家勾选确认
// 支持淘宝/京东/拼多多/抖音/小红书 等口令 + URL + 标题片段
function extractCandidateAliases(text: string): Array<{ type: string; value: string; hint: string }> {
  const candidates: Array<{ type: string; value: string; hint: string }> = []
  const seen = new Set<string>()
  const push = (type: string, value: string, hint: string) => {
    const key = `${type}::${value}`
    if (seen.has(key)) return
    if (value.length < 6) return
    seen.add(key)
    candidates.push({ type, value, hint })
  }

  // ① URL 解析 → external_id / short_url
  const urlMatches = text.match(/https?:\/\/[^\s一-鿿'"]+/gi) || []
  for (const url of urlMatches) {
    const meta = parsePlatformUrl(url)
    if (meta?.external_id) push('external_id', `${meta.platform}:${meta.external_id}`, '平台 canonical ID')
    // short_url：取 host + path（不含 query）
    try {
      const u = new URL(url)
      const shortKey = (u.host + u.pathname).replace(/\/+$/, '')
      if (shortKey.length >= 6) push('short_url', shortKey, '短链 alias')
    } catch {}
  }

  // ② 淘口令 token：8￥xxxxxx￥ / ￥xxxxxx￥ / $xxxxxx$（淘宝、京东等的通用加密 token 格式）
  const koulingRegex = /[8]?[¥￥$＄][A-Za-z0-9]{8,20}[¥￥$＄]/g
  const koulingMatches = text.match(koulingRegex) || []
  for (const m of koulingMatches) {
    const token = m.replace(/[8¥￥$＄]/g, '')
    if (token.length >= 8) push('kouling_token', token, '淘口令加密 token')
  }

  // ③ title_substring：清洗噪音词后取连续 6+ 字片段
  const noise = [
    '复制此条信息', '打开手机淘宝', '复制本条信息', '打开拼多多', '打开京东', '抖音商城',
    '点击链接直接打开', '【淘宝】', '【天猫】', '【京东】', '【拼多多】', '【抖音】', '【小红书】',
    '来自小红书', '复制到', 'App', '链接', '商品名', '点我', '抢购',
  ]
  let cleaned = text
  for (const n of noise) cleaned = cleaned.split(n).join('  ')
  // 去掉 URL
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, ' ')
  // 去掉 ￥...￥
  cleaned = cleaned.replace(koulingRegex, ' ')
  // 取连续的"中文+字母数字+空格" 片段
  const chunks = cleaned.split(/[^一-鿿\w\s·]+/).map(s => s.trim()).filter(s => s.length >= 6)
  // 按长度降序，前 3 个候选
  chunks.sort((a, b) => b.length - a.length)
  for (const c of chunks.slice(0, 3)) push('title_substring', c, '商品标题片段')

  return candidates
}

// 找到所有可能匹配用户输入的 product_id 集合
// 三层匹配：① title 完全相等 ② external_title 完全相等 ③ alias 子串/token 出现在用户文本中
function findProductsByAlias(userInput: string): Set<string> {
  const text = String(userInput || '').trim()
  const matched = new Set<string>()
  if (!text) return matched

  // ① product.title 完全相等
  try {
    const rows = db.prepare(`SELECT id FROM products WHERE title = ? AND status = 'active'`).all(text) as Array<{ id: string }>
    rows.forEach(r => matched.add(r.id))
  } catch {}

  // ② external_title 完全相等（product_external_links）
  try {
    const rows = db.prepare(`SELECT DISTINCT product_id FROM product_external_links WHERE external_title = ?`).all(text) as Array<{ product_id: string }>
    rows.forEach(r => matched.add(r.product_id))
  } catch {}

  // ③ alias 包含判定 — 只取 active + alias_value 长度 ≤ text 长度（必要条件）
  // 性能：MVP 阶段全表扫；大表后切 FTS5
  try {
    const aliases = db.prepare(`
      SELECT product_id, alias_value
      FROM product_aliases
      WHERE status = 'active' AND length(alias_value) >= 6 AND length(alias_value) <= ?
    `).all(text.length) as Array<{ product_id: string; alias_value: string }>
    for (const a of aliases) {
      if (text.includes(a.alias_value)) matched.add(a.product_id)
    }
  } catch {}

  return matched
}

// 预编译插入语句，hot path 上零运行时开销
const logAgentCallStmt = db.prepare(
  `INSERT INTO agent_call_log (api_key, user_id, endpoint, method, status_code) VALUES (?, ?, ?, ?, ?)`
)

// 30 天 TTL — 启动时清理一次（轻），后续靠每日 cron
;(() => {
  try {
    const r = db.prepare(`DELETE FROM agent_call_log WHERE created_at < datetime('now', '-30 days')`).run()
    if (r.changes > 0) console.log(`[M4-ttl] cleaned ${r.changes} agent_call_log rows`)
  } catch (e) { console.error('[M4-ttl]', e) }
})()

// trust_score 计算 — lazy refresh，1h 缓存
const TRUST_CACHE_MS = 60 * 60 * 1000
function computeAgentTrust(apiKey: string): {
  api_key: string; user_id: string; trust_score: number; level: 'new'|'trusted'|'quality'|'legend'; signals: Record<string, number>
} | null {
  const user = db.prepare(`SELECT id, created_at, sponsor_id FROM users WHERE api_key = ?`).get(apiKey) as { id: string; created_at: string; sponsor_id: string | null } | undefined
  if (!user) return null

  const ageDays = Math.max(0, (Date.now() - new Date(user.created_at.replace(' ', 'T') + 'Z').getTime()) / 86400_000)
  const completedBuyer = (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND status = 'completed'`).get(user.id) as { n: number }).n
  const completedSeller = (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE seller_id = ? AND status = 'completed'`).get(user.id) as { n: number }).n
  const disputeLoss = (db.prepare(`SELECT COUNT(*) as n FROM disputes WHERE defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')`).get(user.id) as { n: number }).n

  // 商品分享带来的真实成交（创作者贡献）
  const shareConversions = (db.prepare(`
    SELECT COUNT(*) as n FROM product_share_attribution psa
    JOIN orders o ON o.product_id = psa.product_id AND o.buyer_id = psa.recipient_id
    WHERE psa.sharer_id = ? AND o.status = 'completed' AND o.created_at >= psa.created_at
  `).get(user.id) as { n: number }).n

  // 30 天内 endpoint 多样性（agent 调用模式）
  const diversity = (db.prepare(`
    SELECT COUNT(DISTINCT endpoint) as n FROM agent_call_log
    WHERE api_key = ? AND created_at > datetime('now', '-30 days')
  `).get(apiKey) as { n: number }).n

  // sybil cluster：同 IP_hash 注册的账户数（减去自己）
  const myReg = db.prepare(`SELECT ip_hash FROM registration_audit_log WHERE user_id = ? LIMIT 1`).get(user.id) as { ip_hash: string } | undefined
  const sybilSize = myReg
    ? (db.prepare(`SELECT COUNT(DISTINCT user_id) as n FROM registration_audit_log WHERE ip_hash = ?`).get(myReg.ip_hash) as { n: number }).n
    : 0
  const sameIpOthers = Math.max(0, sybilSize - 1)   // 排除自己

  // 放置同支审计 / 上架限速命中
  const crossHits = (db.prepare(`SELECT COUNT(*) as n FROM commission_audit_log WHERE buyer_id = ? OR seller_id = ?`).get(user.id, user.id) as { n: number }).n
  // 限速命中 — 简化：30 天内 429 状态码次数
  const ratelimitHits = (db.prepare(`SELECT COUNT(*) as n FROM agent_call_log WHERE api_key = ? AND status_code = 429 AND created_at > datetime('now', '-30 days')`).get(apiKey) as { n: number }).n

  // 公式 — #420 P1-2:penalty 系数 / sybil 阈值 / 等级 cutoff 由 protocol_params 驱动(默认 = 原字面量)
  const t = readAntiAbuseThresholds(db)
  const agePts        = Math.min(ageDays, 90) * 0.5
  const orderPts      = Math.min(completedBuyer + completedSeller, 50) * 0.5
  const sharePts      = Math.min(shareConversions, 20) * 1.0
  const diversityPts  = Math.min(diversity, 25) * 0.4
  const disputeP      = -disputeLoss * t.trustDisputePenalty
  const sybilP        = agentSybilPenalty(sybilSize, t)
  const crossP        = -crossHits * t.trustCrossPenalty
  const ratelimitP    = -ratelimitHits * t.trustRatelimitPenalty

  const raw = agePts + orderPts + sharePts + diversityPts + disputeP + sybilP + crossP + ratelimitP
  const trust = Math.max(0, Math.round(raw * 100) / 100)

  const level: 'new'|'trusted'|'quality'|'legend' = agentTrustLevel(trust, t)

  const signals = {
    age_days: Math.round(ageDays * 10) / 10,
    completed_buyer: completedBuyer,
    completed_seller: completedSeller,
    dispute_loss: disputeLoss,
    share_conversions: shareConversions,
    diversity: diversity,
    same_ip_others: sameIpOthers,         // 同 IP 其他账户数（不含自己）
    cross_hits: crossHits,
    ratelimit_hits: ratelimitHits,
    age_pts: Math.round(agePts * 100) / 100,
    order_pts: Math.round(orderPts * 100) / 100,
    share_pts: Math.round(sharePts * 100) / 100,
    diversity_pts: Math.round(diversityPts * 100) / 100,
    dispute_penalty: Math.round(disputeP * 100) / 100,
    sybil_penalty: Math.round(sybilP * 100) / 100,
    cross_penalty: Math.round(crossP * 100) / 100,
    ratelimit_penalty: Math.round(ratelimitP * 100) / 100,
  }

  // 写入 / 更新
  db.prepare(`INSERT INTO agent_reputation (api_key, user_id, trust_score, level, signals, last_calculated_at)
              VALUES (?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(api_key) DO UPDATE SET
                user_id = excluded.user_id,
                trust_score = excluded.trust_score,
                level = excluded.level,
                signals = excluded.signals,
                last_calculated_at = excluded.last_calculated_at`).run(
    apiKey, user.id, trust, level, JSON.stringify(signals)
  )

  return { api_key: apiKey, user_id: user.id, trust_score: trust, level, signals }
}

function getAgentTrustCached(apiKey: string): ReturnType<typeof computeAgentTrust> {
  const row = db.prepare(`SELECT api_key, user_id, trust_score, level, signals, last_calculated_at FROM agent_reputation WHERE api_key = ?`).get(apiKey) as { api_key: string; user_id: string; trust_score: number; level: string; signals: string; last_calculated_at: string } | undefined
  if (row && row.last_calculated_at) {
    const age = Date.now() - new Date(row.last_calculated_at.replace(' ', 'T') + 'Z').getTime()
    if (age < TRUST_CACHE_MS) {
      let signals: Record<string, number> = {}
      try { signals = JSON.parse(row.signals || '{}') } catch {}
      return { api_key: row.api_key, user_id: row.user_id, trust_score: row.trust_score, level: row.level as 'new'|'trusted'|'quality'|'legend', signals }
    }
  }
  return computeAgentTrust(apiKey)
}

// 反操纵 helper：稳定的 IP / UA hash（不可逆，留作证据但保护隐私）
function antiCheatHash(input: string | null | undefined): string {
  if (!input) return 'unknown'
  return createHmac('sha256', MASTER_SEED).update('m3:' + input).digest('hex').slice(0, 24)
}
// 放置同支检测：写入 commission_audit_log（监测+证据；不阻断）
function auditSponsorChainCross(orderId: string, buyerId: string, sellerId: string, buyerSponsorPath: string | null) {
  if (buyerId === sellerId) return
  const sellerRow = db.prepare(`SELECT sponsor_path FROM users WHERE id = ?`).get(sellerId) as { sponsor_path: string | null } | undefined
  const sellerPath = sellerRow?.sponsor_path || ''
  const buyerAncestors = (buyerSponsorPath || '').split('>').filter(Boolean)
  const sellerAncestors = sellerPath.split('>').filter(Boolean)
  let relation: string | null = null
  if (buyerAncestors.includes(sellerId)) {
    // 卖家是买家的 PV 上游 → 买家自买给上游 = 自循环刷 commission/PV 嫌疑
    relation = 'seller_is_buyer_ancestor'
  } else if (sellerAncestors.includes(buyerId)) {
    // 买家是卖家的 PV 上游 → 上游买下游商品（不违规但需留证据）
    relation = 'buyer_is_seller_ancestor'
  } else {
    // 检查共同祖先（最近 N 层）
    const shared = buyerAncestors.filter(a => sellerAncestors.includes(a) && a !== 'sys_protocol')
    if (shared.length) relation = 'shared_ancestor'
  }
  if (!relation) return
  db.prepare(`INSERT INTO commission_audit_log (order_id, buyer_id, seller_id, flag, detail)
              VALUES (?,?,?,?,?)`).run(
    orderId, buyerId, sellerId, 'sponsor_chain_cross',
    JSON.stringify({ relation, buyer_path: buyerSponsorPath || '', seller_path: sellerPath })
  )
}

// 新账户分享 → 仅打标记，不阻断（留作 ranking weight 调整 / 后台审计依据）
function flagNewAccountShareable(shareableId: string, ownerId: string) {
  try {
    const u = db.prepare(`SELECT created_at FROM users WHERE id = ?`).get(ownerId) as { created_at: string } | undefined
    if (!u?.created_at) return
    const ageMs = Date.now() - new Date(u.created_at.replace(' ', 'T') + 'Z').getTime()
    if (ageMs < 3 * 86400_000) {
      db.prepare(`UPDATE shareables SET flag_new_account = 1 WHERE id = ?`).run(shareableId)
    }
  } catch (e) { console.error('[M3-flagNewAccount]', e) }
}
function clientIpHash(req: Parameters<typeof getUser>[0]): string {
  // trust proxy 已配置：req.ip 已是经反伪造校验后的真实客户端 IP
  const ip = (req as { ip?: string }).ip || ''
  return antiCheatHash(ip.trim() || 'unknown')
}
function clientUaHash(req: Parameters<typeof getUser>[0]): string {
  const ua = req.headers?.['user-agent']
  return antiCheatHash(typeof ua === 'string' ? ua : 'unknown')
}

// ─── 商品信息 hash（防篡改）──────────────────────────────────────
function md5(data: string) { return createHash('md5').update(data).digest('hex') }

function makeCommitmentHash(p: Record<string, unknown>) {
  return md5(JSON.stringify({
    ship_regions:    p.ship_regions    ?? '全国',
    handling_hours:  p.handling_hours  ?? 24,
    estimated_days:  p.estimated_days  ?? null,
    return_days:     p.return_days     ?? 7,
    return_condition:p.return_condition ?? '',
    warranty_days:   p.warranty_days   ?? 0,
  }))
}
function makeDescriptionHash(p: Record<string, unknown>) {
  return md5(JSON.stringify({ title: p.title, description: p.description, specs: p.specs ?? null }))
}
function makePriceHash(price: number, ts: string) {
  return md5(JSON.stringify({ price, created_at: ts }))
}

// ─── 外部链接解析（用于买家粘贴搜索） ────────────────────────────
// 服务器只做正则 / URL 解析，不做 HTTP 出网（避开反爬 + 0 等待）。
// 短链（e.tb.cn / 3.cn / 拼多多 ps=）能识别 platform 但拿不到 external_id —— 落到 external_title 兜底。
function parsePlatformUrl(rawUrl: string | null | undefined): { platform: string; external_id: string | null } | null {
  if (!rawUrl) return null
  let u: URL
  try { u = new URL(rawUrl) } catch { return null }
  const host = u.hostname.toLowerCase()

  if (host === 'item.taobao.com' || host === 'a.m.taobao.com') {
    return { platform: 'taobao', external_id: u.searchParams.get('id') }
  }
  if (host === 'detail.tmall.com' || host === 'detail.m.tmall.com') {
    return { platform: 'tmall', external_id: u.searchParams.get('id') }
  }
  if (host === 'e.tb.cn' || host === 'm.tb.cn' || host === 's.click.taobao.com') {
    return { platform: 'taobao', external_id: null }
  }
  if (host === 'item.jd.com' || host === 'item.m.jd.com') {
    const m = u.pathname.match(/\/(\d+)(?:\.html|$)/)
    return { platform: 'jd', external_id: m ? m[1] : null }
  }
  if (host === '3.cn' || host === 'u.jd.com') {
    return { platform: 'jd', external_id: null }
  }
  if (host === 'mobile.yangkeduo.com' || host === 'yangkeduo.com') {
    return { platform: 'pdd', external_id: u.searchParams.get('goods_id') }
  }
  if (host === 'k.pinduoduo.com' || host.endsWith('pinduoduo.com')) {
    return { platform: 'pdd', external_id: null }
  }
  if (host.endsWith('1688.com')) {
    const m = u.pathname.match(/\/offer\/(\d+)\.html/)
    return { platform: '1688', external_id: m ? m[1] : null }
  }
  if (host.endsWith('douyin.com') || host.endsWith('jinritemai.com') || host.endsWith('zhuwang.cc')) {
    return { platform: 'douyin', external_id: null }
  }
  if (host.endsWith('xiaohongshu.com') || host === 'xhslink.com') {
    return { platform: 'xhs', external_id: null }
  }
  return null
}

function extractTitleFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/「([^」]+)」/)
  return m?.[1]?.trim() ?? null
}

function extractUrlFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/https?:\/\/[^\s「」【】《》<>]+/i)
  return m?.[0] ?? null
}

// Agent-first 设计：粘贴外链匹配 **只允许精准匹配**，没有 LIKE 兜底。
// 模糊匹配与外推荐留给未来独立的"模糊搜索"入口（精准 trust，0 命中引导用户去 discover，不加 LIKE 兜底）。
function searchByExternalLink(opts: {
  platform?: string | null
  external_id?: string | null
  external_title?: string | null
}): { matched_by: 'external_id' | 'external_title_exact' | 'product_title_exact' | 'none'; products: Record<string, unknown>[] } {
  const cols = `p.id, p.title, p.description, p.price, p.stock, p.category, p.seller_id,
    p.specs, p.brand, p.model, p.handling_hours, p.return_days, p.warranty_days, p.ship_regions, p.fragile,
    p.estimated_days, p.return_condition, p.created_at, u.name as seller_name,
    pel.platform as link_platform, pel.external_id as link_external_id, pel.external_title as link_external_title, pel.url as link_url`
  const verifiedPredicate = `pel.verified = 1 AND (pel.revoked IS NULL OR pel.revoked = 0)`

  // Level 1: (platform, external_id) 完全相等
  if (opts.platform && opts.external_id) {
    const rows = db.prepare(`
      SELECT DISTINCT ${cols} FROM products p
      JOIN users u ON p.seller_id = u.id
      JOIN product_external_links pel ON pel.product_id = p.id
      WHERE pel.platform = ? AND pel.external_id = ? AND ${verifiedPredicate} AND p.status = 'active'
      LIMIT 20
    `).all(opts.platform, opts.external_id) as Record<string, unknown>[]
    if (rows.length) return { matched_by: 'external_id', products: rows }
  }

  // Level 2 & 3: 字符串绝对相等（Unicode NFKC 正规化后字面比较）。
  // NFKC 只统一字符的"视觉等价形式"（半角↔全角、组合↔合成），不剥任何字符，
  // 因此仍是精准匹配——只是"看起来一样"的字符串确实会被判等。
  // 规则：商品标题必须与外链标题一致，所以两个字段都查。
  if (opts.external_title) {
    const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').trim()
    const wanted = norm(opts.external_title)
    if (wanted) {
      // Level 2: 已认领外链的 external_title 完全相等
      const linked = db.prepare(`
        SELECT DISTINCT ${cols} FROM products p
        JOIN users u ON p.seller_id = u.id
        JOIN product_external_links pel ON pel.product_id = p.id
        WHERE pel.external_title IS NOT NULL AND ${verifiedPredicate} AND p.status = 'active'
      `).all() as Record<string, unknown>[]
      const linkedMatch = linked.filter((r) => norm(r.link_external_title as string) === wanted)
      if (linkedMatch.length) return { matched_by: 'external_title_exact', products: linkedMatch.slice(0, 20) }

      // Level 3: products.title 完全相等（手工上架无外链时的精准匹配入口）
      const productCols = cols.split('JOIN product_external_links')[0]  // drop the pel cols
      const allProducts = db.prepare(`
        SELECT p.id, p.title, p.description, p.price, p.stock, p.category, p.seller_id,
               p.specs, p.brand, p.model, p.handling_hours, p.return_days, p.warranty_days,
               p.ship_regions, p.fragile, p.estimated_days, p.return_condition, p.created_at,
               u.name as seller_name
        FROM products p
        JOIN users u ON p.seller_id = u.id
        WHERE p.status = 'active'
      `).all() as Record<string, unknown>[]
      const titleMatch = allProducts.filter((r) => norm(r.title as string) === wanted)
      if (titleMatch.length) return { matched_by: 'product_title_exact', products: titleMatch.slice(0, 20) }
    }
  }

  return { matched_by: 'none', products: [] }
}

// 口令格式检测（仅用于给用户友好提示，不做模糊匹配尝试）
function detectShareCommandFormat(text: string): { platform: string; hint: string } | null {
  if (/\$[A-Za-z0-9]{8,}\$/.test(text))         return { platform: 'taobao', hint: '淘口令（淘宝 App 加密分享格式）' }
  if (/￥[A-Za-z0-9]{8,}￥/.test(text))         return { platform: 'jd/pdd', hint: '京东 / 拼多多口令格式' }
  if (/^\d\.\d\s+[A-Za-z0-9]{8,}/.test(text.trim())) return { platform: 'xhs', hint: '小红书口令格式' }
  return null
}
db.exec(`
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,
    to_address         TEXT NOT NULL,
    amount             REAL NOT NULL,
    status             TEXT DEFAULT 'pending',
    status_detail      TEXT,
    email_confirmed_at TEXT,
    created_at         TEXT DEFAULT (datetime('now')),
    processed_at       TEXT,
    tx_hash            TEXT
  )
`)
// migrations for older DBs (idempotent — fail silently if column already exists)
try { db.exec("ALTER TABLE withdrawal_requests ADD COLUMN status_detail TEXT") } catch {}
try { db.exec("ALTER TABLE withdrawal_requests ADD COLUMN email_confirmed_at TEXT") } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS deposit_txns (
    tx_hash      TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    amount       REAL NOT NULL,        -- ⚠ 语义：原始 USDC 数量（≠ credited_waz）。旧行（Wave G 前）amount = WAZ。聚合时按 confirmed_at 判定。
    block_number INTEGER,
    swept        INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('ALTER TABLE deposit_txns ADD COLUMN swept INTEGER DEFAULT 0') } catch {}
// Wave G-3: 确认进度跟踪 — confirmed_at NULL = pending；credited_waz = 实际入账 WAZ（Wave G 后入账以此为准，不要 SUM(amount)）
try { db.exec('ALTER TABLE deposit_txns ADD COLUMN confirmed_at TEXT') } catch {}
try { db.exec('ALTER TABLE deposit_txns ADD COLUMN credited_waz REAL') } catch {}
try { db.exec('ALTER TABLE deposit_txns ADD COLUMN block_at_seen INTEGER') } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS system_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  )
`)

// ─── 2026-05-23 支付选项管理（root admin 配置层 + 多链/多渠道预留）────
// payment_methods：全局支付方法目录（如 USDC-Base / USDT-Tron / 支付宝）
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_methods (
    id                TEXT PRIMARY KEY,           -- 'usdc_base' / 'usdt_tron' / 'alipay_cn' …
    display_name      TEXT NOT NULL,              -- 中文显示名
    display_name_en   TEXT,                       -- 英文显示名
    kind              TEXT NOT NULL,              -- 'crypto_onchain' | 'bank_wire' | 'card' | 'mobile_wallet' | 'p2p'
    asset             TEXT NOT NULL,              -- 'USDC' | 'USDT' | 'CNY' | 'EUR'
    chain             TEXT,                       -- 'base' | 'tron' | 'ethereum' | 'polygon' (crypto only)
    contract_address  TEXT,                       -- ERC20 / TRC20 合约
    decimals          INTEGER DEFAULT 6,
    icon              TEXT,                       -- emoji
    status            TEXT NOT NULL DEFAULT 'inactive',     -- 'active' | 'preview' | 'inactive' | 'deprecated'
    watcher_status    TEXT NOT NULL DEFAULT 'unconfigured', -- 'active' | 'unconfigured' | 'failing'
    notes             TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now')),
    updated_by        TEXT
  )
`)
// region_payment_methods：地区 × 方法 × 方向（deposit/withdraw）开关 + 额度
db.exec(`
  CREATE TABLE IF NOT EXISTS region_payment_methods (
    id            TEXT PRIMARY KEY,
    region        TEXT NOT NULL,                  -- 'china' | 'us' | 'eu' | 'global' (fallback)
    method_id     TEXT NOT NULL,
    direction     TEXT NOT NULL,                  -- 'deposit' | 'withdraw' | 'both'
    status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'blocked'
    min_amount    REAL DEFAULT 0,
    max_amount    REAL,                           -- NULL = no cap
    daily_cap     REAL,
    notes         TEXT,
    updated_at    TEXT DEFAULT (datetime('now')),
    updated_by    TEXT,
    UNIQUE(region, method_id, direction)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_rpm_region ON region_payment_methods(region, status)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_rpm_method ON region_payment_methods(method_id)`)
// payment_methods_log：变更审计（COP transparency — 公开可查）
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_methods_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_kind   TEXT NOT NULL,                  -- 'method' | 'region_mapping'
    entity_id     TEXT NOT NULL,
    action        TEXT NOT NULL,                  -- 'create' | 'update' | 'delete' | 'status_change'
    old_value     TEXT,                           -- JSON snapshot
    new_value     TEXT,                           -- JSON snapshot
    changed_by    TEXT,
    reason        TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_pml_entity ON payment_methods_log(entity_kind, entity_id, id DESC)`)

// Seed：USDC-Base (active) + USDT-Tron (preview stub) + global × usdc_base 默认开启
function seedPaymentMethods() {
  const hasBase = db.prepare(`SELECT 1 FROM payment_methods WHERE id = 'usdc_base'`).get()
  if (!hasBase) {
    db.prepare(`INSERT INTO payment_methods (
      id, display_name, display_name_en, kind, asset, chain, contract_address, decimals, icon, status, watcher_status, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'usdc_base', 'USDC（Base 链）', 'USDC on Base', 'crypto_onchain',
      'USDC', 'base',
      // 取当前运行配置的 USDC 地址（mainnet/testnet 自适应）— 这里先用 mainnet 地址，启动后实际读 env
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6,
      '💵', 'active', 'active',
      '协议默认结算资产 · 已接入链上 watcher 自动到账',
    )
  }
  const hasTron = db.prepare(`SELECT 1 FROM payment_methods WHERE id = 'usdt_tron'`).get()
  if (!hasTron) {
    db.prepare(`INSERT INTO payment_methods (
      id, display_name, display_name_en, kind, asset, chain, contract_address, decimals, icon, status, watcher_status, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'usdt_tron', 'USDT（Tron 链）', 'USDT on Tron', 'crypto_onchain',
      'USDT', 'tron',
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6,
      '🔶', 'preview', 'unconfigured',
      'Tron 链 USDT — watcher 未接入；当前为 admin 配置预览',
    )
  }
  // 默认区域映射：global × usdc_base × both = active
  const hasGlobalMapping = db.prepare(
    `SELECT 1 FROM region_payment_methods WHERE region = 'global' AND method_id = 'usdc_base' AND direction = 'both'`,
  ).get()
  if (!hasGlobalMapping) {
    db.prepare(`INSERT INTO region_payment_methods (
      id, region, method_id, direction, status, min_amount, max_amount, daily_cap, notes
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      generateId('rpm'), 'global', 'usdc_base', 'both', 'active', 0, null, null, '默认开放',
    )
  }
}
try { seedPaymentMethods() } catch (e) { console.error('[payment_methods seed]', e) }
db.exec(`
  CREATE TABLE IF NOT EXISTS price_sessions (
    token      TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    price      REAL NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  )
`)
// 外部链接验证 base → server-schema.ts；ALTER/index/回填 IIFE 刻意留原位（紧跟下方）
initProductExternalLinksBaseSchema(db)
try { db.exec('ALTER TABLE product_external_links ADD COLUMN revoked INTEGER DEFAULT 0') } catch {}
// 平台 / 外部 ID / 外部全标题（用于买家粘贴外链搜索）
try { db.exec('ALTER TABLE product_external_links ADD COLUMN platform TEXT') } catch {}
try { db.exec('ALTER TABLE product_external_links ADD COLUMN external_id TEXT') } catch {}
try { db.exec('ALTER TABLE product_external_links ADD COLUMN external_title TEXT') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_pel_platform_ext ON product_external_links(platform, external_id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_pel_ext_title    ON product_external_links(external_title)') } catch {}

// 回填：旧 product_external_links 行用 parsePlatformUrl 补 platform/external_id；external_title 暂用商品 title
;(() => {
  try {
    const stale = db.prepare(`
      SELECT pel.id, pel.url, p.title as product_title
      FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.platform IS NULL OR pel.external_title IS NULL
      LIMIT 500
    `).all() as { id: string; url: string; product_title: string }[]
    const upd = db.prepare(`UPDATE product_external_links SET platform = ?, external_id = ?, external_title = COALESCE(external_title, ?) WHERE id = ?`)
    let n = 0
    for (const r of stale) {
      const meta = parsePlatformUrl(r.url)
      upd.run(meta?.platform ?? null, meta?.external_id ?? null, r.product_title, r.id)
      n++
    }
    if (n) console.log(`[WebAZ] backfilled ${n} product_external_links rows with platform/external_id/external_title`)
  } catch (e) { console.error('[backfill failed]', (e as Error).message) }
})()
// link_challenges 保留用于向后兼容，新流程用 verify_tasks → server-schema.ts
initLinkChallengesSchema(db)
initVerifyTasksSchema(db)
initVerifySubmissionsSchema(db)
// verifier_stats 须在 PERMANENT_ACCOUNTS bootstrap 之前完成 → server-schema.ts
initVerifierStatsSchema(db)

// ─── PERMANENT_ACCOUNTS bootstrap (moved here 2026-05-26 by boot-order fix) ───
// 原在 line ~496 但引用 users.email_verified / verifier_whitelist.tier 等
// ALTER 列 + verifier_stats 表，那时 schema 还没建好 → boot crash。
// 移到所有 DDL 完成之后跑，零 boot-order 依赖。
;(() => {
  for (const acc of PERMANENT_ACCOUNTS) {
    const apiKey = 'key_perm_' + createHmac('sha256', MASTER_SEED).update(acc.seed).digest('hex')
    const existing = db.prepare('SELECT api_key FROM users WHERE id = ?').get(acc.id) as { api_key: string } | undefined
    if (!existing) {
      db.prepare('INSERT INTO users (id, name, role, roles, api_key, email_verified) VALUES (?,?,?,?,?,1)')
        .run(acc.id, acc.name, acc.role, JSON.stringify(acc.roles), apiKey)
      db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?,?)').run(acc.id, acc.balance)
      console.log(`[WebAZ] ✓ 永久账户 ${acc.name} 已 bootstrap`)
      // H-5 P1: 生产环境不打印完整 api_key 防日志泄漏（开发可见，方便调试）
      if (process.env.NODE_ENV === 'production') {
        console.log(`           API Key: ${apiKey.slice(0, 12)}…${apiKey.slice(-4)}（生产环境已脱敏）`)
      } else {
        console.log(`           API Key: ${apiKey}`)
      }
    } else if (existing.api_key !== apiKey) {
      db.prepare('UPDATE users SET api_key = ?, role = ?, roles = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(apiKey, acc.role, JSON.stringify(acc.roles), acc.id)
      console.log(`[WebAZ] ↻ 永久账户 ${acc.name} api_key 已重置`)
      if (process.env.NODE_ENV === 'production') {
        console.log(`           API Key: ${apiKey.slice(0, 12)}…${apiKey.slice(-4)}（生产环境已脱敏）`)
      } else {
        console.log(`           API Key: ${apiKey}`)
      }
    }
    // Verifier 类账户自动进白名单
    if ('whitelist' in acc && acc.whitelist) {
      const wl = db.prepare("SELECT user_id FROM verifier_whitelist WHERE user_id = ?").get(acc.id)
      if (!wl) {
        db.prepare(`INSERT INTO verifier_whitelist (user_id, note, tier, daily_quota, granted_by)
                    VALUES (?, '永久测试账户', ?, ?, 'system_bootstrap')`)
          .run(acc.id, acc.whitelist.tier, acc.whitelist.daily_quota)
      }
      db.prepare("INSERT OR IGNORE INTO verifier_stats (user_id) VALUES (?)").run(acc.id)
    }
  }
})()

const app = express()

// trust proxy：只信内网/回环链路传来的 X-Forwarded-For
// — 防伪造（开发：直连 ::1/127 → req.ip 返回 socket IP；生产：信任同机/同 VPC 内的反代）
// — 部署在 Cloudflare/nginx 后面时若不在同 VPC，需改为 ['cloudflare-cidr', ...] 或具体 IP 列表，绝不要写 true
app.set('trust proxy', 'loopback, linklocal, uniquelocal')

// Cloudflare-only origin guard (defense-in-depth vs direct-to-origin bypass). OFF by default;
// configured via CF_ORIGIN_GUARD_MODE (off|observe|enforce) + CF_ORIGIN_SHARED_SECRET — see cf-origin-guard.ts.
app.use(createCfOriginGuard())

app.use(express.json())

// ─── Security headers (CSP + nosniff + frame-options) ─────────
// 注意：现有代码大量使用 inline onclick="..." / style="..."，无法启用纯净 CSP
// 折中策略：保留 'unsafe-inline'，但收紧 frame-ancestors / object-src / base-uri 等防 clickjacking + script injection vectors
app.use((req, res, next) => {
  // connect-src 白名单：自身 + 区块链浏览器 + 全部 HTTPS（支持用户自定义 agent endpoint）
  // 安全权衡：用户能配置任意 endpoint 接入自己的 agent，需放开 https:；
  // XSS exfil 风险由 script-src 'self' + frame-ancestors 'none' + base-uri 'self' 兜底
  const CONNECT_ALLOW = [
    "'self'",
    "https:",                                          // 全部 HTTPS（含 LLM providers + 用户自定义 agent endpoint）
    "http://localhost:*",                              // Ollama 本地 + 开发
    "wss:", "ws:",                                     // SSE/WebSocket
  ].join(' ')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",                     // 商品/外链缩略图
    "media-src 'self' blob: data:",
    `connect-src ${CONNECT_ALLOW}`,
    "font-src 'self' data:",
    "frame-ancestors 'none'",                          // 防 clickjacking
    "base-uri 'self'",                                 // 防 base tag injection
    "form-action 'self'",
    "object-src 'none'",                               // 禁 Flash/Java plugin
  ].join('; '))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()')
  next()
})

// 里程碑 4-a：agent_call_log 中间件 — 仅 /api/* 路径，不阻塞响应（user_id 留空，由计算 trust 时反查）
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  const key = req.headers.authorization?.replace('Bearer ', '') ?? null
  // endpoint 规范化：把动态段（id）替换为占位（避免索引爆炸）
  const endpoint = req.path.replace(/\/(usr_|prd_|ord_|shr_|key_|pvl_|dpt_|fd_)[A-Za-z0-9_]+/g, '/:id')
  res.on('finish', () => {
    try { logAgentCallStmt.run(key, null, endpoint, req.method, res.statusCode) } catch {}
  })
  next()
})

// 2026-05-23 Agent 治理 — 分档 rate limit + 撤销 + active strike 检查
// spec: docs/AGENT-GOVERNANCE.md §7
// 流程：抓 api_key → 查 agent_reputation.level → 按协议参数取本档 cap → 滚动 60s 窗口内计数 → 超限 429
// 同时检查 api_key / operator-name 是否被撤销；active strike (suspend_7d / permanent) 也拒绝
const agentRateBuckets = new Map<string, { windowStart: number; count: number }>()
// active strike / revocation 缓存（60s）
const agentBlockedCache = new Map<string, { blocked: boolean; reason?: string; until: number }>()
const AGENT_BLOCK_CACHE_TTL_MS = 60_000

function isApiKeyBlocked(apiKey: string): { blocked: boolean; reason?: string } {
  const cached = agentBlockedCache.get(apiKey)
  if (cached && cached.until > Date.now()) return { blocked: cached.blocked, reason: cached.reason }
  // 查 active strike (permanent 或 suspend_7d 未到期；warning 不阻断只是 penalty)
  const strike = db.prepare(`SELECT severity, reason_code FROM agent_strikes
    WHERE api_key = ?
      AND severity IN ('permanent', 'suspend_7d')
      AND (severity = 'permanent' OR expires_at > datetime('now'))
      AND appeal_status NOT IN ('approved')
    ORDER BY issued_at DESC LIMIT 1`).get(apiKey) as { severity: string; reason_code: string } | undefined
  if (strike) {
    const reason = `agent ${strike.severity === 'permanent' ? '已永久封禁' : '处于暂停期'}：${strike.reason_code}`
    agentBlockedCache.set(apiKey, { blocked: true, reason, until: Date.now() + AGENT_BLOCK_CACHE_TTL_MS })
    return { blocked: true, reason }
  }
  // 查 api_key 直接撤销
  const directRevoke = db.prepare(`SELECT 1 FROM agent_revocations WHERE target_kind = 'api_key' AND target_value = ? LIMIT 1`).get(apiKey)
  if (directRevoke) {
    agentBlockedCache.set(apiKey, { blocked: true, reason: 'agent 已被用户/admin 撤销', until: Date.now() + AGENT_BLOCK_CACHE_TTL_MS })
    return { blocked: true, reason: 'agent 已被用户/admin 撤销' }
  }
  // 查 operator-name 撤销（需 join agent_declarations）
  const opRevoke = db.prepare(`SELECT 1 FROM agent_declarations ad
    JOIN agent_revocations ar ON ar.target_kind = 'operator_name' AND ar.target_value = ad.operator_name
    WHERE ad.api_key = ? LIMIT 1`).get(apiKey)
  if (opRevoke) {
    agentBlockedCache.set(apiKey, { blocked: true, reason: 'operator 已被撤销，旗下所有 agent 不可用', until: Date.now() + AGENT_BLOCK_CACHE_TTL_MS })
    return { blocked: true, reason: 'operator 已被撤销，旗下所有 agent 不可用' }
  }
  // declaration 自撤销（用户主动 revoke 自己的 agent）
  const declRevoke = db.prepare(`SELECT 1 FROM agent_declarations WHERE api_key = ? AND revoked_at IS NOT NULL LIMIT 1`).get(apiKey)
  if (declRevoke) {
    agentBlockedCache.set(apiKey, { blocked: true, reason: 'agent declaration 已撤销', until: Date.now() + AGENT_BLOCK_CACHE_TTL_MS })
    return { blocked: true, reason: 'agent declaration 已撤销' }
  }
  agentBlockedCache.set(apiKey, { blocked: false, until: Date.now() + AGENT_BLOCK_CACHE_TTL_MS })
  return { blocked: false }
}

// 暴露给其它代码用（issue strike 时清缓存）
function invalidateAgentBlockedCache(apiKey: string) { agentBlockedCache.delete(apiKey) }
// Phase 3b/3d 配套：绑/解绑 Passkey 后失效 risk 缓存的 hasPasskey 位,
// 否则 5min TTL 内 D2b 看不到刚绑的 Passkey,刚绑钥的真人会被继续拦。
function invalidateAgentRiskCacheForUser(userId: string) {
  try {
    const keys = db.prepare(`SELECT api_key FROM users WHERE id = ? UNION SELECT api_key FROM agent_reputation WHERE user_id = ?`).all(userId, userId) as Array<{ api_key: string }>
    for (const k of keys) agentRiskCache.delete(k.api_key)
  } catch { /* never break the request */ }
}

// 2026-05-23 P0 audit fix 2.3：自动 strike 发放 + 3-strike 升级
// 升级规则：
//   - 7天内累计 2 次 warning → 自动升级 suspend_7d
//   - 30天内累计 3 次 suspend_7d → 自动升级 permanent
//   - 任何 strike 都触发缓存失效
function issueAgentStrike(opts: {
  apiKey: string
  userId: string
  reasonCode: string                          // 'fake_shipment' | 'dispute_loss' | 'rate_limit_abuse' | 'overlimit_order' | ...
  reasonDetail?: string
  reportedBy?: string                         // user_id 或 'system' / 'admin'
  relatedRef?: string                         // 关联 order/dispute/claim_task id
  initialSeverity?: 'warning' | 'suspend_7d' | 'permanent'  // 默认 warning，特殊情况可直接重判
}): { severity: string; expires_at: string | null; escalated: boolean } {
  const { apiKey, userId, reasonCode } = opts
  const initial = opts.initialSeverity || 'warning'
  // #420 P1-4:升级阶梯阈值/窗口/过期 由 protocol_params 驱动(默认 = 原 7d/30d/≥1/≥2/24h/7d)
  const t = readAntiAbuseThresholds(db)
  // 看是否需要升级
  const warnings7d = (db.prepare(`SELECT COUNT(*) as n FROM agent_strikes
    WHERE api_key = ? AND severity = 'warning' AND issued_at > datetime('now', '-${t.strikeWarnWindowDays} days')
      AND appeal_status NOT IN ('approved')`).get(apiKey) as { n: number }).n
  const suspends30d = (db.prepare(`SELECT COUNT(*) as n FROM agent_strikes
    WHERE api_key = ? AND severity = 'suspend_7d' AND issued_at > datetime('now', '-${t.strikeSuspendWindowDays} days')
      AND appeal_status NOT IN ('approved')`).get(apiKey) as { n: number }).n

  const { severity, escalated } = agentStrikeSeverity(initial, warnings7d, suspends30d, t)
  // expires_at
  let expiresAt: string | null = null
  if (severity === 'warning') {
    expiresAt = new Date(Date.now() + t.strikeWarnExpiryHours * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  } else if (severity === 'suspend_7d') {
    expiresAt = new Date(Date.now() + t.strikeSuspendExpiryDays * 86400_000).toISOString().replace('T', ' ').slice(0, 19)
  }
  db.prepare(`INSERT INTO agent_strikes (api_key, user_id, severity, reason_code, reason_detail, reported_by, related_ref, expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    apiKey, userId, severity, reasonCode,
    opts.reasonDetail || null, opts.reportedBy || 'system', opts.relatedRef || null, expiresAt,
  )
  invalidateAgentBlockedCache(apiKey)

  // 2026-05-23 P1 fix 5.3：suspend_7d / permanent → 自动停用该 seller 的所有 active skill
  if (severity === 'suspend_7d' || severity === 'permanent') {
    try {
      const r = db.prepare(`UPDATE skills SET active = 0, disabled_by_strike_at = datetime('now')
        WHERE seller_id = ? AND active = 1`).run(userId)
      if (r.changes > 0) console.log(`[strike→skill] disabled ${r.changes} skills for user ${userId}`)
    } catch (e) { console.error('[strike skills disable]', e) }
  }
  return { severity, expires_at: expiresAt, escalated }
}
// 暴露（dispute 模块 / cron 也会调用）
void issueAgentStrike

function getAgentRateCap(level: string): number {
  const key = `agent_rate_${level}_per_min` as const
  return Number(getProtocolParam<number>(key, AGENT_RATE_PER_MIN_DEFAULTS[level] ?? AGENT_RATE_PER_MIN_DEFAULTS.new))
}

// 2026-05-23 P1 fix 2.4：mass-action 日 cap（按 trust level + action 类别）
// 拦截 spam / 信息轰炸：chat / comment / share 三类 social-write 操作有独立的日上限
// 触发：超 cap → 429 AGENT_DAILY_CAP；累计 ≥3 次超限 / 24h → issueAgentStrike(warning)
// 限额表抽到 ./limits.ts(单一真相源,与 RFC-011 §② negative-space 发布面共享)。
const MASS_ACTION_TYPES_SET = new Set(MASS_ACTION_TYPES)
const massActionDailyCaps = MASS_ACTION_DAILY_CAPS
// in-memory 日窗口 counter（不持久化，重启清零；持久化需求未来用 agent_call_log 算）
const massActionDailyBuckets = new Map<string, { dayKey: string; counts: Record<string, number>; overruns: number }>()
function todayKey() { return new Date().toISOString().slice(0, 10) }
function checkMassActionCap(apiKey: string, action: string, level: string): { ok: boolean; cap?: number; used?: number } {
  if (!MASS_ACTION_TYPES_SET.has(action)) return { ok: true }
  const cap = (massActionDailyCaps[action] || {})[level] ?? massActionDailyCaps[action]?.new ?? 999999
  const today = todayKey()
  let bucket = massActionDailyBuckets.get(apiKey)
  if (!bucket || bucket.dayKey !== today) {
    bucket = { dayKey: today, counts: {}, overruns: 0 }
    massActionDailyBuckets.set(apiKey, bucket)
  }
  const cur = (bucket.counts[action] || 0) + 1
  bucket.counts[action] = cur
  if (cur > cap) {
    bucket.overruns++
    if (bucket.overruns === 3) {
      // 当日累计 3 次超限 → 自动 warning
      const u = db.prepare(`SELECT id FROM users WHERE api_key = ?`).get(apiKey) as { id: string } | undefined
      if (u) issueAgentStrike({
        apiKey, userId: u.id, reasonCode: 'mass_action_abuse',
        reasonDetail: `${action} 当日 cap=${cap} 累计超 3 次`,
      })
    }
    return { ok: false, cap, used: cur }
  }
  return { ok: true }
}

// #1043(补 A) 跨用户读日 cap — distinct other_user_id per day,真人也罩(只是 cap 更高,不再无限)
// 触发面:只对路径里"显式带其他用户 ID"的端点计数 → /api/users/:id/* 类。
//   · 防"枚举/扒数据"型读取(剽窃 / 内容农场 / 用户画像批量化)
//   · 真人监护人(绑 Passkey) 也罩:audit "补 A" — 之前 Passkey 真人无任何 read cap,scraper 拿真人账号即绕过
//   · 不打 /api/nearby /api/search(地理聚合 / 关键词查),那些已被 B1 read-scope 约束
// CROSS_USER_READ_DAILY_CAP 抽到 ./limits.ts(单一真相源)。
const crossUserReadBuckets = new Map<string, { dayKey: string; distinct: Set<string>; overruns: number }>()
function extractCrossUserTarget(path: string, currentUserId: string): string | null {
  // /api/users/:id 或 /api/users/:id/anything → :id;同 user 不算跨;sys_* 协议账号不算
  // P1-4 修:允许 trailing path 缺失(/api/users/:user_id 是合法 endpoint,返回用户档案)
  const m = path.match(/^\/api\/users\/([^/?#]+)(?:[/?#]|$)/)
  if (!m) return null
  const target = m[1]
  if (!target || target === currentUserId) return null
  if (target.startsWith('sys_')) return null
  return target
}
function checkCrossUserReadCap(userId: string, targetId: string, level: 'passkey_human' | string): { ok: boolean; cap: number; used: number } {
  const today = todayKey()
  let bucket = crossUserReadBuckets.get(userId)
  if (!bucket || bucket.dayKey !== today) {
    bucket = { dayKey: today, distinct: new Set(), overruns: 0 }
    crossUserReadBuckets.set(userId, bucket)
  }
  // 已读过同一个 target 不再计数(distinct cap)
  if (!bucket.distinct.has(targetId)) bucket.distinct.add(targetId)
  const cap = CROSS_USER_READ_DAILY_CAP[level] ?? CROSS_USER_READ_DAILY_CAP.new
  const used = bucket.distinct.size
  if (used > cap) {
    bucket.overruns++
    return { ok: false, cap, used }
  }
  return { ok: true, cap, used }
}

// 2026-05-23 P0 audit fix 2.2：endpoint → action 映射（用于 declared_scope enforcement）
// 只对写操作 enforce；读操作不限制（任何 agent 都能读自己范围内的数据）
// RFC-011 §②:写边界分类器 + 敏感读 scope 已抽到 src/pwa/endpoint-actions.ts(声明式规则表,
//   同一份规则既 enforce(此处中间件迭代)又 publish(capabilityMatrix 端点),doc=code。
//   行为零变化由 tests/test-endpoint-actions.ts 锁定(420 组 path×method diff legacy)。
//   endpointToAction / endpointToReadAction 现从该模块 import(见文件顶部)。
function getDeclaredActions(apiKey: string): string[] | null {
  const row = db.prepare(`SELECT declared_scope FROM agent_declarations WHERE api_key = ? AND revoked_at IS NULL`).get(apiKey) as { declared_scope: string } | undefined
  if (!row) return null
  try {
    const scope = JSON.parse(row.declared_scope) as Record<string, unknown>
    const actions = scope.actions
    if (Array.isArray(actions)) return actions.filter((a): a is string => typeof a === 'string')
  } catch {}
  return null
}

// Phase 3c/3b：风险信息缓存(5min) — risk_score + 监护人是否真人(绑 Passkey)
const agentRiskCache = new Map<string, { risk: number; hasPasskey: boolean; until: number }>()
function getAgentRiskInfo(apiKey: string): { risk: number; hasPasskey: boolean } {
  const now = Date.now()
  const c = agentRiskCache.get(apiKey)
  if (c && c.until > now) return { risk: c.risk, hasPasskey: c.hasPasskey }
  let ownerId: string | undefined
  try {
    ownerId = (db.prepare(`SELECT user_id FROM agent_reputation WHERE api_key = ?`).get(apiKey) as { user_id: string } | undefined)?.user_id
      || (db.prepare(`SELECT id FROM users WHERE api_key = ?`).get(apiKey) as { id: string } | undefined)?.id
  } catch { /* ignore */ }
  if (!ownerId) return { risk: 0, hasPasskey: false }
  let risk = 0
  let hasPasskey = false
  try { risk = computeAgentPassport(db, apiKey, ownerId, () => '').risk_score } catch { /* never break the request */ }
  try { hasPasskey = (((db.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?`).get(ownerId) as { n: number } | undefined)?.n) || 0) > 0 } catch { /* ignore */ }
  agentRiskCache.set(apiKey, { risk, hasPasskey, until: now + 5 * 60 * 1000 })
  return { risk, hasPasskey }
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  // 不限制读 / 心跳 / 公开列表
  if (req.method === 'GET' && /^\/api\/(info|leaderboard|payment-methods|governance|openapi)/.test(req.path)) return next()
  const apiKey = req.headers.authorization?.replace('Bearer ', '')
  if (!apiKey) return next()  // 无 key 走原 IP 速率
  // 2026-05-23 P1 fix：被封禁用户仍可走以下路径（看自己 agent 状态 + 申诉）
  // - GET /api/me/agents 系列（看强 / 申诉前必查）
  // - POST /api/me/agents/strikes/:id/appeal（申诉权不能被封禁阻断）
  if (/^\/api\/me\/agents(\/|$)/.test(req.path) && (req.method === 'GET' || /\/strikes\/\d+\/appeal$/.test(req.path))) {
    return next()
  }
  // 撤销 / strike 检查
  const blk = isApiKeyBlocked(apiKey)
  if (blk.blocked) return void res.status(403).json({ error: blk.reason, error_code: 'AGENT_BLOCKED' })
  // 2026-05-23 P0 fix 2.2 + Phase 3d（D2b）+ Phase 3b（B1）：declared_scope 强制
  // 模型：真人(绑 Passkey)=豁免，不施加任何 agent 约束；agent(无 Passkey)=必须声明且按声明约束。
  //   · D2b 无声明=只读：映射写动作 + 无声明 + 非真人 → 拒绝（声明/绑 Passkey/申诉端点不在映射表，天然豁免）
  //   · B1 声明者读约束：有声明且非通配 → 读(敏感)写都按 declared_scope.actions 约束
  const declaredActions = getDeclaredActions(apiKey)         // null = 未声明
  const riskInfo = getAgentRiskInfo(apiKey)                  // {risk, hasPasskey} — 5min 缓存，复用于 3c/3b
  const action = endpointToAction(req.method, req.path)       // 写动作 token
  const readAction = req.method === 'GET' ? endpointToReadAction(req.path) : null  // B1 敏感读 token
  const scopeToken = action || readAction

  // D2b：无声明 agent 只读。映射写 + 无声明 + 无 Passkey(非真人) → 拒绝，给两条解除路径
  if (action && declaredActions === null && !riskInfo.hasPasskey) {
    return void res.status(403).json({
      error: '写操作需问责：请绑定 Passkey（成为真人）或为该 agent 声明 scope 后再操作',
      error_code: 'AGENT_SCOPE_UNDECLARED', action,
    })
  }
  // 声明者约束（B1 读 + 写）：有声明且非通配 '*' → 必须在声明范围内
  if (scopeToken && declaredActions && !declaredActions.includes('*') && !declaredActions.includes(scopeToken)) {
    return void res.status(403).json({
      error: `agent 已声明只能做 ${declaredActions.join('/')}，禁止 ${scopeToken}`,
      error_code: 'AGENT_SCOPE_DENIED',
      action: scopeToken, declared_actions: declaredActions,
    })
  }

  if (action) {
    // 2026-05-23 P1 fix 2.4：mass-action 日 cap（按 trust level）
    const repRowForCap = db.prepare(`SELECT level FROM agent_reputation WHERE api_key = ?`).get(apiKey) as { level: string } | undefined
    const lvlForCap = repRowForCap?.level || 'new'
    const capCheck = checkMassActionCap(apiKey, action, lvlForCap)
    if (!capCheck.ok) {
      return void res.status(429).json({
        error: `${action} 已达今日上限 ${capCheck.cap}（${lvlForCap} 级）`,
        error_code: 'AGENT_DAILY_CAP',
        action, cap: capCheck.cap, used: capCheck.used, level: lvlForCap,
      })
    }
    // Phase 3c：风险闸 — 高风险 agent 敏感写降速/暂停(只罚高风险,无责零成本)
    const agentRisk = riskInfo.risk
    if (agentRisk >= 100) {
      return void res.status(403).json({
        error: 'agent 风险分已达上限，敏感操作已暂停 — 请在「我的 Agents」查看并申诉',
        error_code: 'AGENT_RISK_SUSPENDED', action, risk: agentRisk,
      })
    }
    if (agentRisk >= 70) {
      res.setHeader('Retry-After', '30')
      return void res.status(429).json({
        error: `agent 风险分偏高(${agentRisk}/100)，敏感操作已降速，请 30 秒后重试`,
        error_code: 'AGENT_RISK_THROTTLED', action, risk: agentRisk,
      })
    }
  }
  // Phase 3b：敏感读降速 — 高风险且监护人未绑 Passkey(非真人背书)的 agent,读也降速
  // 真人监护人(绑 Passkey) + 低风险 完全豁免;/me/agents 申诉路径已在上方放行
  if (req.method === 'GET' && riskInfo.risk >= 70 && !riskInfo.hasPasskey) {
    res.setHeader('Retry-After', '30')
    return void res.status(429).json({
      error: `agent 风险分偏高(${riskInfo.risk}/100)且监护人未绑定 Passkey，读取已降速 — 绑定 Passkey(成为真人监护人)即解除`,
      error_code: 'AGENT_RISK_READ_THROTTLED', risk: riskInfo.risk,
    })
  }
  // #1043(补 A) 跨用户读日 cap — 真人也罩;只对路径里显式带 other user id 的 GET 计数
  // P0-2 优化:先 regex 快判 path 命中(零开销),命中才查 owner.id + level — 避免每 GET 跑 SQLite
  // P1-4 修:正则允许 /api/users/:id 无 trailing slash(GET /api/users/:user_id 是返回用户档案的合法端点)
  if (req.method === 'GET' && /^\/api\/users\/[^/?#]+/.test(req.path)) {
    const owner = db.prepare(`SELECT id FROM users WHERE api_key = ?`).get(apiKey) as { id: string } | undefined
    if (owner) {
      const target = extractCrossUserTarget(req.path, owner.id)
      if (target) {
        const lvl = riskInfo.hasPasskey
          ? 'passkey_human'
          : ((db.prepare(`SELECT level FROM agent_reputation WHERE api_key = ?`).get(apiKey) as { level: string } | undefined)?.level || 'new')
        const cr = checkCrossUserReadCap(owner.id, target, lvl)
        if (!cr.ok) {
          res.setHeader('Retry-After', '600')
          return void res.status(429).json({
            error: `今日跨用户读已达上限 ${cr.cap}(${lvl})。改天再来,或为该 agent 收窄 declared_scope`,
            error_code: 'CROSS_USER_READ_DAILY_CAP',
            cap: cr.cap, used: cr.used, level: lvl,
          })
        }
      }
    }
  }
  // 分档 rate limit
  const repRow = db.prepare(`SELECT level FROM agent_reputation WHERE api_key = ?`).get(apiKey) as { level: string } | undefined
  const level = repRow?.level || 'new'
  const cap = getAgentRateCap(level)
  const now = Date.now()
  let bucket = agentRateBuckets.get(apiKey)
  if (!bucket || now - bucket.windowStart >= 60_000) {
    bucket = { windowStart: now, count: 0 }
    agentRateBuckets.set(apiKey, bucket)
  }
  bucket.count++
  if (bucket.count > cap) {
    // 2026-05-23 P0 fix 2.3：30 分钟内 ≥10 次 429 → 自动 warning strike
    // 用 agent_call_log 反查 30min 内 429 次数（trust 计算也用同一信号）
    const recent429 = (db.prepare(`SELECT COUNT(*) as n FROM agent_call_log
      WHERE api_key = ? AND status_code = 429 AND created_at > datetime('now', '-30 minutes')`)
      .get(apiKey) as { n: number }).n
    if (recent429 === 10) {  // 整数等于 — 防每次都触发 strike
      const u = db.prepare(`SELECT id FROM users WHERE api_key = ?`).get(apiKey) as { id: string } | undefined
      if (u) issueAgentStrike({
        apiKey, userId: u.id, reasonCode: 'rate_limit_abuse',
        reasonDetail: `30min 内 ≥10 次 429`,
      })
    }
    return void res.status(429).json({
      error: `agent 调用过频：${level} 级每分钟 ${cap} 次上限`,
      error_code: 'AGENT_RATE_LIMITED',
      level, cap, window_seconds_left: Math.ceil((60_000 - (now - bucket.windowStart)) / 1000),
    })
  }
  next()
})

// express.static は API ルートの後で登録する（順番が重要）

// ─── SSE 连接池（userId → Response）──────────────────────────
const sseClients = new Map<string, Response>()

// Wave F-5: 实时事件 stream — 全局环形缓冲 + admin SSE 推流
type SystemEvent = { ts: string; type: string; icon: string; summary: string; ref_id?: string | null }
const systemEventBuffer: SystemEvent[] = []
const SYSTEM_EVENT_BUFFER_SIZE = 200
const adminEventClients = new Set<Response>()

export function broadcastSystemEvent(type: string, icon: string, summary: string, refId?: string | null) {
  const evt: SystemEvent = { ts: new Date().toISOString(), type, icon, summary, ref_id: refId || null }
  systemEventBuffer.push(evt)
  if (systemEventBuffer.length > SYSTEM_EVENT_BUFFER_SIZE) {
    systemEventBuffer.splice(0, systemEventBuffer.length - SYSTEM_EVENT_BUFFER_SIZE)
  }
  for (const client of adminEventClients) {
    try { client.write(`data: ${JSON.stringify(evt)}\n\n`) } catch {}
  }
}

setPushCallback((userId: string, notif: Notification) => {
  const client = sseClients.get(userId)
  if (client) {
    try { client.write(`data: ${JSON.stringify(notif)}\n\n`) } catch {}
  }
})

// ─── Auth 中间件 ──────────────────────────────────────────────

function getUser(req: Request) {
  const key = req.headers.authorization?.replace('Bearer ', '') ?? (req.body?.api_key as string)
  if (!key) return null
  return db.prepare('SELECT * FROM users WHERE api_key = ?').get(key) as Record<string, unknown> | null
}

function recordSession(userId: string, apiKey: string, req: Request): string {
  // trust proxy 已配置：req.ip 为反伪造后的真实客户端 IP（本地开发 ::1 / 127.0.0.1）
  const ip = req.ip || ''
  const ua = String(req.headers['user-agent'] || '').slice(0, 300)
  // fingerprint = sha256(ua + accept-language) — 用于轻量异常检测
  const lang = String(req.headers['accept-language'] || '').slice(0, 50)
  const fp = createHash('sha256').update(ua + '|' + lang).digest('hex').slice(0, 32)
  const sid = generateId('ses')
  db.prepare(`INSERT INTO user_sessions (id, user_id, api_key, ip, user_agent, fingerprint_hash)
              VALUES (?,?,?,?,?,?)`).run(sid, userId, apiKey, ip, ua, fp)
  return sid
}

// Wave H-1 P1-1: 失败 auth 速率限制（per-IP 滑动窗口）
const authFailures = new Map<string, { count: number; firstFailAt: number }>()
const AUTH_FAIL_WINDOW_MS = 10 * 60_000  // 10 分钟
const AUTH_FAIL_THRESHOLD = 30           // 10 分钟内同 IP 失败 30 次封禁
function authFailIp(req: Request): boolean {
  const ip = req.ip || ''
  if (!ip) return false
  const now = Date.now()
  const rec = authFailures.get(ip)
  if (rec) {
    if (now - rec.firstFailAt > AUTH_FAIL_WINDOW_MS) {
      authFailures.set(ip, { count: 1, firstFailAt: now })
      return false
    }
    rec.count++
    if (rec.count > AUTH_FAIL_THRESHOLD) return true
  } else {
    authFailures.set(ip, { count: 1, firstFailAt: now })
  }
  // 定期清理过期项（每 1000 次失败一次）
  if (authFailures.size > 1000) {
    for (const [k, v] of authFailures) if (now - v.firstFailAt > AUTH_FAIL_WINDOW_MS) authFailures.delete(k)
  }
  return false
}

function auth(req: Request, res: Response): Record<string, unknown> | null {
  const user = getUser(req)
  if (!user) {
    if (authFailIp(req)) {
      res.status(429).json({ error: '失败次数过多，请 10 分钟后再试', error_code: 'AUTH_RATE_LIMITED' })
      return null
    }
    res.status(401).json({ error: '请先登录' })
    return null
  }
  const mod = db.prepare("SELECT suspended, reason FROM user_moderation WHERE user_id = ?")
    .get(user.id) as { suspended: number; reason: string | null } | undefined
  if (mod?.suspended) {
    res.status(403).json({ error: `账户已被暂停${mod.reason ? `：${mod.reason}` : ''}` })
    return null
  }
  // 会话追踪 + 吊销检查（兼容老用户：无 session 行 → 即时补建）
  const key = req.headers.authorization?.replace('Bearer ', '') ?? (req.body?.api_key as string) ?? ''
  if (key) {
    const session = db.prepare("SELECT id, revoked_at FROM user_sessions WHERE api_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(key) as { id: string; revoked_at: string | null } | undefined
    if (session?.revoked_at) {
      res.status(401).json({ error: '该会话已被远程登出，请重新登录' })
      return null
    }
    if (session) {
      db.prepare("UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?").run(session.id)
    } else {
      // 兼容：老 api_key 没 session 行 → 即时补建（避免破坏现有用户）
      try { recordSession(user.id as string, key, req) } catch {}
    }
  }
  return user
}

function requireAdmin(req: Request, res: Response): Record<string, unknown> | null {
  const user = auth(req, res); if (!user) return null
  const rolesList = (() => { try { return JSON.parse(user.roles as string || '[]') as string[] } catch { return [] } })()
  if (user.role !== 'admin' && !rolesList.includes('admin')) {
    res.status(403).json({ error: '仅限管理员访问' })
    return null
  }
  return user
}

// Admin 分级 helpers
const ADMIN_SCOPE_VALUES = ['global', 'china', 'us', 'eu', 'india', 'singapore', 'global_north', 'global'] as const
const ADMIN_PERMISSIONS = ['users', 'content', 'arbitration', 'protocol', 'verifier_mgmt', 'support'] as const
type AdminPermission = typeof ADMIN_PERMISSIONS[number] | 'all'

function isRootAdmin(user: Record<string, unknown>): boolean {
  return (user.admin_type as string || 'root') === 'root'
}
function getAdminScope(user: Record<string, unknown>): string {
  return (user.admin_scope as string) || 'global'
}
function getAdminPermissions(user: Record<string, unknown>): string[] {
  // root 隐式拥有 all；regional 看 admin_permissions JSON 字段；无字段=空
  if (isRootAdmin(user)) return ['all']
  try { return JSON.parse((user.admin_permissions as string) || '[]') } catch { return [] }
}
function hasAdminPermission(user: Record<string, unknown>, perm: AdminPermission): boolean {
  if (isRootAdmin(user)) return true
  const perms = getAdminPermissions(user)
  return perms.includes('all') || perms.includes(perm)
}
function requireRootAdmin(req: Request, res: Response): Record<string, unknown> | null {
  const user = requireAdmin(req, res); if (!user) return null
  if (!isRootAdmin(user)) {
    res.status(403).json({ error: '仅根管理员可执行此操作（区域管理员无权创建/管理 admin）' })
    return null
  }
  return user
}
function requireAdminPermission(req: Request, res: Response, perm: AdminPermission): Record<string, unknown> | null {
  const user = requireAdmin(req, res); if (!user) return null
  if (!hasAdminPermission(user, perm)) {
    res.status(403).json({ error: `权限不足：需要 "${perm}" 权限（你当前是 regional admin，请联系 root 调整权限）` })
    return null
  }
  return user
}

// 检查 admin 是否可操作目标 user（按 admin_scope 边界）
// root 可操作任何人；regional 仅能操作 region === scope 的用户
function adminCanOperateOn(admin: Record<string, unknown>, targetUserId: string, res: Response): boolean {
  if (isRootAdmin(admin)) return true
  const scope = getAdminScope(admin)
  if (scope === 'global') return true
  const target = db.prepare(`SELECT region, admin_type FROM users WHERE id = ?`).get(targetUserId) as { region: string; admin_type: string } | undefined
  if (!target) { res.json({ error: '用户不存在' }); return false }
  // regional admin 永远不能操作其他 admin（无论同区还是跨区）
  if (target.admin_type) { res.status(403).json({ error: '区域 admin 不可操作其他 admin（仅 root 可）' }); return false }
  if (target.region && target.region !== scope) {
    res.status(403).json({ error: `区域 admin (${scope}) 不可操作其他区域 (${target.region}) 的用户` })
    return false
  }
  return true
}
// 启动 migration：legacy admins (admin_type IS NULL) → root + global
try {
  db.prepare(`UPDATE users SET admin_type = 'root', admin_scope = 'global' WHERE role = 'admin' AND admin_type IS NULL`).run()
} catch (e) { console.warn('[admin migration]', (e as Error).message) }

function logAdminAction(adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) {
  db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
    .run(generateId('audit'), adminId, action, targetType, targetId, detail ? JSON.stringify(detail) : null)
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

// Agent 友好的错误响应：4xx + error_code 机器字段 + 人类可读 error 消息
// （Wave 2 audit P1 fix — agent 看 HTTP 状态判错误，看 error_code 程序分支）
function errorRes(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: message, error_code: code, ...(extra || {}) })
}

// 安全解析 user.roles JSON 列 — 防单条脏数据封死整个认证链路
// （Wave 2 audit P1 fix）
function safeRoles(user: Record<string, unknown> | undefined | null): string[] {
  if (!user) return []
  try {
    const parsed = JSON.parse((user.roles as string) || '[]')
    if (Array.isArray(parsed)) return parsed as string[]
  } catch {}
  const r = user.role as string | undefined
  return r ? [r] : []
}

// 受信角色（admin/verifier）禁止参与交易 / 持钱包 —— 用户铁律
function isTrustedRole(user: Record<string, unknown> | undefined | null): boolean {
  if (!user) return false
  const roles = safeRoles(user)
  const r = (user.role as string) || ''
  return r === 'admin' || r === 'verifier' || roles.includes('admin') || roles.includes('verifier')
}

// ─── API 路由 ─────────────────────────────────────────────────

// #1013 Phase 118: register 已迁出（VALID_REGIONS 在下方 const → 用 getter 避免 TDZ）
registerAuthRegisterRoutes(app, {
  db, errorRes, INTERNAL_AUDITOR_ID,
  isAllowedSponsor, resolveUserRef, resolveInviteCodeRef,
  generateId, generateSecureKey, generatePermanentCode, deriveHandle,
  clientIpHash, clientUaHash,
  get VALID_REGIONS() { return VALID_REGIONS },
  pickPreferredSide, joinPowerLeg,
  // 邮箱验证优先注册 — issueCode/findActiveCode 是 hoisted 函数声明、isVerificationEmailReady/
  // emailDeliveryNotConfigured 是 import,均可在此安全引用;CODE_TTL_MIN/MAX_CODE_ATTEMPTS 是后置 const,
  // 走 getter 延迟读避免 TDZ。
  issueCode, findActiveCode, canDeliverCodes: isVerificationEmailReady, emailDeliveryNotConfigured,
  get CODE_TTL_MIN() { return CODE_TTL_MIN },
  get MAX_CODE_ATTEMPTS() { return MAX_CODE_ATTEMPTS },
  recordSession, broadcastSystemEvent,
})

// #1013 Phase 116: me + profile 已迁出
registerAuthReadRoutes(app, {
  db, auth, safeRoles, getRegionMaxLevels, userMlmGate, getUserLevel,
})

// #1013 Phase 108: agents/me/reputation + admin/agents/:api_key/reputation 已迁出
// getter for RAW_MODE_MIN_TRUST — 下方 const，避免 TDZ
registerAgentReputationRoutes(app, {
  auth, getAgentTrustCached,
  getRawModeMinTrust: () => RAW_MODE_MIN_TRUST,
})

// #1013 Phase 47: 6 公开用户主页 endpoints 已迁出到 routes/users-public.ts
registerUsersPublicRoutes(app, { db, auth, noteAuthenticityBadges })

// RFC-004 build_feedback — agent-native "use → build" 反馈管道
registerBuildFeedbackRoutes(app, {
  db, auth,
  requireSupportAdmin: (req, res) => requireAdminPermission(req, res, 'support'),
})

// RFC-006 Gap 1:协调层(build_tasks "谁在做什么")
registerBuildTasksRoutes(app, {
  db, auth,
  requireSupportAdmin: (req, res) => requireAdminPermission(req, res, 'support'),
})

// PR9C-1 — public Task Board read surface(无需登录;仅 audience=public + status=open;只读,带 value_boundary)
registerPublicBuildTasksRoutes(app, { db, errorRes })

// Task Proposal Inbox v1 — public submit(匿名,validated,限流+去重)+ admin review;建议入收件箱,绝不自动成正式任务/上公开板
const proposalRateLimiter = createSlidingWindowLimiter(20, 3600_000)   // 20 submissions / hour / IP
registerTaskProposalsRoutes(app, {
  db, errorRes,
  requireSupportAdmin: (req, res) => requireAdminPermission(req, res, 'support'),
  rateLimitOk: (key) => proposalRateLimiter(key),
  auth,                          // required auth for proposer-facing /api/me/task-proposals
  resolveUser: (req) => getUser(req),   // optional resolver — links a submission to the logged-in submitter
})

// PR #18 — build_task create quota-increase requests(requester submit + ROOT-only review/approve/reject/revoke)
registerBuildTaskQuotaRoutes(app, {
  db, errorRes, auth,
  requireRootAdmin: (req, res) => requireRootAdmin(req, res),
})

// Phase 2 — admin operator-claim workflow: link an admin SEAT → a real contributor account
// (propose → confirm → approve → revoke/supersede). Claim workflow only; writes NO contribution_facts.
registerAdminOperatorClaimRoutes(app, {
  db, errorRes, auth,
  requireAdmin: (req, res) => requireAdmin(req, res),
  requireRootAdmin: (req, res) => requireRootAdmin(req, res),
  consumeGateToken,   // unlink REQUEST requires a fresh passkey gate (purpose 'operator_claim_unlink')
})

// RFC-006 Gap 2:贡献者自查看板(build_reputation 独立池)
registerBuildReputationRoutes(app, { db, auth })

// PR-F3c — 最小 GitHub 身份认领 API(发起挑战 → Passkey 人门 + WebAZ 自验 gist → F2 原子认领)。
// GitHub 读 token 仅来自可信服务端配置;未配置则 completion fail-closed(不做匿名限流读)。
registerContributionIdentityRoutes(app, {
  auth,
  requireHumanPresence,
  errorRes,
  getGithubReadToken: () => process.env.GITHUB_CONTRIB_READ_TOKEN || undefined,
})

// PR5F — Contribution Score v1 evidence READ surface (logged-in self-view; read-only, no score).
// Returns the caller's OWN component evidence wrapped in the PR5A uncommitted-value boundary.
registerContributionScoreRoutes(app, { auth, errorRes })

// Contribution read-out V1 — the caller's OWN attributable facts (GitHub + admin coordination), grouped
// by source, read-only, wrapped in the uncommitted-value boundary. Attribution is read-time (GitHub
// binding overlay + operator-claim as-of); writes nothing, no reward/payout.
registerContributionFactsRoutes(app, { db, auth, errorRes })

// #1013 Phase 48: 3 auth/sessions endpoints 已迁出到 routes/auth-sessions.ts
registerAuthSessionsRoutes(app, { db, auth, verifyPassword, recordSession, generateSecureKey })

// 个人资料：查看 API Key + 联系方式
// ─── 2026-05-22 COP P0-3：治理 Phase A — 协议参数公示（公开端点，不需 auth）─────
// VISION 团队自约束：'不抽 hidden fee — 所有费率写 protocol_params 公开'
// 任何人都能查协议当前参数 + 完整变更历史
// ─── 治理参数 + 支付方法 ───────────────────────────────────
// #1013 Phase 14: 13 endpoints 已迁出到 routes/payments-governance.ts
registerPaymentsGovernanceRoutes(app, {
  db, generateId,
  requireRootAdmin: (req, res) => requireRootAdmin(req, res),
})

// ─── 2026-05-22 COP P0-2：账号注销 + 数据擦除（GDPR / 个保法）────
// 流程：
// 1. POST /api/me/delete-request → 软删除（feed_visible=0 + deleted_requested_at）
//    7 天冷却期内可撤销
// 2. cron 7 天后 status='soft_deleted'，再 7 天后真正擦 PII（手机/邮箱/handle/name 改 anon）
// 3. 笔记/订单 commission audit 等公共物品保留，作者改 'anon_<random>'
db.exec(`
  CREATE TABLE IF NOT EXISTS account_deletion_requests (
    user_id        TEXT PRIMARY KEY,
    requested_at   TEXT DEFAULT (datetime('now')),
    cancelled_at   TEXT,
    pii_wiped_at   TEXT,
    reason         TEXT
  )
`)
try { db.exec("ALTER TABLE users ADD COLUMN deleted_requested_at TEXT") } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT") } catch {}

// 账号注销 (#1013 Phase 37) — 3 endpoints 已迁出到 routes/account-deletion.ts
registerAccountDeletionRoutes(app, { db, auth })

// ─── 2026-05-23 Agent 治理（spec §6 用户控制 + admin 审核）────
// #1013 Phase 38: 10 endpoints (7 user + 3 admin) 已迁出到 routes/agent-governance.ts
registerAgentGovernanceRoutes(app, {
  db, generateId, auth,
  requireRootAdmin: (req, res) => requireRootAdmin(req, res),
  invalidateAgentBlockedCache,
  requireHumanPresence,
  issueAgentStrike,
  // 监护人指纹：HMAC(MASTER_SEED) over owner id — 可追溯(协议持 seed)不暴露身份
  custodianFingerprint: (ownerId: string) => createHmac('sha256', MASTER_SEED).update('custodian:' + ownerId).digest('hex').slice(0, 16),
  // Phase 4 护照签名：用协议热钱包私钥签(eip191),issuer 地址 = DID 锚点,任何人 ecrecover 可验(闭包→调用时求值,晚于热钱包初始化)
  signPassport: (message: string) => walletSigner.issuerSignMessage(message),
  issuerAddress: () => walletSigner.issuerAddress(),
})

// ─── 2026-05-22 COP 飞轮 + COP P0-1 数据导出 ─────────────
// #1013 Phase 39: 2 endpoints (note-prompts + export) 已迁出到 routes/me-data.ts
registerMeDataRoutes(app, { db, auth })

// cron 任务：真正擦除（14 天后 PII，注销条件不再持有公共物品的所有权）
function processAccountDeletions(): { wiped: number } {
  const candidates = db.prepare(`
    SELECT user_id FROM account_deletion_requests
    WHERE cancelled_at IS NULL AND pii_wiped_at IS NULL
      AND datetime(requested_at) < datetime('now', '-14 days')
    LIMIT 100
  `).all() as Array<{ user_id: string }>
  let wiped = 0
  for (const c of candidates) {
    try {
      // 笔记/订单作者匿名化（保留公共物品）
      const anon = 'anon_' + Math.random().toString(36).slice(2, 8)
      db.prepare(`UPDATE users SET name = ?, handle = NULL, email = NULL, phone = NULL, bio = NULL, search_anchor = NULL, deleted_at = datetime('now'), feed_visible = 0 WHERE id = ?`).run(anon, c.user_id)
      // #1017 fix: 实际表是 user_addresses，列名是 recipient/phone（不带 _name/_phone 后缀）
      db.prepare(`UPDATE user_addresses SET recipient = '[已注销]', phone = '[已注销]', detail = '[已注销]' WHERE user_id = ?`).run(c.user_id)
      db.prepare(`UPDATE account_deletion_requests SET pii_wiped_at = datetime('now') WHERE user_id = ?`).run(c.user_id)
      wiped++
    } catch (e) { console.warn('[deletion]', c.user_id, (e as Error).message) }
  }
  return { wiped }
}

// profile — Phase 116 已迁出

// 添加角色
// 自助添加角色（仅 buyer / seller；其他角色需走申请流程）
// 受信角色：不能自助添加任何其他角色（含 buyer/seller）
// 理由：权责分离；admin 不应同时持有 buyer/seller 身份避免利益冲突；verifier 同理（审核员不能自买自卖自审）
// #1013 Phase 59: 5 profile-identity endpoints 已迁出 — VALID_REGIONS 留 server.ts（注册流程也用）
const VALID_REGIONS = new Set(['china', 'us', 'eu', 'india', 'singapore', 'global_north', 'global'])
registerProfileIdentityRoutes(app, { db, generateId, auth, safeRoles })

// ─── 密码层（P2）─────────────────────────────────────────────
// scrypt hash 格式：scrypt:{salt_hex}:{hash_hex}
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const
const SCRYPT_KEY_LEN = 64
const LOCKOUT_THRESHOLD = 5
const LOCKOUT_MINUTES = 15

function hashPassword(plain: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(plain, salt, SCRYPT_KEY_LEN, SCRYPT_PARAMS)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  const actual = scryptSync(plain, salt, expected.length, SCRYPT_PARAMS)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function isLocked(user: Record<string, unknown>): boolean {
  const lu = user.locked_until as string | null
  return !!lu && new Date(lu).getTime() > Date.now()
}

function recordFailure(userId: string, prevAttempts: number) {
  const attempts = prevAttempts + 1
  const lockedUntil = attempts >= LOCKOUT_THRESHOLD
    ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
    : null
  db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
    .run(attempts, lockedUntil, userId)
}

function resetFailures(userId: string) {
  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(userId)
}

// #1013 Phase 117: login 已迁出
registerAuthLoginRoutes(app, {
  db, INTERNAL_AUDITOR_ID,
  isLocked, verifyPassword, recordFailure, resetFailures, recordSession,
})

// ─── 邮箱绑定 / 找回密钥（P1）─────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_TTL_MIN = 10
const MAX_CODE_ATTEMPTS = 5

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

async function deliverCode(target: string, code: string, purpose: string) {
  return deliverVerificationCode({ target, code, purpose, ttlMin: CODE_TTL_MIN })
}

async function issueCode(userId: string, channel: string, target: string, purpose: string): Promise<IssueCodeResult> {
  if (channel === 'email' && !isVerificationEmailReady()) return emailDeliveryNotConfigured()
  const id = generateId('vcode')
  const code = genCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString()
  db.prepare(`INSERT INTO verification_codes (id, user_id, channel, target, code, purpose, expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, userId, channel, target, code, purpose, expiresAt)
  const delivered = await deliverCode(target, code, purpose)
  if (!delivered.ok) {
    try { db.prepare("UPDATE verification_codes SET used_at = datetime('now') WHERE id = ?").run(id) } catch {}
    return delivered
  }
  return { ok: true, code, expires_at: expiresAt, provider: delivered.provider }
}

function findActiveCode(channel: string, target: string, purpose: string) {
  return db.prepare(`
    SELECT * FROM verification_codes
    WHERE channel = ? AND target = ? AND purpose = ?
      AND used_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(channel, target, purpose) as Record<string, unknown> | undefined
}

// #1013 Phase 49: 3 recover-key endpoints 已迁出到 routes/recover-key.ts
registerRecoverKeyRoutes(app, {
  db, internalAuditorId: INTERNAL_AUDITOR_ID,
  issueCode, findActiveCode, canDeliverCodes: isVerificationEmailReady,
  emailDeliveryNotConfigured, hashPassword, CODE_TTL_MIN, MAX_CODE_ATTEMPTS,
})

// #1013 Phase 55: 5 profile-credentials endpoints 已迁出到 routes/profile-credentials.ts
registerProfileCredentialsRoutes(app, {
  db, auth, verifyPassword, hashPassword,
  issueCode, findActiveCode, MAX_CODE_ATTEMPTS,
})

// 搜索商品（声誉权重排序）
// 构建 agent_summary：一句话决策摘要
function buildAgentSummary(p: Record<string, unknown>): string {
  const parts: string[] = []
  if (p.brand)         parts.push(String(p.brand))
  if (p.model)         parts.push(String(p.model))
  const returnDays = p.return_days != null ? Number(p.return_days) : null
  if (returnDays != null && returnDays > 0) parts.push(`${returnDays}天退货`)
  else if (returnDays === 0)               parts.push('不支持退货')
  const warranty = p.warranty_days != null ? Number(p.warranty_days) : null
  if (warranty && warranty > 0)            parts.push(`${warranty}天质保`)
  const handling = p.handling_hours != null ? Number(p.handling_hours) : null
  if (handling != null)                    parts.push(`${handling}h发货`)
  const est = p.estimated_days
  if (est) {
    const estParsed = typeof est === 'string' ? (() => { try { return JSON.parse(est) } catch { return est } })() : est
    if (typeof estParsed === 'object' && estParsed !== null) {
      const vals = Object.values(estParsed as Record<string, unknown>).map(Number).filter(n => !isNaN(n))
      if (vals.length) parts.push(`全国${Math.min(...vals)}-${Math.max(...vals)}天`)
    } else if (typeof estParsed === 'number') {
      parts.push(`全国约${estParsed}天`)
    } else {
      parts.push(`时效:${String(estParsed)}`)
    }
  }
  if (p.ship_regions && p.ship_regions !== '全国') parts.push(`发货:${p.ship_regions}`)
  if (p.fragile) parts.push('易碎品')
  return parts.join('，') || '暂无物流信息'
}

// 格式化商品行为 agent 友好结构
// S3：从 Accept-Language 头解析买家偏好语言（zh / en / ja / ko 等）
// 默认 zh（中文为协议原始数据）
function pickLang(req: Request | undefined): string {
  if (!req) return 'zh'
  const h = String(req.headers['accept-language'] || '').toLowerCase()
  if (h.startsWith('en')) return 'en'
  if (h.startsWith('ja')) return 'ja'
  if (h.startsWith('ko')) return 'ko'
  if (h.startsWith('zh')) return 'zh'
  return 'zh'
}

function formatProductForAgent(p: Record<string, unknown>, req?: Request): Record<string, unknown> {
  const specsRaw = p.specs
  let specs: Record<string, string> | null = null
  if (specsRaw) {
    try { specs = JSON.parse(specsRaw as string) } catch { specs = null }
  }
  const estRaw = p.estimated_days
  let estimated_days: Record<string, number> | number | null = null
  if (estRaw) {
    try { estimated_days = JSON.parse(estRaw as string) } catch { estimated_days = null }
  }
  // S4：origin_claims JSON 解析
  const ocRaw = p.origin_claims
  let origin_claims: Record<string, unknown> | null = null
  if (ocRaw) {
    try { origin_claims = JSON.parse(ocRaw as string) } catch { origin_claims = null }
  }
  // S3：多语言文案 swap — 仅 buyer lang 非 zh 时尝试替换；缺失则回落原 title/description
  const lang = pickLang(req)
  let title = p.title as string
  let description = p.description as string
  let i18n_titles: Record<string, string> | null = null
  let i18n_descs: Record<string, string> | null = null
  if (p.i18n_titles) {
    try { i18n_titles = JSON.parse(p.i18n_titles as string) } catch {}
  }
  if (p.i18n_descs) {
    try { i18n_descs = JSON.parse(p.i18n_descs as string) } catch {}
  }
  if (lang !== 'zh') {
    if (i18n_titles && i18n_titles[lang]) title = i18n_titles[lang]
    if (i18n_descs && i18n_descs[lang]) description = i18n_descs[lang]
  }
  return {
    ...p,
    title, description,
    specs,
    estimated_days,
    origin_claims,
    i18n_titles, i18n_descs,
    _lang: lang,
    agent_summary: buildAgentSummary(p),
  }
}

// ─── Tier 7：角色感知 API 辅助函数 ─────────────────────────────
const PRODUCT_LIMITS = { pwa: 30, agent: 200, raw: 500 } as const
const VALID_SORTS = new Set(['trending', 'newest', 'rating', 'price_asc', 'price_desc', 'random', 'recommended', 'seller_win_rate'])
const VALID_PRODUCT_TYPES = new Set(['retail', 'wholesale', 'service', 'digital'])   // 里程碑 6
const RAW_MODE_MIN_TRUST = 30   // raw mode 门槛

function encodeProductCursor(score: number, id: string): string {
  return Buffer.from(`${score}:${id}`).toString('base64url')
}
function decodeProductCursor(c: string): { score: number; id: string } | null {
  try {
    const parts = Buffer.from(c, 'base64url').toString('utf8').split(':')
    if (parts.length !== 2) return null
    const score = Number(parts[0])
    if (!Number.isFinite(score)) return null
    return { score, id: parts[1] }
  } catch { return null }
}

// trending 分数表达式（也用作 cursor 排序键）。引用真实列以避免同 SELECT 层 alias 不可见的问题。
// 里程碑 5：阶梯式新鲜度（30/90/180 天）+ 14 天首单 boost
// 里程碑 6-d：季节性 lifecycle — 非应季 -10
const TRENDING_SCORE_EXPR = `ROUND(
  COALESCE(p.completion_count, 0) * 0.5
  + COALESCE(rs.total_points, 0) * 0.1
  + COALESCE(p.unique_sharer_count, 0) * 2.0
  + COALESCE(p.total_likes, 0) * 1.0    /* LIKE 系统：点赞累积权重 */
  + CASE
      WHEN p.last_sold_at IS NULL THEN 0
      WHEN julianday('now') - julianday(p.last_sold_at) < 30  THEN 10.0
      WHEN julianday('now') - julianday(p.last_sold_at) < 90  THEN 10.0 * (1 - (julianday('now') - julianday(p.last_sold_at) - 30) / 60.0)
      WHEN julianday('now') - julianday(p.last_sold_at) < 180 THEN -5.0
      ELSE -15.0
    END
  + CASE
      WHEN p.first_sold_at IS NOT NULL
           AND julianday('now') - julianday(p.first_sold_at) < 14
      THEN 5.0 ELSE 0 END
  + CASE
      WHEN pc.seasonal_months IS NULL OR pc.seasonal_months = '' THEN 0
      WHEN (',' || pc.seasonal_months || ',') LIKE ('%,' || CAST(CAST(strftime('%m', 'now') AS INTEGER) AS TEXT) || ',%') THEN 0
      ELSE -10.0
    END
  - COALESCE(p.dispute_loss_count, 0) * 5.0
, 4)`

// ─── 健康检查 / Liveness probe（LB + 监控用，不需 auth） ─────────
const SERVICE_START_MS = Date.now()
// #1013 Phase 107: health + mcp-telemetry + system-flags + editor-picks + manifest + error-report 已迁出
// 注意：register 在底部统一调用（generateManifest/logError 在下方定义，避免 TDZ）



// A2 黑名单 (#1013 Phase 32) — 5 endpoints 已迁出到 routes/blocklist.ts
registerBlocklistRoutes(app, { db, auth })

// ─── Wave A-1 + A-2: 心愿单 + Q&A ──────────────────────────
// #1013 Phase 15: 9 endpoints 已迁出到 routes/wishlist-qa.ts
registerWishlistQaRoutes(app, { db, generateId, auth, isTrustedRole, errorRes })

// ─── Wave A-3: 优惠券 ──────────────────────────────────────
// #1013 Phase 16: 5 endpoints + applyCouponToOrder 已迁出到 routes/coupons.ts
// 双签名 wrapper：orders 流程仍用 (code, sellerId, productId, totalAmount) 签名
const applyCouponToOrder = (couponCode: string, sellerId: string, productId: string, totalAmount: number) =>
  applyCouponToOrderRaw(db, couponCode, sellerId, productId, totalAmount)
registerCouponsRoutes(app, { db, generateId, auth, isTrustedRole, safeRoles, errorRes })

// ─── Wave A-4: 公告 ────────────────────────────────────────
// #1013 Phase 17: 4 endpoints 已迁出到 routes/announcements.ts
registerAnnouncementsRoutes(app, {
  db, generateId, auth, safeRoles,
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  isRootAdmin, getAdminScope, logAdminAction,
})

// ─── Wave B-1 Phase 1: 商品 variants CRUD ──────────────────
// #1013 Phase 18: 4 endpoints (POST/PATCH/DELETE/GET) + canonicalOptionsKey helper 已迁出
registerVariantsRoutes(app, { db, generateId, auth })

// ─── Wave C-2: 多收货地址簿 ──────────────────────────────
// #1013 Phase 19: 4 endpoints 已迁出到 routes/addresses.ts
registerAddressesRoutes(app, { db, generateId, auth, isTrustedRole, errorRes })

// ─── Wave C-3: 买家评价 / 评分 ──────────────────────────
// #1013 Phase 20: 8 endpoints + RATING_BLIND_DAYS + parseDim 已迁出到 routes/ratings.ts
registerRatingsRoutes(app, { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent })

// ─── Welcome 域端点 ─────────────────────────────────────────
// #1013 Phase 2: 7 endpoints + doUnsubscribe helper 已迁出到 src/pwa/routes/welcome.ts
registerWelcomeRoutes(app, {
  db, generateId, getUser, clientIpHash, clientUaHash,
  requireSupportAdmin: (req, res) => requireAdminPermission(req, res, 'support'),
})

// ─── Wave D-3: 客服 / 反馈通道 ─────────────────────────
// #1013 Phase 21: 7 endpoints + W7 ticket-thread 已迁出到 routes/feedback.ts
registerFeedbackRoutes(app, { db, generateId, auth, broadcastSystemEvent, detectFraud, anthropic })

// ─── Wave D-5: trusted 角色 KPI 仪表盘 ───────────────────
// #1013 Phase 22: 2 endpoints 已迁出到 routes/trusted-kpi.ts
registerTrustedKpiRoutes(app, { db, auth })

// ─── Wave D-4: 限时促销 ──────────────────────────────────
// #1013 Phase 23: 5 endpoints + getActiveFlashSale 已迁出到 routes/flash-sales.ts
registerFlashSalesRoutes(app, { db, generateId, auth, broadcastSystemEvent })

// ─── 2026-05-24 #979：测评免单 API ─────────────────────────
// 卖家创建/更新测评计划（一商品一活动）
// ─── 测评免单 (product trial campaigns) ─────────────────────
// #1013 Phase 3: 8 endpoints + admin run-eval + evaluateTrialClaims cron 已迁出到 src/pwa/routes/trial.ts
registerTrialRoutes(app, {
  db, generateId, auth, clientIpHash, clientUaHash,
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  logAdminAction,
})

// ─── Wave B-2: 预售 / waitlist ─────────────────────────────
// #1013 Phase 24: 5 endpoints 已迁出到 routes/waitlist.ts
registerWaitlistRoutes(app, { db, auth, isTrustedRole, errorRes })

// ─── Wave B-3: 退货请求 + W2 timeline + L3 物流取件 ──────
// #1013 Phase 25: 11 endpoints + executeReturnRefund + 2 constants 已迁出到 routes/returns.ts
registerReturnsRoutes(app, { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent, detectFraud })

// ─── Wave B-4 + C-5 + return-stats: 分析仪表盘 ──────────
// #1013 Phase 26: 3 endpoints 合并迁出到 routes/analytics.ts
registerAnalyticsRoutes(app, { db, auth })

// Buyer 预览（不消耗 uses_count）— 下单页查券是否可用
// #1013 Phase 104: coupons/preview + my-products + search-by-link + search-fuzzy + check-url 已迁出
registerSearchRoutes(app, {
  db, auth, applyCouponToOrder,
  extractUrlFromText, extractTitleFromText, parsePlatformUrl,
  searchByExternalLink, detectShareCommandFormat, formatProductForAgent,
})


// #1013 Phase 58: 3 profile-prefs endpoints (default-address / feed-visible / PATCH /api/profile) 已迁出
registerProfilePrefsRoutes(app, { db, auth })

// GET /api/products/:id — Phase 92 已迁出

// 价格历史 — 帮 buyer/agent 判断卖家是否底价倾销
// 数据来源：orders WHERE product_id = ? AND status = 'completed'
// 防 abuse：rate limit + buyer_id 永不返回



// ─── 话题 / 标签 API ─────────────────────────────────────
// #1013 Phase 50: 2 tags endpoints 已迁出到 routes/tags.ts
registerTagsRoutes(app, { db })


// my-products — Phase 104 已迁出

// products aliases 4 endpoints — Phase 89 已迁出
registerProductsAliasesRoutes(app, { db, auth, generateId, extractCandidateAliases })

// products meta 4 endpoints — Phase 90 已迁出
registerProductsMetaRoutes(app, { db, auth, generateId, rateLimitOk, flagNewAccountShareable, refreshProductSharerCount })

// products links 3 endpoints — Phase 91 已迁出
registerProductsLinksRoutes(app, { db, auth, generateId, extractUrlFromText, extractTitleFromText, parsePlatformUrl })

// products CRUD lighter 3 endpoints — Phase 92 已迁出
registerProductsCrudRoutes(app, { db, auth, errorRes, formatProductForAgent, retireAnchorsByTarget })

// products PUT 1 endpoint — Phase 93 已迁出
registerProductsUpdateRoutes(app, {
  db, auth, makeCommitmentHash, makeDescriptionHash, makePriceHash,
  notifyWaitlist,
  notifyWishlistPriceDrop: (productId, productTitle, oldPrice, newPrice) =>
    notifyWishlistPriceDrop(productId, productTitle, oldPrice, newPrice),
  checkStockAndMaybeDelist,
})

// products POST create 1 endpoint — Phase 94 已迁出
registerProductsCreateRoutes(app, {
  db, auth, generateId, checkSellerCanList, getStakeDiscount, VALID_PRODUCT_TYPES,
  parsePlatformUrl, makeCommitmentHash, makeDescriptionHash, makePriceHash,
})

// products GET list 1 endpoint — Phase 95 已迁出
registerProductsListRoutes(app, {
  db, getUser, VALID_PRODUCT_TYPES, RAW_MODE_MIN_TRUST, getAgentTrustCached,
  VALID_SORTS, PRODUCT_LIMITS, TRENDING_SCORE_EXPR,
  findProductsByAlias, decodeProductCursor, encodeProductCursor,
  MASTER_SEED, formatProductForAgent,
})


// search-by-link — Phase 104 已迁出

// search-fuzzy + check-url — Phase 104 已迁出

// ─── 众包验证任务引擎 ─────────────────────────────────────────

function getVerifierStats(userId: string) {
  let stats = db.prepare('SELECT * FROM verifier_stats WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined
  if (!stats) {
    db.prepare('INSERT OR IGNORE INTO verifier_stats (user_id) VALUES (?)').run(userId)
    stats = db.prepare('SELECT * FROM verifier_stats WHERE user_id = ?').get(userId) as Record<string, unknown>
  }
  return stats
}

function isEligibleVerifier(userId: string, taskId: string): { ok: boolean; reason?: string } {
  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!task) return { ok: false, reason: '任务不存在' }

  // 必须在白名单
  const wl = db.prepare('SELECT cooldown_until, is_system FROM verifier_whitelist WHERE user_id = ?').get(userId) as { cooldown_until: string | null; is_system: number } | undefined
  if (!wl) return { ok: false, reason: '不在审核员白名单' }

  // 撤销后冷却中
  if (wl.cooldown_until && new Date(wl.cooldown_until).getTime() > Date.now()) {
    return { ok: false, reason: '资格冷却期未结束' }
  }

  // 暂停中
  const stats = db.prepare('SELECT suspended_until FROM verifier_stats WHERE user_id = ?').get(userId) as { suspended_until: string | null } | undefined
  if (stats?.suspended_until && new Date(stats.suspended_until).getTime() > Date.now()) {
    return { ok: false, reason: '审核员资格已暂停' }
  }

  // 配额（系统兜底跳过）
  if (!wl.is_system) {
    resetDailyQuotaIfNeeded(userId)
    const q = db.prepare('SELECT tasks_today, daily_quota FROM verifier_whitelist WHERE user_id = ?').get(userId) as { tasks_today: number; daily_quota: number }
    if (q.daily_quota > 0 && q.tasks_today >= q.daily_quota) {
      return { ok: false, reason: '今日配额已用完' }
    }
  }

  // 不能是任务发布者（商品卖家）
  const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(task.product_id as string) as { seller_id: string } | undefined
  if (product?.seller_id === userId) return { ok: false, reason: '不能验证自己的商品链接' }

  // 未已领取
  const existing = db.prepare('SELECT id FROM verify_submissions WHERE task_id = ? AND verifier_id = ?').get(taskId, userId)
  if (existing) return { ok: false, reason: '已领取此任务' }

  return { ok: true }
}

function assignVerifiers(taskId: string) {
  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!task || task.status !== 'open') return

  const needed = (task.verifiers_needed as number)
  const alreadyAssigned = (db.prepare('SELECT COUNT(*) as n FROM verify_submissions WHERE task_id = ?').get(taskId) as { n: number }).n
  const toAssign = needed - alreadyAssigned
  if (toAssign <= 0) return

  // 混采策略：优先 active tier，且限制最多 2 个"近 7 天注册"的新号
  const pool = db.prepare(`
    SELECT vw.user_id, vw.tier, vw.is_system, u.created_at
    FROM verifier_whitelist vw
    JOIN users u ON u.id = vw.user_id
    WHERE vw.user_id != (SELECT seller_id FROM products WHERE id = ?)
      AND (vw.cooldown_until IS NULL OR vw.cooldown_until < datetime('now'))
    ORDER BY RANDOM()
  `).all(task.product_id as string) as { user_id: string; tier: string; is_system: number; created_at: string }[]

  const sevenDaysAgo = Date.now() - 7 * 86400_000
  const isNewAccount = (createdAt: string) => new Date(createdAt).getTime() > sevenDaysAgo
  const isActive     = (tier: string)       => tier?.startsWith('active')

  const picked: string[] = []
  let newAccountCount = 0
  let hasActive = false

  const tryPick = (entry: { user_id: string; tier: string; is_system: number; created_at: string }) => {
    if (picked.includes(entry.user_id)) return false
    if (isNewAccount(entry.created_at) && newAccountCount >= 2) return false
    const check = isEligibleVerifier(entry.user_id, taskId)
    if (!check.ok) return false
    picked.push(entry.user_id)
    if (isNewAccount(entry.created_at)) newAccountCount++
    if (isActive(entry.tier) || entry.is_system) hasActive = true
    return true
  }

  // 1) 先保证至少 1 个 active（含系统兜底）
  for (const p of pool) {
    if (isActive(p.tier) || p.is_system) {
      if (tryPick(p)) break
    }
  }

  // 2) 补足其余席位
  for (const p of pool) {
    if (picked.length >= toAssign) break
    tryPick(p)
  }

  // 3) 池子不够 → 强制系统兜底
  if (picked.length < toAssign && !hasActive) {
    const sys = db.prepare("SELECT vw.user_id, vw.tier, vw.is_system, u.created_at FROM verifier_whitelist vw JOIN users u ON u.id = vw.user_id WHERE vw.is_system = 1 LIMIT 1")
      .get() as { user_id: string; tier: string; is_system: number; created_at: string } | undefined
    if (sys) tryPick(sys)
  }

  // 实际写入分配 + 计配额
  for (const uid of picked) {
    db.prepare(`INSERT OR IGNORE INTO verify_submissions (id, task_id, verifier_id) VALUES (?,?,?)`)
      .run(generateId('vsb'), taskId, uid)
    db.prepare("UPDATE verifier_whitelist SET tasks_today = tasks_today + 1 WHERE user_id = ?").run(uid)
  }
}

function settleTask(taskId: string) {
  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ?').get(taskId) as Record<string, unknown>
  const subs = db.prepare(`SELECT * FROM verify_submissions WHERE task_id = ? AND submitted_at IS NOT NULL`).all(taskId) as Record<string, unknown>[]
  if (subs.length < (task.verifiers_needed as number)) return  // 未满足

  // 统计提交内容（忽略空白/null）
  const freq: Record<string, number> = {}
  for (const s of subs) {
    const v = ((s.submission as string) ?? '').trim().toUpperCase()
    if (v) freq[v] = (freq[v] ?? 0) + 1
  }

  // 找多数票（超过半数）
  const majority = Object.entries(freq).find(([, n]) => n > subs.length / 2)
  const expectedCode = (task.code as string).toUpperCase()
  const passed = majority && majority[0] === expectedCode

  const result = passed ? 'verified' : 'failed'
  db.prepare(`UPDATE verify_tasks SET status='settled', result=?, settled_at=datetime('now') WHERE id=?`).run(result, taskId)

  // 分发奖励 / 扣验证权
  const rewardEach = task.reward_per_verifier as number
  const feeLocked  = task.fee_locked as number

  if (passed) {
    // 通过：全额发给多数验证者，少数验证权-2
    for (const s of subs) {
      const vid = s.verifier_id as string
      const sub = ((s.submission as string) ?? '').trim().toUpperCase()
      const isCorrect = sub === expectedCode
      if (isCorrect) {
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(rewardEach, vid)
        db.prepare(`UPDATE verify_submissions SET verdict='correct' WHERE id=?`).run(s.id)
        db.prepare(`UPDATE verifier_stats SET verify_rights = verify_rights + 1, tasks_done = tasks_done + 1, tasks_correct = tasks_correct + 1 WHERE user_id = ?`).run(vid)
        maybeAutoPromote(vid)
      } else {
        db.prepare(`UPDATE verify_submissions SET verdict='wrong' WHERE id=?`).run(s.id)
        db.prepare(`UPDATE verifier_stats SET verify_rights = verify_rights - 2, tasks_done = tasks_done + 1, tasks_wrong = tasks_wrong + 1 WHERE user_id = ?`).run(vid)
        applyVerifierErrorPenalty(vid)
      }
    }
    // 更新挑战者链接为已验证，商品自动上架
    db.prepare(`UPDATE product_external_links SET verified=1, revoked=0, verify_note='众包验证通过', verified_at=datetime('now') WHERE product_id=? AND url=?`)
      .run(task.product_id, task.url)
    db.prepare(`UPDATE products SET status='active', updated_at=datetime('now') WHERE id=? AND status='warehouse'`)
      .run(task.product_id)

    // 原持有者链接标记为「主权失效」，并检查是否需要强制下架
    const originalOwners = db.prepare(`
      SELECT p.id as product_id, p.seller_id FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url=? AND pel.product_id != ? AND pel.verified=1
    `).all(task.url, task.product_id) as { product_id: string; seller_id: string }[]

    db.prepare(`
      UPDATE product_external_links SET revoked=1, verified=0, verify_note='主权失效'
      WHERE url=? AND product_id != ? AND verified=1
    `).run(task.url, task.product_id)

    for (const orig of originalOwners) {
      const hasValidLink = db.prepare(`
        SELECT id FROM product_external_links WHERE product_id=? AND verified=1 AND (revoked IS NULL OR revoked=0)
      `).get(orig.product_id)
      if (!hasValidLink) {
        db.prepare(`UPDATE products SET status='warehouse', updated_at=datetime('now') WHERE id=? AND status='active'`)
          .run(orig.product_id)
        // 写入系统通知（降级处理，失败不影响主流程）
        // #1017 fix: notifications schema 无 entity_type/entity_id/message — 用 actions JSON 存 product_id 引用，title/body 拆分
        try {
          db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, actions, created_at)
            VALUES (?,?,'link_revoked',?,?,?,datetime('now'))`)
            .run(generateId('ntf'), orig.seller_id,
              '商品已被自动下架',
              `您的商品因链接「${task.url as string}」主权失效已被自动下架至仓库，如需重新上架请更换链接或重新发起认领验证。`,
              JSON.stringify([{ label: '查看商品', href: `#order-product/${orig.product_id}` }]))
        } catch {}
      }
    }
  } else {
    // 失败：50% 发给参与验证者（补偿时间），50% 销毁
    const compensateTotal = feeLocked * 0.5
    const compensateEach  = subs.length > 0 ? compensateTotal / subs.length : 0
    for (const s of subs) {
      if (compensateEach > 0) db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(compensateEach, s.verifier_id)
      db.prepare(`UPDATE verify_submissions SET verdict='abstain' WHERE id=?`).run(s.id)
      db.prepare(`UPDATE verifier_stats SET tasks_done = tasks_done + 1 WHERE user_id = ?`).run(s.verifier_id)
    }
    // 验证失败：标记链接为 revoked，保留记录使商品无法直接上架
    db.prepare(`UPDATE product_external_links SET revoked=1, verify_note='验证失败：验证码未在原链接中确认' WHERE product_id=? AND url=? AND verified=0`)
      .run(task.product_id, task.url)
  }
}

// #1013 Phase 72: 7 verify-tasks endpoints 已迁出
registerVerifyTasksRoutes(app, { db, auth, assignVerifiers, settleTask, getVerifierStats })


// ─── MCP 遥测：ingest + 管理员看板 ──────────────────────────────
const TELEMETRY_RATE = new Map<string, number[]>()
function rateLimitOk(ip: string, max = 200, windowMs = 60_000): boolean {
  const now = Date.now()
  const times = (TELEMETRY_RATE.get(ip) ?? []).filter((t) => now - t < windowMs)
  if (times.length >= max) return false
  times.push(now)
  TELEMETRY_RATE.set(ip, times)
  return true
}

// mcp-telemetry — Phase 107 已迁出

// admin/usage + admin/auditor — Phase 105 已迁出


// #1013 Phase 70: 4 admin/categories + products endpoints 已迁出
registerAdminCatalogRoutes(app, {
  db,
  requireContentAdmin: (req, res) => requireAdminPermission(req, res, 'content'),
  logAdminAction,
})


// ─── Admin 角色端点（role='admin' 鉴权，运营管理）───────────────────
// ─── Admin 分级管理 ────────────────────────────────────────
// #1013 Phase 61: 4 admin/admins endpoints 已迁出到 routes/admin-admins.ts
registerAdminAdminsRoutes(app, {
  db, generateId,
  requireAdmin: (req, res) => requireAdmin(req, res),
  requireRootAdmin: (req, res) => requireRootAdmin(req, res),
  isRootAdmin, getAdminPermissions, ADMIN_PERMISSIONS,
})

// finance/monthly — Phase 105 已迁出



// ─── Wave F-5: 实时事件 stream ──────────────────────────
// #1013 Phase 67: 3 admin/events endpoints 已迁出
registerAdminEventsRoutes(app, {
  db, generateId, requireAdmin,
  systemEventBuffer, SYSTEM_EVENT_BUFFER_SIZE, adminEventClients,
})


// ─── Wave F-2: 协议参数配置 ─────────────────────────────
// #1013 Phase 60: 4 protocol-params endpoints 已迁出到 routes/admin-protocol-params.ts
registerAdminProtocolParamsRoutes(app, {
  db, generateId,
  requireAdmin: (req, res) => requireAdmin(req, res),
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
})

// #1013 Phase 105: protocol-kpi + dashboard 已迁出
registerAdminAnalyticsRoutes(app, {
  db, adminAuth, requireAdmin,
  requireRootAdmin: (req, res) => requireRootAdmin(req, res),
  getProtocolParam, INTERNAL_AUDITOR_ID,
})

// #1013 Phase 62: 6 admin/tokenomics endpoints 已迁出到 routes/admin-tokenomics.ts
registerAdminTokenomicsRoutes(app, {
  db,
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  logAdminAction,
})


// system-flags — Phase 107 已迁出

// #1013 Phase 73: GET /api/reviews/recent 已迁出（claim 2 端点也由同模块注册，定义在下游）


// B-4: 编辑精选 / 每周推荐 → server-schema.ts
initEditorPicksSchema(db)

// editor-picks 公开 — Phase 107 已迁出

// #1013 Phase 66: 3 admin/editor-picks endpoints 已迁出
registerAdminEditorPicksRoutes(app, {
  db, generateId,
  requireContentAdmin: (req, res) => requireAdminPermission(req, res, 'content'),
})


// B-3: 群组团购
db.exec(`
  CREATE TABLE IF NOT EXISTS group_buys (
    id            TEXT PRIMARY KEY,
    seller_id     TEXT NOT NULL,
    product_id    TEXT NOT NULL,
    variant_id    TEXT,
    target_count  INTEGER NOT NULL,
    discount_pct  REAL NOT NULL,             -- 例如 0.15 表示成团后 -15%
    ends_at       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',  -- active / succeeded / failed
    created_at    TEXT DEFAULT (datetime('now')),
    settled_at    TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS group_buy_participants (
    id              TEXT PRIMARY KEY,
    group_buy_id    TEXT NOT NULL,
    buyer_id        TEXT NOT NULL,
    shipping_address TEXT NOT NULL,
    escrow_amount   REAL NOT NULL,
    order_id        TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending / fulfilled / refunded
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(group_buy_id, buyer_id)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_gb_status ON group_buys(status, ends_at)') } catch {}

// #1013 Phase 28: 5 endpoints + settleGroupBuy + sweep cron 已迁出到 routes/group-buys.ts
registerGroupBuysRoutes(app, { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent })

// Cron: 过期未成团 → 失败结算（function 已迁出到 routes/group-buys.ts）
setInterval(() => sweepExpiredGroupBuysRaw(db, generateId, broadcastSystemEvent), 60_000)

// I-2: admin 全平台数据导出
const ADMIN_EXPORT_LIMIT = 20000

const csvEscapeAdmin = (val: unknown): string => {
  const s = val == null ? '' : String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

// #1013 Phase 106: admin/export + ai/anomaly-check + reputation/decay + _dev/recompute + errors 已迁出
registerAdminOpsRoutes(app, {
  db, auth,
  requireUsersAdmin: (req, res) => requireAdminPermission(req, res, 'users'),
  hasAdminPermission,
  INTERNAL_AUDITOR_ID, ADMIN_EXPORT_LIMIT, csvEscapeAdmin,
  anthropic, applyDecayIfDue, computeValueBadges,
  logAdminAction,
})

// AI 2 endpoints — Phase 100 已迁出
registerAiRoutes(app, { db, auth, anthropic })

// D-3: KYC light — 实名认证（轻度，不存原始证件号）→ server-schema.ts
initKycRecordsSchema(db)

// KYC 2 endpoints — Phase 97 已迁出
registerKycRoutes(app, { db, auth, MASTER_SEED })

// #1013 Phase 68: 6 admin/kyc+risk endpoints 已迁出
registerAdminModerationRoutes(app, {
  db, generateId,
  requireUsersAdmin: (req, res) => requireAdminPermission(req, res, 'users'),
  authFailures, INTERNAL_AUDITOR_ID, broadcastSystemEvent,
  logAdminAction,
})


// 邀请 endpoints — Phase 98 已迁出
registerReferralRoutes(app, {
  db, auth,
})


// 推土机权限：是否允许作为 sponsor 拿分享佣金
// 默认：必须有 ≥ 1 笔 completed 订单（verified buyer）才能 sponsor
// admin override：l1_share_override = 1 (强允) / -1 (强禁) / 0 (auto)
function isAllowedSponsor(userId: string): boolean {
  const u = db.prepare("SELECT l1_share_override FROM users WHERE id = ?").get(userId) as { l1_share_override: number } | undefined
  if (!u) return false
  if (u.l1_share_override === 1)  return true
  if (u.l1_share_override === -1) return false
  // auto: verified buyer = 至少 1 笔 completed 订单
  return !!db.prepare("SELECT 1 FROM orders WHERE buyer_id = ? AND status = 'completed' LIMIT 1").get(userId)
}

// 模糊化 api_key（前 8 + 后 4，中间省略）
function maskApiKey(key: string): string {
  if (!key) return '***'
  if (key.length <= 12) return `${key.slice(0,2)}***${key.slice(-2)}`
  return `${key.slice(0,8)}…${key.slice(-4)}`
}

// 计算用户状态标签（列表轻量版）
function computeLightTags(user: Record<string, unknown>, mod: { suspended: number } | null, vWhite: { tier: string; is_system: number } | null, vAppPending: boolean): string[] {
  const tags: string[] = []
  const roleSet = new Set<string>((() => { try { return JSON.parse((user.roles as string) || '[]') } catch { return [] } })())
  const ageDays = (Date.now() - new Date(user.created_at as string).getTime()) / 86400e3
  if (ageDays < 7) tags.push('new')
  if (mod?.suspended) tags.push('suspended')
  if (roleSet.has('admin'))      tags.push('admin')
  if (roleSet.has('arbitrator')) tags.push('arbitrator')
  if (roleSet.has('logistics'))  tags.push('logistics')
  if (vAppPending)               tags.push('verifier_pending')
  if (vWhite?.is_system)         tags.push('verifier_system')
  else if (vWhite?.tier?.startsWith('trial'))  tags.push('verifier_trial')
  else if (vWhite?.tier?.startsWith('active')) tags.push('verifier_active')
  if (Number(user.failed_attempts ?? 0) >= 3) tags.push('login_risk')
  return tags
}


// #1013 Phase 101: admin/orders + admin/disputes + admin/verify-tasks + admin/audit-log 已迁出
registerAdminReportsRoutes(app, {
  db,
  requireContentAdmin:     (req, res) => requireAdminPermission(req, res, 'content'),
  requireArbitrationAdmin: (req, res) => requireAdminPermission(req, res, 'arbitration'),
  requireProtocolAdmin:    (req, res) => requireAdminPermission(req, res, 'protocol'),
})

// ─── 放置树挂靠(中性参与记录:position + 每腿 PV 累计) ───────────────────────
const PV_PROPAGATION_DEPTH_LIMIT = 5000   // PV 累积深度上限（admin 可调，存 system_state 之后）

// (2026-06-04 移除 countSubtreeUsers — 旧实现只数单条脊链, 名实不符;
//  team_count 改读增量维护的 users.left_count/right_count, 见 pickPreferredSide + joinPowerLeg)

// 根据 inviter 偏好自动选边（链接不带 side 时用）
// 支持 2 档：team_count（默认，下线人数少）/ pv_count（近 90 天 PV 累计少）
// 兼容 legacy: left/right 视为 team_count（启动时会被静默迁移；这里防御性兜底）
function pickPreferredSide(inviterId: string): 'left' | 'right' {
  const u = db.prepare("SELECT placement_pref, total_left_pv, total_right_pv, left_count, right_count FROM users WHERE id = ?")
    .get(inviterId) as { placement_pref: string; total_left_pv: number; total_right_pv: number; left_count: number; right_count: number } | undefined
  const pref = u?.placement_pref || 'team_count'
  if (pref === 'pv_count') {
    // 近 90 天 PV 累计 = matched (binary_score_records.consumed_*_pv last 90d) + 当前未结算 (users.total_*_pv)
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const w = db.prepare(`SELECT COALESCE(SUM(consumed_left_pv),0) AS l, COALESCE(SUM(consumed_right_pv),0) AS r
                          FROM binary_score_records WHERE user_id = ? AND created_at >= ?`)
      .get(inviterId, since) as { l: number; r: number }
    const leftPv  = Number(u?.total_left_pv  ?? 0) + Number(w.l)
    const rightPv = Number(u?.total_right_pv ?? 0) + Number(w.r)
    return leftPv <= rightPv ? 'left' : 'right'
  }
  // team_count（默认）：左右【整棵子树】人数，挂少的一边。
  // 读增量维护的 left_count/right_count（O(1)）。2026-06-04 修：旧实现 countSubtreeUsers
  // 只数单条脊链（不含旁支子树），名实不符 → 病毒增长下选边失真。改为增量全子树计数。
  const lCount = Number(u?.left_count ?? 0)
  const rCount = Number(u?.right_count ?? 0)
  return lCount <= rCount ? 'left' : 'right'
}

/**
 * 末端垂直挂靠：用 X 码邀请的新人 → 挂在码主人 X 区最末梢。
 * 两个码完全对称（left / right）。better-sqlite3 WAL 单写天然串行。
 */
function joinPowerLeg(inviterId: string, side: 'left' | 'right', newUserId: string) {
  const childField = side === 'left' ? 'left_child_id' : 'right_child_id'
  const place = db.transaction(() => {
    // 沿 inviter 的 side 链一路向下，找到末梢节点
    let current = inviterId
    let depth = 0
    while (depth < 10_000) {  // 极端保护：硬上限 10K 避免无限循环
      const row = db.prepare(`SELECT ${childField}, placement_depth FROM users WHERE id = ?`).get(current) as { [k: string]: unknown; placement_depth: number } | undefined
      const next = row?.[childField] as string | null | undefined
      if (!next) break
      current = next
      depth++
    }
    // 现在 current = 末梢节点，把新人挂到它的 side_child
    const tailInfo = db.prepare(`SELECT placement_path, placement_depth FROM users WHERE id = ?`).get(current) as { placement_path: string | null; placement_depth: number } | undefined
    const newPath = tailInfo?.placement_path ? `${tailInfo.placement_path}>${current}` : current
    const newDepth = (tailInfo?.placement_depth ?? 0) + 1

    db.prepare(`UPDATE users SET ${childField} = ? WHERE id = ?`).run(newUserId, current)
    db.prepare(`UPDATE users SET placement_id = ?, placement_side = ?, placement_path = ?, placement_depth = ? WHERE id = ?`)
      .run(current, side, newPath, newDepth, newUserId)

    // 增量维护 left_count/right_count：从新人上溯，每个祖先的对应腿 +1（整棵子树计数，与 total_*_pv 同模式）。
    // 首轮：current 的 [side] 腿 +1（新人直接落在 current 的 side 侧）；逐级上溯，按各节点 placement_side 归边。
    let upParent: string | null = current
    let upSide: 'left' | 'right' = side
    let safety = 10_000
    while (upParent && safety-- > 0) {
      const col = upSide === 'left' ? 'left_count' : 'right_count'
      db.prepare(`UPDATE users SET ${col} = ${col} + 1 WHERE id = ?`).run(upParent)
      const pr = db.prepare("SELECT placement_id, placement_side FROM users WHERE id = ?").get(upParent) as { placement_id: string | null; placement_side: 'left' | 'right' | null } | undefined
      if (!pr?.placement_id) break
      upSide = pr.placement_side || 'left'
      upParent = pr.placement_id
    }
    return { tail: current, depth: newDepth }
  })
  return place()
}

// ─── 原子能 Cron 结算引擎 ─────────────────────────────────────

// Step 1: 处理 pv_ledger → 累积到上线 total_left/right_pv（最多 5000 层）
function processPvLedger() {
  // Category C: 纯聚合(pv_ledger → total_left/right_pv 计数,不产生 score/WAZ/权益)= 参与记录 → 默认 ON。
  if (!participationRecordingActive(db)) return 0
  const pending = db.prepare(`SELECT * FROM pv_ledger WHERE processed = 0 ORDER BY created_at ASC LIMIT 1000`).all() as Record<string, unknown>[]
  for (const lg of pending) {
    try {
      const buyer = db.prepare("SELECT placement_id, placement_side, placement_path FROM users WHERE id = ?").get(lg.buyer_id) as { placement_id: string | null; placement_side: string | null; placement_path: string | null } | undefined
      if (!buyer?.placement_id || !buyer.placement_side) {
        // buyer 不在放置树（无 placement）→ 流水跳过但标 processed
        db.prepare("UPDATE pv_ledger SET processed = 1 WHERE id = ?").run(lg.id)
        continue
      }
      // path = "X1>X2>X3..."（X1 是 buyer 的直接 placement_id）
      const ancestors = buyer.placement_path ? buyer.placement_path.split('>') : [buyer.placement_id]
      // 限制深度
      const limited = ancestors.slice(0, PV_PROPAGATION_DEPTH_LIMIT)

      // 第 i 个 ancestor 的 side（buyer 在 ancestor 哪边）由 path 链上"下一跳的 placement_side"决定
      // ancestors[0] = buyer.placement_id，buyer 在其哪边 = buyer.placement_side
      // ancestors[1] = ancestors[0].placement_id，ancestors[0] 在其哪边 = ancestors[0].placement_side
      // ...
      const sideRows = limited.length > 0
        ? db.prepare(`SELECT id, placement_side FROM users WHERE id IN (${limited.map(()=>'?').join(',')})`).all(...limited) as { id: string; placement_side: string }[]
        : []
      const sideMap = new Map(sideRows.map(r => [r.id, r.placement_side]))

      const leftAncestors: string[] = []
      const rightAncestors: string[] = []
      // buyer 的 side 决定 ancestors[0] 累加到哪边
      let nextSide: string = buyer.placement_side
      for (let i = 0; i < limited.length; i++) {
        const a = limited[i]
        if (nextSide === 'left')  leftAncestors.push(a)
        if (nextSide === 'right') rightAncestors.push(a)
        // 下一个 ancestor 的 side 由 a 在其父的 placement_side 决定
        const aSide = sideMap.get(a) || 'left'
        nextSide = aSide
      }

      const pv = Number(lg.pv)
      if (leftAncestors.length) {
        db.prepare(`UPDATE users SET total_left_pv = total_left_pv + ?, pv_dirty_at = datetime('now') WHERE id IN (${leftAncestors.map(()=>'?').join(',')})`).run(pv, ...leftAncestors)
      }
      if (rightAncestors.length) {
        db.prepare(`UPDATE users SET total_right_pv = total_right_pv + ?, pv_dirty_at = datetime('now') WHERE id IN (${rightAncestors.map(()=>'?').join(',')})`).run(pv, ...rightAncestors)
      }
      db.prepare("UPDATE pv_ledger SET processed = 1 WHERE id = ?").run(lg.id)
    } catch (e) {
      console.error('[pv_ledger]', e)
    }
  }
  return pending.length
}

// ─── 匹配奖励结算引擎(Category C)— 已切除 / EXCISED ───────────────────────────
// 匹配奖励结算 + 兑付 = REWARD 路径,已从公开代码切除:internal/pv-settlement.ts
// 现为永久 no-op stub(runBinarySettlement → 0;executeSafeSettlementCron → disabled,无视 kill-switch)。
// 比门控更强 —— 即便翻 matching_rewards_active='1',公开代码也无引擎可跑、不会兑付。完整引擎归档在
// docs/modules/pv-settlement-engine.INTERNAL.md(gitignored)+ git 历史;重启需律师/治理放行 + 重接,非翻 flag。
// 留在本文件的中性【参与记录】(默认 ON,不受影响):joinPowerLeg(放置树)/ processPvLedger(PV 聚合)/ calculatePv。
// 注:工厂签名不变,下游 1h/24h cron 调用点零改动(stub 安全返回)。regionPvEnabled 为函数声明(hoisted)。
const { runBinarySettlement, executeSafeSettlementCron } = createPvSettlementEngine({ db, generateId, regionPvEnabled })

// 启动定时任务（每 1h 处理 ledger + settle；每 24h 兑付结算）
// Category C:1h cron 混了【参与记录】(processPvLedger,默认 ON)+【奖励】(runBinarySettlement,默认 OFF) —
// 不加外层守卫,各函数自门控(recording vs rewards)。24h 兑付是纯 REWARD → 外层 matchingRewardsActive 守卫。
setInterval(() => {
  try { processPvLedger() } catch (e) { console.error('[cron pv]', e) }
  try { runBinarySettlement() } catch (e) { console.error('[cron settle]', e) }
}, 60 * 60_000)

setInterval(() => {
  if (!matchingRewardsActive(db)) return
  try {
    const r = executeSafeSettlementCron()
    if (r.status === 'completed') {
      console.log(`[原子能] 周期 ${r.periodId} 完成：发放 ${r.cash_distributed} 元 / 沉淀 ${r.cash_retained} 元 / payout_rate=${r.payout_rate} / unit_cash=${r.effective_unit_cash}`)
    }
  } catch (e) { console.error('[cron settlement]', e) }
}, 24 * 60 * 60_000)

// 2026-05-24 #980：测评免单 reach 评估 cron — 每 6h 跑一次
// #1013 Phase 3: evaluateTrialClaims + /api/admin/trial/run-eval 已迁出到 routes/trial.ts；这里只挂 cron
setInterval(async () => {
  try {
    const r = await evaluateTrialClaims(db, generateId)
    if (r.evaluated > 0) console.log(`[cron trial-eval] evaluated=${r.evaluated} refunded=${r.refunded} expired=${r.expired}`)
  } catch (e) { console.error('[cron trial-eval]', e) }
}, 6 * 60 * 60_000)

// 2026-05-24 #959：拍卖提醒 cron — 每 60s 扫一次
// #1013 Phase 5: fireDueAuctionReminders + admin endpoint 已迁出到 routes/auction.ts；这里只挂 cron
setInterval(() => {
  try {
    const r = fireDueAuctionReminders(db, generateId)
    if (r.fired > 0) console.log(`[cron auction-reminder] fired=${r.fired}`)
  } catch (e) { console.error('[cron auction-reminder]', e) }
}, 60_000)

// #1013 Phase 65: 3 admin/atomic endpoints 已迁出
registerAdminAtomicRoutes(app, {
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  processPvLedger, runBinarySettlement, executeSafeSettlementCron,
  logAdminAction,
})

// #1013 Phase 110: tokenomics/status + shares/dashboard 已迁出
registerDashboardsRoutes(app, { db, auth })

// ─── 原子能挂靠：补绑端点（已注册无 placement 的孤儿）─────
// #1013 Phase 56: 3 placement endpoints 已迁出到 routes/profile-placement.ts
registerProfilePlacementRoutes(app, {
  db, auth, internalAuditorId: INTERNAL_AUDITOR_ID,
  resolveUserRef, resolveInviteCodeRef, pickPreferredSide, joinPowerLeg,
})

// shares/dashboard — Phase 110 已迁出

// ─── 推土机轨道：推广统计端点 ─────────────────────────────────
// #1013 Phase 77: 2 promoter endpoints 已迁出
registerPromoterRoutes(app, { db, auth, isAllowedSponsor, participationRecordingActive: () => participationRecordingActive(db), matchingRewardsActive: () => matchingRewardsActive(db) })


// ─── 成长任务（分享达人养成主线）─────────────────────────────
// #1013 Phase 30: 4 endpoints + catalog + evaluator 已迁出到 routes/growth.ts
registerGrowthRoutes(app, { db, auth })

// 直推 L1 列表

// ─── 卖家发新品配额（模块 A）─────────────────────────────────
const QUOTA_TIERS = [200, 500, 1000]

// #1013 Phase 78: 12 admin/users 生命周期端点已迁出
registerAdminUsersLifecycleRoutes(app, {
  db,
  requireUsersAdmin:    (req, res) => requireAdminPermission(req, res, 'users'),
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  requireContentAdmin:  (req, res) => requireAdminPermission(req, res, 'content'),
  requireRootAdmin,
  adminCanOperateOn, isRootAdmin, safeRoles, logAdminAction, QUOTA_TIERS,
})

// #1013 Phase 79: 5 admin/users 查询/详情端点已迁出
registerAdminUsersQueryRoutes(app, {
  db,
  requireUsersAdmin: (req, res) => requireAdminPermission(req, res, 'users'),
  adminCanOperateOn, isRootAdmin, isAllowedSponsor,
  maskApiKey, computeLightTags, getAdminScope, getSellerDailyLimit, todayStartISO,
  broadcastSystemEvent, INTERNAL_AUDITOR_ID,
  logAdminAction,
})

function getSellerDailyLimit(user: { id?: unknown; created_at?: unknown }): number {
  const id = String(user.id ?? '')
  const ageDays = (Date.now() - new Date(String(user.created_at ?? '')).getTime()) / 86400_000
  if (ageDays >= 30) return 20
  const hasCompletedOrder = !!db.prepare("SELECT 1 FROM orders WHERE seller_id = ? AND status = 'completed' LIMIT 1").get(id)
  return hasCompletedOrder ? 20 : 10
}

function checkSellerCanList(user: Record<string, unknown>): { ok: boolean; reason?: string; daily_limit?: number; daily_used?: number; total?: number; max?: number; new_user?: boolean } {
  if (user.listing_paused) {
    const r = user.listing_paused_reason ? `：${user.listing_paused_reason}` : ''
    return { ok: false, reason: `发布权限已被管理员暂停${r}` }
  }
  const max = Number(user.max_products ?? 200)
  const total = (db.prepare("SELECT COUNT(*) as n FROM products WHERE seller_id = ? AND status != 'deleted'").get(user.id) as { n: number }).n
  if (total >= max) return { ok: false, reason: `已达商品总数上限 ${max}，请申请扩容`, total, max }
  const today = todayStartISO()
  const todayCount = (db.prepare("SELECT COUNT(*) as n FROM products WHERE seller_id = ? AND created_at >= ?").get(user.id, today) as { n: number }).n
  const dailyLimit = getSellerDailyLimit({ id: user.id, created_at: user.created_at })
  const ageDays = (Date.now() - new Date(String(user.created_at ?? '')).getTime()) / 86400_000
  const newUser = ageDays < 30 && dailyLimit === 10
  if (todayCount >= dailyLimit) return { ok: false, reason: `今日发布已达上限 ${dailyLimit} 件`, daily_limit: dailyLimit, daily_used: todayCount, total, max, new_user: newUser }
  return { ok: true, daily_limit: dailyLimit, daily_used: todayCount, total, max, new_user: newUser }
}

// ─── Verifier 访问控制层（申请 / 审批 / 申诉）────────────────
// 详见 docs/modules/verifier-access-control.md
const TIER_QUOTAS: Record<string, number> = {
  'trial-1': 2, 'trial-2': 5, 'trial-3': 15, 'active-1': 30, 'active-2': 60
}
const VERIFIER_STAKE_REQUIRED = Number(process.env.VERIFIER_STAKE_REQUIRED || 0)
const APP_REJECT_COOLDOWN_DAYS = 30
const REVOKE_COOLDOWN_DAYS = 90
// 外部仲裁员（比 verifier 门槛更高）
const ARB_STAKE_REQUIRED = Number(process.env.ARB_STAKE_REQUIRED || 0)
const ARB_APP_REJECT_COOLDOWN_DAYS = 60

// #1013 Phase 63: 6 admin/verifier-whitelist endpoints 已迁出
registerAdminVerifierWhitelistRoutes(app, {
  db,
  requireVerifierMgmtAdmin: (req, res) => requireAdminPermission(req, res, 'verifier_mgmt'),
  adminCanOperateOn,
  logAdminAction,
  INTERNAL_AUDITOR_ID,
  TIER_QUOTAS,
  REVOKE_COOLDOWN_DAYS,
})

interface EligibilityItem { key: string; label: string; current: number | string; required: number | string; ok: boolean }

function checkVerifierEligibility(userId: string): { eligible: boolean; items: EligibilityItem[] } {
  const user = db.prepare("SELECT id, name, email_verified, reputation, created_at FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined
  if (!user) return { eligible: false, items: [] }

  const items: EligibilityItem[] = []
  const ageDays = Math.floor((Date.now() - new Date(user.created_at as string).getTime()) / 86400_000)
  items.push({ key: 'age', label: '账户年龄 ≥ 60 天', current: ageDays, required: 60, ok: ageDays >= 60 })
  items.push({ key: 'email', label: '邮箱已验证', current: user.email_verified ? '✓' : '✗', required: '✓', ok: !!user.email_verified })

  const orders = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND status = 'completed'").get(userId, userId) as { n: number }).n
  items.push({ key: 'orders', label: '完成订单 ≥ 20 笔', current: orders, required: 20, ok: orders >= 20 })

  const disputeLost = (db.prepare(`
    SELECT COUNT(*) as n FROM disputes
    WHERE ((initiator_id = ? AND ruling_type = 'release_seller')
       OR  (defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')))
       AND status IN ('resolved')
  `).get(userId, userId) as { n: number }).n
  items.push({ key: 'no_violations', label: '零仲裁判输', current: disputeLost, required: 0, ok: disputeLost === 0 })

  const wasSuspended = !!db.prepare("SELECT 1 FROM user_moderation WHERE user_id = ?").get(userId)
  items.push({ key: 'never_suspended', label: '账户未曾被暂停', current: wasSuspended ? '✗' : '✓', required: '✓', ok: !wasSuspended })

  const wallet = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(userId) as { balance: number } | undefined
  const balance = wallet?.balance ?? 0
  items.push({ key: 'balance', label: '钱包余额 ≥ 200 WAZ', current: Number(balance).toFixed(2), required: 200, ok: balance >= 200 })

  const reputation = Number(user.reputation ?? 0)
  items.push({ key: 'reputation', label: 'reputation ≥ 110', current: reputation, required: 110, ok: reputation >= 110 })

  return { eligible: items.every(i => i.ok), items }
}

function getVerifierState(userId: string) {
  const app = db.prepare(
    "SELECT * FROM verifier_applications WHERE user_id = ? ORDER BY applied_at DESC LIMIT 1"
  ).get(userId) as Record<string, unknown> | undefined
  const wl = db.prepare("SELECT * FROM verifier_whitelist WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined
  const stats = db.prepare("SELECT * FROM verifier_stats WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined

  let state = 'none'
  if (app?.status === 'pending')  state = 'pending'
  if (app?.status === 'rejected') state = 'rejected'
  if (wl) {
    if (wl.cooldown_until && new Date(wl.cooldown_until as string).getTime() > Date.now()) state = 'cooldown'
    else if (stats?.suspended_until && new Date(stats.suspended_until as string).getTime() > Date.now()) state = 'suspended'
    else state = String(wl.tier || 'active-2')
  }
  return { state, application: app ?? null, whitelist: wl ?? null, stats: stats ?? null }
}

function todayStartISO(): string {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString()
}

function resetDailyQuotaIfNeeded(userId: string) {
  const wl = db.prepare("SELECT quota_reset_at FROM verifier_whitelist WHERE user_id = ?").get(userId) as { quota_reset_at: string | null } | undefined
  if (!wl) return
  const todayStart = todayStartISO()
  if (!wl.quota_reset_at || wl.quota_reset_at < todayStart) {
    db.prepare("UPDATE verifier_whitelist SET tasks_today = 0, quota_reset_at = ? WHERE user_id = ?")
      .run(todayStart, userId)
  }
}

function pickNextTierOnError(currentTier: string, drop: number): string {
  const order = ['trial-1', 'trial-2', 'trial-3', 'active-1', 'active-2']
  const idx = order.indexOf(currentTier)
  if (idx < 0) return 'trial-1'
  return order[Math.max(0, idx - drop)]
}

// 自动 Tier 升级：每次正确后检查，只升不降
function maybeAutoPromote(userId: string) {
  const wl = db.prepare("SELECT tier, is_system, added_at FROM verifier_whitelist WHERE user_id = ?")
    .get(userId) as { tier: string; is_system: number; added_at: string } | undefined
  if (!wl || wl.is_system) return
  const stats = db.prepare("SELECT tasks_done, tasks_correct FROM verifier_stats WHERE user_id = ?")
    .get(userId) as { tasks_done: number; tasks_correct: number } | undefined
  if (!stats) return
  const correct  = stats.tasks_correct
  const accuracy = stats.tasks_done > 0 ? stats.tasks_correct / stats.tasks_done : 0
  const daysSince = Math.floor((Date.now() - new Date(wl.added_at).getTime()) / 86400_000)

  let target: string | null = null
  if      (correct >= 500 && accuracy >= 0.90 && daysSince >= 180) target = 'active-2'
  else if (correct >= 200 && accuracy >= 0.90 && daysSince >= 60)  target = 'active-1'
  else if (correct >= 80  && accuracy >= 0.92)                     target = 'trial-3'
  else if (correct >= 30  && accuracy >= 0.95)                     target = 'trial-2'

  const order = ['trial-1', 'trial-2', 'trial-3', 'active-1', 'active-2']
  if (!target || order.indexOf(target) <= order.indexOf(wl.tier)) return

  db.prepare("UPDATE verifier_whitelist SET tier = ?, daily_quota = ? WHERE user_id = ?")
    .run(target, TIER_QUOTAS[target], userId)
  logAdminAction(INTERNAL_AUDITOR_ID, 'auto_promote_verifier', 'user', userId, { from: wl.tier, to: target, correct, accuracy: Number(accuracy.toFixed(2)) })
}

// 错误处罚梯度（每次 settleTask 中 verifier 提交错时调用）
function applyVerifierErrorPenalty(userId: string) {
  const wl = db.prepare("SELECT user_id, tier, error_count_180d, is_system, stake_amount FROM verifier_whitelist WHERE user_id = ?")
    .get(userId) as { user_id: string; tier: string; error_count_180d: number; is_system: number; stake_amount: number } | undefined
  if (!wl) return
  if (wl.is_system) return  // 系统兜底不受处罚

  const newCount = (wl.error_count_180d || 0) + 1
  if (newCount === 1) {
    const until = new Date(Date.now() + 7 * 86400_000).toISOString()
    const newTier = pickNextTierOnError(wl.tier, 1)
    db.prepare("UPDATE verifier_whitelist SET error_count_180d = ?, tier = ?, daily_quota = ? WHERE user_id = ?")
      .run(newCount, newTier, TIER_QUOTAS[newTier] || 0, userId)
    db.prepare("UPDATE verifier_stats SET suspended_until = ? WHERE user_id = ?").run(until, userId)
  } else if (newCount === 2) {
    const until = new Date(Date.now() + 30 * 86400_000).toISOString()
    const newTier = pickNextTierOnError(wl.tier, 2)
    db.prepare("UPDATE verifier_whitelist SET error_count_180d = ?, tier = ?, daily_quota = ? WHERE user_id = ?")
      .run(newCount, newTier, TIER_QUOTAS[newTier] || 0, userId)
    db.prepare("UPDATE verifier_stats SET suspended_until = ? WHERE user_id = ?").run(until, userId)
  } else {
    // 第 3 次 → 撤销 + 3 个月冷却 + 没收 50% 质押
    const cooldownUntil = new Date(Date.now() + REVOKE_COOLDOWN_DAYS * 86400_000).toISOString()
    const forfeit = (wl.stake_amount || 0) * 0.5
    if (wl.stake_amount > 0) {
      db.prepare("UPDATE wallets SET staked = staked - ? WHERE user_id = ?").run(wl.stake_amount, userId)
      if (wl.stake_amount > forfeit) {
        db.prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = ?").run(wl.stake_amount - forfeit, userId)
      }
    }
    db.prepare("DELETE FROM verifier_whitelist WHERE user_id = ?").run(userId)
    db.prepare(`INSERT INTO verifier_whitelist (user_id, note, tier, daily_quota, cooldown_until, is_system)
                VALUES (?, '错误 3 次自动撤销', 'trial-1', 0, ?, 0)`).run(userId, cooldownUntil)
  }
}

// ─── 用户侧 verifier API ──────────────────────────────────────
// #1013 Phase 46: 5 user endpoints 已迁出到 routes/verifier-user.ts
registerVerifierUserRoutes(app, {
  db, generateId, auth, errorRes,
  checkVerifierEligibility, getVerifierState, resetDailyQuotaIfNeeded,
  TIER_QUOTAS, VERIFIER_STAKE_REQUIRED, APP_REJECT_COOLDOWN_DAYS,
})

// #1013 Phase 64: 5 admin/verifier-applications + appeals endpoints 已迁出
registerAdminVerifierFlowRoutes(app, {
  db,
  requireVerifierMgmtAdmin: (req, res) => requireAdminPermission(req, res, 'verifier_mgmt'),
  TIER_QUOTAS, VERIFIER_STAKE_REQUIRED, todayStartISO, logAdminAction,
})


// ─── Arbitrator 访问控制层（与 Verifier 平行；门槛更高）────────

function checkArbitratorEligibility(userId: string): { eligible: boolean; items: EligibilityItem[] } {
  const user = db.prepare("SELECT id, email_verified, reputation, created_at FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined
  if (!user) return { eligible: false, items: [] }
  const items: EligibilityItem[] = []
  const ageDays = Math.floor((Date.now() - new Date(user.created_at as string).getTime()) / 86400_000)
  items.push({ key: 'age', label: '账户年龄 ≥ 90 天', current: ageDays, required: 90, ok: ageDays >= 90 })
  items.push({ key: 'email', label: '邮箱已验证', current: user.email_verified ? '✓' : '✗', required: '✓', ok: !!user.email_verified })
  const orders = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND status = 'completed'").get(userId, userId) as { n: number }).n
  items.push({ key: 'orders', label: '完成订单 ≥ 50 笔', current: orders, required: 50, ok: orders >= 50 })
  const disputeLost = (db.prepare(`
    SELECT COUNT(*) as n FROM disputes
    WHERE ((initiator_id = ? AND ruling_type = 'release_seller')
       OR  (defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')))
       AND status IN ('resolved')
  `).get(userId, userId) as { n: number }).n
  items.push({ key: 'no_violations', label: '零仲裁判输', current: disputeLost, required: 0, ok: disputeLost === 0 })
  const wasSuspended = !!db.prepare("SELECT 1 FROM user_moderation WHERE user_id = ?").get(userId)
  items.push({ key: 'never_suspended', label: '账户未曾被暂停', current: wasSuspended ? '✗' : '✓', required: '✓', ok: !wasSuspended })
  const wallet = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(userId) as { balance: number } | undefined
  const balance = wallet?.balance ?? 0
  items.push({ key: 'balance', label: '钱包余额 ≥ 500 WAZ', current: balance.toFixed(2), required: 500, ok: balance >= 500 })
  const rep = Number(user.reputation || 0)
  items.push({ key: 'reputation', label: 'reputation ≥ 300', current: rep, required: 300, ok: rep >= 300 })
  return { eligible: items.every(i => i.ok), items }
}

function getArbitratorState(userId: string) {
  const app = db.prepare("SELECT * FROM arbitrator_applications WHERE user_id = ? ORDER BY applied_at DESC LIMIT 1").get(userId) as Record<string, unknown> | undefined
  const wl = db.prepare("SELECT * FROM arbitrator_whitelist WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined
  let state = 'none'
  if (app?.status === 'pending')  state = 'pending'
  if (app?.status === 'rejected') state = 'rejected'
  if (wl) state = 'approved'
  return { state, application: app ?? null, whitelist: wl ?? null }
}

// 仲裁员身份判定（内部 role + 外部 whitelist 双通道）— 用于 /api/disputes/:id/arbitrate 守门
function isEligibleArbitrator(userId: string): { ok: boolean; reason?: string; via?: 'role' | 'whitelist' } {
  const u = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined
  if (!u) return { ok: false, reason: '用户不存在' }
  if (u.role === 'arbitrator') return { ok: true, via: 'role' }
  const wl = db.prepare("SELECT user_id FROM arbitrator_whitelist WHERE user_id = ?").get(userId)
  if (wl) return { ok: true, via: 'whitelist' }
  return { ok: false, reason: '非仲裁员 — 需 role=arbitrator（内部）或 arbitrator_whitelist（外部）' }
}

// #1013 Phase 44: 4 user + 3 admin arbitrator endpoints 已迁出到 routes/arbitrator.ts
registerArbitratorRoutes(app, {
  db, generateId, auth,
  requireArbitrationAdmin: (req, res) => requireAdminPermission(req, res, 'arbitration'),
  checkArbitratorEligibility, getArbitratorState, errorRes, logAdminAction,
  ARB_STAKE_REQUIRED, ARB_APP_REJECT_COOLDOWN_DAYS,
})

// Governance onboarding (W3.5-B #1093) — apply + quiz + cases + admin activation + resign/appeal + auto_deactivate audit
registerGovernanceOnboardingRoutes(app, {
  db, generateId, auth, errorRes,
  checkArbitratorEligibility, checkVerifierEligibility,
  consumeGateToken, getProtocolParam,
  requireGovernanceAdmin: (req, res) => requireAdminPermission(req, res, 'arbitration'),
  logAdminAction,
})

// #1090 RFC-002 PR-2a: rewards apply/deactivate/status endpoints
registerRewardsApplyRoutes(app, {
  db, auth, errorRes, consumeGateToken, getProtocolParam,
})

// task #1093 stage 5: admin manual auto-deactivate sweep trigger
// Useful for ops + testing. The scheduled cron also runs every N hours.
app.post('/api/admin/governance/run-auto-deactivate', async (req, res) => {
  const admin = requireAdminPermission(req, res, 'arbitration'); if (!admin) return
  try {
    const result = await runAutoDeactivateSweep({ db, generateId, getProtocolParam })
    logAdminAction((admin as Record<string, unknown>).id as string, 'governance_auto_deactivate_sweep', null, null, {
      scanned: result.scanned,
      deactivated_count: result.deactivated.length,
    })
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// link-challenges/verify — Phase 113 已迁出

// 2026-05-24 价格下降时通知 wishlist 中开启了价格提醒的用户
function notifyWishlistPriceDrop(productId: string, productTitle: string, oldPrice: number, newPrice: number) {
  const users = db.prepare(`
    SELECT user_id, price_at_add FROM user_wishlist
    WHERE product_id = ? AND notify_price_drop = 1
  `).all(productId) as Array<{ user_id: string; price_at_add: number | null }>
  if (users.length === 0) return
  const dropPct = ((oldPrice - newPrice) / oldPrice * 100).toFixed(1)
  db.transaction(() => {
    for (const { user_id, price_at_add } of users) {
      // 仅当当前价 < 用户加心愿单时的价（避免反复通知）
      if (price_at_add != null && newPrice >= price_at_add) continue
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
          .run(generateId('ntf'), user_id, 'product', '💰 心愿单商品降价', `「${productTitle}」从 ${oldPrice} 降到 ${newPrice} WAZ (-${dropPct}%)`, null)
      } catch {}
    }
  })()
}

// Wave B-2 helper: 库存回归时通知所有等待中的 waitlist 用户
function notifyWaitlist(productId: string, productTitle: string) {
  const users = db.prepare(`
    SELECT user_id FROM product_waitlist WHERE product_id = ? AND notified_at IS NULL
  `).all(productId) as Array<{ user_id: string }>
  if (users.length === 0) return
  db.transaction(() => {
    for (const { user_id } of users) {
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
          .run(generateId('ntf'), user_id, '⏰ 等待的商品已到货', `你订阅补货提醒的「${productTitle}」已重新上架，先到先得`, null)
      } catch {}
    }
    db.prepare(`UPDATE product_waitlist SET notified_at = datetime('now') WHERE product_id = ? AND notified_at IS NULL`).run(productId)
  })()
}

// 库存检查 — 扣库存后调用：低于阈值通知，归零且开启自动下架则移到仓库
// 注意：调用前必须已 UPDATE 库存；本函数读最新 stock 决策
function checkStockAndMaybeDelist(productId: string) {
  try {
    const p = db.prepare(`SELECT id, seller_id, title, stock, status,
      low_stock_threshold, auto_delist_on_zero, low_stock_alerted_at
      FROM products WHERE id = ?`).get(productId) as {
        id: string; seller_id: string; title: string;
        stock: number; status: string;
        low_stock_threshold: number | null;
        auto_delist_on_zero: number | null;
        low_stock_alerted_at: string | null;
      } | undefined
    if (!p) return
    const stock = Number(p.stock || 0)
    const threshold = Number(p.low_stock_threshold ?? 3)
    const autoDelist = Number(p.auto_delist_on_zero ?? 1) === 1

    // 售罄 + 开启自动下架 + 当前是 active → 移仓库
    if (stock === 0 && autoDelist && p.status === 'active') {
      db.prepare(`UPDATE products SET status='warehouse', auto_delisted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(productId)
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
          .run(generateId('ntf'), p.seller_id, 'stock_auto_delist',
            '📦 商品已自动下架（售罄）',
            `「${p.title}」库存归零，已移入仓库。补货后请手动重新上架。`,
            null)
      } catch (e) { console.error('[stock-alert delist-notify]', (e as Error).message) }
      return
    }

    // 低于阈值（>0 且 ≤threshold）→ 通知，24h 去重
    if (stock > 0 && stock <= threshold) {
      const last = p.low_stock_alerted_at ? new Date(p.low_stock_alerted_at).getTime() : 0
      const now = Date.now()
      if (now - last < 24 * 60 * 60 * 1000) return  // 24h 内已通知，跳过
      db.prepare(`UPDATE products SET low_stock_alerted_at=datetime('now') WHERE id=?`).run(productId)
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
          .run(generateId('ntf'), p.seller_id, 'stock_low',
            '⚠️ 库存预警',
            `「${p.title}」库存仅剩 ${stock} 件（阈值 ${threshold}）— 建议尽快补货避免售罄。`,
            null)
      } catch (e) { console.error('[stock-alert low-notify]', (e as Error).message) }
    }
  } catch (e) {
    console.error('[stock-alert]', (e as Error).message)
  }
}

// PATCH /:id/status + DELETE /:id — Phase 92 已迁出

// ============================================================
// P1 — 多商家跟卖 API（listing × product 共享身份）
// products.listing_id 不空 = 此 product 即为该 listing 的一个 offer
// ============================================================
const LISTING_CATEGORIES = {
  standard:   { name: '标品',      stake_mult: 1.0, cold_start: 30, min_sales: 0,  requires_kyc: false },
  general:    { name: '普通',      stake_mult: 1.5, cold_start: 20, min_sales: 5,  requires_kyc: false },
  highvalue:  { name: '高价大件',  stake_mult: 2.0, cold_start: 15, min_sales: 20, requires_kyc: false },
  restricted: { name: '食药婴幼',  stake_mult: 3.0, cold_start: 50, min_sales: 50, requires_kyc: true  },
} as const
type ListingCategoryKey = keyof typeof LISTING_CATEGORIES
const BASE_LISTING_STAKE = 50  // 50 WAZ
const VALID_FULFILLMENT_TYPES = new Set(['instant_pickup', 'same_day', 'next_day', 'standard'])

function isListingCategoryKey(s: string): s is ListingCategoryKey {
  return Object.prototype.hasOwnProperty.call(LISTING_CATEGORIES, s)
}
// #1013 Phase 52: 5 listings endpoints 已迁出到 routes/listings.ts
// (sellerCompletedSales / URGENCY_WEIGHTS / VALID_OFFER_SORTS / computeOfferScore 也封装在 module)
registerListingsRoutes(app, {
  db, generateId, auth,
  LISTING_CATEGORIES, BASE_LISTING_STAKE, VALID_FULFILLMENT_TYPES, isListingCategoryKey,
})

// ─── 公开仲裁判例 API ──────────────────────────────────────
// #1013 Phase 8: 6 endpoints + meetsPublicSpeechThreshold 已迁出到 routes/dispute-cases.ts
registerDisputeCasesRoutes(app, {
  db, auth, getUser, generateId,
  piiSanitize, detectFraud, commentBlocklistHit, llmModerateComment,
})


// ============================================================
// P3 — RFQ 抢单 API
// ============================================================
const VALID_RFQ_URGENCIES = new Set(['now', 'today', 'flex'])
const VALID_AWARD_MODES = new Set(['manual', 'first_match', 'time_window'])
const RFQ_DEFAULT_WINDOW_MIN: Record<string, number> = { now: 15, today: 60, flex: 1440 }
const RFQ_MAX_WINDOW_MIN = 7 * 24 * 60   // 7 天上限
// QA 轮 10.2-C P1：RFQ_BUYER_DEPOSIT_RATE 死常量删了（实际生效见 routes/rfqs.ts:66 — 1% 封顶 1 WAZ）
// 旧 2% 注释 + 全局 buyerRfqDeposit 都是迁出后的 dead code 残留，已清
const BID_STAKE_RATE = 0.05              // 卖家 5% bid 押金（防中标弃单）— routes/rfqs.ts 用
const RFQ_DAILY_CAP_PER_BUYER = 10
const BID_DAILY_CAP_PER_SELLER = 100
// P0.2: 数量 / 价格上限（防 LLM 注入 + 钱包溢出）
const RFQ_MAX_QTY = 100_000
const RFQ_MAX_PRICE = 1_000_000   // 1M WAZ per unit 上限

// QA 轮 10.2-C P1：dead code 清除 — buyerRfqDeposit 已迁 routes/rfqs.ts:65 (1% 封顶 1 WAZ)
// 旧 2% 公式 dead，已删。
// bidStakeFor 还在本文件其他地方用（如 evaluateAutoBids），保留单一定义，跟 routes/rfqs.ts:69 同公式（min 0.5, 5%）。
function bidStakeFor(price: number, qty: number): number {
  return Math.max(0.5, Math.round(price * qty * BID_STAKE_RATE * 100) / 100)
}

// #1013 Phase 83: 4 orders read endpoints 已迁出
registerOrdersReadRoutes(app, { db, auth, getOrderStatus, getOrderChain, verifyOrderChain, getOrderDispute })

// #1013 Phase 84: 4 orders action endpoints 已迁出
// 注意：settleOrder 是函数声明（hoisted）但绑了 db 闭包，无需注入 db
registerOrdersActionRoutes(app, {
  db, auth, isTrustedRole, generateId, transition, notifyTransition,
  settleOrder, settleFault, detectFraud, createDispute, checkTimeouts, recordViolationReputation,
  broadcastSystemEvent,
})

// #1013 Phase 85: POST /api/orders 巨型事务已迁出
registerOrdersCreateRoutes(app, {
  db, auth, isTrustedRole, generateId, generateRecipientCode, DONATION_VALID_PCTS,
  INTERNAL_AUDITOR_ID, addHours,
  getActiveFlashSale, applyCouponToOrder, getProtocolParam,
  getProductShareChain, isAllowedSponsor, checkStockAndMaybeDelist, auditSponsorChainCross,
  appendOrderEvent, transition, notifyTransition, shouldAutoAccept, ensureCharityRep,
  broadcastSystemEvent, resolveInviteCodeRef,
  signPassport: (message: string) => walletSigner.issuerSignMessage(message),
  issuerAddress: () => walletSigner.issuerAddress(),
})

// #1013 Phase 45: 卖家配额 + 数据中心 7 endpoints — 2026-05-31 修补:之前 import 了但忘了 register,
// 导致 /api/seller/quota-status + /api/seller/insights 落入 SPA fallback 返回 HTML,前端 JSON.parse 死循环
registerSellerQuotaRoutes(app, {
  db, generateId, auth,
  requireUsersAdmin: (req, res) => requireAdminPermission(req, res, 'users'),
  safeRoles, checkSellerCanList, adminCanOperateOn, logAdminAction, QUOTA_TIERS,
})

// #1013 Phase 86: 5 disputes 读端点已迁出
registerDisputesReadRoutes(app, {
  db, auth, errorRes,
  getOpenDisputes, getDisputeDetails, getEvidenceRequests, listEvidenceFiles,
  isEligibleArbitrator,
})

// #1013 Phase 87: 5 disputes 写端点已迁出（包括 234 行 arbitrate）
// FUND_BASE_RATE 是 const 函数在文件下游定义；用 getter 包一层避免 TDZ
registerDisputesWriteRoutes(app, {
  db, auth, generateId, detectFraud, errorRes,
  isEligibleArbitrator, requireHumanPresence,
  getDisputeDetails, respondToDispute, arbitrateDispute, addPartyEvidence, requestEvidence,
  markEvidenceExpiry, uploadEvidence, EVIDENCE_MAX_BYTES, EVIDENCE_ALLOWED_MIME,
  appendOrderEvent,
  FUND_BASE_RATE: () => FUND_BASE_RATE(),
  settleCommission, depositToFund, calculatePv,
  recordDisputeReputation, issueAgentStrike, publishDisputeCase, logAdminAction, snfSend,
  getProtocolParam,
})

// lightAuthGuard：轻量 Authorization 头守门（在 raw 解析之前挡掉无 auth 请求）
// 被 Phase 13 shareables（视频上传）+ Phase 87 disputes evidence-blob 共享
function lightAuthGuard(req: Request, res: Response, next: NextFunction) {
  const hasAuth = !!req.headers.authorization
  if (!hasAuth) return void res.status(401).json({ error: 'auth required' })
  next()
}

// #1013 Phase 82: 9 rfqs + bids endpoints 已迁出到 routes/rfqs.ts
registerRfqsRoutes(app, {
  db, auth, generateId,
  VALID_RFQ_URGENCIES, VALID_AWARD_MODES, RFQ_MAX_QTY, RFQ_MAX_PRICE,
  RFQ_DAILY_CAP_PER_BUYER, RFQ_MAX_WINDOW_MIN, RFQ_DEFAULT_WINDOW_MIN,
  BID_DAILY_CAP_PER_SELLER, BID_STAKE_RATE,
  VALID_FULFILLMENT_TYPES, isListingCategoryKey, LISTING_CATEGORIES,
  awardBidAndCreateOrder, notifyMatchedSellers, evaluateAutoBidsForRfq,
  shouldAutoAccept, transition, notifyTransition,
})

// 买家：创建 RFQ — Phase 82 已迁出

// GET /api/rfqs + /mine + /:id + DELETE /:id + POST /:id/bids — Phase 82 已迁出

// PATCH /api/bids/:id + DELETE /api/bids/:id — Phase 82 已迁出

// P3c：urgency-tiered 订单截止期（now < today < flex）
const RFQ_ORDER_DEADLINES = {
  now:   { accept: 2,  ship: 4,   pickup: 6,   delivery: 24,  confirm: 48  },
  today: { accept: 6,  ship: 12,  pickup: 18,  delivery: 48,  confirm: 72  },
  flex:  { accept: 48, ship: 120, pickup: 168, delivery: 336, confirm: 408 },
}

// P3c 核心：award → 自动建 order（不冲正，幂等 — 已建过则不重）
// 返回：{ ok, order_id?, error? }
function awardBidAndCreateOrder(rfq: Record<string, unknown>, winner: Record<string, unknown>): { ok: boolean; order_id?: string; error?: string } {
  const rfqId = String(rfq.id)
  const bidId = String(winner.id)
  const buyerId = String(rfq.buyer_id)
  const sellerId = String(winner.seller_id)
  const price = Number(winner.price)
  const qty = Math.max(1, Math.floor(Number(winner.qty_offered) || 1))
  const totalAmount = Math.round(price * qty * 100) / 100
  const deposit = Number(rfq.buyer_stake_locked) || 0
  const winnerStake = Number(winner.stake_locked) || 0

  const shipping = String(rfq.shipping_address || '').trim()
  if (!shipping) return { ok: false, error: 'RFQ 缺收货地址，无法建单（旧数据），请取消重发' }

  // 买家钱包：扣 escrow（押金即将释放可冲抵），需满足 balance + deposit ≥ total
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(buyerId) as { balance: number } | undefined
  const need = totalAmount - deposit   // 扣完押金回笼后还差多少
  if (!wallet || Number(wallet.balance) + deposit < totalAmount) {
    return { ok: false, error: `买家余额不足建单（需 ${totalAmount} WAZ，含释放押金 ${deposit} 后还差 ${Math.max(0, need)} WAZ）` }
  }

  // 决策 1：lazy product 创建
  let productId = winner.offer_id ? String(winner.offer_id) : ''
  // P1-2: RFQ 不支持 variants — 若 winner offer 指向带 variants 商品，拒绝
  if (productId) {
    const pCheck = db.prepare('SELECT has_variants FROM products WHERE id = ?').get(productId) as { has_variants: number } | undefined
    if (pCheck && Number(pCheck.has_variants) === 1) {
      return { ok: false, error: 'RFQ 暂不支持带规格的商品（has_variants=1）' }
    }
  }
  if (!productId) {
    // 校验：若 winner 对该 RFQ.listing_id 已有 product 行，复用；否则新建
    const lstId = rfq.listing_id ? String(rfq.listing_id) : null
    if (lstId) {
      const existing = db.prepare("SELECT id, has_variants FROM products WHERE seller_id = ? AND listing_id = ? AND status != 'deleted'").get(sellerId, lstId) as { id: string; has_variants: number } | undefined
      if (existing) {
        if (Number(existing.has_variants) === 1) {
          return { ok: false, error: 'RFQ 暂不支持带规格的商品（has_variants=1）' }
        }
        productId = existing.id
      }
    }
    if (!productId) {
      productId = generateId('p')
      const fulfillmentType = String(winner.fulfillment_type || 'standard')
      const etaHours = winner.eta_hours != null ? Number(winner.eta_hours) : null
      db.prepare(`
        INSERT INTO products (id, seller_id, title, description, price, stock, status, images,
          ship_regions, handling_hours, commission_rate, category_id, stake_amount,
          listing_id, fulfillment_type, eta_hours, freshness_ts, cold_start_remaining)
        VALUES (?,?,?,?,?,?,'active','[]',?,?,?,?,0,?,?,?,datetime('now'),?)
      `).run(
        productId, sellerId,
        String(rfq.title),
        `[RFQ ${rfqId}] ` + (rfq.notes ? String(rfq.notes).slice(0, 200) : '协议撮合订单'),
        price, qty,
        String(rfq.region_required || '全国'),
        24, 0,
        'cat_default',
        lstId,
        fulfillmentType,
        etaHours,
        30,  // cold_start_remaining
      )
    }
  } else {
    // 引用已有 offer：校验 stock 充足、属于 winner.seller_id
    const p = db.prepare("SELECT seller_id, stock, status FROM products WHERE id = ?").get(productId) as { seller_id: string; stock: number; status: string } | undefined
    if (!p) return { ok: false, error: '关联的 offer 不存在' }
    if (p.seller_id !== sellerId) return { ok: false, error: 'offer 归属与 bid 不匹配' }
    if (p.status !== 'active') return { ok: false, error: 'offer 已下架' }
    if (Number(p.stock) < qty) return { ok: false, error: `offer 库存不足（${p.stock} < ${qty}）` }
  }

  // urgency-tiered deadlines（决策 3）
  const urg = String(rfq.urgency || 'flex')
  const dl = RFQ_ORDER_DEADLINES[urg as keyof typeof RFQ_ORDER_DEADLINES] ?? RFQ_ORDER_DEADLINES.flex
  const now = new Date()
  const buyerRegion = (db.prepare('SELECT region FROM users WHERE id = ?').get(buyerId) as { region: string | null } | undefined)?.region || 'global'

  const orderId = generateId('ord')
  // 决策 5：l1/l2/l3 = NULL，snapshot_commission_rate = 0
  // P0.1：bid_stake_held 写入订单 — 卖家 stake 保留到 completed 才放回，fault 时按 settleFault 处置
  db.prepare(`INSERT INTO orders (
    id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
    status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
    pickup_deadline, delivery_deadline, confirm_deadline,
    l1_uid, l2_uid, l3_uid, snapshot_commission_rate, buyer_region, source, bid_stake_held
  ) VALUES (?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,NULL,NULL,NULL,0,?,'rfq',?)`).run(
    orderId, productId, buyerId, sellerId, qty, price, totalAmount, totalAmount,
    shipping,
    `[RFQ ${rfqId}] ` + (rfq.notes ? String(rfq.notes).slice(0, 200) : ''),
    addHours(now, 0),                  // pay_deadline：award 瞬间立即"已支付"，给 0 也无害
    addHours(now, dl.accept),
    addHours(now, dl.ship),
    addHours(now, dl.pickup),
    addHours(now, dl.delivery),
    addHours(now, dl.confirm),
    buyerRegion,
    winnerStake,
  )

  // 钱包：释放买家押金；卖家 bid stake 保留在 staked，仅在订单 completed/fault 时处置
  if (deposit > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(deposit, deposit, buyerId)
  db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?').run(totalAmount, totalAmount, buyerId)
  db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, productId)
  checkStockAndMaybeDelist(String(productId))

  // RFQ + bid 状态
  db.prepare("UPDATE rfqs SET status = 'awarded', winning_bid_id = ?, awarded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(bidId, rfqId)
  db.prepare("UPDATE bids SET status = 'won', resolved_at = datetime('now') WHERE id = ?").run(bidId)
  // 其他 bid → lost + 释放 stake
  const losers = db.prepare("SELECT id, seller_id, stake_locked FROM bids WHERE rfq_id = ? AND id != ? AND status = 'active'").all(rfqId, bidId) as Array<{ id: string; seller_id: string; stake_locked: number }>
  for (const l of losers) {
    db.prepare("UPDATE bids SET status = 'lost', resolved_at = datetime('now') WHERE id = ?").run(l.id)
    if (l.stake_locked > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(l.stake_locked, l.stake_locked, l.seller_id)
  }

  // state machine：created → paid
  try { transition(db, orderId, 'paid', buyerId, [], 'RFQ award：买家押金转 escrow 模拟支付') } catch (e) { console.error('[P3c transition paid]', e) }
  return { ok: true, order_id: orderId }
}

// 买家：选定 winner（手动 award 或不传 bid_id → 自动选最低价 = 提前结算）
// POST /api/rfqs/:id/award — Phase 82 已迁出

// P3b: 创建 RFQ 时推送给 top-N 匹配卖家
function notifyMatchedSellers(rfqId: string) {
  const rfq = db.prepare("SELECT id, title, category, region_required, urgency, max_price, qty FROM rfqs WHERE id = ?").get(rfqId) as Record<string, unknown> | undefined
  if (!rfq) return
  // 匹配：有同 category active offer 的卖家，优先本地区
  const sellers = db.prepare(`
    SELECT DISTINCT p.seller_id, u.region
    FROM products p
    JOIN users u ON u.id = p.seller_id
    LEFT JOIN listings l ON l.id = p.listing_id
    WHERE p.status = 'active'
      AND (l.category = ? OR l.category IS NULL)
      AND u.role = 'seller'
    ORDER BY (u.region = ?) DESC
    LIMIT 20
  `).all(String(rfq.category), String(rfq.region_required || '')) as Array<{ seller_id: string; region: string }>

  const title = `📩 新求购：${String(rfq.title).slice(0, 30)}`
  const body = `${rfq.qty} 件${rfq.max_price ? ' · 预算 ' + rfq.max_price + ' WAZ' : ''} · RFQ #${rfqId}`
  for (const s of sellers) {
    try {
      db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'rfq_match',?,?,datetime('now'))`)
        .run(generateId('ntf'), s.seller_id, title, body)
    } catch (e) { console.error('[P3 notify match]', e) }
  }
}

// P3e: auto_bid 评估器（rfq.created 之后立即扫描所有 active auto_bid Skill）
// 返回触发次数；内部直接 INSERT bid + 锁 stake（绕过 HTTP auth + 频率限制 — Skill 已是 seller 主动配置）
function evaluateAutoBidsForRfq(rfqId: string): number {
  const rfq = db.prepare("SELECT * FROM rfqs WHERE id = ? AND status = 'open'").get(rfqId) as Record<string, unknown> | undefined
  if (!rfq) { console.warn('[P3e] rfq not found or not open', rfqId); return 0 }
  const skills = db.prepare(`
    SELECT s.id, s.seller_id, s.config FROM skills s
    WHERE s.skill_type = 'auto_bid' AND s.active = 1
  `).all() as Array<{ id: string; seller_id: string; config: string }>
  if (skills.length === 0) return 0

  let triggered = 0
  for (const s of skills) {
    let cfg: Record<string, unknown> = {}
    try { cfg = JSON.parse(s.config || '{}') } catch { continue }
    if (cfg.enabled === false) continue

    // category 过滤
    const cats = Array.isArray(cfg.categories) ? cfg.categories as string[] : []
    if (cats.length && !cats.includes(String(rfq.category))) continue

    // region 过滤
    const regs = Array.isArray(cfg.regions) ? cfg.regions as string[] : []
    const sellerRegion = (db.prepare('SELECT region FROM users WHERE id = ?').get(s.seller_id) as { region: string | null } | undefined)?.region
    if (regs.length && rfq.region_required && !regs.includes(String(rfq.region_required))) continue
    if (rfq.region_required && sellerRegion && rfq.region_required !== sellerRegion && (!regs.length || !regs.includes(String(rfq.region_required)))) continue

    // 自己发的 RFQ 不能自己 bid
    if (rfq.buyer_id === s.seller_id) continue

    // ETA 校验
    const maxEta = Number(cfg.max_eta_h || 24)
    // urgency=now 强 ETA 上限
    if (String(rfq.urgency) === 'now' && maxEta > 4) continue   // urgency=now 时 ETA ≤ 4h 才有效

    // daily_cap：当日 auto_bid 数
    const dailyCap = Math.max(1, Math.floor(Number(cfg.daily_cap || 20)))
    const todayCnt = (db.prepare(`SELECT COUNT(1) as n FROM bids WHERE seller_id = ? AND auto_bid_skill = 1 AND submitted_at > datetime('now','-1 day')`).get(s.seller_id) as { n: number }).n
    if (todayCnt >= dailyCap) continue

    // cooldown：同一 buyer 短期内不重复 bid
    const cooldownMin = Math.max(0, Math.floor(Number(cfg.cooldown_min || 60)))
    if (cooldownMin > 0) {
      const recent = db.prepare(`
        SELECT 1 FROM bids b
        JOIN rfqs r ON r.id = b.rfq_id
        WHERE b.seller_id = ? AND r.buyer_id = ? AND b.auto_bid_skill = 1
          AND b.submitted_at > datetime('now', '-' || ? || ' minutes')
        LIMIT 1
      `).get(s.seller_id, String(rfq.buyer_id), cooldownMin)
      if (recent) continue
    }

    // 计算 bid 价格（决策：strategy）
    const strategy = String(cfg.bid_strategy || 'cheapest_undercut')
    const undercutPct = Math.max(0, Math.min(0.5, Number(cfg.undercut_pct || 0.05)))
    const maxPriceCap = cfg.max_price_cap != null ? Number(cfg.max_price_cap) : Infinity
    const rfqMaxPrice = rfq.max_price != null ? Number(rfq.max_price) : null

    let proposedPrice: number
    if (strategy === 'match_budget' && rfqMaxPrice) {
      proposedPrice = rfqMaxPrice
    } else {
      // cheapest_undercut：当前最低价 × (1-pct)，无 bid 则用 max_price
      const lowest = db.prepare("SELECT MIN(price) as p FROM bids WHERE rfq_id = ? AND status = 'active'").get(rfqId) as { p: number | null }
      if (lowest.p != null) proposedPrice = Math.max(0.01, lowest.p * (1 - undercutPct))
      else proposedPrice = rfqMaxPrice ?? maxPriceCap
    }
    if (!Number.isFinite(proposedPrice) || proposedPrice <= 0) continue
    proposedPrice = Math.round(proposedPrice * 100) / 100
    if (proposedPrice > maxPriceCap) continue
    if (rfqMaxPrice && proposedPrice > rfqMaxPrice) continue

    const qty = Math.max(1, Math.floor(Number(rfq.qty || 1)))
    const stake = bidStakeFor(proposedPrice, qty)
    const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(s.seller_id) as { balance: number } | undefined
    if (!wallet || Number(wallet.balance) < stake) continue   // 余额不够 → 安静跳过

    // 已存在 active bid → 不重复（与手动一致）
    const exists = db.prepare("SELECT id FROM bids WHERE rfq_id = ? AND seller_id = ?").get(rfqId, s.seller_id) as { id: string } | undefined
    if (exists) continue

    const bidId = generateId('bid')
    const fulfillmentType = String(cfg.fulfillment_type || 'standard')
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO bids (id, rfq_id, seller_id, price, qty_offered, eta_hours, fulfillment_type, note, stake_locked, auto_bid_skill)
                    VALUES (?,?,?,?,?,?,?,?,?,1)`).run(
          bidId, rfqId, s.seller_id, proposedPrice, qty, maxEta, fulfillmentType,
          '🤖 ' + (cfg.note ? String(cfg.note).slice(0, 200) : 'auto-bid by Skill'),
          stake)
        db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?').run(stake, stake, s.seller_id)
        db.prepare(`UPDATE rfqs SET bid_count = bid_count + 1, updated_at = datetime('now') WHERE id = ?`).run(rfqId)
        db.prepare('UPDATE skills SET total_uses = total_uses + 1 WHERE id = ?').run(s.id)
      })()
      triggered++

      // 通知卖家 + 买家
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                    VALUES (?,?,'rfq_auto_bid',?,?,datetime('now'))`)
          .run(generateId('ntf'), s.seller_id, `🤖 自动报价已提交`, `RFQ：${String(rfq.title).slice(0, 30)} · ${proposedPrice} WAZ`)
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                    VALUES (?,?,'rfq_bid',?,?,datetime('now'))`)
          .run(generateId('ntf'), String(rfq.buyer_id), `💰 新报价 ${proposedPrice} WAZ`, `RFQ：${String(rfq.title).slice(0, 30)} · 🤖 auto_bid`)
      } catch {}

      // first_match 模式 → 立即评估 award（同 POST /bids 路径）
      if (rfq.award_mode === 'first_match' && (!rfqMaxPrice || proposedPrice <= rfqMaxPrice)) {
        try {
          const newBid = db.prepare('SELECT * FROM bids WHERE id = ?').get(bidId) as Record<string, unknown>
          let r: ReturnType<typeof awardBidAndCreateOrder> = { ok: false }
          db.transaction(() => {
            const rfqLatest = db.prepare('SELECT * FROM rfqs WHERE id = ?').get(rfqId) as Record<string, unknown> | undefined
            if (rfqLatest && rfqLatest.status === 'open') {
              r = awardBidAndCreateOrder(rfqLatest, newBid)
              if (!r.ok) throw new Error(r.error || 'first_match award failed')
            }
          })()
          if (r.ok) {
            try {
              db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                          VALUES (?,?,'rfq_won',?,?,datetime('now'))`)
                .run(generateId('ntf'), s.seller_id, `🎉 中标（first_match）`, `订单 ${r.order_id}`)
            } catch {}
          }
        } catch (e) { console.error('[P3e auto_bid first_match]', (e as Error).message) }
      }
    } catch (e) { console.error('[P3e auto_bid insert]', (e as Error).message) }
  }
  return triggered
}

// Cron: RFQ 自动过期（每分钟扫一次）
setInterval(() => {
  try {
    const expired = db.prepare(`
      SELECT * FROM rfqs
      WHERE status = 'open' AND deadline_at < datetime('now')
    `).all() as Array<Record<string, unknown>>
    for (const r of expired) {
      const rfqId = String(r.id)
      const awardMode = String(r.award_mode || 'manual')
      const winner = (awardMode === 'time_window' || awardMode === 'first_match')
        ? db.prepare("SELECT * FROM bids WHERE rfq_id = ? AND status = 'active' ORDER BY price ASC, submitted_at ASC LIMIT 1").get(rfqId) as Record<string, unknown> | undefined
        : undefined

      if (winner) {
        // auto-pick → 复用 award helper（自动建单 + escrow + 状态机）
        let result: ReturnType<typeof awardBidAndCreateOrder> = { ok: false }
        try {
          db.transaction(() => {
            result = awardBidAndCreateOrder(r, winner)
            if (!result.ok) throw new Error(result.error || 'cron award failed')
          })()
        } catch (e) {
          console.error('[P3c cron award]', rfqId, (e as Error).message)
          // 失败 fallback：标 expired + 释放所有 stake
          db.transaction(() => {
            db.prepare("UPDATE rfqs SET status = 'expired', updated_at = datetime('now') WHERE id = ?").run(rfqId)
            const all = db.prepare("SELECT id, seller_id, stake_locked FROM bids WHERE rfq_id = ? AND status = 'active'").all(rfqId) as Array<{ id: string; seller_id: string; stake_locked: number }>
            for (const b of all) {
              db.prepare("UPDATE bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(b.id)
              if (b.stake_locked > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(b.stake_locked, b.stake_locked, b.seller_id)
            }
            const dep = Number(r.buyer_stake_locked || 0)
            if (dep > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(dep, dep, r.buyer_id)
          })()
          continue
        }
        try {
          db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                      VALUES (?,?,'rfq_won',?,?,datetime('now'))`)
            .run(generateId('ntf'), winner.seller_id as string, `🎉 中标（窗口期到）`, `订单 ${result.order_id}`)
        } catch (e) { console.error('[P3 notify won-cron]', e) }
      } else {
        // 无 bid 或 manual 模式 → 标 expired，释放所有 stake
        db.transaction(() => {
          db.prepare("UPDATE rfqs SET status = 'expired', updated_at = datetime('now') WHERE id = ?").run(rfqId)
          const all = db.prepare("SELECT id, seller_id, stake_locked FROM bids WHERE rfq_id = ? AND status = 'active'").all(rfqId) as Array<{ id: string; seller_id: string; stake_locked: number }>
          for (const b of all) {
            db.prepare("UPDATE bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(b.id)
            if (b.stake_locked > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(b.stake_locked, b.stake_locked, b.seller_id)
          }
          const dep = Number(r.buyer_stake_locked || 0)
          if (dep > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(dep, dep, r.buyer_id)
        })()
      }
    }
  } catch (e) { console.error('[P3 expire cron]', e) }
}, 10_000)   // P1: 10s 精度（urgency=now 15min 窗口期需要 < 1min 精度）

// ============================================================
// AUC — 加价拍卖 API（English forward auction）
// #1013 Phase 5: 9 endpoints + AUC_* 常量 + aucXxxStake helpers + fireDueAuctionReminders 已迁出到 routes/auction.ts
// settleAuction* 留下（深耦合 transition + checkStockAndMaybeDelist），其结算 cron 也留
// ============================================================
registerAuctionRoutes(app, {
  db, auth, generateId,
  RFQ_MAX_QTY, RFQ_MAX_PRICE,
  LISTING_CATEGORIES, isListingCategoryKey,
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  logAdminAction,
})


// AUC 结算 helper：到期 → 最高 active bid → 建单（或流拍）
// P0 audit fix #2：顶层 try/catch 兜底，意外抛错时 status='error' 防 cron 死循环
function settleAuction(aucId: string): { ok: boolean; order_id?: string; result: string } {
  try {
    return settleAuctionInner(aucId)
  } catch (e) {
    const msg = (e as Error).message
    // 并发跳过不是错，无需标 error（下次 cron 自然跳过 status != 'open' 的）
    if (msg === 'concurrent_settle_skip') return { ok: false, result: msg }
    console.error('[AUC settle fatal]', aucId, msg)
    try { db.prepare("UPDATE auctions SET status = 'error', updated_at = datetime('now') WHERE id = ? AND status = 'open'").run(aucId) } catch {}
    return { ok: false, result: 'error: ' + msg }
  }
}
function settleAuctionInner(aucId: string): { ok: boolean; order_id?: string; result: string } {
  const auc = db.prepare('SELECT * FROM auctions WHERE id = ?').get(aucId) as Record<string, unknown> | undefined
  if (!auc) return { ok: false, result: 'not_found' }
  if (auc.status !== 'open') return { ok: false, result: `already_${auc.status}` }

  const winner = db.prepare("SELECT * FROM auction_bids WHERE auction_id = ? AND status = 'active' ORDER BY price DESC, submitted_at ASC LIMIT 1").get(aucId) as Record<string, unknown> | undefined
  const sellerStake = Number(auc.seller_stake_locked) || 0

  // 1) 流拍：无人出价 → 退卖家担保金
  if (!winner) {
    db.transaction(() => {
      const cur = db.prepare("SELECT status FROM auctions WHERE id = ?").get(aucId) as { status: string } | undefined
      if (!cur || cur.status !== 'open') throw new Error('concurrent_settle_skip')
      db.prepare("UPDATE auctions SET status = 'expired_no_bid', updated_at = datetime('now') WHERE id = ?").run(aucId)
      if (sellerStake > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(sellerStake, sellerStake, auc.seller_id)
      if (auc.product_id) db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'auction_pending'").run(auc.product_id)
    })()
    return { ok: true, result: 'expired_no_bid' }
  }

  // 2) 未达保留价 → 流拍 + 退所有 stake
  const reserve = auc.reserve_price != null ? Number(auc.reserve_price) : null
  if (reserve != null && Number(winner.price) < reserve) {
    db.transaction(() => {
      const cur = db.prepare("SELECT status FROM auctions WHERE id = ?").get(aucId) as { status: string } | undefined
      if (!cur || cur.status !== 'open') throw new Error('concurrent_settle_skip')
      db.prepare("UPDATE auctions SET status = 'reserve_not_met', updated_at = datetime('now') WHERE id = ?").run(aucId)
      if (sellerStake > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(sellerStake, sellerStake, auc.seller_id)
      // winner bid 标 cancelled + 退押金
      const ws = Number(winner.stake_locked) || 0
      db.prepare("UPDATE auction_bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(winner.id)
      if (ws > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(ws, ws, winner.buyer_id)
      // 其他 active 已经在每次新 bid 时变 outbid 释放过，理论应为空，但兜底扫
      const others = db.prepare("SELECT id, buyer_id, stake_locked FROM auction_bids WHERE auction_id = ? AND status = 'active' AND id != ?").all(aucId, winner.id) as Array<{ id: string; buyer_id: string; stake_locked: number }>
      for (const o of others) {
        db.prepare("UPDATE auction_bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(o.id)
        if (o.stake_locked > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(o.stake_locked, o.stake_locked, o.buyer_id)
      }
      if (auc.product_id) db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'auction_pending'").run(auc.product_id)
    })()
    return { ok: true, result: 'reserve_not_met' }
  }

  // 3) 成交：建单
  const buyerId = String(winner.buyer_id)
  const sellerId = String(auc.seller_id)
  const qty = Math.max(1, Math.floor(Number(auc.qty || 1)))
  const price = Number(winner.price)
  const totalAmount = Math.round(price * qty * 100) / 100
  const buyerStake = Number(winner.stake_locked) || 0

  // buyer 地址快照
  const buyerProfile = db.prepare('SELECT default_address_text, default_address_json FROM users WHERE id = ?').get(buyerId) as { default_address_text: string | null; default_address_json: string | null } | undefined
  let shipping: string | null = buyerProfile?.default_address_text ?? null
  if (!shipping && buyerProfile?.default_address_json) {
    try {
      const a = JSON.parse(buyerProfile.default_address_json) as Record<string, string>
      const parts = [a.recipient, a.line1, a.line2, a.city, a.state, a.country, a.phone1].filter(Boolean)
      if (parts.length) shipping = parts.join(' / ')
    } catch {}
  }
  if (!shipping) {
    // 极端：买家无地址 → 流拍 + 退 stake，避免无法发货
    return settleAuctionNoAddress(aucId, sellerStake, winner)
  }

  // buyer 钱包：押金已锁，需补 (total - stake) escrow
  const need = totalAmount - buyerStake
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(buyerId) as { balance: number } | undefined
  if (!wallet || Number(wallet.balance) + buyerStake < totalAmount) {
    // P0 audit fix #1：买家弃单赔偿给卖家（卖家无责，因拍卖周期付出了机会成本）
    // 买家 stake 全数转给卖家 balance；卖家担保金退回
    db.transaction(() => {
      // 幂等重读
      const cur = db.prepare("SELECT status FROM auctions WHERE id = ?").get(aucId) as { status: string } | undefined
      if (!cur || cur.status !== 'open') throw new Error('concurrent_settle_skip')
      db.prepare("UPDATE auctions SET status = 'buyer_insufficient', updated_at = datetime('now') WHERE id = ?").run(aucId)
      db.prepare("UPDATE auction_bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(winner.id)
      if (buyerStake > 0) {
        db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(buyerStake, buyerId)
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(buyerStake, sellerId)   // 转给卖家而非 sys
      }
      if (sellerStake > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(sellerStake, sellerStake, sellerId)
      if (auc.product_id) db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'auction_pending'").run(auc.product_id)
    })()
    // 通知卖家收到补偿
    try {
      db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'auction_compensation',?,?,datetime('now'))`)
        .run(generateId('ntf'), sellerId, `⚠ 中标方失约：你获得补偿 ${buyerStake} WAZ`, `拍卖：${String(auc.title).slice(0, 30)} · 买家余额不足`)
    } catch {}
    return { ok: false, result: 'buyer_insufficient' }
  }

  // 4) 选定产品 — 引用已有 product 或懒建 synthetic
  let productId = auc.product_id ? String(auc.product_id) : ''
  // P1-2: 拍卖不支持 variants
  if (productId) {
    const pCheck = db.prepare('SELECT has_variants FROM products WHERE id = ?').get(productId) as { has_variants: number } | undefined
    if (pCheck && Number(pCheck.has_variants) === 1) {
      return { ok: false, result: 'variants_not_supported' }
    }
  }
  if (!productId) {
    productId = generateId('p')
    db.prepare(`
      INSERT INTO products (id, seller_id, title, description, price, stock, status, images,
        ship_regions, handling_hours, commission_rate, category_id, stake_amount, listing_id, freshness_ts, cold_start_remaining)
      VALUES (?,?,?,?,?,?,'active','[]',?,?,?,?,0,?,datetime('now'),?)
    `).run(
      productId, sellerId,
      String(auc.title),
      `[AUC ${aucId}] ` + (auc.notes ? String(auc.notes).slice(0, 200) : '拍卖成交'),
      price, qty,
      '全国', 24, 0.10, 'cat_default',
      auc.listing_id ? String(auc.listing_id) : null,
      30,
    )
  }

  // 5) 截止期 — 拍卖订单走标准 17 天链（拍卖结束后再谈履约时效）
  const now = new Date()
  const orderId = generateId('ord')
  const buyerRegion = (db.prepare('SELECT region FROM users WHERE id = ?').get(buyerId) as { region: string | null } | undefined)?.region || 'global'

  db.transaction(() => {
    // P0 audit fix #3：transaction 内重读 status 防 TOCTOU 双结算
    const cur = db.prepare("SELECT status FROM auctions WHERE id = ?").get(aucId) as { status: string } | undefined
    if (!cur || cur.status !== 'open') throw new Error('concurrent_settle_skip')
    db.prepare(`INSERT INTO orders (
      id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
      status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
      pickup_deadline, delivery_deadline, confirm_deadline,
      l1_uid, l2_uid, l3_uid, snapshot_commission_rate, buyer_region, source, bid_stake_held
    ) VALUES (?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,NULL,NULL,NULL,0,?,'auction',?)`).run(
      orderId, productId, buyerId, sellerId, qty, price, totalAmount, totalAmount,
      shipping,
      `[AUC ${aucId}] ` + (auc.notes ? String(auc.notes).slice(0, 200) : ''),
      addHours(now, 0),
      addHours(now, 48), addHours(now, 120), addHours(now, 168), addHours(now, 336), addHours(now, 408),
      buyerRegion,
      buyerStake,
    )
    // 买家：押金保留为 bid_stake_held（同 RFQ）；额外扣 escrow = total - stake
    db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?').run(need, totalAmount, buyerId)
    db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(buyerStake, buyerId)   // 从 staked 释放（注意：amount 已转 escrow）
    // 卖家 stake 同步保留至订单 completed
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, productId)
    checkStockAndMaybeDelist(String(productId))

    db.prepare("UPDATE auctions SET status = 'settled', winning_bid_id = ?, awarded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(winner.id, aucId)
    db.prepare("UPDATE auction_bids SET status = 'won', resolved_at = datetime('now') WHERE id = ?").run(winner.id)
  })()

  try { transition(db, orderId, 'paid', buyerId, [], '拍卖成交：买家押金转 escrow 模拟支付') } catch (e) { console.error('[AUC transition]', e) }
  try {
    db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                VALUES (?,?,'auction_won',?,?,datetime('now'))`)
      .run(generateId('ntf'), buyerId, `🎉 拍下：${String(auc.title).slice(0, 30)}`, `订单 ${orderId} · ${totalAmount} WAZ`)
    db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                VALUES (?,?,'auction_sold',?,?,datetime('now'))`)
      .run(generateId('ntf'), sellerId, `💰 拍出：${String(auc.title).slice(0, 30)}`, `订单 ${orderId} · ${totalAmount} WAZ`)
  } catch {}
  return { ok: true, order_id: orderId, result: 'settled' }
}

function settleAuctionNoAddress(aucId: string, sellerStake: number, winner: Record<string, unknown>): { ok: boolean; result: string } {
  db.transaction(() => {
    db.prepare("UPDATE auctions SET status = 'expired_no_bid', updated_at = datetime('now') WHERE id = ?").run(aucId)
    if (sellerStake > 0) {
      const a = db.prepare('SELECT seller_id, product_id FROM auctions WHERE id = ?').get(aucId) as { seller_id: string; product_id: string | null }
      db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(sellerStake, sellerStake, a.seller_id)
      if (a.product_id) db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'auction_pending'").run(a.product_id)
    }
    const ws = Number(winner.stake_locked) || 0
    if (ws > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(ws, ws, winner.buyer_id)
    db.prepare("UPDATE auction_bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(winner.id)
  })()
  return { ok: false, result: 'buyer_no_address' }
}

// AUC cron：扫到期 → 结算
setInterval(() => {
  try {
    const expired = db.prepare(`SELECT id FROM auctions WHERE status = 'open' AND deadline_at < datetime('now')`).all() as Array<{ id: string }>
    for (const a of expired) {
      try { settleAuction(a.id) } catch (e) { console.error('[AUC settle cron]', a.id, (e as Error).message) }
    }
  } catch (e) { console.error('[AUC cron]', e) }
}, 10_000)

// ============================================================
// CHAT — 上下文绑定聊天 API
// #1013 Phase 4: 8 endpoints + 4 helpers 已迁出到 routes/chat.ts
// ============================================================
registerChatRoutes(app, { db, auth, generateId, rateLimitOk })

// 初始化导入次数追踪表 → server-schema.ts
initImportLogsSchema(db)

const FREE_IMPORT_LIMIT = 10

// #1013 Phase 114: import-product 已迁出
registerImportProductRoutes(app, {
  db, auth, safeFetch, rateLimitOk, generateId,
  checkSellerCanList, anthropic, AnthropicCtor: Anthropic,
  FREE_IMPORT_LIMIT,
})

// claim-url — Phase 113 已迁出
registerUrlClaimRoutes(app, {
  db, auth, safeFetch, generateId, parsePlatformUrl,
  getStakeDiscount, makeCommitmentHash, makeDescriptionHash, makePriceHash,
})

// #1013 Phase 115: agent-buy 已迁出
registerAgentBuyRoutes(app, {
  db, auth, safeFetch, rateLimitOk, generateId,
  anthropic, AnthropicCtor: Anthropic, formatProductForAgent,
  checkStockAndMaybeDelist, addHours, transition, notifyTransition,
  shouldAutoAccept,
})

// ─── P13: 购物车 API ──────────────────────────────────────────
// #1013 Phase 29: 5 endpoints 已迁出到 routes/cart.ts
registerCartRoutes(app, {
  db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent,
  checkStockAndMaybeDelist, addHours,
})

// POST /api/orders/batch-ship — Phase 84 已迁出

// ─── P14: 社交（关注）─────────────────────────────────────
// #1013 Phase 10: 4 个 follows endpoints (status/post/delete/me) 已迁出到 routes/follows.ts
// /api/follows/feed (Wave D-1) 留下方（依赖 products schema）
registerFollowsRoutes(app, { db, auth, generateId })

// ─── Wave E-5: PWA Push ───────────────────────────────────
// #1013 Phase 31: 4 endpoints 已迁出到 routes/push.ts
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''
registerPushRoutes(app, { db, generateId, auth, vapidPublicKey: VAPID_PUBLIC_KEY })

// ─── Wave E-4: 签到 / 每日任务 ────────────────────────────
const TASK_DEFS = {
  first_order: { label: '首次完成订单', reward: 5 },
  five_orders: { label: '完成 5 单', reward: 10 },
  first_rating: { label: '首次提交评价', reward: 2 },
  follow_three: { label: '关注 3 个卖家', reward: 1 },
  first_review_received: { label: '收到首条评价（seller）', reward: 2 },
}

// 计算用户当前任务进度（不写库，纯读）
function computeTaskProgress(userId: string): Record<string, { progress: number; goal: number; eligible: boolean }> {
  const completed = (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND status = 'completed'`).get(userId) as { n: number }).n
  const ratingsGiven = (db.prepare(`SELECT COUNT(*) as n FROM order_ratings WHERE buyer_id = ?`).get(userId) as { n: number }).n
  const ratingsReceived = (db.prepare(`SELECT COUNT(*) as n FROM order_ratings WHERE seller_id = ?`).get(userId) as { n: number }).n
  const follows = (db.prepare(`SELECT COUNT(*) as n FROM follows WHERE follower_id = ?`).get(userId) as { n: number }).n
  return {
    first_order: { progress: Math.min(completed, 1), goal: 1, eligible: completed >= 1 },
    five_orders: { progress: Math.min(completed, 5), goal: 5, eligible: completed >= 5 },
    first_rating: { progress: Math.min(ratingsGiven, 1), goal: 1, eligible: ratingsGiven >= 1 },
    follow_three: { progress: Math.min(follows, 3), goal: 3, eligible: follows >= 3 },
    first_review_received: { progress: Math.min(ratingsReceived, 1), goal: 1, eligible: ratingsReceived >= 1 },
  }
}

// P0-1: 客户端传 local_date (YYYY-MM-DD) 时优先用之；缺失或非法时 fallback UTC
// 防作弊：local_date 必须在 server UTC 日 ±1 天范围内
function resolveCheckinDate(clientDate: string | undefined): string {
  const utcToday = new Date().toISOString().slice(0, 10)
  if (!clientDate || !/^\d{4}-\d{2}-\d{2}$/.test(clientDate)) return utcToday
  const utcMs = Date.now()
  const clientMs = new Date(clientDate + 'T12:00:00Z').getTime()  // 取 client date 中午做对齐
  if (!Number.isFinite(clientMs)) return utcToday
  if (Math.abs(clientMs - utcMs) > 36 * 3600 * 1000) return utcToday  // ±36h 超过则不信任
  return clientDate
}

// 签到+任务 3 endpoints — Phase 99 已迁出
registerCheckinTasksRoutes(app, {
  db, auth, isTrustedRole, errorRes, generateId, getProtocolParam,
  resolveCheckinDate, TASK_DEFS, computeTaskProgress, disbursePlatformReward,
  broadcastSystemEvent,
})

// #1013 Phase 112: recommendations/me + feed + nearby 已迁出 (在文件下方统一 register)

// ─── Wave E-1: 商家店铺主页 ──────────────────────────────
// #1013 Phase 34: 2 endpoints 已迁出到 routes/shops.ts
registerShopsRoutes(app, { db, auth })

// Wave D-1: 关注卖家动态 Feed (#1013 Phase 35) — 已迁出到 routes/follows.ts

// GET /api/orders/export — Phase 83 已迁出

// feed — Phase 112 已迁出

// ─── P-Distrib β：分布式内容层 ──────────────────────────────

// 外链平台识别 + 缩略图（不下载内容字节）
function detectExternalPlatform(url: string): { type: string; platform: string; video_id?: string; thumbnail?: string } {
  if (!url || typeof url !== 'string') return { type: 'external_url', platform: 'unknown' }
  try {
    const u = new URL(url)
    const h = u.hostname.toLowerCase()
    if (h.includes('youtube.com') || h.includes('youtu.be')) {
      let vid = u.searchParams.get('v') || ''
      if (!vid && h.includes('youtu.be')) vid = u.pathname.slice(1)
      if (!vid && u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/')[2] || ''
      return {
        type: 'external_youtube', platform: 'youtube',
        video_id: vid || undefined,
        thumbnail: vid ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg` : undefined,
      }
    }
    if (h.includes('tiktok.com')) {
      const m = u.pathname.match(/\/video\/(\d+)/)
      return { type: 'external_tiktok', platform: 'tiktok', video_id: m?.[1] }
    }
    if (h.includes('xiaohongshu.com') || h.includes('xhslink.com')) {
      return { type: 'external_xhs', platform: 'xiaohongshu' }
    }
    if (h.includes('bilibili.com')) {
      const m = u.pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av\d+)/)
      return { type: 'external_bilibili', platform: 'bilibili', video_id: m?.[1] }
    }
    if (h.includes('instagram.com')) return { type: 'external_ig', platform: 'instagram' }
    if (h.includes('twitter.com') || h.includes('x.com')) return { type: 'external_twitter', platform: 'twitter' }
    return { type: 'external_url', platform: 'unknown' }
  } catch {
    return { type: 'external_url', platform: 'unknown' }
  }
}

const SHAREABLE_DAILY_LIMIT = 10

// 2026-05-22 audit P1：# 话题/标签解析
// 支持中文 / 英文 / 数字 / 下划线，长度 1-30 字符
// 形式：#标签 (空格/标点结尾) 或 #标签# (闭合式，小红书风格)
// 同一笔记最多 10 个 tag（防滥用 SEO 刷词）
const TAG_MAX_PER_NOTE = 10
const TAG_MAX_LEN = 30
const HASHTAG_RE = /#([\p{L}\p{N}_]{1,30})#?/gu

// 2026-05-22 COP 飞轮：笔记真实性徽章
// verified_buyer = related_order_id 对应 owner 的 completed 订单 + 笔记在订单完成 30d 内
// original_photos = photo_hashes 非空（协议已强制跨笔记唯一，故只要存在即原创）
// 暴露这两条已存在的协议保证给读者，让笔记自带信任信号
const NOTE_VERIFIED_BUYER_WINDOW_DAYS = 30
function noteAuthenticityBadges(row: { owner_id: unknown; related_order_id: unknown; photo_hashes: unknown; created_at: unknown }): { verified_buyer: boolean; original_photos: boolean } {
  let verified_buyer = false
  if (row.related_order_id) {
    const o = db.prepare(`SELECT buyer_id, status, updated_at FROM orders WHERE id = ?`).get(row.related_order_id as string) as { buyer_id: string; status: string; updated_at: string } | undefined
    if (o && o.buyer_id === row.owner_id && ['completed', 'confirmed'].includes(o.status)) {
      const noteTime = new Date(row.created_at as string).getTime()
      const orderTime = new Date(o.updated_at).getTime()
      const days = (noteTime - orderTime) / (24 * 60 * 60 * 1000)
      if (days >= -1 && days <= NOTE_VERIFIED_BUYER_WINDOW_DAYS) verified_buyer = true
    }
  }
  let photos: unknown[] = []
  if (typeof row.photo_hashes === 'string') {
    try { photos = JSON.parse(row.photo_hashes) } catch {}
  } else if (Array.isArray(row.photo_hashes)) {
    photos = row.photo_hashes
  }
  return { verified_buyer, original_photos: photos.length > 0 }
}

function parseHashtags(text: string): string[] {
  if (!text || typeof text !== 'string') return []
  const found = new Set<string>()
  const matches = text.matchAll(HASHTAG_RE)
  for (const m of matches) {
    const raw = m[1].trim().toLowerCase()
    if (raw.length === 0 || raw.length > TAG_MAX_LEN) continue
    found.add(raw)
    if (found.size >= TAG_MAX_PER_NOTE) break
  }
  return Array.from(found)
}

// 2026-05-22 audit P1：@用户提及解析
// handle 协议 ASCII-only [a-z0-9._]+ 3-20 字符（与 anchor handle 规则一致）
// 同一笔记/评论最多 10 个 @（防滥用 spam）
const MENTION_MAX_PER_ITEM = 10
const MENTION_RE = /@([a-z0-9._]{3,20})\b/gi

function parseMentions(text: string): Array<{ handle: string; user_id: string }> {
  if (!text || typeof text !== 'string') return []
  const found = new Set<string>()
  const matches = text.matchAll(MENTION_RE)
  for (const m of matches) {
    const handle = m[1].toLowerCase()
    found.add(handle)
    if (found.size >= MENTION_MAX_PER_ITEM) break
  }
  if (found.size === 0) return []
  // 查 users 表确认 handle 存在 + active
  const placeholders = Array.from(found).map(() => '?').join(',')
  const users = db.prepare(`SELECT id, handle FROM users WHERE handle IN (${placeholders}) AND id != 'sys_protocol'`).all(...Array.from(found)) as Array<{ id: string; handle: string }>
  return users.map(u => ({ handle: u.handle, user_id: u.id }))
}

// 给被 @ 的用户推送通知
// kind: 'note' | 'comment'
function notifyMentions(mentions: Array<{ handle: string; user_id: string }>, fromUserId: string, kind: 'note' | 'comment', noteId: string, preview: string) {
  if (mentions.length === 0) return
  const fromName = (db.prepare("SELECT handle, name FROM users WHERE id = ?").get(fromUserId) as { handle: string | null; name: string } | undefined)
  const fromLabel = fromName?.handle ? '@' + fromName.handle : (fromName?.name || 'someone')
  for (const m of mentions) {
    if (m.user_id === fromUserId) continue   // 不 @ 自己
    try {
      const actions = JSON.stringify([{ kind: 'navigate', label: '查看', href: `#note/${noteId}`, style: 'primary' }])
      const type = kind === 'note' ? 'mention_note' : 'mention_comment'
      const title = kind === 'note' ? `📝 ${fromLabel} 在笔记中提到了你` : `💬 ${fromLabel} 在评论中提到了你`
      db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id, actions) VALUES (?,?,?,?,?,?,?)`)
        .run(generateId('ntf'), m.user_id, type, title, preview.slice(0, 100), null, actions)
    } catch (e) { console.warn('[notif mention]', (e as Error).message) }
  }
}

// ─── Shareables CRUD（外链 + 笔记 + creator stats + feed）─────
// #1013 Phase 13: 11 endpoints 已迁出到 routes/shareables.ts
registerShareablesRoutes(app, {
  db, auth, getUser, generateId, lightAuthGuard,
  detectExternalPlatform, noteAuthenticityBadges, parseHashtags,
  parseMentions, notifyMentions, flagNewAccountShareable, refreshProductSharerCount,
})

// ─── Shareables 互动（click/like/comments/bookmark）─────────
// #1013 Phase 12: 8 endpoints 已迁出到 routes/shareables-interactions.ts
registerShareablesInteractionsRoutes(app, {
  db, auth, generateId, rateLimitOk,
  piiSanitize, detectFraud, commentBlocklistHit, llmModerateComment,
  parseMentions, notifyMentions,
})

registerLeaderboardRoutes(app, { db, internalAuditorId: INTERNAL_AUDITOR_ID, rateLimitOk })


// like-status / bookmark-status / bookmarked-shareables 已迁出 (#1013 Phase 12)

// ─── Manifest Registry API（原生 P2P 内容索引，零字节存储）─────
// ============================================================
// P2P 商店 API — 详情存卖家节点，WebAZ 只锚 hash + 关键字段
// ============================================================
const P2P_THUMB_MAX = 16000   // ≤16KB base64 ≈ 12KB 原图
const P2P_TITLE_MAX = 80
const P2P_DAILY_CAP = 30

// 卖家用 api_key 作密钥 HMAC-SHA256 签 content_hash + signed_at
function verifyP2pSig(contentHash: string, signedAt: string, apiKey: string, signature: string): boolean {
  if (!contentHash || !signedAt || !apiKey || !signature) return false
  const expected = crypto.createHmac('sha256', apiKey).update(`${contentHash}|${signedAt}`).digest('hex')
  return expected === signature
}

// P0：peer_endpoint URL 白名单 — 必须 http(s)://
function isValidPeerEndpoint(url: string): boolean {
  if (!url) return true   // 允许空
  return /^https?:\/\/[a-zA-Z0-9]/.test(url)
}

// P1：signed_at 在 [now-24h, now+5min] 内才接受
function isFreshSignedAt(signedAt: string): boolean {
  const t = Date.parse(signedAt.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t)) return false
  const now = Date.now()
  return t >= now - 24 * 3600 * 1000 && t <= now + 5 * 60 * 1000
}

// #1013 Phase 96: 5 p2p-products endpoints 已迁出
registerP2pProductsRoutes(app, {
  db, auth, generateId, verifyP2pSig, isValidPeerEndpoint, isFreshSignedAt,
  P2P_TITLE_MAX, P2P_THUMB_MAX, P2P_DAILY_CAP, RFQ_MAX_PRICE, RFQ_MAX_QTY,
})

registerManifestsRoutes(app, { db, auth, safeRoles })

// ─── Peer directory（在线节点 + heartbeat）─────
// #1013 Phase 102: peers heartbeat + delete 已迁出
registerPeersRoutes(app, { db, auth })

// ─── Signaling 中继（WebRTC SDP / ICE 短期队列）─────
// #1013 Phase 71: 2 signaling endpoints 已迁出
registerSignalingRoutes(app, { db, auth, generateId })


// ─── Pin receipts（pinner+recipient 双签）─────
// #1013 Phase 71: 2 pin-receipts endpoints 已迁出
registerPinReceiptsRoutes(app, { db, auth, generateId })


// Cleanup cron — signaling 2min 失效 + peer 24h 失效
setInterval(() => {
  try { db.prepare("DELETE FROM signaling_queue WHERE created_at < datetime('now', '-2 minutes')").run() } catch {}
  try { db.prepare("DELETE FROM peer_directory WHERE last_heartbeat < datetime('now', '-24 hours') AND is_owner = 0").run() } catch {}
}, 60_000)

// ─── settlePinRewards：订单完成时从 basin 拨 0.5% 分给 recent pinners ─────
const PIN_REWARD_RATE_OF_ORDER = 0.005

function settlePinRewards(orderId: string): { total_paid: number; pinner_count: number } {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown> | undefined
  if (!order || !order.product_id) return { total_paid: 0, pinner_count: 0 }
  if (order.settled_pin_at) return { total_paid: 0, pinner_count: 0 }   // 幂等

  const total = Number(order.total_amount)
  const rewardPool = Math.round(total * PIN_REWARD_RATE_OF_ORDER * 100) / 100
  if (rewardPool <= 0) {
    db.prepare("UPDATE orders SET settled_pin_at = datetime('now') WHERE id = ?").run(orderId)
    return { total_paid: 0, pinner_count: 0 }
  }

  const manifests = db.prepare(`SELECT hash FROM manifest_registry WHERE related_product_id = ? AND status = 'active'`).all(order.product_id) as { hash: string }[]
  if (manifests.length === 0) {
    db.prepare("UPDATE orders SET settled_pin_at = datetime('now') WHERE id = ?").run(orderId)
    return { total_paid: 0, pinner_count: 0 }
  }
  const hashes = manifests.map(m => m.hash)
  const placeholders = hashes.map(() => '?').join(',')
  const sinceTs = new Date(Date.now() - 30 * 86400_000).toISOString()
  const receipts = db.prepare(`
    SELECT id, pinner_id, bytes_served FROM pin_receipts
    WHERE recipient_id = ? AND manifest_hash IN (${placeholders}) AND rewarded_at IS NULL AND served_at > ?
    ORDER BY served_at DESC LIMIT 5
  `).all(order.buyer_id, ...hashes, sinceTs) as { id: string; pinner_id: string; bytes_served: number }[]
  if (receipts.length === 0) {
    db.prepare("UPDATE orders SET settled_pin_at = datetime('now') WHERE id = ?").run(orderId)
    return { total_paid: 0, pinner_count: 0 }
  }
  const basin = db.prepare("SELECT pool_balance FROM global_fund WHERE id = 1").get() as { pool_balance: number }
  if (basin.pool_balance < rewardPool) {
    db.prepare("UPDATE orders SET settled_pin_at = datetime('now') WHERE id = ?").run(orderId)
    return { total_paid: 0, pinner_count: 0 }
  }

  // 去重：同一 pinner 仅一份；之后均分
  const uniquePinners = new Set<string>()
  const eligible: typeof receipts = []
  for (const r of receipts) {
    if (r.pinner_id === order.buyer_id) continue
    if (uniquePinners.has(r.pinner_id)) continue
    uniquePinners.add(r.pinner_id)
    eligible.push(r)
    if (eligible.length >= 5) break
  }
  if (eligible.length === 0) {
    db.prepare("UPDATE orders SET settled_pin_at = datetime('now') WHERE id = ?").run(orderId)
    return { total_paid: 0, pinner_count: 0 }
  }
  const perPinner = Math.round(rewardPool / eligible.length * 100) / 100
  let totalPaid = 0

  for (const r of eligible) {
    db.prepare("UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?").run(perPinner, perPinner, r.pinner_id)
    db.prepare(`UPDATE pin_receipts SET rewarded_waz = ?, rewarded_at = datetime('now'), related_order_id = ? WHERE id = ?`)
      .run(perPinner, orderId, r.id)
    db.prepare(`INSERT INTO commission_records (id, order_id, beneficiary_id, source_buyer_id, level, amount, rate, region, source)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(generateId('comm'), orderId, r.pinner_id, order.buyer_id, 0, perPinner, 0, (order.region as string) || 'global', 'pin')
    totalPaid += perPinner
  }
  if (totalPaid > 0) {
    db.prepare("UPDATE global_fund SET pool_balance = pool_balance - ? WHERE id = 1").run(totalPaid)
  }
  db.prepare("UPDATE orders SET settled_pin_at = datetime('now') WHERE id = ?").run(orderId)
  return { total_paid: Math.round(totalPaid * 100) / 100, pinner_count: eligible.length }
}

// P15 雷达扫描：cell 精度 helper（从 protocol_param 读，DAO 可调）
// approx_km 用纬度近似：1° latitude ≈ 111km；经度按 cos(lat) 缩短，但 cell 视为正方边 = 纬度方向距离
function getNearbyCellPrecision(): { precision_deg: number; approx_km: number } {
  // F2 修：防 0 / 负值（DAO 写入层校验失效时仍保 quantizeCoord 不除 0）
  const raw = getProtocolParam<number>('nearby_cell_precision_deg', 0.1)
  const precision = Number.isFinite(raw) && raw > 0 ? Math.max(0.01, Math.min(10, raw)) : 0.1
  return { precision_deg: precision, approx_km: Math.round(precision * 111 * 10) / 10 }
}
function quantizeCoord(value: number, precision_deg: number): number {
  // 例：precision=0.1 → factor=10；precision=0.05 → factor=20
  const factor = 1 / precision_deg
  return Math.round(value * factor) / factor
}

// #1013 Phase 57: 2 location endpoints 已迁出到 routes/profile-location.ts
registerProfileLocationRoutes(app, { db, auth, getNearbyCellPrecision })

// nearby — Phase 112 已迁出
registerBuyerFeedsRoutes(app, {
  db, auth, isTrustedRole, errorRes,
  getNearbyCellPrecision, getProtocolParam,
})
// 我的订单（买家或卖家视角）
// GET /api/orders — Phase 83 已迁出

// 订单详情
// ─── Store-and-Forward 协议层 ────────────────────────────────
// #1013 Phase 41: 11 endpoints 已迁出到 routes/snf.ts
registerSnfRoutes(app, { db, auth })

// ─── E1 流量口令注册中心 ────────────────────────────────────────
// #1013 Phase 43: 5 endpoints 已迁出到 routes/anchors.ts
registerAnchorsRoutes(app, { db, auth, rateLimitOk })

// #1013 Phase 42: 10 external-anchors endpoints 已迁出到 routes/external-anchors.ts
registerExternalAnchorsRoutes(app, { db, auth })

// GET /api/orders/:id/chain + GET /api/orders/:id — Phase 83 已迁出

// #1013 Phase 109: checkout/tax-preview + verify-price 已迁出
registerCheckoutHelpersRoutes(app, {
  db, auth, generateId, formatProductForAgent,
  signPassport: (message: string) => walletSigner.issuerSignMessage(message),
  issuerAddress: () => walletSigner.issuerAddress(),
})


// ─── M8 二手板块 ────────────────────────────────────────────
// #1013 Phase 27: 6 endpoints + 4 SH_* sets + addHours 已迁出到 routes/secondhand.ts
registerSecondhandRoutes(app, { db, generateId, auth, errorRes })

// 7. 面交完成确认（绕开物流状态机；仅 in-person 订单）
// POST /api/orders/:id/confirm-in-person — Phase 84 已迁出

// #1013 Phase 103: logistics companies + orders 已迁出
registerLogisticsRoutes(app, { db, auth })

// POST /api/orders/:id/action — Phase 84 已迁出

// 钱包 — Phase 80 已迁出

// #1013 Phase 111: admin/health 已迁出（publicClient 在下方 const，用 getter 避免 TDZ）
registerAdminHealthRoutes(app, {
  db,
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  getPublicClient: () => publicClient,
  getRpcUrl: () => rpcUrl,
  getNetwork: () => NETWORK,
  adminEventClients, sseClients, systemEventBuffer, authFailures,
})


// Wave G-2: deposit-qr + rate — Phase 80 已迁出

// ─── Wave G-1: 钱包连接 — Phase 81 已迁出 ─────────────────

// 提现申请 + 大额邮件确认 — Phase 81 已迁出

// ─── 提现白名单管理 ──────────────────────────────────────────
function maskEmail(email: string): string {
  const [u, d] = email.split('@')
  if (!u || !d) return email
  return u.slice(0, 2) + '***@' + d
}

// whitelist GET/POST/DELETE + withdrawals GET — Phase 80 已迁出

// 用户取消 pending withdrawal — Phase 81 已迁出

// /api/wallet/deposits + getCachedLatestBlock helper — Phase 80 已迁出
// deposits + income — Phase 80 已迁出

// ─── 管理员端点 ───────────────────────────────────────────────

function adminAuth(req: Request, res: Response): boolean {
  const adminKey = process.env.ADMIN_KEY
  if (!adminKey) { res.status(503).json({ error: '管理功能未启用（未设置 ADMIN_KEY）' }); return false }
  if (req.headers['x-admin-key'] !== adminKey) { res.status(403).json({ error: '认证失败' }); return false }
  return true
}


// /api/wallet/topup — Phase 80 已迁出

// 物流：可接订单 + 我的进行中订单 — Phase 103 已迁出

// ─── 结算 ──────────────────────────────────────────────────────

// 推土机分享现金分润结算（订单 completed 时调用，幂等）
const LEVEL_RATES: Record<number, number> = { 1: 0.70, 2: 0.20, 3: 0.10 }

// 区域裁决：返回该 region 允许的最大分润级数（global/us/eu = 3, china = 2）
// Phase B：MLM gate — 返回用户所在地区的 MLM 合规参数
// payoutLevels=0 → 完全禁 MLM；mlmUiVisible=false → UI 隐藏推土机/分润链
function userMlmGate(userRegion: string): { payoutLevels: 0|1|2|3; mlmUiVisible: boolean } {
  const row = db.prepare(`SELECT max_levels, mlm_ui_visible FROM region_config WHERE region = ?`).get(userRegion) as { max_levels: number; mlm_ui_visible: number } | undefined
  const payoutLevels = (row?.max_levels ?? 3) as 0|1|2|3
  // mlm_ui_visible 默认 1；max_levels=0 时强制隐藏
  const mlmUiVisible = payoutLevels > 0 && (row?.mlm_ui_visible ?? 1) === 1
  return { payoutLevels, mlmUiVisible }
}

function getRegionMaxLevels(region: string): number {
  const row = db.prepare("SELECT max_levels FROM region_config WHERE region = ?").get(region) as { max_levels: number } | undefined
  // 未知地区采取**保守 fallback**：默认 1（仅 L1）— 避免在未审计合规的国家暴露 L2/L3 风险
  // 已显式审计且合规允许的地区在 region_config 表里设 2 或 3
  return row?.max_levels ?? 1
}

// PV 匹配奖励的【区域兑付过滤器】—— 不是奖励总闸。与 max_levels（佣金层级）独立。
// 总闸是全局 Category C 双闸（见 pv-kill-switch.ts）：实际兑付仍必须同时满足
// matching_rewards_active='1' + matching_rewards_activation_cleared='1'；本函数只是其后的额外区域过滤。
// 未配置 / 未知地区返回 false，表示该地区过滤器不允许兑付（保守默认）。
function regionPvEnabled(region: string): boolean {
  const row = db.prepare("SELECT pv_enabled FROM region_config WHERE region = ?").get(region) as { pv_enabled: number } | undefined
  return Number(row?.pv_enabled ?? 0) === 1
}

// 派发结果：pool=总额，redirected=回流入基金池的部分；source=static 静态链路 / dynamic L3 动态绑定
type CommissionResult = { pool: number; redirected: number; source: 'static' | 'dynamic' }

// effectiveBase 可选 — partial_refund / liability_split 时按实际成交金额发放
// 默认 undefined → 用 order.total_amount（正常完成 / release_seller）
function settleCommission(orderId: string, effectiveBase?: number): CommissionResult {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown> | undefined
  if (!order) return { pool: 0, redirected: 0, source: 'static' }
  if (order.settled_commission_at) return { pool: 0, redirected: 0, source: 'static' }   // 幂等

  const total = effectiveBase != null ? Number(effectiveBase) : Number(order.total_amount)
  const rate = Number(order.snapshot_commission_rate ?? 0.10)
  if (rate <= 0 || total <= 0) return { pool: 0, redirected: 0, source: 'static' }

  // H-2 fix：优先读 orders.buyer_region 快照（下单时锁定的 region），未填则回退到 live users.region
  let region = (order.buyer_region as string | null) || null
  if (!region) {
    const buyer = db.prepare("SELECT region FROM users WHERE id = ?").get(order.buyer_id) as { region: string } | undefined
    region = buyer?.region ?? 'global'
  }
  const maxLevels = getRegionMaxLevels(region)
  // RFC-014:佣金池 + 三级拆分走整数 base-units;allocate 保证 L1+L2+L3 ≡ pool(精确,修旧版逐项 round2 不守恒暗缝)。
  const poolU = mulRate(toUnits(total), rate)
  const pool = toDecimal(poolU)

  // max_levels=0 → 完全禁 MLM，整个 commission pool 入 commission_reserve（三级公池，只进不出）
  // 2026-06-04 修双计 bug：旧版既 redirectToCharity 又 return redirected:pool 让 depositToFund 再入 global_fund → 印钱。
  // 现统一入 commission_reserve 一次，return redirected:0（depositToFund 只拿 1% base）。
  if (maxLevels === 0) {
    redirectToCommissionReserve(pool, 'redirect_region_cap', { orderId, note: '区域禁 MLM — max_levels=0，整池入三级公池' })
    db.prepare("UPDATE orders SET settled_commission_at = datetime('now') WHERE id = ?").run(orderId)
    return { pool, redirected: 0, source: 'static' }
  }

  // 100% per-product attribution：L1/L2/L3 已在订单创建期由 getProductShareChain() 写入
  const l1Uid = order.l1_uid as string | null
  const l2Uid = order.l2_uid as string | null
  const l3Uid = order.l3_uid as string | null
  const routeSource: 'static' | 'dynamic' = 'static'  // 'static' 字面值保留兼容旧统计
  const recipients = [
    { level: 1, beneficiary: l1Uid },
    { level: 2, beneficiary: l2Uid },
    { level: 3, beneficiary: l3Uid },
  ]

  // #7 Commission source_type — 查 attribution 找到带来 buyer 的 shareable，确定 channel 类型
  // 反推: 该 uid 作为 sharer 把 product 分享给"下家"的 shareable 类型
  function resolveSourceType(uid: string | null): 'note' | 'link' | 'sponsor' {
    if (!uid) return 'sponsor'
    const attr = db.prepare(`
      SELECT shareable_id FROM product_share_attribution
      WHERE product_id = ? AND sharer_id = ? AND shareable_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(order!.product_id, uid) as { shareable_id: string } | undefined
    if (!attr) return 'sponsor'
    const sh = db.prepare(`SELECT type FROM shareables WHERE id = ?`).get(attr.shareable_id) as { type: string } | undefined
    if (!sh) return 'sponsor'
    return sh.type === 'note' ? 'note' : 'link'
  }

  // 2026-06-04：所有兜底统一入 commission_reserve（三级公池，独立科目，只进不出）。
  // commission 不再回流 global_fund（PV 资金）—— 三套科目解耦，redirected 始终 0。
  let toCommissionReserve = 0     // → commission_reserve（仅作日志/返回信息用）
  // 三级金额一次性 allocate(精确求和 ≡ poolU);各级再按 gate 路由到钱包/公池/escrow。
  const levelAmtU = allocate(poolU, [LEVEL_RATES[1], LEVEL_RATES[2], LEVEL_RATES[3]])
  for (const { level, beneficiary } of recipients) {
    const amountU = levelAmtU[level - 1]
    const amount = toDecimal(amountU)
    if (amountU <= 0) continue

    // ① region 截断 (level>maxLevels) → 三级公池
    if (level > maxLevels) {
      redirectToCommissionReserve(amount, 'redirect_region_cap', { orderId, fromUserId: order.buyer_id as string, note: `L${level} > maxLevels=${maxLevels} 区域截断` })
      toCommissionReserve += amount
      continue
    }

    // ② chain 缺失 (自发现 / 上家断链) → 三级公池
    if (!beneficiary) {
      redirectToCommissionReserve(amount, 'redirect_chain_gap', { orderId, fromUserId: order.buyer_id as string, note: `L${level} 空缺` })
      toCommissionReserve += amount
      continue
    }

    // ③ sponsor 资格无效 (被封 / 无 verify) → 三级公池
    if (!isAllowedSponsor(beneficiary)) {
      redirectToCommissionReserve(amount, 'redirect_orphan_sponsor', { orderId, fromUserId: order.buyer_id as string, note: `L${level} sponsor 不合规: ${beneficiary}` })
      toCommissionReserve += amount
      continue
    }

    // ④ RFC-002 §3.5 opt-in gate (PR-1c-a)
    //   opted-in        → normal credit (⑤)
    //   opted-out + last action 'deactivate' → directly 三级公池 (主动放弃)
    //   opted-out + other (never_activated | auto_downgrade) → pending_commission_escrow
    const optIn = (db.prepare("SELECT rewards_opted_in FROM users WHERE id = ?").get(beneficiary) as { rewards_opted_in: number } | undefined)?.rewards_opted_in ?? 0
    if (optIn !== 1) {
      const lastAction = (db.prepare("SELECT action FROM rewards_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(beneficiary) as { action: string } | undefined)?.action
      if (lastAction === 'deactivate') {
        redirectToCommissionReserve(amount, 'redirect_opt_out_deactivated', { orderId, fromUserId: order.buyer_id as string, note: `L${level} ${beneficiary} actively deactivated rewards` })
        toCommissionReserve += amount
        continue
      }
      // never_activated OR auto_downgrade → escrow (30d window per protocol_params.rewards_opt_in.escrow_days)
      const escrowDays = Number((db.prepare("SELECT value FROM protocol_params WHERE key = 'rewards_opt_in.escrow_days'").get() as { value: string } | undefined)?.value ?? 30)
      const now = Date.now()
      try {
        db.prepare(`INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at) VALUES (?,?,?,?,'pending',?,?)`)
          .run(beneficiary, orderId, amount, `L${level}`, now, now + escrowDays * 86400 * 1000)
      } catch (e) { /* UNIQUE 冲突 — settleCommission 重入幂等 */ }
      continue
    }

    // ⑤ 正常分账
    try {
      const srcType = resolveSourceType(beneficiary)
      db.prepare(`INSERT INTO commission_records (id, order_id, beneficiary_id, source_buyer_id, level, amount, rate, region, source, source_type)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(generateId('comm'), orderId, beneficiary, order.buyer_id, level, amount, rate, region, routeSource, srcType)
      applyWalletDelta(db, beneficiary, { balance: amountU, earned: amountU })
    } catch (e) { /* UNIQUE 冲突 */ }
  }
  db.prepare("UPDATE orders SET settled_commission_at = datetime('now') WHERE id = ?").run(orderId)
  // redirected 恒为 0：commission 兜底全部入 commission_reserve，不再回流 global_fund(PV 资金)。
  // toCommissionReserve 仅作日志参考（实际入账已在循环里逐笔落 commission_reserve_txns）。
  void toCommissionReserve
  return { pool, redirected: 0, source: routeSource }
}

// ─── 原子能：基金池入金 (depositToFund) ──────────────────────────
// 1% 永远入池（默认）；commission 端回流由 settleCommission 返回，作为 extraFromCommission 传入
// （回流来源：区域 max_levels<3 裁决 + 全员 verified gate 未通过）
// 2026-05-22 audit P1：getter 实时读 protocol_params，admin 可动态调（地区/合规差异化）
const FUND_BASE_RATE = () => getProtocolParam<number>('fund_base_rate', 0.01)

// V3 用户成长等级（基于历史累积 score = 历史累积 WAZ 收益元值）
// 宇宙天体主题：从尚未点燃的星尘，到普照万物的创世太阳
//   L0 沧海一粟 (A Drop in the Cosmos) — 寄蜉蝣于天地，渺沧海之一粟（苏轼）
//   L1 星星之火 (Cosmic Spark)   — 始于微末，个体觉醒的一缕宇宙微光
//   L2 旷野火把 (Wildfire Torch) — 汇聚成炬，在 AI 旷野上点燃的人类薪火
//   L3 迷雾灯塔 (Nexus Beacon)   — 破开迷雾，地面上最宏伟的坐标与连接纽带
//   L4 苍穹繁星 (Astral Constellation) — 星连成网，繁星连成人类星网
//   L5 北斗七星 (The Big Dipper) — 终极指针，全盘跨越区域的方向图腾
//   L6 不落月亮 (Eternal Moon)   — 执掌夜空，引力潮汐辐射全球
//   L7 创世太阳 (Genesis Sun)    — 万物普照，终极天体无上荣光
const USER_LEVELS: Array<{ level: number; threshold: number; name: string }> = [
  { level: 7, threshold: 2_000_000, name: '创世太阳' },
  { level: 6, threshold:   500_000, name: '不落月亮' },
  { level: 5, threshold:   100_000, name: '北斗七星' },
  { level: 4, threshold:    30_000, name: '苍穹繁星' },
  { level: 3, threshold:     5_000, name: '迷雾灯塔' },
  { level: 2, threshold:     1_000, name: '旷野火把' },
  { level: 1, threshold:         1, name: '星星之火' },
  { level: 0, threshold:         0, name: '沧海一粟' },
]
function getUserLevel(lifetimeScore: number): { level: number; name: string; nextThreshold: number | null } {
  for (const t of USER_LEVELS) {
    if (lifetimeScore >= t.threshold) {
      const next = USER_LEVELS.find(x => x.level === t.level + 1)
      return { level: t.level, name: t.name, nextThreshold: next?.threshold ?? null }
    }
  }
  return { level: 0, name: '游客', nextThreshold: 1 }
}

// V3 PV 单位：每 100 元成交 = 1 PV（pv_multiplier 默认 1.0）
// MAX_PV_PER_ORDER 1000 防单笔暴增 — 单笔订单最多产生 1000 PV (= 10 万元封顶)
// 溢出部分作"协议留存"，等同基金池入金(预留池,当前无消费方)
const PV_PER_YUAN = 0.01
const MAX_PV_PER_ORDER = 1000

function calculatePv(amount: number, multiplier: number = 1.0): number {
  // Category C: PV 是【参与记录】(非收益/非兑付)→ 默认 ON,只在 participation_recording 显式关闭时不生成。
  if (!participationRecordingActive(db)) return 0
  // 防御：负值 / NaN / Infinity 直接返回 0（不写入 pv_ledger）
  if (!Number.isFinite(amount) || amount <= 0) return 0
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0
  const raw = amount * PV_PER_YUAN * multiplier
  return Math.min(MAX_PV_PER_ORDER, Math.round(raw * 100) / 100)
}

// effectiveBase 可选 — partial_refund / liability_split 时按实际成交金额计算 1% 入池
function depositToFund(orderId: string, extraFromCommission: number = 0, effectiveBase?: number): { base: number; redirect: number; total: number } {
  // H-2 fix：优先用 orders.buyer_region 快照；为空（旧订单）才回退 users.region 活值
  const order = db.prepare(
    `SELECT o.id, o.total_amount, COALESCE(o.buyer_region, u.region) as buyer_region
     FROM orders o LEFT JOIN users u ON u.id = o.buyer_id WHERE o.id = ?`
  ).get(orderId) as Record<string, unknown> | undefined
  if (!order) return { base: 0, redirect: 0, total: 0 }
  // 幂等：同一 order 只入池一次
  if (db.prepare("SELECT 1 FROM fund_deposits WHERE order_id = ? LIMIT 1").get(orderId)) {
    return { base: 0, redirect: 0, total: 0 }
  }
  const total = effectiveBase != null ? Number(effectiveBase) : Number(order.total_amount)
  if (total <= 0) return { base: 0, redirect: 0, total: 0 }

  // RFC-014:整数 base-units + 绝对值落库
  const amountBaseU = mulRate(toUnits(total), FUND_BASE_RATE())
  const amountRedirectU = toUnits(Number(extraFromCommission || 0))
  const region = (order.buyer_region as string) || 'global'

  const totalDepositU = amountBaseU + amountRedirectU
  const amountBase = toDecimal(amountBaseU)
  const amountRedirect = toDecimal(amountRedirectU)
  const totalDeposit = toDecimal(totalDepositU)
  if (totalDepositU > 0) {
    // fund_deposits.amount_l3 字段语义已扩为「commission 端回流总额」（区域裁决 + 未 verified）
    db.prepare(`INSERT INTO fund_deposits (id, order_id, amount_base, amount_l3, buyer_region)
                VALUES (?,?,?,?,?)`).run(generateId('fd'), orderId, amountBase, amountRedirect, region)
    creditColumns(db, 'global_fund', 'id = 1', [], { pool_balance: totalDepositU })
  }
  return { base: amountBase, redirect: amountRedirect, total: totalDeposit }
}

// Phase A 2026-05-21：佣金未发出 → charity_fund（科目化）
// 2026-06-04：佣金兜底从 charity_fund 改入 commission_reserve（三级公池，独立科目，只进不出）。
//   region_cap = level>maxLevels 区域截断 + max_levels=0 整池
type CommissionRedirectKind =
  | 'redirect_chain_gap'
  | 'redirect_orphan_sponsor'
  | 'redirect_region_cap'
  | 'redirect_opt_out_deactivated'   // RFC-002 §3.5: recipient actively deactivated rewards
  | 'redirect_escrow_expired'        // RFC-002 §3.5b: pending escrow exceeded grace window
function redirectToCommissionReserve(
  amount: number,
  kind: CommissionRedirectKind,
  args: { orderId?: string; fromUserId?: string; note?: string } = {}
): void {
  if (!Number.isFinite(amount) || amount <= 0) return
  // RFC-014:整数 base-units + 绝对值落库(防 REAL `col = col + ?` 浮点 dust)。
  const aU = toUnits(amount)
  if (aU <= 0) return
  const a = toDecimal(aU)
  // Aggregate column mapping (commission_reserve_txns.kind records exact kind):
  //   chain_gap → total_chain_gap
  //   orphan_sponsor / opt_out_deactivated / escrow_expired → total_orphan_sponsor (no-eligible-recipient bucket)
  //   region_cap → total_region_cap
  const totalCol = kind === 'redirect_chain_gap' ? 'total_chain_gap'
    : kind === 'redirect_region_cap' ? 'total_region_cap'
    : 'total_orphan_sponsor'
  db.transaction(() => {
    creditColumns(db, 'commission_reserve', "id = 'main'", [], { balance: aU, [totalCol]: aU })
    db.prepare(`UPDATE commission_reserve SET updated_at = datetime('now') WHERE id = 'main'`).run()
    db.prepare(`INSERT INTO commission_reserve_txns (id, kind, from_user_id, amount, related_order_id, note)
                VALUES (?,?,?,?,?,?)`).run(generateId('crt'), kind, args.fromUserId || null, a, args.orderId || null, args.note || null)
  })()
}

function settleOrder(orderId: string) {
  // Bug-C fix：所有资金/PV/状态写入包在单一事务内，避免迁 PG / 多 worker 后出现部分提交
  // 内部 try/catch 用于非关键 hook（settlePinRewards / metrics 更新）失败不回滚资金主流程
  db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>
    const total = order.total_amount as number
    const isSecondhand = order.source === 'secondhand'
    const isInPerson = order.fulfillment_mode === 'in_person'
    // 二手商品没有 products 行，按 source 分支拿数据
    const product = isSecondhand
      ? { stake_amount: 0, stake_locked_at: 'na', category_id: null as string | null }
      : db.prepare('SELECT stake_amount, stake_locked_at, category_id FROM products WHERE id = ?').get(order.product_id as string) as { stake_amount: number; stake_locked_at: string | null; category_id: string | null }

    // M8：协议费率二手 1% (vs 商家 2%) — 鼓励个人发布
    const feeRate = isSecondhand ? 0.01 : 0.02
    // QA 轮 9.4 P0：settleOrder default 0 vs settleCommission default 0.10 不一致 → 印钱漏洞
    // 修：统一两处 default = 0.10（跟 PWA orders-create.ts:277 一致）
    const commissionRate = Number(order.snapshot_commission_rate ?? 0.10)
    // RFC-014:实际拆分在下方 computeSettlementSplit(整数 base-units,卖家净额 residual 吸收 → 精确守恒)。
    //   self-fulfill / 面交不收物流费(chargeLogistics=false);协议费 50/50 由 allocate 精确拆。

    // M7.2.6 方案 3 + M-4 fix：首单锁定 stake（trusted+ 跳过）
    // 用单语句 UPDATE ... WHERE stake_locked_at IS NULL 原子拿"是否首次"判定，
    // 避免读后写竞态（旧实现两条语句，迁 PG / 多 worker 时可能双锁）
    // M8: 二手商品无 stake 概念，跳过
    // RFC-008 stage 1：起步免赔付阶段(require_seller_stake=0)不锁 stake —— 与 settleFault 按 stake_backing(=0)结算一致,
    //   消除"成功时锁 product.stake_amount 但违约按 backing=0 不没收"的旧三口径不一致。收紧档(=1)由后续阶段统一在下单锁。
    const requireSellerStake = Number(getProtocolParam<number>('require_seller_stake', 0)) === 1
    let stakeToLock = 0
    if (!isSecondhand && requireSellerStake) {
      const lockResult = db.prepare(
        `UPDATE products SET stake_locked_at = datetime('now') WHERE id = ? AND stake_locked_at IS NULL`
      ).run(order.product_id as string)
      if (lockResult.changes === 1) {
        const sellerTrust = db.prepare(`SELECT level FROM reputation_scores WHERE user_id = ?`).get(order.seller_id as string) as { level: string } | undefined
        const trustedSkip = sellerTrust && ['trusted', 'quality', 'star', 'legend'].includes(sellerTrust.level)
        if (!trustedSkip && product.stake_amount > 0) stakeToLock = product.stake_amount
      }
    }

    // RFC-014:整数 base-units 精确拆分(卖家净额 = total − 其余各项,residual 吸收 → Σ ≡ total)。
    const totalU = toUnits(total)
    const split = computeSettlementSplit({
      totalU,
      feeRate,
      logisticsRate: 0.05,
      chargeLogistics: !isInPerson && !!order.logistics_id,   // self-fulfill / 面交 = 不收物流费
      commissionRate,
      fundRate: FUND_BASE_RATE(),
      stakeToLockU: toUnits(stakeToLock),
    })

    // 买家 escrow 释放 + 卖家净额 + 物流费(实扣即实付)+ 首单 stake 锁定 —— 全绝对值落库
    applyWalletDelta(db, order.buyer_id as string, { escrowed: -totalU })
    applyWalletDelta(db, order.seller_id as string, { balance: split.sellerAmountU, earned: split.sellerAmountU })
    if (order.logistics_id && split.logisticsActualU > 0) {
      applyWalletDelta(db, order.logistics_id as string, { balance: split.logisticsActualU, earned: split.logisticsActualU })
    }
    if (split.stakeToLockU > 0) applyWalletDelta(db, order.seller_id as string, { staked: split.stakeToLockU })

    // 协议费拆分：50% 注入协议储备池，50% 入 sys_protocol 运营
    if (split.protocolToReserveU > 0) creditColumns(db, 'protocol_reserve_pool', 'id = 1', [], { balance: split.protocolToReserveU })
    if (split.protocolToOpsU   > 0) applyWalletDelta(db, 'sys_protocol', { balance: split.protocolToOpsU })

    // 推土机分享分润：正常分账 → 钱包；兜底 → commission_reserve（三级公池，独立科目）
    settleCommission(orderId)

    // 原子能：PV 资金池入金 = 仅 1% base（2026-06-04 起 commission 不再回流此池，三科目解耦）
    depositToFund(orderId)

    // P-Distrib β：若 buyer 是经 pinner 传输内容才看到本商品 → settlePinRewards 从 basin 拨 0.5%
    try {
      const pr = settlePinRewards(orderId)
      if (pr.pinner_count > 0) console.log(`[P-Distrib] pin rewards: ${pr.total_paid} WAZ to ${pr.pinner_count} pinners`)
    } catch (e) { console.error('[settlePinRewards]', e) }

    // 原子能：PV 写入（资金/PV 解耦核心 — 按类目乘数计算 PV）
    const categoryId = product.category_id || 'cat_default'
    const catRow = db.prepare("SELECT pv_multiplier FROM product_categories WHERE id = ?").get(categoryId) as { pv_multiplier: number } | undefined
    const mPv = Number(catRow?.pv_multiplier ?? 1.0)
    const pv = calculatePv(total, mPv)
    if (pv > 0) {
      db.prepare(`INSERT INTO pv_ledger (id, order_id, buyer_id, pv, processed) VALUES (?,?,?,?,0)`)
        .run(generateId('pvl'), orderId, order.buyer_id, pv)
      db.prepare("UPDATE users SET pv_dirty_at = datetime('now') WHERE id = ?").run(order.buyer_id)
    }
    db.prepare("UPDATE orders SET settled_pv_at = datetime('now') WHERE id = ?").run(orderId)

    recordOrderReputation(db, orderId)

    // Tier 7：实时更新 product metrics（完成数 + 最近成交时间）
    // 里程碑 5：首单 → 写 first_sold_at（仅当 NULL，幂等）
    // M8: 二手商品无 products 行 → 改写 secondhand_items.sold_at + sold_order_id
    if (isSecondhand) {
      try {
        db.prepare(`UPDATE secondhand_items SET status='sold', sold_at=datetime('now'), sold_order_id=?, updated_at=datetime('now') WHERE id = ?`)
          .run(orderId, order.product_id as string)
      } catch (e) { console.error('[M8-hook secondhand sold]', e) }
    } else {
      try {
        db.prepare(`UPDATE products SET
          last_sold_at = datetime('now'),
          first_sold_at = COALESCE(first_sold_at, datetime('now')),
          completion_count = COALESCE(completion_count, 0) + 1
        WHERE id = ?`).run(order.product_id as string)
      } catch (e) { console.error('[Tier7-hook settleOrder]', e) }

      // P2: listing-bound product 完成 1 单 → 冷启动剩余减 1（最低 0）
      try {
        db.prepare(`UPDATE products
          SET cold_start_remaining = MAX(0, COALESCE(cold_start_remaining, 0) - 1)
          WHERE id = ? AND listing_id IS NOT NULL AND COALESCE(cold_start_remaining, 0) > 0
        `).run(order.product_id as string)
      } catch (e) { console.error('[P2 cold-start decrement]', e) }

      // P2: listing-bound product 总销量 +1 → listings.total_sales 同步
      try {
        const lid = db.prepare('SELECT listing_id FROM products WHERE id = ?').get(order.product_id as string) as { listing_id: string | null } | undefined
        if (lid?.listing_id) {
          db.prepare('UPDATE listings SET total_sales = total_sales + 1, updated_at = datetime(\'now\') WHERE id = ?').run(lid.listing_id)
        }
      } catch (e) { console.error('[P2 listing.total_sales increment]', e) }

      // P0.1：RFQ 订单完单成功 → 释放卖家 bid_stake_held（staked → balance）+ synthetic product 转 warehouse（P1.2 顺手修）
      try {
        const heldStakeU = toUnits(Number(order.bid_stake_held || 0))
        if (heldStakeU > 0 && order.source === 'rfq') {
          applyWalletDelta(db, order.seller_id as string, { balance: heldStakeU, staked: -heldStakeU })
        }
        // synthetic RFQ product（描述以 [RFQ 开头）卖完后转 warehouse，防 active feed 污染
        const pInfo = db.prepare('SELECT description, stock FROM products WHERE id = ?').get(order.product_id as string) as { description: string | null; stock: number } | undefined
        if (pInfo && Number(pInfo.stock) <= 0 && String(pInfo.description || '').startsWith('[RFQ ')) {
          db.prepare("UPDATE products SET status = 'warehouse', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string)
        }
      } catch (e) { console.error('[P0.1 bid_stake release / warehouse]', e) }
    }
  })()
}

// Tier 7：重新计算商品的独立分享者数
function refreshProductSharerCount(productId: string) {
  try {
    const row = db.prepare(`SELECT COUNT(DISTINCT owner_id) as n FROM shareables WHERE related_product_id = ? AND status = 'active'`).get(productId) as { n: number }
    db.prepare(`UPDATE products SET unique_sharer_count = ? WHERE id = ?`).run(row.n, productId)
  } catch (e) { console.error('[Tier7-hook refreshSharerCount]', e) }
}

// 2026-05-23 S5 极致性价比认证 — daily batch 计算
// 协议级算法（公开框架）：每个 category 内按 price 升序排，前 top_pct 标 value_badge
// 参数走 governance: value_badge_top_pct (默认 0.20) + value_badge_min_sample (默认 5)
// 注：仅 status=active + stock>0 的商品参与（避免下架商品锁定徽章）
function computeValueBadges(): { categories: number; total_products: number; badged: number; skipped_small: number } {
  const topPct = Math.max(0.05, Math.min(0.50, Number(getProtocolParam<number>('value_badge_top_pct', 0.20)) || 0.20))
  const minSample = Math.max(2, Math.floor(Number(getProtocolParam<number>('value_badge_min_sample', 5)) || 5))
  const now = new Date().toISOString()

  // 收集所有有 category 的活跃商品
  const products = db.prepare(`
    SELECT id, category, price FROM products
    WHERE status = 'active' AND stock > 0 AND category IS NOT NULL AND category != ''
    ORDER BY category ASC, price ASC
  `).all() as Array<{ id: string; category: string; price: number }>

  // 按 category 分组
  const byCategory: Record<string, Array<{ id: string; price: number }>> = {}
  for (const p of products) {
    if (!byCategory[p.category]) byCategory[p.category] = []
    byCategory[p.category].push({ id: p.id, price: Number(p.price) })
  }

  let totalCategories = 0, totalProducts = 0, badged = 0, skippedSmall = 0
  // 事务批量更新
  db.transaction(() => {
    // 先清空所有现有 badge（不论是否在 active 商品里）—— 让下架商品也丢失徽章
    db.prepare(`UPDATE products SET value_badge = 0, value_badge_rank = NULL, value_badge_pct = NULL`).run()

    for (const [cat, list] of Object.entries(byCategory)) {
      totalCategories++
      totalProducts += list.length
      if (list.length < minSample) { skippedSmall += list.length; continue }
      // 已按 price ASC 排序（SQL ORDER BY）— 取前 N 个
      const cutoff = Math.max(1, Math.floor(list.length * topPct))
      // 中位价计算（用于 pct）
      const mid = list[Math.floor(list.length / 2)].price
      for (let i = 0; i < cutoff; i++) {
        const p = list[i]
        const pct = mid > 0 ? Math.round((1 - p.price / mid) * 10000) / 10000 : 0   // 比中位低多少 %
        db.prepare(`UPDATE products SET value_badge = 1, value_badge_at = ?, value_badge_rank = ?, value_badge_pct = ? WHERE id = ?`)
          .run(now, i + 1, pct, p.id)
        badged++
      }
    }
  })()
  console.log(`[S5 value-badge] computed: ${badged}/${totalProducts} badged across ${totalCategories} categories (top ${(topPct * 100).toFixed(0)}%, min sample ${minSample}, skipped ${skippedSmall} from small-sample categories)`)
  return { categories: totalCategories, total_products: totalProducts, badged, skipped_small: skippedSmall }
}

// admin _dev/recompute-value-badges — Phase 106 已迁出

// ─── 通知 API ─────────────────────────────────────────────────
// #1013 Phase 36: 3 endpoints 已迁出到 routes/notifications.ts
registerNotificationsRoutes(app, { db, auth, sseClients })

// ─── Skill 市场 API ───────────────────────────────────────────
// #1013 Phase 33: 8 endpoints 已迁出到 routes/skills.ts
registerSkillsRoutes(app, { db, auth, getUser })
registerSkillMarketRoutes(app, {
  db, generateId, auth, getUser, getProtocolParam,
  requireContentAdmin: (req, res) => requireAdminPermission(req, res, 'content'),
})

// ─── Protocol Manifest（L0-5）────────────────────────────────

// manifest 公开 — Phase 107 已迁出

// 声誉 API ─────────────────────────────────────────────────────

// 4 维信誉指标：履约率 / 准时率 / 胜诉率 / 退款率
// sample_size < MIN_SAMPLE 时不显示具体数字 — 防小样本误导（如 1/1 = 100% 胜率）
const REP_MIN_SAMPLE = 5
function getSellerMetrics(userId: string): {
  sample_size: number
  is_new_seller: boolean
  fulfillment_rate: number | null
  on_time_rate: number | null
  dispute_win_rate: number | null
  dispute_count: number
  open_dispute_count: number
  refund_rate: number | null
} {
  const completed = (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE seller_id = ? AND status = 'completed'`).get(userId) as { n: number }).n
  const cancelled = (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE seller_id = ? AND status = 'cancelled'`).get(userId) as { n: number }).n
  const onTimeEvents = (db.prepare(`SELECT COUNT(*) as n FROM reputation_events WHERE user_id = ? AND event_type = 'on_time_ship'`).get(userId) as { n: number }).n
  const violations = (db.prepare(`SELECT COUNT(*) as n FROM reputation_events WHERE user_id = ? AND event_type = 'timeout_violation'`).get(userId) as { n: number }).n
  const won  = (db.prepare(`SELECT COUNT(*) as n FROM disputes WHERE defendant_id = ? AND ruling_type = 'release_seller'`).get(userId) as { n: number }).n
  const lost = (db.prepare(`SELECT COUNT(*) as n FROM disputes WHERE defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')`).get(userId) as { n: number }).n
  const refundsViaDispute = lost                       // 与 lost 同源 — 退款裁决即败诉
  const refundsViaReturn  = (db.prepare(`SELECT COUNT(*) as n FROM return_requests WHERE seller_id = ? AND status = 'refunded'`).get(userId) as { n: number }).n
  const refunds = refundsViaDispute + refundsViaReturn
  const disputeTotal = won + lost
  // 2026-05-22 audit P1：商品页 hero 三柱需 — 进行中争议数（红色警示用）
  const openDisputes = (db.prepare(`SELECT COUNT(*) as n FROM disputes WHERE defendant_id = ? AND ruling_type IS NULL AND created_at > datetime('now', '-90 days')`).get(userId) as { n: number }).n
  const fulfillmentDenom = completed + cancelled + violations
  const isNew = completed < REP_MIN_SAMPLE
  return {
    sample_size:      completed,
    is_new_seller:    isNew,
    fulfillment_rate: !isNew && fulfillmentDenom > 0 ? +(completed / fulfillmentDenom).toFixed(3) : null,
    on_time_rate:     !isNew && completed > 0        ? +Math.min(1, onTimeEvents / completed).toFixed(3) : null,
    dispute_win_rate: disputeTotal > 0               ? +(won / disputeTotal).toFixed(3) : null,
    dispute_count:    disputeTotal,
    open_dispute_count: openDisputes,
    refund_rate:      !isNew && completed > 0        ? +(refunds / completed).toFixed(3) : null,
  }
}

// #1013 Phase 71: 2 reputation endpoints 已迁出
registerReputationRoutes(app, { db, auth, getReputation, getSellerMetrics })


// admin reputation/decay — Phase 106 已迁出

// ─── 争议 API（L3 PWA 接口）────────────────────────────────────

// GET /api/disputes — Phase 86 已迁出

// 争议详情（含双方证据）
// 2026-05-22 A2：同类已判案件建议（仲裁详情页 sidebar 用）
// 优先按 product.category 匹配，其次按 dispute.reason 关键词
// 排除自身（避免循环引用 dispute → published case）
// GET /api/disputes/:id/similar-cases — Phase 86 已迁出


// 被诉方提交反驳证据

// 仲裁员裁定（内部 role + 外部 whitelist 双通道）

// 同步内容黑名单 — 仲裁判例评论 / 公开发言的快路径过滤
// 命中即拒绝（400），避免无意义的 LLM 调用成本
const COMMENT_BLOCKLIST = [
  // 辱骂 / 人身攻击高频词（粗筛 — LLM 兜底更细的判断）
  /\b(?:fuck|shit|bitch|asshole|cunt|nigger|faggot|retard)\b/i,
  /(?:傻逼|傻屄|sb|草泥马|cnm|去死|滚蛋|废物|狗东西|贱货|垃圾人)/,
  // 群体仇恨 / 暴力煽动
  /(?:打死|弄死|杀全家|灭你全家|烧死)/,
  // 广告 / 垃圾 spam
  /(?:加我?(?:V|微信|wechat|QQ|q\s?q|tg|telegram)|代写|刷单|招代理|月入[万百千]+)/i,
  // 长串 URL（评论里不允许外链 — 防钓鱼）
  /https?:\/\/\S{10,}/i,
]
function commentBlocklistHit(text: string): string | null {
  for (const pat of COMMENT_BLOCKLIST) {
    if (pat.test(text)) return '内容包含敏感词 / 垃圾信息 / 外链，已被拒绝'
  }
  return null
}

// 异步 LLM 评论审核（fail-open — Claude 不可达时放行）
async function llmModerateComment(text: string): Promise<{ ok: boolean; reason?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: true }
  try {
    const result = await Promise.race([
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: `你是仲裁判例评论审核员。判断以下评论是否包含：辱骂 / 人身攻击 / 虚假指控 / 煽动性语言 / 广告。只输出 JSON：{"ok":true|false,"reason":"若 false 给出 ≤20 字理由"}。\n评论：${text.slice(0, 500)}`,
        }],
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('moderation_timeout')), 3500)),
    ]) as { content?: Array<{ text?: string }> }
    const out = result.content?.[0]?.text || ''
    const lb = out.indexOf('{'); const rb = out.lastIndexOf('}')
    if (lb < 0 || rb <= lb) return { ok: true }
    const parsed = JSON.parse(out.slice(lb, rb + 1)) as { ok?: boolean; reason?: string }
    if (parsed.ok === false) return { ok: false, reason: parsed.reason || '内容不符合社区规范' }
    return { ok: true }
  } catch { return { ok: true } }
}

// 自动 PII 脱敏 — 仲裁判例公开前对买卖家陈述做最小化处理
// 匹配：中国手机 / 邮箱 / 身份证 / 银行卡 / 住址关键词后缀 / IP
function piiSanitize(text: string): string {
  if (!text) return text
  let out = text
  // 11 位手机号（前后非数字边界）
  out = out.replace(/(?<!\d)(\+?86)?1[3-9]\d{9}(?!\d)/g, '[已脱敏-手机]')
  // 邮箱
  out = out.replace(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[已脱敏-邮箱]')
  // 18 位身份证（最后位可为 X/x）
  out = out.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[已脱敏-身份证]')
  // 15 位身份证
  out = out.replace(/(?<!\d)\d{15}(?!\d)/g, '[已脱敏-身份证]')
  // 16-19 位连续数字（可能银行卡）
  out = out.replace(/(?<!\d)\d{16,19}(?!\d)/g, '[已脱敏-卡号]')
  // 含"路 / 号 / 巷 / 弄 / 室"等的连续地址片段（粗略）
  out = out.replace(/[一-龥]{2,}(?:省|市|区|县|镇|乡|村|街道|路|街|巷|弄)[一-龥\d]{0,15}(?:号|楼|室|单元|栋|院|大厦|小区|花园)?/g, '[已脱敏-地址]')
  // IPv4
  out = out.replace(/(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, '[已脱敏-IP]')
  return out
}

// 2026-05-25 #1015：公开判例额外脱敏 — 在 piiSanitize 之上加 WebAZ 特有的反向定位防护
// 适用于 dispute_cases.{ruling_text, buyer_argument, seller_argument}
// - 内部 ID（usr/ord/prd/disp/dcase/wdr 等）→ [id]（防顺藤摸瓜定位具体订单）
// - 精确金额（999.99 WAZ）→ [amount]（amount_bucket 列已分桶展示）
// - 精确时间（2026-05-25 14:30:00）→ 日期级（2026-05-25）
// - URL → [link]（防 utm_*/token 泄露）
function redactCaseText(text: string): string {
  if (!text) return text
  let out = piiSanitize(text)
  // WebAZ 内部 ID：prefix_{6-24} 字母数字（覆盖 usr/ord/prd/disp/dcase/wdr/pcl/ses/key/sub/sh/sk/ctx 等几乎所有 generateId 前缀）
  out = out.replace(/\b(?:usr|ord|prd|disp|dpt|dcase|wdr|pcl|ral|scl|sub|sh|sk|ses|key|ctx|prl|rpm|noc|tsl|cit|pad|nty|aca|aer|cmt|fol|blk|ann|alt|bid|rfq|auct|wsh|fll|pad|cmp|don)_[A-Za-z0-9]{6,24}\b/g, '[id]')
  // 显式 WAZ / USDC 金额（精确数字）→ [amount]（amount_bucket 已提供分桶信息）
  out = out.replace(/(?<![\w.])\d+(?:\.\d+)?\s*(?:WAZ|waz|USDC|usdc|U)\b/g, '[amount]')
  // ISO 时间戳 → 仅保留日期
  out = out.replace(/(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '$1')
  // URL（含 query 可能藏 token / utm）→ [link]
  out = out.replace(/https?:\/\/[^\s一-龥]+/g, '[link]')
  return out
}

// 把已裁决的 dispute 派生为公开 dispute_cases 行（脱敏）
function publishDisputeCase(disputeId: string, ruling: string, reason: string) {
  // 避免重复发布
  const exists = db.prepare(`SELECT id FROM dispute_cases WHERE dispute_id = ?`).get(disputeId) as { id: string } | undefined
  if (exists) return

  const dispute = db.prepare(`SELECT id, order_id, initiator_id, reason as dispute_reason FROM disputes WHERE id = ?`).get(disputeId) as { id: string; order_id: string; initiator_id: string; dispute_reason: string } | undefined
  if (!dispute) return

  const order = db.prepare(`SELECT id, buyer_id, seller_id, product_id, total_amount FROM orders WHERE id = ?`).get(dispute.order_id) as { id: string; buyer_id: string; seller_id: string; product_id: string; total_amount: number } | undefined
  if (!order) return

  const product = db.prepare(`SELECT category FROM products WHERE id = ?`).get(order.product_id) as { category: string } | undefined
  // 推导 category_tag（争议原因 + 商品类目猜测）
  const reasonLower = (dispute.dispute_reason || '').toLowerCase()
  let categoryTag = '其他'
  if (/物流|快递|delivery|shipping|损坏|压坏/.test(reasonLower)) categoryTag = '物流'
  else if (/质量|quality|坏|不合格|defect/.test(reasonLower)) categoryTag = '质量'
  else if (/描述|不符|description|mismatch|sla|spec/.test(reasonLower)) categoryTag = '描述不符'
  else if (/售后|退款|refund|warranty/.test(reasonLower)) categoryTag = '售后'
  else if (/拒收|reject/.test(reasonLower)) categoryTag = '拒收'

  // winner
  let winner = 'split'
  if (ruling === 'refund_buyer') winner = 'buyer'
  else if (ruling === 'release_seller') winner = 'seller'

  // resolution 一句话
  const resolutionMap: Record<string, string> = {
    refund_buyer: '全额退款',
    release_seller: '驳回 · 卖家保留货款',
    partial_refund: '部分退款',
    liability_split: '责任分担',
  }

  // amount_bucket 分桶（避免精确金额暴露）
  const amount = Number(order.total_amount || 0)
  let amountBucket = '0-100 WAZ'
  if (amount >= 2000) amountBucket = '2000+ WAZ'
  else if (amount >= 500) amountBucket = '500-2000 WAZ'
  else if (amount >= 100) amountBucket = '100-500 WAZ'

  // 拉买卖家陈述 —— 从 evidence 表取最早 description 类，做完整脱敏（#1015 升级到 redactCaseText）
  const ev = db.prepare(`SELECT uploader_id, description FROM evidence WHERE order_id = ? AND type = 'description' ORDER BY created_at ASC`).all(order.id) as Array<{ uploader_id: string; description: string }>
  const buyerArg = redactCaseText(ev.find(e => e.uploader_id === order.buyer_id)?.description?.slice(0, 500) || '')
  const sellerArg = redactCaseText(ev.find(e => e.uploader_id === order.seller_id)?.description?.slice(0, 500) || '')
  // #1015: ruling_text 也要走完整脱敏（之前是裸 slice，可能含具体金额 / 用户 ID / 时间戳 / URL）
  const rulingText = redactCaseText(String(reason).slice(0, 1500))

  // 获取仲裁员
  const arbRow = db.prepare(`SELECT assigned_arbitrators FROM disputes WHERE id = ?`).get(disputeId) as { assigned_arbitrators: string | null } | undefined
  let arbitratorId = ''
  try {
    const arr = JSON.parse(arbRow?.assigned_arbitrators || '[]')
    if (Array.isArray(arr) && arr.length > 0) arbitratorId = arr[0]
  } catch {}

  db.prepare(`INSERT INTO dispute_cases
    (id, dispute_id, order_id, product_id, seller_id, buyer_id,
     category_tag, winner, resolution, amount_bucket,
     buyer_argument, seller_argument, ruling_text, arbitrator_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      generateId('dcase'), disputeId, order.id, order.product_id, order.seller_id, order.buyer_id,
      categoryTag, winner, resolutionMap[ruling] || ruling, amountBucket,
      buyerArg, sellerArg, rulingText, arbitratorId
    )
}

// 2026-05-25 #1015 migration：把已发布的 dispute_cases 历史行追加脱敏
// 幂等：redactCaseText 对已脱敏文本（含 [id]/[amount]/[link]）不会重复替换
try {
  const oldRows = db.prepare(`SELECT id, buyer_argument, seller_argument, ruling_text FROM dispute_cases`).all() as Array<{ id: string; buyer_argument?: string; seller_argument?: string; ruling_text?: string }>
  let migrated = 0
  for (const r of oldRows) {
    const nb = redactCaseText(r.buyer_argument || '')
    const ns = redactCaseText(r.seller_argument || '')
    const nr = redactCaseText(r.ruling_text || '')
    if (nb !== r.buyer_argument || ns !== r.seller_argument || nr !== r.ruling_text) {
      db.prepare(`UPDATE dispute_cases SET buyer_argument=?, seller_argument=?, ruling_text=? WHERE id=?`).run(nb, ns, nr, r.id)
      migrated++
    }
  }
  if (migrated > 0) console.log(`[migration #1015] redacted ${migrated} dispute_cases rows`)
} catch (e) { console.error('[migration #1015]', e) }

// 参与方主动提交证据


// GET /api/disputes/:id/evidence-list — Phase 86 已迁出

// #1013 Phase 53: 4 evidence endpoints 已迁出到 routes/evidence.ts
registerEvidenceRoutes(app, { db, auth, detectFraud })

// 仲裁员：请求某方补充证据

// GET /api/disputes/:id/parties — Phase 86 已迁出

// ─── WebAuthn / Passkey 端点 ───────────────────────────────────
// #1013 Phase 1: 7 endpoint handlers 已迁出到 src/pwa/routes/webauthn.ts
// helpers (consumeGateToken / requireHumanPresence) 仍在本文件，被 withdraw/arbitrate/vote 等引用
registerWebauthnRoutes(app, {
  db, auth, generateId, rateLimitOk,
  rpId: WEBAUTHN_RP_ID,
  rpName: WEBAUTHN_RP_NAME,
  origin: WEBAUTHN_ORIGIN,
  challengeTtlMs: WEBAUTHN_CHALLENGE_TTL_MS,
  gateTtlMs: WEBAUTHN_GATE_TTL_MS,
  invalidateAgentRiskCacheForUser,
  requireHumanPresence,  // #1044 — DELETE passkey 自身需 token
})

// consumeGateToken / requireHumanPresence 已抽出到 ./human-presence.ts(PR-F0,behavior-zero,
// 工厂 createHumanPresence(db, getProtocolParam),在 db+getProtocolParam 定义后即实例化 —— 见上方)。
// ─── M7.3 claim 验证任务系统 ──────────────────────────────
// #1013 Phase 9: 8 endpoints + 三路径结算 + outlier strike + 铁律 §4 已迁出到 routes/claim-verify.ts
// product_claim_tasks (Sprint 1) 跨域用 isEligibleClaimVerifier — 从 import 拿
registerClaimVerifyRoutes(app, { db, auth, generateId, requireHumanPresence })


// ─── Sprint 1: 商品声明验证（product_claim_tasks）─────────────
// 任何登录用户（除 seller 本人）可对 active product 的声明发起验证
// 3 个 isEligibleClaimVerifier 共识投票判定

const PRODUCT_CLAIM_TARGETS = new Set([
  'title','description','condition','return_days','handling_hours',
  'warranty_days','shipping_regions','origin','specs','other'
])
const PRODUCT_CLAIM_STAKE_DEFAULT = 5
const PRODUCT_CLAIM_DEADLINE_HOURS = 72
const PRODUCT_CLAIM_VERIFIERS_NEEDED = 3

// #1013 Phase 88: 2 products/claim endpoints 已迁出
registerProductsClaimsRoutes(app, {
  db, auth, isTrustedRole, errorRes, generateId,
  PRODUCT_CLAIM_TARGETS, PRODUCT_CLAIM_STAKE_DEFAULT, PRODUCT_CLAIM_DEADLINE_HOURS, PRODUCT_CLAIM_VERIFIERS_NEEDED,
})
// #1013 Phase 75: 共享给 claim-voting 模块；review 垂类的 3 票阈值
const REVIEW_VERIFIERS_NEEDED = 3

function settleProductClaim(claimId: string): { ok: boolean; majority?: string; ruling?: string; reason?: string } {
  const claim = db.prepare('SELECT * FROM product_claim_tasks WHERE id = ?').get(claimId) as Record<string, unknown> | undefined
  if (!claim) return { ok: false, reason: 'claim not found' }
  if (String(claim.status).startsWith('resolved_')) return { ok: false, reason: '已结算' }
  const votes = db.prepare('SELECT id, verifier_id, vote FROM product_claim_votes WHERE claim_id = ?').all(claimId) as Array<{ id: string; verifier_id: string; vote: string }>

  const counts: Record<string, number> = { upheld: 0, dismissed: 0, insufficient: 0 }
  for (const v of votes) counts[v.vote] = (counts[v.vote] || 0) + 1
  let majority: 'upheld' | 'dismissed' | 'insufficient' = 'insufficient'
  if (votes.length > 0) {
    const maxN = Math.max(counts.upheld, counts.dismissed, counts.insufficient)
    const winners = (['upheld', 'dismissed', 'insufficient'] as const).filter(k => counts[k] === maxN)
    majority = winners.length > 1 ? 'insufficient' : winners[0]
  }

  const claimantId = claim.claimant_id as string
  const stake = Number(claim.stake_claimant)
  const majorityVoters = votes.filter(v => v.vote === majority).map(v => v.verifier_id)
  // 释放 escrow（投资分配前清零）
  db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(stake, claimantId)

  if (majority === 'upheld') {
    // 声明属实（卖家失误）：发起人退 80% + voters 拿 20%
    const refund = Math.round(stake * 0.8 * 100) / 100
    const voterPool = Math.round(stake * 0.2 * 100) / 100
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(refund, claimantId)
    distributeVoterPool(majorityVoters, voterPool)
  } else if (majority === 'dismissed') {
    // 声明不属实：发起人失质押，全部归 voters
    distributeVoterPool(majorityVoters, stake)
  } else {
    // insufficient / 并列 / 0 票：发起人退 100%（中立）
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(stake, claimantId)
  }
  // 标记胜出 voters
  db.transaction(() => {
    for (const v of votes) {
      const isWinner = v.vote === majority ? 1 : 0
      db.prepare('UPDATE product_claim_votes SET was_majority = ? WHERE id = ?').run(isWinner, v.id)
    }
  })()
  const newStatus = majority === 'upheld' ? 'resolved_upheld' : majority === 'dismissed' ? 'resolved_dismissed' : 'resolved_insufficient'
  db.prepare(`UPDATE product_claim_tasks SET status = ?, majority_vote = ?, ruling = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(newStatus, majority, majority, claimId)
  // Sprint 4 — 声誉影响 + 商品 claim_loss_count
  try { applyClaimAftermath('product_claim_tasks', claim, majority) } catch (e) { console.error('[product claim aftermath]', e) }
  return { ok: true, majority, ruling: majority }
}

function distributeVoterPool(voterIds: string[], pool: number) {
  if (voterIds.length === 0 || pool <= 0) return
  const share = Math.round((pool / voterIds.length) * 100) / 100
  for (const uid of voterIds) {
    db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(share, share, uid)
  }
}

// POST /:id/claim + GET /:id/claims — Phase 88 已迁出

// #1013 Phase 75: 5 垂类 × 2 (available + vote) = 10 endpoints 已迁出
registerClaimVotingRoutes(app, {
  db, auth, isEligibleClaimVerifier, generateId,
  settleProductClaim, settleGenericClaim,
  PRODUCT_CLAIM_VERIFIERS_NEEDED, REVIEW_VERIFIERS_NEEDED,
})


// #1013 Phase 74: 5 claim DELETE 端点（Wave A-5）已迁出
registerClaimWithdrawalsRoutes(app, { auth, withdrawClaim })


// ─── Sprint 2: Review + Secondhand claim 端点 ──────────────
// 共享通用 settle 引擎（参数化 table，valid set 防注入）

const VALID_CLAIM_TABLES = new Set([
  'product_claim_tasks', 'product_claim_votes',
  'review_claim_tasks', 'review_claim_votes',
  'secondhand_claim_tasks', 'secondhand_claim_votes',
  'auction_claim_tasks', 'auction_claim_votes',
  'wish_claim_tasks', 'wish_claim_votes',
])

function settleGenericClaim(taskTable: string, voteTable: string, claimId: string): { ok: boolean; majority?: string; ruling?: string; reason?: string } {
  if (!VALID_CLAIM_TABLES.has(taskTable) || !VALID_CLAIM_TABLES.has(voteTable)) {
    return { ok: false, reason: 'invalid table' }
  }
  const claim = db.prepare(`SELECT * FROM ${taskTable} WHERE id = ?`).get(claimId) as Record<string, unknown> | undefined
  if (!claim) return { ok: false, reason: 'claim not found' }
  if (String(claim.status).startsWith('resolved_')) return { ok: false, reason: '已结算' }
  const votes = db.prepare(`SELECT id, verifier_id, vote FROM ${voteTable} WHERE claim_id = ?`).all(claimId) as Array<{ id: string; verifier_id: string; vote: string }>

  const counts: Record<string, number> = { upheld: 0, dismissed: 0, insufficient: 0 }
  for (const v of votes) counts[v.vote] = (counts[v.vote] || 0) + 1
  let majority: 'upheld' | 'dismissed' | 'insufficient' = 'insufficient'
  if (votes.length > 0) {
    const maxN = Math.max(counts.upheld, counts.dismissed, counts.insufficient)
    const winners = (['upheld', 'dismissed', 'insufficient'] as const).filter(k => counts[k] === maxN)
    majority = winners.length > 1 ? 'insufficient' : winners[0]
  }
  const claimantId = claim.claimant_id as string
  const stake = Number(claim.stake_claimant)
  const majorityVoters = votes.filter(v => v.vote === majority).map(v => v.verifier_id)
  db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(stake, claimantId)
  if (majority === 'upheld') {
    const refund = Math.round(stake * 0.8 * 100) / 100
    const voterPool = Math.round(stake * 0.2 * 100) / 100
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(refund, claimantId)
    distributeVoterPool(majorityVoters, voterPool)
  } else if (majority === 'dismissed') {
    distributeVoterPool(majorityVoters, stake)
  } else {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(stake, claimantId)
  }
  db.transaction(() => {
    for (const v of votes) {
      db.prepare(`UPDATE ${voteTable} SET was_majority = ? WHERE id = ?`).run(v.vote === majority ? 1 : 0, v.id)
    }
  })()
  const newStatus = majority === 'upheld' ? 'resolved_upheld' : majority === 'dismissed' ? 'resolved_dismissed' : 'resolved_insufficient'
  db.prepare(`UPDATE ${taskTable} SET status = ?, majority_vote = ?, ruling = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(newStatus, majority, majority, claimId)

  // Sprint 4 — settle hook：声誉影响 + 目标对象 claim_loss_count
  try { applyClaimAftermath(taskTable, claim, majority) } catch (e) { console.error('[claim aftermath]', e) }

  return { ok: true, majority, ruling: majority }
}

// Sprint 4/5 — claim 结算后的后续影响（声誉 + 目标对象计数 + 自动下架 + voter outlier）
// #420 P1-3:voter outlier 的窗口/暂停/撤销阈值由 protocol_params 驱动(见 checkVerifierOutlier + anti-abuse-thresholds.ts)
const CLAIM_AUTO_SUSPEND_THRESHOLD = 3          // 商品 / 拍卖 / 二手 累计 N 次 upheld → 自动下架

// Wave A-5: 通用 claim 撤回 helper（只有 0 票时 claimant 可撤回，退 stake）
function withdrawClaim(taskTable: string, voteTable: string, claimId: string, userId: string): { ok: boolean; error?: string } {
  if (!VALID_CLAIM_TABLES.has(taskTable) || !VALID_CLAIM_TABLES.has(voteTable)) {
    return { ok: false, error: 'invalid table' }
  }
  const claim = db.prepare(`SELECT * FROM ${taskTable} WHERE id = ?`).get(claimId) as Record<string, unknown> | undefined
  if (!claim) return { ok: false, error: '声明不存在' }
  if (claim.claimant_id !== userId) return { ok: false, error: '仅发起人可撤回' }
  if (claim.status !== 'open') return { ok: false, error: `状态 ${claim.status} 不可撤回` }
  // 任何已投票 → 不可撤回（防发起人被打脸后撤回）
  const voteCount = (db.prepare(`SELECT COUNT(*) as n FROM ${voteTable} WHERE claim_id = ?`).get(claimId) as { n: number }).n
  if (voteCount > 0) return { ok: false, error: `已有 ${voteCount} 票，不可撤回（必须等结算）` }
  // 退还 stake
  const stake = Number(claim.stake_claimant)
  db.transaction(() => {
    db.prepare(`UPDATE ${taskTable} SET status = 'withdrawn', resolved_at = datetime('now') WHERE id = ?`).run(claimId)
    db.prepare('UPDATE wallets SET escrowed = escrowed - ?, balance = balance + ? WHERE user_id = ?').run(stake, stake, userId)
  })()
  return { ok: true }
}

function applyClaimAftermath(taskTable: string, claim: Record<string, unknown>, majority: string) {
  const claimantId = claim.claimant_id as string
  // 按 table 类型确定被诉方 + 目标对象 update 字段
  const META: Record<string, { defendant: string | null; updateTable: string | null; targetIdKey: string; voteTable: string }> = {
    product_claim_tasks:     { defendant: claim.seller_id as string,   updateTable: 'products',         targetIdKey: 'product_id', voteTable: 'product_claim_votes' },
    secondhand_claim_tasks:  { defendant: claim.seller_id as string,   updateTable: 'secondhand_items', targetIdKey: 'sh_item_id',  voteTable: 'secondhand_claim_votes' },
    auction_claim_tasks:     { defendant: claim.seller_id as string,   updateTable: 'auctions',         targetIdKey: 'auction_id',  voteTable: 'auction_claim_votes' },
    review_claim_tasks:      { defendant: claim.reviewer_id as string, updateTable: null,               targetIdKey: 'review_id',   voteTable: 'review_claim_votes' },
    wish_claim_tasks:        { defendant: claim.wisher_id as string,   updateTable: null,               targetIdKey: 'wish_id',     voteTable: 'wish_claim_votes' },
  }
  const meta = META[taskTable]
  if (!meta) return

  if (majority === 'upheld') {
    if (meta.defendant) recordRepEvent(db, meta.defendant, 'claim_upheld_against', `${taskTable} 声明被验证不实 (claim=${claim.id})`)
    recordRepEvent(db, claimantId, 'claim_correct', `${taskTable} 声明被验证支持 (claim=${claim.id})`)
    if (meta.updateTable) {
      const targetId = claim[meta.targetIdKey] as string
      try {
        db.prepare(`UPDATE ${meta.updateTable} SET claim_loss_count = COALESCE(claim_loss_count, 0) + 1 WHERE id = ?`).run(targetId)
        // Sprint 5-A — 自动下架：累计 claim_loss_count >= 3 → status='warehouse'
        const row = db.prepare(`SELECT claim_loss_count, status FROM ${meta.updateTable} WHERE id = ?`).get(targetId) as { claim_loss_count: number; status: string } | undefined
        if (row && row.claim_loss_count >= CLAIM_AUTO_SUSPEND_THRESHOLD && row.status === 'active' && meta.updateTable === 'products') {
          db.prepare(`UPDATE products SET status = 'warehouse', updated_at = datetime('now') WHERE id = ?`).run(targetId)
          // 通知卖家
          if (meta.defendant) {
            try {
              db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
                .run(generateId('ntf'), meta.defendant, '商品已自动下架', `商品累计 ${row.claim_loss_count} 次声明被验证不实，已转入仓库。如需重新上架请先解决问题。`, null)
            } catch {}
          }
        }
        // secondhand_items: closed
        if (row && row.claim_loss_count >= CLAIM_AUTO_SUSPEND_THRESHOLD && row.status === 'available' && meta.updateTable === 'secondhand_items') {
          db.prepare(`UPDATE secondhand_items SET status = 'closed' WHERE id = ?`).run(targetId)
        }
        // auctions: 不自动 cancel（会丢失 seller_stake + bidder escrow — 走 admin 复核 + proper /auctions/:id DELETE flow）
        // 改为：通知 admin + seller，让 admin 人工评估后决定（手动 cancel 会触发正确退款链路）
        if (row && row.claim_loss_count >= CLAIM_AUTO_SUSPEND_THRESHOLD && row.status === 'open' && meta.updateTable === 'auctions') {
          // 通知 seller + 写 admin_audit_log（让 admin 看到异常）
          if (meta.defendant) {
            try {
              db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
                .run(generateId('ntf'), meta.defendant, '⚠ 拍卖累计 claim 已达阈值', `你的拍卖 ${targetId} 累计 ${row.claim_loss_count} 次声明被验证不实，admin 将复核。如有 active bids，请走正式 cancel 流程退款。`, null)
              logAdminAction('system', 'claim_auto_threshold', 'auction', targetId, { claim_loss_count: row.claim_loss_count, action: 'admin_review_required' })
            } catch {}
          }
        }
      } catch (e) { console.error('[claim_loss_count auto-suspend]', e) }
    }
  } else if (majority === 'dismissed') {
    recordRepEvent(db, claimantId, 'claim_dismissed_false', `${taskTable} 声明被驳回（虚假举报） (claim=${claim.id})`)
  }

  // Sprint 5-B — voter outlier 累计 + 自动冻结
  // 找投错票的 verifier（was_majority=0），累计他们 180d 内的 outlier 次数
  try {
    const losers = db.prepare(`SELECT verifier_id FROM ${meta.voteTable} WHERE claim_id = ? AND was_majority = 0`).all(claim.id) as Array<{ verifier_id: string }>
    for (const { verifier_id } of losers) {
      checkVerifierOutlier(verifier_id)
    }
  } catch (e) { console.error('[voter outlier check]', e) }
}

// Sprint 5-B — 检查 voter 累计 outlier，达阈值时插入 suspend / revoke 记录
function checkVerifierOutlier(verifierId: string) {
  // 已经 revoked 的不再处理
  const existing = db.prepare(`SELECT type FROM claim_verifier_suspensions WHERE user_id = ? AND type = 'revoked' LIMIT 1`).get(verifierId)
  if (existing) return

  // #420 P1-3:窗口/阈值/暂停时长由 protocol_params 驱动(默认 = 原 180d/≥5/≥3/30d)
  const t = readAntiAbuseThresholds(db)
  // 统计窗口内 outlier 票数（跨所有 vote table）
  const VOTE_TABLES = ['claim_verification_votes', 'product_claim_votes', 'review_claim_votes', 'secondhand_claim_votes', 'auction_claim_votes', 'wish_claim_votes']
  let outlierCount = 0
  const since = new Date(Date.now() - t.outlierWindowDays * 86400_000).toISOString()
  for (const tbl of VOTE_TABLES) {
    try {
      const n = (db.prepare(`SELECT COUNT(*) as n FROM ${tbl} WHERE verifier_id = ? AND was_majority = 0 AND voted_at > ?`).get(verifierId, since) as { n: number }).n
      outlierCount += n
    } catch {}
  }

  const band = verifierOutlierBand(outlierCount, t)
  if (band === 'revoke') {
    // 永久撤销
    db.prepare(`INSERT INTO claim_verifier_suspensions (id, user_id, type, until_at, reason, outlier_count) VALUES (?,?,?,NULL,?,?)`)
      .run(generateId('cvs'), verifierId, 'revoked', `累计 ${outlierCount} 次 outlier（${t.outlierWindowDays}d 内）→ 永久撤销 verifier 资格`, outlierCount)
    try {
      db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
        .run(generateId('ntf'), verifierId, '⚠ Verifier 资格已撤销', `你在 ${t.outlierWindowDays} 天内累计 ${outlierCount} 次 outlier 投票，按协议规则资格被永久撤销。`, null)
    } catch {}
  } else if (band === 'suspend') {
    // 临时 suspend，避免重复 suspend
    const dup = db.prepare(`SELECT id FROM claim_verifier_suspensions WHERE user_id = ? AND type = 'suspended' AND (until_at IS NULL OR until_at > datetime('now')) LIMIT 1`).get(verifierId)
    if (!dup) {
      const until = new Date(Date.now() + t.outlierSuspendDays * 86400_000).toISOString()
      db.prepare(`INSERT INTO claim_verifier_suspensions (id, user_id, type, until_at, reason, outlier_count) VALUES (?,?,?,?,?,?)`)
        .run(generateId('cvs'), verifierId, 'suspended', until, `累计 ${outlierCount} 次 outlier（${t.outlierWindowDays}d 内）→ 暂停 ${t.outlierSuspendDays} 天`, outlierCount)
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
          .run(generateId('ntf'), verifierId, '⏳ Verifier 资格已暂停', `你在 ${t.outlierWindowDays} 天内累计 ${outlierCount} 次 outlier 投票，资格暂停 ${t.outlierSuspendDays} 天直至 ${until.slice(0,10)}。`, null)
      } catch {}
    }
  }
}

// ── Review claim 端点 ────────────────────────────────────────
const REVIEW_CLAIM_TARGETS = new Set(['not_real_purchase','paid_promo','incentivized','misleading','fake','other'])
const REVIEW_CLAIM_STAKE = 5
const REVIEW_CLAIM_DEADLINE_HOURS = 72

// #1013 Phase 73: 3 reviews endpoints 已迁出（含此处 claim 2 端点）
registerReviewsRoutes(app, {
  db, auth, isTrustedRole, errorRes, generateId,
  REVIEW_CLAIM_TARGETS, REVIEW_CLAIM_STAKE, REVIEW_CLAIM_DEADLINE_HOURS, REVIEW_VERIFIERS_NEEDED,
})



// #1013 Phase 76: 3 垂类 × 2 (POST claim + GET claims) = 6 endpoints 已迁出
registerClaimInitiatorsRoutes(app, { db, auth, isTrustedRole, errorRes, generateId })



// ─── 分享 / 重定向 / QR (#1013 Phase 54) ────────────────────
registerShareRedirectsRoutes(app, { db, auth, clientIpHash, clientUaHash, resolveInviteCodeRef })
registerShopReferralRoutes(app, { db, auth, errorRes, internalAuditorId: INTERNAL_AUDITOR_ID, resolveUserRef, resolveInviteCodeRef })

// 慈善许愿池 API
// ============================================================

// ─── 慈善许愿池 (charity) ─────────────────────────────────
// #1013 Phase 6: 17 endpoints + helpers + 2 cron 函数已迁出到 routes/charity.ts
registerCharityRoutes(app, {
  db, auth, generateId, rateLimitOk, getUser, isTrustedRole,
  // 预绑 db + generateId 给 fireWebhooks，charity 调用时只关心 event/payload/userIds
  fireWebhooks: (eventType, payload, userIds) => fireWebhooks(db, generateId, eventType, payload, userIds),
  requireContentAdmin:  (req, res) => requireAdminPermission(req, res, 'content'),
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
})

// ─── Webhooks 订阅中心 ─────────────────────────────────────
// #1013 Phase 7: 5 endpoints + fireWebhooks 已迁出到 routes/webhooks.ts
registerWebhookRoutes(app, { db, auth, generateId, rateLimitOk })




// #1013 Phase 69: 4 admin/hot-wallet + withdrawals endpoints 已迁出
// 必须在 SPA catch-all 之前；用 getter 延迟解析 publicClient/HOT_WALLET_ADDR 等下游 const
registerAdminWalletOpsRoutes(app, {
  db,
  requireProtocolAdmin: (req, res) => requireAdminPermission(req, res, 'protocol'),
  adminAuth,
  getPublicClient:  () => publicClient,
  getUsdcAddr:      () => USDC_SEPOLIA,
  getUsdcAbi:       () => USDC_ABI,
  getHotWalletAddr: () => HOT_WALLET_ADDR,
  wazToUsdc,
  getIsMainnet:     () => IS_MAINNET,
  getNetwork:       () => NETWORK,
  executeWithdrawal: (id) => executeWithdrawal(id) as Promise<{ success: true; txHash: string } | { success: false; error: string; txHash?: undefined }>,
  logAdminAction,
  // dual-accept transition for attribution(非最终安全收紧):只读、不响应地解析登录的 protocol-admin。
  // 用 resolveBearerProtocolAdmin(钱路强校验):仅认 Authorization: Bearer(不认 req.body.api_key)、
  // 拒暂停用户、拒已吊销会话;角色+protocol 权限用中央 hasAdminPermission(防漂移)。null → 回落共享 ADMIN_KEY。
  // 最终弃用 x-admin-key 留后续 PR。
  resolveProtocolAdminSoft: (req) => resolveBearerProtocolAdmin(db, req, (u) => {
    let rolesList: string[] = []
    try { rolesList = JSON.parse((u.roles as string) || '[]') } catch { rolesList = [] }
    if (u.role !== 'admin' && !rolesList.includes('admin')) return false
    return hasAdminPermission(u, 'protocol')
  }),
})

// #1013 Phase 80: 10 wallet read endpoints 已迁出
registerWalletReadRoutes(app, {
  db, auth, isTrustedRole, generateId, verifyPassword, deriveDepositAddress, getProtocolParam,
  getPublicClient:  () => publicClient,
  getIsMainnet:     () => IS_MAINNET,
  getActiveChainId: () => ACTIVE_CHAIN.id,
  getUsdcContract:  () => USDC_CONTRACT,
  getNetwork:       () => NETWORK,
})

// #1013 Phase 81: 5 wallet write endpoints 已迁出
registerWalletWriteRoutes(app, {
  db, auth, isTrustedRole, generateId, getProtocolParam,
  consumeGateToken, issueCode, findActiveCode, maskEmail,
  LARGE_WITHDRAW_THRESHOLD,
})

// #1013 Phase 107: 6 public/util endpoints 统一 register（必须在 SPA catch-all 之前；logError/generateManifest 在上方定义）
registerPublicUtilsRoutes(app, {
  db, MASTER_SEED, NODE_ENV, SERVICE_START_MS,
  rateLimitOk, generateManifest, getUser, logError,
  // #1045 信任锚:Phase 4 同一把签名 key 的地址,公开发布让第三方验真者锚定
  issuerAddress: () => walletSigner.issuerAddress(),
})

// ─── 静态文件 + SPA 回退（必须在所有 API 路由之后）────────────
// PWA 壳文件必须 no-cache(否则 CF/浏览器 4h 缓存挡新版本)；
// 其他静态资产(图标/字体)走 CF 默认。
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const base = path.basename(filePath)
    if (base === 'app.js' || base === 'sw.js' || base === 'i18n.js' || base === 'index.html' || base === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    }
  },
}))

app.get('/{*path}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate')
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// POST /api/orders/:id/force-timeout-check — Phase 84 已迁出

// ─── 自动执法（随 PWA 进程内置运行）────────────────────────────

const ENFORCE_INTERVAL_MS = 5 * 60 * 1000   // 每 5 分钟扫描一次

function runEnforcement() {
  try {
    const orderResult   = checkTimeouts(db)
    const disputeResult = checkDisputeTimeouts(db)

    if (orderResult.processed > 0) {
      console.log(`⚡ 订单超时判责 × ${orderResult.processed}`)
      orderResult.details.forEach(d => {
        console.log(`   ${d.orderId}  ${d.action}`)
        const faultMatch = d.action.match(/→ (fault_\w+)/)
        if (faultMatch) recordViolationReputation(db, d.orderId, faultMatch[1])
      })
    }

    if (disputeResult.processed > 0) {
      console.log(`⚡ 争议自动裁定 × ${disputeResult.processed}`)
      disputeResult.details.forEach(d => {
        console.log(`   ${d.disputeId}  ${d.action}`)
        if (d.winnerId && d.loserId && d.orderId) {
          recordDisputeReputation(db, d.orderId, d.winnerId as string, d.loserId as string)
        }
      })
    }

    // M7.3b：claim 验证任务结算扫描（sealed + 超时）
    const claimResult = processClaimTaskQueue(db, generateId)
    if (claimResult.sealed > 0 || claimResult.timeout > 0) {
      console.log(`⚡ claim 验证结算 × sealed=${claimResult.sealed} timeout=${claimResult.timeout}`)
      claimResult.details.forEach(d => console.log(`   ${d.task_id}  → ${d.path} (majority=${d.majority})`))
    }

    // 截止前提醒扫描 — 6/12/24h 阈值，每 (order, type) 幂等只发一次
    const reminderResult = scanDeadlineReminders(db)
    if (reminderResult.sent > 0) {
      console.log(`⚡ 截止前提醒 × ${reminderResult.sent}`)
      reminderResult.details.forEach(d => console.log(`   ${d.orderId}  ${d.type}`))
    }

    // SNF TTL cleanup — 删过期消息
    const snfCleaned = snfCleanup(db)
    if (snfCleaned.removed > 0) console.log(`⚡ SNF cleanup × ${snfCleaned.removed}`)

    // L0-4 证据 TTL cleanup — 已撤回 / 已过期的 blob
    try {
      const evCleaned = cleanupExpiredEvidence(db)
      if (evCleaned.swept > 0) console.log(`⚡ Evidence cleanup × ${evCleaned.swept} files (${Math.round(evCleaned.bytes/1024)}KB)`)
    } catch (e) { console.error('证据清理失败：', (e as Error).message) }

    // Phase C 笔记图片孤儿 cleanup — 没有任何笔记引用且超过 1 小时 grace 期的 blob
    // RFC-016:cleanupOrphanNotePhotos 已异步(纯读 + fs 删);best-effort 孤儿清理,fire-and-forget 不阻塞同步 cron runEnforcement。
    cleanupOrphanNotePhotos(db)
      .then(npCleaned => { if (npCleaned.swept > 0) console.log(`⚡ Note photo cleanup × ${npCleaned.swept} files (${Math.round(npCleaned.bytes/1024)}KB)`) })
      .catch(e => console.error('笔记图片清理失败：', (e as Error).message))

    // E1 流量口令 reclaim — retired 满 365 天 → reclaimable（namespace 释放）
    try {
      const r = reclaimRetiredAnchors(db)
      if (r.reclaimed > 0) console.log(`⚡ Anchor reclaim × ${r.reclaimed} (retired ≥ 365d → reclaimable)`)
    } catch (e) { console.error('Anchor reclaim 失败：', (e as Error).message) }

    // 2026-05-22 audit P1：90 天无 lookup 的闲置 anchor → 自动 retire
    // 释放 namespace + 配合 ANCHOR_MAX_PER_USER 升 100 防累积
    try {
      const r = retireIdleAnchors(db)
      if (r.retired > 0) console.log(`⚡ Anchor idle retire × ${r.retired} (active ≥ 90d + hits=0 → retired)`)
    } catch (e) { console.error('Anchor idle retire 失败：', (e as Error).message) }

    // 2026-05-22 COP P0-2：账号注销 14 天后真正擦 PII
    try {
      const r = processAccountDeletions()
      if (r.wiped > 0) console.log(`⚡ Account deletion × ${r.wiped} (PII wiped after 14d cooldown)`)
    } catch (e) { console.error('Account deletion 失败：', (e as Error).message) }

    // CHARITY: 过期愿望/超时认领清理 + 还愿 7 天自动接受
    try { expireCharityWishes(db) } catch (e) { console.error('charity 清理失败：', (e as Error).message) }
    try { autoAcceptExpiredRepayments(db) } catch (e) { console.error('charity 还愿自动接受失败：', (e as Error).message) }
  } catch (err) {
    console.error('执法扫描出错：', (err as Error).message)
  }
}

// ─── 链上基础配置 ─────────────────────────────────────────────
// A-2: 主网迁移配置化 — 通过 env 切换 testnet/mainnet，无需改代码
// 切主网清单：
//   1. NETWORK=mainnet
//   2. BASE_RPC_URL=https://mainnet.base.org（或自有 RPC）
//   3. USDC_CONTRACT=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913（Base mainnet USDC）
//   4. WALLET_MASTER_SEED=<高熵随机值，建议来自 KMS / 硬件签名器>
//   5. 强烈建议把 HOT_WALLET 切到多签（如 Gnosis Safe）+ KMS 签名器 —— 经 WalletSigner seam
//      (internal/wallet-signer.ts) 换 LocalSeedSigner → KMS/Safe 实现，见 docs/HOT-WALLET-CUSTODY-MIGRATION.md
//   6. NODE_ENV=production（启用默认 seed 拒启 + bootstrap key 脱敏）
const NETWORK = (process.env.NETWORK || 'testnet').toLowerCase()
const IS_MAINNET = NETWORK === 'mainnet'
const ACTIVE_CHAIN = IS_MAINNET ? base : baseSepolia
const USDC_CONTRACT = (process.env.USDC_CONTRACT ?? (IS_MAINNET
  ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'  // Base mainnet USDC
  : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'  // Base Sepolia USDC
)) as `0x${string}`
const USDC_SEPOLIA = USDC_CONTRACT  // 旧名兼容（其它地方有引用）
const USDC_DECIMALS = 6
const DEPOSIT_POLL_MS = 60_000

// 主网启动前必须显式确认热钱包不是默认派生
if (IS_MAINNET && (MASTER_SEED === 'webaz-dev-seed-changeme' || !process.env.WALLET_MASTER_SEED)) {
  console.error('🛑 mainnet 启动必须设 WALLET_MASTER_SEED env，且不能等于默认值。进程退出。')
  process.exit(1)
}
if (IS_MAINNET && !process.env.HOT_WALLET_KMS_ACK) {
  console.warn('⚠ 主网热钱包 HOT_WALLET 私钥仍由 MASTER_SEED 派生 — 强烈建议改 KMS / 多签')
  console.warn('  设 HOT_WALLET_KMS_ACK=1 表示你已知悉风险继续运行（生产应把 WalletSigner 换成 KMS/多签实现，见 docs/HOT-WALLET-CUSTODY-MIGRATION.md）')
}

const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
)

const _rpcRaw = process.env.BASE_RPC_URL ?? (IS_MAINNET ? 'mainnet.base.org' : 'sepolia.base.org')
const rpcUrl = _rpcRaw.startsWith('http') ? _rpcRaw : `https://${_rpcRaw}`

const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(rpcUrl),
})

// ─── 热钱包（归集 + 提现出账）────────────────────────────────────

// Phase 0: hot-wallet signing via the WalletSigner seam (Phase 1 swaps LocalSeedSigner → KMS here).
const HOT_WALLET_ADDR = walletSigner.hotAddress()

const hotWalletClient = createWalletClient({
  account: walletSigner.hotAccount(),
  chain: ACTIVE_CHAIN,
  transport: http(rpcUrl),
})

// ─── 归集：充值地址 → 热钱包 ────────────────────────────────────

async function sweepToHotWallet(userId: string, depositAddress: string) {
  // 检查链上 USDC 余额
  const onChain = await publicClient.readContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [depositAddress as `0x${string}`],
  }) as bigint
  if (onChain === 0n) return

  // 热钱包先打一点 ETH 给充值地址支付 Gas
  const ethHash = await hotWalletClient.sendTransaction({
    to: depositAddress as `0x${string}`,
    value: parseEther('0.0005'),
  })
  await publicClient.waitForTransactionReceipt({ hash: ethHash })

  // 充值地址把 USDC 转给热钱包
  const depClient = createWalletClient({
    account: walletSigner.depositAccount(userId),
    chain: ACTIVE_CHAIN,
    transport: http(rpcUrl),
  })
  const usdcHash = await depClient.writeContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'transfer',
    args: [HOT_WALLET_ADDR, onChain],
  })
  await publicClient.waitForTransactionReceipt({ hash: usdcHash })

  db.prepare('UPDATE deposit_txns SET swept = 1 WHERE user_id = ? AND swept = 0').run(userId)
  console.log(`🔄 归集：${Number(onChain) / 1e6} USDC → 热钱包 (${usdcHash.slice(0, 10)}...)`)
}

// ─── 提现执行：热钱包 → 用户地址 ────────────────────────────────

async function executeWithdrawal(requestId: string): Promise<{ success: boolean; error?: string; txHash?: string }> {
  // H-4 P0: 防 re-entrancy — 原子声明 pending → processing；只有 changes=1 的调用者可继续
  const claim = db.prepare("UPDATE withdrawal_requests SET status='processing' WHERE id = ? AND status = 'pending'").run(requestId)
  if (claim.changes !== 1) return { success: false, error: '申请不存在、已处理或被另一会话锁定' }
  const req = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?")
    .get(requestId) as Record<string, unknown> | undefined
  if (!req) return { success: false, error: '申请不存在' }

  // Wave G-2: WAZ → USDC 按当前 rate 换算
  const usdcAmount = wazToUsdc(req.amount as number)
  const amountRaw = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS))
  // P0-2: 防黑洞 — 极端 rate 下舍入到 0 会让 transfer 转 0 但用户余额已扣
  if (amountRaw <= 0n) {
    db.prepare("UPDATE withdrawal_requests SET status='rejected', status_detail='amount_rounded_to_zero' WHERE id=?").run(requestId)
    // 回滚扣款（之前路径里扣了 WAZ）
    db.prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = ?").run(req.amount, req.user_id)
    return { success: false, error: '汇率换算后金额为 0，请提高提现额或联系管理员' }
  }
  // H-4 P0: 失败路径需把 'processing' 还原回 'pending'，让 admin 可重试

  const hotBalance = await publicClient.readContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'balanceOf', args: [HOT_WALLET_ADDR],
  }) as bigint

  if (hotBalance < amountRaw) {
    // H-4 P0: 还原 processing → pending（admin 补钱后可重试）
    db.prepare("UPDATE withdrawal_requests SET status='pending', status_detail='hot_wallet_shortfall' WHERE id=?").run(requestId)
    // P1-3: 热钱包枯竭告警 — broadcast + 通知所有 admin
    const shortfall = (Number(amountRaw) - Number(hotBalance)) / 1e6
    try { broadcastSystemEvent('hotwallet_shortfall', '🚨', `热钱包余额不足，缺口 ${shortfall.toFixed(2)} USDC`, requestId) } catch {}
    try {
      const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: string }>
      for (const a of admins) {
        db.prepare(`INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)`)
          .run(generateId('ntf'), a.id, '🚨 热钱包余额不足', `提现 ${requestId} 失败，缺口 ${shortfall.toFixed(2)} USDC。请补充热钱包。`, null)
      }
    } catch {}
    return { success: false, error: `热钱包余额不足（需 ${usdcAmount} USDC，现有 ${Number(hotBalance) / 1e6} USDC）` }
  }

  let txHash: `0x${string}`
  try {
    txHash = await hotWalletClient.writeContract({
      address: USDC_SEPOLIA, abi: USDC_ABI,
      functionName: 'transfer',
      args: [req.to_address as `0x${string}`, amountRaw],
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
  } catch (e) {
    // H-4 P0: 链上失败 → 还原 processing → pending（避免锁死）
    db.prepare("UPDATE withdrawal_requests SET status='pending', status_detail=? WHERE id=?").run('chain_error:' + (e as Error).message.slice(0, 100), requestId)
    return { success: false, error: '链上交易失败: ' + (e as Error).message }
  }

  db.prepare("UPDATE withdrawal_requests SET status='processed', tx_hash=?, processed_at=datetime('now') WHERE id=?")
    .run(txHash, requestId)
  console.log(`💸 提现完成：${req.amount} USDC → ${(req.to_address as string).slice(0, 10)}... (${txHash.slice(0, 10)}...)`)
  return { success: true, txHash }
}

// ─── 充值监听 ─────────────────────────────────────────────────

async function checkDeposits() {
  const rows = db.prepare(
    'SELECT user_id, deposit_address FROM wallets WHERE deposit_address IS NOT NULL'
  ).all() as { user_id: string; deposit_address: string }[]
  if (rows.length === 0) return

  const addrToUser = new Map(rows.map(r => [r.deposit_address.toLowerCase(), r.user_id]))

  const latestBlock = await publicClient.getBlockNumber()
  const savedRow = db.prepare("SELECT value FROM system_state WHERE key = 'last_deposit_block'").get() as { value: string } | undefined
  let fromBlock = savedRow ? BigInt(savedRow.value) + 1n : latestBlock - 50n
  if (fromBlock > latestBlock) return
  // 回归测试发现：Base Sepolia RPC 限 2000 块每次 getLogs；clamp 上限 1900
  const MAX_RANGE = 1900n
  if (latestBlock - fromBlock > MAX_RANGE) {
    fromBlock = latestBlock - MAX_RANGE
  }

  const logs = await publicClient.getLogs({
    address: USDC_SEPOLIA,
    event: transferEvent,
    args: { to: rows.map(r => r.deposit_address as `0x${string}`) },
    fromBlock,
    toBlock: latestBlock,
  })

  // Wave G-2: 等待 N 块确认
  const requiredConf = getProtocolParam<number>('usdc_required_confirmations', 12)
  const minDeposit = getProtocolParam<number>('usdc_min_deposit', 0.01)

  for (const log of logs as (Log & { args: { to: string; value: bigint }; transactionHash: string; blockNumber: bigint })[]) {
    const txHash  = log.transactionHash
    const toAddr  = log.args.to?.toLowerCase()
    const userId  = addrToUser.get(toAddr)
    if (!userId) continue

    const existing = db.prepare('SELECT confirmed_at, swept FROM deposit_txns WHERE tx_hash = ?').get(txHash) as { confirmed_at: string | null; swept: number } | undefined
    if (existing && existing.confirmed_at) continue  // 已确认入账过

    // Wave G-3: 确认进度
    const confs = Number(latestBlock - log.blockNumber)
    const usdcAmount = Number(log.args.value) / 10 ** USDC_DECIMALS
    if (usdcAmount < minDeposit) continue  // 小额忽略

    if (!existing) {
      // 首次见到：记 pending（confirmed_at=NULL, credited_waz=NULL）
      db.prepare('INSERT INTO deposit_txns (tx_hash, user_id, amount, block_number, block_at_seen) VALUES (?,?,?,?,?)')
        .run(txHash, userId, usdcAmount, Number(log.blockNumber), Number(latestBlock))
    }
    if (confs < requiredConf) continue  // 还没足够确认数，下一轮再来

    // Wave G-2: 用 rate 换算 WAZ，入账
    const wazAmount = usdcToWaz(usdcAmount)
    db.prepare("UPDATE deposit_txns SET credited_waz = ?, confirmed_at = datetime('now') WHERE tx_hash = ?")
      .run(wazAmount, txHash)
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(wazAmount, userId)

    const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined)?.name ?? userId
    console.log(`💰 充值到账：${name} +${wazAmount} WAZ (${usdcAmount} USDC, ${txHash.slice(0, 10)}...)`)
    // 广播
    try { broadcastSystemEvent('deposit', '💰', `${name} 充值 ${usdcAmount} USDC → +${wazAmount} WAZ`, userId) } catch {}

    // 异步归集，不阻塞充值到账
    sweepToHotWallet(userId, toAddr!).catch(e =>
      console.error(`归集失败 (${userId}):`, e.message)
    )
  }

  db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('last_deposit_block', ?)")
    .run(latestBlock.toString())
}

function startDepositWatcher() {
  checkDeposits().catch(e => console.error('充值扫描出错：', e.message))
  setInterval(() => {
    checkDeposits().catch(e => console.error('充值扫描出错：', e.message))
  }, DEPOSIT_POLL_MS)
  console.log(`⛓  充值监听已启动（${IS_MAINNET ? '⚠ Base MAINNET' : 'Base Sepolia'}，每 ${DEPOSIT_POLL_MS / 1000}s 扫描）`)
  console.log(`🏦 热钱包地址：${HOT_WALLET_ADDR}`)
  console.log(`💵 USDC 合约：${USDC_CONTRACT}`)

  // 2026-05-23 多链 watcher 适配层（接口预留）
  // 当前实现：仅 usdc_base 一条链。未来新链接入按下列接口注册：
  //   interface ChainWatcher {
  //     methodId: string                       // 对应 payment_methods.id
  //     start(): void                          // 启动轮询
  //     checkDeposits(): Promise<void>         // 单次扫描
  //     sweep(userId: string, toAddr: string): Promise<void>  // 归集到热钱包
  //   }
  // 启动时把 payment_methods.status='active' 且 kind='crypto_onchain' 的方法对齐到 watcher_status
  try {
    db.prepare(`UPDATE payment_methods SET watcher_status = 'active' WHERE id = 'usdc_base'`).run()
    // 列出其他声明为 active 但无实现的方法 → 警告
    const orphans = db.prepare(`
      SELECT id, display_name FROM payment_methods
      WHERE status = 'active' AND kind = 'crypto_onchain' AND id != 'usdc_base'
    `).all() as Array<{ id: string; display_name: string }>
    for (const o of orphans) {
      console.warn(`⚠ payment_method '${o.id}' (${o.display_name}) 声明 active 但无 ChainWatcher 实现 — 自动降级 watcher_status='failing'`)
      db.prepare(`UPDATE payment_methods SET watcher_status = 'failing' WHERE id = ?`).run(o.id)
    }
  } catch (e) { console.error('[ChainWatcher registry]', e) }
}

// ─── 错误监控（2026-05-22 audit P1）─────────────────────────────
// 轻量级自建错误上报 — 避免外部 Sentry 依赖
// 后端：进程级 uncaughtException + unhandledRejection
// 前端：POST /api/error-report（window.onerror → 入此表）
initErrorLogSchema(db)

// ─── 治理岗位上岗(W3.5-B,2026-06-02)──────────────────────────
// docs/GOVERNANCE-ONBOARDING.md — arbitrator + verifier 申请 / 上岗 / 卸任 / 申诉
// 1 表:governance_applications(append-only,记录 apply/activate/resign/auto_deactivate/appeal)
db.exec(`
  CREATE TABLE IF NOT EXISTS governance_applications (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id),
    role                TEXT NOT NULL,           -- 'arbitrator' | 'verifier'
    action              TEXT NOT NULL,           -- 'apply' | 'activate' | 'resign' | 'auto_deactivate' | 'appeal' | 'reconfirm'
    status              TEXT NOT NULL,           -- 'pending_onboarding' | 'active' | 'inactive' | 'rejected' | 'cooldown'
    consent_hash        TEXT,                    -- apply 时披露文本 hash
    passkey_sig         TEXT,                    -- apply / activate / resign Passkey 签发证据
    iron_rule_method    TEXT,                    -- 'passkey' | 'password' | 'system_auto'
    quiz_score          INTEGER,                 -- 0-100(activate 时)
    case_review_text    TEXT,                    -- onboarding §4.2 案例分析(摘要)
    cooldown_until      INTEGER,                 -- resign / auto_deactivate 后到期 timestamp
    appeal_reason       TEXT,                    -- appeal 时填
    appeal_resolution   TEXT,                    -- maintainer 处置 + 理由
    ip_hash             TEXT,
    ua_hash             TEXT,
    created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_gov_apps_user ON governance_applications(user_id, created_at DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_gov_apps_role_status ON governance_applications(role, status, created_at DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_gov_apps_cooldown ON governance_applications(user_id, role, cooldown_until)') } catch {}
// 2026-06-02 PR #22 review fix P1-3:quiz pass 推进状态时间戳(spec §4.3 onboarding 题目环节完成标记)
try { db.exec('ALTER TABLE governance_applications ADD COLUMN quiz_passed_at INTEGER') } catch {}
// 2026-06-02 task #1093 阶段 4:appeal 行指向被申诉的 auto_deactivate 原行(链接审计 + 防重复 appeal)
try { db.exec('ALTER TABLE governance_applications ADD COLUMN source_application_id TEXT') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_gov_apps_source ON governance_applications(source_application_id) WHERE source_application_id IS NOT NULL') } catch {}

// ─── RFC-002 PR-1a schema(task #1090,2026-06-03)/ rewards opt-in 基础设施 ──────
// spec: docs/rfcs/RFC-002-rewards-opt-in.md §3.6
// scope:本 PR 仅 schema(3 新表 + 2 ALTER + 5 新 protocol_params)。
//        所有表为空,无 code 读 — 零行为变化。后续 PR-1b/1c 接入估值层 gate + escrow 逻辑。

// 1. users 加列(rewards_opt_in flag,默认 0 = opt-out)
try { db.exec('ALTER TABLE users ADD COLUMN rewards_opted_in INTEGER DEFAULT 0') } catch {}

// 2. protocol_params 加 requires_meta_rule_change 列(P0-4 闭环 — 把声明保护转为执行保护)
try { db.exec('ALTER TABLE protocol_params ADD COLUMN requires_meta_rule_change INTEGER DEFAULT 0') } catch {}

// 3. rewards_consent_texts:同意文本版本化(§3.10),先建,被 rewards_applications FK 引用
db.exec(`
  CREATE TABLE IF NOT EXISTS rewards_consent_texts (
    version       TEXT PRIMARY KEY,            -- e.g. '1.0', '1.1', '2.0'
    hash          TEXT NOT NULL,               -- sha256 of canonical text
    change_class  TEXT NOT NULL,               -- 'major' | 'minor'
    effective_at  INTEGER NOT NULL,
    text_zh       TEXT NOT NULL,
    text_en       TEXT NOT NULL,
    changelog     TEXT                         -- human-readable diff summary
  )
`)

// PR-3 slice 2: seed v1.0 (major). Text is canonical placeholder pointing
// to RFC-002; PR-2 disclosure page will render the user-facing rich text.
// Hash is sha256 of (text_zh + "\n---\n" + text_en) so any future text
// change forces a hash bump + new version row.
;(function seedConsentV1() {
  const existing = db.prepare("SELECT version FROM rewards_consent_texts WHERE version = '1.0'").get()
  if (existing) return
  const textZh = 'WebAZ 共建身份(rewards opt-in)v1.0 — 由 RFC-002 §3.3 / §3.10 定义。本同意涉及经济关系登记 + Passkey 真人签名 + 三级佣金 + 积分配对参与。详见 RFC-002 全文。本流程与购物无关,可随时退出,不影响订单。'
  const textEn = 'WebAZ Builder Identity (rewards opt-in) v1.0 — defined by RFC-002 §3.3 / §3.10. This consent records an economic relationship with Passkey-signed proof of personhood + participation in 3-tier commission + points-matching. See full RFC-002. This flow is not part of shopping; you may leave anytime without affecting orders.'
  const hash = createHash('sha256').update(textZh + '\n---\n' + textEn).digest('hex')
  db.prepare(`INSERT INTO rewards_consent_texts (version, hash, change_class, effective_at, text_zh, text_en, changelog)
              VALUES (?, ?, 'major', ?, ?, ?, ?)`)
    .run('1.0', hash, Date.now(), textZh, textEn, 'Initial v1.0 lock — placeholder canonical text pointing to RFC-002')
})()

// v1.1 (major) — clarified wording: drops the "共建身份 / Builder Identity" framing that confused users
// with the contribution system / GitHub claim / build reputation, and states the current commission-level
// reality boundary (pre-launch global cap = 1 level; "three tiers" = protocol maximum design). v1.0 stays
// FROZEN (hash-bound, immutable per version); the status + activate endpoints already serve the latest
// change_class='major' row, so this becomes the shown + consented text with no route-logic change.
//
// ⚠️ DEPLOY GATE (Codex #354 P2) — publishing a NEW change_class='major' consent arms the auto-downgrade
// cron (rewards-auto-downgrade.ts): any user with rewards_opted_in=1 whose last consent version predates
// this major gets auto-downgraded after the reconfirm grace. There is currently NO reconfirm UI/endpoint
// (apply rejects ALREADY_OPTED_IN), so a new major is ONLY safe to deploy when there are ZERO opted-in
// users. Before shipping a new major, an operator MUST verify on the target DB:
//     SELECT COUNT(*) FROM users WHERE rewards_opted_in = 1;   -- must be 0
// (read-only). v1.1 was verified safe 2026-06-13: opted_in=0 on production (apps=2 were a complete
// activate→deactivate cycle, none left opted-in). If a future bump finds opted_in>0, build a reconfirm
// path first or do not publish as major. See RFC-002 §3.10 "Deploying a new major consent version".
;(function seedConsentV11() {
  const existing = db.prepare("SELECT version FROM rewards_consent_texts WHERE version = '1.1'").get()
  if (existing) return
  const textZh = 'WebAZ 分享分润开通(rewards opt-in) v1.1 — 由 RFC-002 §3.3 / §3.10 定义。本同意仅用于记录分享分润相关的经济关系:Passkey 真人签名、推荐关系/左右区位置、佣金/PV/escrow 结算规则。本流程不是购物流程,也不是共建贡献资格;不影响贡献任务、GitHub 贡献认领或普通下单。佣金层级按地区合规配置生效;当前预发布期全局上限为 1 级,“三级”仅为协议最大设计。你可以随时退出,退出不影响已下单或未来订单;已发生的订单和结算按当时有效规则处理。'
  const textEn = 'WebAZ share-commission opt-in (rewards opt-in) v1.1 — defined by RFC-002 §3.3 / §3.10. This consent only records the economic relationship for share commission: Passkey-signed proof of personhood, referral relationship / left-right placement, and commission / PV / escrow settlement rules. This is not a shopping flow and not contribution eligibility; it does not affect contribution tasks, GitHub contribution claims, or normal orders. Commission levels follow per-region compliance configuration; during pre-launch the global cap is 1 level, and “three tiers” is only the protocol maximum design. You may leave at any time without affecting past or future orders; already-created orders and settlements follow the rules effective at that time.'
  const hash = createHash('sha256').update(textZh + '\n---\n' + textEn).digest('hex')
  // effective_at must be strictly later than v1.0's so "latest major" deterministically resolves to v1.1
  // even on a fresh DB that seeds both rows in the same boot (avoids a same-ms ORDER BY tie).
  const v10 = db.prepare("SELECT effective_at FROM rewards_consent_texts WHERE version = '1.0'").get() as { effective_at: number } | undefined
  const effectiveAt = Math.max(Date.now(), (v10?.effective_at ?? 0) + 1)
  db.prepare(`INSERT INTO rewards_consent_texts (version, hash, change_class, effective_at, text_zh, text_en, changelog)
              VALUES (?, ?, 'major', ?, ?, ?, ?)`)
    .run('1.1', hash, effectiveAt, textZh, textEn, 'v1.1 clarification — share-commission opt-in framing (not 共建身份/Builder Identity, not contribution eligibility) + current commission-level reality boundary (pre-launch cap 1 level); v1.0 left frozen')
})()

// 4. rewards_applications:申请留痕表(append-only audit;action='activate'|'deactivate'|'auto_downgrade'|'reconfirm')
db.exec(`
  CREATE TABLE IF NOT EXISTS rewards_applications (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              TEXT NOT NULL,
    action               TEXT NOT NULL,        -- 'activate' | 'deactivate' | 'auto_downgrade' | 'reconfirm'
    consent_version      TEXT,                 -- FK rewards_consent_texts(version); activate/reconfirm 必填
    consent_hash         TEXT,                 -- sha256 of versioned disclosure; activate/reconfirm 必填
    passkey_sig          TEXT,                 -- WebAuthn sig blob; activate/reconfirm required; auto_downgrade 系统侧无签名
    verification_method  TEXT NOT NULL,        -- 'passkey' | 'password' | 'system_auto'
    ip_hash              TEXT,                 -- anonymized IP audit
    ua_hash              TEXT,
    created_at           INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (consent_version) REFERENCES rewards_consent_texts(version)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rewards_apps_user ON rewards_applications(user_id, created_at DESC)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rewards_apps_action ON rewards_applications(user_id, action, created_at DESC)') } catch {}

// 5. pending_commission_escrow:opt-out promoter 待激活领取队列(§3.5b)
// PR-1c-b: order_id is NULLable so attribution_path='pv_pair' rows (which accrue
// across many orders) can record amount without inventing a fake order_id.
// L1/L2/L3 rows still carry a real order_id, enforced by the gate code path
// in settleCommission (not by NOT NULL constraint).
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_commission_escrow (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_user_id        TEXT NOT NULL,
    order_id                 TEXT,                                 -- NULL for pv_pair (PR-1c-b)
    amount                   REAL NOT NULL,    -- WAZ amount
    attribution_path         TEXT NOT NULL,    -- 'L1' | 'L2' | 'L3' | 'pv_pair' | etc.
    status                   TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'settled' | 'expired'
    created_at               INTEGER NOT NULL,
    expires_at               INTEGER NOT NULL,
    settled_at               INTEGER,
    expired_to_charity_at    INTEGER,
    FOREIGN KEY (recipient_user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )
`)

// PR-1c-b: migration — if existing DB has order_id NOT NULL (from PR-1a / pre-1c-b),
// recreate the table. PRAGMA notnull=1 means NOT NULL. Idempotent: skips if already 0.
;(function migrateEscrowOrderIdNullable() {
  const cols = db.prepare("PRAGMA table_info(pending_commission_escrow)").all() as Array<{ name: string; notnull: number }>
  const orderIdCol = cols.find(c => c.name === 'order_id')
  if (!orderIdCol || orderIdCol.notnull === 0) return  // already nullable (or table missing entirely)
  console.log('[pc-escrow-migrate] order_id is NOT NULL — recreating table to allow NULL for pv_pair')
  db.exec('PRAGMA foreign_keys = OFF')
  db.transaction(() => {
    db.exec(`
      CREATE TABLE pending_commission_escrow_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_user_id        TEXT NOT NULL,
        order_id                 TEXT,
        amount                   REAL NOT NULL,
        attribution_path         TEXT NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'pending',
        created_at               INTEGER NOT NULL,
        expires_at               INTEGER NOT NULL,
        settled_at               INTEGER,
        expired_to_charity_at    INTEGER,
        FOREIGN KEY (recipient_user_id) REFERENCES users(id),
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `)
    db.exec('INSERT INTO pending_commission_escrow_new SELECT * FROM pending_commission_escrow')
    db.exec('DROP TABLE pending_commission_escrow')
    db.exec('ALTER TABLE pending_commission_escrow_new RENAME TO pending_commission_escrow')
  })()
  db.exec('PRAGMA foreign_keys = ON')
})()

try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrow_recipient ON pending_commission_escrow(recipient_user_id, status, expires_at)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrow_expiry ON pending_commission_escrow(status, expires_at)') } catch {}
// PR-1c-a: UNIQUE (recipient, order, path) defends against double-insert if settleCommission ever retries
// Note: NULL order_id (PR-1c-b pv_pair) is distinct in SQLite UNIQUE — idempotency for pv_pair relies
// on binary_score_records.settled_at instead (source-side dedup).
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_escrow_recipient_order_path ON pending_commission_escrow(recipient_user_id, order_id, attribution_path)') } catch {}

// Codex #69 P1:pv_escrow_reserve(#1106 隔离负债账)回填历史 pending pv_pair escrow —— 按 delta 对账,不全量转。
//   该列在 global_fund 上新增(line ~2319);#1106 之后新建的 pv_pair escrow 结算时【已】pv_escrow_reserve += wazAmount,
//   但加列【之前】产生的 pending pv_pair 从没进过 reserve。升级窗口里两者混存。
//   ⚠️ 不能"全量 SUM(pending pv_pair) 再转":会把已隔离的新 escrow 二次扣 pool。
//   正确做法:reserve 的目标值 = 当前所有 pending pv_pair 负债;只补差额 delta = liability - currentReserve 的正数部分。
//     · delta > 0:pool -= delta, reserve += delta(纯转账,total 不变);pool 不足则记 shortfall 风险项(基于 delta)。
//     · delta <= 0:已对齐/超额,不反向移动(避免误伤业务流);currentReserve > liability 记 anomaly 供核账。
//   幂等(system_state 标志)。放在 pending_commission_escrow 建表/迁移之后(ALTER-after-CREATE 铁律)。
try {
  db.exec("CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT)")
  const done = db.prepare("SELECT value FROM system_state WHERE key = 'pv_escrow_reserve_backfilled'").get() as { value: string } | undefined
  if (!done) {
    db.transaction(() => {
      const liability = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM pending_commission_escrow WHERE status='pending' AND attribution_path='pv_pair'`).get() as { s: number }).s
      const gf = db.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number } | undefined
      const pool = gf?.pool_balance ?? 0
      const currentReserve = gf?.pv_escrow_reserve ?? 0
      const delta = Math.round((liability - currentReserve) * 100) / 100   // 只补"尚未隔离"的部分
      if (delta > 0) {
        db.prepare("UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve + ?, pool_balance = pool_balance - ? WHERE id=1").run(delta, delta)
        console.log(`[migration pv_escrow_reserve backfill] 历史未隔离 pv_pair 负债 delta=${delta}(liability ${liability} - reserve ${currentReserve})从 pool 移入 reserve(pool ${pool}→${pool - delta})`)
        if (pool < delta) {
          const shortfall = Math.round((delta - pool) * 100) / 100
          console.error(`[migration pv_escrow_reserve backfill] ⚠️ pool_balance(${pool}) < 待回填 delta(${delta});pool 已为负,缺口 ${shortfall} 需人工核账`)
          db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('pv_escrow_reserve_backfill_shortfall', ?)").run(String(shortfall))
        }
      } else if (delta < 0) {
        // reserve 比 pending 负债还多 —— 不反向移动(避免误伤),只记异常供 admin 核账
        const anomaly = Math.round((currentReserve - liability) * 100) / 100
        console.error(`[migration pv_escrow_reserve backfill] ⚠️ pv_escrow_reserve(${currentReserve}) > pending pv_pair 负债(${liability}),超额 ${anomaly};不反向移动,记 anomaly 供核账`)
        db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('pv_escrow_reserve_backfill_anomaly', ?)").run(String(anomaly))
      } else {
        console.log(`[migration pv_escrow_reserve backfill] reserve(${currentReserve})已等于 pending pv_pair 负债(${liability}),无需回填`)
      }
      db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('pv_escrow_reserve_backfilled', '1')").run()
    })()
  }
} catch (e) { console.error('[migration pv_escrow_reserve backfill]', e) }

// 6. INSERT 5 个 RFC-002 protocol_params(独立 INSERT,不动 DEFAULT_PARAMS array)
// 两个标 requires_meta_rule_change=1:require_passkey + consent_delay_seconds(P0-4 闭环)
const RFC002_PARAMS: Array<{ key: string; value: string; type: string; description: string; category: string; min?: number; max?: number; metaRuleLocked: boolean }> = [
  { key: 'rewards_opt_in.min_completed_orders',  value: '1',  type: 'number', description: 'RFC-002 §3.2:申请 rewards opt-in 的最小已完成订单数', category: 'rewards', min: 0, max: 100, metaRuleLocked: false },
  { key: 'rewards_opt_in.require_passkey',       value: '1',  type: 'number', description: 'RFC-002 §3.3:申请 / 关闭是否需 Passkey(1=必须,0=允许 password)— META-RULE LOCKED,降低需 60d meta-rule track', category: 'rewards', min: 0, max: 1, metaRuleLocked: true },
  { key: 'rewards_opt_in.escrow_days',           value: '30', type: 'number', description: 'RFC-002 §3.5b:pending commission escrow 过期天数(过期后流入 charity_fund)', category: 'rewards', min: 7, max: 180, metaRuleLocked: false },
  { key: 'rewards_opt_in.consent_delay_seconds', value: '8',  type: 'number', description: 'RFC-002 §3.3:server-side 8s 反诱导延迟 — META-RULE LOCKED,降低需 60d meta-rule track', category: 'rewards', min: 0, max: 60, metaRuleLocked: true },
  { key: 'rewards_opt_in.reconfirm_grace_days',  value: '14', type: 'number', description: 'RFC-002 §3.10:major consent 变更后用户重新确认 grace 期(过期 auto_downgrade)', category: 'rewards', min: 3, max: 90, metaRuleLocked: false },
]
for (const p of RFC002_PARAMS) {
  try { db.prepare(`INSERT OR IGNORE INTO protocol_params (key, value, type, description, category, default_value, min_value, max_value, requires_meta_rule_change) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(p.key, p.value, p.type, p.description, p.category, p.value, p.min ?? null, p.max ?? null, p.metaRuleLocked ? 1 : 0) } catch {}
}

function logError(source: string, message: string, extra: Record<string, unknown> = {}) {
  try {
    db.prepare(`INSERT INTO error_log (source, message, stack, url, user_agent, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(source, message.slice(0, 2000), String(extra.stack || '').slice(0, 4000), String(extra.url || '').slice(0, 500), String(extra.user_agent || '').slice(0, 200), String(extra.user_id || ''))
  } catch (e) {
    console.error('logError DB failed:', (e as Error).message)
  }
}

process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err)
  logError('server-uncaught', err.message || String(err), { stack: err.stack })
})
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : ''
  console.error('💥 unhandledRejection:', reason)
  logError('server-rejection', msg, { stack })
})

// error-report — Phase 107 已迁出
// admin errors — Phase 106 已迁出

// ─── 启动 ─────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000
app.listen(PORT, () => {
  console.log(`✅ WebAZ 已启动：http://localhost:${PORT}`)
  console.log(`   手机访问：http://<本机IP>:${PORT}`)

  // 启动时立即扫描一次，之后每 5 分钟执行
  runEnforcement()
  setInterval(runEnforcement, ENFORCE_INTERVAL_MS)
  console.log(`⚡ 自动执法已启动（每 ${ENFORCE_INTERVAL_MS / 60000} 分钟扫描）`)

  // 链上充值监听
  startDepositWatcher()

  // 里程碑 4-L4：agent_call_log 每日清理（防表无限增长）
  const cleanAgentCallLog = () => {
    try {
      const r = db.prepare(`DELETE FROM agent_call_log WHERE created_at < datetime('now', '-30 days')`).run()
      if (r.changes > 0) console.log(`[M4-cron] agent_call_log: cleaned ${r.changes} rows >30d`)
    } catch (e) { console.error('[M4-cron]', e) }
  }
  setInterval(cleanAgentCallLog, 24 * 60 * 60 * 1000)   // 每 24h 跑一次
  console.log(`🧹 agent_call_log TTL cron 已启动（每 24h 清理 >30d）`)

  // S5 性价比认证 daily batch — 启动时立即跑一次（如未跑过），之后每 24h
  try {
    const lastRun = db.prepare(`SELECT MAX(value_badge_at) as t FROM products WHERE value_badge_at IS NOT NULL`).get() as { t: string | null }
    const stale = !lastRun?.t || (Date.now() - new Date(lastRun.t).getTime()) > 23 * 3600 * 1000
    if (stale) computeValueBadges()
  } catch (e) { console.error('[S5 startup compute]', e) }
  setInterval(computeValueBadges, 24 * 60 * 60 * 1000)
  console.log(`💎 性价比认证 daily batch 已启动（每 24h 重算 value_badge）`)

  // M-2: WebAuthn 过期表清理 — challenge / gate token 都是短命数据，无理由长期驻留
  const cleanWebAuthnExpired = () => {
    try {
      const ch = db.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < datetime('now', '-1 day')`).run()
      const gt = db.prepare(`DELETE FROM webauthn_gate_tokens WHERE expires_at < datetime('now', '-1 day')`).run()
      if (ch.changes > 0 || gt.changes > 0) {
        console.log(`[webauthn-cron] cleaned ch=${ch.changes} gt=${gt.changes}`)
      }
    } catch (e) { console.error('[webauthn-cron]', e) }
  }
  setInterval(cleanWebAuthnExpired, 6 * 60 * 60 * 1000)  // 每 6h 跑一次
  console.log(`🧹 webauthn 过期清理 cron 已启动（每 6h 清 >1d 残留）`)

  // task #1093 stage 5: governance auto-deactivate cron
  // Spec docs/ARBITRATION-PLAYBOOK.md §6.2 + GOVERNANCE-ONBOARDING.md §6.2
  // Anchor: confirmed_wrong (NOT outlier). Phase A: verifier only.
  startAutoDeactivateCron({ db, generateId, getProtocolParam })

  // #1090 RFC-002 PR-1c-a: escrow expire cron (every 1h)
  startEscrowExpireCron({ db, redirectToCommissionReserve })

  // #1090 RFC-002 PR-3 slice 2: auto_downgrade cron (every 24h)
  // Triggered when a new major consent text is published; opted-in users
  // who don't reconfirm within reconfirm_grace_days (14d default) get
  // rewards_opted_in flipped to 0 with action='auto_downgrade'. Per
  // PR-1c-a settleCommission gate, future commissions then route to
  // escrow (not charity) for re-activation recovery.
  startAutoDowngradeCron({ db, getProtocolParam })
})
