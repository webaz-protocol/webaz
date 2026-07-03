/**
 * Disputes 读端点 — 仲裁列表 + 同类判例 + 详情聚合 + evidence-list + parties
 *
 * 由 #1013 Phase 86 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET /api/disputes                       仲裁员看开放争议（双通道：内部 role + 外部 whitelist）
 *   GET /api/disputes/:id/similar-cases     A2 同类已判案件推荐（按 product.category + reason 关键词 + recency 兜底）
 *   GET /api/disputes/:id                   详情聚合（256 行：原告/被告/参与方证据 + W4 timeline 归一化 + chain ruling 取证）
 *   GET /api/disputes/:id/evidence-list     当事人 + 仲裁员可查（meta only，blob 单独拉）
 *   GET /api/disputes/:id/parties           涉案三方（buyer/seller/logistics + initiator/defendant 去重）
 *
 * 详情接口构造 timeline：
 *   open → plaintiff evidence → defendant response/evidence → party evidence
 *   → evidence requests + submitted → ruling (从 order_events chain 取) → resolved
 *
 * 跨域注入：auth + errorRes + getOpenDisputes + getDisputeDetails + getEvidenceRequests
 *           + listEvidenceFiles + isEligibleArbitrator
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface DisputesReadDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  getOpenDisputes: (db: Database.Database) => unknown
  getDisputeDetails: any
  getEvidenceRequests: any
  listEvidenceFiles: (db: Database.Database, disputeId: string, userId: string) => Promise<unknown>
  isEligibleArbitrator: (userId: string) => { ok: boolean; reason?: string; via?: string }
}

export function registerDisputesReadRoutes(app: Application, deps: DisputesReadDeps): void {
  const { db, auth, errorRes, getOpenDisputes, getDisputeDetails, getEvidenceRequests, listEvidenceFiles, isEligibleArbitrator } = deps

  // 仲裁员：查看所有开放争议
  app.get('/api/disputes', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleArbitrator(user.id as string)
    if (!elig.ok) return void errorRes(res, 403, 'NOT_ARBITRATOR', elig.reason || '仅限仲裁员访问')
    res.json(await getOpenDisputes(db))
  })

  // A2 同类判例推荐
  app.get('/api/disputes/:id/similar-cases', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const dispute = await dbOne<{ id: string; order_id: string; reason: string; initiator_id: string; defendant_id: string | null }>('SELECT id, order_id, reason, initiator_id, defendant_id FROM disputes WHERE id = ?', [req.params.id])
    if (!dispute) return void res.status(404).json({ error: '争议不存在' })
    const role = (user as Record<string, unknown>).role as string
    if (dispute.initiator_id !== user.id && dispute.defendant_id !== user.id && role !== 'arbitrator') {
      return void res.status(403).json({ error: '无权查看' })
    }
    const order = await dbOne<{ product_id: string }>('SELECT product_id FROM orders WHERE id = ?', [dispute.order_id])
    const productCategory = order ? (await dbOne<{ category: string | null }>('SELECT category FROM products WHERE id = ?', [order.product_id]))?.category : null
    const reasonWords = (dispute.reason || '').split(/[\s,，。；\n]+/).filter(w => w.length >= 2).slice(0, 3)
    const results: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    const pushIfNew = (r: Record<string, unknown>) => {
      if (!seen.has(String(r.id))) { seen.add(String(r.id)); results.push(r) }
    }
    // ① 同 product 类目
    if (productCategory) {
      const r1 = await dbAll<Record<string, unknown>>(`
        SELECT dc.id, dc.product_id, dc.category_tag, dc.winner, dc.resolution,
          dc.amount_bucket, dc.fairness_yes, dc.comment_count, dc.published_at,
          (SELECT title FROM products WHERE id = dc.product_id) as product_title,
          'same_category' as match_reason
        FROM dispute_cases dc
        JOIN products p ON p.id = dc.product_id
        WHERE p.category = ? AND (dc.dispute_id IS NULL OR dc.dispute_id != ?)
        ORDER BY dc.published_at DESC LIMIT 3
      `, [productCategory, dispute.id])
      r1.forEach(pushIfNew)
    }
    // ② reason 关键词命中 ruling_text / 双方陈述
    if (results.length < 3 && reasonWords.length > 0) {
      for (const w of reasonWords) {
        if (results.length >= 3) break
        const pat = '%' + w.replace(/[%_]/g, '\\$&') + '%'
        const r2 = await dbAll<Record<string, unknown>>(`
          SELECT dc.id, dc.product_id, dc.category_tag, dc.winner, dc.resolution,
            dc.amount_bucket, dc.fairness_yes, dc.comment_count, dc.published_at,
            (SELECT title FROM products WHERE id = dc.product_id) as product_title,
            'keyword_match' as match_reason
          FROM dispute_cases dc
          WHERE (dc.dispute_id IS NULL OR dc.dispute_id != ?)
            AND (dc.ruling_text LIKE ? OR dc.buyer_argument LIKE ? OR dc.seller_argument LIKE ?)
          ORDER BY dc.published_at DESC LIMIT 3
        `, [dispute.id, pat, pat, pat])
        r2.forEach(pushIfNew)
      }
    }
    // ③ 兜底：最近 3 条已发布判例
    if (results.length < 3) {
      const r3 = await dbAll<Record<string, unknown>>(`
        SELECT dc.id, dc.product_id, dc.category_tag, dc.winner, dc.resolution,
          dc.amount_bucket, dc.fairness_yes, dc.comment_count, dc.published_at,
          (SELECT title FROM products WHERE id = dc.product_id) as product_title,
          'recent' as match_reason
        FROM dispute_cases dc
        WHERE (dc.dispute_id IS NULL OR dc.dispute_id != ?)
        ORDER BY dc.published_at DESC LIMIT 3
      `, [dispute.id])
      r3.forEach(pushIfNew)
    }
    res.json({ items: results.slice(0, 3), product_category: productCategory, reason_keywords: reasonWords })
  })

  // 详情聚合（含 W4 timeline + chain ruling）
  app.get('/api/disputes/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const dispute = await getDisputeDetails(db, req.params.id)
    if (!dispute) return void res.status(404).json({ error: '争议不存在' })

    // PR-E:允许 发起方 / 被告方 / 物流方 / active whitelist 仲裁员。不再用 role === 'arbitrator'(旧旁路 →
    //   suspended/revoked/role-only 可越权读、whitelist-only 买家被错误挡)。授权源统一为 isEligibleArbitrator。
    const orderForAuth = await dbOne<{ logistics_id: string | null }>('SELECT logistics_id FROM orders WHERE id = ?', [dispute.order_id])
    const isLogisticsParty = orderForAuth?.logistics_id === user.id
    if (dispute.initiator_id !== user.id && dispute.defendant_id !== user.id
        && !isLogisticsParty && !isEligibleArbitrator(user.id as string).ok) {
      return void res.status(403).json({ error: '无权查看此争议' })
    }

    // 原告证据 — 从状态机历史中取 disputed 转移时附带的
    const hist = await dbOne<{ evidence_ids: string }>(
      `SELECT evidence_ids FROM order_state_history WHERE order_id = ? AND to_status = 'disputed'`,
      [dispute.order_id]
    )
    // P1 fix: 单条脏 JSON 不应封死整个 dispute 详情
    const safeJsonArr = (s: string | null | undefined): string[] => {
      try { const p = JSON.parse(s || '[]'); return Array.isArray(p) ? p as string[] : [] } catch { return [] }
    }
    const plaintiffEvidenceIds: string[] = hist ? safeJsonArr(hist.evidence_ids) : []
    const defEvidenceIds: string[] = safeJsonArr(dispute.defendant_evidence_ids)

    const fetchEvidence = async (ids: string[]) =>
      ids.length
        ? await dbAll(`SELECT * FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
        : []

    const evidenceRequests = await getEvidenceRequests(db, req.params.id) as Array<Record<string, unknown>>
    const myPendingRequests = evidenceRequests.filter(
      (r: any) => r.requested_from_id === user.id && r.status === 'pending'
    )

    const order = await dbOne<Record<string, string | null>>('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?', [dispute.order_id])
    const partyIds = [dispute.initiator_id, dispute.defendant_id, order?.logistics_id].filter(Boolean) as string[]
    const parties = (await Promise.all([...new Set(partyIds)].map(id =>
      dbOne('SELECT id, name, role FROM users WHERE id = ?', [id])
    ))).filter(Boolean)

    const partyEvidenceIds: string[] = safeJsonArr((dispute as Record<string, unknown>).party_evidence_ids as string)

    const orderParties = await dbOne<Record<string, string | null>>('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?', [dispute.order_id])
    const allPartyIds = [
      orderParties?.buyer_id, orderParties?.seller_id, orderParties?.logistics_id,
      dispute.initiator_id, dispute.defendant_id
    ].filter(Boolean) as string[]
    const isParty = allPartyIds.includes(user.id as string)

    const plaintiffEvidence = await fetchEvidence(plaintiffEvidenceIds) as Array<Record<string, unknown>>
    const defendantEvidence = await fetchEvidence(defEvidenceIds) as Array<Record<string, unknown>>
    const partyEvidence = await fetchEvidence(partyEvidenceIds) as Array<Record<string, unknown>>

    // W4 timeline 归一化
    const partyMap = new Map<string, string>()
    partyMap.set(dispute.initiator_id, 'plaintiff')
    if (dispute.defendant_id) partyMap.set(dispute.defendant_id, 'defendant')
    const orderRole = (uid: string | null | undefined): string => {
      if (!uid || !order) return 'unknown'
      if (uid === order.buyer_id) return 'buyer'
      if (uid === order.seller_id) return 'seller'
      if (uid === order.logistics_id) return 'logistics'
      return 'unknown'
    }
    const userById = new Map<string, { id: string; name: string; handle: string | null; role: string }>()
    const loadUser = async (uid: string | null | undefined) => {
      if (!uid || userById.has(uid)) return
      const u = await dbOne<{ id: string; name: string; handle: string | null; role: string }>(
        'SELECT id, name, handle, role FROM users WHERE id = ?', [uid])
      if (u) userById.set(uid, u)
    }
    await loadUser(dispute.initiator_id)
    await loadUser(dispute.defendant_id)

    type TLEvent = {
      id: string
      type: 'open' | 'evidence' | 'response' | 'evidence_request' | 'ruling' | 'resolved'
      ts: string
      actor_id: string | null
      actor_role: string
      body: string
      flagged?: number
      flag_reasons?: string[]
      meta?: Record<string, unknown>
    }
    const events: TLEvent[] = []

    // 1) open
    events.push({
      id: `open-${dispute.id}`,
      type: 'open',
      ts: String(dispute.created_at || ''),
      actor_id: dispute.initiator_id,
      actor_role: 'plaintiff',
      body: String(dispute.reason || ''),
      meta: {
        stake_deposit: dispute.stake_deposit,
        respond_deadline: dispute.respond_deadline,
        arbitrate_deadline: dispute.arbitrate_deadline,
      },
    })

    // 2) plaintiff evidence
    const evToEvent = async (ev: Record<string, unknown>, role: string): Promise<TLEvent> => {
      await loadUser(ev.uploader_id as string)
      let fr: string[] = []
      try { fr = ev.flag_reasons ? JSON.parse(String(ev.flag_reasons)) : [] } catch {}
      return {
        id: `ev-${ev.id}`,
        type: 'evidence',
        ts: String(ev.created_at || ''),
        actor_id: (ev.uploader_id as string) || null,
        actor_role: role,
        body: String(ev.description || ''),
        flagged: fr.length > 0 ? 1 : 0,
        flag_reasons: fr,
        meta: {
          evidence_id: ev.id,
          evidence_type: ev.type,
          file_hash: ev.file_hash,
          mime: ev.mime || null,
          size: ev.size || null,
          filename: ev.filename || null,
          sig: ev.sig || null,
          has_blob: !!ev.file_path,
          withdrawn_at: ev.withdrawn_at || null,
        },
      }
    }
    for (const ev of plaintiffEvidence) events.push(await evToEvent(ev, 'plaintiff'))

    // 3) defendant response — 用 defendant 第一条证据时间逼近 respond_at
    if (dispute.defendant_notes) {
      const firstDefTs = defendantEvidence[0]?.created_at as string | undefined
      events.push({
        id: `resp-${dispute.id}`,
        type: 'response',
        ts: firstDefTs || String(dispute.created_at || ''),
        actor_id: dispute.defendant_id,
        actor_role: 'defendant',
        body: String(dispute.defendant_notes || ''),
      })
    }
    for (const ev of defendantEvidence) events.push(await evToEvent(ev, 'defendant'))

    // 4) party evidence (物流等)
    for (const ev of partyEvidence) {
      const r = orderRole(ev.uploader_id as string)
      events.push(await evToEvent(ev, r === 'unknown' ? 'party' : r))
    }

    // 5) evidence requests + submitted_items
    for (const r of evidenceRequests) {
      let evidenceTypes: string[] = []
      try { evidenceTypes = JSON.parse(String(r.evidence_types || '[]')) } catch {}
      await loadUser(r.requested_from_id as string)
      events.push({
        id: `req-${r.id}`,
        type: 'evidence_request',
        ts: String(r.created_at || ''),
        actor_id: null,
        actor_role: 'arbitrator',
        body: String(r.description || ''),
        meta: {
          request_id: r.id,
          requested_from_id: r.requested_from_id,
          requested_from_name: r.requested_from_name,
          requested_from_role: orderRole(r.requested_from_id as string),
          evidence_types: evidenceTypes,
          deadline: r.deadline,
          status: r.status,
        },
      })
      const submitted = (r.submitted_items || []) as Array<Record<string, unknown>>
      for (const si of submitted) {
        const role = orderRole(si.uploader_id as string)
        const ev = await evToEvent(si, role === 'unknown' ? 'party' : role)
        ev.meta = { ...(ev.meta || {}), in_response_to: r.id }
        events.push(ev)
      }
    }

    // 6) ruling — 从 order_events 签名链取
    try {
      const chainRows = await dbAll<{ actor_id: string; signed_at: string; payload_json: string }>(
        `SELECT actor_id, signed_at, payload_json FROM order_events WHERE order_id = ? ORDER BY seq ASC`,
        [dispute.order_id]
      )
      for (const row of chainRows) {
        let payload: Record<string, unknown> = {}
        try { payload = JSON.parse(row.payload_json) } catch { continue }
        const extra = (payload.extra || {}) as Record<string, unknown>
        if (extra.action === 'arbitration_ruling' && extra.dispute_id === dispute.id) {
          await loadUser(row.actor_id)
          events.push({
            id: `rule-${row.signed_at}`,
            type: 'ruling',
            ts: row.signed_at,
            actor_id: row.actor_id,
            actor_role: 'arbitrator',
            body: String(extra.reason || ''),
            meta: {
              ruling: extra.ruling,
              refund_amount: extra.refund_amount,
              liable_party_id: extra.liable_party_id,
              liability_parties: extra.liability_parties,
            },
          })
        }
      }
    } catch (e) { console.warn('[timeline] chain query failed:', (e as Error).message) }

    // 7) resolved/dismissed marker
    if (dispute.resolved_at) {
      const hasRulingEvent = events.some(e => e.type === 'ruling')
      events.push({
        id: `done-${dispute.id}`,
        type: 'resolved',
        ts: String(dispute.resolved_at),
        actor_id: null,
        actor_role: 'system',
        body: hasRulingEvent ? '' : String((dispute as Record<string, unknown>).verdict_reason || ''),
        meta: {
          status: dispute.status,
          ruling_type: (dispute as Record<string, unknown>).ruling_type,
          refund_amount: (dispute as Record<string, unknown>).refund_amount,
          liability_parties: (dispute as Record<string, unknown>).liability_parties,
        },
      })
    }

    events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

    res.json({
      ...dispute,
      plaintiff_evidence:   plaintiffEvidence,
      defendant_evidence:   defendantEvidence,
      party_evidence:       partyEvidence,
      evidence_requests:    evidenceRequests,
      my_pending_requests:  myPendingRequests,
      parties,
      is_party: isParty,
      timeline:             events,
      actors:               Object.fromEntries([...userById].map(([id, u]) => [id, u])),
    })
  })

  // 当事人 + 仲裁员可查（meta only，blob 单独拉）
  app.get('/api/disputes/:id/evidence-list', async (req, res) => {
    const user = auth(req, res); if (!user) return
    try {
      const rows = await listEvidenceFiles(db, req.params.id, user.id as string)
      res.json(rows)
    } catch (e) {
      const msg = (e as Error).message
      res.status(msg === 'not_dispute_party' ? 403 : 404).json({ error: msg })
    }
  })

  // 涉案三方（仲裁员选择发证据请求的对象）
  app.get('/api/disputes/:id/parties', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const dispute = await getDisputeDetails(db, req.params.id)
    if (!dispute) return void res.status(404).json({ error: '争议不存在' })

    const order = await dbOne<Record<string, string | null>>('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?', [dispute.order_id])

    // PR-E:同详情权限门 —— 仅 涉案方 或 active whitelist 仲裁员可读涉案方名单(此前任意登录用户可读=泄露)。
    const isParty = [order?.buyer_id, order?.seller_id, order?.logistics_id, dispute.initiator_id, dispute.defendant_id].filter(Boolean).includes(user.id as string)
    if (!isParty && !isEligibleArbitrator(user.id as string).ok) {
      return void res.status(403).json({ error: '无权查看涉案方' })
    }

    const partyIds = [dispute.initiator_id, dispute.defendant_id, order?.logistics_id].filter(Boolean) as string[]
    const uniqueIds = [...new Set(partyIds)]
    const parties = (await Promise.all(uniqueIds.map(id =>
      dbOne<Record<string, string>>('SELECT id, name, role FROM users WHERE id = ?', [id])
    ))).filter(Boolean)

    res.json(parties)
  })
}
