/**
 * Agent buy — AI 比价 + 可选自动下单 (buyer 唯一智能购物入口)
 *
 * 由 #1013 Phase 115 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint:
 *   POST /api/agent-buy   仅买家 · 6/min/IP
 *                         safeFetch source → haiku 提关键词 → 搜 WebAZ 同类
 *                         → haiku 比价 → auto_buy=true 且无变体则锁价+创建+modulo paid
 *
 * 跨域注入：auth + db + safeFetch + rateLimitOk + generateId
 *           + anthropic + AnthropicCtor + formatProductForAgent
 *           + checkStockAndMaybeDelist + addHours + transition + notifyTransition
 *           + shouldAutoAccept
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'

export interface AgentBuyDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeFetch: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ text: () => Promise<string> }>
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
  generateId: (prefix: string) => string
  anthropic: any
  AnthropicCtor: any
  formatProductForAgent: (row: Record<string, unknown>) => Record<string, unknown>
  checkStockAndMaybeDelist: (productId: string) => void
  addHours: (d: Date, hours: number) => string
  transition: any
  notifyTransition: any
  shouldAutoAccept: (db: Database.Database, orderId: string) => boolean
}

export function registerAgentBuyRoutes(app: Application, deps: AgentBuyDeps): void {
  const { db, auth, safeFetch, rateLimitOk, generateId,
          anthropic, AnthropicCtor, formatProductForAgent,
          checkStockAndMaybeDelist, addHours, transition, notifyTransition,
          shouldAutoAccept } = deps

  app.post('/api/agent-buy', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'buyer') return void res.json({ error: '仅买家可使用智能下单' })

    const { source_url, shipping_address, auto_buy = false, user_api_key } = req.body
    if (!source_url) return void res.json({ error: '请提供商品链接' })
    if (auto_buy && !shipping_address) return void res.json({ error: '自动下单需提供收货地址' })
    if (!rateLimitOk(req.ip || 'unknown', 6, 60_000)) return void res.status(429).json({ error: '请求过于频繁，请稍后再试' })

    let html = ''
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10000)
      const resp = await safeFetch(String(source_url), {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebAZ/1.0; +https://webaz.xyz)',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      })
      clearTimeout(timer)
      html = (await resp.text()).slice(0, 20000)
    } catch (e: unknown) {
      const msg = (e as Error).message
      if (msg.startsWith('ssrf_')) return void res.json({ error: '链接指向私网/localhost 或经 redirect 触达内部地址，已拦截' })
      return void res.json({ error: `无法访问该链接：${msg}` })
    }

    const client = (typeof user_api_key === 'string' && user_api_key.trim().startsWith('sk-ant-'))
      ? new AnthropicCtor({ apiKey: user_api_key.trim() })
      : anthropic

    let source: Record<string, unknown>
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content:
          `从以下网页提取商品关键信息，仅返回JSON：
{
  "title": "商品全名",
  "price_cny": 数字或null,
  "category": "分类",
  "search_terms": ["独立短词1","独立短词2","独立短词3"]
}
search_terms 是3-5个独立的中文短词（每个2-4个汉字），用于在数据库里搜索同类商品。
例：九阳炒菜机器人 → ["炒菜机","九阳","炒菜机器人","自动炒菜"]
HTML：${html}` }],
      })
      const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) throw new Error('no json')
      source = JSON.parse(m[0])
    } catch {
      return void res.json({ error: '无法从链接提取商品信息，请尝试其他链接' })
    }

    if (!source.title) return void res.json({ error: '链接无法提取商品信息（可能需要登录或动态渲染）' })

    const urlMatchIds = (db.prepare(`
      SELECT DISTINCT product_id FROM product_external_links WHERE url = ? AND verified = 1
    `).all(source_url) as { product_id: string }[]).map(r => r.product_id)

    const urlMatchProducts: Record<string, unknown>[] = urlMatchIds.length > 0
      ? db.prepare(`
          SELECT p.*, u.name as seller_name,
            COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
          FROM products p
          JOIN users u ON p.seller_id = u.id
          LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
          WHERE p.id IN (${urlMatchIds.map(() => '?').join(',')}) AND p.status = 'active' AND p.stock > 0
        `).all(...urlMatchIds) as Record<string, unknown>[]
      : []

    let keywordProducts: Record<string, unknown>[] = []
    if (urlMatchProducts.length < 3) {
      const rawTerms = Array.isArray(source.search_terms) ? source.search_terms as string[] : []
      if (rawTerms.length === 0) {
        const t = source.title as string
        for (let i = 0; i + 2 <= t.length && rawTerms.length < 4; i += 2) rawTerms.push(t.slice(i, i + 4))
      }
      const terms = rawTerms.filter((t: string) => t && t.length >= 2).slice(0, 6)
      if (terms.length > 0) {
        const termClauses = terms.map(() => `p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\'`).join(' OR ')
        const termParams  = terms.flatMap((t: string) => { const e = t.replace(/[\\%_]/g, '\\$&'); return [`%${e}%`, `%${e}%`] })
        const catClause   = source.category ? ` OR p.category = ?` : ''
        const catParam    = source.category ? [source.category] : []
        const alreadyIds  = urlMatchProducts.map(p => p.id as string)
        const excludeClause = alreadyIds.length > 0 ? ` AND p.id NOT IN (${alreadyIds.map(() => '?').join(',')})` : ''
        keywordProducts = db.prepare(`
          SELECT p.*, u.name as seller_name,
            COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
          FROM products p
          JOIN users u ON p.seller_id = u.id
          LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
          WHERE p.status = 'active' AND p.stock > 0
            AND (${termClauses}${catClause})${excludeClause}
          ORDER BY rep_points DESC, p.price ASC LIMIT ${5 - urlMatchProducts.length}
        `).all(...termParams, ...catParam, ...alreadyIds) as Record<string, unknown>[]
      }
    }

    const webazProducts = [...urlMatchProducts, ...keywordProducts]
    const webazFormatted: Record<string, unknown>[] = webazProducts.map(p => ({
      ...formatProductForAgent(p),
      url_match: urlMatchIds.includes(p.id as string),
    }))

    let decision: { recommendation: string; best_product_id?: string; reason: string; savings_note?: string }
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content:
          `你是一个购物助手。用户想买以下商品，我们找到了 WebAZ 平台上的替代选项，请做出购买建议。

原商品：
- 标题：${source.title}
- 原平台价格：${source.price_cny ? `¥${source.price_cny} CNY` : '未知'}
- 链接：${source_url}

WebAZ 平台替代方案（WAZ ≈ CNY）：
${webazFormatted.length > 0 ? JSON.stringify(webazFormatted.map(p => ({
  id: p.id,
  title: p.title,
  price: p.price,
  agent_summary: p.agent_summary,
  seller: p.seller_name,
  rep: p.rep_level,
})), null, 2) : '暂无匹配商品'}

仅返回JSON（不要其他文字）：
{
  "recommendation": "buy_webaz" | "buy_source" | "no_match",
  "best_product_id": "WebAZ商品ID（recommendation=buy_webaz时填写，否则null）",
  "reason": "一句话购买建议，说明为什么选这个方案（包含价格对比、售后优势等）",
  "savings_note": "省了多少或更优在哪（简短，可null）"
}` }],
      })
      const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) throw new Error('no json')
      decision = JSON.parse(m[0])
    } catch {
      decision = { recommendation: 'no_match', reason: '无法完成比价分析，请手动选购' }
    }

    let orderId: string | null = null
    let sessionToken: string | null = null
    let verifiedPrice: number | null = null

    if (auto_buy && decision.recommendation === 'buy_webaz' && decision.best_product_id) {
      const product = db.prepare(`SELECT * FROM products WHERE id = ? AND status = 'active'`)
        .get(decision.best_product_id) as Record<string, unknown> | undefined

      if (product && Number(product.has_variants) === 1) {
        decision.reason = (decision.reason || '') + ' · 该商品需手动选规格，跳过 auto_buy'
      } else if (product && (product.stock as number) > 0) {
        const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }

        if (wallet.balance >= (product.price as number)) {
          const now = new Date()
          const expiresAt = new Date(now.getTime() + 10 * 60_000)
          sessionToken = generateId('pst')
          const oId = generateId('ord')
          const totalAmount = product.price as number
          const seller = db.prepare('SELECT id FROM users WHERE id = ?').get(product.seller_id as string) as { id: string }

          // 原子核心:余额扣款(balance>=amount 守卫)+ 库存 CAS(stock>=1)+ 建单 + 价格锁,任一 changes!==1 抛回滚整笔。
          //   注:transition() 自带 db.transaction,不能嵌套进来(better-sqlite3 禁套娃);故状态推进 + 通知放 tx 提交后,
          //   与原顺序一致(原本就是 insert(created) → 扣款 → transition(paid))。守卫杜绝并发超卖/超扣 + 半写(Phase 3 pg 安全)。
          let committed = false
          try {
            db.transaction(() => {
              const deb = db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ? AND balance >= ?')
                .run(totalAmount, totalAmount, user.id, totalAmount)
              if (deb.changes !== 1) throw new Error('AGENTBUY_INSUFFICIENT_BALANCE')
              const dec = db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1').run(product.id)
              if (dec.changes !== 1) throw new Error('AGENTBUY_OUT_OF_STOCK')
              db.prepare(`INSERT INTO price_sessions (token, product_id, user_id, price, quantity, created_at, expires_at) VALUES (?,?,?,?,1,?,?)`)
                .run(sessionToken, product.id, user.id, product.price, now.toISOString(), expiresAt.toISOString())
              db.prepare(`INSERT INTO orders (
                id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
                status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
                pickup_deadline, delivery_deadline, confirm_deadline
              ) VALUES (?,?,?,?,1,?,?,?,'created',?,?,?,?,?,?,?,?)`).run(
                oId, product.id, user.id, seller.id, totalAmount, totalAmount, totalAmount,
                shipping_address, `[智能下单] ${decision.reason}`,
                addHours(now, 24), addHours(now, 48), addHours(now, 120),
                addHours(now, 168), addHours(now, 336), addHours(now, 408)
              )
              db.prepare(`UPDATE price_sessions SET used_at = datetime('now') WHERE token = ?`).run(sessionToken)
              committed = true
            })()
          } catch (e) {
            const m = (e as Error).message
            if (m !== 'AGENTBUY_INSUFFICIENT_BALANCE' && m !== 'AGENTBUY_OUT_OF_STOCK') throw e
            // 并发售罄 / 余额已变 → 不下单(auto_bought=false),在 reason 里说明
            sessionToken = null
            decision.reason = (decision.reason || '') + (m === 'AGENTBUY_OUT_OF_STOCK' ? ' · auto_buy 跳过：商品已售罄' : ' · auto_buy 跳过：余额不足')
          }

          if (committed) {
            // tx 提交后:状态推进 + 通知(transition 自带事务,故置于此)
            checkStockAndMaybeDelist(String(product.id))
            transition(db, oId, 'paid', user.id as string, [], '智能下单：模拟支付完成')
            notifyTransition(db, oId, 'created', 'paid')
            if (shouldAutoAccept(db, oId)) {
              const sys = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
              if (sys) {
                const ar = transition(db, oId, 'accepted', sys.id, [], '⚡ auto_accept Skill 自动接单')
                if (ar.success) notifyTransition(db, oId, 'paid', 'accepted')
              }
            }
            verifiedPrice = product.price as number
            orderId = oId
          }
        }
      }
    }

    const bestProduct = decision.best_product_id
      ? webazFormatted.find(p => p.id === decision.best_product_id) ?? null
      : null

    res.json({
      source: {
        title: source.title,
        price_cny: source.price_cny ?? null,
        url: source_url,
      },
      webaz_products: webazFormatted.slice(0, 3),
      recommendation: decision.recommendation,
      best_product: bestProduct,
      reason: decision.reason,
      savings_note: decision.savings_note ?? null,
      auto_bought: !!orderId,
      order_id: orderId,
      verified_price: verifiedPrice,
    })
  })
}
