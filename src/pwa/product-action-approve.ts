/**
 * Ops Passkey-in-flow approval — product-action【批准+执行】orchestration domain(Task 5)。删除切片。
 *
 * 现场真人 Passkey 批准的编排:归属/状态/过期检查 → 消费一次性 purpose-bound WebAuthn gate token(裸 api_key
 *   永不放行)→ CAS 标 approved →(可选)开 T1 窗 → 调 Task 4 执行器删除。所有 sync db.prepare 集中在本 domain
 *   模块,route 只做 HTTP 映射(routes seam ratchet 只降不升)。
 *
 * gate token 的 purpose_data 绑 { request_id, open_window }:为删 A 拿的 token 不能用去批 B,不开窗的 token 也
 *   不能被复用去开窗(validate 精确匹配 + 一次性消费)。
 */
import type Database from 'better-sqlite3'
import { mintWindow } from './approval-window.js'
import { executeProductActionRequest } from './product-action-exec.js'

export interface ApproveResult {
  ok: boolean
  request_id?: string
  deleted_product_id?: string
  approved?: boolean
  window_opened?: boolean
  window_expires_at?: string
  error?: string
  error_code?: string
  http?: number
}

export interface ApproveDeps {
  requestId: string
  ownerId: string
  webauthnToken: string | undefined
  openWindow: boolean
  generateId: (prefix: string) => string
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  retireAnchorsByTarget: (db: Database.Database, kind: 'product', id: string) => unknown
}

/** 批准并执行一条 pending 删除请求。真人 Passkey 是硬门;删除走 Task 4 执行器(前置与 DELETE 路由一致)。 */
export function approveProductActionRequest(db: Database.Database, opts: ApproveDeps): ApproveResult {
  const { requestId, ownerId, webauthnToken, openWindow, generateId, consumeGateToken, retireAnchorsByTarget } = opts
  try {
    const reqRow = db.prepare('SELECT id, owner_id, status, expires_at FROM product_action_requests WHERE id = ?')
      .get(requestId) as { id: string; owner_id: string; status: string; expires_at: string } | undefined
    if (!reqRow) return { ok: false, error_code: 'REQUEST_NOT_FOUND', error: '请求不存在', http: 404 }
    if (reqRow.owner_id !== ownerId) return { ok: false, error_code: 'NOT_REQUEST_OWNER', error: '只能批准自己发起的请求', http: 403 }
    if (reqRow.expires_at <= new Date().toISOString()) {
      db.prepare("UPDATE product_action_requests SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(requestId)
      return { ok: false, error_code: 'REQUEST_EXPIRED', error: '该请求已过期,请重新发起', http: 410 }
    }
    if (reqRow.status !== 'pending') return { ok: false, error_code: 'NOT_PENDING', error: `请求状态为 ${reqRow.status},无法批准`, http: 409 }

    // 人工铁律:一次性 purpose-bound WebAuthn gate token。绑 request_id + open_window(杜绝跨请求/跨决定复用)。
    const gate = consumeGateToken(ownerId, webauthnToken, 'product_action_approve',
      (data) => { const d = data as { request_id?: string; open_window?: boolean } | null; return !!d && d.request_id === requestId && (d.open_window === true) === openWindow })
    if (!gate.ok) return { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', error: gate.reason || '此操作需真实人工 WebAuthn 验证', http: 403 }

    // CAS 标 approved(防并发/重放:只有仍 pending 才认领成功)。
    const claim = db.prepare("UPDATE product_action_requests SET status='approved', approved_at=? WHERE id=? AND status='pending'")
      .run(new Date().toISOString(), requestId)
    if (claim.changes !== 1) return { ok: false, error_code: 'NOT_PENDING', error: '请求状态已变化,请重试', http: 409 }

    // 可选开 T1 窗(后续同档位删除免逐条 Passkey)。开窗失败不阻断本次删除——窗口是增益,本次授权靠 approved 路径。
    let windowOpened = false, windowExpiresAt: string | undefined
    if (openWindow) {
      const w = mintWindow(db, { ownerId, tier: 'T1', generateId })
      windowOpened = w.ok; windowExpiresAt = w.expires_at
    }

    // 执行(批准路径:executor 见 approved → 走 approval 授权,不消费窗口)。
    const exec = executeProductActionRequest(db, { requestId, retireAnchorsByTarget })
    if (!exec.ok) {
      // 未删成(如商品未入回收箱/有进行中订单):把 approved 退回 pending。★安全:绝不把 'approved' 作为【持久
      //   bearer 授权】留库——执行器的 approved 路径无需新 gate,若留 approved,未来任何 owner-key 调用都能凭这次
      //   旧 ceremony 直删(无新真人在场)。退回 pending 后,重试必须【重新 Passkey】(或消费一次窗口),ceremony 一次性。
      db.prepare("UPDATE product_action_requests SET status='pending', approved_at=NULL WHERE id=? AND status='approved'").run(requestId)
      return { ok: false, error_code: exec.error_code, error: exec.error, http: exec.http || 500, approved: false, window_opened: windowOpened, window_expires_at: windowExpiresAt }
    }
    return { ok: true, request_id: requestId, deleted_product_id: exec.product_id, approved: true, window_opened: windowOpened, window_expires_at: windowExpiresAt }
  } catch (e) {
    console.error('[product-action-approve] failed:', (e as Error).message)   // detail 留服务端
    return { ok: false, error_code: 'APPROVE_FAILED', error: '批准执行失败,请重试', http: 500 }
  }
}
