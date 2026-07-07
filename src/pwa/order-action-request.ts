/**
 * RFC-021 PR2 — order-action 请求 domain(创建 pending + Passkey 批准到 approved)。
 *
 * ⚠️ 硬边界(PR2):本模块【绝不执行订单动作、不改订单状态、不碰钱路】。approveOrderActionRequest 只把请求
 *   CAS 到 status='approved' 就停;执行(executeSellerOrderAction)全在 PR3。本模块不 import 任何执行/状态机/结算。
 *
 * 放在【非 route 文件】:sync db.transaction(CAS + 审计原子)在这里,route(agent-grants.ts)只调本模块 →
 *   不增加 route 层 sync db.prepare 计数(routes seam ratchet 已满,只能降不能升)。
 *
 * I6:action_params 只保留 ship 的 {tracking, evidence_ref};任何其它键(含地址)一律丢弃,绝不入库/入 audit。
 * I2:params_hash = SHA-256(canonical {order_id, action, params}) —— 批准 Passkey 绑此三元组。
 * I5:executed_at 列由 PR3 写;本模块永不写。I3:绝不 UPDATE accept_deadline/ship_deadline。
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export type OrderAction = 'accept' | 'ship'
const TTL_HOURS = 24   // 请求短 TTL(I5)

/** I6:仅 ship 保留 {tracking, evidence_ref};accept 无参;其它键(含任何地址)一律丢弃。 */
export function sanitizeOrderActionParams(action: string, raw: unknown): Record<string, string> {
  if (action !== 'ship') return {}
  const r = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  if (r.tracking != null) out.tracking = String(r.tracking)
  if (r.evidence_ref != null) out.evidence_ref = String(r.evidence_ref)
  return out
}

export function computeParamsHash(orderId: string, action: string, params: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify({ order_id: orderId, action, params })).digest('hex')
}

export interface DomainResult { ok: boolean; request_id?: string; params_hash?: string; error?: string; error_code?: string; http?: number }

/** 写 pending 请求;不执行、不改订单。归属校验(seller 本人)+ D2 拒 decline + I4 提交侧 ship tracking presence + 唯一索引防双 pending。 */
export function createOrderActionRequest(db: Database.Database, opts: {
  orderId: string; action: string; rawParams: unknown;
  grantId: string; humanId: string; agentLabel: string | null; generateId: (p: string) => string;
}): DomainResult {
  const { orderId, action } = opts
  if (action === 'decline') return { ok: false, error_code: 'DECLINE_NOT_DELEGATED', error: 'decline 不可委托;请人工在 PWA 处理', http: 400 }   // D2
  if (action !== 'accept' && action !== 'ship') return { ok: false, error_code: 'BAD_ACTION', error: "action 必须为 'accept' | 'ship'", http: 400 }
  const order = db.prepare('SELECT seller_id FROM orders WHERE id = ?').get(orderId) as { seller_id: string } | undefined
  if (!order) return { ok: false, error_code: 'ORDER_NOT_FOUND', error: '订单不存在', http: 404 }
  if (order.seller_id !== opts.humanId) return { ok: false, error_code: 'NOT_ORDER_SELLER', error: '该订单不属于你', http: 403 }   // 归属
  const params = sanitizeOrderActionParams(action, opts.rawParams)   // I6:地址等被丢弃
  if (action === 'ship' && (!params.tracking?.trim() || !params.evidence_ref?.trim())) {
    return { ok: false, error_code: 'SHIP_TRACKING_REQUIRED', error: 'ship 请求必须带 tracking + evidence_ref', http: 400 }   // I4 提交侧(presence;内容重校在 PR3)
  }
  const paramsHash = computeParamsHash(orderId, action, params)
  const id = opts.generateId('apr')
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000).toISOString()
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO agent_permission_requests
        (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, action_params)
        VALUES (?,?,?,?, '[]', 'medium', 'once', 'pending', ?, 'order_action', ?, ?, ?, ?)`)
        .run(id, opts.humanId, opts.grantId, opts.agentLabel, expiresAt, orderId, action, paramsHash, JSON.stringify(params))
      // I7:创建审计(不含地址;capability 只带 order_id/action/hash 前缀)
      db.prepare('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)')
        .run(opts.grantId, opts.humanId, `order_action:request:${orderId}:${action}:${paramsHash.slice(0, 12)}`, 'allow', null)
    })()
  } catch (e) {
    const dup = db.prepare("SELECT 1 FROM agent_permission_requests WHERE order_id=? AND order_action=? AND kind='order_action' AND status IN ('pending','approved')").get(orderId, action)
    if (dup) return { ok: false, error_code: 'DUPLICATE_ACTION_REQUEST', error: '该订单该动作已有待批准请求', http: 409 }
    return { ok: false, error_code: 'REQUEST_FAILED', error: (e as Error).message, http: 500 }
  }
  return { ok: true, request_id: id, params_hash: paramsHash }
}

/**
 * 人 Passkey 批准后:CAS pending→approved + 审计,单事务。**停在 approved,绝不执行**(PR3 才 execute)。
 * Passkey 校验(绑三元组)由 route 层先做(requireHumanPresence 消费 gate token);本函数只做原子状态跃迁 + 审计。
 * P1-b:过期判定【原子在 CAS 里】—— WHERE 含 expires_at > nowIso(nowIso 由 route 传入),移除"预检查再 CAS"两步式;
 *   过期/已批/竞态 → 0 行 → 409(approve-after-expire 必失败,并发双 approve 只一次成功)。
 */
export function approveOrderActionRequest(db: Database.Database, requestId: string, actorId: string, grantId: string, orderId: string, action: string, nowIso: string): DomainResult {
  let claimed = 0
  try {
    claimed = db.transaction((): number => {
      const c = db.prepare("UPDATE agent_permission_requests SET status='approved', approved_at=? WHERE id=? AND status='pending' AND kind='order_action' AND expires_at > ?").run(nowIso, requestId, nowIso).changes
      if (c === 1) {
        db.prepare('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)')
          .run(grantId, actorId, `order_action:approve:${orderId}:${action}`, 'allow', null)   // I7
      }
      return c
      // 【硬边界】此处结束:无 execute、无 transition、无 settle、不写 executed_at。
    })()
  } catch (e) {
    return { ok: false, error_code: 'APPROVE_AUDIT_FAILED', error: (e as Error).message, http: 503 }   // 审计失败 → 不留无审计 approved
  }
  if (claimed !== 1) return { ok: false, error_code: 'REQUEST_NOT_PENDING_OR_EXPIRED', error: '请求非 pending 或已过期(可能已批/已过期/竞态)', http: 409 }
  return { ok: true }
}
