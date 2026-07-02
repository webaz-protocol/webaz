/**
 * L3-1 · 争议引擎
 *
 * 核心设计原则：无歧义自动判责
 * - 发起争议 → 被诉方 48h 内必须提交反驳证据
 * - 被诉方超时不回应 → 协议自动判发起方胜诉
 * - 仲裁员收到争议后 120h 内必须裁定
 * - 仲裁员超时 → 协议默认退款给买家（买家保护原则）
 *
 * 覆盖模块：L3-1 争议触发、L3-2 证据收集、L3-3 超时自动判责、L3-5 处置执行
 *
 * 关联 / Related: AGENTS.md · 元规则 #1 当一切可见 / #5 不偏袒(判责规则对所有人一致) ·
 *   arbitrate 是 Iron-Rule 真人动作(需 Passkey) · 协议级改动审批见 CHARTER §3.2
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
// RFC-014 PR5 — 争议资金处置走整数 base-units + 绝对值落库 + allocate 精确拆分。
import { toUnits, toDecimal, mulRate, allocate } from '../../money.js'
import { applyWalletDelta, debitStakeThenBalance } from '../../ledger.js'

// ─── 类型定义 ─────────────────────────────────────────────────

export interface DisputeRecord {
  id: string
  order_id: string
  initiator_id: string
  initiator_name?: string
  initiator_role?: string
  defendant_id: string | null
  defendant_name?: string
  defendant_role?: string
  reason: string
  status: 'open' | 'in_review' | 'resolved' | 'dismissed'
  defendant_notes: string | null
  defendant_evidence_ids: string   // JSON 数组
  respond_deadline: string | null
  arbitrate_deadline: string | null
  assigned_arbitrators: string     // JSON 数组
  verdict: string | null
  verdict_reason: string | null
  ruling_type: string | null
  refund_amount: number | null
  party_evidence_ids: string       // JSON 数组（参与方主动举证）
  liability_parties: string        // JSON 数组（责任分配裁定）
  created_at: string
  resolved_at: string | null
}

// ─── Schema 初始化（幂等，安全重复调用）────────────────────────

/**
 * 为 disputes 表添加 L3 需要的新列
 * 使用 try/catch 避免列已存在时报错
 */
export function initDisputeSchema(db: Database.Database): void {
  const newColumns = [
    `ALTER TABLE disputes ADD COLUMN defendant_id TEXT`,
    `ALTER TABLE disputes ADD COLUMN defendant_notes TEXT`,
    `ALTER TABLE disputes ADD COLUMN defendant_evidence_ids TEXT DEFAULT '[]'`,
    `ALTER TABLE disputes ADD COLUMN respond_deadline TEXT`,
    `ALTER TABLE disputes ADD COLUMN arbitrate_deadline TEXT`,
    `ALTER TABLE disputes ADD COLUMN ruling_type TEXT`,
    `ALTER TABLE disputes ADD COLUMN refund_amount REAL`,
    // Phase 1 新增：多方举证 + 责任分配
    `ALTER TABLE disputes ADD COLUMN party_evidence_ids TEXT DEFAULT '[]'`,
    `ALTER TABLE disputes ADD COLUMN liability_parties TEXT DEFAULT '[]'`,
    // 2026-06-02 task #1093 stage 6: arbitrator_pause_auto_judge (playbook §2.1)
    // Freeze the 48h respondent-silence auto-judge clock + the arbitrate_deadline clock
    // when arbitrator legitimately needs more time for evidence collection.
    `ALTER TABLE disputes ADD COLUMN auto_judge_paused_until INTEGER`,
    `ALTER TABLE disputes ADD COLUMN auto_judge_pause_reason TEXT`,
    `ALTER TABLE disputes ADD COLUMN audit_log TEXT DEFAULT '[]'`,
  ]
  for (const stmt of newColumns) {
    try { db.exec(stmt) } catch { /* 列已存在，跳过 */ }
  }
}

/** 任意参与方（非被告）主动提交证据 */
export function addPartyEvidence(
  db: Database.Database,
  disputeId: string,
  submitterId: string,
  description: string,
  evidenceType: EvidenceType = 'text',
  fileHash?: string
): { success: boolean; evidenceId?: string; anchorHash?: string; error?: string } {
  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId) as DisputeRecord | undefined
  if (!dispute) return { success: false, error: '争议不存在' }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    return { success: false, error: '该争议已结案' }
  }

  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as Record<string, string | null> | undefined
  const partyIds = [order?.buyer_id, order?.seller_id, order?.logistics_id,
                    dispute.initiator_id, dispute.defendant_id].filter(Boolean) as string[]
  if (!partyIds.includes(submitterId)) {
    return { success: false, error: '你不是此争议的参与方' }
  }

  const anchorHash = fileHash || generateAnchorHash(description)
  const eid = generateId('evt')
  db.prepare(
    `INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash) VALUES (?,?,?,?,?,?)`
  ).run(eid, dispute.order_id, submitterId, evidenceType, description, anchorHash)

  const existing: string[] = JSON.parse(dispute.party_evidence_ids || '[]')
  existing.push(eid)
  db.prepare(`UPDATE disputes SET party_evidence_ids = ? WHERE id = ?`).run(JSON.stringify(existing), disputeId)

  return { success: true, evidenceId: eid, anchorHash }
}

// ─── L3-1 争议触发 ────────────────────────────────────────────

/**
 * 创建争议记录
 * 在 webaz_update_order action=dispute 之后调用，写入 disputes 表
 */
