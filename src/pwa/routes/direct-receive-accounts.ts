/**
 * Direct Pay (Rail 1) — 卖家多收款账号 owner-gated 端点 (Phase C1)。
 *
 * ADDITIVE only:不改现有 direct_receive_payment_instructions,不动 create route,不 bump contract。买家侧零暴露。
 * 写操作(add/update/deactivate/qr upload)都要 seller 现场真人 Passkey(purpose 'direct_receive_account_manage',
 *   action/account 绑 purpose_data,杜绝跨动作/跨账号复用 token)。审计 append-only、只记 ref、绝不写 raw 内容。
 * QR:仅 png|webp、magic-byte 校验、解码 ≤64KB;经硬化端点 owner-only 转发(forced content-type + nosniff +
 *   Cache-Control private,no-store);不存在/非本人统一 404(不枚举)。WebAZ 绝不解析二维码 / 验证收款方 / 路由资金。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { listSellerAccounts, getAccount, addAccount, updateAccount, deactivateAccount, listSellerAccountOptions } from '../../direct-receive-accounts.js'
import { storeQrImage, getQrImageForOwner, appendAccountEvent } from '../../direct-receive-account-qr.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'

export interface DirectReceiveAccountsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

const GATE_PURPOSE = 'direct_receive_account_manage'

export function registerDirectReceiveAccountsRoutes(app: Application, deps: DirectReceiveAccountsDeps): void {
  const { db, auth, generateId, consumeGateToken } = deps

  /** 登录 + seller 角色。返回 user 或 null(已写响应)。 */
  function requireSeller(req: Request, res: Response): Record<string, unknown> | null {
    const user = auth(req, res); if (!user) return null
    if (user.role !== 'seller') { res.status(403).json({ error: '仅卖家可管理直付收款账号', error_code: 'SELLER_ONLY' }); return null }
    return user
  }

  /** 现场真人 Passkey 门(写操作)。action(+可选 account_id)绑 purpose_data。返回 true=通过(否则已写 403)。 */
  function passkeyOk(req: Request, res: Response, userId: string, action: string, accountId?: string): boolean {
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId, webauthnToken: req.body?.webauthn_token as string | undefined,
      purpose: GATE_PURPOSE,
      validate: (data) => {
        const d = data as { action?: string; account_id?: string } | null
        if (!d || d.action !== action) return false
        return accountId ? d.account_id === accountId : true
      },
    })
    if (!gate.ok) { res.status(403).json({ error: gate.reason, error_code: gate.error_code }); return false }
    return true
  }

  /** owner-scoped 取账号;不存在/非本人 → null + 404(不枚举)。 */
  function ownedAccount(res: Response, id: string, sellerId: string): { id: string; seller_id: string } | null {
    const acc = getAccount(db, id)
    if (!acc || acc.seller_id !== sellerId) { res.status(404).json({ error: '账号不存在', error_code: 'ACCOUNT_NOT_FOUND' }); return null }
    return acc
  }

  // ── list（本人;不返回 raw QR,只含 qr_image_ref)──
  app.get('/api/direct-receive/accounts', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    res.json({ accounts: listSellerAccounts(db, user.id as string, { includeInactive: true }) })
  })

  // ── buyer-facing:某商品卖家的【可选收款账号】(结算前选"怎么付")。任意登录用户可读;字面路径,不与 /accounts/:id 冲突。
  //   ⚠️ 只下发元数据 method/currency/label —— instruction 原文与 QR 受披露门保护,D1/D2 ack 后才随订单快照给买家。
  app.get('/api/direct-receive/selectable-accounts', (req, res) => {
    const user = auth(req, res); if (!user) return
    const productId = String(req.query.product_id || '')
    if (!productId) return void res.status(400).json({ error: '缺少 product_id', error_code: 'PRODUCT_ID_REQUIRED' })
    const product = db.prepare('SELECT seller_id, status FROM products WHERE id = ?').get(productId) as { seller_id: string; status: string } | undefined
    if (!product || product.status === 'deleted') return void res.status(404).json({ error: '商品不存在', error_code: 'PRODUCT_NOT_FOUND' })
    res.json({ options: listSellerAccountOptions(db, product.seller_id) })
  })

  // ── add(Passkey)──
  app.post('/api/direct-receive/accounts', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    if (!passkeyOk(req, res, user.id as string, 'add')) return
    const b = req.body || {}
    const out = db.transaction(() => {
      const r = addAccount(db, user.id as string, { method: b.method, currency: b.currency, instruction: b.instruction, label: b.label }, generateId)
      if (r.ok) appendAccountEvent(db, { accountId: r.account.id, sellerId: user.id as string, eventType: 'account_added' }, generateId)
      return r
    })()
    if (!out.ok) return void res.status(400).json({ error: out.reason, error_code: 'ACCOUNT_INPUT_INVALID' })
    res.json({ ok: true, account: out.account })
  })

  // ── update(Passkey + owner)──
  app.put('/api/direct-receive/accounts/:id', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const id = String(req.params.id)
    if (!ownedAccount(res, id, user.id as string)) return
    if (!passkeyOk(req, res, user.id as string, 'update', id)) return
    const b = req.body || {}
    const out = db.transaction(() => {
      const r = updateAccount(db, id, user.id as string, { method: b.method, currency: b.currency, instruction: b.instruction, label: b.label })
      if (r.ok && r.changed) appendAccountEvent(db, { accountId: id, sellerId: user.id as string, eventType: 'account_updated' }, generateId)
      return r
    })()
    if (!out.ok) return void res.status(400).json({ error: out.reason, error_code: 'ACCOUNT_INPUT_INVALID' })
    res.json({ ok: true, changed: out.changed })
  })

  // ── deactivate(Passkey + owner)──
  app.delete('/api/direct-receive/accounts/:id', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const id = String(req.params.id)
    if (!ownedAccount(res, id, user.id as string)) return
    if (!passkeyOk(req, res, user.id as string, 'deactivate', id)) return
    let changed = false
    db.transaction(() => {
      changed = deactivateAccount(db, id, user.id as string)
      if (changed) appendAccountEvent(db, { accountId: id, sellerId: user.id as string, eventType: 'account_deactivated' }, generateId)
    })()
    res.json({ ok: true, changed })
  })

  // ── upload / replace QR(Passkey + owner;immutable content-addressed store)──
  app.put('/api/direct-receive/accounts/:id/qr', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const id = String(req.params.id)
    if (!ownedAccount(res, id, user.id as string)) return
    if (!passkeyOk(req, res, user.id as string, 'qr', id)) return
    const r = storeQrImage(db, { accountId: id, sellerId: user.id as string, dataUri: req.body?.qr_data_uri }, generateId)
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'QR_INVALID' })
    res.json({ ok: true, qr_image_ref: r.ref })
  })

  // ── QR preview(owner-only read;硬化转发;不存在/非本人 → 404)──
  app.get('/api/direct-receive/accounts/:id/qr', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const acc = getAccount(db, String(req.params.id))
    if (!acc || acc.seller_id !== user.id || !acc.qr_image_ref) return void res.status(404).end()
    const img = getQrImageForOwner(db, acc.qr_image_ref, user.id as string)
    if (!img) return void res.status(404).end()
    res.setHeader('Content-Type', img.mime)                        // server-set from whitelist, never echoed from client
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')            // private seller data — not the public cache thumbnails use
    res.send(img.buf)
  })
}
