/**
 * Strict Bearer → protocol-admin resolver for money-path attribution.
 *
 * Used by the withdrawals/approve "dual-accept transition for attribution": prefer a logged-in
 * protocol-admin via Authorization: Bearer, else the route falls back to the shared ADMIN_KEY.
 *
 * Why not reuse getUser(req): getUser is too weak for a money-path bearer decision — it also accepts
 * req.body.api_key and does NOT check suspension or session revocation. This resolver:
 *   - reads ONLY `Authorization: Bearer <api_key>` (never req.body.api_key)
 *   - rejects suspended users (user_moderation.suspended)
 *   - rejects revoked sessions (latest user_sessions row for the key has revoked_at; no row = not revoked,
 *     consistent with auth())
 *   - leaves the role/permission check to the caller (isProtocolAdmin), so it can't drift from the
 *     central hasAdminPermission()
 * Returns the user row only when ALL checks pass; otherwise null. Never returns or logs the key.
 */
import type Database from 'better-sqlite3'

type ReqLike = { headers?: { authorization?: unknown } }

export function resolveBearerProtocolAdmin(
  db: Database.Database,
  req: ReqLike,
  isProtocolAdmin: (user: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const authz = req?.headers?.authorization
  if (typeof authz !== 'string' || !authz.startsWith('Bearer ')) return null   // Bearer only — NOT req.body.api_key
  const key = authz.slice('Bearer '.length).trim()
  if (!key) return null

  const u = db.prepare('SELECT * FROM users WHERE api_key = ?').get(key) as Record<string, unknown> | undefined
  if (!u) return null

  const mod = db.prepare('SELECT suspended FROM user_moderation WHERE user_id = ?').get(u.id) as { suspended: number } | undefined
  if (mod?.suspended) return null   // suspended admin cannot approve

  const session = db.prepare('SELECT revoked_at FROM user_sessions WHERE api_key = ? ORDER BY created_at DESC LIMIT 1')
    .get(key) as { revoked_at: string | null } | undefined
  if (session?.revoked_at) return null   // remotely logged-out session cannot approve

  if (!isProtocolAdmin(u)) return null   // admin role + protocol permission (caller-supplied, central logic)
  return u
}
