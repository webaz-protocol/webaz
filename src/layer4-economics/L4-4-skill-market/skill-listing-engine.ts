/**
 * L4-4 · 技能市场（知识技能 / Knowledge Skill Marketplace）
 *
 * 与同目录 skill-engine.ts（卖家自动化插件）是两套独立产品：
 *   - skill-engine.ts   = 卖家行为自动化（auto_accept / catalog_sync…），config 驱动、免费、无审计
 *   - 本文件            = 内容型可购买技能（模板/提示词/指南/清单），人人可发、经 WebAZ 审计后上架、他人付费
 *
 * 核心循环：
 *   作者发布(submitted) → WebAZ 人工审计(approved/rejected) → 上架 →
 *   买家购买/按次使用 → 解锁正文 → 作者收入（净额入钱包，协议费入 sys_protocol）
 *
 * 计费模式：
 *   free      免费解锁
 *   one_time  一次性买断，永久解锁
 *   per_use   按次付费，每次读取正文都扣 price
 *
 * 收益隔离（重要）：技能销售收入是独立资金流，
 *   绝不进入 PV 二元匹配 / 推土机三级佣金 / fund_base —— 保持双引擎解耦、规避 PV 合规问题。
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)
import { toUnits, toDecimal } from '../../money.js'
import { applyWalletDelta } from '../../ledger.js'

// ─── 常量 ─────────────────────────────────────────────────────

export type SkillBillingMode = 'free' | 'one_time' | 'per_use'
export type SkillKind = 'template' | 'prompt' | 'guide' | 'checklist'
export type SkillStatus = 'submitted' | 'approved' | 'rejected' | 'delisted'

export const SKILL_KINDS: SkillKind[] = ['template', 'prompt', 'guide', 'checklist']
export const SKILL_BILLING_MODES: SkillBillingMode[] = ['free', 'one_time', 'per_use']

export const SKILL_KIND_META: Record<SkillKind, { label: string; label_en: string; icon: string }> = {
  template:  { label: '模板',   label_en: 'Template',  icon: '📋' },
  prompt:    { label: '提示词', label_en: 'Prompt',    icon: '💬' },
  guide:     { label: '指南',   label_en: 'Guide',     icon: '📖' },
  checklist: { label: '清单',   label_en: 'Checklist', icon: '✅' },
}

const PRICE_CAP = 100000  // 单个技能价格上限（WAZ），防误填
const round2 = (n: number) => Math.round(Number(n) * 100) / 100  // 金额统一 2 位精度，防结算端凑整造钱

// ─── 类型 ─────────────────────────────────────────────────────

export interface SkillListing {
  id: string
  author_id: string
  title: string
  summary: string
  preview: string
  content: string         // 正文：公开接口不返回，仅 readContent 在校验后返回
  category: string
  skill_kind: SkillKind
  billing_mode: SkillBillingMode
  price: number
  status: SkillStatus
  audit_note: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  total_sales: number
  total_revenue: number
  rating: number
  rating_count: number
  active: number
  created_at: string
  updated_at: string
  // JOIN / 计算附加字段
  author_name?: string
  owned?: number          // 当前查看者是否已解锁（one_time/free）
}

// 公开字段（不含 content）
const PUBLIC_COLS = `
  l.id, l.author_id, l.title, l.summary, l.preview, l.category, l.skill_kind,
  l.billing_mode, l.price, l.status, l.total_sales, l.rating, l.rating_count,
  l.active, l.created_at, l.updated_at
`

// ─── Schema ───────────────────────────────────────────────────

export function initSkillMarketSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_listings (
      id            TEXT PRIMARY KEY,
      author_id     TEXT NOT NULL REFERENCES users(id),
      title         TEXT NOT NULL,
      summary       TEXT NOT NULL DEFAULT '',
      preview       TEXT NOT NULL DEFAULT '',
      content       TEXT NOT NULL DEFAULT '',
      category      TEXT NOT NULL DEFAULT 'general',
      skill_kind    TEXT NOT NULL DEFAULT 'template',
      billing_mode  TEXT NOT NULL DEFAULT 'free',
      price         REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'submitted',
      audit_note    TEXT,
      reviewed_by   TEXT,
      reviewed_at   TEXT,
      total_sales   INTEGER NOT NULL DEFAULT 0,
      total_revenue REAL NOT NULL DEFAULT 0,
      rating        REAL NOT NULL DEFAULT 5.0,
      rating_count  INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_orders (
      id           TEXT PRIMARY KEY,
      listing_id   TEXT NOT NULL REFERENCES skill_listings(id),
      buyer_id     TEXT NOT NULL REFERENCES users(id),
      billing_mode TEXT NOT NULL,
      amount_paid  REAL NOT NULL DEFAULT 0,
      protocol_fee REAL NOT NULL DEFAULT 0,
      author_net   REAL NOT NULL DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sklm_status   ON skill_listings(status, active);
    CREATE INDEX IF NOT EXISTS idx_sklm_author   ON skill_listings(author_id);
    CREATE INDEX IF NOT EXISTS idx_sklm_category ON skill_listings(category, status);
    CREATE INDEX IF NOT EXISTS idx_sko_buyer     ON skill_orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_sko_listing   ON skill_orders(listing_id);
  `)
}

// ─── 发布 / 修改 ──────────────────────────────────────────────

export interface PublishListingInput {
  authorId: string
  title: string
  summary?: string
  preview?: string
  content: string
  category?: string
  skillKind?: SkillKind
  billingMode: SkillBillingMode
  price?: number
}

function validateListingInput(input: { title: string; content: string; billingMode: SkillBillingMode; skillKind?: SkillKind; price?: number }): void {
  if (!input.title || !input.title.trim()) throw new Error('请填写技能标题')
  if (!input.content || !input.content.trim()) throw new Error('请填写技能正文内容')
  if (!SKILL_BILLING_MODES.includes(input.billingMode)) throw new Error('计费模式无效')
  if (input.skillKind && !SKILL_KINDS.includes(input.skillKind)) throw new Error('技能类型无效')
  const price = Number(input.price ?? 0)
  if (!Number.isFinite(price) || price < 0 || price > PRICE_CAP) throw new Error(`价格必须 0–${PRICE_CAP} WAZ`)
  if (input.billingMode === 'free' && price !== 0) throw new Error('免费技能价格必须为 0')
  if (input.billingMode !== 'free' && price <= 0) throw new Error('付费技能价格必须大于 0')
}

/** 任何登录用户都可发布；发布即进入审核队列（status=submitted, active=0） */
export function publishListing(db: Database.Database, input: PublishListingInput): SkillListing {
  const author = db.prepare('SELECT id FROM users WHERE id = ?').get(input.authorId)
  if (!author) throw new Error('用户不存在')
  const price = round2(Number(input.price ?? 0))
  validateListingInput({ ...input, price })

  const id = generateId('skm')
  db.prepare(`
    INSERT INTO skill_listings (id, author_id, title, summary, preview, content, category, skill_kind, billing_mode, price, status, active)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'submitted', 0)
  `).run(
    id, input.authorId, input.title.trim(), (input.summary ?? '').trim(), (input.preview ?? '').trim(),
    input.content, (input.category ?? 'general').trim(), input.skillKind ?? 'template',
    input.billingMode, price,
  )
  return getListingRaw(db, id)!
}