export function createDispute(
  db: Database.Database,
  orderId: string,
  initiatorId: string,
  reason: string,
  evidenceIds: string[]
): { success: boolean; disputeId?: string; error?: string; message?: string; respondDeadline?: string } {

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!order) return { success: false, error: `订单不存在：${orderId}` }
  if (order.status !== 'disputed') return { success: false, error: '订单尚未进入争议状态，请先调用 webaz_update_order action=dispute' }

  // 检查是否已有进行中的争议
  const existing = db.prepare(
    `SELECT id FROM disputes WHERE order_id = ? AND status NOT IN ('resolved', 'dismissed')`
  ).get(orderId) as { id: string } | undefined
  if (existing) return { success: false, error: `该订单已有进行中的争议：${existing.id}` }

  // 确定被诉方：买家发起 → 被诉卖家，卖家/物流发起 → 被诉买家
  const initiator = db.prepare('SELECT role FROM users WHERE id = ?').get(initiatorId) as { role: string } | undefined
  if (!initiator) return { success: false, error: '发起方用户不存在' }

  let defendantId: string
  if (initiator.role === 'buyer') {
    defendantId = order.seller_id as string
  } else if (initiator.role === 'seller') {
    defendantId = order.buyer_id as string
  } else if (initiator.role === 'logistics') {
    defendantId = order.seller_id as string  // 物流纠纷默认与卖家
  } else {
    return { success: false, error: '此角色不能发起争议' }
  }

  const now = new Date()
  const disputeId = generateId('dsp')
  const respondDeadline = addHours(now, 48)
  const arbitrateDeadline = addHours(now, 120)

  db.prepare(`
    INSERT INTO disputes (
      id, order_id, initiator_id, defendant_id, reason, status,
      defendant_evidence_ids, respond_deadline, arbitrate_deadline, assigned_arbitrators
    ) VALUES (?, ?, ?, ?, ?, 'open', '[]', ?, ?, '[]')
  `).run(disputeId, orderId, initiatorId, defendantId, reason, respondDeadline, arbitrateDeadline)

  return {
    success: true,
    disputeId,
    respondDeadline,
    message: `争议已记录（${disputeId}）。被诉方有 48 小时提交反驳证据，超时协议自动判你胜诉。`,
  }
}

// ─── L3-2 证据收集 ────────────────────────────────────────────

/**
 * 被诉方提交反驳证据
 * @param db
 * @param disputeId 争议ID
 * @param responderId 被诉方用户ID
 * @param notes 反驳说明
 * @param evidenceIds 证据ID列表
 */
export function respondToDispute(
  db: Database.Database,
  disputeId: string,
  responderId: string,
  notes: string,
  evidenceIds: string[]
): { success: boolean; error?: string; message?: string } {

  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId) as DisputeRecord | undefined
  if (!dispute) return { success: false, error: `争议不存在：${disputeId}` }
  if (dispute.status !== 'open') {
    return { success: false, error: `争议已不在等待回应状态（当前：${dispute.status}）` }
  }
  if (dispute.defendant_id !== responderId) {
    return { success: false, error: '你不是本争议的被诉方，无法提交回应' }
  }

  // 检查截止时间
  if (dispute.respond_deadline && new Date() > new Date(dispute.respond_deadline)) {
    return { success: false, error: '回应截止时间已过，协议将自动裁定' }
  }

  db.prepare(`
    UPDATE disputes SET
      defendant_notes = ?,
      defendant_evidence_ids = ?,
      status = 'in_review'
    WHERE id = ?
  `).run(notes, JSON.stringify(evidenceIds), disputeId)

  return {
    success: true,
    message: '反驳证据已提交，争议进入仲裁阶段。仲裁员将在 120 小时（5 天）内做出裁定，超时协议自动判初诉方胜。',
  }
}

// ─── L3-4 仲裁裁定 + L3-5 处置执行 ──────────────────────────

/**
 * 仲裁员做出裁定，并自动执行资金处置
 */
export interface LiabilityEntry {
  user_id: string
  role: string
  amount: number          // 该方应承担的赔偿金额
  insurance_cap?: number  // 保险兜底上限（物流方可用），超额由协议垫付
}

/**
 * 非托管订单(direct_p2p / escrow_amount=0)的争议裁定 —— 【只做状态终结,绝不动任何资金】。
 * 协议从未持有买家货款(买家场外直付卖家),故 executeSettlement 那套"退托管/扣质押/入协议费"会【凭空】给买家记
 * balance、把不存在的托管退款、腐蚀账本(P0)。此路径只把订单推进到与 ruling 对应的既有争议终态,金额一律 0;
 * reputation/strike 由路由层照常施加(那才是本轨"证据制信誉裁决,不涉资金赔付"的裁决效力)。
 * 返回 non_custodial 标记 → 路由据此跳过 release_seller / partial_refund / liability_split 的佣金/PV/基金分润钩子。
 */
export function executeNonCustodialSettlement(
  db: Database.Database, orderId: string, ruling: string
): { success: boolean; error?: string; detail?: Record<string, unknown> } {
  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
  if (!sysUser) return { success: false, error: 'sys_protocol 用户不存在' }
  const terminal = ruling === 'refund_buyer' ? 'refunded_full'
    : ruling === 'release_seller' ? 'resolved_for_seller' : 'refunded_partial'
  const r = transition(db, orderId, terminal, sysUser.id, [], `非托管(直付)争议裁定:协议不持货款,仅信誉裁决、不动任何资金 — ${ruling}`)
  if (!r.success) return { success: false, error: r.error }
  // 金额全 0(供路由分润钩子据此算出 0),并打 non_custodial 标记。
  return { success: true, detail: { non_custodial: true, ruling, buyer_refund: 0, buyer_compensation: 0, seller_received: 0, seller_escrow_share: 0, actual_refund: 0, note: '非托管订单:仅信誉裁决,不动用任何托管/钱包/质押/佣金资金' } }
}

