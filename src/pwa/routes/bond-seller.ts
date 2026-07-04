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
import { openDeposit, getSellerLatestDeposit, expireDeposit, requiredBondUnits, cancelPendingDeposit, requestBondRefund, cancelBondRefundRequest } from '../../direct-receive-deposits.js'
import { enumerateBondRefundBlockers } from '../../bond-refund-blockers.js'   // B2:§5 unlock blockers(fail-closed)
import { listBondSlashProposals } from '../../bond-slash.js'   // B3:待复核罚没提案(卖家须被告知)
import { bondRailClearanceBlockers } from '../../direct-pay-bond-rail-clearance.js'
import { getActiveDeferral } from '../../direct-receive-deferral.js'
import { listActivePlatformAccounts } from '../../platform-receive-accounts.js'
import { toDecimal } from '../../money.js'
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface BondSellerDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}

/** operator_attested 生产轨是否已被法务/治理放行(Lock B;当前恒 false,放行=registry 置真)。 */
function bondRailCleared(): boolean {
  const blockers = bondRailClearanceBlockers('operator_attested')
  return blockers.filter(b => b !== 'NO_PRODUCTION_RECEIPT').length === 0
}

export function registerBondSellerRoutes(app: Application, deps: BondSellerDeps): void {
  const { db, auth, generateId, errorRes, getProtocolParam } = deps
  const coolingDays = (): number => Math.max(0, Number(getProtocolParam<number>('direct_pay.bond_refund_cooling_days', 14)) || 14)

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
        production_confirmed: latest.production_receipt_confirmed_at != null, refund_evidence_ref: latest.refund_evidence_ref,
        created_at: latest.created_at, locked_at: latest.locked_at,
      } : null,
      deferral: deferral ? { id: deferral.id, expires_at: deferral.expiresAt, grace_until: deferral.graceUntil, in_grace: deferral.inGrace, reduced_quota_factor: deferral.reducedQuotaFactor } : null,
      // B2:退出退还视图 —— locked 时预览 blockers(能不能申请);refunding 时给冷静期/可执行时间
      refund: latest && latest.status === 'locked' ? { can_request: enumerateBondRefundBlockers(db, sellerId).length === 0, blockers: enumerateBondRefundBlockers(db, sellerId), cooling_days: coolingDays() }
        : latest && latest.status === 'refunding' ? { requested_at: latest.refund_requested_at, cooling_days: coolingDays() } : null,
      // B3:待复核罚没提案(冷静期=卖家申诉窗,必须让卖家看见)
      pending_slash: (() => { try { const p = listBondSlashProposals(db, { sellerId, status: 'proposed' })[0]; return p ? { id: p.id, dispute_id: p.dispute_id, cooling_until: p.cooling_until, reason: p.reason } : null } catch { return null } })(),
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

  // ── B2:退出退还 —— 申请(§5 blockers fail-closed)→ 冷静期 → admin 执行;申请期间直付资格暂停,可撤销 ──
  app.post('/api/direct-receive/bond-refund-request', async (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const sellerId = user.id as string
    const latest = getSellerLatestDeposit(db, sellerId)
    if (!latest || latest.status !== 'locked') return void errorRes(res, 409, 'NO_LOCKED_BOND', '没有已锁定的保证金可退')
    const blockers = enumerateBondRefundBlockers(db, sellerId)
    if (blockers.length > 0) return void res.status(409).json({ error: '有未了结的直付责任,暂不能申请退还', error_code: 'REFUND_BLOCKED', blockers })
    const r = requestBondRefund(db, { depositId: latest.id, userId: sellerId })
    if (!r.ok) return void errorRes(res, 409, 'REFUND_REQUEST_FAILED', r.reason)
    try {
      const roots = await dbAll<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND (admin_type = 'root' OR admin_type IS NULL)")
      for (const a of roots) createNotification(db, a.id, null, 'bond_refund_requested', '↩️ 保证金退出申请待处理', `卖家 ${String(user.name ?? sellerId)} 申请退还履约保证金(冷静期 ${coolingDays()} 天,期间其直付资格已暂停)。冷静期满且复核无未了结责任后,场外退还并在 admin 后台记录执行。`, { templateKey: 'bond_refund_requested', params: { seller: String(user.name ?? sellerId), days: coolingDays() } })
    } catch (e) { console.warn('[bond-refund notify]', (e as Error).message) }
    return void res.json({ success: true, status: 'refunding', cooling_days: coolingDays(), note: '申请已提交:冷静期内你的直付资格暂停(不可接新直付单);冷静期满、复核无未了结责任后,平台在协议外退还并记录。可随时撤销申请恢复资格。' })
  })

  app.post('/api/direct-receive/bond-refund-request/cancel', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const latest = getSellerLatestDeposit(db, user.id as string)
    if (!latest) return void errorRes(res, 404, 'DEPOSIT_NOT_FOUND', '无保证金记录')
    const r = cancelBondRefundRequest(db, { depositId: latest.id, userId: user.id as string })
    if (!r.ok) return void errorRes(res, 409, 'REFUND_CANCEL_FAILED', r.reason)
    return void res.json({ success: true, status: 'locked', note: '退出申请已撤销,直付资格已恢复。' })
  })

  app.post('/api/direct-receive/bond-deposit/:id/cancel', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    // 单一 writer 边界:deposits 写只经域模块(guard:direct-pay-deposit 机器强制,route 零裸写)
    const r = cancelPendingDeposit(db, { depositId: req.params.id, userId: user.id as string })
    if (!r.ok) return void errorRes(res, r.reason === 'deposit not found' ? 404 : 409, 'BOND_CANCEL_FAILED', r.reason)
    return void res.json({ success: true })
  })
}