export interface UpdateListingPatch {
  title?: string
  summary?: string
  preview?: string
  content?: string
  category?: string
  skillKind?: SkillKind
  billingMode?: SkillBillingMode
  price?: number
}

/**
 * 作者修改自己的技能。已上架(approved)技能修改后需重新审核（status→submitted, active=0），
 * 防止"审通过后偷换正文"。已下架/被拒/待审的可自由修改。
 */
export function updateListing(db: Database.Database, id: string, authorId: string, patch: UpdateListingPatch): SkillListing {
  const cur = getListingRaw(db, id)
  if (!cur) throw new Error('技能不存在')
  if (cur.author_id !== authorId) throw new Error('仅作者本人可修改')

  const next = {
    title: patch.title !== undefined ? patch.title.trim() : cur.title,
    summary: patch.summary !== undefined ? patch.summary.trim() : cur.summary,
    preview: patch.preview !== undefined ? patch.preview.trim() : cur.preview,
    content: patch.content !== undefined ? patch.content : cur.content,
    category: patch.category !== undefined ? patch.category.trim() : cur.category,
    skill_kind: (patch.skillKind ?? cur.skill_kind) as SkillKind,
    billing_mode: (patch.billingMode ?? cur.billing_mode) as SkillBillingMode,
    price: round2(patch.price !== undefined ? Number(patch.price) : cur.price),
  }
  validateListingInput({ title: next.title, content: next.content, billingMode: next.billing_mode, skillKind: next.skill_kind, price: next.price })

  // approved 技能被修改 → 回到审核队列
  const reaudit = cur.status === 'approved'
  db.prepare(`
    UPDATE skill_listings SET
      title=?, summary=?, preview=?, content=?, category=?, skill_kind=?, billing_mode=?, price=?,
      status = CASE WHEN ?=1 THEN 'submitted' ELSE status END,
      active = CASE WHEN ?=1 THEN 0 ELSE active END,
      updated_at = datetime('now')
    WHERE id=?
  `).run(
    next.title, next.summary, next.preview, next.content, next.category, next.skill_kind, next.billing_mode, next.price,
    reaudit ? 1 : 0, reaudit ? 1 : 0, id,
  )
  return getListingRaw(db, id)!
}

