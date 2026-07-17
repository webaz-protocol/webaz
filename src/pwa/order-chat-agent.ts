/**
 * RFC-026 PR-4 — 订单上下文聊天(context-bound;safe scopes order_chat_read / order_chat_send)。
 *
 * 边界:只有【订单双方】(买家/卖家 = grant 的 human)可读可发,上下文绑死 kind='order' + 该订单;
 * 【没有自由私信】—— 非本单参与方连会话存在性都探不到(404)。发送走【进程内回环打真实
 * /api/conversations 路径】:反诈检测(flagged/flag_reasons)/每分钟限频/屏蔽状态/参与方门,
 * 全部生产同一条路,零复刻。发送后把 agent 归因(grant/label/幂等键/内容哈希)后置标注进
 * messages.meta.agent —— 即 spec 的 sent_by_agent 等价标记,配合 grant 审计日志构成完整审计链。
 *
 * 幂等:idempotency_key 在近 10 分钟窗口内查 meta.agent.idempotency_key,命中 → 返回原消息
 * (duplicate:true),绝不重发。读投影:sender 只回 'you'/'counterparty'(不回裸 user id),
 * body/flag 原样透传(聊天正文本就是双方互见的自由文本;反诈标记保留)。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export type ApiLoopback = (apiKey: string, path: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>

function orderParty(db: Database.Database, humanId: string, orderId: string): { ok: true; order: Record<string, unknown>; peerId: string } | { ok: false; status: number; body: Record<string, unknown> } {
  const o = db.prepare('SELECT id, buyer_id, seller_id, status FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!o || (o.buyer_id !== humanId && o.seller_id !== humanId)) {
    return { ok: false, status: 404, body: { error_code: 'ORDER_NOT_FOUND', reason: 'no such order (or you are not a party)', retryable: false } }
  }
  return { ok: true, order: o, peerId: String(o.buyer_id === humanId ? o.seller_id : o.buyer_id) }
}

function convFor(db: Database.Database, humanId: string, orderId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT id, user_a, user_b, status FROM conversations WHERE kind = 'order' AND context_id = ? AND (user_a = ? OR user_b = ?) LIMIT 1")
    .get(orderId, humanId, humanId) as Record<string, unknown> | undefined
}

function projectMessages(db: Database.Database, convId: string, humanId: string): Array<Record<string, unknown>> {
  const rows = db.prepare('SELECT id, sender_id, body, flagged, flag_reasons, meta, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id LIMIT 200')
    .all(convId) as Array<Record<string, unknown>>
  return rows.map(m => {
    let flags: unknown = []
    try { flags = m.flag_reasons ? JSON.parse(String(m.flag_reasons)) : [] } catch { flags = [] }
    let agentMeta: Record<string, unknown> | null = null
    try { const meta = m.meta ? JSON.parse(String(m.meta)) as Record<string, unknown> : null; const a = meta?.agent as Record<string, unknown> | undefined; agentMeta = a && typeof a.grant_id === 'string' && typeof a.body_sha256 === 'string' ? a : null } catch { agentMeta = null }   // shape 校验:畸形/历史数据不冒充 agent 归因
    return {
      message_id: String(m.id),
      sender: m.sender_id === humanId ? 'you' : 'counterparty',
      body: String(m.body ?? ''),
      flagged: Number(m.flagged) === 1,
      flag_reasons: flags,
      sent_by_agent: !!agentMeta,
      ...(agentMeta ? { agent_label: String(agentMeta.label ?? '') } : {}),
      created_at: String(m.created_at),
    }
  })
}

export function readOrderChat(db: Database.Database, humanId: string, orderId: unknown):
  { ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> } {
  if (typeof orderId !== 'string' || !orderId) return { ok: false, status: 400, body: { error_code: 'ORDER_NOT_FOUND', reason: 'order_id is required', retryable: true } }
  const party = orderParty(db, humanId, orderId)
  if (!party.ok) return party
  const conv = convFor(db, humanId, orderId)
  if (!conv) return { ok: true, response: { order_id: orderId, messages: [], note: 'No conversation yet — send the first message to open one (order participants only).' } }
  return { ok: true, response: { order_id: orderId, conversation_status: String(conv.status), messages: projectMessages(db, String(conv.id), humanId) } }
}

export async function sendOrderChat(db: Database.Database, deps: { apiLoopback: ApiLoopback; humanId: string; grantId: string; agentLabel: string }, orderId: unknown, bodyText: unknown, idempotencyKey: unknown):
  Promise<{ ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }> {
  const { apiLoopback, humanId, grantId, agentLabel } = deps
  if (typeof orderId !== 'string' || !orderId) return { ok: false, status: 400, body: { error_code: 'ORDER_NOT_FOUND', reason: 'order_id is required', retryable: true } }
  const text = typeof bodyText === 'string' ? bodyText.trim() : ''
  if (!text || text.length > 2000) return { ok: false, status: 400, body: { error_code: 'CHAT_BODY_INVALID', reason: 'body must be 1..2000 chars', retryable: true } }
  const idem = typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(idempotencyKey) ? idempotencyKey : null
  const party = orderParty(db, humanId, orderId)
  if (!party.ok) return party
  // 幂等(Codex HIGH):DB 级预留 —— grant 命名空间 + body 哈希绑定;UNIQUE(grant,key) 抗并发同键。
  const bodySha = sha(text)
  if (idem) {
    try {
      db.prepare('INSERT INTO agent_chat_idem (grant_id, idem_key, body_sha, message_id) VALUES (?,?,?,NULL)').run(grantId, idem, bodySha)
    } catch (e) {
      if (!/UNIQUE|PRIMARY/i.test((e as Error).message)) return { ok: false, status: 503, body: { error_code: 'CHAT_UNAVAILABLE', reason: 'idempotency store unavailable', retryable: true } }
      const prev = db.prepare('SELECT body_sha, message_id, created_at FROM agent_chat_idem WHERE grant_id = ? AND idem_key = ?').get(grantId, idem) as { body_sha: string; message_id: string | null; created_at: string } | undefined
      if (prev && prev.body_sha !== bodySha) return { ok: false, status: 409, body: { error_code: 'IDEMPOTENCY_CONFLICT', reason: 'this idempotency_key was already used with a DIFFERENT body — pick a new key', retryable: false } }
      if (prev?.message_id) return { ok: true, response: { order_id: orderId, message_id: prev.message_id, duplicate: true, reused_existing_message: true } }
      // 同键同体、消息未落(对手在飞/曾崩溃):>10 分钟视为死预留可重占,否则如实退避
      const stale = prev && db.prepare("SELECT 1 x WHERE ? < datetime('now','-10 minutes')").get(prev.created_at)
      if (!stale) return { ok: false, status: 409, body: { error_code: 'SEND_IN_FLIGHT', reason: 'an identical send with this key is in flight — retry shortly to fetch its message id', retryable: true } }
      db.prepare("UPDATE agent_chat_idem SET created_at = datetime('now'), message_id = NULL WHERE grant_id = ? AND idem_key = ?").run(grantId, idem)
    }
  }
  const u = db.prepare('SELECT api_key FROM users WHERE id = ?').get(humanId) as { api_key: string } | undefined
  if (!u) return { ok: false, status: 404, body: { error_code: 'ORDER_NOT_FOUND', reason: 'account unavailable', retryable: false } }
  // 回环①:find-or-create 会话(真实参与方门)
  const st = await apiLoopback(u.api_key, '/api/conversations/start', { kind: 'order', context_id: orderId, recipient_id: party.peerId })
  const convId = st.json && typeof st.json.id === 'string' ? st.json.id : null
  if (!convId) return { ok: false, status: 409, body: { error_code: 'CHAT_UNAVAILABLE', reason: String(st.json?.error ?? 'conversation unavailable'), retryable: true } }
  // 回环②:真实发送(反诈/限频/屏蔽全生产同路)
  const sd = await apiLoopback(u.api_key, `/api/conversations/${encodeURIComponent(convId)}/messages`, { body: text })
  const msg = (sd.json?.message as Record<string, unknown> | undefined) ?? (typeof sd.json?.id === 'string' ? sd.json : undefined)
  const msgId = msg && typeof msg.id === 'string' ? msg.id : null
  if (sd.status === 429) return { ok: false, status: 429, body: { error_code: 'CHAT_RATE_LIMITED', reason: 'sending too fast — retry shortly', retryable: true } }
  if (!msgId) return { ok: false, status: 409, body: { error_code: 'CHAT_SEND_REJECTED', reason: String(sd.json?.error ?? 'send rejected'), retryable: false } }
  // agent 归因后置标注(spec sent_by_agent 等价;失败如实上报,不假装已标注 —— Codex MEDIUM)
  let marked = false
  try {
    const row = db.prepare('SELECT meta FROM messages WHERE id = ? AND sender_id = ?').get(msgId, humanId) as { meta: string | null } | undefined
    let meta: Record<string, unknown> = {}
    try { meta = row?.meta ? JSON.parse(row.meta) as Record<string, unknown> : {} } catch { meta = {} }
    meta.agent = { grant_id: grantId, label: agentLabel, body_sha256: bodySha, ...(idem ? { idempotency_key: idem } : {}) }
    const upd = db.prepare('UPDATE messages SET meta = ? WHERE id = ? AND sender_id = ?').run(JSON.stringify(meta), msgId, humanId)
    marked = upd.changes === 1
  } catch { marked = false }
  if (idem) { try { db.prepare('UPDATE agent_chat_idem SET message_id = ? WHERE grant_id = ? AND idem_key = ?').run(msgId, grantId, idem) } catch { /* 预留兑现 best-effort;同键重试会走 in-flight→stale 路径 */ } }
  const flagged = msg ? Number(msg.flagged) === 1 : false
  return { ok: true, response: { order_id: orderId, message_id: msgId, sent: true, sent_by_agent: marked, ...(marked ? {} : { note_attribution: 'agent attribution annotation FAILED to persist — the message went out unmarked; the grant audit log still records this call' }), flagged, ...(flagged ? { note: 'anti-scam flagged this message — it is delivered with a warning to the counterparty' } : {}), duplicate: false } }
}
