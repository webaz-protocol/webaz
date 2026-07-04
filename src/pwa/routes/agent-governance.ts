/**
 * Agent 治理域 (2026-05-23 spec §6 用户控制 + admin 审核)
 *
 * 由 #1013 Phase 38 从 src/pwa/server.ts 抽出。
 *
 * 10 endpoints (7 user + 3 admin)：
 *   GET    /api/me/agents                                    用户视角列出本账号所有 agent
 *   GET    /api/me/agents/:apiKeyPrefix/log                  单 agent 30d 调用历史
 *   POST   /api/me/agents/declarations                       agent 自声明
 *   POST   /api/me/agents/:apiKeyPrefix/revoke               用户撤销 agent（铁律 §4 human presence）
 *   POST   /api/me/agents/operators/:operator_name/revoke    撤销 operator 旗下所有 agent
 *   POST   /api/me/agents/strikes/:strikeId/appeal           申诉 strike（30d 窗口）
 *   POST   /api/me/agents/attestations                       用户批准 agent scope
 *   POST   /api/admin/agent-strikes/:strikeId/decide         (root) 裁决 strike 申诉
 *   GET    /api/admin/agent-strikes/pending                  (root) 待审申诉列表
 *   POST   /api/admin/agent-strikes/issue                    (root) 主动 issue strike
 *
 * 铁律 §4：agent_revoke 需 require_human_presence（按协议参数开关）
 * P1 fix 5.3：appeal approved → 恢复因 strike 自动停用的 skills
 *
 * 跨域 helpers:
 *   - invalidateAgentBlockedCache / issueAgentStrike — server.ts 顶层注入
 *   - requireHumanPresence — server.ts 注入
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { computeAgentPassport } from '../../layer1-agent/L1-2-identity/agent-passport.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AgentGovernanceDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  invalidateAgentBlockedCache: (apiKey: string) => void
  custodianFingerprint: (ownerId: string) => string
  signPassport: (message: string) => Promise<string>   // 协议私钥签名(ecrecover 可验)
  issuerAddress: () => string                            // 协议签发地址(= DID 锚点)
  requireHumanPresence: (
    userId: string,
    purpose: 'vote' | 'arbitrate' | 'agent_revoke',
    token: string | undefined,
    paramKey: string,
    validate?: (data: unknown) => boolean,
  ) => { ok: boolean; reason?: string; error_code?: string; required_when_enabled?: boolean }
  issueAgentStrike: (opts: {
    apiKey: string
    userId: string
    reasonCode: string
    reasonDetail?: string
    reportedBy: string
    relatedRef?: string
    initialSeverity?: 'warning' | 'suspend_7d' | 'permanent'
  }) => Record<string, unknown>
}

export function registerAgentGovernanceRoutes(app: Application, deps: AgentGovernanceDeps): void {
  const { db, generateId, auth, requireRootAdmin, invalidateAgentBlockedCache, requireHumanPresence, issueAgentStrike, custodianFingerprint, signPassport, issuerAddress } = deps

  // /api/me/agents — 列出本账号所有 agent + declaration / strikes
  app.get('/api/me/agents', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const keys = await dbAll<{ api_key: string }>(`SELECT api_key FROM users WHERE id = ? UNION SELECT api_key FROM agent_reputation WHERE user_id = ?`, [user.id, user.id])
    const items = await Promise.all(keys.map(async k => {
      const decl = await dbOne<Record<string, unknown>>(`SELECT operator_name, operator_contact, purpose, declared_scope, attestations, repo_url, revoked_at FROM agent_declarations WHERE api_key = ?`, [k.api_key])
      // P1 fix 4.4：附 signals JSON
      const rep = await dbOne<Record<string, unknown>>(`SELECT trust_score, level, signals, last_calculated_at FROM agent_reputation WHERE api_key = ?`, [k.api_key])
      if (rep && rep.signals) {
        try { rep.signals = JSON.parse(rep.signals as string) } catch { rep.signals = null }
      }
      const calls30d = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM agent_call_log WHERE api_key = ? AND created_at > datetime('now', '-30 days')`, [k.api_key]))!.n
      const last = await dbOne<Record<string, unknown>>(`SELECT endpoint, method, status_code, created_at FROM agent_call_log WHERE api_key = ? ORDER BY created_at DESC LIMIT 1`, [k.api_key])
      const strikes = await dbAll(`SELECT id, severity, reason_code, reason_detail, issued_at, expires_at, appeal_status FROM agent_strikes WHERE api_key = ? ORDER BY issued_at DESC LIMIT 5`, [k.api_key])   // +id/detail:被封申诉 UI 需要(此端点封禁豁免)
      let passport = null
      try { passport = computeAgentPassport(db, k.api_key, user.id as string, custodianFingerprint) } catch { /* read-only, never break the list */ }
      return {
        api_key_prefix: k.api_key.slice(0, 12) + '...',
        api_key_full: k.api_key === user.api_key ? k.api_key : null,
        declaration: decl || null,
        reputation: rep || null,
        calls_30d: calls30d,
        last_call: last || null,
        recent_strikes: strikes,
        passport,
      }
    }))
    // Phase 2 监护人总览(只读/软绑定):真人态 + 旗下 agent 聚合 + 连带
    const hasPasskey = ((await dbOne<{ n: number }>('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', [user.id]))?.n || 0) > 0
    const pps = items.map(i => i.passport).filter(Boolean) as Array<{ risk_score: number; engagement_depth: string }>
    const depthRank: Record<string, number> = { shallow: 0, medium: 1, deep: 2, profound: 3 }
    const deepest = pps.reduce((d, p) => (depthRank[p.engagement_depth] ?? 0) > (depthRank[d] ?? 0) ? p.engagement_depth : d, 'shallow')
    const custodian = {
      fingerprint: custodianFingerprint(user.id as string),
      has_passkey: hasPasskey,
      agent_count: items.length,
      max_risk: pps.reduce((m, p) => Math.max(m, p.risk_score), 0),
      high_risk_count: pps.filter(p => p.risk_score >= 50).length,
      deepest_engagement: pps.length ? deepest : null,
    }
    res.json({ items, custodian })
  })

  // Phase 4 + DID/VC 短期 mapping(B.6 b,2026-05-30):
  //   webaz_format = 原 WebAZAgentPassport (向后兼容,任何 existing consumer 还用这个)
  //   vc_format    = W3C Verifiable Credential v1 标准(任何标准 DID/VC resolver 可用)
  //   两者签名是同一个(eip191 over canonical 串),两者可互推。
  //   issuer 同时给 did:web:webaz.xyz(标准 DID method)+ 原 did:webaz:0x... 地址(向后兼容)。
  app.get('/api/me/agents/:apiKeyPrefix/passport', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const prefix = String(req.params.apiKeyPrefix || '').replace('...', '')
    if (prefix.length < 6) return void res.status(400).json({ error: 'apiKeyPrefix 太短' })
    const keys = await dbAll<{ api_key: string }>(`SELECT api_key FROM users WHERE id = ? UNION SELECT api_key FROM agent_reputation WHERE user_id = ?`, [user.id, user.id])
    const match = keys.find(k => k.api_key.startsWith(prefix))
    if (!match) return void res.status(404).json({ error: '未找到该 agent(或不属于你)' })
    const pp = computeAgentPassport(db, match.api_key, user.id as string, custodianFingerprint)
    const issued_at = new Date().toISOString()
    const expires_at = new Date(Date.now() + 7 * 86400_000).toISOString()
    const issuerAddr = issuerAddress()
    const issuerDidWeb = 'did:web:webaz.xyz'                                         // W3C did:web 形态
    const issuerDidLegacy = 'did:webaz:' + issuerAddr                                // 原自定义形态(保留)
    const keyPrefix = match.api_key.slice(0, 12) + '...'
    const bp = pp.behavior_profile
    // 规范化签名串(verifier 用相同格式重建 → verifyMessage(issuerAddr, canonical, signature))
    // 两套 wrapper 共享同一 canonical + signature,所以一签两用。
    const canonical = `webaz-agent-passport|v1|${issuerAddr}|${issued_at}|${expires_at}|${pp.custodian_fingerprint}|${keyPrefix}|risk=${pp.risk_score}|depth=${pp.engagement_depth}|bp=${bp.query},${bp.transact},${bp.govern}`
    let signature = ''
    try { signature = await signPassport(canonical) } catch (e) { return void res.status(503).json({ error: '签名服务暂不可用', detail: (e as Error).message }) }

    // 原格式(向后兼容)— 任何已写过 webaz 集成的 consumer 不需要改
    const webaz_format = {
      type: 'WebAZAgentPassport', version: 1,
      issuer: issuerDidLegacy, issuer_address: issuerAddr,
      issued_at, expires_at,
      subject: { custodian_fingerprint: pp.custodian_fingerprint, agent_key_prefix: keyPrefix },
      claims: { risk_score: pp.risk_score, engagement_depth: pp.engagement_depth, behavior_profile: bp },
      canonical, signature,
      verify: { scheme: 'eip191', how: 'verifyMessage(issuer_address, canonical, signature)' },
    }

    // W3C Verifiable Credential v1 标准格式 — 任何 DID/VC 生态工具(KILT/Polygon ID/Veramo/SpruceID/...)可直接消费
    // proof.type 用 EcdsaSecp256k1RecoverySignature2020(eip191 在 W3C 安全套件里的标准名)
    // proofValue 是同一 signature 字符串(0x..),verifier 用 viem.verifyMessage 验真
    const vc_format = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://webaz.xyz/credentials/v1',                                          // webaz 自定义 schema 命名空间
      ],
      type: ['VerifiableCredential', 'WebAZAgentPassport'],
      issuer: issuerDidWeb,                                                          // did:web — 通过 /.well-known/did.json 解析
      issuanceDate: issued_at,
      expirationDate: expires_at,
      credentialSubject: {
        id: `${issuerDidWeb}:agents:${keyPrefix.replace('...', '')}`,                // 在 issuer 命名空间下的 agent 标识
        custodianFingerprint: pp.custodian_fingerprint,
        agentKeyPrefix: keyPrefix,
        riskScore: pp.risk_score,
        engagementDepth: pp.engagement_depth,
        behaviorProfile: { query: bp.query, transact: bp.transact, govern: bp.govern },
      },
      proof: {
        type: 'EcdsaSecp256k1RecoverySignature2020',                                 // eip191 在 W3C 套件里的标准名
        created: issued_at,
        verificationMethod: `${issuerDidWeb}#key-1`,                                 // 指向 did.json 里的 verificationMethod
        proofPurpose: 'assertionMethod',
        proofValue: signature,
        // canonical 不在 W3C VC 标准里,但 webaz consumer 仍需要它来重建签名:
        webazCanonical: canonical,
      },
    }

    res.json({
      // 两个格式并存返回 — backward-compat consumer 用 webaz_format,标准 DID/VC consumer 用 vc_format
      // 顶层保留 webaz_format 的关键字段方便不解嵌的 consumer(类似 ?format=webaz 默认行为)
      ...webaz_format,
      vc_format,
      webaz_format,                                                                  // 显式重复让消费者明确选哪个
    })
  })

  app.get('/api/me/agents/:apiKeyPrefix/log', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const prefix = String(req.params.apiKeyPrefix || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
    if (prefix.length < 8) return void res.status(400).json({ error: 'apiKeyPrefix 至少 8 字符' })
    const targetKey = await dbOne<{ api_key: string }>(`SELECT api_key FROM users WHERE id = ? AND api_key LIKE ? || '%'
      UNION SELECT api_key FROM agent_reputation WHERE user_id = ? AND api_key LIKE ? || '%'`,
      [user.id, prefix, user.id, prefix])
    if (!targetKey) return void res.status(404).json({ error: '未找到匹配的 agent api_key（仅可查本人的）' })
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100))
    const rows = await dbAll(`SELECT endpoint, method, status_code, created_at FROM agent_call_log
      WHERE api_key = ? AND created_at > datetime('now', '-30 days') ORDER BY id DESC LIMIT ?`, [targetKey.api_key, limit])
    res.json({ items: rows })
  })

  app.post('/api/me/agents/declarations', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const b = req.body as Record<string, unknown>
    const targetApiKey = b.api_key ? String(b.api_key) : user.api_key as string
    const ownership = await dbOne(`SELECT id FROM users WHERE id = ? AND api_key = ?
      UNION SELECT user_id as id FROM agent_reputation WHERE user_id = ? AND api_key = ?`,
      [user.id, targetApiKey, user.id, targetApiKey])
    if (!ownership) return void res.status(403).json({ error: 'api_key 不属于本账号' })

    const operator_name = String(b.operator_name || '').trim().slice(0, 60)
    if (operator_name.length < 2) return void res.status(400).json({ error: 'operator_name 2-60 字' })
    const operator_contact = String(b.operator_contact || '').trim().slice(0, 120)
    if (operator_contact.length < 3) return void res.status(400).json({ error: 'operator_contact 必填' })
    const purpose = String(b.purpose || '').trim().slice(0, 200)
    if (purpose.length < 5) return void res.status(400).json({ error: 'purpose 5-200 字' })
    let scopeJson: string
    try {
      const s = b.declared_scope
      if (!s || typeof s !== 'object') return void res.status(400).json({ error: 'declared_scope 必须是对象' })
      scopeJson = JSON.stringify(s).slice(0, 2000)
    } catch { return void res.status(400).json({ error: 'declared_scope 无法序列化' }) }
    const attestationsJson = b.attestations && typeof b.attestations === 'object' ? JSON.stringify(b.attestations).slice(0, 2000) : null
    const repo_url = b.repo_url ? String(b.repo_url).slice(0, 200) : null
    const homepage = b.homepage ? String(b.homepage).slice(0, 200) : null

    await dbRun(`INSERT INTO agent_declarations (
      api_key, user_id, operator_name, operator_contact, purpose, declared_scope, attestations, repo_url, homepage
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(api_key) DO UPDATE SET
      operator_name = excluded.operator_name,
      operator_contact = excluded.operator_contact,
      purpose = excluded.purpose,
      declared_scope = excluded.declared_scope,
      attestations = excluded.attestations,
      repo_url = excluded.repo_url,
      homepage = excluded.homepage,
      revoked_at = NULL,
      updated_at = datetime('now')`,
      [targetApiKey, user.id, operator_name, operator_contact, purpose, scopeJson, attestationsJson, repo_url, homepage])
    invalidateAgentBlockedCache(targetApiKey)
    res.json({ ok: true })
  })

  // 用户撤销 agent（铁律 §4 human presence）
  app.post('/api/me/agents/:apiKeyPrefix/revoke', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const prefix = String(req.params.apiKeyPrefix || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
    if (prefix.length < 8) return void res.status(400).json({ error: 'apiKeyPrefix 至少 8 字符' })
    const targetKey = await dbOne<{ api_key: string }>(`SELECT api_key FROM users WHERE id = ? AND api_key LIKE ? || '%'
      UNION SELECT api_key FROM agent_reputation WHERE user_id = ? AND api_key LIKE ? || '%'`,
      [user.id, prefix, user.id, prefix])
    if (!targetKey) return void res.status(404).json({ error: '未找到匹配的 agent api_key' })
    const hpCheck = requireHumanPresence(user.id as string, 'agent_revoke', (req.body || {}).webauthn_token, 'require_human_presence_for_agent_revoke', () => true)
    if (!hpCheck.ok) return void res.status(412).json({ error: hpCheck.reason, error_code: hpCheck.error_code })

    const reason = String((req.body || {}).reason || '').slice(0, 300)
    await dbRun(`INSERT INTO agent_revocations (target_kind, target_value, revoked_by, revoked_by_role, reason)
      VALUES ('api_key', ?, ?, 'self', ?)
      ON CONFLICT(target_kind, target_value, revoked_by) DO NOTHING`, [targetKey.api_key, user.id, reason])
    await dbRun(`UPDATE agent_declarations SET revoked_at = datetime('now'), revoked_reason = ? WHERE api_key = ?`, [reason, targetKey.api_key])
    invalidateAgentBlockedCache(targetKey.api_key)
    res.json({ ok: true })
  })

  // 撤销同 operator 名下所有 agent（仅撤销本用户给 operator 旗下 agent 的 attestation）
  app.post('/api/me/agents/operators/:operator_name/revoke', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const opName = String(req.params.operator_name || '').trim().slice(0, 60)
    if (opName.length < 2) return void res.status(400).json({ error: 'operator_name 至少 2 字' })
    const hpCheck = requireHumanPresence(user.id as string, 'agent_revoke', (req.body || {}).webauthn_token, 'require_human_presence_for_agent_revoke', () => true)
    if (!hpCheck.ok) return void res.status(412).json({ error: hpCheck.reason, error_code: hpCheck.error_code })

    const reason = String((req.body || {}).reason || '').slice(0, 300)
    const affected = await dbRun(`UPDATE agent_attestations SET revoked_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL
        AND api_key IN (SELECT api_key FROM agent_declarations WHERE operator_name = ?)`,
      [user.id, opName])
    await dbRun(`INSERT INTO agent_revocations (target_kind, target_value, revoked_by, revoked_by_role, reason)
      VALUES ('operator_name', ?, ?, 'self', ?)
      ON CONFLICT(target_kind, target_value, revoked_by) DO NOTHING`, [opName, user.id, reason])
    const keys = await dbAll<{ api_key: string }>(`SELECT api_key FROM agent_declarations WHERE operator_name = ?`, [opName])
    for (const k of keys) invalidateAgentBlockedCache(k.api_key)
    res.json({ ok: true, attestations_revoked: affected.changes })
  })

  // P0 audit fix 4.2: 申诉 strike
  app.post('/api/me/agents/strikes/:strikeId/appeal', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const strikeId = Number(req.params.strikeId)
    if (!Number.isInteger(strikeId) || strikeId <= 0) return void res.status(400).json({ error: 'strikeId 必须是正整数' })
    const strike = await dbOne<Record<string, unknown>>(`SELECT id, api_key, user_id, severity, issued_at, appeal_status FROM agent_strikes WHERE id = ?`, [strikeId])
    if (!strike) return void res.status(404).json({ error: 'strike 不存在' })
    if (strike.user_id !== user.id) return void res.status(403).json({ error: '只能申诉自己 agent 的 strike' })
    if (strike.appeal_status !== 'none') return void res.status(409).json({ error: `已申诉过（状态：${strike.appeal_status}）` })
    const issuedAt = new Date(String(strike.issued_at).replace(' ', 'T') + 'Z').getTime()
    if (Date.now() - issuedAt > 30 * 86400_000) return void res.status(410).json({ error: '已过 30 天申诉窗口' })
    const reason = String((req.body || {}).reason || '').trim().slice(0, 500)
    if (reason.length < 10) return void res.status(400).json({ error: '申诉理由 ≥10 字' })
    await dbRun(`UPDATE agent_strikes SET appeal_status = 'pending', appeal_reason = ? WHERE id = ?`, [reason, strikeId])
    res.json({ ok: true, message: '申诉已提交，等待 root admin 审核' })
  })

  // Admin: 审核 strike 申诉
  app.post('/api/admin/agent-strikes/:strikeId/decide', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const strikeId = Number(req.params.strikeId)
    if (!Number.isInteger(strikeId) || strikeId <= 0) return void res.status(400).json({ error: 'strikeId 必须是正整数' })
    const decision = String((req.body || {}).decision || '')
    if (!['approved', 'denied'].includes(decision)) return void res.status(400).json({ error: 'decision 必须是 approved / denied' })
    const strike = await dbOne<{ api_key: string; appeal_status: string }>(`SELECT id, api_key, appeal_status FROM agent_strikes WHERE id = ?`, [strikeId])
    if (!strike) return void res.status(404).json({ error: 'strike 不存在' })
    if (strike.appeal_status !== 'pending') return void res.status(409).json({ error: `当前状态 ${strike.appeal_status} 不可裁决` })
    await dbRun(`UPDATE agent_strikes SET appeal_status = ?, appeal_decided_by = ?, appeal_decided_at = datetime('now') WHERE id = ?`,
      [decision, user.id as string, strikeId])
    invalidateAgentBlockedCache(strike.api_key)
    // P1 fix 5.3: appeal approved → 恢复因 strike 自动停用的 skills
    if (decision === 'approved') {
      try {
        const uRow = await dbOne<{ id: string }>(`SELECT id FROM users WHERE api_key = ?`, [strike.api_key])
        if (uRow) {
          const r = await dbRun(`UPDATE skills SET active = 1, disabled_by_strike_at = NULL
            WHERE seller_id = ? AND disabled_by_strike_at IS NOT NULL AND active = 0`, [uRow.id])
          if (r.changes > 0) console.log(`[appeal approved→skill] restored ${r.changes} skills for ${uRow.id}`)
        }
      } catch (e) { console.error('[appeal skills restore]', e) }
    }
    res.json({ ok: true, decision })
  })

  // Admin: 列出待审 strike 申诉
  app.get('/api/admin/agent-strikes/pending', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const rows = await dbAll(`SELECT s.id, s.api_key, s.user_id, u.handle, s.severity, s.reason_code, s.reason_detail, s.issued_at, s.appeal_reason
      FROM agent_strikes s JOIN users u ON u.id = s.user_id
      WHERE s.appeal_status = 'pending' ORDER BY s.id DESC LIMIT 100`)
    res.json({ items: rows })
  })

  // P1 fix 4.3: admin 主动 issue strike
  app.post('/api/admin/agent-strikes/issue', async (req, res) => {
    const adminUser = requireRootAdmin(req, res); if (!adminUser) return
    const b = req.body as Record<string, unknown>
    const apiKey = String(b.api_key || '').trim()
    if (apiKey.length < 8) return void res.status(400).json({ error: 'api_key 必填' })
    const targetUser = await dbOne<{ id: string; handle: string }>(`SELECT id, handle FROM users WHERE api_key = ?`, [apiKey])
    if (!targetUser) return void res.status(404).json({ error: '未找到该 api_key' })
    const reasonCode = String(b.reason_code || '').trim().slice(0, 40)
    if (!/^[a-z_]{3,40}$/.test(reasonCode)) return void res.status(400).json({ error: 'reason_code 必须是 3-40 位 [a-z_]（如 fake_shipment / spam）' })
    const reasonDetail = b.reason_detail ? String(b.reason_detail).slice(0, 500) : null
    const initialSeverity = (b.severity ? String(b.severity) : 'warning') as 'warning' | 'suspend_7d' | 'permanent'
    if (!['warning', 'suspend_7d', 'permanent'].includes(initialSeverity)) {
      return void res.status(400).json({ error: 'severity 必须是 warning / suspend_7d / permanent' })
    }
    const result = issueAgentStrike({
      apiKey, userId: targetUser.id,
      reasonCode, reasonDetail: reasonDetail || undefined,
      reportedBy: adminUser.id as string,
      relatedRef: b.related_ref ? String(b.related_ref) : undefined,
      initialSeverity,
    })
    res.json({ ok: true, target_handle: targetUser.handle, ...result })
  })

  // bilateral attestation（用户批准某 agent 的 scope）
  app.post('/api/me/agents/attestations', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const b = req.body as Record<string, unknown>
    const apiKey = String(b.api_key || '')
    if (!apiKey) return void res.status(400).json({ error: 'api_key 必填' })
    const decl = await dbOne<Record<string, unknown>>(`SELECT declared_scope, operator_name, purpose FROM agent_declarations WHERE api_key = ? AND revoked_at IS NULL`, [apiKey])
    if (!decl) return void res.status(404).json({ error: '该 agent 未声明 / 已撤销，无法授权' })
    let approvedScopeJson: string
    try {
      const s = b.approved_scope
      if (!s || typeof s !== 'object') return void res.status(400).json({ error: 'approved_scope 必须是对象' })
      approvedScopeJson = JSON.stringify(s).slice(0, 2000)
    } catch { return void res.status(400).json({ error: 'approved_scope 无法序列化' }) }
    const spendCapPerOrder = b.spend_cap_per_order != null ? Math.max(0, Number(b.spend_cap_per_order)) : null
    const spendCapDaily = b.spend_cap_daily != null ? Math.max(0, Number(b.spend_cap_daily)) : null

    const id = generateId('aat')
    await dbRun(`INSERT INTO agent_attestations (id, api_key, user_id, approved_scope, spend_cap_per_order, spend_cap_daily)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(api_key, user_id) DO UPDATE SET
        approved_scope = excluded.approved_scope,
        spend_cap_per_order = excluded.spend_cap_per_order,
        spend_cap_daily = excluded.spend_cap_daily,
        revoked_at = NULL,
        granted_at = datetime('now')`,
      [id, apiKey, user.id, approvedScopeJson, spendCapPerOrder, spendCapDaily])
    res.json({ ok: true })
  })
}
