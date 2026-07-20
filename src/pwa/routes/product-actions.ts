/**
 * Ops Passkey-in-flow approval — product-action routes(owner-key)。删除切片。
 *
 * 薄 route:仅调 domain(product-action-request / approval-window / product-action-exec),自身几乎不含 sync
 *   db.prepare → 不进 routes seam ratchet(唯一直查 db.prepare 用于 approve 端点读取请求归属/状态,已登记)。
 * self-init OAuth-style:注册时建表(applyWebazRuntimeSchema 亦覆盖 MCP fresh DB)。幂等。
 *
 * 端点:
 *   POST /api/product-actions/request       提交 pending 删除请求(owner-key,零执行权;Task 2)
 *   POST /api/product-actions/:id/approve    ★现场真人 Passkey 批准 → 标 approved(+可选开 T1 窗)→ 服务端执行删除(Task 5)
 *
 * approve 是【人工铁律】节点:必须消费一次性 purpose-bound WebAuthn gate token(purpose='product_action_approve',
 *   purpose_data 绑 request_id + open_window 决定,杜绝跨请求/跨决定复用),裸 api_key 永远过不了。执行走 Task 4 的
 *   executeProductActionRequest(批准路径),删除前置与 DELETE /api/products/:id 完全一致。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { initProductActionApprovalSchema } from '../../runtime/webaz-schema-helpers.js'
import { submitProductActionRequest } from '../product-action-request.js'
import { approveProductActionRequest } from '../product-action-approve.js'

export interface ProductActionDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  /** 一次性真人 WebAuthn gate token 消费器(server.ts createHumanPresence 注入)。 */
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  /** anchor GC(与 DELETE 路由同一实现;执行器删除时 retire 指向该商品的 active anchor)。kind:'product' + unknown 返回,
   *  以兼容生产签名 (…, AnchorTargetKind, string) => number,不把 anchor 泛型泄漏进本模块。 */
  retireAnchorsByTarget: (db: Database.Database, kind: 'product', id: string) => unknown
}

export function registerProductActionRoutes(app: Application, deps: ProductActionDeps): void {
  const { db, auth, generateId, consumeGateToken, retireAnchorsByTarget } = deps
  initProductActionApprovalSchema(db)   // PWA runtime self-init(MCP 经 applyWebazRuntimeSchema);幂等

  // 提交:owner-key 建 pending 删除请求 → 返回 approve_url(人去 Passkey)。绝不执行删除。
  app.post('/api/product-actions/request', (req, res) => {
    const user = auth(req, res); if (!user) return
    const b = (req.body || {}) as Record<string, unknown>
    const action = typeof b.action === 'string' ? b.action : ''
    const productId = typeof b.product_id === 'string' ? b.product_id : ''
    if (!productId) return void res.status(400).json({ error: 'product_id is required', error_code: 'PRODUCT_ID_REQUIRED' })
    const r = submitProductActionRequest(db, { ownerId: String(user.id), action, productId, generateId })
    if (!r.ok) {
      return void res.status(r.http || 400).json({
        error: r.error, error_code: r.error_code,
        ...(r.existing_request_id ? { existing_request_id: r.existing_request_id, approve_url: `/#product-action/${r.existing_request_id}` } : {}),
      })
    }
    res.json({
      success: true, request_id: r.request_id, approve_url: r.approve_url, expires_at: r.expires_at,
      note: '待人工 Passkey 批准;删除仅在批准后由服务端执行(裸 api_key 无法直删)。',
    })
  })

  // ★批准执行:现场真人 Passkey。薄 route,编排全在 product-action-approve domain(seam ratchet 只降不升)。
  //   open_window(默认 false):true 时额外开一个 30min ≤20 次 T1 窗,同档位后续删除免逐条 Passkey;窗口决定绑进
  //   gate token 的 purpose_data,故"不开窗的 token"无法被复用去开窗。裸 api_key 永远过不了(consumeGateToken)。
  app.post('/api/product-actions/:id/approve', (req, res) => {
    const user = auth(req, res); if (!user) return
    const body = (req.body || {}) as Record<string, unknown>
    const r = approveProductActionRequest(db, {
      requestId: req.params.id, ownerId: String(user.id),
      webauthnToken: body.webauthn_token as string | undefined,
      openWindow: body.open_window === true,
      generateId, consumeGateToken, retireAnchorsByTarget,
    })
    if (!r.ok) {
      return void res.status(r.http || 400).json({
        error: r.error, error_code: r.error_code,
        ...(r.approved ? { approved: true, window_opened: r.window_opened, window_expires_at: r.window_expires_at } : {}),
      })
    }
    res.json({
      success: true, request_id: r.request_id, deleted_product_id: r.deleted_product_id,
      window_opened: r.window_opened, window_expires_at: r.window_expires_at,
      note: '删除已由服务端在真人 Passkey 批准后执行。',
    })
  })
}
