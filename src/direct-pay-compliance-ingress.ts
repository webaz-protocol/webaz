/**
 * Direct Pay (Rail 1) — PR-6F 合规 ingress scaffold(受控写入入口)。
 *
 * 为 Phase 6 的 runtime invariants(KYB / sanctions reader、AML breaker、monitor writer、review workflow)
 *   提供【人工 / 未来 vendor adapter 可复用】的受控写入入口。本 PR【不】接真实第三方 vendor、【不】外呼网络、
 *   【不】做真实 STR 申报,也【不】让 Direct Pay production-ready。
 *
 * 三个 append-only writer(各写自己的台账 + 一条 admin_audit_log,同一 db.transaction):
 *   recordKybReview         → direct_receive_kyb_reviews
 *   recordSanctionsScreening→ sanctions_screening
 *   recordAmlFlagIngress    → aml_flags
 *
 * 铁律:
 *  - append-only / 保留历史:每次都【INSERT 新行】,绝不 UPDATE/DELETE 既有台账或审计记录。
 *    (KYB/sanctions reader 用"存在 approved/clear+未过期 且 无 bad 行"语义,累积历史天然可用。)
 *  - status / severity / rule 全 allowlist;未知值【fail-closed】直接拒,不写任何行、不写审计。
 *  - admin_audit_log.detail 无 PII:仅内部 id、status/severity/rule、provider_ref 的【短 hash】、有无 expiry 布尔。
 *    providerRef 原值只落到台账自身的 reason 字段(运营记录),【不】进审计明文。
 *  - 不外呼网络、不接 vendor API;不写 wallet/escrow/settlement/refund/commission/fund/tokenomics;
 *    不改 order 状态机、不改变 Direct Pay create 行为。Direct Pay 仍 non-launchable / fail-closed。
 */
import type Database from 'better-sqlite3'
import { randomUUID, createHash } from 'crypto'

// ── allowlists(未知值 fail-closed)──
const KYB_STATUSES = new Set(['pending', 'approved', 'rejected', 'revoked'])
const SANCTIONS_STATUSES = new Set(['clear', 'flagged', 'blocked'])
const AML_RULES = new Set(['structuring', 'concentration', 'cumulative', 'crypto', 'velocity'])
const AML_SEVERITIES = new Set(['low', 'medium', 'high'])
const AML_STATUSES = new Set(['open', 'reviewing', 'cleared', 'escalated', 'str_filed'])

export interface IngressResult { ok: boolean; error?: string; id?: string }

/** providerRef → 审计用短引用(sha256 前 16 hex);无则 undefined。原值不进审计明文。 */
function providerRefHash(providerRef?: string): string | undefined {
  if (!providerRef) return undefined
  return createHash('sha256').update(providerRef).digest('hex').slice(0, 16)
}

/** 审计写入(append-only;PII-free)。与台账 INSERT 同事务调用。 */
function writeAudit(db: Database.Database, adminId: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown>): void {
  db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
    .run('cing_' + randomUUID(), adminId, action, targetType, targetId, JSON.stringify(detail))
}

export interface RecordKybReviewArgs { userId: string; reviewerId: string; status: string; providerRef?: string; expiresAt?: string }
/** KYB 复核结论 ingress(append-only)。status ∈ {pending,approved,rejected,revoked}。 */
export function recordKybReview(db: Database.Database, args: RecordKybReviewArgs): IngressResult {
  const { userId, reviewerId, status, providerRef, expiresAt } = args
  if (!userId || !reviewerId) return { ok: false, error: 'MISSING_ARGS' }
  if (!KYB_STATUSES.has(status)) return { ok: false, error: 'INVALID_STATUS' }
  const id = 'kyb_' + randomUUID()
  db.transaction(() => {
    db.prepare(`INSERT INTO direct_receive_kyb_reviews (id, user_id, status, reviewed_by, reviewed_at, expires_at, reason)
      VALUES (?,?,?,?,datetime('now'),?,?)`).run(id, userId, status, reviewerId, expiresAt ?? null, providerRef ?? null)
    writeAudit(db, reviewerId, 'direct_pay.kyb_ingress', 'user', userId,
      { kyb_status: status, provider_ref_hash: providerRefHash(providerRef), has_expiry: !!expiresAt, review_id: id })
  })()
  return { ok: true, id }
}

export interface RecordSanctionsScreeningArgs { userId: string; reviewerId: string; status: string; providerRef?: string; expiresAt?: string }
/** 制裁筛查结论 ingress(append-only)。status ∈ {clear,flagged,blocked}。 */
export function recordSanctionsScreening(db: Database.Database, args: RecordSanctionsScreeningArgs): IngressResult {
  const { userId, reviewerId, status, providerRef, expiresAt } = args
  if (!userId || !reviewerId) return { ok: false, error: 'MISSING_ARGS' }
  if (!SANCTIONS_STATUSES.has(status)) return { ok: false, error: 'INVALID_STATUS' }
  const id = 'sc_' + randomUUID()
  db.transaction(() => {
    db.prepare(`INSERT INTO sanctions_screening (id, user_id, status, source, reason, screened_at, expires_at)
      VALUES (?,?,?,?,?,datetime('now'),?)`).run(id, userId, status, 'manual_ingress', providerRef ?? null, expiresAt ?? null)
    writeAudit(db, reviewerId, 'direct_pay.sanctions_ingress', 'user', userId,
      { sanctions_status: status, provider_ref_hash: providerRefHash(providerRef), has_expiry: !!expiresAt, screening_id: id })
  })()
  return { ok: true, id }
}

export interface RecordAmlFlagIngressArgs { userId: string; reviewerId: string; rule: string; severity: string; status: string; relatedOrderId?: string; detail?: Record<string, unknown> }
/** AML flag ingress(append-only,新建 flag)。rule/severity/status 全 allowlist。 */
export function recordAmlFlagIngress(db: Database.Database, args: RecordAmlFlagIngressArgs): IngressResult {
  const { userId, reviewerId, rule, severity, status, relatedOrderId, detail } = args
  if (!userId || !reviewerId) return { ok: false, error: 'MISSING_ARGS' }
  if (!AML_RULES.has(rule)) return { ok: false, error: 'INVALID_RULE' }
  if (!AML_SEVERITIES.has(severity)) return { ok: false, error: 'INVALID_SEVERITY' }
  if (!AML_STATUSES.has(status)) return { ok: false, error: 'INVALID_STATUS' }
  const id = 'amlf_' + randomUUID()
  db.transaction(() => {
    db.prepare(`INSERT INTO aml_flags (id, subject_user_id, related_order_id, rule, severity, detail, status)
      VALUES (?,?,?,?,?,?,?)`).run(id, userId, relatedOrderId ?? null, rule, severity, detail ? JSON.stringify(detail) : null, status)
    writeAudit(db, reviewerId, 'direct_pay.aml_ingress', 'aml_flag', id,
      { subject_user_id: userId, rule, severity, aml_status: status, related_order_id: relatedOrderId ?? null })
  })()
  return { ok: true, id }
}
