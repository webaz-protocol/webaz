/**
 * Auth 读端点 — 当前用户信息 + 完整 profile
 *
 * 由 #1013 Phase 116 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/me       简版（含 wallet + region_max_levels）
 *   GET /api/profile  完整（含 PV 参与记录 + 资产指标;不含奖励等级/积分,#PR-D）
 *
 * 跨域注入：auth + db + safeRoles + getRegionMaxLevels + userMlmGate + getUserLevel
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AuthReadDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeRoles: (user: Record<string, unknown>) => string[]
  getRegionMaxLevels: (region: string) => number
  userMlmGate: (region: string) => { payoutLevels: any; mlmUiVisible: boolean }
  getUserLevel: (lifetimeScore: number) => unknown
}

export function registerAuthReadRoutes(app: Application, deps: AuthReadDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne),不再直接用 deps.db
  const { auth, safeRoles, getRegionMaxLevels, userMlmGate } = deps

  app.get('/api/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const wallet = await dbOne<Record<string, number>>('SELECT * FROM wallets WHERE user_id = ?', [user.id])
    let roles: string[] = []
    try { roles = JSON.parse((user.roles as string) || JSON.stringify([user.role])) } catch { roles = [user.role as string] }
    const region = (user.region as string) || 'global'
    const maxLevels = getRegionMaxLevels(region)
    const pvEnabled = (await dbOne<{ pv_enabled: number }>("SELECT pv_enabled FROM region_config WHERE region = ?", [region]))?.pv_enabled ?? 0
    // 恢复能力标志(供首页"无恢复方式"横幅 + 凭证清单徽章用)。password_hash 不外泄,只回布尔。
    const passkeyCount = (await dbOne<{ n: number }>('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', [user.id]))?.n ?? 0
    res.json({
      ...user, api_key: undefined, password_hash: undefined,
      roles, wallet: wallet || null, region_max_levels: maxLevels, region_pv_enabled: Number(pvEnabled) === 1 ? 1 : 0,
      email_verified: !!user.email_verified,
      has_password: !!user.password_hash,
      has_passkey: Number(passkeyCount) > 0,
    })
  })

  app.get('/api/profile', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const wallet = await dbOne<Record<string, number>>('SELECT balance, staked, escrowed, earned FROM wallets WHERE user_id = ?', [user.id])
    const roles = safeRoles(user)
    const pv = await dbOne<{ total_left_pv: number; total_right_pv: number }>("SELECT total_left_pv, total_right_pv FROM users WHERE id = ?", [user.id])
    res.json({
      id: user.id, name: user.name, role: user.role, roles, api_key: user.api_key, wallet: wallet || null,
      permanent_code: user.permanent_code ?? null,
      handle: user.handle ?? null,
      handle_last_created_at: user.handle_last_created_at ?? null,
      handle_change_log: (() => { try { return JSON.parse((user.handle_change_log as string) || '[]') } catch { return [] } })(),
      email: user.email ?? null,
      email_verified: !!user.email_verified,
      phone: user.phone ?? null,
      phone_verified: !!user.phone_verified,
      has_password: !!user.password_hash,
      has_passkey: ((await dbOne<{ n: number }>('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', [user.id]))?.n ?? 0) > 0,
      region: user.region ?? 'global',
      region_max_levels: getRegionMaxLevels((user.region as string) || 'global'),
      region_pv_enabled: (((await dbOne<{ pv_enabled: number }>("SELECT pv_enabled FROM region_config WHERE region = ?", [(user.region as string) || 'global']))?.pv_enabled ?? 0) === 1 ? 1 : 0),
      ...(() => { const g = userMlmGate((user.region as string) || 'global'); return { mlm_ui_visible: g.mlmUiVisible, mlm_payout_levels: g.payoutLevels } })(),
      bio: user.bio ?? null,
      search_anchor: user.search_anchor ?? null,
      feed_visible: user.feed_visible == null ? 1 : Number(user.feed_visible),
      default_address_text:   user.default_address_text   ?? null,
      default_address_region: user.default_address_region ?? null,
      default_address: (() => {
        try { return user.default_address_json ? JSON.parse(user.default_address_json as string) : null } catch { return null }
      })(),
      total_left_pv:  Number(pv?.total_left_pv  ?? 0),
      total_right_pv: Number(pv?.total_right_pv ?? 0),
    })
  })
}
