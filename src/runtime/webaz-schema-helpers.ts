/**
 * WebAZ shared schema helpers — pure idempotent DDL initializers.
 *
 * Neutral top-level module (relocated from src/pwa/server-schema.ts). It imports
 * nothing but the DB type, so both the PWA server boot path AND the MCP runtime
 * schema composition root (src/runtime/apply-webaz-runtime-schema.ts) can call
 * the SAME definitions — no divergent DDL copies. `src/pwa/server-schema.ts`
 * remains as a thin compatibility re-export of this file.
 *
 * Each function is pure idempotent DDL (`CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS` / guarded `ALTER TABLE`) — calling it on a
 * populated DB is a no-op, and it performs NO business-row INSERT/UPDATE/DELETE.
 * server.ts invokes these at the SAME position/order the inline blocks
 * previously ran, so boot order is unchanged. The SQL is byte-identical to
 * the former inline statements, so `npm run schema:verify` is zero-diff.
 *
 * INVARIANT: every exported `init*` function here must be a pure idempotent DDL
 * initializer — the composition root calls all of them generically.
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
  // PR-B 生产仲裁员生命周期字段(ADD COLUMN 必在 CREATE 后 —— schema 铁律)。legacy 行 status NULL 视为 active。
  for (const alter of [
    `ALTER TABLE arbitrator_whitelist ADD COLUMN status TEXT DEFAULT 'active'`,   // active | suspended | revoked
    `ALTER TABLE arbitrator_whitelist ADD COLUMN suspended_at TEXT`,
    `ALTER TABLE arbitrator_whitelist ADD COLUMN revoked_at TEXT`,
  ]) { try { db.exec(alter) } catch { /* 列已存在 */ } }
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

// ─── 里程碑 7.2：商品 alias 系统 schema ─────────────────────────────
// 注：调用方 server.ts 保留原 try/catch 边界与 console.error label；
// 这些 DDL 原本无逐句 try/catch（靠外层 try 兜底），此处照搬不加。
export function initProductAliasesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS product_aliases (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL,
    alias_type      TEXT NOT NULL,            -- 'external_id' | 'external_title' | 'short_url' | 'kouling_token' | 'title_substring'
    alias_value     TEXT NOT NULL,
    min_match_chars INTEGER DEFAULT 6,
    created_at      TEXT DEFAULT (datetime('now')),
    challenged_at   TEXT,                     -- M7.4 verifier 挑战时间
    status          TEXT DEFAULT 'active',    -- 'active' | 'revoked' | 'challenged'
    UNIQUE(alias_type, alias_value, product_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alias_value ON product_aliases(alias_value)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alias_product ON product_aliases(product_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alias_type ON product_aliases(alias_type)`)
}

// ─── M-5：region 切换 audit log + 24h 限流 ──────────────────────────
export function initRegionChangeLogSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS region_change_log (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    from_region TEXT,
    to_region   TEXT NOT NULL,
    ip          TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_region_change_user_ts ON region_change_log(user_id, created_at DESC)`)
}

// ─── P13: 购物车 ───────────────────────────────────────────────────
export function initCartItemsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS cart_items (
    user_id     TEXT NOT NULL,
    product_id  TEXT NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 1,
    added_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, product_id)
  )
`)
}

// ─── P14: 关注关系（社交电商）──────────────────────────────────────
export function initFollowsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    follower_id  TEXT NOT NULL,
    followee_id  TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (follower_id, followee_id)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)') } catch {}
}

// ─── Web Push 订阅 ─────────────────────────────────────────────────
export function initPushSubscriptionsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    endpoint      TEXT NOT NULL,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    user_agent    TEXT,
    enabled       INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, endpoint)
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id, enabled)') } catch {}
}

// ─── 用户会话（一键全登出 = rotate users.api_key）──────────────────
export function initUserSessionsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    api_key         TEXT NOT NULL,
    ip              TEXT,
    user_agent      TEXT,
    fingerprint_hash TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    last_seen_at    TEXT DEFAULT (datetime('now')),
    revoked_at      TEXT
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id, revoked_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_key ON user_sessions(api_key)') } catch {}
}

// ─── A2 黑名单（精准匹配护栏）──────────────────────────────────────
export function initUserBlocklistSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_blocklist (
    blocker_id  TEXT NOT NULL,
    blocked_id  TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id)
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_blocklist_blocker ON user_blocklist(blocker_id)") } catch {}
}

// ─── 导入次数追踪表 ────────────────────────────────────────────────
export function initImportLogsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS import_logs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)
}

// ─── 错误日志（server uncaught/rejection + client onerror）──────────
export function initErrorLogSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS error_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,    -- 'server-uncaught' | 'server-rejection' | 'client'
    message     TEXT NOT NULL,
    stack       TEXT,
    url         TEXT,             -- 客户端 location.href
    user_agent  TEXT,             -- 客户端 UA
    user_id     TEXT,             -- 已登录用户（可空）
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at)') } catch {}
}

// ─── 二手市场（1 件即 1 件，个人卖家，协议费 1%）───────────────────
// 注：调用方 server.ts 保留原 try/catch + [secondhand schema] label；
// 这些 DDL 原本无逐句 try/catch（靠外层 try 兜底），此处照搬不加。
export function initSecondhandItemsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS secondhand_items (
    id            TEXT PRIMARY KEY,
    seller_id     TEXT NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT,
    category      TEXT NOT NULL,        -- phone/computer/appliance/furniture/clothing/book/toy/sports/other
    condition_grade TEXT NOT NULL,      -- brand_new/like_new/lightly_used/well_used/heavily_used
    price         REAL NOT NULL,
    negotiable    INTEGER DEFAULT 0,
    images        TEXT,                 -- JSON 数组：dataURL 字符串 (最多 9 张)
    region        TEXT,
    fulfillment   TEXT DEFAULT 'both',  -- shipping / in_person / both
    status        TEXT DEFAULT 'available',  -- available / reserved / sold / closed
    view_count    INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    sold_at       TEXT,
    sold_order_id TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_si_status_created ON secondhand_items(status, created_at DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_si_seller ON secondhand_items(seller_id, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_si_cat ON secondhand_items(category, status)`)
}