export function arbitrateDispute(
  db: Database.Database,
  disputeId: string,
  arbitratorId: string,
  ruling: 'refund_buyer' | 'release_seller' | 'partial_refund' | 'liability_split',
  reason: string,
  refundAmount?: number,
  liabilityParties?: LiabilityEntry[],
  liablePartyId?: string   // 指定责任方 user_id（用于 partial_refund 第三方责任场景）
): { success: boolean; error?: string; message?: string; non_custodial?: boolean; settlement?: Record<string, unknown> } {

  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId) as DisputeRecord | undefined
  if (!dispute) return { success: false, error: `争议不存在：${disputeId}` }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    return { success: false, error: '该争议已处理完毕' }
  }

  const arbitrator = db.prepare('SELECT role FROM users WHERE id = ?').get(arbitratorId) as { role: string } | undefined
  if (!arbitrator) return { success: false, error: '仲裁员不存在' }
  if (arbitrator.role !== 'arbitrator' && arbitrator.role !== 'system') {
    return { success: false, error: `只有仲裁员才能做出裁定，你的角色是：${arbitrator.role}` }
  }

  // 非托管(直付)订单:协议不持货款 → 走【只信誉、不动资金】路径,绝不跑 executeSettlement/executeLiabilitySplit 的托管资金链。
  const ord0 = db.prepare('SELECT payment_rail FROM orders WHERE id = ?').get(dispute.order_id) as { payment_rail: string | null } | undefined
  const nonCustodial = !!ord0 && ord0.payment_rail === 'direct_p2p'

  // 执行资金处置(非托管 → 零资金终结)
  const settlement = nonCustodial
    ? executeNonCustodialSettlement(db, dispute.order_id, ruling)
    : ruling === 'liability_split' && liabilityParties
      ? executeLiabilitySplit(db, dispute.order_id, liabilityParties, refundAmount)
      : executeSettlement(db, dispute.order_id, ruling, refundAmount, liablePartyId)
  if (!settlement.success) return { success: false, error: settlement.error }

  // 收取仲裁费（败诉/责任方付 1%，最低 1 WAZ）
  const order = db.prepare('SELECT total_amount, buyer_id, seller_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as { total_amount: number; buyer_id: string; seller_id: string } | undefined
  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
  const arbFees: Record<string, number> = {}

  if (order && !nonCustodial) {   // 非托管:不收仲裁费(不动任何钱包资金)
    const amt = order.total_amount
    if (ruling === 'refund_buyer') {
      const f = chargeArbitrationFee(db, order.seller_id, amt, arbitratorId, sysUser.id)
      if (f.fee > 0) arbFees[order.seller_id] = f.fee
    } else if (ruling === 'release_seller') {
      const f = chargeArbitrationFee(db, order.buyer_id, amt, arbitratorId, sysUser.id)
      if (f.fee > 0) arbFees[order.buyer_id] = f.fee
    } else if (ruling === 'partial_refund') {
      // 有指定责任方：仲裁费全由责任方承担
      // 无责任方：买卖双方各付 0.5%
      const payerId = liablePartyId ?? null
      if (payerId) {
        const f = chargeArbitrationFee(db, payerId, amt, arbitratorId, sysUser.id)
        if (f.fee > 0) arbFees[payerId] = f.fee
      } else {
        const halfAmt = amt * 0.5
        const fb = chargeArbitrationFee(db, order.buyer_id,  halfAmt, arbitratorId, sysUser.id)
        const fs = chargeArbitrationFee(db, order.seller_id, halfAmt, arbitratorId, sysUser.id)
        if (fb.fee > 0) arbFees[order.buyer_id]  = fb.fee
        if (fs.fee > 0) arbFees[order.seller_id] = fs.fee
      }
    } else if (ruling === 'liability_split' && liabilityParties) {
      const totalLiability = liabilityParties.reduce((s, p) => s + p.amount, 0) || amt
      for (const p of liabilityParties) {
        const share = (p.amount / totalLiability) * amt
        const f = chargeArbitrationFee(db, p.user_id, share, arbitratorId, sysUser.id)
        if (f.fee > 0) arbFees[p.user_id] = (arbFees[p.user_id] ?? 0) + f.fee
      }
    }
  }

  // 更新争议记录
  db.prepare(`
    UPDATE disputes SET
      status = 'resolved',
      verdict = ?,
      verdict_reason = ?,
      ruling_type = ?,
      refund_amount = ?,
      liability_parties = ?,
      resolved_at = datetime('now')
    WHERE id = ?
  `).run(
    ruling, reason, ruling, nonCustodial ? null : (refundAmount ?? null),   // 非托管:不落任何退款/赔付金额(不退款、不赔付)
    JSON.stringify(nonCustodial ? [] : (liabilityParties ?? [])),
    disputeId
  )

  return {
    success: true,
    non_custodial: nonCustodial,   // 路由据此跳过佣金/PV/基金分润钩子(非托管无托管结算)
    message: nonCustodial ? getNonCustodialRulingDescription(ruling) : `裁定已执行：${getRulingDescription(ruling, refundAmount)}`,
    settlement: {
      ...settlement.detail,
      arbitration_fees: arbFees,
    },
  }
}

