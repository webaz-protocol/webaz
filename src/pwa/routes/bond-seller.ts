/**
 * 商家履约保证金(base bond)—— 卖家侧端点(B1 缴纳闭环)。
 *
 *   GET  /api/direct-receive/bond-status            状态卡:要求额度 / 最新存款 / 缓交 / 缴纳通道放行状态 / 平台收款方式
 *   POST /api/direct-receive/bond-deposit           申报缴纳(operator_attested 轨;凭据必填;不动钱,只建 pending 行)
 *   POST /api/direct-receive/bond-deposit/:id/cancel 撤回自己的 pending 申报
 *
 * 硬边界:
 *  - 申报【不动钱、不 Passkey】(与 fee-prepay 申请同范式);真实生效 = admin ROOT+Passkey 走
 *    confirmProductionReceipt(双锁:Lock A 轨道已实现 + Lock B 法务放行 registry —— 当前 Lock B 全关,
 *    生产上无法确认;放行是治理/法务翻转,不在代码)。
 *  - rail_cleared=false 时 GET 明示"缴纳通道待平台放行",前端据此隐藏申报表单(fail-closed UI);
 *    POST 也硬拒(不收无法核实生效的申报,防申报单积压误导商家)。
 *  - 保证金=商家履约担保物(security deposit),非买家货款/escrow/订单资金;本文件零资金移动。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { openDeposit, getSellerLatestDeposit, expireDeposit, requiredBondUnits } from '../../direct-receive-deposits.js'
import { bondRailClearanceBlockers } from '../../direct-pay-bond-rail-clearance.js'
import { getActiveDeferral } from '../../direct-receive-deferral.js'
import { listActivePlatformAccounts } from '../../platform-receive-accounts.js'
import { toDecimal } from '../../money.js'
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export interface BondSellerDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

/** operator_attested 生产轨是否已被法务/治理放行(Lock B;当前恒 false,放行=registry 置真)。 */
function bondRailCleared(): boolean {
  const blockers = bondRailClearanceBlockers('operator_attested')
  return blockers.filter(b => b !== 'NO_PRODUCTION_RECEIPT').length === 0
}

