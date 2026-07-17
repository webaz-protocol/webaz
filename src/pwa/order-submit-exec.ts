/**
 * RFC-025 PR-5a — order-submit 批准执行域(钱路)。人 Passkey 批准后由服务端执行:创建订单
 * (escrow 轨 = 建单事务内钱包→托管扣款,即 D-4 定板"批准即创建+入 escrow")。
 *
 * 单一执行真相源:执行 = 【进程内回环调用真实 POST /api/orders】(注入的 createOrderLoopback)——
 *   区域/运费/库存 CAS/钱包扣款/spend-cap/直付门,全部走生产同一条路,零复刻零 drift。
 *
 * 三重防漂移(人批的 = 执行的,一字不差):
 *   ① params_hash:Passkey 绑定的 hash 必须等于【当下 draft 行】重算的 hash(draft 不可变+UNIQUE(quote_id),
 *      但仍重算 —— 直接改库的写者也骗不过批准)。
 *   ② preview 重验:computeBuyerQuote(mode='preview') 用当前市场状态重算,与 draft 快照逐经济字段对比,
 *      任何不一致 = 409 DRAFT_DRIFT 硬失败(绝不静默按新价执行),草稿退回 draft 状态,请重新报价。
 *   ③ 地址绑定:当前默认地址 sha256 必须等于 draft.address_summary_hash,变了 = ADDRESS_CHANGED 硬失败。
 *      全文地址只在本函数内部流转进回环调用,【绝不】进返回值/审计/日志。
 *
 * 恰一次语义(诚实版,orders-create 无幂等是已记录缺口):
 *   draft 'draft'→'ordering' CAS = 唯一执行闸门(并发批准恰一个过);
 *   回环明确失败(4xx/409)→ 回滚 'ordering'→'draft'(可重新批准或重报价);
 *   回环成功 → 'ordering'→'ordered' + order_id 回链 + request executed_at CAS;
 *   回环【结果不明】(网络/超时/5xx)→ draft 停在 'ordering'(fail-closed:绝不自动重试造重复订单),
 *      响应如实告知去 webaz.xyz 核对订单。
 *
 * I1(准确表述,Codex HIGH):本文件只被 approve handler(agent-grants.ts)import;agent-bearer 提交/MCP 层
 *   不 import 它。approve 端点经 auth() 可由 api_key bearer 到达(WebAZ 会话模型即 api_key)——真正的
 *   执行门是【一次性 Passkey gate token】(只有真人能铸,且绑定 request/draft/hash 四元组);无门票不可执行。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { computeBuyerQuote } from './buyer-quote.js'
import { orderSubmitParamsHash } from './order-submit-request.js'
import { toDecimal } from '../money.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export interface OrderLoopbackResult { status: number; json: Record<string, unknown> | null }
export type CreateOrderLoopback = (apiKey: string, body: Record<string, unknown>) => Promise<OrderLoopbackResult>

export interface SubmitExecResult {
  ok: boolean; http?: number; error?: string; error_code?: string;
  order_id?: string; already_executed?: boolean; ambiguous?: boolean
}

export async function approveAndExecuteOrderSubmit(db: Database.Database, deps: {
  requestId: string; approverId: string; nowIso: string;
  getProtocolParam: <T>(key: string, fallback: T) => T
  generateId: (p: string) => string
  createOrderLoopback: CreateOrderLoopback
}): Promise<SubmitExecResult> {
  const { requestId, approverId, nowIso } = deps
  const fail = (error_code: string, http: number, error: string): SubmitExecResult => ({ ok: false, error_code, http, error })
  // RFC-026 PR-1:干净失败(drift/地址变/草稿死/上游明确拒)→ 请求进终态 'failed' —— 释放 per-draft 与
  //   per-intent 活跃唯一坑位(重试 = agent 重新提交产生新请求,人重新批准新卡);结果不明(ambiguous)
  //   例外:保持 approved 占坑,同意图新购被挡直到人工核对 —— 防重复扣款优先于便利。
  const failTerminal = (error_code: string, http: number, error: string): SubmitExecResult => {
    db.prepare("UPDATE agent_permission_requests SET status = 'failed' WHERE id = ? AND executed_at IS NULL").run(requestId)
    return fail(error_code, http, error)
  }

  // ── 0. 请求行(pending→approved 原子 CAS,含未过期;approved 已执行的幂等短路) ──
  const reqRow = db.prepare("SELECT * FROM agent_permission_requests WHERE id = ? AND kind = 'order_submit'").get(requestId) as Record<string, unknown> | undefined
  if (!reqRow) return fail('SUBMIT_REQUEST_NOT_FOUND', 404, '提交请求不存在')
  if (reqRow.human_id !== approverId) return fail('NOT_YOUR_REQUEST', 403, '不是你的提交请求')
  if (reqRow.executed_at) {
    const d0 = db.prepare('SELECT order_id FROM order_drafts WHERE id = ?').get(String(reqRow.order_id)) as { order_id: string | null } | undefined
    return { ok: true, already_executed: true, order_id: d0?.order_id ?? undefined }
  }
  const claim = db.prepare("UPDATE agent_permission_requests SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?").run(nowIso, requestId, nowIso)
  if (claim.changes !== 1) {
    // RFC-026 PR-1:并发第二个批准会读到 stale 'pending' —— 重读现值再判。已执行 → 直接返回已建订单号
    //   (§11.2 重复批准返回已有结果);approved 未执行(对手正在跑或干净失败待重试)→ 继续,下游 draft 闸门收敛。
    const fresh = db.prepare('SELECT status, executed_at FROM agent_permission_requests WHERE id = ?').get(requestId) as { status: string; executed_at: string | null } | undefined
    if (fresh?.executed_at) {
      const d1 = db.prepare('SELECT order_id FROM order_drafts WHERE id = ?').get(String(reqRow.order_id)) as { order_id: string | null } | undefined
      return { ok: true, already_executed: true, order_id: d1?.order_id ?? undefined }
    }
    if (fresh?.status !== 'approved') return fail('SUBMIT_REQUEST_NOT_PENDING', 409, '提交请求已过期或已处理')
  }

  const draftId = String(reqRow.order_id)
  const draft = db.prepare('SELECT * FROM order_drafts WHERE id = ? AND buyer_id = ?').get(draftId, approverId) as Record<string, unknown> | undefined
  if (!draft) return failTerminal('DRAFT_NOT_FOUND', 404, '草稿不存在')
  if (String(draft.status) === 'ordering') return fail('ORDER_CREATE_AMBIGUOUS', 409, '上一次执行结果不明(草稿处于 ordering)。请先到 webaz.xyz 订单页核对是否已建单,避免重复下单。')
  if (String(draft.status) === 'ordered') { db.prepare('UPDATE agent_permission_requests SET executed_at = ? WHERE id = ? AND executed_at IS NULL').run(nowIso, requestId); return { ok: true, already_executed: true, order_id: draft.order_id ? String(draft.order_id) : undefined } }
  if (String(draft.status) !== 'draft') return failTerminal('DRAFT_NOT_AVAILABLE', 409, `草稿状态为 ${String(draft.status)},不可执行`)
  if (String(draft.expires_at) <= nowIso) return failTerminal('DRAFT_NOT_AVAILABLE', 409, '草稿已过期,请重新报价')

  // ── ① params_hash 重算必须与 Passkey 绑定的一致(直接改库也骗不过) ──
  if (orderSubmitParamsHash(draft) !== String(reqRow.params_hash)) return failTerminal('DRAFT_DRIFT', 409, '草稿内容与你 Passkey 批准的内容不一致,已拒绝执行')

  // ── ③ 地址绑定:当前默认地址必须仍是报价时那一个(全文只在本进程内部) ──
  const u = db.prepare('SELECT api_key, default_address_text FROM users WHERE id = ?').get(approverId) as { api_key: string; default_address_text: string | null } | undefined
  const addrText = (u?.default_address_text || '').trim()
  if (!addrText) return failTerminal('ADDRESS_CHANGED', 409, '默认地址已被清空 —— 请在 webaz.xyz 重设默认地址后重新报价')
  if (draft.address_summary_hash && sha(addrText) !== String(draft.address_summary_hash)) {
    return failTerminal('ADDRESS_CHANGED', 409, '默认地址在报价后被修改 —— 请重新报价以按新地址计算运费/可售性')
  }

  // ── ② preview 重验:当前市场状态重算,与快照逐经济字段对比(drift = 硬失败,绝不静默换条件) ──
  const pv = computeBuyerQuote(db, { generateId: deps.generateId, getProtocolParam: deps.getProtocolParam }, approverId, {
    product_id: String(draft.product_id), variant_id: draft.variant_id == null ? undefined : String(draft.variant_id),
    quantity: Number(draft.quantity), payment_rail: String(draft.payment_rail),
    direct_receive_account_id: draft.direct_receive_account_id == null ? undefined : String(draft.direct_receive_account_id),
    anonymous_recipient: Number(draft.anonymous_recipient) === 1, donation_bps: Number(draft.donation_bps), address_source: 'default',
  }, 'preview')
  if (!pv.ok) return failTerminal('DRAFT_DRIFT', 409, `当前市场状态下该报价已不成立(${pv.body.error_code}:${pv.body.reason})—— 请重新报价`)
  const now = pv.response as Record<string, unknown>
  // 对比集 = 快照的全部身份+经济字段 -- Codex BLOCKER-2: seller_id 是 preview 现算的真实漂移向量,商品换主后价格不变也必须拒;其余身份字段一并锁死
  for (const k of ['product_id', 'variant_id', 'seller_id', 'quantity', 'unit_price_units', 'item_units', 'shipping_units', 'donation_bps', 'donation_units', 'total_units', 'payable_units', 'currency', 'payment_rail', 'direct_receive_account_id', 'dest_region', 'address_summary_hash', 'anonymous_recipient'] as const) {
    if (String(now[k] ?? '') !== String(draft[k] ?? '')) {
      return failTerminal('DRAFT_DRIFT', 409, `${k} 已变化(报价 ${String(draft[k])} → 当前 ${String(now[k])})—— 条款绝不静默变更,请重新报价`)
    }
  }

  // ── 恰一次闸门:draft→ordering CAS(并发批准恰一个能过) ──
  const gate = db.prepare("UPDATE order_drafts SET status = 'ordering' WHERE id = ? AND status = 'draft' AND expires_at > ?").run(draftId, nowIso)
  if (gate.changes !== 1) return fail('DRAFT_NOT_AVAILABLE', 409, '草稿状态并发变化,请重试或重新报价')

  // ── 执行 = 回环调用真实 POST /api/orders(生产同路;expected_price 是第二道价格网) ──
  const body: Record<string, unknown> = {
    product_id: String(draft.product_id),
    quantity: Number(draft.quantity),
    shipping_address: addrText,                         // 内部流转;绝不进返回值/审计
    expected_price: toDecimal(Number(draft.unit_price_units)),
    ship_to_region: draft.dest_region == null ? undefined : String(draft.dest_region),
    donation_pct: Number(draft.donation_bps) / 10000,
    draft_id: draftId,                                  // RFC-026 PR-1:orders.draft_id 唯一约束 = 一 draft 一单的 DB 级兜底
  }
  if (draft.variant_id != null) body.variant_id = String(draft.variant_id)
  if (Number(draft.anonymous_recipient) === 1) body.anonymous_recipient = true
  if (String(draft.payment_rail) === 'direct_p2p') {
    body.payment_rail = 'direct_p2p'
    if (draft.direct_receive_account_id != null) body.direct_receive_account_id = String(draft.direct_receive_account_id)
  }
  let lb: OrderLoopbackResult
  try {
    lb = await deps.createOrderLoopback(String(u!.api_key), body)
  } catch {
    // 结果不明:订单可能已建。fail-closed —— draft 停在 ordering,绝不自动重试造重复订单。
    return { ok: false, http: 502, error: '建单调用结果不明 —— 为避免重复下单已冻结该草稿;请到 webaz.xyz 订单页核对,若未建单请联系管理员恢复草稿。', error_code: 'ORDER_CREATE_AMBIGUOUS', ambiguous: true }
  }
  const orderId = lb.json && (typeof lb.json.order_id === 'string' ? lb.json.order_id : (lb.json.order as Record<string, unknown> | undefined)?.id)
  const created = lb.status >= 200 && lb.status < 300 && !!orderId && !(lb.json && lb.json.error)
  if (!created) {
    if (lb.status >= 500) {
      return { ok: false, http: 502, error: '建单调用结果不明(上游 5xx)—— 草稿已冻结防重复;请到 webaz.xyz 核对。', error_code: 'ORDER_CREATE_AMBIGUOUS', ambiguous: true }
    }
    // 明确失败(4xx / 200+error 体):安全回滚草稿,原样透传上游错误码(库存/价格/余额/直付门等)。
    db.prepare("UPDATE order_drafts SET status = 'draft' WHERE id = ? AND status = 'ordering'").run(draftId)
    const upstream = (lb.json && (lb.json.error_code || lb.json.error)) ? String(lb.json.error_code || lb.json.error) : `HTTP_${lb.status}`
    return failTerminal(String(lb.json?.error_code || 'ORDER_CREATE_REJECTED'), 409, `建单被拒绝(${upstream})—— 草稿已退回,可修正后重新报价`)
  }
  // ── 成功:draft→ordered + 回链 + executed_at(同一事务收尾;订单已在生产路径落地) ──
  db.transaction(() => {
    db.prepare("UPDATE order_drafts SET status = 'ordered', order_id = ? WHERE id = ? AND status = 'ordering'").run(String(orderId), draftId)
    db.prepare('UPDATE agent_permission_requests SET executed_at = ?, execution_result = ? WHERE id = ? AND executed_at IS NULL').run(nowIso, JSON.stringify({ order_id: orderId }), requestId)
  }).immediate()
  return { ok: true, order_id: String(orderId) }
}
