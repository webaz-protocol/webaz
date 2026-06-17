/**
 * Reviews 公开 feed + 评测声明（claim）
 *
 * 由 #1013 Phase 73 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET  /api/reviews/recent              B-5 全局创作者评测 feed（公开 + product 元数据 JOIN）
 *   POST /api/reviews/:type/:id/claim     发起声明（shareable / manifest）— 锁 5 WAZ
 *   GET  /api/reviews/:type/:id/claims    某 review 的声明列表（公开）
 *
 * 受信角色不可发起声明；不可对自己评测发起；同 (review, claimant, target) 不能重复 open
 *
 * 跨域注入：auth + isTrustedRole + errorRes + generateId + REVIEW_CLAIM_*
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ReviewsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  generateId: (prefix: string) => string
  REVIEW_CLAIM_TARGETS: Set<string>
  REVIEW_CLAIM_STAKE: number
  REVIEW_CLAIM_DEADLINE_HOURS: number
  REVIEW_VERIFIERS_NEEDED: number
}

export function registerReviewsRoutes(app: Application, deps: ReviewsDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam(dbOne/dbAll/dbRun)。
  // db 保留:claim 是质押/escrow 资金路径(dup 门 + 钱包扣减 + INSERT 任务必须原子),
  // 用 db.transaction 同步事务守恒;Phase 3 随资金路径迁 pg(BEGIN + SELECT...FOR UPDATE)。
  const { db, auth, isTrustedRole, errorRes, generateId,
          REVIEW_CLAIM_TARGETS, REVIEW_CLAIM_STAKE, REVIEW_CLAIM_DEADLINE_HOURS, REVIEW_VERIFIERS_NEEDED } = deps

  app.get('/api/reviews/recent', async (req, res) => {
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50))
    const items = await dbAll(`
      SELECT s.id, s.external_url, s.external_platform, s.thumbnail_url, s.title, s.click_count, s.like_count,
        s.created_at, s.related_product_id,
        u.handle as owner_handle, u.name as owner_name,
        p.title as product_title, p.price as product_price, p.images as product_images
      FROM shareables s
      JOIN users u ON u.id = s.owner_id
      LEFT JOIN products p ON p.id = s.related_product_id AND p.status = 'active'
      WHERE s.status = 'active'
      ORDER BY s.created_at DESC LIMIT ?
    `, [limit])
    res.json({ items })
  })

  app.post('/api/reviews/:type/:id/claim', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) {
      return void errorRes(res, 403, 'TRUSTED_ROLE_NO_CLAIM', '受信角色不可发起声明')
    }
    const reviewType = req.params.type
    if (!['shareable', 'manifest'].includes(reviewType)) return void res.status(400).json({ error: 'review type must be shareable / manifest' })
    let reviewerId: string | null = null
    let productId: string | null = null
    // #1017 fix: shareables / manifest_registry 实际列名是 related_product_id
    if (reviewType === 'shareable') {
      const row = await dbOne<{ owner_id: string; related_product_id: string | null }>('SELECT owner_id, related_product_id FROM shareables WHERE id = ?', [req.params.id])
      if (!row) return void res.status(404).json({ error: '评测不存在' })
      reviewerId = row.owner_id; productId = row.related_product_id
    } else {
      const row = await dbOne<{ owner_id: string; related_product_id: string | null }>('SELECT owner_id, related_product_id FROM manifest_registry WHERE hash = ?', [req.params.id])
      if (!row) return void res.status(404).json({ error: '原生评测不存在' })
      reviewerId = row.owner_id; productId = row.related_product_id
    }
    if (reviewerId === user.id) return void errorRes(res, 403, 'CANNOT_CLAIM_OWN', '不可对自己的评测发起声明')
    const target = String(req.body?.claim_target || '').trim()
    if (!REVIEW_CLAIM_TARGETS.has(target)) return void res.status(400).json({ error: `claim_target 须为 ${[...REVIEW_CLAIM_TARGETS].join(' / ')}` })
    const text = String(req.body?.claim_text || '').trim()
    if (text.length < 6 || text.length > 500) return void res.status(400).json({ error: 'claim_text 长度需 6-500 字' })
    const evidence = req.body?.evidence_uri ? String(req.body.evidence_uri).trim().slice(0, 500) : null

    // 友好预检查(读):余额不足直接早退;真正的守恒门在下面的事务内(WHERE balance >= stake)。
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || wallet.balance < REVIEW_CLAIM_STAKE) {
      return void res.status(400).json({ error: `余额不足：发起需锁 ${REVIEW_CLAIM_STAKE} WAZ` })
    }

    const id = generateId('rct')
    const deadline = new Date(Date.now() + REVIEW_CLAIM_DEADLINE_HOURS * 3600_000).toISOString()

    // 质押/escrow 原子段(同步事务):dup 门 + 钱包扣减(守恒 guard)+ INSERT 任务,
    // 任一失败整段回滚 → 不会出现"任务已建但钱没锁"或"双重 open 声明"或透支。
    try {
      db.transaction(() => {
        const dup = db.prepare(`SELECT id FROM review_claim_tasks WHERE review_type = ? AND review_id = ? AND claimant_id = ? AND claim_target = ? AND status = 'open'`)
          .get(reviewType, req.params.id, user.id, target)
        if (dup) throw new Error('CLAIM_DUP')
        // 守恒:仅当余额仍 >= stake 才扣(挡并发透支);changes=0 → 回滚
        const debit = db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ? AND balance >= ?')
          .run(REVIEW_CLAIM_STAKE, REVIEW_CLAIM_STAKE, user.id, REVIEW_CLAIM_STAKE)
        if (debit.changes === 0) throw new Error('CLAIM_INSUFFICIENT')
        db.prepare(`INSERT INTO review_claim_tasks (id, review_type, review_id, product_id, reviewer_id, claimant_id, claim_target, claim_text, evidence_uri, stake_claimant, deadline_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open')`)
          .run(id, reviewType, req.params.id, productId, reviewerId, user.id, target, text, evidence, REVIEW_CLAIM_STAKE, deadline)
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'CLAIM_DUP') return void res.status(409).json({ error: '你已对此评测同一项发起过 open 声明' })
      if (msg === 'CLAIM_INSUFFICIENT') return void res.status(400).json({ error: `余额不足：发起需锁 ${REVIEW_CLAIM_STAKE} WAZ` })
      console.error('[reviews claim tx]', msg)
      return void res.status(500).json({ error: '发起声明失败,请重试' })
    }
    res.json({ success: true, claim_id: id, deadline_at: deadline, stake_locked: REVIEW_CLAIM_STAKE })
  })

  app.get('/api/reviews/:type/:id/claims', async (req, res) => {
    const rows = await dbAll(`
      SELECT rct.id, rct.claim_target, rct.claim_text, rct.evidence_uri, rct.status, rct.ruling, rct.deadline_at, rct.resolved_at, rct.created_at,
             u.name as claimant_name,
             (SELECT COUNT(*) FROM review_claim_votes WHERE claim_id = rct.id) as votes_count
      FROM review_claim_tasks rct JOIN users u ON u.id = rct.claimant_id
      WHERE rct.review_type = ? AND rct.review_id = ?
      ORDER BY rct.created_at DESC LIMIT 50
    `, [req.params.type, req.params.id])
    res.json({ claims: rows, votes_needed: REVIEW_VERIFIERS_NEEDED })
  })
}
