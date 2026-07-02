/**
 * L4-4 · Skill 市场
 *
 * Skill 是卖家发布的可复用能力插件，让买家 Agent 一键接入卖家服务。
 * 核心思路：解决冷启动——现有 Amazon/Shopify 卖家零成本接入新渠道。
 *
 * Skill 类型：
 *   catalog_sync      - 目录同步（把外部店铺接入 WebAZ 搜索）
 *   auto_accept       - 自动接单（买家下单后立即接受，无需等待）
 *   price_negotiation - 价格协商（允许 Agent 在限定范围内议价）
 *   quality_guarantee - 质量承诺（额外质押，增强买家信心）
 *   instant_ship      - 极速发货（承诺 24h 内发货）
 *
 * 收益模型：
 *   - catalog_sync 技能的订单，技能发布者获得成交额 0.5% 的推荐佣金
 *   - 其他技能目前免费（增强曝光，间接提升成交）
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)
import { toUnits, toDecimal } from '../../money.js'
import { applyWalletDelta } from '../../ledger.js'

// ─── Schema ───────────────────────────────────────────────────

export function initSkillSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id            TEXT PRIMARY KEY,
      seller_id     TEXT NOT NULL REFERENCES users(id),
      name          TEXT NOT NULL,
      description   TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'general',
      skill_type    TEXT NOT NULL,
      config        TEXT DEFAULT '{}',
      price_per_use REAL DEFAULT 0,
      active        INTEGER DEFAULT 1,
      total_uses    INTEGER DEFAULT 0,
      rating        REAL DEFAULT 5.0,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_subscriptions (
      id         TEXT PRIMARY KEY,
      skill_id   TEXT NOT NULL REFERENCES skills(id),
      user_id    TEXT NOT NULL REFERENCES users(id),
      config     TEXT DEFAULT '{}',
      active     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(skill_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS skill_usage_log (
      id         TEXT PRIMARY KEY,
      skill_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      order_id   TEXT,
      fee_paid   REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_skills_type   ON skills(skill_type, active);
    CREATE INDEX IF NOT EXISTS idx_skills_seller ON skills(seller_id);
    CREATE INDEX IF NOT EXISTS idx_sub_user      ON skill_subscriptions(user_id, active);
  `)
}

// ─── 类型 ─────────────────────────────────────────────────────

export type SkillType =
  | 'catalog_sync'
  | 'auto_accept'
  | 'auto_bid'
  | 'price_negotiation'
  | 'quality_guarantee'
  | 'instant_ship'

export interface Skill {
  id: string
  seller_id: string
  name: string
  description: string
  category: string
  skill_type: SkillType
  config: string        // JSON
  price_per_use: number
  active: number
  total_uses: number
  rating: number
  created_at: string
  // 附加字段（JOIN 时有）
  seller_name?: string
  subscriber_count?: number
  subscribed?: number   // 当前用户是否已订阅
}

export interface SkillSubscription {
  id: string
  skill_id: string
  user_id: string
  config: string
  active: number
  created_at: string
}

// Skill 类型对应的元信息（描述给 Agent 看；双语支持）
export const SKILL_TYPE_META: Record<SkillType, { label: string; label_en: string; icon: string; description: string; description_en: string }> = {
  catalog_sync: {
    label: '目录同步',
    label_en: 'Catalog sync',
    icon: '🔄',
    description: '将卖家的外部商品目录（Amazon/Shopify/自定义）同步到 WebAZ，买家 Agent 订阅后可优先发现这些商品。',
    description_en: 'Sync seller external catalogs (Amazon/Shopify/custom) to WebAZ — subscribed buyer agents discover these first.',
  },
  auto_accept: {
    label: '自动接单',
    label_en: 'Auto accept',
    icon: '⚡',
    description: '买家下单后卖家立即自动接受（无需手动确认），减少买家等待，提升转化率。',
    description_en: 'Auto-accept incoming orders without manual confirmation — reduces buyer wait and lifts conversion.',
  },
  auto_bid: {
    label: '自动报价',
    label_en: 'Auto bid',
    icon: '🤖',
    description: 'RFQ 求购单创建时，按预设规则（类目/地区/ETA/价格策略）自动向匹配的 RFQ 提交 bid，捕获急单流量。',
    description_en: 'When an RFQ is posted, auto-submit a bid by your rules (category/region/ETA/strategy) — captures urgent demand.',
  },
  price_negotiation: {
    label: '价格协商',
    label_en: 'Price negotiation',
    icon: '🤝',
    description: '允许买家 Agent 在指定范围内自动议价，无需人工参与价格谈判。',
    description_en: 'Allow buyer agents to auto-negotiate within set bounds — no human required.',
  },
  quality_guarantee: {
    label: '质量承诺',
    label_en: 'Quality guarantee',
    icon: '🛡️',
    description: '卖家额外质押 WAZ 作为质量保证金，问题订单买家可获得额外赔偿。',
    description_en: 'Seller stakes extra WAZ as quality bond — buyer gets additional compensation on disputes.',
  },
  instant_ship: {
    label: '极速发货',
    label_en: 'Instant ship',
    icon: '🚀',
    description: '卖家承诺 24h 内发货，违约自动赔付。适合现货充足的卖家。',
    description_en: 'Seller commits to shipping within 24h; auto-payout on violation.',
  },
}

// 各 skill_type 的默认 config（QA 轮 16 P2：publish 不传 config → config_preview 空 {}）
// publish 时若 config 缺省，套用这里的合理默认，agent 可后续 PATCH 调整
export const DEFAULT_SKILL_CONFIG: Record<SkillType, Record<string, unknown>> = {
  catalog_sync:      { source: 'custom', auto_refresh_hours: 24 },
  auto_accept:       { enabled: true, max_order_value: null },
  auto_bid:          { enabled: true, categories: ['standard'], regions: [], max_eta_h: 24, bid_strategy: 'cheapest_undercut', undercut_pct: 0.05, max_price_cap: null, daily_cap: 20, cooldown_min: 60 },
  price_negotiation: { enabled: true, min_accept_pct: 0.85, max_rounds: 3 },
  quality_guarantee: { bond_amount: 0, compensation_pct: 0.5 },
  instant_ship:      { ship_within_hours: 24, penalty_pct: 0.1 },
}

// ─── 发布 Skill ────────────────────────────────────────────────

export interface PublishSkillInput {
  sellerId: string
  name: string
  description: string
  category?: string
  skillType: SkillType
  config?: Record<string, unknown>
  pricePerUse?: number
}

export function publishSkill(db: Database.Database, input: PublishSkillInput): Skill {
  const seller = db.prepare('SELECT id, role, name FROM users WHERE id = ?').get(input.sellerId) as { role: string; name: string } | undefined
  if (!seller) throw new Error('用户不存在')
  if (seller.role !== 'seller') throw new Error('只有卖家才能发布 Skill')

  // 检查重复
  const exists = db.prepare('SELECT id FROM skills WHERE seller_id = ? AND skill_type = ? AND name = ? AND active = 1').get(input.sellerId, input.skillType, input.name)
  if (exists) throw new Error('你已发布过同名同类型的 Skill，请先修改现有 Skill')

  const id = generateId('skl')
  // QA 轮 16 P2：config 缺省时套用 per-type 默认（避免 config_preview 空 {}）
  const hasConfig = input.config && Object.keys(input.config).length > 0
  const config = JSON.stringify(hasConfig ? input.config : (DEFAULT_SKILL_CONFIG[input.skillType] ?? {}))

  db.prepare(`
    INSERT INTO skills (id, seller_id, name, description, category, skill_type, config, price_per_use)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.sellerId, input.name, input.description, input.category ?? 'general', input.skillType, config, input.pricePerUse ?? 0)

  return getSkillById(db, id)!
}

// ─── 查询 Skill 列表 ───────────────────────────────────────────

export interface ListSkillsFilter {
  skillType?: SkillType
  category?: string
  query?: string
  subscriberId?: string   // 传入时附加"是否已订阅"字段
  limit?: number
}

// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点均确认不在 db.transaction 内)。
//   注:getSkillById(被同步写 publishSkill 内部调用)+ shouldAutoAccept(orders-create tx 内)留 Phase 3。
export async function listSkills(_db: Database.Database, filter: ListSkillsFilter = {}): Promise<Skill[]> {
  const params: unknown[] = []
  let sql = `
    SELECT s.*, u.name as seller_name,
      (SELECT COUNT(*) FROM skill_subscriptions ss WHERE ss.skill_id = s.id AND ss.active = 1) as subscriber_count
      ${filter.subscriberId ? `, (SELECT COUNT(*) FROM skill_subscriptions ss2 WHERE ss2.skill_id = s.id AND ss2.user_id = ? AND ss2.active = 1) as subscribed` : ''}
    FROM skills s
    JOIN users u ON s.seller_id = u.id
    WHERE s.active = 1
  `
  if (filter.subscriberId) params.push(filter.subscriberId)

  if (filter.skillType) { sql += ` AND s.skill_type = ?`; params.push(filter.skillType) }
  if (filter.category)  { sql += ` AND s.category = ?`;   params.push(filter.category) }
  if (filter.query)     { sql += ` AND (s.name LIKE ? OR s.description LIKE ?)`; params.push(`%${filter.query}%`, `%${filter.query}%`) }

  sql += ` ORDER BY s.total_uses DESC, s.rating DESC LIMIT ?`
  params.push(filter.limit ?? 20)

  return await dbAll<Skill>(sql, params)
}

export function getSkillById(db: Database.Database, skillId: string): Skill | null {
  return db.prepare(`
    SELECT s.*, u.name as seller_name,
      (SELECT COUNT(*) FROM skill_subscriptions ss WHERE ss.skill_id = s.id AND ss.active = 1) as subscriber_count
    FROM skills s JOIN users u ON s.seller_id = u.id WHERE s.id = ?
  `).get(skillId) as Skill | null
}

export async function getMySkills(_db: Database.Database, sellerId: string): Promise<Skill[]> {
  return await dbAll<Skill>(`
    SELECT s.*,
      (SELECT COUNT(*) FROM skill_subscriptions ss WHERE ss.skill_id = s.id AND ss.active = 1) as subscriber_count
    FROM skills s WHERE s.seller_id = ? ORDER BY s.created_at DESC
  `, [sellerId])
}

// ─── 订阅 / 取消订阅 ──────────────────────────────────────────

export function subscribeSkill(
  db: Database.Database,
  userId: string,
  skillId: string,
  config: Record<string, unknown> = {},
): { success: boolean; message: string } {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ? AND active = 1').get(skillId) as Skill | undefined
  if (!skill) throw new Error('Skill 不存在或已下架')

  // 如果之前取消过，重新激活
  const existing = db.prepare('SELECT id FROM skill_subscriptions WHERE skill_id = ? AND user_id = ?').get(skillId, userId) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE skill_subscriptions SET active = 1, config = ? WHERE id = ?').run(JSON.stringify(config), existing.id)
    return { success: true, message: '已重新订阅' }
  }

  const id = generateId('sub')
  db.prepare('INSERT INTO skill_subscriptions (id, skill_id, user_id, config) VALUES (?,?,?,?)').run(id, skillId, userId, JSON.stringify(config))
  return { success: true, message: '订阅成功' }
}

export function unsubscribeSkill(db: Database.Database, userId: string, skillId: string): void {
  db.prepare('UPDATE skill_subscriptions SET active = 0 WHERE skill_id = ? AND user_id = ?').run(skillId, userId)
}

export async function getMySubscriptions(_db: Database.Database, userId: string): Promise<Skill[]> {
  return await dbAll<Skill>(`
    SELECT s.*, u.name as seller_name, 1 as subscribed,
      (SELECT COUNT(*) FROM skill_subscriptions ss WHERE ss.skill_id = s.id AND ss.active = 1) as subscriber_count
    FROM skill_subscriptions sub
    JOIN skills s ON sub.skill_id = s.id
    JOIN users u ON s.seller_id = u.id
    WHERE sub.user_id = ? AND sub.active = 1
    ORDER BY sub.created_at DESC
  `, [userId])
}

// ─── 使用记录 + 佣金 ──────────────────────────────────────────

/**
 * 记录 Skill 使用：在订单成交时调用。
 * catalog_sync Skill 的发布者可获得成交额 0.5% 的推荐佣金。
 */
