/**
 * 平台(WebAZ)收款方式 —— admin(ROOT)管理端点。
 *
 * 卖家申请充值【平台服务费】时要看到平台的收款方式并据此付款(见后续 fee-prepay 申请流)。本文件只管【平台侧多收款账号】的
 *   增删改查(admin 配置)。写操作 = 改平台收款流向 → **ROOT + 现场真人 Passkey**(purpose 'platform_receive_account_manage',
 *   action[+account_id] 绑 purpose_data)。qr 内联 data-uri(域层 validateQrDataUri 校验 png/webp≤64KB)。全写操作留 admin 审计。
 *   不碰任何 wallet/escrow/settlement/fee 余额 —— 纯配置。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { listPlatformAccounts, getPlatformAccount, addPlatformAccount, updatePlatformAccount, deactivatePlatformAccount } from '../../platform-receive-accounts.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'

export interface PlatformReceiveAccountsDeps {
  db: Database.Database
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string; error_code?: string }
  logAdminAction?: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

const GATE_PURPOSE = 'platform_receive_account_manage'

export function registerPlatformReceiveAccountsRoutes(app: Application, deps: PlatformReceiveAccountsDeps): void {
  const { db, requireRootAdmin, generateId, consumeGateToken, logAdminAction } = deps

  /** ROOT + 现场真人 Passkey(写操作)。action(+可选 account_id)绑 purpose_data。返回 true=通过(否则已写 403)。 */
  function passkeyOk(req: Request, res: Response, adminId: string, action: string, accountId?: string): boolean {
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: adminId, webauthnToken: req.body?.webauthn_token as string | undefined,
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

  const bodyInput = (req: Request): { label?: string; method?: string; currency?: string; instruction: string; qrDataUri?: string | null } => {
    const b = req.body || {}
    const out: { label?: string; method?: string; currency?: string; instruction: string; qrDataUri?: string | null } = { instruction: b.instruction, label: b.label, method: b.method, currency: b.currency }
    if ('qr_data_uri' in b) out.qrDataUri = b.qr_data_uri   // 缺省不改;给了(含 null/'')才动 qr
    return out
  }

  // ── list(ROOT 读;含 inactive + qr_data_uri)──
  app.get('/api/admin/platform-receive-accounts', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    res.json({ accounts: listPlatformAccounts(db, { includeInactive: true }) })
  })

  // ── add(ROOT + Passkey)──
  app.post('/api/admin/platform-receive-accounts', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    if (!passkeyOk(req, res, admin.id as string, 'add')) return
    const r = addPlatformAccount(db, bodyInput(req), generateId)
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'PLATFORM_ACCOUNT_INPUT_INVALID' })
    logAdminAction?.(admin.id as string, 'platform_receive_account_add', 'platform_receive_account', r.account.id, { method: r.account.method, currency: r.account.currency, has_qr: !!r.account.qr_data_uri })
    res.json({ ok: true, account: r.account })
  })

  // ── update(ROOT + Passkey + 存在性)──
  app.put('/api/admin/platform-receive-accounts/:id', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const id = String(req.params.id)
    if (!getPlatformAccount(db, id)) return void res.status(404).json({ error: '平台收款方式不存在', error_code: 'PLATFORM_ACCOUNT_NOT_FOUND' })
    if (!passkeyOk(req, res, admin.id as string, 'update', id)) return
    const r = updatePlatformAccount(db, id, bodyInput(req))
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'PLATFORM_ACCOUNT_INPUT_INVALID' })
    logAdminAction?.(admin.id as string, 'platform_receive_account_update', 'platform_receive_account', id)
    res.json({ ok: true, changed: r.changed })
  })

  // ── deactivate(ROOT + Passkey + 存在性)──
  app.delete('/api/admin/platform-receive-accounts/:id', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const id = String(req.params.id)
    if (!getPlatformAccount(db, id)) return void res.status(404).json({ error: '平台收款方式不存在', error_code: 'PLATFORM_ACCOUNT_NOT_FOUND' })
    if (!passkeyOk(req, res, admin.id as string, 'deactivate', id)) return
    const changed = deactivatePlatformAccount(db, id)
    logAdminAction?.(admin.id as string, 'platform_receive_account_deactivate', 'platform_receive_account', id)
    res.json({ ok: true, changed })
  })
}
