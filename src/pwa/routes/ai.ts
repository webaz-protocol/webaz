/**
 * AI 卖家辅助 — 价格建议 + 文案生成
 *
 * 由 #1013 Phase 100 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/ai/price-suggestion      G-2: 基于类目历史 + 近 30 天成交均价
 *   POST /api/ai/generate-description  G-1: 100-200 字差异化卖点（zh/en）
 *
 * 用 claude-haiku-4-5 模型。
 *
 * 跨域注入：auth + anthropic 客户端实例
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AiDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  // 真实 Anthropic SDK 签名极复杂；用 any 接口对齐
  anthropic: any
}

export function registerAiRoutes(app: Application, deps: AiDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne),不再直接用 deps.db
  const { auth, anthropic } = deps

  // G-2: AI 价格建议
  app.post('/api/ai/price-suggestion', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.status(403).json({ error: '仅卖家可用' })
    const { title, category, description } = req.body || {}
    if (!title) return void res.status(400).json({ error: '请提供 title' })
    // 类目历史价位
    const stats = (await dbOne<{ cnt: number; avg: number; min: number; max: number; median: number }>(`
      SELECT COUNT(*) as cnt, COALESCE(AVG(price), 0) as avg, COALESCE(MIN(price), 0) as min, COALESCE(MAX(price), 0) as max,
        COALESCE((SELECT price FROM products WHERE status='active' AND category = ? ORDER BY price LIMIT 1 OFFSET CAST((SELECT COUNT(*) FROM products WHERE status='active' AND category = ?) / 2 AS INTEGER)), 0) as median
      FROM products WHERE status = 'active' AND category = ?
    `, [category || '', category || '', category || '']))!
    // 近 30 天成交均价（更可信）
    const recentAvg = (await dbOne<{ avg: number }>(`
      SELECT COALESCE(AVG(total_amount), 0) as avg FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE p.category = ? AND o.status = 'completed' AND o.created_at > datetime('now', '-30 days')
    `, [category || '']))!.avg

    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `你是 WebAZ 定价顾问。给以下商品建议合理定价（WAZ ≈ CNY，1 USDC ≈ 1 WAZ）：
商品标题: ${String(title).slice(0, 100)}
类目: ${category || '未填'}
描述: ${String(description || '').slice(0, 300)}

同类目市场数据（active 商品）：
- 商品数: ${stats.cnt}
- 价位区间: ${stats.min} - ${stats.max} WAZ
- 均价: ${stats.avg.toFixed(0)} WAZ
- 中位价: ${stats.median} WAZ
- 近 30 天成交均价: ${recentAvg.toFixed(0)} WAZ

只返回 JSON（无前后缀）：
{
  "suggested_price": 推荐价数字,
  "low_price": 价格区间下限,
  "high_price": 价格区间上限,
  "reasoning": "1-2 句简短解释"
}`,
        }],
      })
      const text = (message.content[0] as { type: string; text?: string })?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return void res.status(500).json({ error: 'AI 返回格式错误' })
      const parsed = JSON.parse(m[0])
      res.json({ ...parsed, market_data: stats, recent_avg: recentAvg })
    } catch (e) {
      res.status(503).json({ error: 'AI 失败: ' + (e as Error).message })
    }
  })

  // G-1: AI 文案生成（卖家发品辅助）
  app.post('/api/ai/generate-description', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.status(403).json({ error: '仅卖家可用' })
    const { title, category, keywords, language } = req.body || {}
    if (!title) return void res.status(400).json({ error: '请提供 title' })
    const lang = language === 'en' ? 'English' : '中文'
    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `你是 WebAZ 电商文案助手。根据以下信息生成商品描述（${lang}）：
- 标题: ${String(title).slice(0, 100)}
- 类目: ${category || '未填'}
- 关键词: ${(keywords || []).slice(0, 10).join('、') || '无'}

要求：
1. 100-200 字
2. 强调 1-2 个差异化卖点
3. 无虚假宣传 / 无绝对化用语（最、第一）
4. ${lang}
5. 不加 emoji
6. 直接输出文案正文，无多余前后缀`,
        }],
      })
      const text = (message.content[0] as { type: string; text?: string })?.text || ''
      res.json({ description: text.trim(), model: 'claude-haiku-4-5' })
    } catch (e) {
      res.status(503).json({ error: 'AI 生成失败: ' + (e as Error).message })
    }
  })
}
