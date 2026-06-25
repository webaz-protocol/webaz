/**
 * Server-local schema init — DDL extracted from the server.ts boot path
 * (PR2 schema extraction, slice 1).
 *
 * Each function is pure idempotent DDL (`CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS`) — calling it on a populated DB is a no-op.
 * server.ts invokes these at the SAME position/order the inline blocks
 * previously ran, so boot order is unchanged. The SQL is byte-identical to
 * the former inline statements, so `npm run schema:verify` is zero-diff.
 */
import type Database from 'better-sqlite3'

// ─── 验证员白名单表 ───────────────────────────────────────────────
export function initVerifierWhitelistSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verifier_whitelist (
    user_id   TEXT PRIMARY KEY,
    added_at  TEXT DEFAULT (datetime('now')),
    note      TEXT
  )
`)
}

// ─── MCP 工具调用埋点表（远程上报）─────────────────────────────────
export function initMcpToolCallsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name      TEXT NOT NULL,
    user_id_hash   TEXT,
    server_version TEXT,
    outcome        TEXT NOT NULL,
    latency_ms     INTEGER NOT NULL,
    ts             TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tc_ts   ON mcp_tool_calls(ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tc_tool ON mcp_tool_calls(tool_name, ts)`)
}

// ─── 笔记图片 hash 索引表（审计修 C-1）─────────────────────────────
// hash PRIMARY KEY 天然唯一约束；删笔记时同步删对应行
export function initNotePhotoIndexSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS note_photo_index (
    hash         TEXT PRIMARY KEY,
    shareable_id TEXT NOT NULL
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_npi_shareable ON note_photo_index(shareable_id)") } catch {}
}

// ─── Wave A-1: 个人心愿单（独立于慈善 wishes）──────────────────────
export function initUserWishlistSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_wishlist (
    user_id      TEXT NOT NULL,
    product_id   TEXT NOT NULL,
    note         TEXT,
    notify_price_drop    INTEGER DEFAULT 1,
    notify_back_in_stock INTEGER DEFAULT 1,
    price_at_add REAL,
    created_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, product_id)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_wl_product ON user_wishlist(product_id)') } catch {}
}