/**
 * 执行多方责任分配结算
 *
 * 资金流模型：
 *  A) 托管资金（买家原款）：
 *     - 买家获得 actualRefund（从托管中拨还）
 *     - 卖家获得 totalAmount - actualRefund（托管剩余，若无责任则取回全额）
 *
 *  B) 责任罚款（惩戒性）：每个责任方按各自金额被扣款，扣款进入协议金库
 *     - 先扣质押，不足再扣余额
 *     - 物流方可设 insurance_cap：超出上限的部分由协议金库垫付（买家仍足额赔付）
 *
 *  C) 卖家商品质押：
 *     - 若卖家未列入责任方，质押全额返还
 *     - 若卖家列入责任方，按责任金额比例扣罚，剩余返还
 *
 * 这样确保托管资金守恒（无凭空创造/销毁），责任方额外受罚（去向：sys_protocol）。
 */
export function executeLiabilitySplit(
  db: Database.Database,
  orderId: string,
  liabilityParties: LiabilityEntry[],
  buyerRefund?: number
): { success: boolean; error?: string; detail?: Record<string, unknown> } {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!order) return { success: false, error: '订单不存在' }

  const totalAmount = order.total_amount as number
  const buyerId     = order.buyer_id as string
  const sellerId    = order.seller_id as string
  const sysUser     = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }

  const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?')
    .get(order.product_id as string) as { stake_amount: number } | undefined
  const stakeAmount = product?.stake_amount ?? 0

  // RFC-014:整数 base-units
  const totalU = toUnits(totalAmount)
  const stakeAmountU = toUnits(stakeAmount)
  const actualRefundU = Math.min(toUnits(buyerRefund ?? totalAmount), totalU)
  const sellerEscrowShareU = totalU - actualRefundU   // 残值,精确

  // 预先计算各责任方实际扣款（资金守恒：责任方扣款 = 协议金库收入），全整数 units
  const settled: Array<{
    userId: string; role: string; owedU: number
    actualPenaltyU: number; insuranceCoveredU: number
  }> = []

  for (const entry of liabilityParties) {
    const wallet = db.prepare('SELECT COALESCE(balance,0) balance, COALESCE(staked,0) staked FROM wallets WHERE user_id = ?')
      .get(entry.user_id) as { balance: number; staked: number } | undefined
    const availableU = toUnits(wallet?.balance ?? 0) + toUnits(wallet?.staked ?? 0)
    const amountU = toUnits(entry.amount)

    let actualPenaltyU: number
    let insuranceCoveredU = 0

    if (entry.insurance_cap !== undefined && toUnits(entry.insurance_cap) < amountU) {
      // 有保险上限：责任方最多赔 insurance_cap，不足部分由协议垫付
      const capU = toUnits(entry.insurance_cap)
      actualPenaltyU = Math.min(capU, availableU)
      insuranceCoveredU = amountU - capU  // 协议垫付(信息性,不实际入账)
    } else {
      // 无保险上限：以实际可用余额为上限
      actualPenaltyU = Math.min(amountU, availableU)
      insuranceCoveredU = amountU - actualPenaltyU       // 余额不足部分
    }

    settled.push({ userId: entry.user_id, role: entry.role, owedU: amountU, actualPenaltyU, insuranceCoveredU })
  }

  // 卖家是否在责任方列表中
  const sellerLiability = liabilityParties.find(p => p.user_id === sellerId)

  db.transaction(() => {
    // ── A. 托管拨付 ──────────────────────────────────────────────
    applyWalletDelta(db, buyerId, { escrowed: -totalU })
    if (actualRefundU > 0) applyWalletDelta(db, buyerId, { balance: actualRefundU })
    if (sellerEscrowShareU > 0) applyWalletDelta(db, sellerId, { balance: sellerEscrowShareU })

    // ── B. 责任罚款 → 协议金库（先质押后余额）─────────────────────
    let totalToTreasuryU = 0
    for (const s of settled) {
      if (s.actualPenaltyU > 0) totalToTreasuryU += debitStakeThenBalance(db, s.userId, s.actualPenaltyU)
    }
    if (totalToTreasuryU > 0) applyWalletDelta(db, sysUser.id, { balance: totalToTreasuryU })

    // ── C. 卖家商品质押处理 ───────────────────────────────────────
    if (stakeAmountU > 0) {
      if (sellerLiability) {
        // 卖家有责：按责任金额扣罚质押(封顶),剩余返还
        const stakeForfeitedU = Math.min(stakeAmountU, toUnits(sellerLiability.amount))
        const stakeReturnU    = stakeAmountU - stakeForfeitedU
        applyWalletDelta(db, sellerId, { staked: -stakeAmountU })
        if (stakeReturnU > 0) applyWalletDelta(db, sellerId, { balance: stakeReturnU })
        if (stakeForfeitedU > 0) applyWalletDelta(db, sysUser.id, { balance: stakeForfeitedU })
      } else {
        // 卖家无责：全额返还质押
        applyWalletDelta(db, sellerId, { staked: -stakeAmountU, balance: stakeAmountU })
      }
    }

    transition(db, orderId, 'refunded_partial', sysUser.id, [], `争议裁定：责任分配，退款买家 ${toDecimal(actualRefundU)} WAZ`)
  })()

  return {
    success: true,
    detail: {
      ruling: 'liability_split',
      buyer_refund: toDecimal(actualRefundU),
      seller_escrow_share: toDecimal(sellerEscrowShareU),
      liability_breakdown: settled.map(s => ({
        userId: s.userId, role: s.role,
        owed: toDecimal(s.owedU), actualPenalty: toDecimal(s.actualPenaltyU), insuranceCovered: toDecimal(s.insuranceCoveredU)
      })),
    }
  }
}

