/**
 * L2-7 · Store-and-Forward (SNF)
 *
 * 协议级离线消息队列 — 借鉴 Mobazha / OpenBazaar 的设计
 *
 * 用途：
 *   - 用户 A 给用户 B 发消息（订单事件、聊天、争议证据等）
 *   - B 此刻不在线 / 没活动 session
 *   - A 不必等 B 上线；消息先落 SNF 队列
 *   - B 下次进站第一时间 pull inbox → 拿到 A 的留言
 *
 * 与已有 notifications 表的区别：
 *   - notifications = 系统对用户的 UI 提示（bell 红点）
 *   - snf_messages  = 用户对用户的协议级消息信封（可含签名 payload）
 *
 * 设计：
 *   - 服务器是 implicit 默认 SNF — 任何用户的消息都可以委托给服务器持有
 *   - 用户可在 snf_designations 表声明额外的 SNF peers（可选，未来 P2P）
 *   - TTL 默认 30 天，过期自动清
 *   - signature 可选，但建议 sender HMAC 签 (与订单签名链同款机制)
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

export const SNF_TTL_DAYS = 30
export const SNF_MAX_PAYLOAD = 32 * 1024   // 32KB 单条上限（大附件走 manifest_registry，SNF 只传 hash）
export const SNF_MAX_RETRIES = 5           // pull → nack 累计超过此次数 → 自动 dead-letter

export type SnfMessageType =
  | 'chat'                    // 一般私聊
  | 'order_event'             // 订单事件转递（payload = 签名链事件 hash 引用）
  | 'dispute_evidence'        // 仲裁证据（仅 hash + 描述）
  | 'dispute_evidence_blob'   // 仲裁证据（带 blob — 接收方可拉 /api/evidence/:id/blob）
  | 'protocol_hint'           // 协议层提示（如 sponsor 邀请）
  | 'custom'                  // 留给上层扩展

export function initSnfSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snf_messages (
      id            TEXT PRIMARY KEY,
      sender_id     TEXT NOT NULL,
      recipient_id  TEXT NOT NULL,
      message_type  TEXT NOT NULL,
      payload       TEXT NOT NULL,            -- canonical JSON
      signature     TEXT,                     -- 可选 HMAC，用 sender api_key 签
      priority      INTEGER DEFAULT 0,        -- 0 普通 / 1 高（仲裁证据等）
      created_at    TEXT DEFAULT (datetime('now')),
      delivered_at  TEXT,                     -- recipient pull 时打戳
      expires_at    TEXT NOT NULL,            -- TTL，默认 now+30d
      related_order_id TEXT                   -- 可选：与订单关联便于审计
    );
    CREATE TABLE IF NOT EXISTS snf_designations (
      user_id     TEXT PRIMARY KEY,
      snf_peers   TEXT NOT NULL DEFAULT '[]', -- JSON array of peer_ids
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_snf_inbox ON snf_messages(recipient_id, delivered_at, created_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_snf_sender ON snf_messages(sender_id, created_at DESC)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_snf_expire ON snf_messages(expires_at)') } catch {}
  // Agent 工作流升级（#5）：retry / dead-letter 语义
  //   delivery_attempts  - pull → nack 累计次数
  //   last_attempt_at    - 上次拉取时间
  //   last_error         - 最近一次 nack 的错误描述（≤500 字符）
  //   dead_letter        - 1=已死信化；列表/普通 pull 自动排除
  for (const stmt of [
    'ALTER TABLE snf_messages ADD COLUMN delivery_attempts INTEGER DEFAULT 0',
    'ALTER TABLE snf_messages ADD COLUMN last_attempt_at TEXT',
    'ALTER TABLE snf_messages ADD COLUMN last_error TEXT',
    'ALTER TABLE snf_messages ADD COLUMN dead_letter INTEGER DEFAULT 0',
  ]) { try { db.exec(stmt) } catch { /* 已存在 */ } }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_snf_dead ON snf_messages(recipient_id, dead_letter)') } catch {}
}

