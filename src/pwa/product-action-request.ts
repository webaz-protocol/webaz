/**
 * Ops Passkey-in-flow approval — product-action 请求【提交】domain(创建 pending)。删除切片。
 *
 * ⚠️ 本模块【绝不执行删除、不改商品状态、不碰钱路】,【不】import 任何执行器(product-action-exec 由后续 task 建;
 *   负向 grep 守卫,同 order-action-request.ts 的 I1 约定:submit 域不可达执行器)。
 *
 * 放在【非 route 文件】:唯一 INSERT + 归属校验在这里,route 只调本模块 → 不增加 route 层 sync db.prepare 计数
 *   (routes seam ratchet 只降不升)。
 *
 * owner-key 流:owner_id 由 api_key 解析(非 agent grant),故用独立表 product_action_requests(PR-1)。
 * 归属:只能对【自己的】商品(products.seller_id === ownerId)提删除请求。防双 pending 靠 ux_par_active 唯一索引。
 * 执行永远要人 Passkey(后续 task 的执行器 + DELETE 路由上闸);本模块只留意图 pending 行 + approve_url。
 */
import type Database from 'better-sqlite3'

export type ProductAction = 'delete'
const REQUEST_TTL_MIN = 30   // 就地批准是即时交互流:请求短 TTL,过期自动作废

export interface ProductActionResult {
  ok: boolean
  request_id?: string
  approve_url?: string
  expires_at?: string
  existing_request_id?: string
  error?: string
  error_code?: string
  http?: number
}

/** 写 pending 删除请求;不执行、不改状态。归属校验 + 唯一索引防双 pending。approve_url 是人去 Passkey 的落点。 */
export function submitProductActionRequest(db: Database.Database, opts: {
  ownerId: string; action: string; productId: string; generateId: (p: string) => string;
}): ProductActionResult {
  const { ownerId, action, productId } = opts
  if (action !== 'delete') return { ok: false, error_code: 'BAD_ACTION', error: "action 必须为 'delete'(本切片)", http: 400 }

  // Single sanitized failure boundary: EVERY db read/write below is inside this try, so no raw SQLite
  // exception (from the ownership read, the reap+insert tx, OR the dup lookup) can ever escape to the
  // route / Express default handler and leak schema/stack to the client (Codex R2).
  try {
    const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(productId) as { seller_id: string } | undefined
    if (!product) return { ok: false, error_code: 'PRODUCT_NOT_FOUND', error: '商品不存在', http: 404 }
    if (product.seller_id !== ownerId) return { ok: false, error_code: 'NOT_PRODUCT_OWNER', error: '该商品不属于你', http: 403 }

    const id = opts.generateId('par')
    const approveUrl = `/#product-action/${id}`
    const nowIso = new Date().toISOString()
    const expiresAt = new Date(Date.now() + REQUEST_TTL_MIN * 60_000).toISOString()
    try {
      // Lazily reap STALE unanswered requests before inserting: without an expiry worker yet, an expired
      // pending row would otherwise keep occupying ux_par_active and permanently block resubmission. Reap +
      // insert in ONE tx so the uniqueness guarantee holds (only a genuinely-live pending/approved blocks).
      db.transaction(() => {
        db.prepare("UPDATE product_action_requests SET status='expired' WHERE product_id=? AND action=? AND status='pending' AND expires_at <= ?").run(productId, action, nowIso)
        db.prepare("INSERT INTO product_action_requests (id, owner_id, action, product_id, status, approve_url, expires_at) VALUES (?,?,?,?, 'pending', ?, ?)").run(id, ownerId, action, productId, approveUrl, expiresAt)
      })()
    } catch (insErr) {
      // ux_par_active:同 (product_id, action) 仍有 live pending/approved 请求 → 返回既有,不重复建。
      //   dup 查询本身若抛,交给外层 sanitized 边界(不外泄)。
      const dup = db.prepare("SELECT id FROM product_action_requests WHERE product_id=? AND action=? AND status IN ('pending','approved')").get(productId, action) as { id: string } | undefined
      if (dup) return { ok: false, error_code: 'DUPLICATE_ACTION_REQUEST', error: '该商品该动作已有待批准请求', existing_request_id: dup.id, http: 409 }
      throw insErr
    }
    return { ok: true, request_id: id, approve_url: approveUrl, expires_at: expiresAt }
  } catch (e) {
    console.error('[product-action-request] failed:', (e as Error).message)   // detail stays server-side
    return { ok: false, error_code: 'REQUEST_FAILED', error: '无法创建请求,请重试', http: 500 }
  }
}