// ─── 测评免单计划（1 product 1 row；后续无 ALTER）──────────────────
export function initProductTrialCampaignsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_trial_campaigns (
    id                TEXT PRIMARY KEY,                   -- ptc_xxxx
    -- 1 product 1 row (复用同一行：关闭后再开 = UPDATE status='active'，避免 UNIQUE 阻断 reopen)
    product_id        TEXT NOT NULL UNIQUE REFERENCES products(id),
    seller_id         TEXT NOT NULL REFERENCES users(id),
    quota_total       INTEGER NOT NULL,                   -- 总名额 1-200
    quota_claimed     INTEGER NOT NULL DEFAULT 0,
    reach_threshold   INTEGER NOT NULL,                   -- 综合 reach 阈值 (默认 50)
    min_chars         INTEGER NOT NULL DEFAULT 50,        -- 笔记最少字数
    min_days_live     INTEGER NOT NULL DEFAULT 7,         -- 笔记需 live 至少 N 天才评估
    status            TEXT NOT NULL DEFAULT 'active',     -- active / paused / closed
    created_at        TEXT DEFAULT (datetime('now')),
    closed_at         TEXT
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ptc_seller ON product_trial_campaigns(seller_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ptc_product ON product_trial_campaigns(product_id, status)") } catch {}
}

// ─── 测评免单认领（snap/audit ALTER 刻意留 server.ts 原位）──────────
export function initProductTrialClaimsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_trial_claims (
    id                TEXT PRIMARY KEY,                   -- pcl_xxxx
    campaign_id       TEXT NOT NULL REFERENCES product_trial_campaigns(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    seller_id         TEXT NOT NULL REFERENCES users(id),
    buyer_id          TEXT NOT NULL REFERENCES users(id),
    order_id          TEXT NOT NULL REFERENCES orders(id),
    note_id           TEXT,                               -- shareables.id with type='note'
    status            TEXT NOT NULL DEFAULT 'pending_note', -- pending_note / pending_threshold / refunded / expired / cancelled
    reach_score       REAL DEFAULT 0,
    metrics_json      TEXT,                               -- 最新评估的 {views, shares, conversions} 快照
    refund_amount     REAL,
    refunded_at       TEXT,
    expired_at        TEXT,
    last_eval_at      TEXT,
    claimed_at        TEXT DEFAULT (datetime('now')),
    note_linked_at    TEXT,
    UNIQUE(buyer_id, product_id)                          -- 一买家一商品仅 1 个名额
  )
`)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pcl_campaign ON product_trial_claims(campaign_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pcl_buyer ON product_trial_claims(buyer_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pcl_seller ON product_trial_claims(seller_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pcl_eval ON product_trial_claims(status, last_eval_at)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pcl_note ON product_trial_claims(note_id) WHERE note_id IS NOT NULL") } catch {}
}

// ─── Wave B-3: 退货请求（pickup ALTER 刻意留 server.ts 原位）────────
export function initReturnRequestsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS return_requests (
    id                   TEXT PRIMARY KEY,
    order_id             TEXT NOT NULL,
    buyer_id             TEXT NOT NULL,
    seller_id            TEXT NOT NULL,
    product_id           TEXT NOT NULL,
    reason               TEXT NOT NULL,          -- 'quality' | 'wrong_item' | 'damaged' | 'no_longer_needed' | 'other'
    reason_text          TEXT,
    refund_amount        DECIMAL(18,2),          -- 默认 = order.total_amount
    status               TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | refunded | escalated | cancelled | (direct_p2p) await_refund | refund_marked
    seller_response      TEXT,
    escalated_dispute_id TEXT,
    created_at           TEXT DEFAULT (datetime('now')),
    resolved_at          TEXT
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_returns_seller_pending ON return_requests(seller_id, status) WHERE status = \'pending\'') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_returns_buyer ON return_requests(buyer_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_returns_order ON return_requests(order_id)') } catch {}
  // 直付(direct_p2p)送达后退货·场外退款握手(src/direct-pay-returns.ts)。ALTER 必须在 CREATE 之后(fresh DB silent-fail 铁律)。
  try { db.exec('ALTER TABLE return_requests ADD COLUMN refund_reference TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE return_requests ADD COLUMN await_refund_since TEXT') } catch { /* 已存在 */ }
}

// ─── W2 售后协商时间线（flagged/flag_reasons ALTER 刻意留 server.ts 原位）──
export function initReturnMessagesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS return_messages (
    id          TEXT PRIMARY KEY,            -- rmsg_xxx
    return_id   TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_role TEXT NOT NULL,               -- 'buyer' | 'seller' | 'system'
    body        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rmsg_return ON return_messages(return_id, created_at)') } catch {}
}

// ─── Wave B-1: 商品 variants（has_variants/options_key ALTER + 回填 + uniq 索引刻意留 server.ts 原位）──
export function initProductVariantsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_variants (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL,
    sku             TEXT,                 -- 卖家内部 SKU 编号（可选）
    options_json    TEXT NOT NULL,        -- {"颜色":"红","尺寸":"L"} 必填
    price_override  REAL,                 -- null = 用 product.price
    stock           INTEGER DEFAULT 0,
    images_json     TEXT,                 -- variant 专属图（可选，null = 用 product.images）
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pv_product ON product_variants(product_id, is_active)') } catch {}
}

// ─── B-4: 编辑精选 / 每周推荐 ──────────────────────────────────────
export function initEditorPicksSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS editor_picks (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,     -- 'product' | 'seller'
    target_id   TEXT NOT NULL,
    title       TEXT,              -- 编辑推荐语
    note        TEXT,
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    sort_order  INTEGER DEFAULT 0,
    created_by  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_ep_active ON editor_picks(kind, ends_at, sort_order)') } catch {}
}

// ─── D-3: KYC light — 实名认证（轻度，不存原始证件号）──────────────
export function initKycRecordsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS kyc_records (
    user_id        TEXT PRIMARY KEY,
    real_name      TEXT NOT NULL,
    id_type        TEXT NOT NULL,            -- 'passport' | 'national_id' | 'driver_license'
    id_number_hash TEXT NOT NULL,            -- sha256(id_number + MASTER_SEED)
    id_number_last4 TEXT,                    -- 末 4 位明文（便于核对）
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
    reject_reason  TEXT,
    reviewed_by    TEXT,
    reviewed_at    TEXT,
    submitted_at   TEXT DEFAULT (datetime('now'))
  )
`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_records(status, submitted_at)') } catch {}
}

// ─── WebAuthn / Passkey — 敏感操作二次确认 ─────────────────────────
// 注：调用方 server.ts 保留原外层 try/catch + [webauthn schema] label，并在本
// init 调用之后、同一 try 内保留 users.webauthn_required_for_withdraw ALTER。
// 这些 DDL 原本无逐句 try/catch（靠外层 try 兜底），此处照搬不加。
export function initWebauthnSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              TEXT PRIMARY KEY,         -- credential.id (base64url)
    user_id         TEXT NOT NULL,
    public_key      BLOB NOT NULL,            -- COSE public key
    counter         INTEGER NOT NULL DEFAULT 0,
    transports      TEXT,                     -- JSON array
    device_label    TEXT,                     -- user-friendly label
    created_at      TEXT DEFAULT (datetime('now')),
    last_used_at    TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wac_user ON webauthn_credentials(user_id)`)

  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    challenge    TEXT NOT NULL,
    purpose      TEXT NOT NULL,                -- 'register' | 'withdraw' | 'change-password' | 'reveal-key' | 'region'
    purpose_data TEXT,                          -- JSON：例如 {amount: 1000, to_address: '0x...'}
    created_at   TEXT DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    consumed_at  TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wac_chall_user ON webauthn_challenges(user_id, expires_at)`)

  // gate token：auth/finish 成功后颁发，绑定 user + purpose + 业务参数（防重放）
  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (
    id           TEXT PRIMARY KEY,             -- token
    user_id      TEXT NOT NULL,
    purpose      TEXT NOT NULL,
    purpose_data TEXT,                          -- JSON
    expires_at   TEXT NOT NULL,                 -- now + 60s
    consumed_at  TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wac_gate_user ON webauthn_gate_tokens(user_id, expires_at)`)
}

// ─── M7.3：claim 验证任务系统（base） ──────────────────────────────
// 注：调用方 server.ts 保留原外层 try/catch + [M7.3 schema claim_verification]；
// 本函数只含 claim_verification_tasks/votes + indexes，结算扩展 ALTER
// (majority_vote / was_majority) 刻意留在 server.ts 本函数调用之后。
export function initClaimVerificationBaseSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS claim_verification_tasks (
    id                  TEXT PRIMARY KEY,
    order_id            TEXT NOT NULL,
    buyer_id            TEXT NOT NULL,
    seller_id           TEXT NOT NULL,
    product_id          TEXT NOT NULL,
    claim_target        TEXT NOT NULL,    -- 'price' | 'commission' | 'protection' | 'return' | 'warranty' | 'handling' | 'other'
    claim_text          TEXT NOT NULL,    -- 买家陈述（≤ 500 字）
    evidence_uri        TEXT,             -- 买家证据（URL / hash）
    stake_buyer         REAL NOT NULL,    -- 买家锁定的质押金
    seller_evidence_uri TEXT,             -- 卖家提交的证据
    seller_evidence_at  TEXT,
    deadline_at         TEXT NOT NULL,    -- 默认 48h；卖家提交证据后 +24h
    status              TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'sealed' | 'resolved_pass' | 'resolved_fail' | 'resolved_no_fault' | 'timeout_pass' | 'timeout_fail'
    resolved_at         TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    UNIQUE(order_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvt_status ON claim_verification_tasks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvt_buyer ON claim_verification_tasks(buyer_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvt_seller ON claim_verification_tasks(seller_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvt_deadline ON claim_verification_tasks(deadline_at) WHERE status = 'open'`)

  db.exec(`CREATE TABLE IF NOT EXISTS claim_verification_votes (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    vote         TEXT NOT NULL,   -- 'pass' | 'fail' | 'no_fault'
    evidence_uri TEXT,
    note         TEXT,
    voted_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(task_id, verifier_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvv_task ON claim_verification_votes(task_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvv_verifier ON claim_verification_votes(verifier_id)`)
}

