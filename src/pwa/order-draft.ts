/**
 * RFC-025 PR-4 — Order Draft Service(激活 draft_order capability 的首个消费者 · 零经济执行 · 零 PII)。
 *
 * create:消费一个【本人、未过期、未消费】的 quote_token → 冻结快照为 order_drafts 行。
 *   一次性:order_quotes.consumed_at CAS 与 draft INSERT 同在一个同步事务 —— 同一 quote 绝不产生两份草稿。
 *   快照列 = quote 行整数金额原样复制(零重算 = 与报价零 drift);草稿不可变(无 update,仅 cancel 终态)。
 * cancel:draft → cancelled(CAS,幂等安全);get/list:仅本人,输出与 quote 响应同纪律(masked id,零 PII)。
 *
 * 不做的事(PR-5a 的事):不建真实订单、不扣款、不锁资金、不动库存、不 Passkey;
 *   提交(submitted)与批准后的全量重校验(价格/库存/资格,drift=硬失败)在 PR-5a。
 * auth 适配:与 buyer-quote 同形态 —— route 解析 humanId 后调用,本模块不做鉴权。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { verifyQuoteToken } from './buyer-quote.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export const DRAFT_TTL_MS = 24 * 60 * 60_000   // 24h(与 agent_permission_requests 同窗;过期草稿 PR-5a 拒提交)

export interface DraftError {
  ok: false
  status: number
  body: { error_code: string; reason: string; retryable: boolean; missing_requirements: string[]; next_steps: string[]; [k: string]: unknown }
}
const derr = (status: number, error_code: string, reason: string, extra: Partial<DraftError['body']> = {}): DraftError =>
  ({ ok: false, status, body: { error_code, reason, retryable: false, missing_requirements: [], next_steps: [], ...extra } })

const maskId = (id: string): string => !id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `${id.slice(0, 2)}…`

/** 草稿行 → agent 面投影(allowlist 构造;零 PII;与 quote 响应字段口径一致)。 */
export function draftView(db: Database.Database, row: Record<string, unknown>): Record<string, unknown> {
  const buyer = db.prepare('SELECT handle FROM users WHERE id = ?').get(String(row.buyer_id)) as { handle: string | null } | undefined
  const prod = db.prepare('SELECT title FROM products WHERE id = ?').get(String(row.product_id)) as { title: string } | undefined
  return {
    draft_id: String(row.id),
    status: String(row.status),
    acting_as: buyer?.handle ? `@${buyer.handle}` : null,
    account_id_hint: maskId(String(row.buyer_id)),
    quote_id: String(row.quote_id),
    product: { product_id: String(row.product_id), title: prod ? prod.title : null, variant_id: row.variant_id == null ? null : String(row.variant_id), seller_id_hint: maskId(String(row.seller_id)) },
    quantity: Number(row.quantity),
    destination: { address_source: 'default', address_summary: `Default address · ${row.dest_region ? String(row.dest_region) : 'region unset'}`, region: row.dest_region == null ? null : String(row.dest_region) },
    payment_rail: String(row.payment_rail),
    total: { amount_minor: Number(row.total_units), currency: 'WAZ', currency_exponent: 6 },
    payable_total: { amount_minor: Number(row.payable_units), currency: 'WAZ', currency_exponent: 6, note: 'total + donation — what an escrow order will debit at creation' },
    donation_bps: Number(row.donation_bps),
    anonymous_recipient: Number(row.anonymous_recipient) === 1,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    ...(row.cancelled_at ? { cancelled_at: String(row.cancelled_at) } : {}),
    stock_reserved: false,
    economic_action_executed: false,
    note: 'A draft is a frozen quote snapshot — no order exists, nothing was charged, no stock is held. Price/stock/eligibility are re-validated at human approval (RFC-025 PR-5a, not yet available); drift there hard-fails back to a fresh quote.',
    next_action: 'submit for human Passkey approval (RFC-025 PR-5a, NOT yet available). Until then a human orders at webaz.xyz, or an api_key agent uses webaz_place_order.',
  }
}