// ─── Wave A-2: 商品 Q&A（公开问答 — 自动 FAQ + 防虚假承诺）─────────
export function initProductQaSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_qa (
    id           TEXT PRIMARY KEY,
    product_id   TEXT NOT NULL,
    asker_id     TEXT NOT NULL,
    seller_id    TEXT NOT NULL,
    question     TEXT NOT NULL,
    answer       TEXT,
    answered_at  TEXT,
    is_public    INTEGER DEFAULT 1,
    helpful_count INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_qa_product ON product_qa(product_id, created_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_qa_seller ON product_qa(seller_id, answered_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_qa_asker ON product_qa(asker_id)') } catch {}
  // 防重复 +1 的 votes 表
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_qa_helpful_voters (
    qa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    voted_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (qa_id, user_id)
  )
`)
}

// ─── Wave A-3: 优惠券 / 限时折扣（卖家发券 · 全店满减 · 单品限时）──
export function initCouponsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS coupons (
    id               TEXT PRIMARY KEY,
    seller_id        TEXT NOT NULL,
    code             TEXT NOT NULL,
    scope            TEXT NOT NULL,           -- 'product' | 'shop' | 'all'
    scope_id         TEXT,                    -- product_id when scope='product'
    discount_type    TEXT NOT NULL,           -- 'percentage' | 'fixed'
    discount_value   REAL NOT NULL,
    min_order_amount REAL DEFAULT 0,
    max_uses         INTEGER DEFAULT 0,       -- 0 = unlimited
    uses_count       INTEGER DEFAULT 0,
    starts_at        TEXT,
    expires_at       TEXT,
    is_active        INTEGER DEFAULT 1,
    created_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(seller_id, code)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_coupons_seller ON coupons(seller_id, is_active)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_coupons_scope ON coupons(scope, scope_id) WHERE is_active = 1') } catch {}
}

// ─── Wave A-4: 平台公告（admin 发布 → 角色 / 区域定向）+ 阅读记录 ──
export function initAnnouncementsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id              TEXT PRIMARY KEY,
    author_id       TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    target_roles    TEXT,                    -- JSON array: ['buyer','seller'] or null=all
    target_regions  TEXT,                    -- JSON array: ['china','us'] or null=all
    severity        TEXT DEFAULT 'info',     -- 'info' | 'warning' | 'critical'
    is_active       INTEGER DEFAULT 1,
    starts_at       TEXT,
    expires_at      TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_ann_active ON announcements(is_active, created_at DESC)') } catch {}

  // 用户阅读记录（PK 防重复 dismiss）
  db.exec(`
  CREATE TABLE IF NOT EXISTS announcement_reads (
    user_id      TEXT NOT NULL,
    announcement_id TEXT NOT NULL,
    read_at      TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, announcement_id)
  )
`)
}

// ─── Wave B-2: 预售 / waitlist（缺货商品允许买家排队 → 回货时通知）──
export function initProductWaitlistSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_waitlist (
    user_id      TEXT NOT NULL,
    product_id   TEXT NOT NULL,
    desired_qty  INTEGER DEFAULT 1,
    note         TEXT,
    notified_at  TEXT,                    -- 回货时填，表示已发通知
    created_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, product_id)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_product ON product_waitlist(product_id) WHERE notified_at IS NULL') } catch {}
}

// ─── Wave D-4: 限时促销 / Flash Sale ───────────────────────────────
export function initFlashSalesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS flash_sales (
    id              TEXT PRIMARY KEY,
    seller_id       TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    variant_id      TEXT,                 -- 可选，绑定具体规格
    sale_price      REAL NOT NULL,
    original_price  REAL NOT NULL,        -- 创建时快照，用于显示「省 X」
    max_qty         INTEGER DEFAULT 0,    -- 0 = 不限
    sold_count      INTEGER DEFAULT 0,
    starts_at       TEXT NOT NULL,
    ends_at         TEXT NOT NULL,
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_flash_product ON flash_sales(product_id, is_active)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_flash_seller ON flash_sales(seller_id, ends_at DESC)') } catch {}
}

// ─── 首屏「我有建议」公开收集（匿名可投，登录态自动绑 user_id）──────
export function initPublicIdeasSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS public_ideas (
    id            TEXT PRIMARY KEY,
    user_id       TEXT,                                  -- 可空（匿名提交）
    contact       TEXT,                                  -- 可选 email / handle / 任何联系方式
    content       TEXT NOT NULL,
    ip_hash       TEXT,
    ua_hash       TEXT,
    status        TEXT NOT NULL DEFAULT 'new',          -- new / triaged / resolved / spam
    created_at    TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pi_status ON public_ideas(status, created_at DESC)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pi_rate ON public_ideas(ip_hash, created_at)") } catch {}
}

// ─── #959: 拍卖「⏰ 提醒我」（1 订阅 = 多行，每个 lead 时间一行）────
export function initAuctionRemindersSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS auction_reminders (
    id            TEXT PRIMARY KEY,                   -- arm_xxxx
    auction_id    TEXT NOT NULL REFERENCES auctions(id),
    user_id       TEXT NOT NULL REFERENCES users(id),
    lead_minutes  INTEGER NOT NULL,                   -- 提前多少分钟提醒
    fire_at       TEXT NOT NULL,                      -- deadline - lead_minutes（创建时算好）
    sent_at       TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(auction_id, user_id, lead_minutes)
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_arm_due ON auction_reminders(sent_at, fire_at) WHERE sent_at IS NULL") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_arm_user ON auction_reminders(user_id, auction_id)") } catch {}
}

// ─── 邮箱订阅独立表（GDPR-ready）— 与 ideas 解耦 ───────────────────
// consent 显式存；unsubscribe_token 让用户主动退订；source 区分来源
// 注：后续 ALTER 列扩展刻意保留在 server.ts 原位（紧跟本 init 调用之后）
export function initEmailSubscriptionsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS email_subscriptions (
    id                   TEXT PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE,
    source               TEXT NOT NULL DEFAULT 'welcome',
    consent_at           TEXT NOT NULL DEFAULT (datetime('now')),
    unsubscribe_token    TEXT NOT NULL UNIQUE,
    unsubscribed_at      TEXT,
    ip_hash              TEXT,
    user_id              TEXT,
    created_at           TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_es_status ON email_subscriptions(unsubscribed_at, created_at DESC)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_es_source ON email_subscriptions(source, created_at DESC)") } catch {}
}

// ─── Wave D-3: 用户反馈 / 客服工单（buyer-to-platform，独立于 disputes）──
// 注：后续 ALTER 列扩展刻意保留在 server.ts 原位（紧跟本 init 调用之后）
export function initFeedbackTicketsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_tickets (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    category      TEXT NOT NULL,         -- 'bug' | 'abuse' | 'feature' | 'account' | 'other'
    severity      TEXT DEFAULT 'medium', -- 'low' | 'medium' | 'high'
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',  -- open | in_progress | resolved | closed
    admin_reply   TEXT,
    replied_by    TEXT,
    replied_at    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback_tickets(user_id, created_at DESC)') } catch {}
}

// ─── W7 客服 ticket-thread — 多轮消息（user ↔ admin）─────────────────
// 注：后续 ALTER 列扩展刻意保留在 server.ts 原位（紧跟本 init 调用之后）
export function initFeedbackMessagesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_messages (
    id          TEXT PRIMARY KEY,            -- fmsg_xxx
    ticket_id   TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_role TEXT NOT NULL,               -- 'user' | 'admin'
    body        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_fmsg_ticket ON feedback_messages(ticket_id, created_at)') } catch {}
}

// ─── 公开判例（裁决后脱敏版本，disputes 是当事人/仲裁员私域）────────
export function initDisputeCasesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS dispute_cases (
    id              TEXT PRIMARY KEY,            -- dcase_xxx
    dispute_id      TEXT,                         -- 原始 disputes.id (内部追溯)
    order_id        TEXT,
    product_id      TEXT,                         -- 关键索引：按商品查公开判例
    seller_id       TEXT,
    buyer_id        TEXT,                         -- 仅内部使用，不外露
    category_tag    TEXT,                         -- 物流 / 质量 / 描述不符 / 售后 / 拒收 / 其他
    winner          TEXT,                         -- buyer / seller / split / dismissed
    resolution      TEXT,                         -- 简短人读判决 (如 '全额退款')
    amount_bucket   TEXT,                         -- '0-100' / '100-500' / '500-2000' / '2000+' WAZ
    buyer_argument  TEXT,                         -- 脱敏后买家陈述
    seller_argument TEXT,                         -- 脱敏后卖家陈述
    ruling_text     TEXT,                         -- 仲裁员判决书
    arbitrator_id   TEXT,
    fairness_yes    INTEGER DEFAULT 0,
    fairness_no     INTEGER DEFAULT 0,
    comment_count   INTEGER DEFAULT 0,
    published_at    TEXT DEFAULT (datetime('now')),
    created_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dcase_product ON dispute_cases(product_id, published_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dcase_seller ON dispute_cases(seller_id, published_at DESC)') } catch {}
}

// ─── 公开判例评论（一案一人一次；anonymous ALTER + 索引留 server.ts 原位）──
export function initDisputeCommentsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS dispute_comments (
    id              TEXT PRIMARY KEY,            -- dcom_xxx
    case_id         TEXT NOT NULL,
    commenter_id    TEXT NOT NULL,
    body            TEXT NOT NULL,
    flagged         INTEGER DEFAULT 0,
    likes           INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(case_id, commenter_id)                -- 一案一人一次（防刷）
  )
`)
}

