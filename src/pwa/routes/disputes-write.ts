/**
 * Disputes 写端点 — 被诉响应 + 仲裁裁定 + 证据提交（含 blob）+ 仲裁员请证据
 *
 * 由 #1013 Phase 87 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST /api/disputes/:id/respond            被诉方反驳 + 自动反诈
 *   POST /api/disputes/:id/arbitrate          234 行仲裁裁定（含 4 种 ruling + 资金链 + reputation + agent strike + dispute_cases 发布）
 *   POST /api/disputes/:id/add-evidence       参与方主动举证（text）+ SNF 信封分发
 *   POST /api/disputes/:id/evidence-blob      blob 上传（HMAC 签 + dedup）+ SNF + lightAuthGuard 守门
 *   POST /api/disputes/:id/request-evidence   仲裁员请某方补证
 *
 * arbitrate 关键链：
 *   1. requireHumanPresence (P0 铁律)
 *   2. assigned_arbitrators 原子领取（防任意仲裁员裁决任意争议）
 *   3. appendOrderEvent 'arbitration_ruling' → order_events 签名链
 *   4. arbitrateDispute (engine 层资金结算)
 *   5. markEvidenceExpiry (90 天清理戳)
 *   6. release_seller / partial_refund / liability_split → 触发 commission + PV + 基金池
 *      （seller 余额不足 → audit log + 静默跳过防 ghost write）
 *   7. recordDisputeReputation + product.dispute_loss_count
 *   8. issueAgentStrike (败诉方 api_key)
 *   9. publishDisputeCase (脱敏后入公开判例库)
 *
 * 跨域注入：auth + generateId + isEligibleArbitrator + requireHumanPresence + errorRes
 *           + getDisputeDetails + respondToDispute + arbitrateDispute + addPartyEvidence + requestEvidence
 *           + markEvidenceExpiry + uploadEvidence + EVIDENCE_MAX_BYTES + EVIDENCE_ALLOWED_MIME
 *           + appendOrderEvent + FUND_BASE_RATE + settleCommission + depositToFund + calculatePv
 *           + recordDisputeReputation + issueAgentStrike + publishDisputeCase + logAdminAction + snfSend
 *           + detectFraud + lightAuthGuard + express.raw (传 express 实例)
 */