// ─── verifier 禁言 / 永封记录（outlier 累计触发）────────────────────
export function initClaimVerifierSuspensionsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS claim_verifier_suspensions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    type          TEXT NOT NULL,    -- 'suspended' | 'revoked'
    until_at      TEXT,             -- NULL = permanent (revoked)
    reason        TEXT,
    outlier_count INTEGER,
    created_at    TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cvs_user ON claim_verifier_suspensions(user_id, created_at DESC)`)
}

// ─── Sprint 1: 商品声明验证（product 层，与 order claim 平行）────────
export function initProductClaimSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS product_claim_tasks (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL,
    claimant_id     TEXT NOT NULL,
    seller_id       TEXT NOT NULL,
    claim_target    TEXT NOT NULL,    -- 'title' | 'description' | 'condition' | 'return_days' | 'handling_hours' | 'warranty_days' | 'shipping_regions' | 'origin' | 'other'
    claim_text      TEXT NOT NULL,    -- 发起人陈述 6-500 字
    evidence_uri    TEXT,             -- 发起人证据 URL
    stake_claimant  REAL NOT NULL,    -- 发起人锁定质押
    seller_evidence_uri TEXT,         -- 卖家反驳证据
    seller_evidence_at  TEXT,
    deadline_at     TEXT NOT NULL,    -- 默认 72h；卖家提交证据后 +24h
    status          TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'sealed' | 'resolved_upheld' | 'resolved_dismissed' | 'expired'
    ruling          TEXT,             -- 'upheld' | 'dismissed' | 'insufficient'
    majority_vote   TEXT,
    resolved_at     TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pct_status ON product_claim_tasks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pct_product ON product_claim_tasks(product_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pct_claimant ON product_claim_tasks(claimant_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pct_seller ON product_claim_tasks(seller_id)`)

  db.exec(`CREATE TABLE IF NOT EXISTS product_claim_votes (
    id           TEXT PRIMARY KEY,
    claim_id     TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    vote         TEXT NOT NULL,    -- 'upheld' | 'dismissed' | 'insufficient'
    evidence_uri TEXT,
    note         TEXT,
    was_majority INTEGER,
    voted_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(claim_id, verifier_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcv_claim ON product_claim_votes(claim_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcv_verifier ON product_claim_votes(verifier_id)`)
}

