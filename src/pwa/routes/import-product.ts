/**
 * Import product — 一键导入（safeFetch → AI 抽取结构化商品数据）
 *
 * 由 #1013 Phase 114 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint:
 *   POST /api/import-product   仅卖家 · 6/min/IP · 10/day（用自己 key 不限）
 *                              safeFetch 30k HTML → haiku 抽商品 JSON + 定价建议
 *
 * 跨域注入：auth + db + safeFetch + rateLimitOk + generateId
 *           + checkSellerCanList + anthropic (默认) + AnthropicCtor (用户 key 时新建实例)
 *           + FREE_IMPORT_LIMIT
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ImportProductDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeFetch: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ text: () => Promise<string> }>
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
  generateId: (prefix: string) => string
  checkSellerCanList: (user: Record<string, unknown>) => { ok: boolean; reason?: string }
  anthropic: any
  AnthropicCtor: any
  FREE_IMPORT_LIMIT: number
}

export function registerImportProductRoutes(app: Application, deps: ImportProductDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, safeFetch, rateLimitOk, generateId, checkSellerCanList,
          anthropic, AnthropicCtor, FREE_IMPORT_LIMIT } = deps

  app.post('/api/import-product', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可使用导入功能' })

    const quotaCheck = checkSellerCanList(user)
    if (!quotaCheck.ok) return void res.json({ error: quotaCheck.reason })

    const { url, user_api_key } = req.body
    if (!url) return void res.json({ error: '请提供商品链接' })
    if (!rateLimitOk(req.ip || 'unknown', 6, 60_000)) return void res.status(429).json({ error: '请求过于频繁，请稍后再试' })

    const selfClaim = await dbOne<{ product_id: string; title: string }>(`
      SELECT p.id as product_id, p.title FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND p.seller_id = ?
    `, [url, user.id])
    if (selfClaim) {
      return void res.json({ error: `您已上架过来自此链接的商品「${selfClaim.title}」，不能重复关联相同外部链接` })
    }

    const otherClaim = await dbOne<{ product_id: string }>(`
      SELECT p.id as product_id FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
    `, [url, user.id])
    if (otherClaim) {
      return void res.json({
        conflict: true,
        url,
        message: '此链接已被其他商家认领上架。如需认领归属，请发起链接认领验证任务。',
      })
    }

    const usingOwnKey = typeof user_api_key === 'string' && user_api_key.trim().startsWith('sk-ant-')
    if (!usingOwnKey) {
      const todayCount = (await dbOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM import_logs WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
      , [user.id]))!.cnt
      if (todayCount >= FREE_IMPORT_LIMIT) {
        return void res.json({
          error: `今日免费导入次数已用完（${FREE_IMPORT_LIMIT} 次/天）。请在导入面板填入你自己的 Anthropic API Key 以继续使用。`,
          quota_exceeded: true,
          used: todayCount,
          limit: FREE_IMPORT_LIMIT,
        })
      }
    }

    let html = ''
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      const resp = await safeFetch(String(url), {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebAZ/1.0; +https://webaz.xyz)',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      })
      clearTimeout(timer)
      const raw = await resp.text()
      html = raw.slice(0, 30000)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('ssrf_')) return void res.json({ error: '链接指向私网/localhost 或经 redirect 触达内部地址，已拦截' })
      return void res.json({ error: `无法访问该链接：${msg}` })
    }

    const avgPrices = await dbAll<{ category: string; avg_price: number; min_price: number; max_price: number; cnt: number }>(`
      SELECT category, AVG(price) as avg_price, MIN(price) as min_price, MAX(price) as max_price, COUNT(*) as cnt
      FROM products WHERE status = 'active' GROUP BY category
    `)

    const priceContext = avgPrices.map(r =>
      `${r.category || '未分类'}：均价 ${r.avg_price?.toFixed(0)} WAZ，最低 ${r.min_price} WAZ，最高 ${r.max_price} WAZ（${r.cnt} 件商品）`
    ).join('\n')

    const client = usingOwnKey
      ? new AnthropicCtor({ apiKey: user_api_key.trim() })
      : anthropic

    let extracted: Record<string, unknown>
    try {
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `你是一个电商商品信息提取助手，服务于 AI Agent 商业协议平台。从以下网页 HTML 中提取商品信息，返回精简结构化 JSON。

网页来源 URL：${url}

WebAZ 平台各类目价格参考（WAZ ≈ CNY）：
${priceContext || '暂无参考数据'}

只返回 JSON，不要其他文字：
{
  "title": "商品标题（简洁，50字以内）",
  "description": "面向 AI Agent 的商品描述：核心参数+适用场景，100字以内，无营销话术",
  "specs": {"规格名":"规格值"},
  "brand": "品牌（找不到填null）",
  "model": "型号或规格编号（找不到填null）",
  "original_price": 原平台价格数字（CNY，找不到填null）,
  "suggested_price": 建议WAZ定价（参考原价和平台均价，有竞争力）,
  "price_reasoning": "定价理由（1句）",
  "category": "茶具/家居/食品/服装/手工/电子（其他填空）",
  "stock": 建议库存（默认1）,
  "weight_kg": 重量数字（找不到填null）,
  "handling_hours": 备货时间小时数（默认24）,
  "ship_regions": "全国",
  "estimated_days": {"华东":2,"全国":5},
  "return_days": 退货天数（默认7）,
  "return_condition": "退货条件（如未拆封/任意原因）",
  "warranty_days": 质保天数（默认0）,
  "fragile": false,
  "tags": ["标签1","标签2"]
}

HTML（前30000字符）：
${html}`,
        }],
      })

      const text = message.content[0].type === 'text' ? message.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('未能提取 JSON')
      extracted = JSON.parse(jsonMatch[0])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return void res.json({ error: `AI 解析失败：${msg}` })
    }

    const title = typeof extracted.title === 'string' ? extracted.title.trim() : ''
    const description = typeof extracted.description === 'string' ? extracted.description.trim() : ''
    if (!title || title.length < 2) {
      return void res.json({
        error: '该链接无法提取商品信息（可能需要登录、或为动态渲染页面）。建议使用京东/亚马逊/独立站链接，或改用手动上架。',
        suggestion: 'manual',
      })
    }
    if (!description || description.length < 5) {
      extracted.description = title
    }

    if (!usingOwnKey) {
      await dbRun(`INSERT INTO import_logs (id, user_id) VALUES (?, ?)`, [generateId('iml'), user.id])
    }

    const usedToday = usingOwnKey ? 0 : (await dbOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM import_logs WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
    , [user.id]))!.cnt

    res.json({
      success: true,
      source_url: url,
      source_price: extracted.original_price ?? null,
      used_own_key: usingOwnKey,
      quota: usingOwnKey ? null : { used: usedToday, limit: FREE_IMPORT_LIMIT, remaining: FREE_IMPORT_LIMIT - usedToday },
      ...extracted,
    })
  })
}