export function recordSkillUsage(
  db: Database.Database,
  orderId: string,
  orderAmount: number,
): void {
  const order = db.prepare('SELECT buyer_id, seller_id FROM orders WHERE id = ?').get(orderId) as { buyer_id: string; seller_id: string } | undefined
  if (!order) return

  // 查找该买家是否订阅了该卖家的 catalog_sync Skill
  const skillSub = db.prepare(`
    SELECT s.id as skill_id, s.seller_id
    FROM skill_subscriptions sub
    JOIN skills s ON sub.skill_id = s.id
    WHERE sub.user_id = ? AND s.seller_id = ? AND s.skill_type = 'catalog_sync' AND sub.active = 1
    LIMIT 1
  `).get(order.buyer_id, order.seller_id) as { skill_id: string; seller_id: string } | undefined

  if (!skillSub) return

  const feeU = Math.round(toUnits(orderAmount) * 0.005)  // 0.5% 推荐佣金(整数 base-units)
  if (feeU <= 0) return

  // 从系统账户（protocol fee 池）拨出佣金给 Skill 发布者
  // 简化实现：直接增加卖家钱包余额（Skill 发布者就是卖家本人）
  applyWalletDelta(db, skillSub.seller_id, { balance: feeU })
  db.prepare('UPDATE skills SET total_uses = total_uses + 1 WHERE id = ?').run(skillSub.skill_id)

  const id = generateId('sul')
  db.prepare('INSERT INTO skill_usage_log (id, skill_id, user_id, order_id, fee_paid) VALUES (?,?,?,?,?)').run(id, skillSub.skill_id, order.buyer_id, orderId, toDecimal(feeU))
}

