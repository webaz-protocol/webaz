/**
 * Products 声明端点（独立于 claim-initiators 因 product 是第 5 个垂类，stake 常量也不同）
 *
 * 由 #1013 Phase 88 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/products/:id/claim     发起商品声明（锁 PRODUCT_CLAIM_STAKE_DEFAULT WAZ）
 *   GET  /api/products/:id/claims    某商品的全部声明（公开）
 *
 * 与 Phase 76 claim-initiators 区别：
 *   - product 走 product_claim_tasks 表（而非 5 垂类的统一表）
 *   - PRODUCT_CLAIM_STAKE_DEFAULT 单独配置
 *   - PRODUCT_CLAIM_VERIFIERS_NEEDED 单独配置
 *
 * 跨域注入：auth + isTrustedRole + errorRes + generateId + 3 个 PRODUCT_CLAIM 常量
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProductsClaimsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  generateId: (prefix: string) => string
  PRODUCT_CLAIM_TARGETS: Set<string>
  PRODUCT_CLAIM_STAKE_DEFAULT: number
  PRODUCT_CLAIM_DEADLINE_HOURS: number
  PRODUCT_CLAIM_VERIFIERS_NEEDED: number
}

export function registerProductsClaimsRoutes(app: Application, deps: ProductsClaimsDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam;db 保留:claim 是质押/escrow 资金路径,
  // dup 门 + 钱包扣减 + INSERT 任务必须原子(db.transaction),Phase 3 迁 pg 行锁。
  const { db, auth, isTrustedRole, errorRes, generateId,
          PRODUCT_CLAIM_TARGETS, PRODUCT_CLAIM_STAKE_DEFAULT, PRODUCT_CLAIM_DEADLINE_HOURS, PRODUCT_CLAIM_VERIFIERS_NEEDED } = deps

  app.post('/api/products/:id/claim', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // 受信角色不可参与（管理员中立）
    if (isTrustedRole(user as Record<string, unknown>)) {
      return void errorRes(res, 403, 'TRUSTED_ROLE_NO_CLAIM', '受信角色不可发起商品声明')
    }
    const product = await dbOne<Record<string, unknown>>('SELECT * FROM products WHERE id = ?', [req.params.id])
    if (!product) return void res.status(404).json({ error: '商品不存在' })
    if (product.seller_id === user.id) return void errorRes(res, 403, 'CANNOT_CLAIM_OWN', '不可对自己的商品发起声明')
    if (product.status !== 'active') return void res.status(400).json({ error: '仅在售商品可发起声明' })

    const claim_target = String(req.body?.claim_target || '').trim()
    if (!PRODUCT_CLAIM_TARGETS.has(claim_target)) {
      return void res.status(400).json({ error: `claim_target 须为 ${[...PRODUCT_CLAIM_TARGETS].join(' / ')}` })
    }
    const claim_text = String(req.body?.claim_text || '').trim()
    if (claim_text.length < 6 || claim_text.length > 500) {
      return void res.status(400).json({ error: 'claim_text 长度需 6-500 字' })
    }
    const evidence_uri = req.body?.evidence_uri ? String(req.body.evidence_uri).trim().slice(0, 500) : null

    // 友好预检查(读):真正的守恒门在事务内(WHERE balance >= stake)。
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    const stake = PRODUCT_CLAIM_STAKE_DEFAULT
    if (!wallet || wallet.balance < stake) {
      return void res.status(400).json({ error: `余额不足：发起需锁 ${stake} WAZ，当前 ${wallet?.balance ?? 0} WAZ` })
    }

    const id = generateId('pct')
    const deadline = new Date(Date.now() + PRODUCT_CLAIM_DEADLINE_HOURS * 3600_000).toISOString()

    // 质押/escrow 原子段(同步事务):dup 门 + 钱包扣减(守恒 guard)+ INSERT 任务。
    try {
      db.transaction(() => {
        const dup = db.prepare(`SELECT id FROM product_claim_tasks WHERE product_id = ? AND claimant_id = ? AND claim_target = ? AND status = 'open'`)
          .get(req.params.id, user.id, claim_target)
        if (dup) throw new Error('CLAIM_DUP')
        const debit = db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ? AND balance >= ?')
          .run(stake, stake, user.id, stake)
        if (debit.changes === 0) throw new Error('CLAIM_INSUFFICIENT')
        db.prepare(`INSERT INTO product_claim_tasks
          (id, product_id, claimant_id, seller_id, claim_target, claim_text, evidence_uri, stake_claimant, deadline_at, status)
          VALUES (?,?,?,?,?,?,?,?,?,'open')`)
          .run(id, req.params.id, user.id, product.seller_id, claim_target, claim_text, evidence_uri, stake, deadline)
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'CLAIM_DUP') return void res.status(409).json({ error: '你已对此商品的同一项发起过 open 声明' })
      if (msg === 'CLAIM_INSUFFICIENT') return void res.status(400).json({ error: `余额不足：发起需锁 ${stake} WAZ` })
      console.error('[products-claims tx]', msg)
      return void res.status(500).json({ error: '发起声明失败,请重试' })
    }
    res.json({ success: true, claim_id: id, deadline_at: deadline, stake_locked: stake })
  })

  // 公开：列出某商品的全部声明（含已结算）
  app.get('/api/products/:id/claims', async (req, res) => {
    const rows = await dbAll(`
      SELECT pct.id, pct.claim_target, pct.claim_text, pct.evidence_uri, pct.status, pct.ruling, pct.deadline_at, pct.resolved_at, pct.created_at,
             u.name as claimant_name,
             (SELECT COUNT(*) FROM product_claim_votes WHERE claim_id = pct.id) as votes_count
      FROM product_claim_tasks pct
      JOIN users u ON u.id = pct.claimant_id
      WHERE pct.product_id = ?
      ORDER BY pct.created_at DESC LIMIT 50
    `, [req.params.id])
    res.json({ claims: rows, votes_needed: PRODUCT_CLAIM_VERIFIERS_NEEDED })
  })
}
