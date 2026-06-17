/**
 * Agent reputation 端点 — 自查 + admin 查询
 *
 * 由 #1013 Phase 108 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/agents/me/reputation              自己看（含 raw_mode 判定）
 *   GET /api/admin/agents/:api_key/reputation  admin 查任意 agent
 *
 * 跨域注入：auth + getAgentTrustCached + RAW_MODE_MIN_TRUST
 */
import type { Application, Request, Response } from 'express'

export interface AgentReputationDeps {
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getAgentTrustCached: (apiKey: string) => {
    user_id: string
    trust_score: number
    level: string
    signals: Record<string, unknown>
  } | null
  getRawModeMinTrust: () => number
}

export function registerAgentReputationRoutes(app: Application, deps: AgentReputationDeps): void {
  const { auth, getAgentTrustCached, getRawModeMinTrust } = deps

  app.get('/api/agents/me/reputation', (req, res) => {
    const user = auth(req, res); if (!user) return
    const key = req.headers.authorization?.replace('Bearer ', '') ?? ''
    const t = getAgentTrustCached(key)
    if (!t) return void res.status(404).json({ error: 'agent_not_found' })
    const min = getRawModeMinTrust()
    res.json({
      api_key_prefix: key.slice(0, 12) + '…',
      user_id: t.user_id,
      trust_score: t.trust_score,
      level: t.level,
      signals: t.signals,
      raw_mode_enabled: t.trust_score >= min,
      raw_mode_min_trust: min,
    })
  })

  app.get('/api/admin/agents/:api_key/reputation', (req, res) => {
    const admin = auth(req, res); if (!admin) return
    if (admin.role !== 'admin') return void res.status(403).json({ error: '仅管理员可查询其他 agent' })
    const target = req.params.api_key
    const t = getAgentTrustCached(target)
    if (!t) return void res.status(404).json({ error: 'agent_not_found' })
    res.json(t)
  })
}
