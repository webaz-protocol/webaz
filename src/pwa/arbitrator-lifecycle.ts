/**
 * PR-B 仲裁员生产生命周期 —— 域逻辑(唯一授权源 = active arbitrator_whitelist)。
 *
 * 设计约束(Holden):
 *  - active arbitrator_whitelist 是【唯一】授权源;移除 role='arbitrator' 旁路。legacy NULL status 视为 active。
 *  - grant / suspend / reinstate / revoke 全走此域函数;路由层只做 ROOT/admin auth + 真人 Passkey + audit。
 *  - revoked 是【终态】:grant / reinstate 都不得复活被撤销的用户。suspend 可逆,revoke 不可逆。
 *  - 只授权真实人类:拒 sys_protocol / 内部审计号 / system 角色 / 无 Passkey 的账号(合成/agent 无 Passkey → 被拒,
 *    且保证被授权者真的能仲裁 —— 仲裁需现场真人 Passkey)。
 *  - COI:买家/卖家/物流/发起人/被诉人不得仲裁本案。
 *  - sys_protocol 自动裁决【不】经此模块(它走 engine arbitrateDispute 的 role gate),故本模块不影响超时兜底。
 */
import type Database from 'better-sqlite3'

const SYSTEM_ACCOUNT_IDS = new Set(['sys_protocol', 'usr_iaudit_001'])

export type ArbitratorStatus = 'active' | 'suspended' | 'revoked'
type WLRow = { status: string | null } | undefined
const effectiveStatus = (row: WLRow): ArbitratorStatus | null =>
  !row ? null : ((row.status ?? 'active') as ArbitratorStatus)   // legacy NULL = active

export interface ArbEligibility { ok: boolean; reason?: string; via?: 'whitelist' }
export interface ArbMutation { ok: boolean; error_code?: string; error?: string }

/** 仲裁资格:唯一看 active arbitrator_whitelist。role='arbitrator' 不再是旁路。 */
export function isEligibleArbitrator(db: Database.Database, userId: string): ArbEligibility {
  const st = effectiveStatus(db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id = ?').get(userId) as WLRow)
  if (st === null) return { ok: false, reason: '非仲裁员 — 需 active arbitrator_whitelist(role 不再作旁路)' }
  if (st === 'active') return { ok: true, via: 'whitelist' }
  return { ok: false, reason: st === 'suspended' ? '仲裁员资格已暂停' : '仲裁员资格已撤销' }
}

/** 目标必须是可授权的真实人类:非系统/内部号、非 system 角色、已注册 Passkey。 */
function assertGrantableHuman(db: Database.Database, userId: string): ArbMutation | null {
  if (SYSTEM_ACCOUNT_IDS.has(userId)) return { ok: false, error_code: 'NOT_HUMAN', error: '系统/内部账号不可授权为仲裁员' }
  const u = db.prepare('SELECT id, role, roles FROM users WHERE id = ?').get(userId) as { id: string; role: string; roles: string | null } | undefined
  if (!u) return { ok: false, error_code: 'USER_NOT_FOUND', error: '用户不存在' }
  let roles: string[] = []; try { roles = JSON.parse(u.roles || '[]') } catch {}
  if (u.role === 'system' || roles.includes('system')) return { ok: false, error_code: 'NOT_HUMAN', error: 'system 账号不可授权为仲裁员' }
  const hasPk = (db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId) as { n: number }).n > 0
  if (!hasPk) return { ok: false, error_code: 'PASSKEY_REQUIRED', error: '目标需先注册 Passkey(仲裁需真人);合成/agent 账号无 Passkey 故被拒' }
  return null
}