export function registerBondSellerRoutes(app: Application, deps: BondSellerDeps): void {
  const { db, auth, generateId, errorRes } = deps

  function requireSeller(req: Request, res: Response): Record<string, unknown> | null {
    const user = auth(req, res); if (!user) return null
    if (user.role !== 'seller') { errorRes(res, 403, 'SELLER_ONLY', '仅卖家有履约保证金'); return null }
    return user
  }

  app.get('/api/direct-receive/bond-status', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const sellerId = user.id as string
    // lazy expiry:pending 超 TTL 顺手过期(无 cron 依赖)
    const latest0 = getSellerLatestDeposit(db, sellerId)
    if (latest0 && latest0.status === 'pending') expireDeposit(db, { depositId: latest0.id, nowIso: new Date().toISOString() })
    const latest = getSellerLatestDeposit(db, sellerId)
    const deferral = getActiveDeferral(db, sellerId, new Date().toISOString())
    const cleared = bondRailCleared()
    return void res.json({
      required: { tier: 'T0', units: requiredBondUnits('T0'), display: toDecimal(requiredBondUnits('T0')), currency: 'USDC', note: '固定 token 数(档位参考 ≈ S$500,非汇率换算);治理可调' },
      deposit: latest ? {
        id: latest.id, status: latest.status, amount: latest.amount, required_amount: latest.required_amount,
        rail: latest.deposit_rail, evidence_ref: latest.external_ref, reject_note: latest.reject_note,
        production_confirmed: latest.production_receipt_confirmed_at != null,
        created_at: latest.created_at, locked_at: latest.locked_at,
      } : null,
      deferral: deferral ? { id: deferral.id, expires_at: deferral.expiresAt, grace_until: deferral.graceUntil, in_grace: deferral.inGrace, reduced_quota_factor: deferral.reducedQuotaFactor } : null,
      rail_cleared: cleared,
      rail_blockers: cleared ? [] : bondRailClearanceBlockers('operator_attested').filter(b => b !== 'NO_PRODUCTION_RECEIPT'),
      payment_accounts: cleared ? listActivePlatformAccounts(db) : [],   // 放行前不展示收款方式(不引导无法生效的转账)
      note: cleared
        ? '按平台收款方式转账后提交申报(凭据必填);运营核实到账并确认后保证金正式锁定、直付入场门即满足。'
        : '保证金缴纳通道待平台放行(合规审查中)。当前可通过【缓交申请】先行入场(额度受限);放行后再补缴转正式。',
    })
  })

  app.post('/api/direct-receive/bond-deposit', async (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const sellerId = user.id as string
    // fail-closed:Lock B 未放行 → 不收申报(收了也无法核实生效,只会积压误导)
    if (!bondRailCleared()) return void errorRes(res, 409, 'BOND_RAIL_NOT_CLEARED', '保证金缴纳通道待平台放行(合规审查中);当前请使用缓交申请入场')
    const evidence = String(req.body?.evidence_ref ?? '').trim()
    if (!evidence || evidence.length > 120) return void errorRes(res, 400, 'EVIDENCE_REQUIRED', '付款凭据号必填(≤120 字;转账单号/链上 tx 等,运营据此核对到账)')
    const latest0 = getSellerLatestDeposit(db, sellerId)
    if (latest0 && latest0.status === 'pending') expireDeposit(db, { depositId: latest0.id, nowIso: new Date().toISOString() })   // lazy expiry
    const latest = getSellerLatestDeposit(db, sellerId)
    if (latest && ['pending', 'confirmed', 'insufficient'].includes(latest.status)) return void errorRes(res, 409, 'DEPOSIT_IN_FLIGHT', `已有在途申报(${latest.status}),请等待运营核实或先撤回`)
    if (latest && latest.status === 'locked') return void errorRes(res, 409, 'BOND_ALREADY_LOCKED', '保证金已锁定生效,无需重复缴纳')
    const depositId = generateId('bond')
    const r = openDeposit(db, { depositId, userId: sellerId, tier: 'T0', currency: 'usdc', depositRail: 'operator_attested', externalRef: evidence })
    if (!r.ok) return void errorRes(res, 400, 'BOND_OPEN_FAILED', r.reason)
    // N3 同款:通知 root admin 有待核实申报(best-effort)
    try {
      const roots = await dbAll<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND (admin_type = 'root' OR admin_type IS NULL)")
      for (const a of roots) {
        createNotification(db, a.id, null, 'bond_deposit_submitted', '🏦 新保证金缴纳申报待核实',
          `卖家 ${String(user.name ?? sellerId)} 申报已缴纳履约保证金(T0,凭据 ${evidence.slice(0, 40)})。请核对真实到账后在 admin 后台确认(ROOT+Passkey)。`,
          { templateKey: 'bond_deposit_submitted', params: { seller: String(user.name ?? sellerId), evidence: evidence.slice(0, 40) } })
      }
    } catch (e) { console.warn('[bond-deposit notify]', (e as Error).message) }
    return void res.json({ success: true, deposit_id: depositId, status: 'pending', note: '申报已提交;运营核实真实到账并确认后生效。申报本身不授予任何入场资格。' })
  })

  app.post('/api/direct-receive/bond-deposit/:id/cancel', async (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const latest = getSellerLatestDeposit(db, user.id as string)
    if (!latest || latest.id !== req.params.id) return void errorRes(res, 404, 'DEPOSIT_NOT_FOUND', '申报不存在')
    if (latest.status !== 'pending') return void errorRes(res, 409, 'NOT_PENDING', `当前状态 ${latest.status},不可撤回`)
    await dbRun("UPDATE direct_receive_deposits SET status = 'expired', reject_note = '卖家自行撤回', updated_at = datetime('now') WHERE id = ? AND status = 'pending'", [latest.id])
    return void res.json({ success: true })
  })
}