// ─── Sprint 2-A: 测评真实性验证（shareables / manifests）────────────
export function initReviewClaimSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS review_claim_tasks (
    id              TEXT PRIMARY KEY,
    review_type     TEXT NOT NULL,    -- 'shareable' | 'manifest'
    review_id       TEXT NOT NULL,    -- shareable.id 或 manifest.hash
    product_id      TEXT,             -- 关联商品（用于显示）
    reviewer_id     TEXT NOT NULL,    -- 被诉评测作者
    claimant_id     TEXT NOT NULL,
    claim_target    TEXT NOT NULL,    -- 'not_real_purchase' | 'paid_promo' | 'incentivized' | 'misleading' | 'fake' | 'other'
    claim_text      TEXT NOT NULL,
    evidence_uri    TEXT,
    stake_claimant  REAL NOT NULL,
    deadline_at     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    ruling          TEXT,
    majority_vote   TEXT,
    resolved_at     TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rct_status ON review_claim_tasks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rct_review ON review_claim_tasks(review_type, review_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rct_reviewer ON review_claim_tasks(reviewer_id)`)

  db.exec(`CREATE TABLE IF NOT EXISTS review_claim_votes (
    id           TEXT PRIMARY KEY,
    claim_id     TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    vote         TEXT NOT NULL,    -- 'upheld' | 'dismissed' | 'insufficient'
    evidence_uri TEXT,
    note         TEXT,
    was_majority INTEGER,
    voted_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(claim_id, verifier_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rcv_claim ON review_claim_votes(claim_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rcv_verifier ON review_claim_votes(verifier_id)`)
}

// ─── Sprint 2-B: 二手成色验证（secondhand_items）───────────────────
export function initSecondhandClaimSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS secondhand_claim_tasks (
    id              TEXT PRIMARY KEY,
    sh_item_id      TEXT NOT NULL,
    seller_id       TEXT NOT NULL,    -- 二手卖家
    claimant_id     TEXT NOT NULL,
    claim_target    TEXT NOT NULL,    -- 'condition' | 'images' | 'description' | 'title' | 'price' | 'other'
    claim_text      TEXT NOT NULL,
    evidence_uri    TEXT,
    stake_claimant  REAL NOT NULL,
    deadline_at     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    ruling          TEXT,
    majority_vote   TEXT,
    resolved_at     TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sct_status ON secondhand_claim_tasks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sct_item ON secondhand_claim_tasks(sh_item_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sct_seller ON secondhand_claim_tasks(seller_id)`)

  db.exec(`CREATE TABLE IF NOT EXISTS secondhand_claim_votes (
    id           TEXT PRIMARY KEY,
    claim_id     TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    vote         TEXT NOT NULL,
    evidence_uri TEXT,
    note         TEXT,
    was_majority INTEGER,
    voted_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(claim_id, verifier_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scv_claim ON secondhand_claim_votes(claim_id)`)
}

// ─── Sprint 3-A: 拍卖声明（auctions）───────────────────────────────
export function initAuctionClaimSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_claim_tasks (
    id              TEXT PRIMARY KEY,
    auction_id      TEXT NOT NULL,
    seller_id       TEXT NOT NULL,
    claimant_id     TEXT NOT NULL,
    claim_target    TEXT NOT NULL,    -- 'unreasonable_reserve' | 'shill_bidding' | 'collusion' | 'fake_listing' | 'other'
    claim_text      TEXT NOT NULL,
    evidence_uri    TEXT,
    stake_claimant  REAL NOT NULL,
    deadline_at     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    ruling          TEXT,
    majority_vote   TEXT,
    resolved_at     TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_act_status ON auction_claim_tasks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_act_auction ON auction_claim_tasks(auction_id)`)

  db.exec(`CREATE TABLE IF NOT EXISTS auction_claim_votes (
    id           TEXT PRIMARY KEY,
    claim_id     TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    vote         TEXT NOT NULL,
    evidence_uri TEXT,
    note         TEXT,
    was_majority INTEGER,
    voted_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(claim_id, verifier_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_acv_claim ON auction_claim_votes(claim_id)`)
}

// ─── Sprint 3-B: 慈善许愿声明（wishes）─────────────────────────────
export function initWishClaimSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS wish_claim_tasks (
    id              TEXT PRIMARY KEY,
    wish_id         TEXT NOT NULL,
    wisher_id       TEXT NOT NULL,
    claimant_id     TEXT NOT NULL,
    claim_target    TEXT NOT NULL,    -- 'fake_identity' | 'fake_story' | 'already_fulfilled' | 'duplicate' | 'inappropriate' | 'other'
    claim_text      TEXT NOT NULL,
    evidence_uri    TEXT,
    stake_claimant  REAL NOT NULL,
    deadline_at     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    ruling          TEXT,
    majority_vote   TEXT,
    resolved_at     TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wct_status ON wish_claim_tasks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wct_wish ON wish_claim_tasks(wish_id)`)

  db.exec(`CREATE TABLE IF NOT EXISTS wish_claim_votes (
    id           TEXT PRIMARY KEY,
    claim_id     TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    vote         TEXT NOT NULL,
    evidence_uri TEXT,
    note         TEXT,
    was_majority INTEGER,
    voted_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(claim_id, verifier_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wcv_claim ON wish_claim_votes(claim_id)`)
}

// ─── 里程碑 3：反操纵层 schema ──────────────────────────────────────
// 注：调用方 server.ts 保留原外层 try/catch + label（[M3 schema scl/cal/ral]）；
// 这些 DDL 原本无逐句 try/catch（靠外层 try 兜底），此处照搬不加。
// shareables 的 unique_click_count / flag_new_account ALTER 刻意留在 server.ts
// 原位（scl init 之后、cal init 之前）。
export function initShareableClickLogSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shareable_click_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shareable_id TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    ref_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scl_share_ts ON shareable_click_log(shareable_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scl_share_ipua ON shareable_click_log(shareable_id, ip_hash, ua_hash, created_at)`)
}

export function initCommissionAuditLogSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS commission_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    buyer_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    flag TEXT NOT NULL,                  -- 'sponsor_chain_cross' / 'self_in_chain'
    detail TEXT,                          -- JSON: { relation: 'buyer_ancestor_of_seller' | ..., path: '...' }
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_buyer ON commission_audit_log(buyer_id, created_at)`)
}

export function initRegistrationAuditLogSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS registration_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    sponsor_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ral_ip_ts ON registration_audit_log(ip_hash, created_at)`)
}

// ─── 外部链接验证 schema ────────────────────────────────────────────
// 注：product_external_links 的 revoked/platform/external_id/external_title ALTER、
// idx_pel_platform_ext / idx_pel_ext_title 索引、以及回填 IIFE 刻意留 server.ts 原位。
// 这些 DDL 原本是 top-level db.exec 无外层 catch，helper 不新增 catch。
export function initProductExternalLinksBaseSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS product_external_links (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    source      TEXT DEFAULT 'manual',
    verified    INTEGER DEFAULT 0,
    verify_note TEXT,
    added_at    TEXT DEFAULT (datetime('now')),
    verified_at TEXT,
    UNIQUE(product_id, url)
  )
`)
}

export function initLinkChallengesSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS link_challenges (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    code        TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    verified_at TEXT
  )
`)
}

export function initVerifyTasksSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verify_tasks (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL DEFAULT 'code_check',
    product_id          TEXT NOT NULL,
    url                 TEXT NOT NULL,
    code                TEXT,
    verifiers_needed    INTEGER NOT NULL DEFAULT 3,
    reward_per_verifier REAL NOT NULL DEFAULT 0.1,
    fee_locked          REAL NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'open',
    result              TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    settled_at          TEXT
  )
`)
}

export function initVerifySubmissionsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verify_submissions (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    submission   TEXT,
    verdict      TEXT,
    claimed_at   TEXT DEFAULT (datetime('now')),
    submitted_at TEXT,
    UNIQUE(task_id, verifier_id)
  )
`)
}

export function initVerifierStatsSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS verifier_stats (
    user_id       TEXT PRIMARY KEY,
    verify_rights INTEGER NOT NULL DEFAULT 3,
    tasks_done    INTEGER NOT NULL DEFAULT 0,
    tasks_correct INTEGER NOT NULL DEFAULT 0,
    tasks_wrong   INTEGER NOT NULL DEFAULT 0,
    suspended_until TEXT
  )
`)
}

/**
 * Non-money columns the MCP sandbox register → list_product → search path needs
 * that previously lived ONLY as inline `ALTER TABLE` statements in
 * src/pwa/server.ts boot (so an MCP-initialized fresh DB never got them, and a
 * sandbox `webaz_register` / `webaz_list_product` failed with "no such column").
 *
 * Single source shared by the PWA boot path (called from the same boot position
 * the inline `handle` pre-warm ran, before the anchor migration) and the MCP
 * runtime schema composition root. All guarded + idempotent; the `users` /
 * `products` CREATE TABLEs are in L0 initDatabase(), so call this AFTER it
 * (CREATE-before-ALTER preserved).
 *
 * SCOPE GUARD: exactly the 14 non-money identity/locale/product-attribute
 * columns the register/list/search regression requires — NO wallet / order /
 * status / escrow / commission / fund / tokenomics columns. DDL text is
 * byte-identical to the former inline statements, so schema:verify is zero-diff.
 */
export function initRegisterListSearchColumns(db: Database.Database): void {
  for (const stmt of [
    // users — 4-layer identity model short code + handle + sales/commission region
    'ALTER TABLE users ADD COLUMN permanent_code TEXT',
    'ALTER TABLE users ADD COLUMN handle TEXT',
    "ALTER TABLE users ADD COLUMN region       TEXT DEFAULT 'global'",
    // products — structured listing attributes (specs / sourcing ref / shipping / returns / warranty)
    'ALTER TABLE products ADD COLUMN specs TEXT',
    'ALTER TABLE products ADD COLUMN brand TEXT',
    'ALTER TABLE products ADD COLUMN model TEXT',
    'ALTER TABLE products ADD COLUMN source_price REAL',
    'ALTER TABLE products ADD COLUMN ship_regions TEXT DEFAULT "全国"',
    'ALTER TABLE products ADD COLUMN handling_hours INTEGER DEFAULT 24',
    'ALTER TABLE products ADD COLUMN estimated_days TEXT',
    'ALTER TABLE products ADD COLUMN fragile INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN return_days INTEGER DEFAULT 7',
    'ALTER TABLE products ADD COLUMN return_condition TEXT',
    'ALTER TABLE products ADD COLUMN warranty_days INTEGER DEFAULT 0',
  ]) { try { db.exec(stmt) } catch { /* column already exists */ } }
  // unique short-code / handle indexes (partial — only non-NULL)
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_permanent_code ON users(permanent_code) WHERE permanent_code IS NOT NULL") } catch { /* exists */ }
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle) WHERE handle IS NOT NULL") } catch { /* exists */ }
}