// ─── L3-5 资金处置执行 ────────────────────────────────────────

// ─── 仲裁费收取 ───────────────────────────────────────────────

/**
 * 向败诉方收取仲裁费：订单金额的 1%（最低 1 WAZ）
 * - 有人工仲裁员时：50% 给仲裁员作为激励，50% 归协议
 * - 自动裁定时：100% 归协议
 * - 先扣质押，质押不足再扣余额
 */
function chargeArbitrationFee(
  db: Database.Database,
  loserId: string,
  orderAmount: number,
  arbitratorId: string,
  sysUserId: string,
): { fee: number; arbitratorShare: number; protocolShare: number } {
  // RFC-014:整数 base-units。费 = max(1 WAZ, 订单额×1%)
  const feeU = Math.max(toUnits(1), mulRate(toUnits(orderAmount), 0.01))
  const isHumanArbitrator = arbitratorId !== sysUserId

  const wallet = db.prepare('SELECT COALESCE(balance,0) balance, COALESCE(staked,0) staked FROM wallets WHERE user_id = ?')
    .get(loserId) as { balance: number; staked: number } | undefined
  const availableU = toUnits(wallet?.balance ?? 0) + toUnits(wallet?.staked ?? 0)
  const actualFeeU = Math.min(feeU, availableU)
  if (actualFeeU <= 0) return { fee: 0, arbitratorShare: 0, protocolShare: 0 }

  // 扣款：先质押后余额
  debitStakeThenBalance(db, loserId, actualFeeU)

  // 分配：人工仲裁各一半(allocate 精确),自动裁定全归协议
  const arbitratorShareU = isHumanArbitrator ? allocate(actualFeeU, [1, 1])[0] : 0
  const protocolShareU = actualFeeU - arbitratorShareU

  if (protocolShareU > 0) applyWalletDelta(db, sysUserId, { balance: protocolShareU })
  if (arbitratorShareU > 0) applyWalletDelta(db, arbitratorId, { balance: arbitratorShareU })

  return { fee: toDecimal(actualFeeU), arbitratorShare: toDecimal(arbitratorShareU), protocolShare: toDecimal(protocolShareU) }
}

