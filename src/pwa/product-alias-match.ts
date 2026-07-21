/**
 * 商品匹配单一真相源(A4:宁缺毋滥,exact-first 排他)。
 *
 * 从 pwa/server.ts 抽出(顶格文件加码必拆新文件的仓库铁律)。判定顺序:
 *   ① product ID / title 完全相等 · ② external_title 完全相等 —— 命中任一即【排他】只返回精确集
 *      (完整标题不得返回其他品牌/规格);
 *   ③ 仅在无精确命中时,才启用卖家声明的 alias 包含判定(alias_value ≥6 字符、active、≤ 输入长度)。
 * 关键判定者,绝不桩空返(见 test-mcp-model-projection A4-1)。
 */
import type Database from 'better-sqlite3'

export function resolveProductMatch(db: Database.Database, userInput: string): Set<string> {
  const text = String(userInput || '').trim()
  const matched = new Set<string>()
  if (!text) return matched
  try {
    const rows = db.prepare(`SELECT id FROM products WHERE (id = ? OR title = ?) AND status = 'active'`).all(text, text) as Array<{ id: string }>
    rows.forEach(r => matched.add(r.id))
  } catch { /* table shape variance in some fixtures */ }
  try {
    const rows = db.prepare(`SELECT DISTINCT product_id FROM product_external_links WHERE external_title = ?`).all(text) as Array<{ product_id: string }>
    rows.forEach(r => matched.add(r.product_id))
  } catch { /* external links optional */ }
  if (matched.size > 0) return matched   // exact-first 排他:有精确命中就不叠加族别名
  try {
    const aliases = db.prepare(`
      SELECT product_id, alias_value FROM product_aliases
      WHERE status = 'active' AND length(alias_value) >= 6 AND length(alias_value) <= ?
    `).all(text.length) as Array<{ product_id: string; alias_value: string }>
    for (const a of aliases) { if (text.includes(a.alias_value)) matched.add(a.product_id) }
  } catch { /* aliases optional */ }
  return matched
}
