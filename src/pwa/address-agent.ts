/**
 * RFC-026 PR-5 — 地址的 OAuth 安全双路径(safe scopes address_read_masked / address_change_request)。
 *
 * 读:沿用 PR-2.5 的保守投影不变量 —— 摘要只由 region + 存在性构成,【绝不截取子串】(不给 postal
 * hint/masked 姓名电话;比 RFC-026 spec 示例更保守,经 Codex 硬化的既有纪律优先)。
 *
 * 变更:agent 提交的新地址【只】进 address_change_requests 专表(全文绝不入 action_params/审计/agent
 * 可读面);审批行 action_params 只存 {address_sha256, region}。人在 PWA 审批卡看到全文,Passkey
 * 批准(四元组绑定 params_hash=SHA-256(text+region))后服务端写 users;拒绝即删专表行(清 PII)。
 * 提交后 agent 再读只有 masked 视图 —— 它自己发来的文本不回显。每人同一时间至多一条活跃变更请求
 * (部分唯一索引);同 hash 重复提交幂等重用,异 hash 冲突提示先处理已有请求。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function maskedAddressAgentView(db: Database.Database, humanId: string): Record<string, unknown> {
  const u = db.prepare('SELECT default_address_text, default_address_region FROM users WHERE id = ?').get(humanId) as { default_address_text: string | null; default_address_region: string | null } | undefined
  const has = !!(u?.default_address_text && u.default_address_text.trim())
  const region = (u?.default_address_region && u.default_address_region.trim()) || null
  const pending = db.prepare("SELECT id FROM agent_permission_requests WHERE human_id = ? AND kind = 'address_change' AND status IN ('pending','approved') AND executed_at IS NULL LIMIT 1").get(humanId) as { id: string } | undefined
  return {
    has_default: has,
    address_region: region,
    masked_summary: has ? `saved address on file${region ? ` (${region})` : ''}` : null,
    ...(pending ? { pending_change_request: pending.id, pending_note: `an address change is awaiting Passkey approval (/#agent-approvals/${pending.id})` } : {}),
    note: 'Full address text is NEVER returned to agents (no substrings, no hints). Orders resolve the default server-side; the human manages the full text at webaz.xyz.',
  }
}

export function addressChangeParamsHash(addressText: string, region: string): string {
  return sha(JSON.stringify({ address_text: addressText, region }))
}

export function createAddressChangeRequest(db: Database.Database, args: {
  humanId: string; grantId: string; agentLabel: string; addressText: unknown; region: unknown; generateId: (p: string) => string
}): { ok: true; request_id: string; params_hash: string; duplicate?: boolean } | { ok: false; http: number; error: string; error_code: string; existing_request_id?: string } {
  const { humanId, grantId, agentLabel, generateId } = args
  const text = typeof args.addressText === 'string' ? args.addressText.trim() : ''
  const region = typeof args.region === 'string' ? args.region.trim().toUpperCase() : ''
  if (text.length < 10 || text.length > 500) return { ok: false, http: 400, error: '地址文本须 10..500 字符', error_code: 'ADDRESS_TEXT_INVALID' }
  if (!/^[A-Z]{2}$/.test(region)) return { ok: false, http: 400, error: 'region 须为两位国家/地区码(如 SG)', error_code: 'ADDRESS_REGION_INVALID' }
  const paramsHash = addressChangeParamsHash(text, region)
  const requestId = generateId('apr')
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO agent_permission_requests
          (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, action_params)
        VALUES (?,?,?,?, '[]', 'high', 'once', 'pending', ?, 'address_change', '', 'address_change', ?, ?)`)
        .run(requestId, humanId, grantId, agentLabel, new Date(Date.now() + 24 * 3600_000).toISOString(), paramsHash, JSON.stringify({ address_sha256: sha(text), region }))
      db.prepare('INSERT INTO address_change_requests (request_id, human_id, address_text, region) VALUES (?,?,?,?)').run(requestId, humanId, text, region)
    }).immediate()
    return { ok: true, request_id: requestId, params_hash: paramsHash }
  } catch (e) {
    if (!/UNIQUE|PRIMARY/i.test((e as Error).message)) return { ok: false, http: 503, error: '提交暂不可用,请稍后重试', error_code: 'ADDRESS_CHANGE_UNAVAILABLE' }
    const prev = db.prepare("SELECT id, params_hash, status, expires_at FROM agent_permission_requests WHERE human_id = ? AND kind = 'address_change' AND status IN ('pending','approved') AND executed_at IS NULL LIMIT 1").get(humanId) as { id: string; params_hash: string; status: string; expires_at: string } | undefined
    if (!prev) return { ok: false, http: 409, error: '提交冲突,请重试', error_code: 'ADDRESS_CHANGE_UNAVAILABLE' }
    if (prev.status === 'pending' && prev.expires_at <= new Date().toISOString()) {
      db.prepare("UPDATE agent_permission_requests SET status = 'expired' WHERE id = ? AND status = 'pending'").run(prev.id)
      db.prepare('DELETE FROM address_change_requests WHERE request_id = ?').run(prev.id)   // 过期即清 PII
      return createAddressChangeRequest(db, args)
    }
    if (prev.params_hash === paramsHash) return { ok: true, request_id: prev.id, params_hash: paramsHash, duplicate: true }
    return { ok: false, http: 409, error: '已有一条待批准的地址变更(内容不同)—— 请先在 PWA 批准或拒绝它', error_code: 'ADDRESS_CHANGE_PENDING', existing_request_id: prev.id }
  }
}

/** Passkey 批准后执行:写 users 默认地址(专表全文 → users;同事务 executed_at;全文绝不进返回值)。 */
export function approveAddressChange(db: Database.Database, requestId: string, approverId: string, nowIso: string):
  { ok: true; already_executed?: boolean; region?: string } | { ok: false; http: number; error: string; error_code: string } {
  const r = db.prepare("SELECT human_id, status, expires_at, params_hash, executed_at FROM agent_permission_requests WHERE id = ? AND kind = 'address_change'").get(requestId) as Record<string, unknown> | undefined
  if (!r) return { ok: false, http: 404, error: '变更请求不存在', error_code: 'ADDRESS_CHANGE_NOT_FOUND' }
  if (r.human_id !== approverId) return { ok: false, http: 403, error: '不是你的请求', error_code: 'NOT_YOUR_REQUEST' }
  if (r.executed_at) return { ok: true, already_executed: true }
  const acr = db.prepare('SELECT address_text, region FROM address_change_requests WHERE request_id = ? AND human_id = ?').get(requestId, approverId) as { address_text: string; region: string } | undefined
  if (!acr) return { ok: false, http: 409, error: '待确认内容缺失(可能已被拒绝清除)', error_code: 'ADDRESS_CHANGE_NOT_FOUND' }
  if (addressChangeParamsHash(acr.address_text, acr.region) !== String(r.params_hash)) return { ok: false, http: 409, error: '内容与 Passkey 绑定不一致,拒绝执行', error_code: 'ADDRESS_CHANGE_DRIFT' }
  const claim = db.prepare("UPDATE agent_permission_requests SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?").run(nowIso, requestId, nowIso)
  if (claim.changes !== 1) return { ok: false, http: 409, error: '请求已过期或已处理', error_code: 'ADDRESS_CHANGE_NOT_PENDING' }
  db.transaction(() => {
    db.prepare('UPDATE users SET default_address_text = ?, default_address_region = ? WHERE id = ?').run(acr.address_text, acr.region, approverId)
    db.prepare("UPDATE agent_permission_requests SET executed_at = ?, execution_result = ? WHERE id = ? AND executed_at IS NULL").run(nowIso, JSON.stringify({ ok: true, address_sha256: sha(acr.address_text), region: acr.region }), requestId)
  }).immediate()
  return { ok: true, region: acr.region }
}

/** 人工审批列表附全文(human-authed 本人;域层 sync 读,route 零 seam 计数)。 */
export function addressChangeContentForHuman(db: Database.Database, requestId: string): { address_text: string; region: string } | null {
  const r = db.prepare('SELECT address_text, region FROM address_change_requests WHERE request_id = ?').get(requestId) as { address_text: string; region: string } | undefined
  return r ?? null
}

/** 拒绝时清 PII(路由 reject 分支调用)。 */
export function purgeAddressChangeContent(db: Database.Database, requestId: string): void {
  try { db.prepare('DELETE FROM address_change_requests WHERE request_id = ?').run(requestId) } catch { /* best effort */ }
}
