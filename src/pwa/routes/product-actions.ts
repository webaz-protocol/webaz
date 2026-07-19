/**
 * Ops Passkey-in-flow approval — product-action routes(owner-key)。删除切片。
 *
 * 薄 route:仅调 domain(product-action-request 及后续 exec),自身不含 sync db.prepare → 不进 routes seam ratchet。
 * self-init OAuth-style:注册时建表(applyWebazRuntimeSchema 亦覆盖 MCP fresh DB)。幂等。
 *
 * 本 task(PR-2)只有【提交】端点(零执行权)。approve(Passkey 执行)/ get / revoke-window 由后续 task 加到本文件。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { initProductActionApprovalSchema } from '../../runtime/webaz-schema-helpers.js'
import { submitProductActionRequest } from '../product-action-request.js'

export interface ProductActionDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerProductActionRoutes(app: Application, deps: ProductActionDeps): void {
  const { db, auth, generateId } = deps
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
}