interface DraftDeps { generateId: (prefix: string) => string }

export function createOrderDraft(db: Database.Database, deps: DraftDeps, humanId: string, input: { quote_token?: unknown; idempotency_key?: unknown }):
  { ok: true; response: Record<string, unknown> } | DraftError {
  // 幂等 key:与 quote 同纪律(入库,必须 token 形态,拒自由文本/PII 形态)
  let idemKey: string | null = null
  if (input.idempotency_key !== undefined && input.idempotency_key !== null) {
    if (typeof input.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.idempotency_key)) {
      return derr(400, 'IDEMPOTENCY_KEY_INVALID', 'idempotency_key must match [A-Za-z0-9_-]{1,64} (it is stored — no free text/PII shapes)', { retryable: true })
    }
    idemKey = input.idempotency_key
  }
  const nowIso = new Date().toISOString()
  // 幂等短路(事务外只读预检;权威判定在事务内唯一索引)
  if (idemKey) {
    const prev = db.prepare('SELECT * FROM order_drafts WHERE buyer_id = ? AND idempotency_key = ?').get(humanId, idemKey) as Record<string, unknown> | undefined
    if (prev) {
      // 同键重放的唯一判据:呈交的 token 指向的就是 prev 消费的那个 quote(quote_id 即载荷指纹;token 一次性,
      //   不看 draft 状态 —— 之前按 status==='draft' 放行会把【不同 quote】误判为重放,测试 I-2 抓实)。
      const tokRow = typeof input.quote_token === 'string' && input.quote_token.startsWith('qtk_')
        ? db.prepare('SELECT id, human_id FROM order_quotes WHERE token_hash = ?').get(sha(input.quote_token)) as { id: string; human_id: string } | undefined
        : undefined
      if (tokRow && tokRow.human_id === humanId && String(tokRow.id) === String(prev.quote_id)) {
        return { ok: true, response: { ...draftView(db, prev), idempotent_replay: true } }
      }
      return derr(409, 'IDEMPOTENCY_CONFLICT', 'this idempotency_key was already used for a different draft — pick a new key', { retryable: true })
    }
  }
  // 消费 quote(一次性 CAS + INSERT 同事务)
  const v = verifyQuoteToken(db, input.quote_token, humanId)
  if (!v.ok) {
    const map: Record<string, [number, string, string]> = {
      QUOTE_TOKEN_INVALID: [401, 'QUOTE_TOKEN_INVALID', 'quote_token unknown, malformed, or not yours — request a fresh quote via webaz_quote_order'],
      TOKEN_EXPIRED: [409, 'TOKEN_EXPIRED', 'this quote expired (10-min TTL) — request a fresh quote via webaz_quote_order'],
      QUOTE_ALREADY_CONSUMED: [409, 'QUOTE_ALREADY_CONSUMED', 'this quote was already converted into a draft — one quote, one draft'],
    }
    const [st, code, reason] = map[v.error_code]
    return derr(st, code, reason, { next_steps: ['webaz_quote_order'] })
  }
  const q = v.quote
  const draftId = deps.generateId('odr')
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString()
  try {
    const made = db.transaction((): boolean => {
      const cas = db.prepare("UPDATE order_quotes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").run(nowIso, String(q.id), nowIso)
      if (cas.changes !== 1) return false   // 并发消费/刚过期 → 让上层给准确错误
      db.prepare(`INSERT INTO order_drafts (id, buyer_id, quote_id, product_id, variant_id, seller_id, quantity, unit_price_units,
          item_units, shipping_units, donation_bps, donation_units, total_units, payable_units, currency, payment_rail,
          direct_receive_account_id, dest_region, address_summary_hash, anonymous_recipient, status, idempotency_key, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`)
        .run(draftId, humanId, String(q.id), String(q.product_id), q.variant_id ?? null, String(q.seller_id), Number(q.quantity), Number(q.unit_price_units),
          Number(q.item_units), Number(q.shipping_units), Number(q.donation_bps), Number(q.donation_units), Number(q.total_units), Number(q.payable_units), 'WAZ', String(q.payment_rail),
          q.direct_receive_account_id ?? null, q.dest_region ?? null, q.address_summary_hash ?? null, Number(q.anonymous_recipient), idemKey, expiresAt)
      return true
    }).immediate()
    if (!made) return derr(409, 'QUOTE_ALREADY_CONSUMED', 'this quote was consumed or expired concurrently — request a fresh quote', { next_steps: ['webaz_quote_order'] })
  } catch (e) {
    if (idemKey && /idx_od_idem|order_drafts\.buyer_id|order_drafts\.idempotency_key/i.test((e as Error).message)) {
      const winner = db.prepare('SELECT * FROM order_drafts WHERE buyer_id = ? AND idempotency_key = ?').get(humanId, idemKey) as Record<string, unknown> | undefined
      if (winner && String(winner.quote_id) === String(q.id)) return { ok: true, response: { ...draftView(db, winner), idempotent_replay: true } }
      return derr(409, 'IDEMPOTENCY_CONFLICT', 'this idempotency_key was used concurrently for a different draft — pick a new key', { retryable: true })
    }
    return derr(503, 'DRAFT_CREATION_FAILED', 'draft ledger unavailable — the quote was NOT consumed; retry shortly', { retryable: true })
  }
  const row = db.prepare('SELECT * FROM order_drafts WHERE id = ?').get(draftId) as Record<string, unknown>
  return { ok: true, response: draftView(db, row) }
}