// ─── W5 仲裁公开评论楼中楼 — 单层子回复 ────────────────────────────
export function initDisputeCommentRepliesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS dispute_comment_replies (
    id                TEXT PRIMARY KEY,           -- drep_xxx
    parent_comment_id TEXT NOT NULL,              -- 指向 dispute_comments.id
    case_id           TEXT NOT NULL,
    replier_id        TEXT NOT NULL,
    body              TEXT NOT NULL,
    anonymous         INTEGER DEFAULT 0,
    likes             INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_drep_parent ON dispute_comment_replies(parent_comment_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_drep_case ON dispute_comment_replies(case_id, created_at DESC)') } catch {}
}

// ─── W6 笔记评论 — 原生 parent_id 楼中楼（仅 1 层）─────────────────
export function initShareableCommentsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS shareable_comments (
    id           TEXT PRIMARY KEY,                -- scom_xxx
    shareable_id TEXT NOT NULL,                    -- shareables.id
    commenter_id TEXT NOT NULL,
    parent_id    TEXT,                             -- 子评论指向父评论；root = NULL
    body         TEXT NOT NULL,
    flagged      INTEGER DEFAULT 0,
    likes        INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_scom_shareable ON shareable_comments(shareable_id, parent_id, created_at DESC)') } catch {}
}

// ─── 公开判例公平性投票（一案一人一票）──────────────────────────────
export function initDisputeFairnessVotesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS dispute_fairness_votes (
    case_id     TEXT NOT NULL,
    voter_id    TEXT NOT NULL,
    vote        TEXT NOT NULL,                   -- 'yes' / 'no'
    created_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (case_id, voter_id)
  )
`)
}

// ─── Wave C-3: 买家评价 / 评分（完成订单后给卖家 1-5 星 + 文字）──────
// 注：后续结构化维度 ALTER + 跨表 orders 索引刻意保留在 server.ts 原位
export function initOrderRatingsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS order_ratings (
    order_id     TEXT PRIMARY KEY,
    buyer_id     TEXT NOT NULL,
    seller_id    TEXT NOT NULL,
    product_id   TEXT NOT NULL,
    stars        INTEGER NOT NULL,            -- 1-5
    comment      TEXT,
    reply        TEXT,                        -- seller 可回复
    replied_at   TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rating_seller ON order_ratings(seller_id, created_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rating_product ON order_ratings(product_id, created_at DESC)') } catch {}
  // P2 hot-path：覆盖 recommend_count 子查询（COUNT DISTINCT buyer_id WHERE product_id=? AND stars>=4）
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rating_recommend ON order_ratings(product_id, stars, buyer_id)') } catch {}
}

// ─── 反向评价：卖家给买家评分（双盲）──────────────────────────────
export function initBuyerRatingsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS buyer_ratings (
    order_id              TEXT PRIMARY KEY,
    seller_id             TEXT NOT NULL,
    buyer_id              TEXT NOT NULL,
    stars                 INTEGER NOT NULL,
    comment               TEXT,
    dim_payment_speed     INTEGER,
    dim_communication     INTEGER,
    dim_responsiveness    INTEGER,
    hidden_until          TEXT,
    created_at            TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_buyer_ratings_buyer ON buyer_ratings(buyer_id, created_at DESC)') } catch {}
}

// ─── Wave C-2: 多收货地址簿（buyer 保存常用地址，下单时选默认）──────
export function initUserAddressesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_addresses (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    label        TEXT NOT NULL,           -- 标签（家 / 公司 / 父母家）
    recipient    TEXT NOT NULL,
    phone        TEXT,
    region       TEXT,                    -- 省/市/区
    detail       TEXT NOT NULL,           -- 详细地址
    is_default   INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_addr_user ON user_addresses(user_id, is_default DESC)') } catch {}
}

// ─── P2P 店铺 ──────────────────────────────────────────────────────
export function initP2pShopsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS p2p_shops (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    thumbnail_uri   TEXT,
    peer_endpoint   TEXT,
    peer_pubkey     TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_p2p_shops_owner ON p2p_shops(owner_id, status)') } catch {}
}

// ─── 笔记点赞 ──────────────────────────────────────────────────────
export function initShareableLikesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS shareable_likes (
    id            TEXT PRIMARY KEY,
    shareable_id  TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(shareable_id, user_id)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_shr_likes_shr ON shareable_likes(shareable_id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_shr_likes_user ON shareable_likes(user_id, created_at DESC)') } catch {}
}

// ─── audit P2：收藏功能（小红书风格"收藏" tab）───────────────────────
export function initShareableBookmarksSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS shareable_bookmarks (
    id            TEXT PRIMARY KEY,
    shareable_id  TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(shareable_id, user_id)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_shr_bm_user ON shareable_bookmarks(user_id, created_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_shr_bm_shr ON shareable_bookmarks(shareable_id)') } catch {}
}

// ─── audit P1 backlog：# 话题/标签系统（小红书风格内容分发）──────────
export function initShareableTagsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS shareable_tags (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    shareable_id  TEXT NOT NULL,
    tag           TEXT NOT NULL,          -- 已 lowercase + trim，最长 30 字符
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(shareable_id, tag)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_shr_tags_tag ON shareable_tags(tag, created_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_shr_tags_shr ON shareable_tags(shareable_id)') } catch {}
}

// ─── manifest_registry = 原生 P2P 内容索引（仅 hash + 签名 + 元数据）──
export function initManifestRegistrySchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS manifest_registry (
    hash                 TEXT PRIMARY KEY,
    owner_id             TEXT NOT NULL,
    content_type         TEXT NOT NULL,
    byte_size            INTEGER NOT NULL,
    title                TEXT,
    description          TEXT,
    thumbnail_data_uri   TEXT,
    signature            TEXT NOT NULL,
    signed_at            TEXT NOT NULL,
    related_product_id   TEXT,
    related_anchor       TEXT,
    status               TEXT DEFAULT 'active',
    takedown_reason      TEXT,
    takedown_at          TEXT,
    takedown_by          TEXT,
    created_at           TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_mfst_owner ON manifest_registry(owner_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_mfst_product ON manifest_registry(related_product_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_mfst_anchor ON manifest_registry(related_anchor, status)") } catch {}
}

// ─── peer_directory = 在线 peer 注册（hash cache 持有者，heartbeat 5min 失效）──
export function initPeerDirectorySchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS peer_directory (
    peer_id             TEXT NOT NULL,
    manifest_hash       TEXT NOT NULL,
    is_owner            INTEGER DEFAULT 0,
    pin_intent          INTEGER DEFAULT 0,
    last_heartbeat      TEXT NOT NULL,
    bytes_served_total  INTEGER DEFAULT 0,
    PRIMARY KEY (peer_id, manifest_hash)
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_peer_hash ON peer_directory(manifest_hash, last_heartbeat DESC)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_peer_heartbeat ON peer_directory(last_heartbeat)") } catch {}
}

// ─── signaling_queue = WebRTC SDP/ICE 中继（TTL 2min，cron 清理）─────
export function initSignalingQueueSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS signaling_queue (
    id              TEXT PRIMARY KEY,
    to_peer_id      TEXT NOT NULL,
    from_peer_id    TEXT NOT NULL,
    signal_type     TEXT NOT NULL,
    signal_data     TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_sig_to ON signaling_queue(to_peer_id, delivered_at)") } catch {}
}

// ─── CHAT — 上下文绑定聊天（order / rfq / listing_qa）────────────────
export function initConversationsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    context_id      TEXT NOT NULL,
    user_a          TEXT NOT NULL,
    user_b          TEXT NOT NULL,
    last_message_at TEXT,
    last_preview    TEXT,
    unread_a        INTEGER NOT NULL DEFAULT 0,
    unread_b        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(kind, context_id, user_a, user_b)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_a ON conversations(user_a, last_message_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_b ON conversations(user_b, last_message_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_ctx ON conversations(kind, context_id)') } catch {}
}

// ─── 聊天消息（后续 kind/meta ALTER 刻意保留在 server.ts 原位）────────
export function initMessagesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id       TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    attachments     TEXT,
    flagged         INTEGER NOT NULL DEFAULT 0,
    flag_reasons    TEXT,
    read_at         TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id, created_at DESC)') } catch {}
}

// ─── 反诈举报表（chat report → 人工审核）──────────────────────────────
export function initChatReportsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS chat_reports (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id      TEXT,
    reporter_id     TEXT NOT NULL,
    reported_id     TEXT NOT NULL,
    reason          TEXT NOT NULL,
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_chatrpt_status ON chat_reports(status, created_at)') } catch {}
}

// ─── 配额提升申请 ──────────────────────────────────────────────────
export function initQuotaIncreaseApplicationsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS quota_increase_applications (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    current_quota   INTEGER,
    requested_quota INTEGER,
    reason          TEXT,
    status          TEXT DEFAULT 'pending',
    applied_at      TEXT DEFAULT (datetime('now')),
    reviewed_at     TEXT,
    reviewed_by     TEXT,
    decision_note   TEXT
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_quota_apps_status ON quota_increase_applications(status)') } catch {}
}

// ─── Verifier 申请记录 ─────────────────────────────────────────────
export function initVerifierApplicationsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verifier_applications (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    applied_at      TEXT DEFAULT (datetime('now')),
    reviewed_at     TEXT,
    reviewed_by     TEXT,
    decision_note   TEXT,
    snapshot        TEXT
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_verifier_apps_status ON verifier_applications(status)') } catch {}
}

// ─── Arbitrator 申请 + 白名单（外部仲裁员路径 — 与 verifier 平行）────
// 注：legacy 内部仲裁员 → 白名单的 migration INSERT 刻意保留在 server.ts 原位
export function initArbitratorReviewSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS arbitrator_applications (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    applied_at      TEXT DEFAULT (datetime('now')),
    reviewed_at     TEXT,
    reviewed_by     TEXT,
    decision_note   TEXT,
    snapshot        TEXT
  );
  CREATE TABLE IF NOT EXISTS arbitrator_whitelist (
    user_id         TEXT PRIMARY KEY,
    added_at        TEXT DEFAULT (datetime('now')),
    note            TEXT,
    is_system       INTEGER DEFAULT 0,
    granted_by      TEXT,
    stake_amount    INTEGER DEFAULT 0
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_arb_apps_status ON arbitrator_applications(status)') } catch {}
}

// ─── Verifier 申诉记录 ─────────────────────────────────────────────
export function initVerifierAppealsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verifier_appeals (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    task_id       TEXT,
    submission_id TEXT,
    reason        TEXT NOT NULL,
    evidence_urls TEXT DEFAULT '[]',
    status        TEXT DEFAULT 'pending',
    admin_note    TEXT,
    reviewed_by   TEXT,
    reviewed_at   TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_verifier_appeals_status ON verifier_appeals(status)') } catch {}
}

// ─── 用户暂停状态（admin 管理）────────────────────────────────────
export function initUserModerationSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_moderation (
    user_id        TEXT PRIMARY KEY,
    suspended      INTEGER DEFAULT 0,
    reason         TEXT,
    suspended_by   TEXT,
    suspended_at   TEXT
  )
`)
}