import type { Application, Request, Response, NextFunction } from 'express'
import express from 'express'
import type Database from 'better-sqlite3'
// RFC-007 stage 5：客观拒单仲裁翻案直接复用 L0 状态机/结算(纯 db 函数,无副作用)
import { transition, settleFault, settleDeclinedNoFault } from '../../layer0-foundation/L0-2-state-machine/engine.js'
// RFC-014 PR5 — 争议后佣金/基金 clawback 走整数 base-units + 绝对值落库。
import { toUnits, toDecimal, mulRate } from '../../money.js'
import { applyWalletDelta } from '../../ledger.js'
// RFC-016 Phase 1 — 纯只读端点/校验读/SNF 分发读/标记写 → async seam;arbitrate 仲裁核心(原子领取 +
//   2 settlement db.transaction + reputation/strike/publish)与 tx 内 appendAuditLog 保持同步(Phase 3 迁 pg)。
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export interface DisputesWriteDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  detectFraud: (text: string) => string[]
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  isEligibleArbitrator: (userId: string) => { ok: boolean; reason?: string }
  requireHumanPresence: (userId: string, purpose: 'arbitrate' | 'vote' | 'agent_revoke', token: string | undefined, paramKey: string, validate?: (data: unknown) => boolean) => { ok: boolean; reason?: string; error_code?: string }
  getDisputeDetails: any
  respondToDispute: any
  arbitrateDispute: any
  addPartyEvidence: any
  requestEvidence: any
  markEvidenceExpiry: (db: Database.Database, disputeId: string) => void
  uploadEvidence: any
  EVIDENCE_MAX_BYTES: number
  EVIDENCE_ALLOWED_MIME: Set<string>
  appendOrderEvent: any
  FUND_BASE_RATE: () => number
  settleCommission: (orderId: string, effectiveBase?: number) => { redirected: number; [k: string]: unknown }
  depositToFund: (orderId: string, extra?: number, effectiveBase?: number) => unknown
  calculatePv: (amount: number, multiplier?: number) => number
  recordDisputeReputation: (db: Database.Database, orderId: string, winnerId: string, loserId: string) => void
  issueAgentStrike: (opts: { apiKey: string; userId: string; reasonCode: string; reasonDetail: string; relatedRef?: string }) => void
  publishDisputeCase: (disputeId: string, ruling: string, reason: string) => void
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  snfSend: any
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerDisputesWriteRoutes(app: Application, deps: DisputesWriteDeps): void {
  const { db, auth, generateId, detectFraud, errorRes, isEligibleArbitrator, requireHumanPresence,
          getDisputeDetails, respondToDispute, arbitrateDispute, addPartyEvidence, requestEvidence,
          markEvidenceExpiry, uploadEvidence, EVIDENCE_MAX_BYTES, EVIDENCE_ALLOWED_MIME,
          appendOrderEvent, FUND_BASE_RATE, settleCommission, depositToFund, calculatePv,
          recordDisputeReputation, issueAgentStrike, publishDisputeCase, logAdminAction, snfSend,
          getProtocolParam } = deps

  // ── RFC-007 stage 5：客观拒单【临时判责】的仲裁翻案 ─────────────────────────────
  //   卖家 contest_decline 后,订单 = fault_seller + decline_objective_pending=1 + decline_contested=1(未结算)。
  //   仲裁员(真实人工 + WebAuthn)裁决:uphold → declined_nofault(免责全退+退质押);reject → 违约结算。
  const SYS = 'sys_protocol'

  // 仲裁员待办:列出所有被举证的临时判责拒单
  app.get('/api/admin/decline-contests', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleArbitrator(user.id as string)
    if (!elig.ok) return void errorRes(res, 403, 'NOT_ARBITRATOR', elig.reason || '仅限仲裁员')
    const rows = await dbAll(`
      SELECT id AS order_id, buyer_id, seller_id, product_id, total_amount, decline_reason_code, declined_at, decline_contest_deadline
      FROM orders
      WHERE status = 'fault_seller' AND COALESCE(decline_objective_pending,0)=1 AND COALESCE(decline_contested,0)=1 AND settled_fault_at IS NULL
      ORDER BY declined_at ASC
    `)
    res.json({ contests: rows })
  })

  // 仲裁员裁决
  app.post('/api/admin/decline-contests/:orderId/resolve', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleArbitrator(user.id as string)
    if (!elig.ok) return void errorRes(res, 403, 'NOT_ARBITRATOR', elig.reason || '仅限仲裁员')
    // 铁律:仲裁需真实人工 WebAuthn
    const hp = requireHumanPresence(user.id as string, 'arbitrate', req.body?.webauthn_token, 'require_human_presence_for_arbitrate')
    if (!hp.ok) return void errorRes(res, 412, hp.error_code || 'HUMAN_PRESENCE_REQUIRED', hp.reason || '此操作需真实人工 WebAuthn 验证')

    const { decision, reason } = req.body ?? {}
    if (!['uphold', 'reject'].includes(decision)) return void errorRes(res, 400, 'BAD_DECISION', "decision 必须为 'uphold'(认定无责) 或 'reject'(驳回,判违约)")
    if (!reason || !String(reason).trim()) return void errorRes(res, 400, 'REASON_REQUIRED', '请提供裁决理由')

    const order = await dbOne<Record<string, unknown>>('SELECT * FROM orders WHERE id = ?', [req.params.orderId])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.status !== 'fault_seller' || Number(order.decline_objective_pending) !== 1 || Number(order.decline_contested) !== 1 || order.settled_fault_at) {
      return void errorRes(res, 400, 'NOT_CONTESTED_PROVISIONAL', '本订单不是【已举证·待裁决】的临时判责拒单')
    }

    try {
      appendOrderEvent(db, { orderId: req.params.orderId, eventType: 'transition', fromStatus: 'fault_seller', toStatus: 'fault_seller', actorId: user.id as string, actorRole: 'arbitrator', extra: { action: 'decline_contest_ruling', decision, reason } })
    } catch (e) { console.warn('[order-chain] decline ruling event:', (e as Error).message) }

    if (decision === 'uphold') {
      // 认定客观无责 → declined_nofault：全退买家 + 退卖家质押,零罚没
      const r1 = transition(db, req.params.orderId, 'declined_nofault', user.id as string, [], `客观拒单仲裁维持(无责)：${reason}`)
      if (!r1.success) return void res.json({ error: r1.error })
      settleDeclinedNoFault(db, req.params.orderId)
      transition(db, req.params.orderId, 'completed', SYS, [], '无责拒单结算完成')
      logAdminAction(user.id as string, 'decline_contest_uphold', 'order', req.params.orderId, { reason })
      return void res.json({ success: true, outcome: 'declined_nofault', note: '裁决:客观无责。买家已全额退款,卖家质押已退回,无罚没。' })
    }
    // reject → 违约结算(终结临时判责)
    settleFault(db, req.params.orderId, 'fault_seller')
    transition(db, req.params.orderId, 'completed', SYS, [], `客观拒单仲裁驳回 → 违约结算：${reason}`)
    db.prepare('UPDATE orders SET decline_objective_pending = 0, decline_contested = 0 WHERE id = ?').run(req.params.orderId)
    logAdminAction(user.id as string, 'decline_contest_reject', 'order', req.params.orderId, { reason })
    res.json({ success: true, outcome: 'fault_seller', note: '裁决:驳回。按违约结算,买家已全额退款,卖家质押按规则罚没。' })
  })

  // 被诉方反驳
  app.post('/api/disputes/:id/respond', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { notes = '', evidence_description = '' } = req.body

    const dispute = await getDisputeDetails(db, req.params.id)
    if (!dispute) return void res.status(404).json({ error: '争议不存在' })
    if (dispute.defendant_id !== user.id) return void res.status(403).json({ error: '你不是本争议的被诉方' })

    const evidenceIds: string[] = []
    if (evidence_description) {
      const eid = generateId('evt')
      const evReasons = detectFraud(String(evidence_description))
      db.prepare(`INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash, flag_reasons)
        VALUES (?,?,?,'description',?,?,?)`).run(eid, dispute.order_id, user.id, evidence_description, `hash_${Date.now()}`,
          evReasons.length ? JSON.stringify(evReasons) : null)
      evidenceIds.push(eid)
    }

    const result = respondToDispute(db, req.params.id, user.id as string, notes || evidence_description, evidenceIds)
    if (!result.success) return void res.json({ error: result.error })
    res.json({ success: true, message: result.message })
  })

  // 仲裁员裁定
  app.post('/api/disputes/:id/arbitrate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleArbitrator(user.id as string)
    if (!elig.ok) return void errorRes(res, 403, 'NOT_ARBITRATOR', elig.reason || '仅限仲裁员')

    // 2026-05-23 Agent 治理铁律：仲裁需真实人工
    const hpCheck = requireHumanPresence(user.id as string, 'arbitrate', req.body?.webauthn_token, 'require_human_presence_for_arbitrate', (data) => {
      const d = data as Record<string, unknown> | null
      return d == null || d.dispute_id === req.params.id
    })
    if (!hpCheck.ok) return void errorRes(res, 412, hpCheck.error_code || 'HUMAN_PRESENCE_REQUIRED', hpCheck.reason || '此操作需真实人工 WebAuthn 验证')

    const { ruling, reason, refund_amount, liable_party_id, liability_parties } = req.body
    if (!ruling || !reason) return void res.json({ error: '请提供裁定结果（ruling）和理由（reason）' })
    const validRulings = ['refund_buyer', 'release_seller', 'partial_refund', 'liability_split']
    if (!validRulings.includes(ruling)) {
      return void res.json({ error: `ruling 必须是 ${validRulings.join(' / ')} 之一` })
    }
    if (ruling === 'liability_split') {
      if (!Array.isArray(liability_parties) || liability_parties.length === 0) {
        return void res.json({ error: '责任分配裁定需要提供 liability_parties 数组' })
      }
      for (const p of liability_parties as Array<{ user_id?: string; amount?: number }>) {
        if (!p.user_id || typeof p.amount !== 'number' || p.amount < 0) {
          return void res.json({ error: '每个责任方需提供 user_id 和非负 amount' })
        }
      }
    }

    const dispute = await getDisputeDetails(db, req.params.id)
    if (!dispute) return void res.status(404).json({ error: '争议不存在' })

    // P0: 防"任意仲裁员裁决任意争议"
    // 若 assigned_arbitrators 为空 → 首位调用者原子领取
    const arbRow = db.prepare(`SELECT assigned_arbitrators FROM disputes WHERE id = ?`).get(req.params.id) as { assigned_arbitrators: string | null } | undefined
    let assignedArbitrators: string[] = []
    try { assignedArbitrators = JSON.parse(arbRow?.assigned_arbitrators || '[]') } catch {}
    if (assignedArbitrators.length === 0) {
      const claimRes = db.prepare(`UPDATE disputes SET assigned_arbitrators = ? WHERE id = ? AND (assigned_arbitrators IS NULL OR assigned_arbitrators = '[]')`)
        .run(JSON.stringify([user.id]), req.params.id)
      if (claimRes.changes === 0) {
        const fresh = db.prepare(`SELECT assigned_arbitrators FROM disputes WHERE id = ?`).get(req.params.id) as { assigned_arbitrators: string | null } | undefined
        try { assignedArbitrators = JSON.parse(fresh?.assigned_arbitrators || '[]') } catch {}
      } else {
        assignedArbitrators = [user.id as string]
      }
    }
    if (!assignedArbitrators.includes(user.id as string)) {
      return void res.status(403).json({ error: '此争议未分配给你 — 仅指派的仲裁员可裁定', error_code: 'NOT_ASSIGNED_ARBITRATOR' })
    }

    // 协议层：仲裁员签名的 ruling 入订单链
    try {
      appendOrderEvent(db, {
        orderId: dispute.order_id as string,
        eventType: 'transition',
        fromStatus: 'disputed',
        toStatus: 'disputed',
        actorId: user.id as string,
        actorRole: 'arbitrator',
        extra: {
          action: 'arbitration_ruling',
          dispute_id: req.params.id,
          ruling, reason,
          refund_amount: refund_amount ? Number(refund_amount) : null,
          liable_party_id: liable_party_id || null,
          liability_parties: liability_parties || null,
        },
      })
    } catch (e) { console.warn('[order-chain] arbitration ruling event failed:', (e as Error).message) }

    const result = arbitrateDispute(
      db, req.params.id, user.id as string, ruling, reason,
      refund_amount ? Number(refund_amount) : undefined,
      liability_parties,
      liable_party_id
    )
    if (!result.success) return void res.json({ error: result.error })

    // 争议结案 → 给证据 blob 打过期戳
    try { markEvidenceExpiry(db, req.params.id) } catch (e) { console.warn('[evidence] mark expiry:', (e as Error).message) }

    // release_seller 等同正常完成 → 触发推土机分润 + 原子能
    if (ruling === 'release_seller') {
      try {
        db.transaction(() => {
          const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(dispute.order_id) as Record<string, unknown> | undefined
          if (!order || order.settled_commission_at) return
          const total = Number(order.total_amount)
          const commRate = Number(order.snapshot_commission_rate ?? 0)
          const deductU = mulRate(toUnits(total), commRate) + mulRate(toUnits(total), FUND_BASE_RATE())
          const deduct = toDecimal(deductU)
          const sellerWallet = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(order.seller_id) as { balance: number } | undefined
          if (sellerWallet && toUnits(sellerWallet.balance) >= deductU) {
            applyWalletDelta(db, order.seller_id as string, { balance: -deductU, earned: -deductU })
            const { redirected: disputeRedirected } = settleCommission(dispute.order_id)
            depositToFund(dispute.order_id, disputeRedirected)

            const productRow = db.prepare("SELECT category_id FROM products WHERE id = ?").get(order.product_id) as { category_id: string | null } | undefined
            const categoryId = productRow?.category_id || 'cat_default'
            const catRow = db.prepare("SELECT pv_multiplier FROM product_categories WHERE id = ?").get(categoryId) as { pv_multiplier: number } | undefined
            const mPv = Number(catRow?.pv_multiplier ?? 1.0)
            const pv = calculatePv(total, mPv)
            if (pv > 0) {
              db.prepare(`INSERT INTO pv_ledger (id, order_id, buyer_id, pv, processed) VALUES (?,?,?,?,0)`)
                .run(generateId('pvl'), dispute.order_id, order.buyer_id, pv)
              db.prepare("UPDATE users SET pv_dirty_at = datetime('now') WHERE id = ?").run(order.buyer_id)
            }
            db.prepare("UPDATE orders SET settled_pv_at = datetime('now') WHERE id = ?").run(dispute.order_id)
          } else {
            // P2 #6：seller 余额不足，commission/PV 被吞 — 记 audit
            console.warn(`[dispute hook · release_seller] commission/PV 被吞 order=${dispute.order_id} seller=${order.seller_id} balance=${sellerWallet?.balance ?? 'null'} required=${deduct}`)
            try {
              logAdminAction('system', 'commission_skipped', 'order', String(dispute.order_id), { reason: 'seller_balance_insufficient', ruling: 'release_seller', required: deduct, actual: sellerWallet?.balance ?? 0 })
            } catch {}
          }
        })()
      } catch (e) { console.error('[dispute commission/pv hook]', e) }
    }

    // Bug-A fix：partial_refund / liability_split 也按 effectiveBase 发 commission/PV/基金池
    if (ruling === 'partial_refund' || ruling === 'liability_split') {
      try {
        db.transaction(() => {
          const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(dispute.order_id) as Record<string, unknown> | undefined
          if (!order || order.settled_commission_at) return
          let effectiveBase = 0
          if (ruling === 'partial_refund' && liable_party_id) {
            effectiveBase = Number(order.total_amount)
          } else if (ruling === 'partial_refund') {
            effectiveBase = Number(result.settlement?.seller_received ?? 0)
          } else {
            effectiveBase = Number(result.settlement?.seller_escrow_share ?? 0)
          }
          if (effectiveBase <= 0) return
          const commRate = Number(order.snapshot_commission_rate ?? 0)
          const deductU = mulRate(toUnits(effectiveBase), commRate) + mulRate(toUnits(effectiveBase), FUND_BASE_RATE())
          const deduct = toDecimal(deductU)
          const sellerWallet = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(order.seller_id) as { balance: number } | undefined
          if (sellerWallet && toUnits(sellerWallet.balance) >= deductU) {
            if (deductU > 0) {
              applyWalletDelta(db, order.seller_id as string, { balance: -deductU, earned: -deductU })
            }
            const { redirected } = settleCommission(dispute.order_id, effectiveBase)
            depositToFund(dispute.order_id, redirected, effectiveBase)

            const productRow = db.prepare("SELECT category_id FROM products WHERE id = ?").get(order.product_id) as { category_id: string | null } | undefined
            const categoryId = productRow?.category_id || 'cat_default'
            const catRow = db.prepare("SELECT pv_multiplier FROM product_categories WHERE id = ?").get(categoryId) as { pv_multiplier: number } | undefined
            const mPv = Number(catRow?.pv_multiplier ?? 1.0)
            const pv = calculatePv(effectiveBase, mPv)
            if (pv > 0) {
              db.prepare(`INSERT INTO pv_ledger (id, order_id, buyer_id, pv, processed) VALUES (?,?,?,?,0)`)
                .run(generateId('pvl'), dispute.order_id, order.buyer_id, pv)
              db.prepare("UPDATE users SET pv_dirty_at = datetime('now') WHERE id = ?").run(order.buyer_id)
            }
            db.prepare("UPDATE orders SET settled_pv_at = datetime('now') WHERE id = ?").run(dispute.order_id)
          } else {
            // P2 #6：seller 余额不足，commission/PV 被吞
            console.warn(`[dispute hook · ${ruling}] commission/PV 被吞 order=${dispute.order_id} seller=${order.seller_id} balance=${sellerWallet?.balance ?? 'null'} required=${deduct} effectiveBase=${effectiveBase}`)
            try {
              logAdminAction('system', 'commission_skipped', 'order', String(dispute.order_id), { reason: 'seller_balance_insufficient', ruling, required: deduct, actual: sellerWallet?.balance ?? 0, effectiveBase })
            } catch {}
          }
        })()
      } catch (e) { console.error('[partial_refund/liability_split commission/pv hook]', e) }
    }

    // 争议声誉更新（责任分配时以主要责任方为败诉方）
    let winnerId: string | null = null
    let loserId: string | null = null
    if (ruling === 'refund_buyer') {
      winnerId = dispute.initiator_id; loserId = dispute.defendant_id
    } else if (ruling === 'release_seller') {
      winnerId = dispute.defendant_id; loserId = dispute.initiator_id
    } else if (ruling === 'liability_split' && Array.isArray(liability_parties) && liability_parties.length > 0) {
      const maxLiable = (liability_parties as Array<{ user_id: string; amount: number }>).reduce((a, b) => a.amount >= b.amount ? a : b)
      loserId = maxLiable.user_id
      winnerId = dispute.initiator_id !== loserId ? dispute.initiator_id : dispute.defendant_id
    }
    if (winnerId && loserId) recordDisputeReputation(db, dispute.order_id, winnerId, loserId)

    // Tier 7：商品级争议败诉计数（卖家败诉时 +1）
    try {
      const sellerLost = (
        ruling === 'refund_buyer' || ruling === 'partial_refund'
        || (ruling === 'liability_split' && loserId === dispute.defendant_id)
      )
      if (sellerLost) {
        const orderRow = db.prepare('SELECT product_id FROM orders WHERE id = ?').get(dispute.order_id) as { product_id: string } | undefined
        if (orderRow?.product_id) {
          db.prepare(`UPDATE products SET dispute_loss_count = COALESCE(dispute_loss_count, 0) + 1 WHERE id = ?`).run(orderRow.product_id)
        }
      }
    } catch (e) { console.error('[Tier7-hook dispute]', e) }

    // 2026-05-23 P0: 败诉方若 api_key 行为可能为 agent 代操 → 发 strike
    try {
      if (loserId) {
        const loserKey = db.prepare(`SELECT api_key FROM users WHERE id = ?`).get(loserId) as { api_key: string } | undefined
        if (loserKey?.api_key) {
          issueAgentStrike({
            apiKey: loserKey.api_key,
            userId: loserId,
            reasonCode: 'dispute_loss',
            reasonDetail: `仲裁裁定 ${ruling}`,
            relatedRef: req.params.id,
          })
        }
      }
    } catch (e) { console.error('[strike issuance]', e) }

    // 自动发布到公开判例库（脱敏）
    try {
      publishDisputeCase(req.params.id, ruling, reason)
    } catch (e) {
      console.error('[publishDisputeCase]', e)
    }

    res.json({ success: true, message: result.message, settlement: result.settlement })
  })

  // 参与方主动举证（text）+ SNF 信封分发
  app.post('/api/disputes/:id/add-evidence', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { description, evidence_type = 'text', file_hash } = req.body
    if (!description?.trim()) return void res.json({ error: '请填写证据内容' })

    const rawDesc = String(description).trim()
    const result = addPartyEvidence(
      db, req.params.id, user.id as string,
      rawDesc, evidence_type, file_hash
    )
    if (!result.success) return void res.json({ error: result.error })
    // 跨窗反诈
    const evReasons = detectFraud(rawDesc)
    if (evReasons.length > 0 && result.evidenceId) {
      try { await dbRun(`UPDATE evidence SET flag_reasons = ? WHERE id = ?`, [JSON.stringify(evReasons), result.evidenceId]) } catch {}
    }

    // 协议层：作为签名 SNF 信封投到对方 + 已分配仲裁员 inbox
    try {
      const d = await dbOne<{ order_id: string; initiator_id: string; defendant_id: string | null; assigned_arbitrators: string | null }>(`SELECT order_id, initiator_id, defendant_id, assigned_arbitrators FROM disputes WHERE id = ?`, [req.params.id])
      if (d) {
        const uid = user.id as string
        const recipients = new Set<string>()
        if (d.initiator_id && d.initiator_id !== uid) recipients.add(d.initiator_id)
        if (d.defendant_id && d.defendant_id !== uid) recipients.add(d.defendant_id)
        try {
          const arbs: string[] = JSON.parse(d.assigned_arbitrators || '[]')
          for (const a of arbs) if (a && a !== uid) recipients.add(a)
        } catch {}
        const envelope = {
          dispute_id:   req.params.id,
          evidence_id:  result.evidenceId,
          anchor_hash:  result.anchorHash,
          evidence_type,
          description:  description.trim(),
          file_hash:    file_hash || null,
        }
        for (const rid of recipients) {
          try {
            snfSend(db, {
              senderId: uid, recipientId: rid,
              messageType: 'dispute_evidence',
              payload: envelope, priority: 1,
              relatedOrderId: d.order_id,
            })
          } catch (e) { console.warn('[snf dispute-evidence]', rid, (e as Error).message) }
        }
      }
    } catch (e) { console.warn('[snf dispute-evidence] route err:', (e as Error).message) }

    res.json({ success: true, evidence_id: result.evidenceId, anchor_hash: result.anchorHash })
  })

  // L0-4 证据 blob 上传 — raw body + HMAC 签 + dedup + SNF 分发
  // M: 轻量 authGuard 在 raw 解析之前 — 挡掉 unauth 20MB 请求避免内存浪费
  const lightAuthGuard = (req: Request, res: Response, next: NextFunction) => {
    const hasAuth = !!req.headers.authorization
    if (!hasAuth) return void res.status(401).json({ error: 'auth required' })
    next()
  }
  // N: limit 精确 = EVIDENCE_MAX_BYTES
  app.post('/api/disputes/:id/evidence-blob',
    lightAuthGuard,
    express.raw({ type: 'application/octet-stream', limit: EVIDENCE_MAX_BYTES }),
    async (req: Request, res: Response) => {
      const user = auth(req, res); if (!user) return
      const hash = String(req.headers['x-content-hash'] || '').trim().toLowerCase()
      const mime = String(req.headers['x-content-mime'] || '').trim().toLowerCase()
      // J: decodeURIComponent 收 %ZZ 坏序列会抛 URIError → 400
      let description: string
      let filename: string | undefined
      try {
        description = decodeURIComponent(String(req.headers['x-description'] || '').trim())
        filename = req.headers['x-filename'] ? decodeURIComponent(String(req.headers['x-filename'])) : undefined
      } catch {
        return void res.status(400).json({ error: 'malformed_header_encoding' })
      }
      // L: filename 长度封顶
      if (filename && filename.length > 200) return void res.status(400).json({ error: 'filename_too_long' })

      if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return void res.status(400).json({ error: 'invalid_hash' })
      if (!mime) return void res.status(400).json({ error: 'missing_mime' })
      if (!EVIDENCE_ALLOWED_MIME.has(mime)) return void res.status(415).json({ error: 'mime_not_allowed', allowed: [...EVIDENCE_ALLOWED_MIME] })

      const blob = req.body as Buffer
      if (!Buffer.isBuffer(blob) || blob.length === 0) return void res.status(400).json({ error: 'empty_body' })

      try {
        const out = uploadEvidence(db, {
          uploaderId: user.id as string,
          uploaderApiKey: user.api_key as string,
          disputeId: String(req.params.id),
          blob, declaredHash: hash, mime, description, filename,
        })
        // 跨窗反诈：detect description（已 decoded）
        const evReasons = detectFraud(description)
        if (evReasons.length > 0 && out.id) {
          try { await dbRun(`UPDATE evidence SET flag_reasons = ? WHERE id = ?`, [JSON.stringify(evReasons), out.id]) } catch {}
        }

        // SNF 信封投递
        try {
          const d = await dbOne<{ order_id: string; initiator_id: string; defendant_id: string | null; assigned_arbitrators: string | null }>(`SELECT order_id, initiator_id, defendant_id, assigned_arbitrators FROM disputes WHERE id = ?`, [req.params.id])
          if (d) {
            const uid = user.id as string
            const recipients = new Set<string>()
            if (d.initiator_id && d.initiator_id !== uid) recipients.add(d.initiator_id)
            if (d.defendant_id && d.defendant_id !== uid) recipients.add(d.defendant_id)
            try {
              const arbs: string[] = JSON.parse(d.assigned_arbitrators || '[]')
              for (const a of arbs) if (a && a !== uid) recipients.add(a)
            } catch {}
            for (const rid of recipients) {
              try {
                snfSend(db, {
                  senderId: uid, recipientId: rid,
                  messageType: 'dispute_evidence_blob',
                  payload: {
                    dispute_id: req.params.id,
                    evidence_id: out.id,
                    file_hash: out.hash,
                    size: out.size,
                    mime, description, filename: filename || null,
                    sig: out.sig,
                  },
                  priority: 1, relatedOrderId: d.order_id,
                })
              } catch (e) { console.warn('[snf evidence-blob]', rid, (e as Error).message) }
            }
          }
        } catch (e) { console.warn('[snf evidence-blob] route err:', (e as Error).message) }

        res.json({ success: true, evidence_id: out.id, hash: out.hash, sig: out.sig, dedup: out.dedup, size: out.size })
      } catch (e) {
        const msg = (e as Error).message
        const status = msg === 'not_dispute_party' ? 403
          : msg === 'dispute_not_found' || msg === 'evidence_not_found' ? 404
          : msg === 'evidence_too_large' ? 413
          : msg === 'evidence_mime_not_allowed' ? 415
          : 400
        res.status(status).json({ error: msg })
      }
    }
  )

  // 仲裁员：请求某方补证
  app.post('/api/disputes/:id/request-evidence', (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleArbitrator(user.id as string)
    if (!elig.ok) return void errorRes(res, 403, 'NOT_ARBITRATOR', elig.reason || '仅限仲裁员')

    const { requested_from_id, evidence_types, description, deadline_hours = 48 } = req.body
    if (!requested_from_id || !description) return void res.json({ error: '请指定被要求方和证据要求说明' })
    if (!Array.isArray(evidence_types) || evidence_types.length === 0) {
      return void res.json({ error: '请至少选择一种证据类型' })
    }
    const validTypes = ['text', 'image', 'video', 'document', 'chain_data']
    if (!evidence_types.every((t: string) => validTypes.includes(t))) {
      return void res.json({ error: `证据类型无效，支持：${validTypes.join('/')}` })
    }

    const result = requestEvidence(
      db, req.params.id, user.id as string,
      requested_from_id, evidence_types,
      description, Number(deadline_hours)
    )
    if (!result.success) return void res.json({ error: result.error })
    res.json({ success: true, request_id: result.requestId })
  })

  // ─── task #1093 stage 6: arbitrator_pause / resume auto_judge ─────
  // Spec: docs/ARBITRATION-PLAYBOOK.md §2.1 (clock conflict resolution)
  // Freezes the 48h respondent-silence + arbitrate_deadline clocks while
  // arbitrator legitimately needs more time(e.g., evidence collection).
  //
  // Both endpoints require caller is one of dispute.assigned_arbitrators.
  // Repause(extend) allowed — each pause writes an audit_log entry.
  // No Iron-Rule Passkey: routine arbitrator action, fully audit-traceable.

  async function isAssignedArbitrator(disputeId: string, userId: string): Promise<boolean> {
    const row = await dbOne<{ assigned_arbitrators: string | null }>(`SELECT assigned_arbitrators FROM disputes WHERE id = ?`, [disputeId])
    if (!row) return false
    let arr: string[] = []
    try { arr = JSON.parse(row.assigned_arbitrators || '[]') } catch { arr = [] }
    return arr.includes(userId)
  }

  function appendAuditLog(disputeId: string, entry: Record<string, unknown>): void {
    // Append-only JSON array. Reads existing audit_log, appends, writes back.
    const row = db.prepare(`SELECT audit_log FROM disputes WHERE id = ?`).get(disputeId) as { audit_log: string | null } | undefined
    let arr: Array<Record<string, unknown>> = []
    try { arr = JSON.parse(row?.audit_log || '[]') } catch { arr = [] }
    arr.push({ ...entry, at: Math.floor(Date.now() / 1000) })
    db.prepare(`UPDATE disputes SET audit_log = ? WHERE id = ?`).run(JSON.stringify(arr), disputeId)
  }

  // task #1093 stage 6 P0 fix:pause 必须扩展 deadline,否则 cron 解冻后立即 auto-judge
  // 且 /respond 端点硬查 deadline,暂停期间 respondent 提交反驳会被拒
  function extendIsoDeadlineBySeconds(text: string | null, secondsToAdd: number): string | null {
    if (!text || secondsToAdd <= 0) return text
    const ms = new Date(text).getTime()
    if (isNaN(ms)) return text  // unparseable — leave as is
    return new Date(ms + secondsToAdd * 1000).toISOString()
  }

  app.post('/api/disputes/:id/arbitrator-pause-auto-judge', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const disputeId = req.params.id
    const body = req.body || {}
    const reason = String(body.reason || '').trim()
    const untilTs = Number(body.until_ts || 0)

    if (!reason || reason.length < 10) {
      return void errorRes(res, 400, 'REASON_TOO_SHORT', '暂停理由至少 10 字符(写入 audit_log 公示)')
    }
    if (!untilTs || untilTs <= Math.floor(Date.now() / 1000)) {
      return void errorRes(res, 400, 'INVALID_UNTIL_TS', 'until_ts 必须是未来 epoch 秒')
    }
    const maxHours = Number(getProtocolParam<number>('arbitration_max_pause_hours', 168))
    const maxAllowed = Math.floor(Date.now() / 1000) + maxHours * 3600
    if (untilTs > maxAllowed) {
      return void errorRes(res, 400, 'EXCEEDS_MAX_HOURS', `until_ts 超过最大暂停窗口 ${maxHours}h(playbook §2.1)`)
    }

    const dispute = await dbOne<{ id: string; status: string; ruling_type: string | null; assigned_arbitrators: string | null; auto_judge_paused_until: number | null; respond_deadline: string | null; arbitrate_deadline: string | null }>(`SELECT id, status, ruling_type, assigned_arbitrators, auto_judge_paused_until, respond_deadline, arbitrate_deadline FROM disputes WHERE id = ?`, [disputeId])
    if (!dispute) return void errorRes(res, 404, 'NOT_FOUND', 'dispute 不存在')
    if (dispute.ruling_type) {
      return void errorRes(res, 409, 'ALREADY_RULED', '已裁决的 dispute 不能暂停自动判定时钟')
    }
    if (dispute.status !== 'open' && dispute.status !== 'in_review') {
      return void errorRes(res, 409, 'WRONG_STATUS', `status='${dispute.status}',只能 pause open / in_review`)
    }
    if (!await isAssignedArbitrator(disputeId, userId)) {
      return void errorRes(res, 403, 'NOT_ASSIGNED_ARBITRATOR', '仅 assigned_arbitrators 可暂停自动判定时钟')
    }

    // P0 fix:计算 deadline 扩展秒数
    // - 首次 pause:increment = untilTs - now
    // - repause(已经 paused):increment = untilTs - existing_paused_until(可能 < 0,clamp 0)
    // 这样多次 pause 累加正确;repause 缩短无效果(只 audit_log 记)
    const nowSec = Math.floor(Date.now() / 1000)
    // Codex #229 P1:上面的 await 预检与同步 tx 之间有 yield,dispute 的 status/ruling/
    // assignment 可能已变。所有授权+状态判定 + baseline/increment 计算必须基于【tx 内重读】的行,
    // 先于任何写抛回滚;预检仅作友好 fast-fail。
    let incrementSec = 0
    let isRepause = false
    try {
      db.transaction(() => {
        const d = db.prepare(`SELECT status, ruling_type, assigned_arbitrators, auto_judge_paused_until, respond_deadline, arbitrate_deadline FROM disputes WHERE id = ?`).get(disputeId) as { status: string; ruling_type: string | null; assigned_arbitrators: string | null; auto_judge_paused_until: number | null; respond_deadline: string | null; arbitrate_deadline: string | null } | undefined
        if (!d) throw new Error('DW_NOT_FOUND')
        if (d.ruling_type) throw new Error('DW_ALREADY_RULED')
        if (d.status !== 'open' && d.status !== 'in_review') throw new Error('DW_WRONG_STATUS')
        let assigned: string[] = []
        try { assigned = JSON.parse(d.assigned_arbitrators || '[]') } catch { assigned = [] }
        if (!assigned.includes(userId)) throw new Error('DW_NOT_ASSIGNED')

        const baseline = d.auto_judge_paused_until && d.auto_judge_paused_until > nowSec ? d.auto_judge_paused_until : nowSec
        incrementSec = Math.max(0, untilTs - baseline)
        isRepause = d.auto_judge_paused_until !== null && d.auto_judge_paused_until > nowSec

        // 扩展 deadline(若 increment > 0)— 基于 tx 内重读的 deadline,非陈旧预检值
        if (incrementSec > 0) {
          const newRespondDeadline = extendIsoDeadlineBySeconds(d.respond_deadline, incrementSec)
          const newArbitrateDeadline = extendIsoDeadlineBySeconds(d.arbitrate_deadline, incrementSec)
          db.prepare(`UPDATE disputes SET respond_deadline = ?, arbitrate_deadline = ? WHERE id = ?`)
            .run(newRespondDeadline, newArbitrateDeadline, disputeId)
        }
        db.prepare(`UPDATE disputes SET auto_judge_paused_until = ?, auto_judge_pause_reason = ? WHERE id = ?`)
          .run(untilTs, reason, disputeId)
        appendAuditLog(disputeId, {
          event: 'arbitrator_pause_auto_judge',
          actor: userId,
          reason,
          until_ts: untilTs,
          deadline_extended_seconds: incrementSec,
          is_repause: isRepause,
          spec_ref: 'playbook §2.1',
        })
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'DW_NOT_FOUND') return void errorRes(res, 404, 'NOT_FOUND', 'dispute 不存在')
      if (msg === 'DW_ALREADY_RULED') return void errorRes(res, 409, 'ALREADY_RULED', '已裁决的 dispute 不能暂停自动判定时钟')
      if (msg === 'DW_WRONG_STATUS') return void errorRes(res, 409, 'WRONG_STATUS', 'dispute 状态已变更,只能 pause open / in_review')
      if (msg === 'DW_NOT_ASSIGNED') return void errorRes(res, 403, 'NOT_ASSIGNED_ARBITRATOR', '仅 assigned_arbitrators 可暂停自动判定时钟')
      throw e
    }

    res.json({
      success: true,
      dispute_id: disputeId,
      paused_until: untilTs,
      paused_until_iso: new Date(untilTs * 1000).toISOString(),
      max_hours: maxHours,
      deadline_extended_seconds: incrementSec,
      note: incrementSec > 0
        ? `自动判定时钟已冻结,respond/arbitrate deadline 已延后 ${Math.round(incrementSec / 3600)}h。补证据期满或证据齐全后请显式 resume。`
        : 'pause 已记录(repause 缩短无 deadline 变化)。',
    })
  })

  app.post('/api/disputes/:id/arbitrator-resume-auto-judge', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const disputeId = req.params.id

    const dispute = await dbOne<{ id: string; ruling_type: string | null; auto_judge_paused_until: number | null }>(`SELECT id, ruling_type, auto_judge_paused_until FROM disputes WHERE id = ?`, [disputeId])
    if (!dispute) return void errorRes(res, 404, 'NOT_FOUND', 'dispute 不存在')
    if (dispute.ruling_type) {
      return void errorRes(res, 409, 'ALREADY_RULED', '已裁决的 dispute 不需 resume')
    }
    if (!dispute.auto_judge_paused_until) {
      return void errorRes(res, 409, 'NOT_PAUSED', '当前未暂停,无需 resume')
    }
    if (!await isAssignedArbitrator(disputeId, userId)) {
      return void errorRes(res, 403, 'NOT_ASSIGNED_ARBITRATOR', '仅 assigned_arbitrators 可 resume')
    }

    // Codex #229 P1:tx 内重读 + 重判授权/状态,先于任何写抛回滚;上面 await 预检仅友好 fast-fail。
    try {
      db.transaction(() => {
        const d = db.prepare(`SELECT ruling_type, assigned_arbitrators, auto_judge_paused_until FROM disputes WHERE id = ?`).get(disputeId) as { ruling_type: string | null; assigned_arbitrators: string | null; auto_judge_paused_until: number | null } | undefined
        if (!d) throw new Error('DW_NOT_FOUND')
        if (d.ruling_type) throw new Error('DW_ALREADY_RULED')
        if (!d.auto_judge_paused_until) throw new Error('DW_NOT_PAUSED')
        let assigned: string[] = []
        try { assigned = JSON.parse(d.assigned_arbitrators || '[]') } catch { assigned = [] }
        if (!assigned.includes(userId)) throw new Error('DW_NOT_ASSIGNED')
        db.prepare(`UPDATE disputes SET auto_judge_paused_until = NULL, auto_judge_pause_reason = NULL WHERE id = ?`)
          .run(disputeId)
        appendAuditLog(disputeId, {
          event: 'arbitrator_resume_auto_judge',
          actor: userId,
          spec_ref: 'playbook §2.1',
        })
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'DW_NOT_FOUND') return void errorRes(res, 404, 'NOT_FOUND', 'dispute 不存在')
      if (msg === 'DW_ALREADY_RULED') return void errorRes(res, 409, 'ALREADY_RULED', '已裁决的 dispute 不需 resume')
      if (msg === 'DW_NOT_PAUSED') return void errorRes(res, 409, 'NOT_PAUSED', '当前未暂停,无需 resume')
      if (msg === 'DW_NOT_ASSIGNED') return void errorRes(res, 403, 'NOT_ASSIGNED_ARBITRATOR', '仅 assigned_arbitrators 可 resume')
      throw e
    }

    res.json({ success: true, dispute_id: disputeId, note: '自动判定时钟已解冻' })
  })
}