export function cancelOrderDraft(db: Database.Database, humanId: string, draftId: unknown):
  { ok: true; response: Record<string, unknown> } | DraftError {
  if (typeof draftId !== 'string' || !draftId) return derr(400, 'DRAFT_NOT_FOUND', 'draft_id is required', { retryable: true })
  const row = db.prepare('SELECT * FROM order_drafts WHERE id = ? AND buyer_id = ?').get(draftId, humanId) as Record<string, unknown> | undefined
  if (!row) return derr(404, 'DRAFT_NOT_FOUND', 'no such draft (or not yours)')
  if (row.status === 'cancelled') return { ok: true, response: { ...draftView(db, row), already_cancelled: true } }   // 幂等安全
  if (row.status !== 'draft') return derr(409, 'DRAFT_NOT_CANCELLABLE', `draft status is ${String(row.status)} — only status=draft can be cancelled`)
  const cas = db.prepare("UPDATE order_drafts SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'draft'").run(draftId)
  if (cas.changes !== 1) return derr(409, 'DRAFT_NOT_CANCELLABLE', 'draft state changed concurrently — re-read it')
  return { ok: true, response: draftView(db, db.prepare('SELECT * FROM order_drafts WHERE id = ?').get(draftId) as Record<string, unknown>) }
}

export function getOrderDraft(db: Database.Database, humanId: string, draftId: unknown):
  { ok: true; response: Record<string, unknown> } | DraftError {
  if (typeof draftId !== 'string' || !draftId) return derr(400, 'DRAFT_NOT_FOUND', 'draft_id is required', { retryable: true })
  const row = db.prepare('SELECT * FROM order_drafts WHERE id = ? AND buyer_id = ?').get(draftId, humanId) as Record<string, unknown> | undefined
  if (!row) return derr(404, 'DRAFT_NOT_FOUND', 'no such draft (or not yours)')
  return { ok: true, response: draftView(db, row) }
}

export function listOrderDrafts(db: Database.Database, humanId: string): { ok: true; response: Record<string, unknown> } {
  const rows = db.prepare('SELECT * FROM order_drafts WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 50').all(humanId) as Array<Record<string, unknown>>
  return { ok: true, response: { count: rows.length, drafts: rows.map(r => draftView(db, r)) } }
}
