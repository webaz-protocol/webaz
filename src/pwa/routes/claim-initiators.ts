/**
 * Claim 发起 + 列表 — 3 个声明垂类的 POST claim + GET claims
 *
 * 由 #1013 Phase 76 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints（3 垂类 × 2）：
 *   POST /api/secondhand/:id/claim     发起声明（锁 5 WAZ）
 *   GET  /api/secondhand/:id/claims    列表
 *   POST /api/auctions/:id/claim
 *   GET  /api/auctions/:id/claims
 *   POST /api/wishes/:id/claim
 *   GET  /api/wishes/:id/claims
 *
 * （/api/products/:id/claim + /api/reviews/:type/:id/claim 在 product/reviews 模块单独）
 *
 * 共享逻辑：
 *   - 受信角色不可发起声明
 *   - 不可对自己挂的目标发起
 *   - 状态白名单（available / open / open|claimed）
 *   - claim_target 在 TARGETS 集合内
 *   - claim_text 长度 6–500
 *   - 钱包余额 ≥ STAKE
 *   - 同 (entity, claimant, target, status='open') 不可重复
 *   - INSERT task + UPDATE wallet（扣 balance, 加 escrowed）
 *
 * 跨域注入：auth + isTrustedRole + errorRes + generateId
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ClaimInitiatorsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  generateId: (prefix: string) => string
}

interface InitiatorConfig {
  entityPath: string                   // 'secondhand' (used in URL /api/<entityPath>/:id/claim)
  entityTable: string                  // 'secondhand_items' | 'auctions' | 'wishes'
  entityIdCol: string                  // FK column in task table referring to entity ('sh_item_id' etc)
  entityPartyCol: string               // entity table's owner col ('seller_id' | 'user_id')
  taskTable: string
  taskPartyCol: string                 // task table's owner col, often same as entityPartyCol but wish uses wisher_id
  voteTable: string
  voteCountedFromVotesTable: string    // alias for vote count SELECT (same as voteTable)
  targets: Set<string>
  stake: number
  deadlineHours: number
  idPrefix: string
  allowedStatuses: string[]            // entity statuses allowed to claim
  notFoundMsg: string                  // '二手物品不存在' etc
  ownClaimMsg: string                  // '不可对自己挂售的物品发起声明' etc
  statusErrMsg: string                 // '仅在售物品可发起声明' etc
  dupErrMsg: string                    // '你已对此物品同一项发起过 open 声明'
  taskAlias: string                    // 'sct' | 'act' | 'wct'
}

export function registerClaimInitiatorsRoutes(app: Application, deps: ClaimInitiatorsDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam;db 保留:claim 是质押/escrow 资金路径,
  // dup 门 + 钱包扣减 + INSERT 任务必须原子(db.transaction),Phase 3 迁 pg 行锁。
  const { db, auth, isTrustedRole, errorRes, generateId } = deps

  const wire = (cfg: InitiatorConfig) => {
    const { entityPath, entityTable, entityIdCol, entityPartyCol, taskTable, taskPartyCol,
            voteTable, targets, stake, deadlineHours, idPrefix, allowedStatuses,
            notFoundMsg, ownClaimMsg, statusErrMsg, dupErrMsg, taskAlias: a } = cfg

    app.post(`/api/${entityPath}/:id/claim`, async (req, res) => {
      const user = auth(req, res); if (!user) return
      if (isTrustedRole(user as Record<string, unknown>)) {
        return void errorRes(res, 403, 'TRUSTED_ROLE_NO_CLAIM', '受信角色不可发起声明')
      }
      const entity = await dbOne<{ id: string; status: string; [k: string]: unknown }>(`SELECT id, ${entityPartyCol}, status FROM ${entityTable} WHERE id = ?`,
        [req.params.id])
      if (!entity) return void res.status(404).json({ error: notFoundMsg })
      const partyId = entity[entityPartyCol] as string
      if (partyId === user.id) return void errorRes(res, 403, 'CANNOT_CLAIM_OWN', ownClaimMsg)
      if (!allowedStatuses.includes(entity.status)) return void res.status(400).json({ error: statusErrMsg })

      const target = String(req.body?.claim_target || '').trim()
      if (!targets.has(target)) return void res.status(400).json({ error: `claim_target 须为 ${[...targets].join(' / ')}` })
      const text = String(req.body?.claim_text || '').trim()
      if (text.length < 6 || text.length > 500) return void res.status(400).json({ error: 'claim_text 长度需 6-500 字' })
      const evidence = req.body?.evidence_uri ? String(req.body.evidence_uri).trim().slice(0, 500) : null

      // 友好预检查(读):余额不足直接早退;真正的守恒门在事务内(WHERE balance >= stake)。
      const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
      if (!wallet || wallet.balance < stake) return void res.status(400).json({ error: `余额不足：发起需锁 ${stake} WAZ` })

      const id = generateId(idPrefix)
      const deadline = new Date(Date.now() + deadlineHours * 3600_000).toISOString()

      // 质押/escrow 原子段(同步事务):dup 门 + 钱包扣减(守恒 guard)+ INSERT 任务,
      // 任一失败整段回滚 → 不会出现"任务已建但钱没锁"或"双重 open 声明"或透支。
      try {
        db.transaction(() => {
          const dup = db.prepare(`SELECT id FROM ${taskTable} WHERE ${entityIdCol} = ? AND claimant_id = ? AND claim_target = ? AND status = 'open'`)
            .get(req.params.id, user.id, target)
          if (dup) throw new Error('CLAIM_DUP')
          const debit = db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ? AND balance >= ?')
            .run(stake, stake, user.id, stake)
          if (debit.changes === 0) throw new Error('CLAIM_INSUFFICIENT')
          db.prepare(`INSERT INTO ${taskTable} (id, ${entityIdCol}, ${taskPartyCol}, claimant_id, claim_target, claim_text, evidence_uri, stake_claimant, deadline_at, status) VALUES (?,?,?,?,?,?,?,?,?,'open')`)
            .run(id, req.params.id, partyId, user.id, target, text, evidence, stake, deadline)
        })()
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'CLAIM_DUP') return void res.status(409).json({ error: dupErrMsg })
        if (msg === 'CLAIM_INSUFFICIENT') return void res.status(400).json({ error: `余额不足：发起需锁 ${stake} WAZ` })
        console.error('[claim-initiators tx]', msg)
        return void res.status(500).json({ error: '发起声明失败,请重试' })
      }
      res.json({ success: true, claim_id: id, deadline_at: deadline, stake_locked: stake })
    })

    app.get(`/api/${entityPath}/:id/claims`, async (req, res) => {
      const sql = `
        SELECT ${a}.id, ${a}.claim_target, ${a}.claim_text, ${a}.evidence_uri, ${a}.status, ${a}.ruling, ${a}.deadline_at, ${a}.resolved_at, ${a}.created_at,
               u.name as claimant_name,
               (SELECT COUNT(*) FROM ${voteTable} WHERE claim_id = ${a}.id) as votes_count
        FROM ${taskTable} ${a} JOIN users u ON u.id = ${a}.claimant_id
        WHERE ${a}.${entityIdCol} = ? ORDER BY ${a}.created_at DESC LIMIT 50
      `
      const rows = await dbAll(sql, [req.params.id])
      res.json({ claims: rows, votes_needed: 3 })
    })
  }

  wire({
    entityPath: 'secondhand', entityTable: 'secondhand_items', entityIdCol: 'sh_item_id',
    entityPartyCol: 'seller_id', taskTable: 'secondhand_claim_tasks', taskPartyCol: 'seller_id',
    voteTable: 'secondhand_claim_votes', voteCountedFromVotesTable: 'secondhand_claim_votes',
    targets: new Set(['condition','images','description','title','price','other']),
    stake: 5, deadlineHours: 72, idPrefix: 'sct',
    allowedStatuses: ['available'],
    notFoundMsg: '二手物品不存在', ownClaimMsg: '不可对自己挂售的物品发起声明',
    statusErrMsg: '仅在售物品可发起声明', dupErrMsg: '你已对此物品同一项发起过 open 声明',
    taskAlias: 'sct',
  })

  wire({
    entityPath: 'auctions', entityTable: 'auctions', entityIdCol: 'auction_id',
    entityPartyCol: 'seller_id', taskTable: 'auction_claim_tasks', taskPartyCol: 'seller_id',
    voteTable: 'auction_claim_votes', voteCountedFromVotesTable: 'auction_claim_votes',
    targets: new Set(['unreasonable_reserve','shill_bidding','collusion','fake_listing','other']),
    stake: 5, deadlineHours: 72, idPrefix: 'act',
    allowedStatuses: ['open'],
    notFoundMsg: '拍卖不存在', ownClaimMsg: '不可对自己发起的拍卖发起声明',
    statusErrMsg: '仅进行中的拍卖可发起声明', dupErrMsg: '你已对此拍卖同一项发起过 open 声明',
    taskAlias: 'act',
  })

  wire({
    entityPath: 'wishes', entityTable: 'wishes', entityIdCol: 'wish_id',
    entityPartyCol: 'user_id', taskTable: 'wish_claim_tasks', taskPartyCol: 'wisher_id',
    voteTable: 'wish_claim_votes', voteCountedFromVotesTable: 'wish_claim_votes',
    targets: new Set(['fake_identity','fake_story','already_fulfilled','duplicate','inappropriate','other']),
    stake: 5, deadlineHours: 72, idPrefix: 'wct',
    allowedStatuses: ['open', 'claimed'],
    notFoundMsg: '许愿不存在', ownClaimMsg: '不可对自己发起的许愿发起声明',
    statusErrMsg: '仅 open / claimed 状态的许愿可发起声明', dupErrMsg: '你已对此许愿同一项发起过 open 声明',
    taskAlias: 'wct',
  })
}