/** 作者下架（不删除，可重新提交审核） */
export function delistListing(db: Database.Database, id: string, authorId: string): void {
  const cur = getListingRaw(db, id)
  if (!cur) throw new Error('技能不存在')
  if (cur.author_id !== authorId) throw new Error('仅作者本人可下架')
  db.prepare("UPDATE skill_listings SET status='delisted', active=0, updated_at=datetime('now') WHERE id=?").run(id)
}

/** 作者把被拒/下架的技能重新提交审核 */
export function resubmitListing(db: Database.Database, id: string, authorId: string): void {
  const cur = getListingRaw(db, id)
  if (!cur) throw new Error('技能不存在')
  if (cur.author_id !== authorId) throw new Error('仅作者本人可提交')
  if (cur.status === 'approved') throw new Error('技能已上架，无需重新提交')
  db.prepare("UPDATE skill_listings SET status='submitted', active=0, audit_note=NULL, updated_at=datetime('now') WHERE id=?").run(id)
}

// ─── 查询 ─────────────────────────────────────────────────────

function getListingRaw(db: Database.Database, id: string): SkillListing | null {
  return db.prepare('SELECT * FROM skill_listings WHERE id = ?').get(id) as SkillListing | null
}

export interface ListFilter {
  category?: string
  skillKind?: SkillKind
  billingMode?: SkillBillingMode
  query?: string
  viewerId?: string
  limit?: number
}

/** 公开列表：仅 approved + active 的技能，不含 content */
// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点 skill-market.ts 均 inTx=false)。
//   注:hasUnlock(被同步写 purchaseListing/readContent 复用)留 Phase 3,故 getMarketDetail 的 owned 检查内联为 dbOne。
export async function listMarket(_db: Database.Database, filter: ListFilter = {}): Promise<SkillListing[]> {
  const params: unknown[] = []
  let ownedSelect = ''
  if (filter.viewerId) {
    ownedSelect = `, (SELECT COUNT(*) FROM skill_orders o WHERE o.listing_id = l.id AND o.buyer_id = ?) as owned`
    params.push(filter.viewerId)
  }
  let sql = `SELECT ${PUBLIC_COLS}, u.name as author_name ${ownedSelect}
    FROM skill_listings l JOIN users u ON l.author_id = u.id
    WHERE l.status = 'approved' AND l.active = 1`
  if (filter.category)    { sql += ' AND l.category = ?';     params.push(filter.category) }
  if (filter.skillKind)   { sql += ' AND l.skill_kind = ?';   params.push(filter.skillKind) }
  if (filter.billingMode) { sql += ' AND l.billing_mode = ?'; params.push(filter.billingMode) }
  if (filter.query)       { sql += ' AND (l.title LIKE ? OR l.summary LIKE ?)'; params.push(`%${filter.query}%`, `%${filter.query}%`) }
  sql += ' ORDER BY l.total_sales DESC, l.rating DESC, l.created_at DESC LIMIT ?'
  params.push(filter.limit ?? 30)
  return await dbAll<SkillListing>(sql, params)
}