// ─── admin 操作审计日志（initAdminCoordinationSchema FK 依赖本表，须先建）──
export function initAdminAuditLogSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           TEXT PRIMARY KEY,
    admin_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    detail       TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at)') } catch {}
}

// ─── 验证码表（邮箱绑定 / 找回密钥 / 改密码 等共用）────────────────
export function initVerificationCodesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verification_codes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    channel     TEXT NOT NULL,           -- 'email' / 'phone'
    target      TEXT NOT NULL,           -- 邮箱地址 / 手机号
    code        TEXT NOT NULL,           -- 6 位数字
    purpose     TEXT NOT NULL,           -- 'bind_email' / 'recover_key' / ...
    attempts    INTEGER DEFAULT 0,
    used_at     TEXT,
    expires_at  TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup ON verification_codes(channel, target, purpose)') } catch {}
}

// ─── 里程碑 4：Agent observability/reputation schema ─────────────────
// 注：调用方 server.ts 保留原 try/catch 边界与 console.error label；
// 这些 DDL 原本无逐句 try/catch（靠外层大 try 兜底），此处照搬不加。
export function initAgentCallLogSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT,
    user_id TEXT,
    endpoint TEXT NOT NULL,
    method TEXT,
    status_code INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_acl_apikey_ts ON agent_call_log(api_key, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_acl_user_ts ON agent_call_log(user_id, created_at)`)
}

export function initAgentReputationSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_reputation (
    api_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trust_score REAL DEFAULT 0,
    level TEXT DEFAULT 'new',
    signals TEXT,                    -- JSON
    last_calculated_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_user ON agent_reputation(user_id)`)
}