export function executeSettlement(
  db: Database.Database,
  orderId: string,
  ruling: string,
  refundAmount?: number,
  liablePartyId?: string
): { success: boolean; error?: string; detail?: Record<string, unknown> } {

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!order) return { success: false, error: '订单不存在' }

  const totalAmount = order.total_amount as number
  const buyerId   = order.buyer_id as string
  const sellerId  = order.seller_id as string

  const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?')
    .get(order.product_id as string) as { stake_amount: number } | undefined
  const stakeAmount = product?.stake_amount ?? 0

  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }

  // RFC-014:整数 base-units
  const totalU = toUnits(totalAmount)
  const stakeAmountU = toUnits(stakeAmount)

  if (ruling === 'refund_buyer') {
    // ── 买家胜诉：退全款 + 卖家损失一半质押（惩罚,allocate 精确二分）──────────────
    const [penaltyU, stakeReturnU] = stakeAmountU > 0 ? allocate(stakeAmountU, [1, 1]) : [0, 0]

    db.transaction(() => {
      // 退还买家托管资金
      applyWalletDelta(db, buyerId, { escrowed: -totalU, balance: totalU })
      // 卖家扣押全额质押 → 一半补偿买家,一半退回卖家(净损一半)
      if (stakeAmountU > 0) {
        applyWalletDelta(db, sellerId, { staked: -stakeAmountU })
        if (penaltyU > 0) applyWalletDelta(db, buyerId, { balance: penaltyU })
        if (stakeReturnU > 0) applyWalletDelta(db, sellerId, { balance: stakeReturnU })
      }
      transition(db, orderId, 'refunded_full', sysUser.id, [], `争议裁定：退款买家，质押惩罚 ${toDecimal(penaltyU)} WAZ`)
    })()

    return {
      success: true,
      detail: {
        ruling: 'refund_buyer',
        buyer_refund: toDecimal(totalU),
        buyer_compensation: toDecimal(penaltyU),
        seller_stake_forfeited: toDecimal(stakeAmountU),
        seller_stake_returned: toDecimal(stakeReturnU),
      }
    }

  } else if (ruling === 'release_seller') {
    // ── 卖家胜诉：资金释放给卖家（正常结算逻辑）──────────────────
    const protocolFeeU  = mulRate(totalU, 0.02)
    const logisticsFeeU = order.logistics_id ? mulRate(totalU, 0.05) : 0
    const sellerAmountU = totalU - protocolFeeU - logisticsFeeU   // 残值

    db.transaction(() => {
      applyWalletDelta(db, buyerId, { escrowed: -totalU })
      applyWalletDelta(db, sellerId, { balance: sellerAmountU })
      if (order.logistics_id && logisticsFeeU > 0) applyWalletDelta(db, order.logistics_id as string, { balance: logisticsFeeU })
      if (protocolFeeU > 0) applyWalletDelta(db, sysUser.id, { balance: protocolFeeU })   // 协议费入金库
      if (stakeAmountU > 0) applyWalletDelta(db, sellerId, { staked: -stakeAmountU, balance: stakeAmountU })  // 返还质押
      transition(db, orderId, 'resolved_for_seller', sysUser.id, [], '争议裁定：卖家胜诉，资金释放完成')
    })()

    return {
      success: true,
      detail: {
        ruling: 'release_seller',
        seller_received: toDecimal(sellerAmountU),
        logistics_fee: toDecimal(logisticsFeeU),
        protocol_fee: toDecimal(protocolFeeU),
        seller_stake_returned: toDecimal(stakeAmountU),
      }
    }

  } else if (ruling === 'partial_refund') {
    const refundU = refundAmount != null ? toUnits(refundAmount) : mulRate(totalU, 0.5)
    if (refundU > totalU) return { success: false, error: `退款金额 ${toDecimal(refundU)} 超出订单总额 ${totalAmount}` }

    if (liablePartyId) {
      // ── 第三方责任 partial_refund ────────────────────────────────
      // 卖家全额结算（正常收款），买家赔偿由责任方钱包直接支付
      const protocolFeeU  = mulRate(totalU, 0.02)
      const logisticsFeeU = order.logistics_id ? mulRate(totalU, 0.05) : 0
      const sellerAmountU = totalU - protocolFeeU - logisticsFeeU

      // 检查责任方余额是否足够
      const liableWallet = db.prepare('SELECT COALESCE(balance,0) balance, COALESCE(staked,0) staked FROM wallets WHERE user_id = ?')
        .get(liablePartyId) as { balance: number; staked: number } | undefined
      const liableAvailableU = toUnits(liableWallet?.balance ?? 0) + toUnits(liableWallet?.staked ?? 0)
      const actualRefundU = Math.min(refundU, liableAvailableU)

      db.transaction(() => {
        // 1. 释放托管 → 正常结算给卖家
        applyWalletDelta(db, buyerId, { escrowed: -totalU })
        applyWalletDelta(db, sellerId, { balance: sellerAmountU })
        if (order.logistics_id && logisticsFeeU > 0) applyWalletDelta(db, order.logistics_id as string, { balance: logisticsFeeU })
        if (protocolFeeU > 0) applyWalletDelta(db, sysUser.id, { balance: protocolFeeU })   // 协议费入金库
        // 2. 返还卖家质押
        if (stakeAmountU > 0) applyWalletDelta(db, sellerId, { staked: -stakeAmountU, balance: stakeAmountU })
        // 3. 从责任方钱包扣赔偿(先质押后余额) → 4. 给买家
        if (actualRefundU > 0) {
          debitStakeThenBalance(db, liablePartyId, actualRefundU)
          applyWalletDelta(db, buyerId, { balance: actualRefundU })
        }
        transition(db, orderId, 'refunded_partial', sysUser.id, [], `争议裁定：第三方责任赔偿 ${toDecimal(actualRefundU)} WAZ，卖家全额结算`)
      })()

      return {
        success: true,
        detail: {
          ruling: 'partial_refund',
          liable_party: liablePartyId,
          buyer_compensation: toDecimal(actualRefundU),
          seller_received: toDecimal(sellerAmountU),
          logistics_fee: toDecimal(logisticsFeeU),
          protocol_fee: toDecimal(protocolFeeU),
          seller_stake_returned: toDecimal(stakeAmountU),
        }
      }

    } else {
      // ── 买卖双方协商 partial_refund ───────────────────────
      const sellerGetU = totalU - refundU
      // 政策(option a):协商和解无过错 → 全额退质押,不罚没。
      const stakeReturnU = stakeAmountU

      db.transaction(() => {
        applyWalletDelta(db, buyerId, { escrowed: -totalU })
        if (refundU > 0) applyWalletDelta(db, buyerId, { balance: refundU })
        if (sellerGetU > 0) applyWalletDelta(db, sellerId, { balance: sellerGetU })
        if (stakeAmountU > 0) applyWalletDelta(db, sellerId, { staked: -stakeAmountU, balance: stakeReturnU })
        transition(db, orderId, 'refunded_partial', sysUser.id, [], `争议裁定：部分退款 ${toDecimal(refundU)} WAZ`)
      })()

      return {
        success: true,
        detail: {
          ruling: 'partial_refund',
          buyer_refund: toDecimal(refundU),
          seller_received: toDecimal(sellerGetU),
          seller_stake_returned: toDecimal(stakeReturnU),
        }
      }
    }
  }

  return { success: false, error: `未知裁定类型：${ruling}` }
}

// ─── L3-3 超时自动判责 ────────────────────────────────────────

/**
 * 扫描争议超时情况，自动裁定
 * 与 checkTimeouts() 配套使用，应定期运行
 */
