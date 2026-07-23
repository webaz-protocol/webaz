/**
 * USDC 合约担保 PR-B2 — 卖家收款地址注册路由(自报 EIP-55 链上地址,voucher 签发的目的地来源)。
 *
 * 3 endpoints(全部卖家本人;地址是公开链上标识,非敏感收款指令,不走披露门):
 *   GET    /api/usdc-escrow/payout-addresses          我的 active 地址列表
 *   POST   /api/usdc-escrow/payout-addresses          新增(EIP-55 归一;去重)
 *   POST   /api/usdc-escrow/payout-addresses/:id/retire  退役(不 DELETE,幂等)
 *
 * 域逻辑在 src/usdc-escrow-store.ts;本文件只做 auth/角色门/参数透传。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { addPayoutAddress, listActivePayoutAddresses, retirePayoutAddress } from '../../usdc-escrow-store.js'

export interface UsdcPayoutAddressDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  generateId: (prefix: string) => string
}

export function registerUsdcPayoutAddressRoutes(app: Application, deps: UsdcPayoutAddressDeps): void {
  const { db, auth, isTrustedRole, generateId } = deps
  const sellerGate = (req: Request, res: Response): Record<string, unknown> | null => {
    const user = auth(req, res); if (!user) return null
    if (isTrustedRole(user)) { res.status(403).json({ error: '受信角色无交易面', error_code: 'TRUSTED_ROLE_NO_TRADE' }); return null }
    // 多角色账号:persisted roles 含 seller 即可(active_role 无关)。JSON.parse 产物必须是数组 ——
    // 否则(如 roles 存成字符串 "reseller")String.includes 子串匹配会放行非卖家(Codex #519 R1 High)。
    let roles: string[]
    try { const parsed: unknown = JSON.parse((user.roles as string) || JSON.stringify([user.role])); roles = Array.isArray(parsed) ? parsed.map(String) : [String(user.role)] } catch { roles = [String(user.role)] }
    if (!roles.includes('seller')) { res.status(403).json({ error: '仅卖家可管理收款地址', error_code: 'SELLER_ONLY' }); return null }
    return user
  }

  app.get('/api/usdc-escrow/payout-addresses', (req, res) => {
    const user = sellerGate(req, res); if (!user) return
    res.json({ items: listActivePayoutAddresses(db, String(user.id)) })
  })

  app.post('/api/usdc-escrow/payout-addresses', (req, res) => {
    const user = sellerGate(req, res); if (!user) return
    const r = addPayoutAddress(db, { generateId, sellerId: String(user.id), address: req.body?.address, label: req.body?.label })
    if (!r.ok) return void res.status(400).json({ error: r.error, error_code: r.error_code })
    res.json({ success: true, item: r.row })
  })

  app.post('/api/usdc-escrow/payout-addresses/:id/retire', (req, res) => {
    const user = sellerGate(req, res); if (!user) return
    const r = retirePayoutAddress(db, String(user.id), String(req.params.id))
    if (!r.ok) return void res.status(404).json({ error: '地址不存在', error_code: r.error_code })
    res.json({ success: true })
  })
}
