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

// expires_at 形态:reader 用 `expires_at > datetime('now')` 做【字符串比较】,datetime('now') = 'YYYY-MM-DD HH:MM:SS'。
//   任意字符串(如 'not-a-date')会被字典序当成"未来"→ 错误地通过 fail-closed reader。故 ingress 必须校验+规范化:
//   只接受 SQLite datetime 'YYYY-MM-DD HH:MM:SS' 或完整 ISO-8601,且能真实解析;ISO 一律规范化为可比的 SQLite 格式。
const SQLITE_DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/
/** 校验+规范化 expiresAt:空→null(无期限,允许);合法→可比的 'YYYY-MM-DD HH:MM:SS';非法→ false。 */
export function normalizeExpiry(expiresAt?: string): { ok: true; value: string | null } | { ok: false } {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return { ok: true, value: null }
  if (SQLITE_DT_RE.test(expiresAt)) {
    const ms = Date.parse(expiresAt.replace(' ', 'T') + 'Z')   // 当作 UTC 校验真实性(如 13 月 / 99 时 → NaN)
    return Number.isFinite(ms) ? { ok: true, value: expiresAt } : { ok: false }
  }
  if (ISO_DT_RE.test(expiresAt)) {
    const ms = Date.parse(expiresAt)
    return Number.isFinite(ms) ? { ok: true, value: new Date(ms).toISOString().slice(0, 19).replace('T', ' ') } : { ok: false }
  }
  return { ok: false }
}

/** providerRef → 审计用短引用(sha256 前 16 hex);无则 undefined。原值不进审计明文。 */
function providerRefHash(providerRef?: string): string | undefined {
  if (!providerRef) return undefined
  return createHash('sha256').update(providerRef).digest('hex').slice(0, 16)
}

/**
 * AML detail allowlist key 集 —— 与 #108 monitor 实际写入的聚合字段一致(velocity/concentration)。
 * key 也走 allowlist(不止 value):杜绝把 PII 藏进 key(如 {"alice@example.com":1} / {"wallet_0x..":1})。
 */
export const AML_DETAIL_KEYS = new Set(['window_hours', 'order_count', 'threshold', 'small_order_count', 'small_order_amount'])

/**
 * AML detail = 仅【allowlist key + 聚合数字 value】(与 #108 monitor 纪律一致,防 PII 落库:
 *   邮箱/地址/钱包/叙述性笔记无论藏在 value 还是 key 一律拒)。undefined 视为"无 detail"(合法)。
 */
export function isNumericDetail(detail: unknown): boolean {
  if (detail === undefined || detail === null) return true
  if (typeof detail !== 'object' || Array.isArray(detail)) return false
  return Object.entries(detail as Record<string, unknown>).every(
    ([k, v]) => AML_DETAIL_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v))
}

/**
 * AML detail 的 canonical hash(key 排序后 JSON → sha256 前 16 hex),供 Passkey purpose_data 绑定【写入内容】用
 *   (route 与签名方用同一函数,保证"签的 detail = 写的 detail")。无 detail → 固定 'none'。
 */
export function amlDetailHash(detail?: Record<string, unknown>): string {
  if (detail === undefined || detail === null) return 'none'
  const canonical = JSON.stringify(Object.keys(detail).sort().reduce((o, k) => { o[k] = (detail as Record<string, unknown>)[k]; return o }, {} as Record<string, unknown>))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
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
  const exp = normalizeExpiry(expiresAt)
  if (!exp.ok) return { ok: false, error: 'INVALID_EXPIRES_AT' }
  const id = 'kyb_' + randomUUID()
  db.transaction(() => {
    db.prepare(`INSERT INTO direct_receive_kyb_reviews (id, user_id, status, reviewed_by, reviewed_at, expires_at, reason)
      VALUES (?,?,?,?,datetime('now'),?,?)`).run(id, userId, status, reviewerId, exp.value, providerRef ?? null)
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
  const exp = normalizeExpiry(expiresAt)
  if (!exp.ok) return { ok: false, error: 'INVALID_EXPIRES_AT' }
  const id = 'sc_' + randomUUID()
  db.transaction(() => {
    db.prepare(`INSERT INTO sanctions_screening (id, user_id, status, source, reason, screened_at, expires_at)
      VALUES (?,?,?,?,?,datetime('now'),?)`).run(id, userId, status, 'manual_ingress', providerRef ?? null, exp.value)
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
  // P2: detail 仅允许聚合数字(防 PII 落库)。非纯数字 → fail-closed,不写。
  if (!isNumericDetail(detail)) return { ok: false, error: 'INVALID_DETAIL' }
  const id = 'amlf_' + randomUUID()
  db.transaction(() => {
    db.prepare(`INSERT INTO aml_flags (id, subject_user_id, related_order_id, rule, severity, detail, status)
      VALUES (?,?,?,?,?,?,?)`).run(id, userId, relatedOrderId ?? null, rule, severity, detail ? JSON.stringify(detail) : null, status)
    writeAudit(db, reviewerId, 'direct_pay.aml_ingress', 'aml_flag', id,
      { subject_user_id: userId, rule, severity, aml_status: status, related_order_id: relatedOrderId ?? null })
  })()
  return { ok: true, id }
}