export function checkDisputeTimeouts(db: Database.Database): {
  processed: number
  details: Array<{ disputeId: string; action: string; orderId?: string; winnerId?: string; loserId?: string }>
} {
  const now = new Date().toISOString()
  const details: Array<{ disputeId: string; action: string; orderId?: string; winnerId?: string; loserId?: string }> = []

  const openDisputes = db.prepare(
    `SELECT * FROM disputes WHERE status IN ('open', 'in_review')`
  ).all() as DisputeRecord[]

  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }

  for (const dispute of openDisputes) {
    // task #1093 stage 6: skip auto-judge if arbitrator paused the clock (playbook §2.1)
    // Pause expires automatically when auto_judge_paused_until passes; no resume needed
    // for the clock to thaw — explicit resume just clears the field eagerly + audit log.
    const pausedUntil = (dispute as DisputeRecord & { auto_judge_paused_until?: number | null }).auto_judge_paused_until
    if (pausedUntil && pausedUntil * 1000 > Date.now()) {
      continue
    }

    if (dispute.status === 'open' && dispute.respond_deadline && now > dispute.respond_deadline) {
      // 被告未在截止时间内回应 → 自动判发起方胜诉
      const initiator = db.prepare('SELECT role FROM users WHERE id = ?')
        .get(dispute.initiator_id) as { role: string } | undefined
      const ruling = initiator?.role === 'buyer' ? 'refund_buyer' : 'release_seller'

      const r = arbitrateDispute(db, dispute.id, sysUser.id, ruling, '被诉方超时未提交反驳证据，协议自动裁定')
      if (r.success) {
        details.push({
          disputeId: dispute.id,
          action: `被告超时 → ${ruling}`,
          orderId: dispute.order_id,
          winnerId: dispute.initiator_id,
          loserId: dispute.defendant_id ?? undefined,
        })
      }

    } else if (dispute.status === 'in_review' && dispute.arbitrate_deadline && now > dispute.arbitrate_deadline) {
      // 仲裁员超时未裁定 → 买家保护原则，默认退款
      const r = arbitrateDispute(db, dispute.id, sysUser.id, 'refund_buyer', '仲裁员超时未裁定，协议默认退款买家（买家保护原则）')
      if (r.success) {
        // 默认退款买家 → 买家胜，被告（卖家）败
        details.push({
          disputeId: dispute.id,
          action: '仲裁超时 → 默认退款买家',
          orderId: dispute.order_id,
          winnerId: dispute.initiator_id,
          loserId: dispute.defendant_id ?? undefined,
        })
      }
    }
  }

  return { processed: details.length, details }
}

// ─── L3-2 扩展：证据补充请求系统 ────────────────────────────────

export type EvidenceType = 'text' | 'image' | 'video' | 'document' | 'chain_data'

export interface EvidenceRequest {
  id: string
  dispute_id: string
  requested_from_id: string
  requested_from_name?: string
  requested_from_role?: string
  evidence_types: string        // JSON 数组
  description: string
  deadline: string
  status: 'pending' | 'submitted' | 'expired'
  submitted_evidence_ids: string // JSON 数组
  created_at: string
}

export function initEvidenceRequestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispute_evidence_requests (
      id                    TEXT PRIMARY KEY,
      dispute_id            TEXT NOT NULL,
      requested_from_id     TEXT NOT NULL,
      evidence_types        TEXT DEFAULT '["text"]',
      description           TEXT NOT NULL,
      deadline              TEXT NOT NULL,
      status                TEXT DEFAULT 'pending',
      submitted_evidence_ids TEXT DEFAULT '[]',
      created_at            TEXT DEFAULT (datetime('now'))
    )
  `)
}

/**
 * 仲裁员向任意角色发出"补充证据"请求
 */
export function requestEvidence(
  db: Database.Database,
  disputeId: string,
  arbitratorId: string,
  requestedFromId: string,
  evidenceTypes: EvidenceType[],
  description: string,
  deadlineHours = 48
): { success: boolean; requestId?: string; error?: string } {
  const arb = db.prepare('SELECT role FROM users WHERE id = ?').get(arbitratorId) as { role: string } | undefined
  if (!arb || (arb.role !== 'arbitrator' && arb.role !== 'system')) {
    return { success: false, error: '仅仲裁员可发出证据请求' }
  }
  const dispute = db.prepare('SELECT status FROM disputes WHERE id = ?').get(disputeId) as { status: string } | undefined
  if (!dispute) return { success: false, error: '争议不存在' }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    return { success: false, error: '该争议已结案' }
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(requestedFromId)
  if (!target) return { success: false, error: '指定用户不存在' }

  const requestId = generateId('evr')
  db.prepare(`
    INSERT INTO dispute_evidence_requests
      (id, dispute_id, requested_from_id, evidence_types, description, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(requestId, disputeId, requestedFromId, JSON.stringify(evidenceTypes), description, addHours(new Date(), deadlineHours))

  // 若争议仍在 open 状态，自动推进到 in_review
  if (dispute.status === 'open') {
    db.prepare(`UPDATE disputes SET status = 'in_review' WHERE id = ?`).run(disputeId)
  }

  return { success: true, requestId }
}

/**
 * 被要求方提交证据（响应某条请求）
 */