// ─── Agent 治理（spec: docs/AGENT-GOVERNANCE.md）────────────────────
// agent_declarations：agent 自声明（trust > new 必须先登记）
export function initAgentDeclarationsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_declarations (
    api_key           TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    operator_name     TEXT NOT NULL,             -- 公司/开发者名
    operator_contact  TEXT NOT NULL,             -- email/handle/DID
    purpose           TEXT NOT NULL,             -- ≤200 字
    declared_scope    TEXT NOT NULL,             -- JSON: {roles, actions, regions}
    attestations      TEXT,                      -- JSON: {gdpr, kids_safe, no_pii_export, ...}
    repo_url          TEXT,
    homepage          TEXT,
    revoked_at        TEXT,                      -- 撤销时间（用户主动 revoke）
    revoked_reason    TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agd_operator ON agent_declarations(operator_name)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agd_revoked ON agent_declarations(revoked_at) WHERE revoked_at IS NOT NULL`)
}

// agent_attestations：bilateral consent（用户主动同意某 agent 的 scope）
export function initAgentAttestationsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_attestations (
    id                TEXT PRIMARY KEY,
    api_key           TEXT NOT NULL,             -- agent 的 api_key
    user_id           TEXT NOT NULL,             -- 同意此 agent 行动的用户
    approved_scope    TEXT NOT NULL,             -- JSON：用户实际批准的子集
    spend_cap_per_order REAL,                    -- 该用户给此 agent 的单笔下单上限（可空 = 沿用 declared_scope）
    spend_cap_daily   REAL,                      -- 24h 累计上限
    granted_at        TEXT DEFAULT (datetime('now')),
    revoked_at        TEXT,
    UNIQUE(api_key, user_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aat_user ON agent_attestations(user_id, revoked_at)`)
}

