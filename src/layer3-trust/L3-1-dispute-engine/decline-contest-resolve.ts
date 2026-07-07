/**
 * 统一仲裁台 · decline_contest 唯一裁决 domain resolver(PR3)。
 *
 * 所有裁决入口 —— 仲裁员 arbitrate 路由、admin fallback 端点、超时自动兜底 —— 都【必须】调用此函数;
 * 旧 /api/admin/decline-contests/:orderId/resolve 已 410 禁用,不再有旁路。保证同一套:
 *   ① dispute CAS(抢占裁决权,防并发/重复裁决)
 *   ② 按 source 授权(arbitrator: COI+assignment;admin_fallback: COI+仲裁窗口已过+不占用 assignment;timeout_auto: 系统)
 *   ③ 订单【终态到 completed】(uphold: fault_seller→declined_nofault→settleDeclinedNoFault→completed;
 *      reject/timeout: settleFault→completed)—— 不留半闭环
 *   ④ 结算(settleFault/settleDeclinedNoFault,各自 settled_fault_at 幂等)
 *   ⑤ 审计(dispute.audit_log 写 source/actor/decision/auto_resolved_by_timeout)
 * 全部在【单一事务】内;任一 transition/CAS 失败即 throw → 整体回滚(绝不半结算)。
 *
 * 说明:状态机 transition 无结算 hook(纯状态移动)→ 不会与 settle 双付。终态转移用系统账号 sys_protocol 执行
 *   (allowedRoles 含 system;白名单仲裁员 role 多为 buyer,不能直接过 allowedRoles),真实裁决人记在 dispute 上。
 *   通知(买卖双方 toast)与 logAdminAction 由【调用方】在成功后做 —— 不进事务(通知失败不回滚已完成的结算)。
 */
import type Database from 'better-sqlite3'
import { transition, settleFault, settleDeclinedNoFault } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { arbitratorHasConflict } from '../../pwa/arbitrator-lifecycle.js'

export type DcDecision = 'decline_no_fault_upheld' | 'decline_fault_confirmed'
export type DcSource = 'arbitrator' | 'admin_fallback' | 'timeout_auto'

const SYS = 'sys_protocol'   // 终态转移执行者(role=system);真实裁决人记在 dispute

export class DcResolveError extends Error {
  code: string; http: number
  constructor(code: string, message: string, http = 400) { super(message); this.code = code; this.http = http }
}

export interface DcResolveResult { orderId: string; decision: DcDecision; source: DcSource; buyerId: string; sellerId: string }

interface DisputeRow { id: string; order_id: string; initiator_id: string | null; defendant_id: string | null; status: string; dispute_type: string | null; arbitrate_deadline: string | null; assigned_arbitrators: string | null; audit_log: string | null }
interface OrderRow { id: string; buyer_id: string; seller_id: string; status: string; decline_objective_pending: number | null; decline_contested: number | null; settled_fault_at: string | null }

function appendAudit(existing: string | null, entry: Record<string, unknown>): string {
  let log: unknown[] = []
  try { const p = JSON.parse(existing || '[]'); if (Array.isArray(p)) log = p } catch { /* 破损 → 重置为空,不丢新条目 */ }
  log.push(entry)
  return JSON.stringify(log)
}

/**
 * 唯一裁决器。decision 对 timeout_auto 会被强制为 decline_fault_confirmed(硬兜底判卖家违约)。
 * @throws DcResolveError(.http 供路由映射状态码);事务整体回滚。
 */