export function submitEvidenceForRequest(
  db: Database.Database,
  requestId: string,
  submitterId: string,
  evidenceType: EvidenceType,
  description: string,
  fileHash?: string
): { success: boolean; evidenceId?: string; anchorHash?: string; error?: string } {
  const req = db.prepare('SELECT * FROM dispute_evidence_requests WHERE id = ?').get(requestId) as EvidenceRequest | undefined
  if (!req) return { success: false, error: '证据请求不存在' }
  if (req.requested_from_id !== submitterId) return { success: false, error: '你不是此请求的被要求方' }
  if (req.status !== 'pending') return { success: false, error: '此请求已关闭（已提交或已过期）' }
  if (new Date() > new Date(req.deadline)) return { success: false, error: '提交截止时间已过' }

  const dispute = db.prepare('SELECT order_id FROM disputes WHERE id = ?').get(req.dispute_id) as { order_id: string }
  // 生成锚定哈希（Phase 0 模拟；Phase 2 替换为 IPFS CID 或链上 TX）
  const anchorHash = fileHash || generateAnchorHash(description)
  const eid = generateId('evt')

  db.prepare(`
    INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eid, dispute.order_id, submitterId, evidenceType, description, anchorHash)

  const current: string[] = JSON.parse(req.submitted_evidence_ids || '[]')
  current.push(eid)
  db.prepare(`
    UPDATE dispute_evidence_requests
    SET status = 'submitted', submitted_evidence_ids = ?
    WHERE id = ?
  `).run(JSON.stringify(current), requestId)

  return { success: true, evidenceId: eid, anchorHash }
}

/**
 * 查询争议的所有证据请求（含已提交内容）
 */
// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容,内部走 dbAll/dbOne;调用点全部已确认不在 db.transaction 内)。
export async function getEvidenceRequests(
  _db: Database.Database,
  disputeId: string
): Promise<(EvidenceRequest & Record<string, unknown>)[]> {
  const rows = await dbAll<EvidenceRequest & Record<string, unknown>>(`
    SELECT r.*, u.name as requested_from_name, u.role as requested_from_role
    FROM dispute_evidence_requests r
    LEFT JOIN users u ON r.requested_from_id = u.id
    WHERE r.dispute_id = ?
    ORDER BY r.created_at ASC
  `, [disputeId])

  return await Promise.all(rows.map(async r => {
    const ids: string[] = JSON.parse(r.submitted_evidence_ids || '[]')
    const items = ids.length
      ? await dbAll(`SELECT * FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
      : []
    return { ...r, submitted_items: items }
  }))
}

/** 生成锚定哈希（Phase 0 模拟；Phase 2 用 IPFS/链上替换） */
function generateAnchorHash(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  const ts = Date.now().toString(16)
  return `0x${h.toString(16).padStart(8, '0')}${ts}`
}

// ─── 查询函数 ─────────────────────────────────────────────────

export async function getDisputeDetails(
  _db: Database.Database,
  disputeId: string
): Promise<(DisputeRecord & Record<string, unknown>) | null> {
  return (await dbOne<DisputeRecord & Record<string, unknown>>(`
    SELECT d.*,
      u1.name as initiator_name, u1.role as initiator_role,
      u2.name as defendant_name, u2.role as defendant_role,
      o.payment_rail as payment_rail
    FROM disputes d
    LEFT JOIN users u1 ON d.initiator_id = u1.id
    LEFT JOIN users u2 ON d.defendant_id = u2.id
    LEFT JOIN orders o ON d.order_id = o.id
    WHERE d.id = ?
  `, [disputeId])) ?? null
}

export async function getOrderDispute(
  _db: Database.Database,
  orderId: string
): Promise<(DisputeRecord & Record<string, unknown>) | null> {
  return (await dbOne<DisputeRecord & Record<string, unknown>>(`
    SELECT d.*,
      u1.name as initiator_name, u1.role as initiator_role,
      u2.name as defendant_name, u2.role as defendant_role,
      o.payment_rail as payment_rail
    FROM disputes d
    LEFT JOIN users u1 ON d.initiator_id = u1.id
    LEFT JOIN users u2 ON d.defendant_id = u2.id
    LEFT JOIN orders o ON d.order_id = o.id
    WHERE d.order_id = ? AND d.status NOT IN ('resolved', 'dismissed')
    ORDER BY d.created_at DESC LIMIT 1
  `, [orderId])) ?? null
}

export async function getOpenDisputes(_db: Database.Database): Promise<(DisputeRecord & Record<string, unknown>)[]> {
  return await dbAll<DisputeRecord & Record<string, unknown>>(`
    SELECT d.*,
      u1.name as initiator_name, u1.role as initiator_role,
      u2.name as defendant_name, u2.role as defendant_role,
      o.total_amount, o.status as order_status
    FROM disputes d
    LEFT JOIN users u1 ON d.initiator_id = u1.id
    LEFT JOIN users u2 ON d.defendant_id = u2.id
    LEFT JOIN orders o ON d.order_id = o.id
    WHERE d.status IN ('open', 'in_review')
    ORDER BY d.created_at ASC
  `)
}

// ─── 工具函数 ─────────────────────────────────────────────────

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

function getRulingDescription(ruling: string, refundAmount?: number): string {
  switch (ruling) {
    case 'refund_buyer':    return `全额退款 ${refundAmount ?? ''}WAZ 给买家，扣押卖家一半保证金`
    case 'release_seller':  return '资金释放给卖家，交易完成'
    case 'partial_refund':  return `部分退款 ${refundAmount} WAZ 给买家，余款归卖家`
    default: return ruling
  }
}

// 非托管(直付)裁定文案:协议不持货款 → 只表达胜负/责任(信誉裁决),【绝不】写退款/资金释放/仲裁费(那些都不发生)。
function getNonCustodialRulingDescription(ruling: string): string {
  switch (ruling) {
    case 'refund_buyer':    return '裁定已执行：买家胜诉(非托管信誉裁决 —— 协议不持货款,不发生退款/资金释放/仲裁费)'
    case 'release_seller':  return '裁定已执行：卖家胜诉(非托管信誉裁决 —— 不发生退款/资金释放/仲裁费)'
    case 'partial_refund':  return '裁定已执行：部分责任(非托管信誉裁决 —— 不发生退款/资金释放/仲裁费)'
    case 'liability_split': return '裁定已执行：责任分配(非托管信誉裁决 —— 不发生退款/赔付/仲裁费)'
    default: return '裁定已执行：非托管信誉裁决(不动任何资金)'
  }
}