/** 公开详情（不含 content）；附加 owned 标记。未上架的仅作者本人可见，防 metadata 泄露 */
export async function getMarketDetail(_db: Database.Database, id: string, viewerId?: string): Promise<SkillListing | null> {
  const row = await dbOne<SkillListing>(`
    SELECT ${PUBLIC_COLS}, u.name as author_name
    FROM skill_listings l JOIN users u ON l.author_id = u.id
    WHERE l.id = ?
  `, [id])
  if (!row) return null
  if (row.status !== 'approved' && row.author_id !== viewerId) return null
  if (viewerId) {
    // owned 检查内联(hasUnlock 被同步写路径复用,留 Phase 3;此处直接走 seam,与 hasUnlock 同 SQL)
    const unlocked = await dbOne(`SELECT 1 FROM skill_orders o WHERE o.listing_id = ? AND o.buyer_id = ? AND o.billing_mode IN ('free','one_time') LIMIT 1`, [id, viewerId])
    row.owned = unlocked ? 1 : 0
  }
  return row
}

/** 作者视角：自己的全部技能（含各状态、含 content 由调用方决定是否回传） */
export async function getMyListings(_db: Database.Database, authorId: string): Promise<SkillListing[]> {
  return await dbAll<SkillListing>(`
    SELECT ${PUBLIC_COLS}, l.audit_note, l.reviewed_at, l.total_revenue
    FROM skill_listings l WHERE l.author_id = ? ORDER BY l.created_at DESC
  `, [authorId])
}

// ─── 访问权 / 解锁 ────────────────────────────────────────────

/** one_time/free 是否已永久解锁（per_use 不算永久解锁） */
function hasUnlock(db: Database.Database, userId: string, listingId: string): boolean {
  const r = db.prepare(`
    SELECT 1 FROM skill_orders o
    WHERE o.listing_id = ? AND o.buyer_id = ? AND o.billing_mode IN ('free','one_time') LIMIT 1
  `).get(listingId, userId)
  return !!r
}

// ─── 支付结算（事务内）────────────────────────────────────────

interface SettleResult { fee: number; net: number; amount: number }

/** 扣买家、加作者净额、协议费入 sys_protocol；记 skill_orders。feeRate 由路由层从协议参数传入。 */
function settlePayment(db: Database.Database, listing: SkillListing, buyerId: string, feeRate: number): SettleResult {
  // RFC-014:整数 base-units(买家付 price = 作者净额 net + 协议费 fee,精确守恒)
  const priceU = toUnits(Number(listing.price))
  const feeU = Math.round(priceU * feeRate)
  const netU = priceU - feeU   // 残值,精确
  const price = toDecimal(priceU), fee = toDecimal(feeU), net = toDecimal(netU)

  const tx = db.transaction(() => {
    const w = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(buyerId) as { balance: number } | undefined
    if (!w || toUnits(w.balance) < priceU) throw new Error('余额不足，请先充值')
    applyWalletDelta(db, buyerId, { balance: -priceU })
    applyWalletDelta(db, listing.author_id, { balance: netU, earned: netU })
    db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('sys_protocol', 0)").run()
    if (feeU > 0) applyWalletDelta(db, 'sys_protocol', { balance: feeU })
    db.prepare('UPDATE skill_listings SET total_sales = total_sales + 1, total_revenue = total_revenue + ? WHERE id = ?').run(price, listing.id)
    db.prepare('INSERT INTO skill_orders (id, listing_id, buyer_id, billing_mode, amount_paid, protocol_fee, author_net) VALUES (?,?,?,?,?,?,?)')
      .run(generateId('sko'), listing.id, buyerId, listing.billing_mode, price, fee, net)
  })
  tx()
  return { fee, net, amount: price }
}

export interface PurchaseResult {
  success: boolean
  already_owned?: boolean
  amount_paid?: number
  message: string
}

/**
 * 购买/解锁（用于 free 与 one_time）。per_use 不走此路径——按次扣费在 readContent 内完成。
 * 自己不能买自己的技能。
 */
