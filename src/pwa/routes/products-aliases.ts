/**
 * Product aliases — M7.2 alias 提取 + CRUD（仅商品 owner）
 *
 * 由 #1013 Phase 89 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   POST   /api/products/extract-aliases       从外部原文提取候选 alias（卖家上架时调用）
 *   GET    /api/products/:id/aliases           owner 查 alias 列表
 *   POST   /api/products/:id/aliases           owner 批量加 alias（事务 + per-INSERT cap 校验 防 TOCTOU）
 *   DELETE /api/products/:id/aliases/:aliasId  owner 撤销（soft delete → status='revoked'）
 *
 * 5 alias 类型：external_id / external_title / short_url / kouling_token / title_substring
 *   - title_substring 必须是商品 title 真子串
 *   - 每商品最多 20 个 active alias（防滥用）
 *   - 长度区间 6–200
 *
 * 跨域注入：auth + generateId + extractCandidateAliases
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProductsAliasesDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  extractCandidateAliases: (text: string) => Array<{ type: string; value: string; hint: string }>
}

export function registerProductsAliasesRoutes(app: Application, deps: ProductsAliasesDeps): void {
  // db 仍保留:用于 POST /aliases 的 db.transaction(TOCTOU 防护,better-sqlite3 事务须同步)。
  // 其余只读/单写站点已走 RFC-016 异步 seam(dbOne/dbAll/dbRun)。
  const { db, auth, generateId, extractCandidateAliases } = deps

  // M7.2-5: 从外部原文提取候选 alias
  app.post('/api/products/extract-aliases', (req, res) => {
    const user = auth(req, res); if (!user) return
    const text = String(req.body?.text || '').trim()
    if (!text || text.length < 6) return void res.json({ error: '文本至少 6 字符' })
    if (text.length > 5000) return void res.json({ error: '文本过长（≤ 5000 字符）' })
    const candidates = extractCandidateAliases(text)
    res.json({ candidates, hint: '勾选要声明为该商品 alias 的项目（≥ 6 字符；过短或过通用的项会被反作弊机制挑战）' })
  })

  // M7.2-7: alias CRUD（仅商品 owner）
  app.get('/api/products/:id/aliases', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [req.params.id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id !== user.id) return void res.status(403).json({ error: '仅商品 owner 可查看 alias' })
    const rows = await dbAll(`SELECT id, alias_type, alias_value, min_match_chars, status, challenged_at, created_at
      FROM product_aliases WHERE product_id = ? ORDER BY created_at DESC`, [req.params.id])
    res.json({ aliases: rows })
  })

  app.post('/api/products/:id/aliases', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ seller_id: string; title: string }>('SELECT seller_id, title FROM products WHERE id = ?', [req.params.id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id !== user.id) return void res.status(403).json({ error: '仅商品 owner 可添加 alias' })
    const inputs = Array.isArray(req.body?.aliases) ? req.body.aliases : []
    if (!inputs.length) return void res.json({ error: '请提供 aliases 数组' })

    const ALLOWED_TYPES = new Set(['external_id', 'external_title', 'short_url', 'kouling_token', 'title_substring'])
    const ALIAS_LIMIT_PER_PRODUCT = 20
    const countActive = db.prepare(`SELECT COUNT(*) as n FROM product_aliases WHERE product_id = ? AND status = 'active'`)
    const insertAlias = db.prepare(`INSERT INTO product_aliases (id, product_id, alias_type, alias_value, min_match_chars) VALUES (?,?,?,?,?)`)
    const rollbackAlias = db.prepare(`DELETE FROM product_aliases WHERE id = ?`)

    // M-3 fix：事务 + 每次 INSERT 后立即 SELECT COUNT 校验
    // 防止并发 / 多 INSERT 突破上限 → 单事务内 TOCTOU 不复存在
    const inserted: string[] = []
    const skipped: Array<{ value: string; reason: string }> = []

    const tx = db.transaction(() => {
      const startCount = (countActive.get(req.params.id) as { n: number }).n
      if (startCount >= ALIAS_LIMIT_PER_PRODUCT) {
        throw new Error(`LIMIT_REACHED:${startCount}`)
      }
      for (const a of inputs as Array<{ type: string; value: string; min_chars?: number }>) {
        const type = String(a?.type || '').trim()
        const value = String(a?.value || '').trim()
        if (!ALLOWED_TYPES.has(type)) { skipped.push({ value, reason: `unknown type: ${type}` }); continue }
        if (value.length < 6) { skipped.push({ value, reason: '< 6 字符' }); continue }
        if (value.length > 200) { skipped.push({ value, reason: '> 200 字符' }); continue }
        if (type === 'title_substring' && !p.title.includes(value)) {
          skipped.push({ value, reason: 'title_substring 必须是商品标题的真子串' }); continue
        }
        const minChars = Math.max(6, Number(a?.min_chars) || 6)
        const id = generateId('pal')
        try {
          insertAlias.run(id, req.params.id, type, value, minChars)
        } catch {
          skipped.push({ value, reason: 'duplicate or constraint' }); continue
        }
        // 立即校验：超 limit 立刻回滚这条
        const afterCount = (countActive.get(req.params.id) as { n: number }).n
        if (afterCount > ALIAS_LIMIT_PER_PRODUCT) {
          rollbackAlias.run(id)
          skipped.push({ value, reason: `reached ${ALIAS_LIMIT_PER_PRODUCT} cap` })
          break
        }
        inserted.push(id)
      }
    })

    try { tx() }
    catch (e) {
      const msg = String((e as Error).message || '')
      if (msg.startsWith('LIMIT_REACHED:')) {
        return void res.json({ error: `每个商品最多 ${ALIAS_LIMIT_PER_PRODUCT} 个 active alias` })
      }
      return void res.status(500).json({ error: msg })
    }
    res.json({ inserted: inserted.length, skipped })
  })

  app.delete('/api/products/:id/aliases/:aliasId', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [req.params.id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    if (p.seller_id !== user.id) return void res.status(403).json({ error: '仅商品 owner 可删除 alias' })
    const r = await dbRun(`UPDATE product_aliases SET status = 'revoked' WHERE id = ? AND product_id = ?`,
      [req.params.aliasId, req.params.id])
    res.json({ success: r.changes > 0 })
  })
}
