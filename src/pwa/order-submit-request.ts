/**
 * RFC-025 PR-5a — order-submit 请求提交域(SUBMIT-only,镜像 RFC-021 order-action-request 的骨架)。
 *
 * 语义:把一个【本人、status=draft、未过期】的订单草稿塞进人工审批队列(agent_permission_requests,
 * kind='order_submit',order_id 列复用为 draft_id)。【绝不执行】—— 建单+扣款只发生在人 Passkey 批准后
 * 由 order-submit-exec 跑(I1 同款:执行器不被本文件 import,agent-bearer 路径永远够不到执行)。
 *
 * params_hash = SHA-256(canonical 全经济快照):draft 的每一个经济字段都进 hash —— 人批的 = 将要执行的,
 * 一字不差(D-4/审计 doc §4;draft 本身不可变 + UNIQUE(quote_id),双保险)。
 * 零 PII:快照本就只有 region 标签 + 地址 sha256;action_params 只存 {draft_id}(展示由审批卡按 id 现查)。
 * 同 draft 唯一 pending:复用 (order_id, order_action) 唯一索引(order_action='order_submit')。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { resolveDirectReceive } from '../direct-receive-resolve.js'   // B6a:审批摘要携带"收款目的地是否可解析"真值(供审批门/卡)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** draft 行 → canonical 经济快照 hash(逐字段显式列出;新增经济字段必须进这里,测试锁字段集)。 */
export function orderSubmitParamsHash(draft: Record<string, unknown>): string {
  return sha(JSON.stringify({
    draft_id: String(draft.id),
    product_id: String(draft.product_id),
    variant_id: draft.variant_id == null ? null : String(draft.variant_id),
    seller_id: String(draft.seller_id),
    quantity: Number(draft.quantity),
    unit_price_units: Number(draft.unit_price_units),
    item_units: Number(draft.item_units),
    shipping_units: Number(draft.shipping_units),
    donation_bps: Number(draft.donation_bps),
    donation_units: Number(draft.donation_units),
    total_units: Number(draft.total_units),
    payable_units: Number(draft.payable_units),
    currency: String(draft.currency),
    payment_rail: String(draft.payment_rail),
    direct_receive_account_id: draft.direct_receive_account_id == null ? null : String(draft.direct_receive_account_id),
    dest_region: draft.dest_region == null ? null : String(draft.dest_region),
    address_summary_hash: draft.address_summary_hash == null ? null : String(draft.address_summary_hash),
    anonymous_recipient: Number(draft.anonymous_recipient),
  }))
}

