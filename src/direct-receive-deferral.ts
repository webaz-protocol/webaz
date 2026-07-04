/**
 * Direct Pay (Rail 1) — base-bond 缓交(deferred deposit)生命周期。设计稿 §10.3 / Phase 5。
 *
 * 商户可【先入场、保证金延后交】:申请 → 真人 admin 审批(【绝不】自动批)→ granted(缓交期 + 宽限期 + 压低配额)
 *   → 到期 → 宽限 → 停权。本模块只做【状态机 + 时钟锚点】,不动任何真实资金、不碰 wallet/escrow/settlement/refund。
 *
 * 铁律:
 *  - 人工批(责任分层):本 helper 仅要求【调用方传入非空 adminId】、无自动授予路径。**ROOT / Passkey / human-presence
 *    的强制在调用方(admin route)**——helper 不验证身份/凭证,只记录 caller 声明的 adminId(approve/reject 同理)。
 *  - 不零威慑:缓交期配额系数【压低且有下限】(clampReducedQuotaFactor:∈[min,max],min>0、max<1)—— 缓交不是免责。
 *  - 到期→宽限→停权:granted 有 expires_at(缓交到期)+ grace_until(宽限截止);超过 grace_until → expired,
 *    由调用方(cron/PR2)据此停权(本模块只置 expired 状态 + 返回受影响 user,不直接改 privileges,保持隔离)。
 *  - 单一活跃:同一 user 同时只允许一条活跃(pending 或 未过 grace 的 granted)缓交。
 *  - now 由调用方传入(确定性,便于测试);不可解析时间 → fail-closed。
 */
import type Database from 'better-sqlite3'

export type DeferralStatus = 'pending' | 'granted' | 'rejected' | 'expired' | 'satisfied'   // satisfied(B4)=缓交期间缴清保证金转正式

export interface DeferralConfig {
  defaultPeriodDays: number
  defaultGraceDays: number
  minReducedQuotaFactor: number   // >0:不零威慑下限
  maxReducedQuotaFactor: number   // <1:缓交期必压低
  maxPeriodDays: number           // 缓交期上限:防卖家提交超大期限 → approve 时日期溢出 RangeError / 超长期缓交
  maxGraceDays: number            // 宽限期上限:同上(approve 用 period+grace 算 grace_until,任一超大都会溢出)
}
export const DEFAULT_DEFERRAL_CONFIG: DeferralConfig = {
  defaultPeriodDays: 30, defaultGraceDays: 7, minReducedQuotaFactor: 0.1, maxReducedQuotaFactor: 0.9,
  maxPeriodDays: 365, maxGraceDays: 90,
}

export type DeferralOpResult =
  | { ok: true; status: DeferralStatus; already?: boolean }
  | { ok: false; reason: string }

interface DeferralRow {
  id: string; user_id: string; status: string; period_days: number
  reduced_quota_factor: number; expires_at: string | null; grace_until: string | null
}

const isPosInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0
const getRow = (db: Database.Database, id: string): DeferralRow | undefined =>
  db.prepare('SELECT id, user_id, status, period_days, reduced_quota_factor, expires_at, grace_until FROM direct_receive_deferrals WHERE id = ?').get(id) as DeferralRow | undefined

/** 配额系数夹到 [min,max](不零威慑 + 缓交期必压低);非法/缺省 → 配置默认中点。 */
export function clampReducedQuotaFactor(factor: number | undefined, config: DeferralConfig = DEFAULT_DEFERRAL_CONFIG): number {
  const lo = config.minReducedQuotaFactor, hi = config.maxReducedQuotaFactor
  const f = typeof factor === 'number' && Number.isFinite(factor) ? factor : (lo + hi) / 2
  return Math.min(hi, Math.max(lo, f))
}

/** 是否有【活跃】缓交(pending,或 granted 且未过 grace_until)。活跃则禁止再申请。 */
function hasActiveDeferral(db: Database.Database, userId: string, nowIso: string): boolean {
  const rows = db.prepare("SELECT status, grace_until FROM direct_receive_deferrals WHERE user_id = ? AND status IN ('pending','granted')").all(userId) as Array<{ status: string; grace_until: string | null }>
  const now = Date.parse(nowIso)
  return rows.some(r => r.status === 'pending' || !r.grace_until || !Number.isFinite(Date.parse(r.grace_until)) || Date.parse(r.grace_until) > now)
}

