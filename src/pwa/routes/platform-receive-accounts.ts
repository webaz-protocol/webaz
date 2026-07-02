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
import { createHash } from 'node:crypto'
import { listPlatformAccounts, getPlatformAccount, addPlatformAccount, updatePlatformAccount, deactivatePlatformAccount } from '../../platform-receive-accounts.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')
/** 稳定序列化(键排序)—— purpose_data 与请求体重算 payload 逐字比对,不受键序影响。 */
function stable(o: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(o).sort().reduce<Record<string, unknown>>((a, k) => { a[k] = o[k]; return a }, {}))
}

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

  /** 从请求体重算【本次写入内容】的 canonical gate payload —— Passkey token 必须绑定它,证明 admin 确认的就是这份收款内容。
   *  绑定字段:action, account_id?, instruction/method/currency/label(原文,与 body 逐字一致), qr_mode(keep|clear|set)+qr_sha256(set 时;绑 QR 内容而非塞 64KB 原文)。 */
  function gateContentPayload(req: Request, action: string, accountId?: string): Record<string, unknown> {
    const b = req.body || {}
    const p: Record<string, unknown> = { action }
    if (accountId) p.account_id = accountId
    if (action === 'add' || action === 'update') {
      p.instruction = String(b.instruction ?? '')
      p.method = String(b.method ?? '')
      p.currency = String(b.currency ?? '')
      p.label = String(b.label ?? '')
      if (!('qr_data_uri' in b)) p.qr_mode = 'keep'
      else if (b.qr_data_uri == null || String(b.qr_data_uri).trim() === '') p.qr_mode = 'clear'
      else { p.qr_mode = 'set'; p.qr_sha256 = sha256hex(String(b.qr_data_uri)) }
    }
    return p
  }

  /** ROOT + 现场真人 Passkey(写操作)。token 的 purpose_data 必须与本次请求体重算的 canonical payload 逐字相等
   *  —— 否则(如用批 A 的 token 写 B 的收款地址,或 body 被篡改)拒。返回 true=通过(否则已写 403)。 */
  function passkeyOk(req: Request, res: Response, adminId: string, action: string, accountId?: string): boolean {
    const expected = stable(gateContentPayload(req, action, accountId))
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: adminId, webauthnToken: req.body?.webauthn_token as string | undefined,
      purpose: GATE_PURPOSE,
      validate: (data) => !!data && typeof data === 'object' && stable(data as Record<string, unknown>) === expected,
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

  /** 审计摘要(canonical,不含 raw QR):便于事后还原"当时展示给卖家的收款内容"。instruction/qr 用 sha256。 */
  const summarize = (a: { instruction?: string | null; method?: string | null; currency?: string | null; label?: string | null; qr_data_uri?: string | null } | null): Record<string, unknown> | null =>
    a == null ? null : { method: a.method ?? null, currency: a.currency ?? null, label: a.label ?? null, instruction_sha256: a.instruction ? sha256hex(a.instruction) : null, qr_sha256: a.qr_data_uri ? sha256hex(a.qr_data_uri) : null, had_qr: !!a.qr_data_uri }

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
    logAdminAction?.(admin.id as string, 'platform_receive_account_add', 'platform_receive_account', r.account.id, { new: summarize(r.account) })
    res.json({ ok: true, account: r.account })
  })

  // ── update(ROOT + Passkey + 存在性)──
  app.put('/api/admin/platform-receive-accounts/:id', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const id = String(req.params.id)
    const before = getPlatformAccount(db, id)
    if (!before) return void res.status(404).json({ error: '平台收款方式不存在', error_code: 'PLATFORM_ACCOUNT_NOT_FOUND' })
    if (!passkeyOk(req, res, admin.id as string, 'update', id)) return
    const r = updatePlatformAccount(db, id, bodyInput(req))
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'PLATFORM_ACCOUNT_INPUT_INVALID' })
    logAdminAction?.(admin.id as string, 'platform_receive_account_update', 'platform_receive_account', id, { old: summarize(before), new: summarize(getPlatformAccount(db, id)) })
    res.json({ ok: true, changed: r.changed })
  })

  // ── deactivate(ROOT + Passkey + 存在性)──
  app.delete('/api/admin/platform-receive-accounts/:id', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const id = String(req.params.id)
    const before = getPlatformAccount(db, id)
    if (!before) return void res.status(404).json({ error: '平台收款方式不存在', error_code: 'PLATFORM_ACCOUNT_NOT_FOUND' })
    if (!passkeyOk(req, res, admin.id as string, 'deactivate', id)) return
    const changed = deactivatePlatformAccount(db, id)
    logAdminAction?.(admin.id as string, 'platform_receive_account_deactivate', 'platform_receive_account', id, { old: summarize(before) })
    res.json({ ok: true, changed })
  })
}
