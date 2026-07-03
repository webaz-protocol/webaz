/**
 * Store-and-Forward 协议层 (L2-7 SNF)
 *
 * 由 #1013 Phase 41 从 src/pwa/server.ts 抽出。
 *
 * 11 endpoints:
 *   POST   /api/snf/send                  发消息（HMAC 签名 + payload object）
 *   GET    /api/snf/inbox                 只读列表（list — 不消费）
 *   GET    /api/snf/inbox/pull            协议级 pull（一次性消费，agent 用）
 *   POST   /api/snf/nack                  agent 处理失败回放（SNF_MAX_RETRIES=5 后死信化）
 *   GET    /api/snf/dead-letter           死信列表（人工 review）
 *   POST   /api/snf/revive/:id            死信复活
 *   POST   /api/snf/ack                   显式 ack（无 ids → ack 全部未读）
 *   GET    /api/snf/pending               未读数
 *   GET    /api/snf/:id/verify            验签（仅当事人或 arbitrator/admin）
 *   POST   /api/snf/designate             声明额外 SNF peers
 *   GET    /api/snf/designate             读 designation
 *
 * 服务器是 implicit 默认 SNF — 用户离线时给他的消息都先落这队列
 * 所有 helpers 来自 L2-7 snf-engine
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import {
  snfSend, snfPullInbox, snfListInbox, snfAck, snfPendingCount,
  snfVerify, snfDesignate, snfGetDesignation,
  snfNack, snfListDeadLetter, snfRevive,
} from '../../layer2-business/L2-7-snf/snf-engine.js'
import { isEligibleArbitrator } from '../arbitrator-lifecycle.js'  // 仲裁能力唯一源=active 白名单(verify 是争议证据面,不认 legacy role)

export interface SnfDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerSnfRoutes(app: Application, deps: SnfDeps): void {
  const { db, auth } = deps

  app.post('/api/snf/send', (req, res) => {
    const user = auth(req, res); if (!user) return
    const { recipient_id, message_type, payload, related_order_id, priority } = req.body || {}
    if (!recipient_id || !message_type || !payload) return void res.status(400).json({ error: '缺少必要字段' })
    if (typeof payload !== 'object') return void res.status(400).json({ error: 'payload 必须是 object' })
    try {
      const r = snfSend(db, {
        senderId: user.id as string,
        recipientId: String(recipient_id),
        messageType: String(message_type) as never,
        payload: payload as Record<string, unknown>,
        relatedOrderId: related_order_id ? String(related_order_id) : null,
        priority: priority === 1 ? 1 : 0,
      })
      res.json({ ok: true, id: r.id, signature: r.signature })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  // 只读列表（不消费）
  app.get('/api/snf/inbox', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80))
    const sinceDays = Math.min(180, Math.max(1, Number(req.query.since_days) || 30))
    const msgs = await snfListInbox(db, user.id as string, limit, sinceDays)
    res.json({ items: msgs, count: msgs.length })
  })

  // 协议级 pull — 一次性消费，agent / 内部组件用
  app.get('/api/snf/inbox/pull', (req, res) => {
    const user = auth(req, res); if (!user) return
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const msgs = snfPullInbox(db, user.id as string, limit)
    res.json({ items: msgs, count: msgs.length })
  })

  // Agent 处理失败 → nack 回放（超 5 次自动死信化）
  app.post('/api/snf/nack', (req, res) => {
    const user = auth(req, res); if (!user) return
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 100) : []
    if (ids.length === 0) return void res.json({ error: 'ids 为空' })
    const error = req.body?.error ? String(req.body.error) : undefined
    const r = snfNack(db, user.id as string, ids, error)
    res.json({ ok: true, reopened: r.reopened, dead_lettered: r.deadLettered })
  })

  app.get('/api/snf/dead-letter', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const items = await snfListDeadLetter(db, user.id as string, limit)
    res.json({ items, count: items.length })
  })

  app.post('/api/snf/revive/:id', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = snfRevive(db, user.id as string, String(req.params.id))
    if (!r.ok) {
      const status = r.reason === 'not_found' ? 404 : r.reason === 'not_owner' ? 403 : 400
      return void res.status(status).json({ error: r.reason })
    }
    res.json({ ok: true })
  })

  // 显式 ack（无 ids → ack 全部未读）
  app.post('/api/snf/ack', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : null
    if (ids && ids.length > 0) {
      const r = snfAck(db, user.id as string, ids)
      return void res.json({ ok: true, acked: r.acked })
    }
    const all = (await snfListInbox(db, user.id as string, 200, 365)).filter(m => !m.delivered_at).map(m => m.id)
    const r = snfAck(db, user.id as string, all)
    res.json({ ok: true, acked: r.acked })
  })

  app.get('/api/snf/pending', async (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json({ pending: await snfPendingCount(db, user.id as string) })
  })

  // 验签（仅当事人或 arbitrator/admin）
  app.get('/api/snf/:id/verify', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbOne<{ sender_id: string; recipient_id: string }>(`SELECT sender_id, recipient_id FROM snf_messages WHERE id = ?`, [req.params.id])
    if (!r) return void res.status(404).json({ error: '消息不存在' })
    const uid = user.id as string
    // 仲裁员认 active 白名单(争议证据验签是仲裁工作面);legacy role 旁路移除 —— 否则 role-only/已吊销账号可按 id
    //   探测任意用户间私信的存在性+签名有效性,而真·白名单仲裁员(role=buyer)反被 403。admin 保持原样。
    if (uid !== r.sender_id && uid !== r.recipient_id && !isEligibleArbitrator(db, uid).ok && user.role !== 'admin') {
      return void res.status(403).json({ error: '无权验证' })
    }
    res.json(await snfVerify(db, req.params.id))
  })

  app.post('/api/snf/designate', (req, res) => {
    const user = auth(req, res); if (!user) return
    const peers = Array.isArray(req.body?.peers) ? req.body.peers.map(String).slice(0, 5) : []
    snfDesignate(db, user.id as string, peers)
    res.json({ ok: true, peers })
  })

  app.get('/api/snf/designate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json({ peers: await snfGetDesignation(db, user.id as string), server_implicit: true })
  })
}
