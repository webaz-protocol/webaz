#!/usr/bin/env tsx
/**
 * 调用契约 P0 PR-E — demand_signals 历史治理(假阴性标记)。
 *   dry-run(默认):npm run backfill:demand-signal-quality
 *   真跑:        npm run backfill:demand-signal-quality -- --commit
 *
 * 只【标记】不删除(append 审计字段 quality/invalidated_at/invalid_reason):把已确认的检索缺陷假阴性
 *   (类目枚举未发布前 result_count=0、且在同约束宽松匹配下本可命中的历史行)标为 invalidated,
 *   排除出"供给缺口"分析。判定用【与当前 discover 同源】的宽松复检(去 category 等值改词命中?——不,
 *   保留 category:审计定的假阴性是"类目枚举未发布"导致 agent 猜错 category,故对这类行按 intent 里
 *   记录的 keywords 做【无 category、单/多词 OR】复检,命中则判假阴性)。绝不动 quality 已非空的行。
 *
 * 安全:纯读 + 单条 UPDATE(仅写三审计列,不改 intent/result_count/created_at);dry-run 打印将改的行;
 *   --commit 才落库。生产经 railway ssh 手动跑(碰生产数据,须 Holden 单独授权)。
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'

const commit = process.argv.includes('--commit')
const home = process.env.HOME || ''
const dbPath = process.env.WEBAZ_DB_PATH || join(home, '.webaz', 'webaz.db')
const db = new Database(dbPath, { readonly: !commit })

const esc = (k: string): string => k.toLowerCase().replace(/[\\%_]/g, m => '\\' + m)

// 候选:result_count=0 且 quality 未标(NULL / 仅 legacy)—— 只治理历史未复核行
const rows = db.prepare("SELECT id, intent_json, category, result_count FROM demand_signals WHERE result_count = 0 AND quality IS NULL ORDER BY created_at").all() as Array<{ id: string; intent_json: string; category: string | null; result_count: number }>

let suspect = 0, kept = 0
const toMark: Array<{ id: string; reason: string }> = []
for (const r of rows) {
  let intent: Record<string, unknown> = {}
  try { intent = JSON.parse(r.intent_json) as Record<string, unknown> } catch { /* 损坏 intent 跳过,不猜 */ }
  const kws = Array.isArray(intent.keywords) ? (intent.keywords as unknown[]).filter((k): k is string => typeof k === 'string' && !!k.trim()) : []
  if (kws.length === 0) { kept++; continue }
  // 宽松复检:标题 OR 命中任一 keyword(库存≥1);类目枚举未发布是根因 → 复检【不】强加 category
  //   (历史行记录的 category 多为 agent 猜错值,如 "household");命中即证"供给其实存在"= 假阴性。
  const clause = kws.map(() => "LOWER(title) LIKE '%' || ? || '%' ESCAPE '\\'").join(' OR ')
  const hit = db.prepare(`SELECT 1 FROM products WHERE status = 'active' AND stock >= 1 AND (${clause}) LIMIT 1`).get(...kws.map(esc))
  if (hit) { suspect++; toMark.push({ id: r.id, reason: `false_negative: keywords ${JSON.stringify(kws)} match active supply under relaxed (title-OR) recheck; original result_count=0 predates category-vocabulary publication` }) }
  else kept++
}

console.log(`demand_signals 历史治理 [${commit ? 'COMMIT' : 'DRY-RUN'}] @ ${dbPath}`)
console.log(`  候选(result_count=0 且未复核): ${rows.length}`)
console.log(`  判定假阴性(将标 invalidated): ${suspect}`)
console.log(`  保留(无 keywords / 复检确无供给): ${kept}`)
for (const m of toMark.slice(0, 30)) console.log(`  → ${m.id}: ${m.reason}`)
if (toMark.length > 30) console.log(`  … 及另 ${toMark.length - 30} 行`)

if (commit && toMark.length) {
  const upd = db.prepare("UPDATE demand_signals SET quality = 'invalidated', invalidated_at = datetime('now'), invalid_reason = ? WHERE id = ? AND quality IS NULL")
  const tx = db.transaction((items: Array<{ id: string; reason: string }>) => { let n = 0; for (const m of items) n += upd.run(m.reason, m.id).changes; return n })
  const n = tx(toMark)
  console.log(`✅ 已标记 ${n} 行为 invalidated(只标不删,原始字段无损)`)
} else if (!commit && toMark.length) {
  console.log('\n(dry-run:未写库。确认后加 --commit 落库)')
}
db.close()