/** 审批列表的 order_submit 行摘要(域层做 sync 读,route 文件不加 seam 计数;零 PII:region 标签 only)。 */
export function submitRowSummary(db: Database.Database, draftId: string): Record<string, unknown> | null {
  const d = db.prepare('SELECT product_id, variant_id, seller_id, quantity, unit_price_units, item_units, shipping_units, donation_bps, donation_units, total_units, payable_units, currency, payment_rail, direct_receive_account_id, anonymous_recipient, dest_region, status, expires_at FROM order_drafts WHERE id = ?').get(draftId) as Record<string, unknown> | undefined
  if (!d) return null
  const prod = db.prepare('SELECT title FROM products WHERE id = ?').get(String(d.product_id)) as { title: string } | undefined
  const seller = db.prepare('SELECT handle FROM users WHERE id = ?').get(String(d.seller_id)) as { handle: string | null } | undefined
  const maskId = (id: string): string => !id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `${id.slice(0, 2)}…`
  // B6a:direct_p2p 的真实收款目的地由服务端解析(chosen→legacy→唯一 active 账号);审批门/卡据此判断,
  //   而非用 direct_receive_account_id==null 误判"无账户"。只投影非敏感元数据,收款原文绝不出现在摘要。
  const rr = String(d.payment_rail) === 'direct_p2p'
    ? resolveDirectReceive(db, String(d.seller_id), d.direct_receive_account_id == null ? undefined : String(d.direct_receive_account_id))
    : null
  return {
    draft_id: draftId, product_id: String(d.product_id),
    product_title: prod?.title ?? null,
    product_title_note: 'live listing title for recognition only — the approval binds product_id, not the title',
    variant_id: d.variant_id ?? null, seller_id_hint: maskId(String(d.seller_id)),
    seller_handle: seller?.handle ? `@${seller.handle}` : null,   // hash 绑定 seller_id 的公开可核对投影
    quantity: Number(d.quantity), unit_price_units: Number(d.unit_price_units),
    item_units: Number(d.item_units), shipping_units: Number(d.shipping_units),
    donation_bps: Number(d.donation_bps), donation_units: Number(d.donation_units),
    total_units: Number(d.total_units), payable_units: Number(d.payable_units),
    // P0-C 币种一致性:审批摘要对外统一显示 USDC 别名(1 WAZ=1 USDC=1e6,纯展示 relabel;记账/结算仍模拟 WAZ)。
    //   与 quote/draft 消费投影一致,消除审批页独露 WAZ 的漂移。currency 仅展示用 —— params_hash 读 draft.currency,
    //   相似购买分组按 payable_units+payment_rail(均不受此影响);真实结算轨的诚实文案由 railHonesty()/rail_note 承载。
    currency: 'USDC', payment_rail: String(d.payment_rail),
    direct_receive_account_id: d.direct_receive_account_id ?? null,
    // B6a:direct_p2p 收款目的地真值 —— resolvable=false 才是真"无可用收款目的地";resolvable=true 时给非敏感目的地
    //   描述(method/currency/label/source),审批卡如实展示、审批门(B6c)据此判断,不再用 account_id==null 误判。
    ...(rr ? { direct_pay_destination_resolvable: rr.resolvable, direct_pay_destination: rr.resolvable ? { source: rr.source, method: rr.method, currency: rr.currency, label: rr.label } : null } : {}),
    anonymous_recipient: Number(d.anonymous_recipient) === 1,
    dest_region: d.dest_region ?? null, draft_status: String(d.status), draft_expires_at: String(d.expires_at),
  }
}

/** 购买意图指纹(RFC-026 PR-1):params_hash 的经济字段【去掉 draft_id】+ 买家 —— 重新报价换 draft
 *  也算同一意图。合法再购的出路:①上一单执行完成(executed_at)后指纹自动释放;②改数量/条款=新指纹。 */
export function orderSubmitIntentHash(humanId: string, draft: Record<string, unknown>): string {
  return sha(JSON.stringify({
    human_id: humanId,
    product_id: String(draft.product_id),
    variant_id: draft.variant_id == null ? null : String(draft.variant_id),
    seller_id: String(draft.seller_id),
    quantity: Number(draft.quantity),
    unit_price_units: Number(draft.unit_price_units),
    item_units: Number(draft.item_units),
    shipping_units: Number(draft.shipping_units),
    donation_bps: Number(draft.donation_bps),
    donation_units: Number(draft.donation_units),
    total_units: Number(draft.total_units),
    payable_units: Number(draft.payable_units),
    currency: String(draft.currency),
    payment_rail: String(draft.payment_rail),
    direct_receive_account_id: draft.direct_receive_account_id == null ? null : String(draft.direct_receive_account_id),
    dest_region: draft.dest_region == null ? null : String(draft.dest_region),
    address_summary_hash: draft.address_summary_hash == null ? null : String(draft.address_summary_hash),
    anonymous_recipient: Number(draft.anonymous_recipient),
  }))
}

export interface SubmitResult { ok: true; request_id: string; params_hash: string; duplicate?: boolean }
export interface SubmitError { ok: false; http: number; error: string; error_code: string }