/**
 * RFC-020 PR-B — agent delegation grants (Passkey-approved, scoped, short-lived,
 * revocable agent credentials; NOT a permanent api_key). A NEW table — deliberately
 * separate from `agent_attestations` (RFC-020 decision: do not overload it). Pure
 * idempotent DDL; the composition root (applyWebazRuntimeSchema) auto-runs this so
 * MCP also has the table for the future `webaz_pair` consumer.
 *
 * Bearer-first: `token_hash` stores a SHA-256 of the bearer (raw bearer is shown
 * once, never stored). `agent_pubkey` / `pkce_challenge` are RESERVED for the PoP /
 * device-flow phase (required before any risk scope or longer-lived delegation) —
 * unused/NULL in PR-B. `human_confirm_required` is a design field only; its
 * enforcement reuses the existing `webauthn_gate_tokens` / requireHumanPresence
 * gate (no second confirmation mechanism). NO money/order/status columns.
 */
export function initAgentDelegationGrantsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_delegation_grants (
      grant_id        TEXT PRIMARY KEY,                 -- grt_xxx
      human_id        TEXT NOT NULL,                    -- delegating human (users.id)
      agent_label     TEXT,                             -- human-friendly agent name
      capabilities    TEXT NOT NULL DEFAULT '[]',       -- JSON [{capability, constraints}] — SAFE scopes only in PR-B
      token_hash      TEXT,                             -- SHA-256 of bearer (bearer-first); raw never stored
      agent_pubkey    TEXT,                             -- RESERVED (PoP, RFC-020 §3.3); NULL in PR-B
      pkce_challenge  TEXT,                             -- RESERVED (device-flow pairing); NULL in PR-B
      human_confirm_required INTEGER NOT NULL DEFAULT 0,-- design field; enforcement reuses webauthn_gate_tokens
      status          TEXT NOT NULL DEFAULT 'active',   -- active | revoked | expired
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT NOT NULL,                    -- short-lived (clamped, RFC-020 bearer-first)
      revoked_at      TEXT,
      revoked_reason  TEXT,
      permission_bundle TEXT                            -- named bundle key if issued/expanded via a bundle (e.g. 'catalog_agent'); NULL = ad-hoc scopes
    )
  `)
  try { db.exec(`ALTER TABLE agent_delegation_grants ADD COLUMN permission_bundle TEXT`) } catch { /* existing DB: column already added */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adg_human  ON agent_delegation_grants(human_id, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adg_token  ON agent_delegation_grants(token_hash)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adg_expiry ON agent_delegation_grants(status, expires_at)`)
}

/**
 * RFC-020 — Agent Permission Requests (JIT + bundle authorization). An already-connected agent (holds a
 * grant) that hits a missing scope, or wants a job bundle, lodges a REQUEST here; the human sees it in
 * #agent-approvals and approves/rejects. Approval expands the agent's existing grant (safe scopes only,
 * duration-capped). Bound to (human_id, grant_id). NO money/order/status columns; a request grants nothing
 * until a human approves it.
 */