export function purchaseListing(db: Database.Database, buyerId: string, listingId: string, feeRate: number): PurchaseResult {
  const listing = getListingRaw(db, listingId)
  if (!listing || listing.status !== 'approved' || !listing.active) throw new Error('技能不存在或未上架')
  if (listing.author_id === buyerId) throw new Error('不能购买自己发布的技能')
  if (listing.billing_mode === 'per_use') throw new Error('按次付费技能无需购买，直接使用即可')

  if (hasUnlock(db, buyerId, listingId)) return { success: true, already_owned: true, message: '你已拥有此技能' }

  if (listing.billing_mode === 'free') {
    db.prepare('INSERT INTO skill_orders (id, listing_id, buyer_id, billing_mode, amount_paid, protocol_fee, author_net) VALUES (?,?,?,?,0,0,0)')
      .run(generateId('sko'), listingId, buyerId, 'free')
    db.prepare('UPDATE skill_listings SET total_sales = total_sales + 1 WHERE id = ?').run(listingId)
    return { success: true, amount_paid: 0, message: '已解锁（免费）' }
  }

  // one_time
  const r = settlePayment(db, listing, buyerId, feeRate)
  return { success: true, amount_paid: r.amount, message: '购买成功' }
}

export interface ReadResult {
  content: string
  charged?: number
  billing_mode: SkillBillingMode
}

/**
 * 读取正文（解锁后调用）。
 *   - 作者本人：直接返回。
 *   - free / one_time：必须已解锁（hasUnlock）。
 *   - per_use：每次读取扣费一次，然后返回。
 */
export function readContent(db: Database.Database, userId: string, listingId: string, feeRate: number): ReadResult {
  const listing = getListingRaw(db, listingId)
  if (!listing) throw new Error('技能不存在')

  // 作者本人随时可读
  if (listing.author_id === userId) {
    return { content: listing.content, billing_mode: listing.billing_mode }
  }
  if (listing.status !== 'approved' || !listing.active) throw new Error('技能未上架')

  if (listing.billing_mode === 'per_use') {
    const r = settlePayment(db, listing, userId, feeRate)
    return { content: listing.content, charged: r.amount, billing_mode: 'per_use' }
  }

  if (!hasUnlock(db, userId, listingId)) throw new Error('请先购买/解锁此技能')
  return { content: listing.content, billing_mode: listing.billing_mode }
}

/** 我的技能库：已解锁(free/one_time)的技能 + per_use 使用过的技能 */
export async function getMyLibrary(_db: Database.Database, userId: string): Promise<SkillListing[]> {
  return await dbAll<SkillListing>(`
    SELECT ${PUBLIC_COLS}, u.name as author_name, 1 as owned,
      MAX(o.created_at) as last_used
    FROM skill_orders o
    JOIN skill_listings l ON o.listing_id = l.id
    JOIN users u ON l.author_id = u.id
    WHERE o.buyer_id = ?
    GROUP BY l.id
    ORDER BY last_used DESC
  `, [userId])
}

// ─── 审计（WebAZ content admin）─────────────────────────────────

export async function listPendingAudit(_db: Database.Database, limit = 100): Promise<SkillListing[]> {
  return await dbAll<SkillListing>(`
    SELECT l.*, u.name as author_name
    FROM skill_listings l JOIN users u ON l.author_id = u.id
    WHERE l.status = 'submitted' ORDER BY l.created_at ASC LIMIT ?
  `, [limit])
}

export function auditListing(
  db: Database.Database,
  listingId: string,
  reviewerId: string,
  decision: 'approve' | 'reject',
  note?: string,
): SkillListing {
  const cur = getListingRaw(db, listingId)
  if (!cur) throw new Error('技能不存在')
  if (cur.status !== 'submitted') throw new Error('该技能不在待审状态')
  if (decision === 'reject' && (!note || !note.trim())) throw new Error('拒绝需填写原因')

  if (decision === 'approve') {
    db.prepare("UPDATE skill_listings SET status='approved', active=1, audit_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(note?.trim() ?? null, reviewerId, listingId)
  } else {
    db.prepare("UPDATE skill_listings SET status='rejected', active=0, audit_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(note!.trim(), reviewerId, listingId)
  }
  return getListingRaw(db, listingId)!
}

// ─── 给 Agent / MCP 用的格式化 ─────────────────────────────────

export function formatListingForAgent(l: SkillListing): Record<string, unknown> {
  const meta = SKILL_KIND_META[l.skill_kind as SkillKind]
  return {
    id: l.id,
    title: l.title,
    summary: l.summary,
    kind: l.skill_kind,
    kind_label: meta?.label ?? l.skill_kind,
    kind_icon: meta?.icon ?? '⚙️',
    category: l.category,
    author: l.author_name,
    billing_mode: l.billing_mode,
    price: l.price,
    sales: l.total_sales,
    rating: l.rating,
    owned: Boolean(l.owned),
  }
}