function canonicalSerialize(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort()
  const sorted: Record<string, unknown> = {}
  for (const k of keys) sorted[k] = obj[k]
  return JSON.stringify(sorted)
}

export function snfSend(db: Database.Database, args: {
  senderId: string
  recipientId: string
  messageType: SnfMessageType
  payload: Record<string, unknown>
  relatedOrderId?: string | null
  priority?: 0 | 1
  ttlDays?: number
}): { id: string; signature: string | null } {
  if (args.senderId === args.recipientId) throw new Error('snf_self_send_disallowed')
  const sender = db.prepare('SELECT api_key FROM users WHERE id = ?').get(args.senderId) as { api_key: string } | undefined
  if (!sender) throw new Error('snf_sender_not_found')
  const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(args.recipientId) as { id: string } | undefined
  if (!recipient) throw new Error('snf_recipient_not_found')

  const canon = canonicalSerialize({
    sender_id:    args.senderId,
    recipient_id: args.recipientId,
    message_type: args.messageType,
    payload:      args.payload,
    related_order_id: args.relatedOrderId || null,
  })
  if (canon.length > SNF_MAX_PAYLOAD) throw new Error('snf_payload_too_large')

  const signature = crypto.createHmac('sha256', sender.api_key).update(canon).digest('hex')
  const id = generateId('snf')
  const ttl = args.ttlDays ?? SNF_TTL_DAYS
  const expiresAt = new Date(Date.now() + ttl * 86400_000).toISOString()
  db.prepare(`
    INSERT INTO snf_messages (id, sender_id, recipient_id, message_type, payload, signature, priority, expires_at, related_order_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, args.senderId, args.recipientId, args.messageType, canon, signature, args.priority || 0, expiresAt, args.relatedOrderId || null)
  return { id, signature }
}

// 只读 list — 列出我作为收件人的近期消息（含已 delivered，TTL 内）
// 用于 UI 显示。不消费 — 刷新 / 重进页面都能看到。
// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点 snf.ts 均 inTx=false,无引擎内写调用)。
export async function snfListInbox(_db: Database.Database, userId: string, limit = 80, sinceDays = 30): Promise<Array<{
  id: string; sender_id: string; message_type: string; payload: Record<string, unknown>;
  signature: string | null; created_at: string; delivered_at: string | null; priority: number; related_order_id: string | null;
}>> {
  const rows = await dbAll<Record<string, unknown>>(`
    SELECT id, sender_id, message_type, payload, signature, created_at, delivered_at, priority, related_order_id
      FROM snf_messages
     WHERE recipient_id = ?
       AND dead_letter = 0
       AND datetime(expires_at) > datetime('now')
       AND datetime(created_at)  > datetime('now', ?)
     ORDER BY priority DESC, created_at DESC
     LIMIT ?
  `, [userId, '-' + sinceDays + ' days', limit])
  return rows.map(r => ({
    id: r.id as string,
    sender_id: r.sender_id as string,
    message_type: r.message_type as string,
    payload: (() => { try { const c = JSON.parse(r.payload as string); return (c?.payload as Record<string, unknown>) || {} } catch { return {} } })(),
    signature: (r.signature as string) || null,
    created_at: r.created_at as string,
    delivered_at: (r.delivered_at as string) || null,
    priority: (r.priority as number) || 0,
    related_order_id: (r.related_order_id as string) || null,
  }))
}

// 显式 ack — 用户点开消息或点 "mark all read" 时调用，把 delivered_at 戳上
// 幂等：已 ack 的不再覆盖
export function snfAck(db: Database.Database, userId: string, msgIds: string[]): { acked: number } {
  if (!msgIds.length) return { acked: 0 }
  const placeholders = msgIds.map(() => '?').join(',')
  const now = new Date().toISOString()
  const r = db.prepare(
    `UPDATE snf_messages SET delivered_at = ? WHERE recipient_id = ? AND delivered_at IS NULL AND id IN (${placeholders})`
  ).run(now, userId, ...msgIds)
  return { acked: r.changes }
}

// 拉取我作为收件人的未投递消息（自动 mark as delivered；幂等 — 同条不会重复返回）
// 用途：协议级 / agent 消费场景，不是 UI 入口（UI 应该用 snfListInbox + snfAck）
// Agent 工作流：成功处理 → 不用调用（已 delivered）；处理失败 → 调 snfNack(ids, error) 回放
export function snfPullInbox(db: Database.Database, userId: string, limit = 50): Array<{
  id: string; sender_id: string; message_type: string; payload: Record<string, unknown>;
  signature: string | null; created_at: string; priority: number; related_order_id: string | null;
  delivery_attempts: number;
}> {
  const rows = db.prepare(`
    SELECT id, sender_id, message_type, payload, signature, created_at, priority, related_order_id, delivery_attempts
      FROM snf_messages
     WHERE recipient_id = ? AND delivered_at IS NULL AND dead_letter = 0
       AND datetime(expires_at) > datetime('now')
     ORDER BY priority DESC, created_at ASC
     LIMIT ?
  `).all(userId, limit) as Array<Record<string, unknown>>

  const now = new Date().toISOString()
  const ids = rows.map(r => r.id as string)
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(`UPDATE snf_messages SET delivered_at = ?, last_attempt_at = ?, delivery_attempts = COALESCE(delivery_attempts,0) + 1 WHERE id IN (${placeholders})`).run(now, now, ...ids)
  }
  return rows.map(r => ({
    id: r.id as string,
    sender_id: r.sender_id as string,
    message_type: r.message_type as string,
    // 服务端存的是 canonical wrapper（含 sender/recipient/message_type/payload/related_order_id）；
    // 返给应用层只暴露 user payload 本身。验证签名时可重建 canonical。
    payload: (() => { try { const c = JSON.parse(r.payload as string); return (c?.payload as Record<string, unknown>) || {} } catch { return {} } })(),
    signature: (r.signature as string) || null,
    created_at: r.created_at as string,
    priority: (r.priority as number) || 0,
    related_order_id: (r.related_order_id as string) || null,
    delivery_attempts: ((r.delivery_attempts as number) || 0) + 1,   // 加 1 反映本次拉取后的值
  }))
}

// Agent 处理失败 → 回放消息（清 delivered_at 让下次 pull 重新拿到）
// 超过 SNF_MAX_RETRIES 自动死信化（避免无限循环）
// error 字段最多保留 500 字符
export function snfNack(db: Database.Database, userId: string, msgIds: string[], error?: string): { reopened: number; deadLettered: number } {
  if (!msgIds.length) return { reopened: 0, deadLettered: 0 }
  const safeError = error ? String(error).slice(0, 500) : null
  let reopened = 0, deadLettered = 0
  db.transaction(() => {
    for (const id of msgIds) {
      const row = db.prepare(`SELECT delivery_attempts, recipient_id FROM snf_messages WHERE id = ? AND dead_letter = 0`).get(id) as { delivery_attempts: number; recipient_id: string } | undefined
      if (!row || row.recipient_id !== userId) continue
      const attempts = row.delivery_attempts || 0
      if (attempts >= SNF_MAX_RETRIES) {
        // 自动死信
        db.prepare(`UPDATE snf_messages SET dead_letter = 1, last_error = ? WHERE id = ? AND recipient_id = ?`).run(safeError, id, userId)
        deadLettered++
      } else {
        // 回放：清 delivered_at + 记 error，下次 pull 会重新拿到
        db.prepare(`UPDATE snf_messages SET delivered_at = NULL, last_error = ? WHERE id = ? AND recipient_id = ?`).run(safeError, id, userId)
        reopened++
      }
    }
  })()
  return { reopened, deadLettered }
}

// 列出死信消息（人工 review 用 — admin / agent 异常排查）
export async function snfListDeadLetter(_db: Database.Database, userId: string, limit = 50): Promise<Array<{
  id: string; sender_id: string; message_type: string; delivery_attempts: number;
  last_error: string | null; last_attempt_at: string | null; created_at: string;
  related_order_id: string | null;
}>> {
  return await dbAll<{ id: string; sender_id: string; message_type: string; delivery_attempts: number; last_error: string | null; last_attempt_at: string | null; created_at: string; related_order_id: string | null }>(`
    SELECT id, sender_id, message_type, delivery_attempts, last_error, last_attempt_at, created_at, related_order_id
      FROM snf_messages
     WHERE recipient_id = ? AND dead_letter = 1
     ORDER BY last_attempt_at DESC NULLS LAST, created_at DESC
     LIMIT ?
  `, [userId, limit])
}

// 死信复活：清零 attempts + dead_letter + delivered_at，重新进 active 队列
// 用于：手动审查发现 transient 错误后想再试
export function snfRevive(db: Database.Database, userId: string, msgId: string): { ok: boolean; reason?: string } {
  const r = db.prepare(`SELECT recipient_id, dead_letter FROM snf_messages WHERE id = ?`).get(msgId) as { recipient_id: string; dead_letter: number } | undefined
  if (!r) return { ok: false, reason: 'not_found' }
  if (r.recipient_id !== userId) return { ok: false, reason: 'not_owner' }
  if (!r.dead_letter) return { ok: false, reason: 'not_dead_letter' }
  db.prepare(`UPDATE snf_messages SET dead_letter = 0, delivered_at = NULL, delivery_attempts = 0, last_error = NULL WHERE id = ?`).run(msgId)
  return { ok: true }
}

// 查看 inbox 未读数（不消费）
export async function snfPendingCount(_db: Database.Database, userId: string): Promise<number> {
  const r = await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM snf_messages WHERE recipient_id = ? AND delivered_at IS NULL AND dead_letter = 0 AND datetime(expires_at) > datetime('now')`, [userId])
  return r?.n ?? 0
}

