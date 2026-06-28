/**
 * Direct Pay (Rail 1) — PR-6E AML flag 合规复核/解除 workflow。
 *
 * 给 #108 写入、#107 据以阻断的 aml_flags 提供【唯一受控 review writer】:合规人员把 flag 标记为
 *   cleared / escalated / suspend,并【原子】写一条 admin_audit_log。这【不是】真实 AML vendor 接入,
 *   【不】做真实 STR 申报,【不】碰任何资金/订单/状态机。
 *
 * 边界(铁律):
 *  - 唯一 UPDATE aml_flags 的业务路径(除 #108 的 INSERT-only writer 外)。【绝不】DELETE aml_flags。
 *  - 只改 status / disposition / reviewed_by / reviewed_at / reason;不碰 subject_user_id / rule / severity /
 *    related_order_id / detail / created_at。不写 wallet / escrow / settlement / refund / commission / fund /
 *    tokenomics,不改 order 状态机,不改变 Direct Pay create 行为。
 *  - 决策语义与 #107 breaker(sellerDirectPayAmlClear)对齐:
 *      clear    → status='cleared', disposition='downgrade' —— 解除阻断(覆盖任何旧 suspend,使该 flag 不再阻断)。
 *      escalate → status='escalated', disposition='review_queue' —— 维持阻断(对 medium/high flag,breaker 继续 false)。
 *      suspend  → disposition='suspend'(status 保持不变) —— breaker 因 suspend 优先【一律阻断】(即便 status='cleared')。
 *  - 审计无 PII:detail 仅记 subject_user_id(内部 id)/ decision / 结果 status+disposition。reviewer 自由文本 notes
 *    可能含 PII,【刻意不持久化】:admin_audit_log 不存(PII 红线),aml_flags 也无 reviewer-notes 列(本 PR 遵循
 *    "优先不改 schema",且不污染 monitor 写的 detail=纯聚合数字)。notes 仍是受控 writer 的入参(route 会传),
 *    留待未来若需留存再加最小 additive 列。
 *  - 原子:flag UPDATE + audit INSERT 同一 db.transaction —— 不会出现"改了 flag 没留痕"。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

export type AmlReviewDecision = 'clear' | 'escalate' | 'suspend'
const VALID_DECISIONS = new Set<AmlReviewDecision>(['clear', 'escalate', 'suspend'])

export interface ReviewAmlFlagArgs {
  flagId: string
  reviewerId: string
  decision: string
  notes?: string
}
export interface ReviewAmlFlagResult {
  ok: boolean
  error?: string
  flagId?: string
  subjectUserId?: string
  decision?: AmlReviewDecision
  status?: string
  disposition?: string | null
}

/**
 * 复核单条 aml_flag(唯一受控 writer)。成功返回 { ok:true, ...新状态 };参数/flag 非法返回 { ok:false, error }。
 * 绝不抛(参数与存在性都显式校验)。
 */
export function reviewAmlFlag(db: Database.Database, args: ReviewAmlFlagArgs): ReviewAmlFlagResult {
  const { flagId, reviewerId, decision } = args  // notes: 入参契约的一部分,但刻意不持久化(见文件头 PII/schema 说明)
  if (!flagId || !reviewerId) return { ok: false, error: 'MISSING_ARGS' }
  if (!VALID_DECISIONS.has(decision as AmlReviewDecision)) return { ok: false, error: 'INVALID_DECISION' }

  const flag = db.prepare('SELECT id, subject_user_id, status FROM aml_flags WHERE id = ?')
    .get(flagId) as { id: string; subject_user_id: string; status: string } | undefined
  if (!flag) return { ok: false, error: 'FLAG_NOT_FOUND' }

  // decision → (新 status, 新 disposition)。suspend 保留当前 status,只强制 disposition(breaker suspend 优先 → 继续阻断)。
  let newStatus: string, newDisposition: string
  if (decision === 'clear') { newStatus = 'cleared'; newDisposition = 'downgrade' }
  else if (decision === 'escalate') { newStatus = 'escalated'; newDisposition = 'review_queue' }
  else { newStatus = flag.status; newDisposition = 'suspend' }

  db.transaction(() => {
    // 只改复核相关列(status / disposition / reviewed_by / reviewed_at);notes 不落库(见文件头)。
    db.prepare(`UPDATE aml_flags SET status = ?, disposition = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
      .run(newStatus, newDisposition, reviewerId, flagId)
    // 审计(append-only;无 PII:仅内部 id + 决策 + 结果)。与 UPDATE 同事务 → 改 flag 必留痕。
    db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
      .run('amlrev_' + randomUUID(), reviewerId, 'direct_pay.aml_review', 'aml_flag', flagId,
        JSON.stringify({ subject_user_id: flag.subject_user_id, decision, status: newStatus, disposition: newDisposition }))
  })()

  return { ok: true, flagId, subjectUserId: flag.subject_user_id, decision: decision as AmlReviewDecision, status: newStatus, disposition: newDisposition }
}
