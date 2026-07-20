/**
 * Human-presence iron-rule gate — extracted from server.ts (PR-F0, BEHAVIOR-ZERO).
 *
 * Sensitive actions (vote / arbitrate / agent_revoke / delete_passkey / identity_claim) require a
 * single-use, purpose-bound WebAuthn gate token (issued by routes/webauthn.ts → webauthn_gate_tokens).
 * These two helpers were inline in server.ts and only ever injected as a FAKE into routes, so the REAL
 * gate logic had no test seam. The factory form `createHumanPresence(db, getProtocolParam)` avoids
 * global state and makes the real functions unit-testable. Bodies are copied verbatim — no behavior
 * change; existing call sites keep the same signatures.
 *
 * spec: docs/AGENT-GOVERNANCE.md §4 · #1006 (default 0→1) · #1044 (delete_passkey).
 */
import type Database from 'better-sqlite3'

export type HumanPresencePurpose = 'vote' | 'arbitrate' | 'agent_revoke' | 'agent_pair_approve' | 'agent_permission_approve' | 'delete_passkey' | 'identity_claim' | 'oauth_consent_approve' | 'product_action_approve'
export interface GateResult { ok: boolean; reason?: string }
export interface HumanPresenceResult { ok: boolean; reason?: string; error_code?: string; required_when_enabled?: boolean }

export interface HumanPresence {
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => GateResult
  requireHumanPresence: (userId: string, purpose: HumanPresencePurpose, token: string | undefined, paramKey: string, validate?: (data: unknown) => boolean) => HumanPresenceResult
}

export function createHumanPresence(db: Database.Database, getProtocolParam: <T>(key: string, fallback: T) => T): HumanPresence {
  // 验证 gate token:被业务端点(如 /api/wallet/withdraw)消费。
  // M-1: 改 CAS — 先抢占性 UPDATE,只有 changes=1 才认为本次成功消费;然后再读 row 校验
  // user/purpose/业务字段。多副本部署也安全。
  function consumeGateToken(userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean): GateResult {
    if (!token) return { ok: false, reason: '缺少 X-WebAuthn-Token' }
    // 先抢占:未消费 + 未过期 才能 mark consumed
    const claim = db.prepare(`UPDATE webauthn_gate_tokens
      SET consumed_at = datetime('now')
      WHERE id = ? AND consumed_at IS NULL AND expires_at > datetime('now')`).run(token)
    if (claim.changes !== 1) {
      // 抢占失败的两种原因区分(仅用于 reason 文案)
      const exist = db.prepare('SELECT consumed_at FROM webauthn_gate_tokens WHERE id = ?').get(token) as { consumed_at: string | null } | undefined
      if (!exist) return { ok: false, reason: 'token 不存在' }
      if (exist.consumed_at) return { ok: false, reason: 'token 已使用' }
      return { ok: false, reason: 'token 已过期' }
    }
    // 已抢占 → 读 row 校验 user/purpose/业务字段;若校验失败 token 仍然作废(防止枚举攻击下的重试)
    const row = db.prepare(`SELECT user_id, purpose, purpose_data FROM webauthn_gate_tokens WHERE id = ?`)
      .get(token) as { user_id: string; purpose: string; purpose_data: string | null }
    if (row.user_id !== userId) return { ok: false, reason: 'token 用户不匹配' }
    if (row.purpose !== purpose) return { ok: false, reason: 'token 用途不匹配' }
    let data: unknown = null
    try { data = row.purpose_data ? JSON.parse(row.purpose_data) : null } catch {}
    if (!validate(data)) return { ok: false, reason: 'token 业务参数不匹配' }
    return { ok: true }
  }

  // ─── Agent 治理铁律:人工铁律节点 ───
  // 关键节点(verifier 投票 / arbitrator 仲裁 / agent_revoke / delete_passkey / identity_claim)必须真实
  // 人工参与,agent 代操作被拦截。实现:要求 webauthn_gate_token(一次性 · 60s)+ 协议参数开关。
  // is_system fixture 旁路【只对 vote 生效】。PR-C:arbitrate 旁路已移除 —— HTTP 人类仲裁路由所有真人仲裁员都必须
  //   现场 Passkey(consumeGateToken)。sys_protocol 自动裁决走 engine arbitrateDispute(role=system,不经此函数),不受影响。
  function requireHumanPresence(userId: string, purpose: HumanPresencePurpose, token: string | undefined, paramKey: string, validate: (data: unknown) => boolean = () => true): HumanPresenceResult {
    const enabled = Number(getProtocolParam<number>(paramKey, 1)) === 1
    if (!enabled) return { ok: true }  // 协议参数关闭 → 不强制

    if (purpose === 'vote') {
      const wl = db.prepare('SELECT is_system FROM verifier_whitelist WHERE user_id = ?').get(userId) as { is_system: number } | undefined
      if (wl?.is_system === 1) return { ok: true }
    }

    const result = consumeGateToken(userId, token, purpose, validate)
    if (!result.ok) {
      return { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: result.reason || '此操作需真实人工 WebAuthn 验证', required_when_enabled: true }
    }
    return { ok: true }
  }

  return { consumeGateToken, requireHumanPresence }
}