/** 授权为 active 仲裁员。revoked 终态不可复活。 */
export function grantArbitrator(db: Database.Database, p: { userId: string; grantedBy: string; note?: string | null }): ArbMutation {
  const bad = assertGrantableHuman(db, p.userId); if (bad) return bad
  let out: ArbMutation = { ok: true }
  db.transaction(() => {
    const st = effectiveStatus(db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id = ?').get(p.userId) as WLRow)
    if (st === 'revoked') { out = { ok: false, error_code: 'REVOKED_TERMINAL', error: '该用户已被永久撤销仲裁员资格,不可重新授权' }; return }
    if (st === null) {
      db.prepare("INSERT INTO arbitrator_whitelist (user_id, note, is_system, granted_by, status) VALUES (?,?,0,?, 'active')").run(p.userId, p.note ?? '管理员直接授权', p.grantedBy)
    } else {
      db.prepare("UPDATE arbitrator_whitelist SET status='active', granted_by=?, note=?, suspended_at=NULL WHERE user_id=? AND status != 'revoked'").run(p.grantedBy, p.note ?? '管理员直接授权', p.userId)
    }
  })()
  return out
}

/** 暂停(可逆)。revoked 不可暂停。 */
export function suspendArbitrator(db: Database.Database, p: { userId: string; note?: string | null }): ArbMutation {
  const st = effectiveStatus(db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id = ?').get(p.userId) as WLRow)
  if (st === null) return { ok: false, error_code: 'NOT_ARBITRATOR', error: '该用户不是仲裁员' }
  if (st === 'revoked') return { ok: false, error_code: 'REVOKED_TERMINAL', error: '已永久撤销,不可暂停' }
  db.prepare("UPDATE arbitrator_whitelist SET status='suspended', suspended_at=datetime('now') WHERE user_id=? AND status != 'revoked'").run(p.userId)
  return { ok: true }
}

/** 复用(暂停→active)。revoked 终态不可复活。 */
export function reinstateArbitrator(db: Database.Database, p: { userId: string; note?: string | null }): ArbMutation {
  const st = effectiveStatus(db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id = ?').get(p.userId) as WLRow)
  if (st === null) return { ok: false, error_code: 'NOT_ARBITRATOR', error: '该用户不是仲裁员' }
  if (st === 'revoked') return { ok: false, error_code: 'REVOKED_TERMINAL', error: '已永久撤销,不可复用' }
  if (st === 'active') return { ok: false, error_code: 'ALREADY_ACTIVE', error: '仲裁员已是 active' }
  db.prepare("UPDATE arbitrator_whitelist SET status='active', suspended_at=NULL WHERE user_id=? AND status='suspended'").run(p.userId)
  return { ok: true }
}

/** 撤销(终态,不可逆)。active/suspended 均可撤销;已撤销幂等。 */
export function revokeArbitrator(db: Database.Database, p: { userId: string; note?: string | null }): ArbMutation {
  const st = effectiveStatus(db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id = ?').get(p.userId) as WLRow)
  if (st === null) return { ok: false, error_code: 'NOT_ARBITRATOR', error: '该用户不是仲裁员' }
  if (st === 'revoked') return { ok: true }   // 幂等:已终态
  db.prepare("UPDATE arbitrator_whitelist SET status='revoked', revoked_at=datetime('now') WHERE user_id=?").run(p.userId)
  return { ok: true }
}

export interface ArbRosterRow { user_id: string; status: ArbitratorStatus; added_at: string | null; suspended_at: string | null; revoked_at: string | null; granted_by: string | null; is_system: number; note: string | null }
/** 名册(admin 只读)。status NULL 归一为 active 便于展示。 */
export function listArbitrators(db: Database.Database): ArbRosterRow[] {
  const rows = db.prepare(`SELECT user_id, status, added_at, suspended_at, revoked_at, granted_by, is_system, note
    FROM arbitrator_whitelist ORDER BY added_at DESC`).all() as Array<Omit<ArbRosterRow, 'status'> & { status: string | null }>
  return rows.map(r => ({ ...r, status: (r.status ?? 'active') as ArbitratorStatus }))
}

/** COI:当前用户是否为本案当事方(买家/卖家/物流/发起人/被诉人)→ 不得仲裁。 */
export function arbitratorHasConflict(db: Database.Database, orderId: string, initiatorId: string | null, defendantId: string | null, userId: string): boolean {
  const o = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?').get(orderId) as { buyer_id: string | null; seller_id: string | null; logistics_id: string | null } | undefined
  const parties = [o?.buyer_id, o?.seller_id, o?.logistics_id, initiatorId, defendantId]
  return parties.some(p => p != null && p === userId)
}
