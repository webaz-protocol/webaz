/**
 * Agent 类目契约(调用契约 P0 PR-AB)—— canonical category registry 单一真相源。
 *
 * 背景(docs/audits/agent-invocation-protocol-audit.md §1):discover 的 category 是等值匹配,
 * 但类目键从未通过任何 agent 可读通道发布 —— ChatGPT 猜 "household" 必得 0(生产 demand_signals
 * 实锤)。本模块提供:
 *   1. CANONICAL_CATEGORIES:稳定注册表(合法类目零商品也不消失)+ alias 种子(含已确认的
 *      household → 家庭清洁/纸品);
 *   2. resolveCategory:canonical / live(卖家自由类目直通)/ alias 唯一修正 / 多义 / 未知 五态;
 *   3. buildCategoryTable:注册表 + 动态 count/samples(供 GET /api/agent/categories 与
 *      MCP 资源 webaz://guide/categories 双通道消费 —— 不依赖宿主的 Resource 读取能力)。
 *
 * 纪律:alias 解析大小写不敏感;多义绝不静默挑一个(返回选项让 agent/用户澄清);live 直通保证
 * 卖家新建类目即刻可用(注册表滞后不阻塞供给)。
 */
import { dbAll, dbOne } from '../layer0-foundation/L0-1-database/db.js'

export interface CanonicalCategory { key: string; en: string; aliases: string[] }

// 种子 = 生产在售类目全集(2026-07-18 只读采样)+ 人工 alias;'test' 类目刻意不收录。
export const CANONICAL_CATEGORIES: CanonicalCategory[] = [
  { key: '家庭清洁/纸品', en: 'household cleaning / paper', aliases: ['household', 'household paper', 'paper', 'tissue', '纸品', '抽纸', '纸巾', '底部抽纸'] },
  { key: '厨房用品',     en: 'kitchen supplies',           aliases: ['kitchen', 'kitchenware', '厨具'] },
  { key: '厨房清洁',     en: 'kitchen cleaning',           aliases: ['kitchen cleaning'] },
  { key: '厨房收纳',     en: 'kitchen storage',            aliases: ['kitchen storage'] },
  { key: '家居收纳',     en: 'home storage',               aliases: ['home storage', 'storage box'] },
  { key: '家居用品/收纳', en: 'home goods / storage',       aliases: [] },
  { key: '家居用品/窗饰', en: 'home goods / window decor',  aliases: ['curtain', '窗饰', '窗帘'] },
  { key: '衣物护理',     en: 'garment care',               aliases: ['laundry', 'garment care', '衣物'] },
  { key: '个护清洁',     en: 'personal care',              aliases: ['personal care', '个护'] },
  { key: '旅行配件',     en: 'travel accessories',         aliases: ['travel accessories'] },
  { key: '旅行收纳',     en: 'travel storage',             aliases: ['travel storage', '旅行袋'] },
  { key: '数码配件',     en: 'digital accessories',        aliases: ['digital accessories', '数码'] },
  { key: '数码清洁',     en: 'digital cleaning',           aliases: ['digital cleaning', '清洁套装'] },
  { key: '手机配件',     en: 'phone accessories',          aliases: ['phone', 'phone accessories', 'phone stand', '手机', '手机支架', '支架'] },
  { key: '3C配件',       en: '3C accessories',             aliases: ['3c', '3c accessories'] },
  { key: '宠物用品',     en: 'pet supplies',               aliases: ['pet', 'pet supplies', '宠物'] },
  { key: '服装',         en: 'apparel',                    aliases: ['clothing', 'apparel', '服饰', '衣服'] },
]

// 多义 alias(刻意注册为多映射 —— 解析返回选项而非猜):
//   travel → 旅行配件|旅行收纳;收纳 → 家居收纳|厨房收纳|旅行收纳|家居用品/收纳;
//   cleaning/清洁 → 家庭清洁/纸品|厨房清洁|数码清洁|个护清洁
const AMBIGUOUS_ALIASES: Record<string, string[]> = {
  'travel':   ['旅行配件', '旅行收纳'],
  '旅行':     ['旅行配件', '旅行收纳'],
  '收纳':     ['家居收纳', '厨房收纳', '旅行收纳', '家居用品/收纳'],
  'storage':  ['家居收纳', '厨房收纳', '旅行收纳', '家居用品/收纳'],
  'cleaning': ['家庭清洁/纸品', '厨房清洁', '数码清洁', '个护清洁'],
  '清洁':     ['家庭清洁/纸品', '厨房清洁', '数码清洁', '个护清洁'],
}

