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