// ─── 自动接单 Skill 触发 ──────────────────────────────────────

/**
 * 新订单创建时检查卖家是否有 auto_accept Skill。
 * 如果有且订单满足条件，返回 true（调用方负责执行 transition）。
 */
export function shouldAutoAccept(db: Database.Database, orderId: string): boolean {
  const order = db.prepare('SELECT seller_id, total_amount FROM orders WHERE id = ?').get(orderId) as { seller_id: string; total_amount: number } | undefined
  if (!order) return false

  const skill = db.prepare(`
    SELECT config FROM skills WHERE seller_id = ? AND skill_type = 'auto_accept' AND active = 1 LIMIT 1
  `).get(order.seller_id) as { config: string } | undefined
  if (!skill) return false

  const config = JSON.parse(skill.config) as { min_amount?: number; max_amount?: number; max_daily_orders?: number }
  const { min_amount = 0, max_amount = Infinity, max_daily_orders = 100 } = config

  if (order.total_amount < min_amount || order.total_amount > max_amount) return false

  // 检查今日已自动接单数
  const today = new Date().toISOString().slice(0, 10)
  const todayCount = (db.prepare(`
    SELECT COUNT(*) as n FROM orders
    WHERE seller_id = ? AND status != 'created' AND substr(created_at, 1, 10) = ?
  `).get(order.seller_id, today) as { n: number }).n

  return todayCount < max_daily_orders
}

// ─── Skill 格式化（给 Agent 看）──────────────────────────────

export function formatSkillForAgent(skill: Skill): Record<string, unknown> {
  const meta = SKILL_TYPE_META[skill.skill_type as SkillType]
  return {
    id: skill.id,
    name: skill.name,
    type: skill.skill_type,
    type_label: meta?.label ?? skill.skill_type,
    type_icon: meta?.icon ?? '⚙️',
    description: skill.description,
    seller: skill.seller_name,
    category: skill.category,
    subscribers: skill.subscriber_count ?? 0,
    rating: skill.rating,
    uses: skill.total_uses,
    subscribed: Boolean(skill.subscribed),
    config_preview: (() => {
      try { return JSON.parse(skill.config) } catch { return {} }
    })(),
  }
}