/** 活跃(未终结未执行)的 order_submit 行:同 draft 或同意图。 */
function findActiveSubmit(db: Database.Database, humanId: string, draftId: string, intentHash: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT id, order_id, params_hash, status, expires_at FROM agent_permission_requests
      WHERE kind = 'order_submit' AND human_id = ? AND status IN ('pending','approved') AND executed_at IS NULL
        AND (order_id = ? OR intent_hash = ?) ORDER BY created_at DESC LIMIT 1`).get(humanId, draftId, intentHash) as Record<string, unknown> | undefined
}

export function createOrderSubmitRequest(db: Database.Database, args: {
  draftId: string; grantId: string; humanId: string; agentLabel: string; generateId: (p: string) => string
}): SubmitResult | SubmitError {
  const { draftId, grantId, humanId, agentLabel, generateId } = args
  const nowIso = new Date().toISOString()
  const draft = db.prepare('SELECT * FROM order_drafts WHERE id = ? AND buyer_id = ?').get(draftId, humanId) as Record<string, unknown> | undefined
  if (!draft) return { ok: false, http: 404, error: '草稿不存在或不属于你', error_code: 'DRAFT_NOT_FOUND' }
  if (String(draft.status) !== 'draft') return { ok: false, http: 409, error: `草稿状态为 ${String(draft.status)},不可提交`, error_code: 'DRAFT_NOT_AVAILABLE' }
  if (String(draft.expires_at) <= nowIso) return { ok: false, http: 409, error: '草稿已过期(24h),请重新报价并建草稿', error_code: 'DRAFT_NOT_AVAILABLE' }
  const paramsHash = orderSubmitParamsHash(draft)
  const intentHash = orderSubmitIntentHash(humanId, draft)
  // 至多重试一次:唯一撞车的对手若已过期,标记 expired 腾位后重插(索引只放行一条活跃行,竞态安全)。
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestId = generateId('apr')
    try {
      db.prepare(`INSERT INTO agent_permission_requests
          (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, intent_hash, action_params)
        VALUES (?,?,?,?, '[]', 'high', 'once', 'pending', ?, 'order_submit', ?, 'order_submit', ?, ?, ?)`)
        .run(requestId, humanId, grantId, agentLabel, new Date(Date.now() + 24 * 3600_000).toISOString(), draftId, paramsHash, intentHash, JSON.stringify({ draft_id: draftId }))
      return { ok: true, request_id: requestId, params_hash: paramsHash }
    } catch (e) {
      if (!/UNIQUE/i.test((e as Error).message)) return { ok: false, http: 503, error: '提交暂不可用,请稍后重试', error_code: 'SUBMIT_UNAVAILABLE' }
      const existing = findActiveSubmit(db, humanId, draftId, intentHash)
      if (!existing) continue   // 对手行刚终结 → 直接重插
      if (String(existing.status) === 'pending' && String(existing.expires_at) <= nowIso) {
        db.prepare("UPDATE agent_permission_requests SET status = 'expired' WHERE id = ? AND status = 'pending'").run(String(existing.id))
        continue
      }
      // 占坑行的草稿已死(取消/超时;'ordering' 冻结不算死 —— 结果不明必须占坑)→ 过期腾位重插
      const exd = db.prepare('SELECT status, expires_at FROM order_drafts WHERE id = ?').get(String(existing.order_id)) as { status: string; expires_at: string } | undefined
      if (!exd || exd.status === 'cancelled' || (exd.status === 'draft' && String(exd.expires_at) <= nowIso)) {
        db.prepare("UPDATE agent_permission_requests SET status = 'expired' WHERE id = ? AND status IN ('pending','approved') AND executed_at IS NULL").run(String(existing.id))
        continue
      }
      // RFC-026 §11.3/§13:等价请求【返回已有请求】而不是让 agent 猜 —— 幂等重用,绝不第二条活跃。
      return { ok: true, request_id: String(existing.id), params_hash: String(existing.params_hash), duplicate: true }
    }
  }
  return { ok: false, http: 503, error: '提交暂不可用,请稍后重试', error_code: 'SUBMIT_UNAVAILABLE' }
}
