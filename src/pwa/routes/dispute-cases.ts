/**
 * 公开仲裁判例 (dispute_cases) 域端点
 *
 * 由 #1013 Phase 8 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints + 1 inner helper:
 *   GET  /api/disputes/cases                          — 公开列表（全网）
 *   GET  /api/disputes/cases/by-product/:product_id   — 按商品的判例
 *   GET  /api/disputes/cases/:case_id                 — 案件详情（含评论 + 身份标签）
 *   POST /api/disputes/cases/:case_id/comment         — 评论（含 PII 脱敏 + LLM 审核）
 *   POST /api/disputes/cases/:case_id/comments/:cid/reply — 子回复（W5）
 *   POST /api/disputes/cases/:case_id/fairness        — 公正度投票
 *
 * + meetsPublicSpeechThreshold — 公共发言门槛（内部 helper）
 *
 * publishDisputeCase / redactCaseText / piiSanitize 留 server.ts
 *   - publishDisputeCase 被 arbitrate 端点调用（在 server.ts 未拆的部分）
 *   - piiSanitize / commentBlocklistHit / llmModerateComment 跨域审核 helper，server.ts 其它端点也用
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // 真实成交单一真相源

export interface DisputeCasesDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getUser: (req: Request) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  // 跨域审核 helpers（server.ts 多处用）
  piiSanitize: (text: string) => string
  detectFraud: (text: string) => string[]
  commentBlocklistHit: (text: string) => string | null
  llmModerateComment: (text: string) => Promise<{ ok: boolean; reason?: string }>
}

export function registerDisputeCasesRoutes(app: Application, deps: DisputeCasesDeps): void {
  const { db, auth, getUser, generateId, piiSanitize, detectFraud, commentBlocklistHit, llmModerateComment } = deps

  // 公共发言门槛 — 防新号/小号刷评论/投票
  // 至少满足其一：账户 >= 3 天 / 完成过 >= 1 单 / lifetime_score >= 5
  async function meetsPublicSpeechThreshold(user: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    const lifetime = Number(user.lifetime_score || 0)
    if (lifetime >= 5) return { ok: true }
    const completed = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND ${genuineSalePredicate('orders')}`, [user.id, user.id]))!.n  // 真实成交,排除退款/违约
    if (completed >= 1) return { ok: true }
    const created = user.created_at ? new Date(String(user.created_at).replace(' ', 'T') + 'Z').getTime() : 0
    if (created > 0 && (Date.now() - created) > 3 * 86400_000) return { ok: true }
    return { ok: false, reason: '账号需 ≥ 3 天 或 完成 ≥ 1 单 或 lifetime_score ≥ 5 才能公开发言（防小号刷量）' }
  }

  // 公开列表（全网）— 判例库总览
  app.get('/api/disputes/cases', async (req, res) => {
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 20))
    const category = req.query.category ? String(req.query.category) : null
    const winner = req.query.winner ? String(req.query.winner) : null
    // 2026-05-22 A1：全文搜索 — ruling_text + buyer_argument + seller_argument + product_title
    const q = req.query.q ? String(req.query.q).trim().slice(0, 80) : null
    // 排序选项 — newest（默认） / discussed（评论多）/ fair（公平评价高）
    const sort = String(req.query.sort || 'newest')
    const where: string[] = []
    const args: unknown[] = []
    if (category) { where.push('category_tag = ?'); args.push(category) }
    if (winner) { where.push('winner = ?'); args.push(winner) }
    if (q) {
      where.push(`(
        ruling_text LIKE ? OR buyer_argument LIKE ? OR seller_argument LIKE ? OR resolution LIKE ?
        OR EXISTS (SELECT 1 FROM products p WHERE p.id = dispute_cases.product_id AND p.title LIKE ?)
      )`)
      const pat = '%' + q.replace(/[%_]/g, '\\$&') + '%'
      args.push(pat, pat, pat, pat, pat)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    let orderSql = 'published_at DESC'
    if (sort === 'discussed') orderSql = 'comment_count DESC, fairness_yes DESC, published_at DESC'
    else if (sort === 'fair') orderSql = 'fairness_yes DESC, comment_count DESC, published_at DESC'
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT id, product_id, category_tag, winner, resolution, amount_bucket,
        fairness_yes, fairness_no, comment_count, published_at,
        (SELECT title FROM products WHERE id = dispute_cases.product_id) as product_title,
        (SELECT category FROM products WHERE id = dispute_cases.product_id) as product_category
      FROM dispute_cases
      ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ?
    `, [...args, limit])
    // 类目统计（侧栏过滤用）— 受 q 影响（搜索时只显匹配 q 的类目计数）
    const catCountWhere = q ? `WHERE (ruling_text LIKE ? OR buyer_argument LIKE ? OR seller_argument LIKE ? OR resolution LIKE ?
      OR EXISTS (SELECT 1 FROM products p WHERE p.id = dispute_cases.product_id AND p.title LIKE ?))` : ''
    const catCountArgs = q ? Array(5).fill('%' + q.replace(/[%_]/g, '\\$&') + '%') : []
    const categoryCounts = await dbAll<{ category_tag: string; n: number }>(`SELECT category_tag, COUNT(*) as n FROM dispute_cases ${catCountWhere} GROUP BY category_tag ORDER BY n DESC`, catCountArgs)
    res.json({ items: rows, category_counts: categoryCounts, total: rows.length, query: q, sort })
  })

  // 公开列表（按商品）
  app.get('/api/disputes/cases/by-product/:product_id', async (req, res) => {
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT id, category_tag, winner, resolution, amount_bucket, ruling_text,
        fairness_yes, fairness_no, comment_count, published_at
      FROM dispute_cases
      WHERE product_id = ?
      ORDER BY published_at DESC
      LIMIT 50
    `, [req.params.product_id])
    res.json({ items: rows })
  })

  // 案件详情（含评论 + 评论者身份标签）
  app.get('/api/disputes/cases/:case_id', async (req, res) => {
    const me = getUser(req)
    const c = await dbOne<Record<string, unknown>>(`SELECT * FROM dispute_cases WHERE id = ?`, [req.params.case_id])
    if (!c) return void res.status(404).json({ error: '判例不存在' })
    // 不外露内部 ID（buyer_id/dispute_id/order_id 不返回给前端）
    const safeCase = {
      id: c.id, category_tag: c.category_tag, winner: c.winner, resolution: c.resolution,
      amount_bucket: c.amount_bucket, buyer_argument: c.buyer_argument, seller_argument: c.seller_argument,
      ruling_text: c.ruling_text, fairness_yes: c.fairness_yes, fairness_no: c.fairness_no,
      comment_count: c.comment_count, published_at: c.published_at,
      product_id: c.product_id, seller_id: c.seller_id,
    }
    // 评论 + 自动身份标签
    const rawComments = await dbAll<Record<string, unknown>>(`
      SELECT dc.*, u.handle, u.name, u.role,
        (SELECT COUNT(*) FROM orders o
         WHERE o.buyer_id = dc.commenter_id AND o.product_id = ? AND ${genuineSalePredicate('o')}) as bought_count,
        (SELECT COUNT(*) FROM products p
         WHERE p.seller_id = dc.commenter_id AND p.category = (SELECT category FROM products WHERE id = ?) AND p.status = 'active') as same_cat_seller_count
      FROM dispute_comments dc
      JOIN users u ON u.id = dc.commenter_id
      WHERE dc.case_id = ? AND dc.flagged = 0
      ORDER BY
        (bought_count > 0) DESC,
        (u.role IN ('verifier','arbitrator')) DESC,
        dc.created_at DESC
      LIMIT 50
    `, [c.product_id, c.product_id, c.id])
    // 脱敏：anonymous=1 时清除 handle/name/commenter_id（保留贡献标签字段：bought/same_cat/role/lifetime）
    // 验证员/仲裁员角色在脱敏时降级为 'staff'（避免小池子反推身份）
    const anonymize = (row: Record<string, unknown>) => {
      if (!row.anonymous) return row
      return { ...row, commenter_id: '__anon__', handle: null, name: null,
        role: (row.role === 'verifier' || row.role === 'arbitrator') ? 'staff' : 'user' }
    }
    // W5: 取所有子回复，按 parent_comment_id 分组挂在 comments 下
    const commentIds = rawComments.map(r => r.id as string)
    const rawReplies = commentIds.length > 0 ? await dbAll<Record<string, unknown>>(`
      SELECT r.*, u.handle, u.name, u.role
      FROM dispute_comment_replies r LEFT JOIN users u ON u.id = r.replier_id
      WHERE r.parent_comment_id IN (${commentIds.map(() => '?').join(',')})
      ORDER BY r.created_at ASC
    `, commentIds) : []
    const repliesByParent = new Map<string, Array<Record<string, unknown>>>()
    for (const r of rawReplies) {
      const pid = String(r.parent_comment_id)
      const arr = repliesByParent.get(pid) || []
      arr.push(anonymize(r))
      repliesByParent.set(pid, arr)
    }
    const comments = rawComments.map(c => ({
      ...anonymize(c),
      replies: repliesByParent.get(c.id as string) || [],
    }))
    // 我的公正度投票（如已投）
    let myVote: string | null = null
    if (me) {
      const v = await dbOne<{ vote: string }>('SELECT vote FROM dispute_fairness_votes WHERE case_id = ? AND voter_id = ?', [c.id, me.id])
      myVote = v?.vote || null
    }
    // 我是否当事人（决定能否评论 / 投票）
    const isParty = !!me && (me.id === c.buyer_id || me.id === c.seller_id || me.id === c.arbitrator_id)
    res.json({ case: safeCase, comments, my_vote: myVote, is_party: isParty })
  })

  // 写评论 — 当事人禁评，一人一案一次
  app.post('/api/disputes/cases/:case_id/comment', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const gate = await meetsPublicSpeechThreshold(user as Record<string, unknown>)
    if (!gate.ok) return void res.status(403).json({ error: gate.reason, error_code: 'SPEECH_THRESHOLD' })
    const c = await dbOne<{ id: string; buyer_id: string; seller_id: string; arbitrator_id: string }>(`SELECT id, buyer_id, seller_id, arbitrator_id FROM dispute_cases WHERE id = ?`, [req.params.case_id])
    if (!c) return void res.status(404).json({ error: '判例不存在' })
    if (user.id === c.buyer_id || user.id === c.seller_id || user.id === c.arbitrator_id) {
      return void res.status(403).json({ error: '当事人禁止评论', error_code: 'PARTY_NO_COMMENT' })
    }
    const rawBody = String(req.body?.body || '').trim()
    if (rawBody.length < 5) return void res.status(400).json({ error: '评论至少 5 字' })
    if (rawBody.length > 500) return void res.status(400).json({ error: '评论最多 500 字' })
    // P2 评论审核：blocklist → PII 脱敏 → LLM 兜底
    const blocked = commentBlocklistHit(rawBody)
    if (blocked) return void res.status(400).json({ error: blocked, error_code: 'COMMENT_BLOCKED' })
    const body = piiSanitize(rawBody)
    const llm = await llmModerateComment(body)
    if (!llm.ok) return void res.status(400).json({ error: llm.reason || '内容不符合社区规范', error_code: 'COMMENT_MODERATED' })
    const anonymous = req.body?.anonymous ? 1 : 0
    // 注：仲裁评论的 flagged 列保留给管理员"隐藏"语义；fraud detect 仅写 flag_reasons
    // 前端按 flag_reasons.length > 0 显示反诈 banner，按 flagged=1 隐藏
    // detectFraud 用 rawBody — piiSanitize 已脱敏的 body 会让电话/银行卡 regex miss
    const reasons = detectFraud(rawBody)
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO dispute_comments (id, case_id, commenter_id, body, anonymous, flag_reasons) VALUES (?,?,?,?,?,?)`)
          .run(generateId('dcom'), c.id, user.id, body, anonymous,
            reasons.length ? JSON.stringify(reasons) : null)
        db.prepare(`UPDATE dispute_cases SET comment_count = comment_count + 1 WHERE id = ?`).run(c.id)
      })()
    } catch (e) {
      if ((e as Error).message?.includes('UNIQUE')) return void res.status(400).json({ error: '你已评论过此判例（一案一次）' })
      throw e
    }
    res.json({ success: true, flag_reasons: reasons })
  })

  // W5 子回复 — 任意人可对顶层评论回复多次（不受"一人一案一次"限制）
  app.post('/api/disputes/cases/:case_id/comments/:comment_id/reply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const gate = await meetsPublicSpeechThreshold(user as Record<string, unknown>)
    if (!gate.ok) return void res.status(403).json({ error: gate.reason, error_code: 'SPEECH_THRESHOLD' })
    const c = await dbOne<{ id: string; buyer_id: string; seller_id: string; arbitrator_id: string }>(`SELECT id, buyer_id, seller_id, arbitrator_id FROM dispute_cases WHERE id = ?`, [req.params.case_id])
    if (!c) return void res.status(404).json({ error: '判例不存在' })
    if (user.id === c.buyer_id || user.id === c.seller_id || user.id === c.arbitrator_id) {
      return void res.status(403).json({ error: '当事人禁止评论', error_code: 'PARTY_NO_COMMENT' })
    }
    const parent = await dbOne<{ id: string }>(`SELECT id FROM dispute_comments WHERE id = ? AND case_id = ?`, [req.params.comment_id, c.id])
    if (!parent) return void res.status(404).json({ error: '父评论不存在' })
    const rawBody = String(req.body?.body || '').trim()
    if (rawBody.length < 2) return void res.status(400).json({ error: '回复至少 2 字' })
    if (rawBody.length > 300) return void res.status(400).json({ error: '回复最多 300 字' })
    const blocked = commentBlocklistHit(rawBody)
    if (blocked) return void res.status(400).json({ error: blocked, error_code: 'COMMENT_BLOCKED' })
    const body = piiSanitize(rawBody)
    const llm = await llmModerateComment(body)
    if (!llm.ok) return void res.status(400).json({ error: llm.reason || '内容不符合社区规范', error_code: 'COMMENT_MODERATED' })
    const anonymous = req.body?.anonymous ? 1 : 0
    // 同上：flagged 给管理员，flag_reasons 给反诈；用 rawBody
    const repReasons = detectFraud(rawBody)
    const rid = generateId('drep')
    db.transaction(() => {
      db.prepare(`INSERT INTO dispute_comment_replies (id, parent_comment_id, case_id, replier_id, body, anonymous, flag_reasons) VALUES (?,?,?,?,?,?,?)`)
        .run(rid, parent.id, c.id, user.id, body, anonymous,
          repReasons.length ? JSON.stringify(repReasons) : null)
      db.prepare(`UPDATE dispute_cases SET comment_count = comment_count + 1 WHERE id = ?`).run(c.id)
    })()
    res.json({ success: true, id: rid, flag_reasons: repReasons })
  })

  // 公正度投票（👍 / 👎）— 一人一案一票
  app.post('/api/disputes/cases/:case_id/fairness', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const gate = await meetsPublicSpeechThreshold(user as Record<string, unknown>)
    if (!gate.ok) return void res.status(403).json({ error: gate.reason, error_code: 'SPEECH_THRESHOLD' })
    const vote = req.body?.vote
    if (vote !== 'yes' && vote !== 'no') return void res.status(400).json({ error: 'vote 必须是 yes 或 no' })
    const c = await dbOne<{ id: string; buyer_id: string; seller_id: string; arbitrator_id: string }>(`SELECT id, buyer_id, seller_id, arbitrator_id FROM dispute_cases WHERE id = ?`, [req.params.case_id])
    if (!c) return void res.status(404).json({ error: '判例不存在' })
    if (user.id === c.buyer_id || user.id === c.seller_id || user.id === c.arbitrator_id) {
      return void res.status(403).json({ error: '当事人禁止投票' })
    }
    db.transaction(() => {
      // 若已投过，先回滚旧票计数再插新票
      const old = db.prepare('SELECT vote FROM dispute_fairness_votes WHERE case_id = ? AND voter_id = ?').get(c.id, user.id) as { vote: string } | undefined
      if (old) {
        if (old.vote === vote) return  // 重复投同一票 no-op
        const dec = old.vote === 'yes' ? 'fairness_yes' : 'fairness_no'
        db.prepare(`UPDATE dispute_cases SET ${dec} = MAX(0, ${dec} - 1) WHERE id = ?`).run(c.id)
        db.prepare("UPDATE dispute_fairness_votes SET vote = ?, created_at = datetime('now') WHERE case_id = ? AND voter_id = ?").run(vote, c.id, user.id)
      } else {
        db.prepare('INSERT INTO dispute_fairness_votes (case_id, voter_id, vote) VALUES (?,?,?)').run(c.id, user.id, vote)
      }
      const inc = vote === 'yes' ? 'fairness_yes' : 'fairness_no'
      db.prepare(`UPDATE dispute_cases SET ${inc} = ${inc} + 1 WHERE id = ?`).run(c.id)
    })()
    res.json({ success: true, vote })
  })
}