export function initAgentPermissionRequestsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_permission_requests (
      id               TEXT PRIMARY KEY,                 -- apr_xxx
      human_id         TEXT NOT NULL,                    -- resolved from the requesting agent's grant
      grant_id         TEXT NOT NULL,                    -- the agent's existing grant that approval expands
      agent_label      TEXT,
      requested_scopes TEXT NOT NULL DEFAULT '[]',       -- JSON string[] — resolved (bundle expanded) safe scopes
      permission_bundle TEXT,                            -- bundle key if requested as a bundle; NULL = ad-hoc
      reason           TEXT,                             -- agent free-text (display only, unverified)
      task_context     TEXT,                             -- agent free-text about the task (display only)
      risk_level       TEXT NOT NULL DEFAULT 'low',      -- low | medium | high (derived, not agent-supplied)
      duration         TEXT NOT NULL DEFAULT '7d',       -- once | 1h | 24h | 7d | 30d (capped by risk tier)
      status           TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired | revoked
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at       TEXT NOT NULL,                    -- request TTL (auto-expire if unanswered)
      approved_at      TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_apr_human  ON agent_permission_requests(human_id, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_apr_status ON agent_permission_requests(status, expires_at)`)
  // RFC-021 PR2:order-action 请求复用本队列(I9)。新列均可空;kind 默认 'scope_grant' → 旧行行为不变,零迁移。
  //   executed_at / execution_result 本 PR 只建列【永不写】(PR3 才写);ALTER-AFTER-CREATE 幂等。
  for (const stmt of [
    "ALTER TABLE agent_permission_requests ADD COLUMN kind TEXT DEFAULT 'scope_grant'",   // scope_grant | order_action
    "ALTER TABLE agent_permission_requests ADD COLUMN order_id TEXT",
    "ALTER TABLE agent_permission_requests ADD COLUMN order_action TEXT",                  // accept | ship(v1)
    "ALTER TABLE agent_permission_requests ADD COLUMN params_hash TEXT",                   // I2 绑定键 SHA-256(order_id,action,params)
    "ALTER TABLE agent_permission_requests ADD COLUMN action_params TEXT",                 // JSON:ship 的 {tracking,evidence_ref};accept '{}'
    "ALTER TABLE agent_permission_requests ADD COLUMN executed_at TEXT",                   // I5 幂等 CAS 键 —— PR3 写,PR2 恒 NULL
    "ALTER TABLE agent_permission_requests ADD COLUMN execution_result TEXT",              // I7 执行结果 —— PR3 写
    "ALTER TABLE agent_permission_requests ADD COLUMN intent_hash TEXT",                   // RFC-026 PR-1 购买意图指纹(经济快照,不含 draft_id —— 等价意图跨 draft 去重)
    "ALTER TABLE orders ADD COLUMN draft_id TEXT",                                         // RFC-026 PR-1 订单↔草稿稳定关联(一 draft 至多一单的 DB 级兜底)
  ]) { try { db.exec(stmt) } catch { /* 列已存在 */ } }
  // 防双 pending + I5 幂等根基:同一 (order_id, order_action) 至多一条未终结(pending/approved)的 order_action 请求。
  //   rejected/expired/executed 为终态,不占索引 → 允许事后重新提交。
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_apr_order_action_active ON agent_permission_requests(order_id, order_action) WHERE kind='order_action' AND status IN ('pending','approved')") } catch { /* */ }
  // RFC-025 PR-5a:同一草稿同一时间只允许一个活跃提交请求(pending/approved;executed 后可再提交的场景不存在 —— draft 已 ordered)
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_apr_order_submit_active ON agent_permission_requests(order_id) WHERE kind='order_submit' AND status IN ('pending','approved')") } catch { /* */ }
  // RFC-026 PR-1(生产双订单事故收口):同一人同一【购买意图】(经济快照指纹,不含 draft_id)至多一条
  //   活跃(未终结未执行)提交请求 —— 重新报价换 draft 也绕不过;执行完成(executed_at)后指纹释放=合法再购。
  //   legacy 行 intent_hash IS NULL 不入索引(24h 自然过期,不做回填 —— 迁移零风险,回滚=drop index)。
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_apr_intent_active ON agent_permission_requests(human_id, intent_hash) WHERE kind='order_submit' AND status IN ('pending','approved') AND executed_at IS NULL AND intent_hash IS NOT NULL") } catch { /* */ }
  // RFC-026 PR-4:agent 聊天幂等预留(grant 命名空间 + body 哈希绑定;UNIQUE = 并发同键恰一发)
  db.exec(`CREATE TABLE IF NOT EXISTS agent_chat_idem (
    grant_id    TEXT NOT NULL,
    idem_key    TEXT NOT NULL,
    body_sha    TEXT NOT NULL,
    owner       TEXT NOT NULL,               -- 本次尝试的租约 token:回收/落账全部 owner-scoped CAS,并发回收恰一胜者
    message_id  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (grant_id, idem_key)
  )`)
  // RFC-026 PR-5:地址变更待确认内容(PII 专表 —— 全文只进这里,绝不入 action_params/审计/agent 面;
  //   人在 PWA 审批卡看全文,Passkey 批准才写 users;拒绝即清 PII)
  db.exec(`CREATE TABLE IF NOT EXISTS address_change_requests (
    request_id   TEXT PRIMARY KEY,
    human_id     TEXT NOT NULL,
    address_text TEXT NOT NULL,
    region       TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  )`)
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_apr_address_change_active ON agent_permission_requests(human_id) WHERE kind='address_change' AND status IN ('pending','approved') AND executed_at IS NULL") } catch { /* */ }
  // RFC-026 PR-1:一张草稿至多产出一笔订单(状态机 CAS 之外的 DB 级不可绕过兜底);历史订单幂等回填自 order_drafts 回链。
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_draft ON orders(draft_id) WHERE draft_id IS NOT NULL") } catch { /* */ }
  const hasTable = (t: string): boolean => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)
  if (hasTable('orders') && hasTable('order_drafts')) {
    try { db.exec("UPDATE orders SET draft_id = (SELECT od.id FROM order_drafts od WHERE od.order_id = orders.id) WHERE draft_id IS NULL AND EXISTS (SELECT 1 FROM order_drafts od2 WHERE od2.order_id = orders.id)") } catch (e) { console.error('[rfc026] orders.draft_id backfill failed (non-fatal, retried next boot):', (e as Error).message) }
  }
  // fail-closed(Codex MEDIUM):P0 保护如果没建成,宁可 boot 失败也不能带病运行 —— try/catch 只为幂等吞
  //   "already exists",这里显式验证唯一索引真实存在;缺失说明上面的静默失败是真故障。
  //   只对【存在对应表】的库强制:部分 fixture(如 contribution 套件)不建 orders 表,P0 保护对它们无意义。
  const requiredIx = [['ux_apr_intent_active', 'agent_permission_requests'], ['ux_orders_draft', 'orders']] as const
  for (const [ix, tbl] of requiredIx) {
    if (!hasTable(tbl)) continue
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(ix)
    if (!row) throw new Error(`[rfc026] P0 unique index missing after migration: ${ix} — refusing to boot without duplicate-order protection`)
  }
}

/**
 * RFC-020 PR-C1 — agent pairing sessions (OAuth device-flow + PKCE shape).
 *
 * One short-lived, one-time pairing per attempt: the agent starts a pairing (sends a
 * PKCE code_challenge), a logged-in human approves it (server-generated consent), and
 * the agent retrieves the credential ONCE using its PKCE verifier. NO raw bearer is
 * ever stored here — the bearer is generated at retrieval and only its SHA-256 hash is
 * persisted on the grant (agent_delegation_grants). `agent_pubkey` is reserved for the
 * PoP phase (stored if sent, NOT verified in C1). Pure idempotent DDL; the composition
 * root auto-runs it so MCP also has the table. NO money/order/status columns.
 */
export function initAgentPairingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_pairing_sessions (
      pairing_id      TEXT PRIMARY KEY,                 -- par_xxx (agent holds this)
      user_code       TEXT NOT NULL,                    -- short one-time code the human approves
      code_challenge  TEXT NOT NULL,                    -- PKCE S256 = base64url(sha256(verifier))
      agent_label     TEXT,
      agent_pubkey    TEXT,                             -- RESERVED (PoP); stored if sent, NOT verified in C1
      reason          TEXT,                             -- agent free-text reason (shown in consent)
      capabilities    TEXT NOT NULL DEFAULT '[]',       -- requested SAFE scopes (validated safe-only at start)
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | consumed | expired | revoked | rejected(human declined)
      human_id        TEXT,                             -- set on approve
      grant_id        TEXT,                             -- set on approve (issued grant; token_hash filled at retrieve)
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT NOT NULL,                    -- short TTL
      approved_at     TEXT,
      consumed_at     TEXT                              -- one-time retrieval marker
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_aps_user_code ON agent_pairing_sessions(user_code)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aps_status ON agent_pairing_sessions(status, expires_at)`)
  // RFC-020 duration-choice: the agent's SUGGESTED grant lifetime (once/1h/24h/7d/30d) shown in consent so the
  //   human can accept or override it at approve. Safe-scope only; the human's choice wins. ALTER after CREATE.
  try { db.exec("ALTER TABLE agent_pairing_sessions ADD COLUMN grant_duration TEXT") } catch { /* 已有 */ }
}

/**
 * RFC-020 PR-C2a — per-request audit of delegation-grant authorizations (RFC-020 §3.7).
 *
 * Records each grant-scoped access attempt (allow/deny + reason) so "every agent action
 * is backed by an accountable human" is checkable. Append-only log; pure idempotent DDL;
 * composition root auto-runs it for MCP. NO money/order/status columns.
 */
/**
 * demand_signals — RFC-025 PR-2 需求信号(「有结果输出结果,没结果记录,形成商机」)。
 * append-only:webaz_discover 的每次结构化查询落一行(result_count 含 0 —— 0 = 未被满足的需求 =
 * 市场机会情报)。只存 allowlist 化的结构化 intent(intent_json,绝无自由聊天文本);内部/admin 只读,
 * 公开聚合是未来独立 gated PR(聚合阈值≥N,永不暴露单买家)。retention:D-3(180 天原始,后聚合)。
 * budget_units = RFC-014 整数 base-units(新表零浮点债)。
 */
/**
 * order_quotes — RFC-025 PR-3 买家报价快照(server 权威;quote_token 的服务端真相)。
 * 零经济执行:不建单/不扣款/不锁资金/不动库存。token 明文只出现在响应里一次,DB 只存 sha256
 * (token_hash)—— 不可由客户端篡改,可由服务端校验(verifyQuoteToken:subject/过期/已消费)。
 * 本表行是报价快照的唯一真相;【PR-4 的 draft 消费器】负责按快照校验商品/数量/地址/轨道/金额一致性
 * 并用 consumed_at 做一次性 —— 本 PR 只提供校验基础,不含消费器。金额全部 INTEGER base-units(RFC-014,
 * 新表零浮点债);currency 恒 'WAZ'(协议结算币,direct_p2p 的实付币种只是账户摘要,无权威汇率)。
 * idempotency:UNIQUE(human_id, idempotency_key) + intent_hash —— 同主体同键同载荷返回同一报价,
 * 同键不同载荷 = IDEMPOTENCY_CONFLICT。address_summary_hash = sha256(默认地址全文):绑定地址内容
 * 而不存内容(PII 永不入本表)。
 */
