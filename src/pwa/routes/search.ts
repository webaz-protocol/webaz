/**
 * 搜索/查询入口集合 — 优惠券预览 + 我的商品 + 三种搜索路径
 *
 * 由 #1013 Phase 104 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET  /api/coupons/preview   优惠券预览（折后价 + 折扣金额）
 *   GET  /api/my-products       卖家：我的全部商品（含任务/链接状态）
 *   POST /api/search-by-link    买家粘贴外链/分享文本 → 精准入口
 *   GET  /api/search-fuzzy      n-gram (n=2) 模糊搜索，独立通道
 *   GET  /api/check-url         上架前链接认领状态自检
 *
 * 跨域注入：auth + applyCouponToOrder + extractUrlFromText/Title + parsePlatformUrl
 *           + searchByExternalLink + detectShareCommandFormat + formatProductForAgent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface SearchDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  applyCouponToOrder: (code: string, sellerId: string, productId: string, price: number) =>
    { ok: boolean; discount?: number; error?: string; coupon?: Record<string, unknown> }
  extractUrlFromText: (text: string) => string | null
  extractTitleFromText: (text: string) => string | null
  parsePlatformUrl: (url: string) => { platform: string; external_id: string | null } | null
  searchByExternalLink: (args: { platform?: string; external_id?: string | null; external_title?: string | null }) =>
    { matched_by: string; products: unknown[] }
  detectShareCommandFormat: (text: string) => { hint: string } | null
  formatProductForAgent: (row: Record<string, unknown>) => Record<string, unknown>
}

export function registerSearchRoutes(app: Application, deps: SearchDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll);applyCouponToOrder 是注入的同步 wrapper(订单金钱路径)
  const { auth, applyCouponToOrder, extractUrlFromText, extractTitleFromText,
          parsePlatformUrl, searchByExternalLink, detectShareCommandFormat,
          formatProductForAgent } = deps

  app.get('/api/coupons/preview', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { code, product_id } = req.query as Record<string, string>
    if (!code || !product_id) return void res.status(400).json({ error: '需提供 code + product_id' })
    const p = await dbOne<{ seller_id: string; price: number }>('SELECT seller_id, price FROM products WHERE id = ?', [product_id])
    if (!p) return void res.status(404).json({ error: '商品不存在' })
    const result = applyCouponToOrder(code, p.seller_id, product_id, Number(p.price))
    if (!result.ok) return void res.json({ ok: false, error: result.error })
    res.json({ ok: true, discount: result.discount, final_price: Math.max(0, Number(p.price) - (result.discount || 0)) })
  })

  app.get('/api/my-products', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const products = await dbAll(`
      SELECT p.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM verify_tasks WHERE product_id=p.id AND status IN ('code_issued','open')
        ) THEN 1 ELSE 0 END as has_pending_task,
        CASE WHEN EXISTS (SELECT 1 FROM product_external_links WHERE product_id=p.id AND revoked=1)
          AND NOT EXISTS (SELECT 1 FROM product_external_links WHERE product_id=p.id AND verified=1 AND (revoked IS NULL OR revoked=0))
        THEN 1 ELSE 0 END as all_links_revoked
      FROM products p WHERE p.seller_id = ? ORDER BY p.created_at DESC
    `, [user.id])
    res.json(products)
  })

  app.post('/api/search-by-link', (req, res) => {
    const text = (req.body?.text || '').toString()
    const ext  = (req.body?.external_link ?? null) as
      | { platform?: string; external_id?: string; external_title?: string; canonical_url?: string }
      | null

    if (!text && !ext) return void res.json({ error: '请提供 text 或 external_link' })
    if (text && text.length > 2000) return void res.json({ error: '文本过长（>2000）' })

    let url: string | null = null
    let title: string | null = null
    let meta: { platform: string; external_id: string | null } | null = null

    if (ext && typeof ext === 'object') {
      if (ext.platform)       meta  = { platform: ext.platform, external_id: ext.external_id ?? null }
      if (ext.external_title) title = ext.external_title
      if (ext.canonical_url)  url   = ext.canonical_url
    }
    if (text) {
      if (!url)   url   = extractUrlFromText(text)
      if (!title) title = extractTitleFromText(text)
      if (!meta && url) meta = parsePlatformUrl(url)
      if (!url && !title) title = text.trim()
    }

    const result = searchByExternalLink({
      platform:       meta?.platform,
      external_id:    meta?.external_id,
      external_title: title,
    })

    let unsupportedHint: string | null = null
    if (result.matched_by === 'none' && !url && !title && text) {
      const cmd = detectShareCommandFormat(text)
      if (cmd) {
        unsupportedHint = `检测到 ${cmd.hint}，该格式经平台加密，无法直接解析。请改用包含 https:// 链接或「商品名」的分享文本。`
      }
    }

    res.json({
      extracted: {
        url,
        title,
        platform:    meta?.platform    ?? null,
        external_id: meta?.external_id ?? null,
      },
      matched_by:   result.matched_by,
      products:     result.products,
      ...(unsupportedHint ? { unsupported_format: true, hint: unsupportedHint } : {}),
    })
  })

  app.get('/api/search-fuzzy', async (req, res) => {
    const q = String(req.query.q ?? '').trim()
    const threshold = 0.5
    if (!q) return void res.json({ products: [], matched_by: 'none', score_threshold: threshold })
    if (q.length > 200) return void res.json({ error: '关键词过长（>200）' })

    const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    const qn = norm(q)
    if (!qn) return void res.json({ products: [], matched_by: 'none', score_threshold: threshold })

    const grams = (s: string, n = 2): string[] => {
      if (s.length <= n) return [s]
      const out: string[] = []
      for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n))
      return out
    }
    const qg = grams(qn)

    const rows = await dbAll<Record<string, unknown>>(`
      SELECT p.*, u.name as seller_name,
        COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
      FROM products p
      JOIN users u ON p.seller_id = u.id
      LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
      WHERE p.status = 'active' AND p.stock > 0
    `)

    const scored = rows
      .map((r) => {
        const tn = norm(String(r.title ?? ''))
        if (tn && tn.includes(qn)) return { row: r, score: 1 }
        let titleScore = 0
        if (tn && qg.length) {
          let hit = 0
          for (const g of qg) if (tn.includes(g)) hit++
          titleScore = hit / qg.length
        }
        let descScore = 0
        const dn = norm(String(r.description ?? ''))
        if (dn && qg.length) {
          let hit = 0
          for (const g of qg) if (dn.includes(g)) hit++
          descScore = (hit / qg.length) * 0.6
        }
        return { row: r, score: Math.max(titleScore, descScore) }
      })
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)

    res.json({
      products: scored.map((x) => ({ ...formatProductForAgent(x.row), _score: Number(x.score.toFixed(2)) })),
      matched_by: scored.length ? 'fuzzy' : 'none',
      score_threshold: threshold,
    })
  })

  app.get('/api/check-url', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const url = req.query.url as string
    if (!url) return void res.json({ error: '请提供 url 参数' })

    const selfClaim = await dbOne<{ product_id: string; title: string }>(`
      SELECT p.id as product_id, p.title FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND p.seller_id = ?
    `, [url, user.id])
    if (selfClaim) {
      return void res.json({ claimed: true, self: true, product_title: selfClaim.title, message: `您已在商品「${selfClaim.title}」中关联了此链接` })
    }

    const otherClaim = await dbOne<{ product_title: string }>(`
      SELECT p.title as product_title FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
    `, [url, user.id])
    if (otherClaim) {
      return void res.json({ claimed: true, self: false, message: `此链接已被其他商家认领，不能直接添加，上架后请在商品编辑页发起认领验证任务` })
    }

    res.json({ claimed: false })
  })
}