// agent_strikes：违规累积（3-strike state machine）
export function initAgentStrikesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_strikes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key           TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    severity          TEXT NOT NULL,             -- 'warning' | 'suspend_7d' | 'permanent'
    reason_code       TEXT NOT NULL,             -- 'fake_shipment' | 'mass_spam' | 'overlimit_order' | 'fraud_claim' | ...
    reason_detail     TEXT,
    reported_by       TEXT,                      -- user_id（举报人 / system / admin）
    related_ref       TEXT,                      -- 关联 order/dispute/claim_task id
    issued_at         TEXT DEFAULT (datetime('now')),
    expires_at        TEXT,                      -- warning=24h; suspend_7d=7d; permanent=null
    appeal_status     TEXT DEFAULT 'none',       -- 'none' | 'pending' | 'approved' | 'denied'
    appeal_reason     TEXT,
    appeal_decided_by TEXT,
    appeal_decided_at TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ast_apikey ON agent_strikes(api_key, issued_at DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ast_user ON agent_strikes(user_id, issued_at DESC)`)
  // 注：SQLite 不允许 partial index 用非确定性函数 (datetime('now'))；用 expires_at 普通索引代替
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ast_active ON agent_strikes(api_key, expires_at)`)
}

// agent_revocations：operator-级撤销（封禁同 operator 名下所有 agent）
export function initAgentRevocationsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_revocations (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind       TEXT NOT NULL,             -- 'api_key' | 'operator_name'
    target_value      TEXT NOT NULL,
    revoked_by        TEXT NOT NULL,             -- user_id（用户自己 OR root admin）
    revoked_by_role   TEXT,                      -- 'self' | 'admin'
    reason            TEXT,
    revoked_at        TEXT DEFAULT (datetime('now')),
    UNIQUE(target_kind, target_value, revoked_by)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_arev_target ON agent_revocations(target_kind, target_value)`)
}
