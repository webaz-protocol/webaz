/**
 * Direct Pay (Rail 1) RISK-scope 守卫 — 直付 / 直接收款 = RISK scope:强制真人 Passkey 二次确认,
 *   agent【硬拒】(无 Passkey credential 即拒,绝不让 agent 代发起/代批准)。设计稿 §0.4 / RFC-020。
 * 镜像 /api/wallet/withdraw 铁律门:① hasPasskey 检查;② 一次性 purpose-bound WebAuthn gate token。
 *
 * 放在 src/pwa/(与 human-presence.ts 同层),不在 routes/ —— 不计入 routes-seam-guard。
 * consumeGateToken 由调用方注入(server.ts 的 createHumanPresence 实例),便于单测。
 */
import type Database from 'better-sqlite3'

export interface DirectPayGuardResult { ok: boolean; error_code?: string; reason?: string }
export interface DirectPayGuardDeps {
  db: Database.Database
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

/**
 * 直付 / 直接收款 RISK 门:
 *   ① 无 Passkey credential → 硬拒(agent 路径:agent 不可能持有 Passkey assertion → 永远过不了)。
 *   ② 需一次性真人 WebAuthn gate token(purpose-bound, 60s)。
 * 两步都过才返回 ok。无自助批准路径。
 */
export function requireDirectPayHumanPasskey(
  deps: DirectPayGuardDeps,
  args: { userId: string; webauthnToken?: string; purpose: string; validate?: (data: unknown) => boolean },
): DirectPayGuardResult {
  const { db, consumeGateToken } = deps
  const { userId, webauthnToken, purpose, validate } = args
  // ① agent 硬拒:没有 Passkey 凭证的身份(agent)绝不能发起/批准直付
  const hasPk = (db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId) as { n: number }).n > 0
  if (!hasPk) {
    return { ok: false, error_code: 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', reason: '直付/直接收款是 RISK 操作:需绑定 Passkey 并真人二次确认,agent 不可代操作' }
  }
  // ② 一次性 purpose-bound 真人 WebAuthn gate token
  const gate = consumeGateToken(userId, webauthnToken, purpose, validate ?? (() => true))
  if (!gate.ok) return { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: gate.reason || '需真实人工 WebAuthn 验证' }
  return { ok: true }
}