export function initOrderQuotesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_quotes (
      id               TEXT PRIMARY KEY,              -- qte_xxx(公开报价 id)
      token_hash       TEXT NOT NULL UNIQUE,          -- sha256(quote_token 明文);明文绝不落库
      human_id         TEXT NOT NULL,                 -- OAuth subject(报价只对本人有效)
      product_id       TEXT NOT NULL,
      variant_id       TEXT,
      seller_id        TEXT NOT NULL,
      quantity         INTEGER NOT NULL,              -- validated_quantity(G-QTY-1 规范化数量)
      unit_price_units INTEGER NOT NULL,              -- 报价时单价快照(变体覆盖后)
      item_units       INTEGER NOT NULL,
      shipping_units   INTEGER NOT NULL,
      donation_bps     INTEGER NOT NULL DEFAULT 0,
      donation_units   INTEGER NOT NULL DEFAULT 0,
      total_units      INTEGER NOT NULL,              -- = item + shipping(与 orders.total_amount 同口径)
      payable_units    INTEGER NOT NULL,              -- = total + donation(买家实际扣款口径,escrow)
      currency         TEXT NOT NULL DEFAULT 'WAZ',
      payment_rail     TEXT NOT NULL,                 -- escrow | direct_p2p
      direct_receive_account_id TEXT,
      dest_region      TEXT,                          -- 默认地址 region 标签(非 PII)
      address_summary_hash TEXT,                      -- sha256(默认地址全文)——绑定内容,不存内容
      anonymous_recipient INTEGER NOT NULL DEFAULT 0,
      intent_hash      TEXT NOT NULL,                 -- sha256(canonical 输入)——幂等载荷指纹
      idempotency_key  TEXT,
      issued_at        TEXT NOT NULL,
      expires_at       TEXT NOT NULL,
      consumed_at      TEXT,                          -- PR-4 draft 消费时置位(一次性)
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oq_idem ON order_quotes(human_id, idempotency_key) WHERE idempotency_key IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oq_expires ON order_quotes(expires_at)`)
}

/**
 * order_drafts — RFC-025 PR-4 订单草稿(激活 RFC-020 以来"授权即死"的 draft_order capability:首个消费者)。
 * 语义:由【未过期、未消费】的 quote 一次性转化(order_quotes.consumed_at CAS,同事务)——
 * 草稿 = 冻结的报价快照 + 生命周期(draft|cancelled|expired;submitted 由 PR-5a 置位)。
 * 零经济执行:不建真实订单行、不扣款、不锁资金、不动库存;价格/库存/资格在 PR-5a 人工 Passkey
 * 批准时以快照为基准全部重校验(drift = 硬失败 + 重新报价,绝不静默换条件)。
 * 一 quote 一 draft 由 UNIQUE(quote_id) 在 schema 级持久保证;【不可变性是服务层保证】(无 update 端点,
 * 仅 cancel 终态)—— 直接改库的写者不受此表约束,勿据此做安全推理。快照列复制 quote 行整数金额(零重算)。
 * PII:与 order_quotes 同纪律 —— 地址只有 region 标签 + sha256,全文永不入本表。
 */
export function initOrderDraftsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_drafts (
      id               TEXT PRIMARY KEY,              -- odr_xxx
      buyer_id         TEXT NOT NULL,                 -- = quote.human_id(消费时校验一致)
      quote_id         TEXT NOT NULL,                 -- 消费的报价(order_quotes.id;一次性)
      product_id       TEXT NOT NULL,
      variant_id       TEXT,
      seller_id        TEXT NOT NULL,
      quantity         INTEGER NOT NULL,
      unit_price_units INTEGER NOT NULL,
      item_units       INTEGER NOT NULL,
      shipping_units   INTEGER NOT NULL,
      donation_bps     INTEGER NOT NULL DEFAULT 0,
      donation_units   INTEGER NOT NULL DEFAULT 0,
      total_units      INTEGER NOT NULL,
      payable_units    INTEGER NOT NULL,
      currency         TEXT NOT NULL DEFAULT 'WAZ',
      payment_rail     TEXT NOT NULL,
      direct_receive_account_id TEXT,
      dest_region      TEXT,
      address_summary_hash TEXT,
      anonymous_recipient INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'draft', -- draft | cancelled | expired(submitted 由 PR-5a 引入)
      idempotency_key  TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at       TEXT NOT NULL,                 -- 24h;过期草稿不可提交(PR-5a 拒)
      cancelled_at     TEXT
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_od_quote ON order_drafts(quote_id)`)   // 一 quote 一 draft:schema 级持久保证(不止服务层 CAS)
  try { db.exec('ALTER TABLE order_drafts ADD COLUMN order_id TEXT') } catch { /* exists */ }   // PR-5a:批准执行后回链真实订单(status=ordered);ALTER AFTER CREATE 铁律
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_od_idem ON order_drafts(buyer_id, idempotency_key) WHERE idempotency_key IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_od_buyer ON order_drafts(buyer_id, created_at)`)
}

export function initDemandSignalsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS demand_signals (
      id            TEXT PRIMARY KEY,                 -- dms_xxx
      human_id      TEXT,                             -- grant subject(可空,便于未来匿名聚合导出)
      source        TEXT NOT NULL,                    -- 'mcp_discover'
      intent_json   TEXT NOT NULL,                    -- allowlist 化结构化 intent(无自由聊天文本)
      category      TEXT,
      region        TEXT,                             -- 2 字母国家码(可空)
      budget_units  INTEGER,                          -- RFC-014 integer base-units(可空)
      result_count  INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dms_created ON demand_signals(created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dms_cat ON demand_signals(category, created_at)`)
}

export function initAgentGrantAuthLogSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_grant_auth_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id    TEXT,                              -- null when token missing / grant not found
      human_id    TEXT,                              -- the accountable human (when resolved)
      capability  TEXT NOT NULL,                     -- the required safe scope checked
      outcome     TEXT NOT NULL,                     -- 'allow' | 'deny'
      error_code  TEXT,                              -- typed denial reason (null on allow)
      ts          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agal_grant ON agent_grant_auth_log(grant_id, ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agal_ts ON agent_grant_auth_log(ts)`)
}

/**
 * pending_commission_escrow — opt-out promoter activation queue (§3.5b) + RFC-018 clearing ledger.
 *
 * Relocated VERBATIM from src/pwa/server.ts (RFC-018 PR1) so the table's whole schema is built once,
 * in the early helper batch — never half-here / half-inline (the fresh-DB silent-fail铁律 bites a
 * half-migration the hardest). RFC-018 adds two things, SCHEMA-ONLY (no settle / escrow read-write
 * logic touched):
 *   - `matures_at` column — the accrue-then-mature clock (= completed_at + return_days +
 *     settlement.clearing_buffer_days); NULL until the PR2 clearing model writes it.
 *   - `reversed` status value — a return inside the clearing window flips pending→reversed; it is a
 *     TEXT value, so it needs no schema change (documented in the column comment).
 * order_id stays NULLable for pv_pair rows (PR-1c-b).
 *
 * Migration, two independent cases (both idempotent, both skip when already current):
 *   (a) order_id NOT NULL (pre-1c-b) → full rebuild — SQLite ADD COLUMN cannot relax a NOT NULL
 *       constraint. Explicit-column INSERT maps the old rows; FK OFF/ON restores L0's global ON. The
 *       rebuilt table already carries matures_at, so (b) then no-ops.
 *   (b) missing matures_at (pre-RFC-018) → a cheap, NON-destructive `ALTER TABLE ADD COLUMN`. No
 *       DROP, rows + indexes preserved. This is the common existing-DB path (every pre-RFC-018 DB,
 *       incl. prod). We deliberately do NOT rebuild for an additive column — a money-path table on a
 *       persistent prod volume should take the smallest safe migration. (Allowed here because the
 *       complexity ratchet counts DDL in server.ts only, not this helper.)
 */
export function initPendingCommissionEscrowSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_commission_escrow (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id        TEXT NOT NULL,
      order_id                 TEXT,                                 -- NULL for pv_pair (PR-1c-b)
      amount                   REAL NOT NULL,    -- WAZ amount
      attribution_path         TEXT NOT NULL,    -- 'L1' | 'L2' | 'L3' | 'pv_pair' | etc.
      status                   TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'settled' | 'expired' | 'reversed' (RFC-018)
      created_at               INTEGER NOT NULL,
      expires_at               INTEGER NOT NULL,
      settled_at               INTEGER,
      expired_to_charity_at    INTEGER,
      matures_at               INTEGER,          -- RFC-018: completed_at + return_days + clearing_buffer_days; NULL until the clearing model writes it
      FOREIGN KEY (recipient_user_id) REFERENCES users(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `)

  ;(function migrateEscrowSchema() {
    const cols = db.prepare("PRAGMA table_info(pending_commission_escrow)").all() as Array<{ name: string; notnull: number }>
    if (cols.length === 0) return  // table absent (shouldn't happen — CREATE above just ran)
    const orderIdCol = cols.find(c => c.name === 'order_id')
    const orderIdNotNull = !!orderIdCol && orderIdCol.notnull === 1

    // (a) STRUCTURAL (pre-1c-b): order_id NOT NULL → nullable. Unavoidable full rebuild (ADD COLUMN
    // cannot relax NOT NULL). The rebuilt table already includes matures_at, so (b) below no-ops.
    if (orderIdNotNull) {
      console.log('[pc-escrow-migrate] order_id NOT NULL — rebuilding table to allow NULL for pv_pair')
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
            matures_at               INTEGER,
            FOREIGN KEY (recipient_user_id) REFERENCES users(id),
            FOREIGN KEY (order_id) REFERENCES orders(id)
          )
        `)
        // explicit columns: an older DB lacks matures_at → it defaults to NULL in _new (never SELECT *)
        db.exec(`INSERT INTO pending_commission_escrow_new
          (id, recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at, settled_at, expired_to_charity_at)
          SELECT id, recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at, settled_at, expired_to_charity_at
          FROM pending_commission_escrow`)
        db.exec('DROP TABLE pending_commission_escrow')
        db.exec('ALTER TABLE pending_commission_escrow_new RENAME TO pending_commission_escrow')
      })()
      db.exec('PRAGMA foreign_keys = ON')
    }

    // (b) ADDITIVE (pre-RFC-018): matures_at missing → cheap, non-destructive column add (no DROP;
    // rows + indexes preserved). Idempotent: throws "duplicate column" once present (fresh DB, or
    // just-rebuilt in (a)) → swallowed. This is the path every existing prod DB takes.
    try { db.exec('ALTER TABLE pending_commission_escrow ADD COLUMN matures_at INTEGER') } catch { /* column already exists */ }
  })()

  try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrow_recipient ON pending_commission_escrow(recipient_user_id, status, expires_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrow_expiry ON pending_commission_escrow(status, expires_at)') } catch {}
  // PR-1c-a: UNIQUE (recipient, order, path) defends against double-insert if settleCommission ever retries
  // Note: NULL order_id (PR-1c-b pv_pair) is distinct in SQLite UNIQUE — idempotency for pv_pair relies
  // on binary_score_records.settled_at instead (source-side dedup).
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_escrow_recipient_order_path ON pending_commission_escrow(recipient_user_id, order_id, attribution_path)') } catch {}
}

// ─── RFC-023 OAuth for Remote MCP (PR-1: schema only; no auth logic yet) ──────────
// Opaque tokens (D1) + no refresh (D2) + allowlist clients (D3) + SAFE scope (D5) + aud-bound (I-3).
// Secrets are stored HASHED, never plaintext. Tokens are credentials FOR an RFC-020 grant (I-5):
// oauth_access_tokens.grant_id references the RFC-020 grant that carries the real capability/revocation.
export function initOAuthSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,           -- JSON array; exact-match validated (T5)
    status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code_hash      TEXT PRIMARY KEY,       -- sha256 of the code; never store plaintext
    client_id      TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    grant_id       TEXT NOT NULL,          -- the RFC-020 grant minted at consent (I-5)
    scope          TEXT NOT NULL,          -- space-delimited SAFE scopes
    code_challenge TEXT NOT NULL,          -- PKCE S256 challenge (I-4)
    redirect_uri   TEXT NOT NULL,          -- exact-match on exchange (T5)
    resource       TEXT NOT NULL,          -- RFC 8707; must == https://webaz.xyz/mcp (I-3)
    expires_at     TEXT NOT NULL,
    consumed_at    TEXT                    -- single-use (CAS on exchange)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_auth_codes(expires_at)`)
  db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token_hash  TEXT PRIMARY KEY,          -- sha256 of the opaque token (D1); never store plaintext
    grant_id    TEXT NOT NULL,             -- RFC-020 grant principal (I-5)
    client_id   TEXT NOT NULL,
    scope       TEXT NOT NULL,             -- SAFE scopes (I-6)
    aud         TEXT NOT NULL,             -- must == https://webaz.xyz/mcp; validated每 /mcp 调用 (I-3)
    expires_at  TEXT NOT NULL,             -- short TTL
    revoked_at  TEXT,                      -- revocation is online (introspection checks this) (D1)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant  ON oauth_access_tokens(grant_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_access_tokens(expires_at)`)

  // RFC-024 Dynamic Client Registration — columns added to oauth_clients (ALTER-after-CREATE, idempotent):
  //   verified: DCR clients are 0 (self-declared/unverified); a curated set may be flipped to 1 (fast-follow).
  //   created_ip_hash: hashed registering IP for abuse-audit (no raw IP stored).
  //   client_metadata: raw RFC 7591 registration fields (audit).
  //   last_authorized_at: set on first successful consent — drives the 30d never-authorized TTL-sweep.
  for (const [col, ddl] of [
    ['verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_ip_hash', 'TEXT'],
    ['client_metadata', 'TEXT'],
    ['last_authorized_at', 'TEXT'],
  ] as const) {
    try { db.exec(`ALTER TABLE oauth_clients ADD COLUMN ${col} ${ddl}`) } catch { /* already present */ }
  }
}
