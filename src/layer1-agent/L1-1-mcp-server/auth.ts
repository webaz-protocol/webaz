/**
 * L1-7 · Agent 身份验证
 * Agent 调用任何需要权限的工具时，必须提供 api_key。
 * api_key 在注册时生成，绑定到用户角色。
 */

import Database from 'better-sqlite3'

export interface AuthUser {
  id: string
  name: string
  handle: string
  role: string
  roles: string       // JSON array string
  api_key: string
}

export function authenticate(
  db: Database.Database,
  apiKey: string
): AuthUser | null {
  if (!apiKey || apiKey === '') return null
  const user = db
    .prepare('SELECT id, name, handle, role, roles, api_key FROM users WHERE api_key = ?')
    .get(apiKey) as AuthUser | null
  if (!user) return null
  // Firebreak: a suspended account (e.g. an emergency-frozen admin) must FAIL the api_key path too —
  // not only the PWA session path (server.ts auth() blocks suspended before session use). The MCP path
  // authenticates by api_key with no session, so honor user_moderation here. fail-closed: suspended →
  // no access. Single chokepoint, so every caller of authenticate (incl. requireAuth) is covered.
  const mod = db
    .prepare('SELECT suspended FROM user_moderation WHERE user_id = ?')
    .get(user.id) as { suspended?: number } | undefined
  if (mod && mod.suspended) return null
  return user
}

export function requireAuth(
  db: Database.Database,
  apiKey: string
): { user: AuthUser } | { error: string } {
  const user = authenticate(db, apiKey)
  if (!user) {
    return {
      error: '身份验证失败：api_key 无效。请先用 dcp_register 注册并保存你的 api_key。'
    }
  }
  return { user }
}