/** 申请缓交(商户发起)→ pending。绝不自动授予。 */
export function requestDeferral(db: Database.Database, args: {
  deferralId: string; userId: string; periodDays?: number; reason?: string; nowIso: string; config?: DeferralConfig
}): DeferralOpResult {
  const { deferralId, userId, reason, nowIso } = args
  const config = args.config ?? DEFAULT_DEFERRAL_CONFIG
  if (!deferralId || !userId) return { ok: false, reason: 'missing deferralId/userId' }
  if (!Number.isFinite(Date.parse(nowIso))) return { ok: false, reason: 'unparseable nowIso' }
  if (getRow(db, deferralId)) return { ok: false, reason: 'deferral id already exists' }
  const periodDays = args.periodDays ?? config.defaultPeriodDays
  if (!isPosInt(periodDays)) return { ok: false, reason: 'periodDays must be a positive integer' }
  // 上限校验:超大 periodDays 会在 approve 时令 new Date(now + days*86_400_000) 溢出 → RangeError(approve 500)。
  //   在【申请入口】就 fail-closed,既挡 500 也挡超长期缓交。
  if (periodDays > config.maxPeriodDays) return { ok: false, reason: `periodDays exceeds max (${config.maxPeriodDays})` }
  if (hasActiveDeferral(db, userId, nowIso)) return { ok: false, reason: 'user already has an active deferral' }
  db.prepare(`INSERT INTO direct_receive_deferrals (id, user_id, reason, period_days, status, created_at)
    VALUES (?,?,?,?, 'pending', datetime('now'))`).run(deferralId, userId, reason ?? null, periodDays)
  return { ok: true, status: 'pending' }
}

/** 审批通过 → granted。设缓交到期 + 宽限截止 + 压低配额。仅要求 caller 传非空 adminId(无自动批);
 *  ROOT/Passkey/human-presence 由【调用方 route】强制,helper 不验证身份。 */
