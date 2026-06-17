/**
 * L0-2b · 订单签名链
 *
 * 每个订单的状态转换 append 到一条 hash-chained 签名事件里。
 * 关键性质：
 *   1. 防篡改 — 每事件含 prev_event_hash，改任一历史事件会让后续 hash 不匹配
 *   2. 防伪造 — 每事件含 HMAC-SHA256 签名（用 actor 的 api_key 签），server 也无法替 actor 凭空写新事件
 *   3. 可独立验证 — 任何人拿到完整链 + 各 actor api_key（仲裁场景）可以离线 replay
 *   4. 不替代而是补强 order_state_history — 旧表保留作为人类可读的状态历史
 *
 * 与 Mobazha 的 serialized_*_signature 字段同思路；区别：
 *   - Mobazha 用 protobuf + 多方签名（buyer + vendor + moderator）
 *   - 我们 MVP 用 JSON + HMAC（API key），实现简单。可日后升级到 Ed25519 非对称签名
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'
import { generateId } from '../L0-1-database/schema.js'
import { dbOne, dbAll } from '../L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

export function initOrderChainSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_events (
      id              TEXT PRIMARY KEY,
      order_id        TEXT NOT NULL,
      seq             INTEGER NOT NULL,        -- 0,1,2... 序号
      prev_event_hash TEXT,                    -- 上一个事件的 event_hash（genesis = null）
      event_hash      TEXT NOT NULL,           -- sha256(canonical_payload) 本事件的指纹
      event_type      TEXT NOT NULL,           -- 'open' | 'transition' | 'cancel' ...
      from_status     TEXT,
      to_status       TEXT NOT NULL,
      actor_id        TEXT NOT NULL,
      actor_role      TEXT NOT NULL,
      payload_json    TEXT NOT NULL,           -- 完整事件载荷（canonical 序列化）
      signature       TEXT NOT NULL,           -- HMAC-SHA256(actor_api_key, canonical_payload)
      signed_at       TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_oevt_order ON order_events(order_id, seq)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_oevt_actor ON order_events(actor_id, created_at DESC)') } catch {}
}

// RFC-011 §⑥ 事件游标流 —— 集成方 agent 拉"自 cursor 以来与我相关的变化"。
//   不变量 2(活性 ≤ 读边界):仅返回【请求方为当事人(buyer/seller/logistics)的订单】的事件,
//   与 /api/orders/:id/chain 的 party 门同口径 —— 流是读边界之上的活性层,不开新读口子。
//   只回结构性事件(状态机转移 + 哈希链字段),完整 payload 仍走 party-gated /chain;
//   event_hash + prev_event_hash 让集成方验链连续性(防篡改);HMAC signature 不暴露(actor 私钥 HMAC,第三方无从验)。
//   cursor = SQLite rowid(append-only 表的插入单调键)—— 唯一对【增量消费】正确的游标:
//     created_at 是秒级、id 随机,同秒事件用它们排序会让"earlier-sorting order 的新事件排到游标前→漏掉";
//     rowid 严格随插入递增,不重不漏、保单内 seq 序。(注:本表 append-only 且不 VACUUM,rowid 稳定;
//      若将来 VACUUM 重排,消费方按 opaque cursor 遇 gap 重同步即可。)
export interface OrderEventFeedItem {
  cursor: string; order_id: string; seq: number; event_type: string
  from_status: string | null; to_status: string; actor_role: string
  event_hash: string; prev_event_hash: string | null; signed_at: string; created_at: string
}
// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点 orders-read.ts 均 inTx=false,非状态机写路径)。
export async function listOrderEventsSince(
  _db: Database.Database, userId: string, since: string | undefined, limit: number
): Promise<{ events: OrderEventFeedItem[]; next_cursor: string | null; has_more: boolean }> {
  const lim = Math.min(200, Math.max(1, Math.floor(limit) || 50))
  const sinceRid = since && /^\d+$/.test(since) ? Number(since) : 0
  const rows = await dbAll<Omit<OrderEventFeedItem, 'cursor'> & { rid: number }>(`
    SELECT e.rowid AS rid, e.order_id, e.seq, e.event_type, e.from_status, e.to_status, e.actor_role,
           e.event_hash, e.prev_event_hash, e.signed_at, e.created_at
    FROM order_events e
    JOIN orders o ON o.id = e.order_id
    WHERE (o.buyer_id = ? OR o.seller_id = ? OR o.logistics_id = ?)
      AND e.rowid > ?
    ORDER BY e.rowid ASC
    LIMIT ?
  `, [userId, userId, userId, sinceRid, lim])
  const events: OrderEventFeedItem[] = rows.map(r => ({
    cursor: String(r.rid),
    order_id: r.order_id, seq: r.seq, event_type: r.event_type,
    from_status: r.from_status, to_status: r.to_status, actor_role: r.actor_role,
    event_hash: r.event_hash, prev_event_hash: r.prev_event_hash, signed_at: r.signed_at, created_at: r.created_at,
  }))
  const has_more = events.length === lim
  const next_cursor = events.length ? events[events.length - 1].cursor : (since ?? null)
  return { events, next_cursor, has_more }
}

// canonical_payload — 递归 stringify，每层 key 字母序
// 修复 ultrareview bug_012：浅排序让嵌套对象用插入序，破坏"独立验证"承诺
// （已知问题：arbitration_ruling 时 liability_parties 是嵌套数组）
// 与 anchor-engine.ts:canonicalSerialize 算法一致 — 两个协议层产同样 hash
export function canonicalSerialize(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonicalSerialize).join(',') + ']'
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalSerialize((obj as Record<string, unknown>)[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}

export function computeEventHash(canonicalPayload: string): string {
  return crypto.createHash('sha256').update(canonicalPayload).digest('hex')
}

export function computeEventSignature(canonicalPayload: string, actorApiKey: string): string {
  return crypto.createHmac('sha256', actorApiKey).update(canonicalPayload).digest('hex')
}

// 主入口 — 在 transaction 内调用，写一条事件到链尾
export function appendOrderEvent(
  db: Database.Database,
  args: {
    orderId: string
    eventType: 'open' | 'transition' | 'cancel'
    fromStatus: string | null
    toStatus: string
    actorId: string
    actorRole: string
    extra?: Record<string, unknown>   // 额外业务数据（如 evidence_ids、notes）
  }
): { id: string; seq: number; event_hash: string } {
  const actor = db.prepare('SELECT api_key FROM users WHERE id = ?').get(args.actorId) as { api_key: string } | undefined
  if (!actor) throw new Error(`actor_not_found:${args.actorId}`)

  const last = db.prepare(
    `SELECT seq, event_hash FROM order_events WHERE order_id = ? ORDER BY seq DESC LIMIT 1`
  ).get(args.orderId) as { seq: number; event_hash: string } | undefined

  const seq = last ? last.seq + 1 : 0
  const prevHash = last ? last.event_hash : null
  const signedAt = new Date().toISOString()
  const payload = {
    order_id:        args.orderId,
    seq,
    prev_event_hash: prevHash,
    event_type:      args.eventType,
    from_status:     args.fromStatus,
    to_status:       args.toStatus,
    actor_id:        args.actorId,
    actor_role:      args.actorRole,
    signed_at:       signedAt,
    ...(args.extra || {}),
  }
  const canon = canonicalSerialize(payload)
  const eventHash = computeEventHash(canon)
  const signature = computeEventSignature(canon, actor.api_key)
  const id = generateId('oevt')

  db.prepare(
    `INSERT INTO order_events
       (id, order_id, seq, prev_event_hash, event_hash, event_type, from_status, to_status,
        actor_id, actor_role, payload_json, signature, signed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, args.orderId, seq, prevHash, eventHash, args.eventType,
    args.fromStatus, args.toStatus, args.actorId, args.actorRole,
    canon, signature, signedAt
  )
  return { id, seq, event_hash: eventHash }
}

// 验证整条链 — 仲裁时或任何审计场景可调
export async function verifyOrderChain(_db: Database.Database, orderId: string): Promise<{
  ok: boolean
  total: number
  verified: number
  firstBrokenSeq?: number
  reason?: string
  history_count?: number
}> {
  const rows = await dbAll<{
    seq: number; prev_event_hash: string | null; event_hash: string;
    payload_json: string; signature: string; actor_id: string;
  }>(
    `SELECT seq, prev_event_hash, event_hash, payload_json, signature, actor_id
       FROM order_events WHERE order_id = ? ORDER BY seq ASC`,
    [orderId])
  if (rows.length === 0) return { ok: false, total: 0, verified: 0, reason: 'empty_chain' }

  // 修复 ultrareview bug_007：transition() 的 appendOrderEvent 是 try-catch 软失败
  // （legacy actor 缺 api_key 等场景），但 order_state_history 仍会 commit。
  // 检测：chain 行数应该至少等于 history 行数（chain ≥ history，因为可能有 open genesis 事件无 history）
  // 不等就说明有 silent drop，链不完整 — UI 不应再显示"验证通过"
  const histCount = await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM order_state_history WHERE order_id = ?`, [orderId])
  if (histCount && rows.length < histCount.n) {
    return { ok: false, total: rows.length, verified: 0, reason: 'chain_incomplete', history_count: histCount.n }
  }

  let prevHash: string | null = null
  for (const r of rows) {
    // 1. prev hash 链续
    if (r.prev_event_hash !== prevHash) {
      return { ok: false, total: rows.length, verified: r.seq, firstBrokenSeq: r.seq, reason: 'prev_hash_mismatch' }
    }
    // 2. event_hash = sha256(payload)
    const reHash = computeEventHash(r.payload_json)
    if (reHash !== r.event_hash) {
      return { ok: false, total: rows.length, verified: r.seq, firstBrokenSeq: r.seq, reason: 'event_hash_mismatch' }
    }
    // 3. signature 用 actor api_key 验
    const actor = await dbOne<{ api_key: string }>('SELECT api_key FROM users WHERE id = ?', [r.actor_id])
    if (!actor) return { ok: false, total: rows.length, verified: r.seq, firstBrokenSeq: r.seq, reason: 'actor_not_found' }
    const reSig = computeEventSignature(r.payload_json, actor.api_key)
    if (reSig !== r.signature) {
      return { ok: false, total: rows.length, verified: r.seq, firstBrokenSeq: r.seq, reason: 'signature_mismatch' }
    }
    prevHash = r.event_hash
  }
  return { ok: true, total: rows.length, verified: rows.length }
}

export async function getOrderChain(_db: Database.Database, orderId: string): Promise<Array<{
  seq: number; event_type: string; from_status: string | null; to_status: string;
  actor_id: string; actor_role: string; signed_at: string;
  event_hash: string; prev_event_hash: string | null; signature: string;
  payload: Record<string, unknown>;
}>> {
  const rows = await dbAll<Record<string, unknown>>(
    `SELECT seq, event_type, from_status, to_status, actor_id, actor_role, signed_at,
            event_hash, prev_event_hash, signature, payload_json
       FROM order_events WHERE order_id = ? ORDER BY seq ASC`,
    [orderId])
  return rows.map(r => ({
    seq: r.seq as number,
    event_type: r.event_type as string,
    from_status: (r.from_status as string) || null,
    to_status: r.to_status as string,
    actor_id: r.actor_id as string,
    actor_role: r.actor_role as string,
    signed_at: r.signed_at as string,
    event_hash: r.event_hash as string,
    prev_event_hash: (r.prev_event_hash as string) || null,
    signature: r.signature as string,
    payload: (() => { try { return JSON.parse(r.payload_json as string) } catch { return {} } })(),
  }))
}
