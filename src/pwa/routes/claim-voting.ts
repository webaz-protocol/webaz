/**
 * Claim 投票 — 5 个声明垂类共享的 available + vote 端点
 *
 * 由 #1013 Phase 75 从 src/pwa/server.ts 抽出。
 *
 * 10 endpoints（5 垂类 × 2）：
 *   GET  /api/<vertical>-claims/available  verifier 可投的 open 列表
 *   POST /api/<vertical>-claims/:id/vote   投票（upheld/dismissed/insufficient）
 *
 * 5 verticals: product / review / secondhand / auction / wish
 *
 * 共享逻辑：
 *   - isEligibleClaimVerifier 守门
 *   - 当事人（claimant 和 party_id）不可投
 *   - dedup vote
 *   - 计票满 3（product 用专门常量）→ seal + settle
 *
 * 各垂类差异由 config 描述：
 *   - 表名 + alias
 *   - party_id 列名（seller_id / reviewer_id / wisher_id）
 *   - vote 主键前缀
 *   - settle 函数（product 用 settleProductClaim, 其余 settleGenericClaim）
 *   - available SQL 的 JOIN + SELECT 行（含商品/许愿/拍卖标题等）
 *
 * 跨域注入：auth + isEligibleClaimVerifier + generateId + settleProductClaim + settleGenericClaim
 *           + PRODUCT_CLAIM_VERIFIERS_NEEDED + REVIEW_VERIFIERS_NEEDED
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ClaimVotingDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isEligibleClaimVerifier: (userId: string) => { ok: boolean; reason?: string }
  generateId: (prefix: string) => string
  settleProductClaim: (claimId: string) => unknown
  settleGenericClaim: (taskTable: string, voteTable: string, claimId: string) => unknown
  PRODUCT_CLAIM_VERIFIERS_NEEDED: number
  REVIEW_VERIFIERS_NEEDED: number
}

interface ClaimConfig {
  vertical: string                        // 'product' | 'review' | ...
  taskTable: string
  voteTable: string
  taskAlias: string                       // 'pct' | 'rct' | ...
  partyIdCol: string                      // 'seller_id' | 'reviewer_id' | 'wisher_id'
  votePrefix: string                      // 'pcv' | 'rcv' | ...
  votesNeeded: number                     // 3 for all
  // available 端点的 JOIN + 额外 SELECT 列（拼到主 SQL 模板里）
  availableExtraSelect: string            // ', p.title as product_title'
  availableJoin: string                   // 'JOIN products p ON p.id = pct.product_id'
  availableBaseCols: string               // 'pct.id, pct.product_id, pct.claim_target, ...'
  // settle 选择：product 走 settleProductClaim(id)，其他走 settleGenericClaim(task, vote, id)
  useProductSettle: boolean
}

export function registerClaimVotingRoutes(app: Application, deps: ClaimVotingDeps): void {
  // 只读站点走 RFC-016 异步 seam;db 保留:vote 是"投票→封顶→结算"裁决资金路径,
  // dup 门 + INSERT vote + 计票 + seal-CAS 必须原子(db.transaction);settle(发还/没收质押)
  // 在 tx 提交后只对真正 seal 的那一票触发,防并发双封顶/双结算。Phase 3 迁 pg 行锁。
  const { db, auth, isEligibleClaimVerifier, generateId, settleProductClaim, settleGenericClaim,
          PRODUCT_CLAIM_VERIFIERS_NEEDED, REVIEW_VERIFIERS_NEEDED } = deps

  const wire = (cfg: ClaimConfig) => {
    const { vertical, taskTable, voteTable, taskAlias: a, partyIdCol, votePrefix, votesNeeded } = cfg

    // GET /api/<vertical>-claims/available
    app.get(`/api/${vertical}-claims/available`, async (req, res) => {
      const user = auth(req, res); if (!user) return
      const elig = isEligibleClaimVerifier(user.id as string)
      if (!elig.ok) return void res.status(403).json({ error: elig.reason, eligible: false })
      const sql = `
        SELECT ${cfg.availableBaseCols},
               (SELECT COUNT(*) FROM ${voteTable} WHERE claim_id = ${a}.id) as votes_count
               ${cfg.availableExtraSelect}
        FROM ${taskTable} ${a}
        ${cfg.availableJoin}
        WHERE ${a}.status = 'open'
          AND ${a}.claimant_id != ? AND ${a}.${partyIdCol} != ?
          AND NOT EXISTS (SELECT 1 FROM ${voteTable} WHERE claim_id = ${a}.id AND verifier_id = ?)
          AND (SELECT COUNT(*) FROM ${voteTable} WHERE claim_id = ${a}.id) < ${votesNeeded}
        ORDER BY ${a}.created_at ASC LIMIT 50
      `
      const rows = await dbAll(sql, [user.id, user.id, user.id])
      res.json({ items: rows, eligible: true })
    })

    // POST /api/<vertical>-claims/:id/vote
    app.post(`/api/${vertical}-claims/:id/vote`, async (req, res) => {
      const user = auth(req, res); if (!user) return
      const elig = isEligibleClaimVerifier(user.id as string)
      if (!elig.ok) return void res.status(403).json({ error: elig.reason })
      const claim = await dbOne<Record<string, unknown>>(`SELECT * FROM ${taskTable} WHERE id = ?`, [req.params.id])
      if (!claim) return void res.status(404).json({ error: '声明不存在' })
      if (claim.status !== 'open') return void res.status(400).json({ error: `状态 ${claim.status} 不接受投票` })
      if (claim.claimant_id === user.id || claim[partyIdCol] === user.id) {
        return void res.status(403).json({ error: vertical === 'product' ? (claim.claimant_id === user.id ? '发起人不可对自己的声明投票' : '商品卖家不可对自己被诉声明投票') : '当事人不可投票' })
      }
      const vote = String(req.body?.vote || '').trim()
      if (!['upheld', 'dismissed', 'insufficient'].includes(vote)) {
        return void res.status(400).json({ error: `vote 须为 upheld / dismissed / insufficient` })
      }
      const evidence_uri = req.body?.evidence_uri ? String(req.body.evidence_uri).trim().slice(0, 500) : null
      const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null
      const voteId = generateId(votePrefix)

      // 裁决原子段:权威重检(状态/dup/票数)→ INSERT vote → 重计票 → 达标则 CAS 封顶。
      // 返回 { after, didSeal };didSeal 仅对真正把 open→sealed 翻过去的那一票为 true。
      let txOut: { after: number; didSeal: boolean }
      try {
        txOut = db.transaction(() => {
          const cur = db.prepare(`SELECT status FROM ${taskTable} WHERE id = ?`).get(req.params.id) as { status: string } | undefined
          if (!cur || cur.status !== 'open') throw new Error('VOTE_CLOSED')
          if (db.prepare(`SELECT id FROM ${voteTable} WHERE claim_id = ? AND verifier_id = ?`).get(req.params.id, user.id)) throw new Error('VOTE_DUP')
          const now = (db.prepare(`SELECT COUNT(*) as n FROM ${voteTable} WHERE claim_id = ?`).get(req.params.id) as { n: number }).n
          if (now >= votesNeeded) throw new Error('VOTE_FULL')
          db.prepare(`INSERT INTO ${voteTable} (id, claim_id, verifier_id, vote, evidence_uri, note) VALUES (?,?,?,?,?,?)`)
            .run(voteId, req.params.id, user.id, vote, evidence_uri, note)
          const after = (db.prepare(`SELECT COUNT(*) as n FROM ${voteTable} WHERE claim_id = ?`).get(req.params.id) as { n: number }).n
          let didSeal = false
          if (after >= votesNeeded) {
            const seal = db.prepare(`UPDATE ${taskTable} SET status = 'sealed' WHERE id = ? AND status = 'open'`).run(req.params.id)
            didSeal = seal.changes === 1
          }
          return { after, didSeal }
        })()
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'VOTE_CLOSED') return void res.status(400).json({ error: '该声明已结案,不接受投票' })
        if (msg === 'VOTE_DUP') return void res.status(409).json({ error: '已投过票' })
        if (msg === 'VOTE_FULL') return void res.status(409).json({ error: '已收齐共识票数' })
        console.error('[claim-voting tx]', msg)
        return void res.status(500).json({ error: '投票失败,请重试' })
      }

      // settle(发还/没收质押)在事务提交后只对真正 seal 的那一票触发(它自身另起事务)。
      let settlement: unknown = null
      if (txOut.didSeal) {
        settlement = cfg.useProductSettle ? settleProductClaim(req.params.id) : settleGenericClaim(taskTable, voteTable, req.params.id)
      }
      res.json({ success: true, votes_collected: txOut.after, sealed: txOut.didSeal, settlement })
    })
  }

  // 5 个垂类配置
  wire({
    vertical: 'product', taskTable: 'product_claim_tasks', voteTable: 'product_claim_votes',
    taskAlias: 'pct', partyIdCol: 'seller_id', votePrefix: 'pcv',
    votesNeeded: PRODUCT_CLAIM_VERIFIERS_NEEDED, useProductSettle: true,
    availableBaseCols: 'pct.id, pct.product_id, pct.claim_target, pct.claim_text, pct.evidence_uri, pct.deadline_at, pct.created_at',
    availableExtraSelect: ', p.title as product_title',
    availableJoin: 'JOIN products p ON p.id = pct.product_id',
  })

  wire({
    vertical: 'review', taskTable: 'review_claim_tasks', voteTable: 'review_claim_votes',
    taskAlias: 'rct', partyIdCol: 'reviewer_id', votePrefix: 'rcv',
    votesNeeded: REVIEW_VERIFIERS_NEEDED, useProductSettle: false,
    availableBaseCols: 'rct.id, rct.review_type, rct.review_id, rct.product_id, rct.claim_target, rct.claim_text, rct.evidence_uri, rct.deadline_at, rct.created_at',
    availableExtraSelect: '',
    availableJoin: '',
  })

  wire({
    vertical: 'secondhand', taskTable: 'secondhand_claim_tasks', voteTable: 'secondhand_claim_votes',
    taskAlias: 'sct', partyIdCol: 'seller_id', votePrefix: 'scv',
    votesNeeded: 3, useProductSettle: false,
    availableBaseCols: 'sct.id, sct.sh_item_id, sct.claim_target, sct.claim_text, sct.evidence_uri, sct.deadline_at, sct.created_at',
    availableExtraSelect: ', si.title as item_title',
    availableJoin: 'JOIN secondhand_items si ON si.id = sct.sh_item_id',
  })

  wire({
    vertical: 'auction', taskTable: 'auction_claim_tasks', voteTable: 'auction_claim_votes',
    taskAlias: 'act', partyIdCol: 'seller_id', votePrefix: 'acv',
    votesNeeded: 3, useProductSettle: false,
    availableBaseCols: 'act.id, act.auction_id, act.claim_target, act.claim_text, act.evidence_uri, act.deadline_at, act.created_at',
    availableExtraSelect: ', a.title as auction_title',
    availableJoin: 'JOIN auctions a ON a.id = act.auction_id',
  })

  wire({
    vertical: 'wish', taskTable: 'wish_claim_tasks', voteTable: 'wish_claim_votes',
    taskAlias: 'wct', partyIdCol: 'wisher_id', votePrefix: 'wcv',
    votesNeeded: 3, useProductSettle: false,
    availableBaseCols: 'wct.id, wct.wish_id, wct.claim_target, wct.claim_text, wct.evidence_uri, wct.deadline_at, wct.created_at',
    availableExtraSelect: ', w.title as wish_title',
    availableJoin: 'JOIN wishes w ON w.id = wct.wish_id',
  })
}