export function resolveDeclineContestDispute(
  db: Database.Database,
  disputeId: string,
  actorId: string,
  decision: DcDecision,
  reason: string,
  source: DcSource,
): DcResolveResult {
  if (decision !== 'decline_no_fault_upheld' && decision !== 'decline_fault_confirmed') {
    throw new DcResolveError('BAD_DECISION', "decision 必须为 'decline_no_fault_upheld'(维持无责) 或 'decline_fault_confirmed'(驳回判违约)", 400)
  }
  if (!reason || !String(reason).trim()) throw new DcResolveError('REASON_REQUIRED', '必须提供裁决理由', 400)

  const run = db.transaction((): DcResolveResult => {
    const dispute = db.prepare('SELECT id, order_id, initiator_id, defendant_id, status, dispute_type, arbitrate_deadline, assigned_arbitrators, audit_log FROM disputes WHERE id = ?').get(disputeId) as DisputeRow | undefined
    if (!dispute) throw new DcResolveError('DISPUTE_NOT_FOUND', '争议不存在', 404)
    if (dispute.dispute_type !== 'decline_contest') throw new DcResolveError('NOT_DECLINE_CONTEST', '本争议不是拒单举证仲裁', 400)
    if (dispute.status !== 'open' && dispute.status !== 'in_review') throw new DcResolveError('ALREADY_RULED', '本案已裁决', 409)

    const order = db.prepare('SELECT id, buyer_id, seller_id, status, decline_objective_pending, decline_contested, settled_fault_at FROM orders WHERE id = ?').get(dispute.order_id) as OrderRow | undefined
    if (!order) throw new DcResolveError('ORDER_NOT_FOUND', '订单不存在', 404)
    if (order.status !== 'fault_seller' || Number(order.decline_objective_pending) !== 1 || Number(order.decline_contested) !== 1 || order.settled_fault_at) {
      throw new DcResolveError('ORDER_NOT_RESOLVABLE', '订单不是可裁决的【已举证客观拒单临时判责】状态', 409)
    }

    // ── ② 按 source 授权 ──
    let effectiveDecision = decision
    const audit: Record<string, unknown> = { at: new Date().toISOString(), source, actor: actorId, decision }
    if (source === 'arbitrator') {
      if (arbitratorHasConflict(db, order.id, dispute.initiator_id, dispute.defendant_id, actorId)) throw new DcResolveError('ARBITRATOR_CONFLICT_OF_INTEREST', '你是本案当事方,不可仲裁(利益冲突)', 403)
      // assignment CAS:首个仲裁员抢占;已分配他人 → 拒
      let assigned: string[] = []
      try { assigned = JSON.parse(dispute.assigned_arbitrators || '[]') } catch { /* */ }
      if (assigned.length === 0) {
        const claim = db.prepare("UPDATE disputes SET assigned_arbitrators = ? WHERE id = ? AND (assigned_arbitrators IS NULL OR assigned_arbitrators = '[]')").run(JSON.stringify([actorId]), disputeId)
        if (claim.changes === 0) { const fresh = db.prepare('SELECT assigned_arbitrators FROM disputes WHERE id = ?').get(disputeId) as { assigned_arbitrators: string | null } | undefined; try { assigned = JSON.parse(fresh?.assigned_arbitrators || '[]') } catch { /* */ } }
        else assigned = [actorId]
      }
      if (!assigned.includes(actorId)) throw new DcResolveError('NOT_ASSIGNED_ARBITRATOR', '本案已分配给其他仲裁员', 409)
    } else if (source === 'admin_fallback') {
      if (arbitratorHasConflict(db, order.id, dispute.initiator_id, dispute.defendant_id, actorId)) throw new DcResolveError('ARBITRATOR_CONFLICT_OF_INTEREST', '你是本案当事方,不可裁决(利益冲突)', 403)
      // §3 仲裁员优先:仅仲裁窗口(arbitrate_deadline)过后 admin 才可 override
      if (!dispute.arbitrate_deadline || new Date().toISOString() <= dispute.arbitrate_deadline) throw new DcResolveError('FALLBACK_TOO_EARLY', '仲裁窗口未过,admin 兜底裁决尚不可用(仲裁员优先)', 409)
      audit.resolved_by_admin_override = actorId   // 不占用 assigned_arbitrators,以 override 记录
    } else { // timeout_auto
      effectiveDecision = 'decline_fault_confirmed'   // 硬兜底:一律判卖家违约(卖家担客观无责举证责任)
      audit.decision = effectiveDecision
      audit.auto_resolved_by_timeout = true
    }

    // ── ① dispute CAS:抢占裁决权(并发第二人 → 0 行 → throw,不结算)──
    const cas = db.prepare("UPDATE disputes SET status='resolved', ruling_type=?, verdict_reason=?, resolved_at=datetime('now'), audit_log=? WHERE id=? AND status IN ('open','in_review')")
      .run(effectiveDecision, reason, appendAudit(dispute.audit_log, audit), disputeId)
    if (cas.changes === 0) throw new DcResolveError('ALREADY_RULED', '本案已被裁决(并发抢占)', 409)

    // ── ③④ 终态转移 + 结算(用 SYS 执行状态机移动;每步失败即 throw 回滚)──
    const orderId = order.id
    if (effectiveDecision === 'decline_no_fault_upheld') {
      const t1 = transition(db, orderId, 'declined_nofault', SYS, [], `拒单举证仲裁维持无责:${reason}`)
      if (!t1.success) throw new DcResolveError('TRANSITION_FAILED', `转 declined_nofault 失败:${t1.error}`, 500)
      settleDeclinedNoFault(db, orderId)   // 全退买家 + 退卖家质押 + 回补库存(settled_fault_at 幂等)
      const t2 = transition(db, orderId, 'completed', SYS, [], '客观无责裁定结算完成')
      if (!t2.success) throw new DcResolveError('TRANSITION_FAILED', `转 completed 失败:${t2.error}`, 500)
    } else {
      settleFault(db, orderId, 'fault_seller')   // 退款买家 + 罚没卖家质押(settled_fault_at 幂等)
      const t = transition(db, orderId, 'completed', SYS, [], `拒单举证仲裁驳回·判卖家违约:${reason}`)
      if (!t.success) throw new DcResolveError('TRANSITION_FAILED', `转 completed 失败:${t.error}`, 500)
    }
    db.prepare('UPDATE orders SET decline_objective_pending=0, decline_contested=0 WHERE id=?').run(orderId)

    return { orderId, decision: effectiveDecision, source, buyerId: order.buyer_id, sellerId: order.seller_id }
  })

  return run()
}
