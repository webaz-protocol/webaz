/**
 * 统一仲裁台 · fault_refund_claim 唯一裁决 domain resolver(P1-D 方案 A)。
 *
 * 案型:直付判责关单(fault_seller→completed 终态)后,买家主张卖家未场外退款的申索。
 * 与 decline_contest 同一纪律:所有裁决入口(仲裁员 arbitrate 路由 / checkDisputeTimeouts 超时兜底)
 * 都【必须】调用此函数 —— 但与之关键不同:
 *   ★ 零订单状态转移(completed 是终态,绝不重开、绝不二次结算)★ 零资金(非托管,信誉裁决)。
 * 效果仅两项:① dispute CAS resolved(裁决留痕+审计)② 信誉:败诉方 dispute_lost / 胜诉方 dispute_won
 * (recordDisputeReputation,与通用争议同刻度 —— 谁败诉谁担,防滥用对称)。
 *
 * decision:
 *   'refund_confirmed'        卖家举证退款成立 → 卖家胜诉(买家申索不成立)
 *   'refund_failed_confirmed' 卖家未退款成立   → 买家胜诉(卖家信誉追加处罚 + 公开违约留痕)
 * timeout_auto 强制 'refund_failed_confirmed'(被诉方沉默 → 判发起方胜,同通用争议原则)。
 */
import type Database from 'better-sqlite3'
import { recordDisputeReputation } from '../../layer4-economics/L4-3-reputation/reputation-engine.js'
import { arbitratorHasConflict } from '../../pwa/arbitrator-lifecycle.js'

export type FrcDecision = 'refund_confirmed' | 'refund_failed_confirmed'
export type FrcSource = 'arbitrator' | 'timeout_auto'

export class FrcResolveError extends Error {
  code: string; http: number
  constructor(code: string, message: string, http = 400) { super(message); this.code = code; this.http = http }
}

export interface FrcResolveResult { orderId: string; decision: FrcDecision; source: FrcSource; buyerId: string; sellerId: string }

interface DisputeRow { id: string; order_id: string; initiator_id: string | null; defendant_id: string | null; status: string; dispute_type: string | null; assigned_arbitrators: string | null; audit_log: string | null }

function appendAudit(existing: string | null, entry: Record<string, unknown>): string {
  let log: unknown[] = []
  try { const p = JSON.parse(existing || '[]'); if (Array.isArray(p)) log = p } catch { /* 破损 → 重置,不丢新条目 */ }
  log.push(entry)
  return JSON.stringify(log)
}

export function resolveFaultRefundClaim(
  db: Database.Database,
  disputeId: string,
  actorId: string,
  decision: FrcDecision,
  reason: string,
  source: FrcSource,
): FrcResolveResult {
  if (decision !== 'refund_confirmed' && decision !== 'refund_failed_confirmed') {
    throw new FrcResolveError('BAD_DECISION', "decision 必须为 'refund_confirmed'(退款成立) 或 'refund_failed_confirmed'(未退款成立)", 400)
  }
  if (!reason || !String(reason).trim()) throw new FrcResolveError('REASON_REQUIRED', '必须提供裁决理由', 400)

  const run = db.transaction((): FrcResolveResult => {
    const dispute = db.prepare('SELECT id, order_id, initiator_id, defendant_id, status, dispute_type, assigned_arbitrators, audit_log FROM disputes WHERE id = ?').get(disputeId) as DisputeRow | undefined
    if (!dispute) throw new FrcResolveError('DISPUTE_NOT_FOUND', '争议不存在', 404)
    if (dispute.dispute_type !== 'fault_refund_claim') throw new FrcResolveError('NOT_FAULT_REFUND_CLAIM', '本争议不是退款申索仲裁', 400)
    if (dispute.status !== 'open' && dispute.status !== 'in_review') throw new FrcResolveError('ALREADY_RULED', '本案已裁决', 409)

    const order = db.prepare('SELECT id, buyer_id, seller_id FROM orders WHERE id = ?').get(dispute.order_id) as { id: string; buyer_id: string; seller_id: string } | undefined
    if (!order) throw new FrcResolveError('ORDER_NOT_FOUND', '订单不存在', 404)

    let effectiveDecision = decision
    const audit: Record<string, unknown> = { at: new Date().toISOString(), source, actor: actorId, decision }
    if (source === 'arbitrator') {
      if (arbitratorHasConflict(db, order.id, dispute.initiator_id, dispute.defendant_id, actorId)) throw new FrcResolveError('ARBITRATOR_CONFLICT_OF_INTEREST', '你是本案当事方,不可仲裁(利益冲突)', 403)
      // assignment CAS:首个仲裁员抢占;已分配他人 → 拒(镜像 decline-contest)
      let assigned: string[] = []
      try { assigned = JSON.parse(dispute.assigned_arbitrators || '[]') } catch { /* */ }
      if (assigned.length === 0) {
        const claim = db.prepare("UPDATE disputes SET assigned_arbitrators = ? WHERE id = ? AND (assigned_arbitrators IS NULL OR assigned_arbitrators = '[]')").run(JSON.stringify([actorId]), disputeId)
        if (claim.changes === 0) { const fresh = db.prepare('SELECT assigned_arbitrators FROM disputes WHERE id = ?').get(disputeId) as { assigned_arbitrators: string | null } | undefined; try { assigned = JSON.parse(fresh?.assigned_arbitrators || '[]') } catch { /* */ } }
        else assigned = [actorId]
      }
      if (!assigned.includes(actorId)) throw new FrcResolveError('NOT_ASSIGNED_ARBITRATOR', '本案已分配给其他仲裁员', 409)
    } else { // timeout_auto:被诉方(卖家)沉默 → 判发起方(买家)胜
      effectiveDecision = 'refund_failed_confirmed'
      audit.decision = effectiveDecision
      audit.auto_resolved_by_timeout = true
    }

    // dispute CAS:抢占裁决权(并发第二人 → 0 行 → throw,不重复记信誉)
    const cas = db.prepare("UPDATE disputes SET status='resolved', ruling_type=?, verdict_reason=?, resolved_at=datetime('now'), audit_log=? WHERE id=? AND status IN ('open','in_review')")
      .run(effectiveDecision, reason, appendAudit(dispute.audit_log, audit), disputeId)
    if (cas.changes === 0) throw new FrcResolveError('ALREADY_RULED', '本案已被裁决(并发抢占)', 409)

    // 信誉(唯一效果;零资金零状态):败诉方 dispute_lost(-25)/ 胜诉方 dispute_won(+8),与通用争议同刻度
    const buyerWins = effectiveDecision === 'refund_failed_confirmed'
    const winnerId = buyerWins ? order.buyer_id : order.seller_id
    const loserId = buyerWins ? order.seller_id : order.buyer_id
    try { recordDisputeReputation(db, order.id, winnerId, loserId) } catch (e) { console.warn('[frc-resolve rep]', (e as Error).message) }

    return { orderId: order.id, decision: effectiveDecision, source, buyerId: order.buyer_id, sellerId: order.seller_id }
  })

  return run()
}
