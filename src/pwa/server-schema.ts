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