const norm = (s: string): string => s.trim().toLowerCase()

const ALIAS_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  for (const c of CANONICAL_CATEGORIES) {
    for (const a of c.aliases) {
      const k = norm(a)
      const arr = m.get(k) ?? []
      if (!arr.includes(c.key)) arr.push(c.key)
      m.set(k, arr)
    }
  }
  for (const [a, keys] of Object.entries(AMBIGUOUS_ALIASES)) m.set(norm(a), [...keys])
  return m
})()

export type CategoryResolution =
  | { status: 'canonical' | 'live'; key: string; submitted: string }
  | { status: 'alias'; key: string; submitted: string }
  | { status: 'ambiguous'; submitted: string; options: string[] }
  | { status: 'unknown'; submitted: string; alias_hints: string[] }

/** 五态解析:canonical 精确 → live 直通(卖家自由类目)→ alias(唯一修正/多义)→ unknown(带近似提示)。 */
export async function resolveCategory(submitted: string): Promise<CategoryResolution> {
  const n = norm(submitted)
  const canon = CANONICAL_CATEGORIES.find(c => norm(c.key) === n)
  if (canon) return { status: 'canonical', key: canon.key, submitted }
  const live = await dbOne<{ category: string }>(
    "SELECT category FROM products WHERE LOWER(category) = ? AND status = 'active' LIMIT 1", [n])
  if (live) return { status: 'live', key: live.category, submitted }
  const aliasKeys = ALIAS_INDEX.get(n)
  if (aliasKeys && aliasKeys.length === 1) return { status: 'alias', key: aliasKeys[0], submitted }
  if (aliasKeys && aliasKeys.length > 1) return { status: 'ambiguous', submitted, options: aliasKeys }
  // 近似提示:注册表键/alias 与提交词互为子串
  const hints = new Set<string>()
  for (const c of CANONICAL_CATEGORIES) {
    if (norm(c.key).includes(n) || n.includes(norm(c.key)) || norm(c.en).includes(n)) hints.add(c.key)
    for (const a of c.aliases) if (norm(a).includes(n) || n.includes(norm(a))) hints.add(c.key)
  }
  return { status: 'unknown', submitted, alias_hints: [...hints].slice(0, 5) }
}

export interface CategoryTableRow {
  key: string
  en: string | null
  aliases: string[]
  active_count: number
  samples: string[]
  uncurated?: true
}

/** 注册表(零商品仍在列)+ 动态 count/samples + 在售但未收录的自由类目(uncurated,active>0 才列)。 */
export async function buildCategoryTable(): Promise<CategoryTableRow[]> {
  const live = await dbAll<{ category: string; c: number }>(
    "SELECT category, COUNT(*) AS c FROM products WHERE status = 'active' AND category IS NOT NULL AND category != '' GROUP BY category")
  const counts = new Map(live.map(r => [r.category, Number(r.c)]))
  const sampleFor = async (key: string): Promise<string[]> => {
    const rows = await dbAll<{ title: string }>(
      "SELECT title FROM products WHERE status = 'active' AND category = ? ORDER BY created_at DESC LIMIT 2", [key])
    return rows.map(r => String(r.title).slice(0, 40))
  }
  const table: CategoryTableRow[] = []
  const registered = new Set<string>()
  for (const c of CANONICAL_CATEGORIES) {
    registered.add(c.key)
    table.push({ key: c.key, en: c.en, aliases: c.aliases, active_count: counts.get(c.key) ?? 0, samples: counts.get(c.key) ? await sampleFor(c.key) : [] })
  }
  for (const [key, count] of counts) {
    if (!registered.has(key) && count > 0) {
      table.push({ key, en: null, aliases: [], active_count: count, samples: await sampleFor(key), uncurated: true })
    }
  }
  return table
}
