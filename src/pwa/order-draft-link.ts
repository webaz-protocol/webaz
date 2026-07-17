/**
 * RFC-026 PR-1 — 订单↔草稿关联解析(orders.draft_id 唯一约束的守门人)。
 *
 * 只有 order-submit-exec 的回环调用会携带 draft_id(它先把草稿 CAS 到 'ordering');任何其他调用方
 * (人工 PWA / api_key agent / 恶意构造)带 draft_id 都过不了这里的归属+状态校验 —— 防止用别人的
 * draft_id 占坑把真执行卡死。已有链接的草稿 → 幂等返回第一笔订单(绝不建第二笔)。
 */
import type Database from 'better-sqlite3'

export type DraftLinkResolution =
  | { kind: 'none' }
  | { kind: 'link'; draftId: string }
  | { kind: 'existing'; orderId: string }
  | { kind: 'invalid'; error: string }

export function resolveDraftLink(db: Database.Database, rawDraftId: unknown, buyerId: string): DraftLinkResolution {
  if (rawDraftId === undefined || rawDraftId === null || rawDraftId === '') return { kind: 'none' }
  if (typeof rawDraftId !== 'string') return { kind: 'invalid', error: 'draft_id 必须是字符串' }
  const d = db.prepare('SELECT id, buyer_id, status FROM order_drafts WHERE id = ?').get(rawDraftId) as { id: string; buyer_id: string; status: string } | undefined
  if (!d || d.buyer_id !== buyerId) return { kind: 'invalid', error: '草稿不存在或不属于当前买家' }
  const linked = db.prepare('SELECT id FROM orders WHERE draft_id = ?').get(rawDraftId) as { id: string } | undefined
  if (linked) return { kind: 'existing', orderId: linked.id }
  if (d.status !== 'ordering') return { kind: 'invalid', error: '草稿未处于执行中状态(draft_id 仅供 Passkey 批准执行路径使用)' }
  return { kind: 'link', draftId: rawDraftId }
}