// 验证签名（用 sender 当时的 api_key — 若 key 旋转过则失败）
export async function snfVerify(_db: Database.Database, msgId: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await dbOne<{ sender_id: string; payload: string; signature: string | null }>(`SELECT sender_id, payload, signature FROM snf_messages WHERE id = ?`, [msgId])
  if (!r) return { ok: false, reason: 'not_found' }
  if (!r.signature) return { ok: false, reason: 'no_signature' }
  const sender = await dbOne<{ api_key: string }>('SELECT api_key FROM users WHERE id = ?', [r.sender_id])
  if (!sender) return { ok: false, reason: 'sender_gone' }
  const sig = crypto.createHmac('sha256', sender.api_key).update(r.payload).digest('hex')
  return sig === r.signature ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
}

// 用户声明 SNF peers — 服务器永远是 implicit fallback
export function snfDesignate(db: Database.Database, userId: string, peers: string[]): void {
  db.prepare(`
    INSERT INTO snf_designations (user_id, snf_peers, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET snf_peers = excluded.snf_peers, updated_at = datetime('now')
  `).run(userId, JSON.stringify(peers.slice(0, 5)))   // 上限 5 个
}

export async function snfGetDesignation(_db: Database.Database, userId: string): Promise<string[]> {
  const r = await dbOne<{ snf_peers: string }>(`SELECT snf_peers FROM snf_designations WHERE user_id = ?`, [userId])
  if (!r) return []
  try { const p = JSON.parse(r.snf_peers); return Array.isArray(p) ? p : [] } catch { return [] }
}

// TTL cleanup — 每小时跑一次
export function snfCleanup(db: Database.Database): { removed: number } {
  const r = db.prepare(`DELETE FROM snf_messages WHERE datetime(expires_at) <= datetime('now')`).run()
  return { removed: r.changes }
}