export function approveDeferral(db: Database.Database, args: {
  deferralId: string; adminId: string; nowIso: string; graceDays?: number; reducedQuotaFactor?: number; config?: DeferralConfig
}): DeferralOpResult {
  const { deferralId, adminId, nowIso } = args
  const config = args.config ?? DEFAULT_DEFERRAL_CONFIG
  if (!adminId) return { ok: false, reason: 'approveDeferral requires a human adminId (no auto-grant)' }
  const row = getRow(db, deferralId)
  if (!row) return { ok: false, reason: 'deferral not found' }
  if (row.status === 'granted') return { ok: true, status: 'granted', already: true }
  if (row.status !== 'pending') return { ok: false, reason: `cannot approve from status '${row.status}'` }
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return { ok: false, reason: 'unparseable nowIso' }
  const graceDays = args.graceDays ?? config.defaultGraceDays
  if (!isPosInt(row.period_days) || !(Number.isInteger(graceDays) && graceDays >= 0)) return { ok: false, reason: 'invalid period/grace days' }
  // 上限校验(防溢出 / 超长期):period 是申请时存的(理应已被 requestDeferral 卡住,这里防御 legacy/旁路行),
  //   grace 是 admin 本次输入。任一超大都会让 new Date(now + (period+grace)*86_400_000) 溢出 → RangeError。
  //   返回【结构化错误】(由 route 转 409),绝不抛 → 杜绝"消耗 Passkey token 后 500"。
  if (row.period_days > config.maxPeriodDays) return { ok: false, reason: `periodDays exceeds max (${config.maxPeriodDays})` }
  if (graceDays > config.maxGraceDays) return { ok: false, reason: `graceDays exceeds max (${config.maxGraceDays})` }
  const expiresAt = new Date(now + row.period_days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const graceUntil = new Date(now + (row.period_days + graceDays) * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const factor = clampReducedQuotaFactor(args.reducedQuotaFactor, config)
  db.prepare(`UPDATE direct_receive_deferrals SET status = 'granted', approved_by = ?, approved_at = datetime('now'),
    expires_at = ?, grace_until = ?, reduced_quota_factor = ? WHERE id = ?`)
    .run(adminId, expiresAt, graceUntil, factor, deferralId)
  return { ok: true, status: 'granted' }
}

/** 真人 admin 拒绝 → rejected。 */
export function rejectDeferral(db: Database.Database, args: { deferralId: string; adminId: string }): DeferralOpResult {
  if (!args.adminId) return { ok: false, reason: 'rejectDeferral requires a human adminId' }
  const row = getRow(db, args.deferralId)
  if (!row) return { ok: false, reason: 'deferral not found' }
  if (row.status === 'rejected') return { ok: true, status: 'rejected', already: true }
  if (row.status !== 'pending') return { ok: false, reason: `cannot reject from status '${row.status}'` }
  db.prepare("UPDATE direct_receive_deferrals SET status = 'rejected', approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(args.adminId, args.deferralId)
  return { ok: true, status: 'rejected' }
}

/**
 * 取某 user 当前【生效中】的缓交(granted 且 now ≤ grace_until)。无 → null。供 PR2 eligibility / 配额读取。
 * 【FAIL-CLOSED】:grace_until 或 expires_at 为空/不可解析 = 坏 granted 行,**绝不**当作 active(返回 null 跳过)。
 *   语义与 expireDeferrals 一致(坏行视为可清理/不生效),杜绝"坏 granted 行被误认有效缓交"放进 eligibility。
 */
export function getActiveDeferral(db: Database.Database, userId: string, nowIso: string): { id: string; reducedQuotaFactor: number; expiresAt: string | null; graceUntil: string | null; inGrace: boolean } | null {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return null
  const rows = db.prepare("SELECT id, reduced_quota_factor, expires_at, grace_until FROM direct_receive_deferrals WHERE user_id = ? AND status = 'granted'").all(userId) as Array<{ id: string; reduced_quota_factor: number; expires_at: string | null; grace_until: string | null }>
  for (const r of rows) {
    const grace = r.grace_until ? Date.parse(r.grace_until) : NaN
    const exp = r.expires_at ? Date.parse(r.expires_at) : NaN
    // fail-closed:两个时钟锚点都必须是合法时间;grace 必须在未来。任一空/坏 → 跳过(不承认为 active)。
    if (Number.isFinite(grace) && Number.isFinite(exp) && grace > now) {
      return { id: r.id, reducedQuotaFactor: r.reduced_quota_factor, expiresAt: r.expires_at, graceUntil: r.grace_until, inGrace: now > exp }
    }
  }
  return null
}

/** 取某 user【最新一条】缓交申请(任意状态)。无 → null。纯读。供卖家自助 status 端点展示当前申请状态。 */
export function getLatestDeferral(db: Database.Database, userId: string): {
  id: string; status: string; period_days: number; reduced_quota_factor: number
  expires_at: string | null; grace_until: string | null; created_at: string | null
} | null {
  // created_at 同秒并列时用 rowid(插入序)兜底,保证"最新"=最后插入,确定性。
  return (db.prepare(`SELECT id, status, period_days, reduced_quota_factor, expires_at, grace_until, created_at
    FROM direct_receive_deferrals WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId) as {
      id: string; status: string; period_days: number; reduced_quota_factor: number
      expires_at: string | null; grace_until: string | null; created_at: string | null
    } | undefined) ?? null
}

/** 列出缓交申请(admin 视图)。可按 status 过滤;默认全部。最新在前。纯读,不改任何状态。供 admin route 渲染审批队列。 */
export interface DeferralListRow {
  id: string; user_id: string; reason: string | null; period_days: number; reduced_quota_factor: number
  status: string; approved_by: string | null; approved_at: string | null
  expires_at: string | null; grace_until: string | null; created_at: string | null
}
export function listDeferrals(db: Database.Database, opts: { status?: DeferralStatus } = {}): DeferralListRow[] {
  const cols = 'id, user_id, reason, period_days, reduced_quota_factor, status, approved_by, approved_at, expires_at, grace_until, created_at'
  if (opts.status) {
    return db.prepare(`SELECT ${cols} FROM direct_receive_deferrals WHERE status = ? ORDER BY created_at DESC, rowid DESC`).all(opts.status) as DeferralListRow[]
  }
  return db.prepare(`SELECT ${cols} FROM direct_receive_deferrals ORDER BY created_at DESC, rowid DESC`).all() as DeferralListRow[]
}

// ───── B4:缓交收口 —— 到期前提醒 / 缴清转正式 / 到期停权 helper ─────────────────────────────
/** 即将到期且未提醒过的 granted 缓交(expires_at 在 now..now+withinDays 内)。cron 提醒用;提醒后 markDeferralReminded 去重。 */
export function listExpiringDeferrals(db: Database.Database, nowIso: string, withinDays: number): Array<{ id: string; user_id: string; expires_at: string }> {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return []
  const rows = db.prepare("SELECT id, user_id, expires_at FROM direct_receive_deferrals WHERE status = 'granted' AND reminder_sent_at IS NULL AND expires_at IS NOT NULL").all() as Array<{ id: string; user_id: string; expires_at: string }>
  const horizon = now + Math.max(0, withinDays) * 86_400_000
  return rows.filter(r => { const e = Date.parse(r.expires_at); return Number.isFinite(e) && e > now && e <= horizon })
}
export function markDeferralReminded(db: Database.Database, deferralId: string): void {
  db.prepare("UPDATE direct_receive_deferrals SET reminder_sent_at = datetime('now') WHERE id = ? AND reminder_sent_at IS NULL").run(deferralId)
}

/** 缴清转正式(B4):生产保证金确认后调用 —— 该 user 的 granted 缓交 → satisfied(解除缓交额度压低;
 *  入场门此后经 bond 满足)。返回转化条数。 */
export function satisfyDeferralOnBond(db: Database.Database, userId: string): number {
  return db.prepare("UPDATE direct_receive_deferrals SET status = 'satisfied', satisfied_at = datetime('now') WHERE user_id = ? AND status = 'granted'").run(userId).changes
}

/** 到期停权(B4):expireDeferrals 的调用方用 —— 该 user 无生产 bond 时把 privilege 置 suspended(理由 deferral_expired)。
 *  有生产 bond(缓交期间已缴清但 satisfied 漏转的兜底)→ 不停权。 */
export function suspendPrivilegeOnDeferralExpiry(db: Database.Database, userId: string): boolean {
  const hasBond = !!db.prepare("SELECT 1 FROM direct_receive_deposits WHERE user_id = ? AND status = 'locked' AND production_receipt_confirmed_at IS NOT NULL LIMIT 1").get(userId)
  if (hasBond) return false
  db.prepare(`INSERT INTO direct_receive_privileges (user_id, status, tier, suspended_reason, updated_at)
    VALUES (?, 'suspended', 'T0', 'deferral_expired', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET status='suspended', suspended_reason='deferral_expired', updated_at=datetime('now')`).run(userId)
  return true
}

/** 到期清理(cron):granted 且【超过 grace_until】→ expired。返回受影响的 user_id(调用方据此停权;本模块不改 privileges —— 停权用 suspendPrivilegeOnDeferralExpiry)。 */
export function expireDeferrals(db: Database.Database, nowIso: string): { expired: string[] } {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return { expired: [] }
  const rows = db.prepare("SELECT id, user_id, grace_until FROM direct_receive_deferrals WHERE status = 'granted'").all() as Array<{ id: string; user_id: string; grace_until: string | null }>
  const expired: string[] = []
  const tx = db.transaction(() => {
    for (const r of rows) {
      const grace = r.grace_until ? Date.parse(r.grace_until) : NaN
      if (!Number.isFinite(grace) || grace <= now) {
        db.prepare("UPDATE direct_receive_deferrals SET status = 'expired' WHERE id = ?").run(r.id)
        expired.push(r.user_id)
      }
    }
  })
  tx()
  return { expired }
}
