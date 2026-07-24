/**
 * USDC 链上合约担保(B 线)PR-B7a — admin 人工裁决路由(链上 arbiterResolve / arbiter-side flagDispute)。
 *
 * ★ 本轨最敏感面:arbiterResolve 能把托管 USDC 移出合约(平台唯一动真钱入口)。故门【逐行仿 arbitrator.ts
 *   的 admin approve】—— protocol admin auth + 现场真人 Passkey(purpose 绑动作 + purpose_data.order_id 绑本单,
 *   杜绝跨动作/跨目标复用)+ admin_audit_log(成功与失败都留痕)。绝不用 admin-wallet-ops.ts 提现批准那种
 *   adminAuth-only(那对"移动真钱"不够)。
 *
 * 边界(刻意):
 *   - DB 侧订单状态【不在本路由改】—— 链上 Resolved/Disputed 事件由 watcher 驱动 DB 收敛(usdc-escrow-settle.ts),
 *     避免"DB 抢跑链上"。本路由只发链上 tx + 记审计。响应诚实:tx 已提交,DB 状态待链上确认(约 1–2 分钟)。
 *   - 自动/超时协议内裁决三处(dispute-engine / decline-contest / mutual-cancel)对本轨仍 fail-closed —— 本 PR
 *     只【新增】这条 admin 人工 Passkey 路径,绝不打开那三处(零资金 DB 裁决绝不触发 arbiter key 动真钱)。
 *   - ★ resolve 路由硬门 order.status==='disputed'(见 handler 内 P1 收口门):唯有 DB 已 disputed 才放行链上
 *     arbiterResolve,保证每个被认可的 Resolved 都落 applyUsdcEscrowResolved 的 disputed 收敛分支。不合作/丢钱包
 *     买家的端到端 DB 收敛需"系统/arbiter 代开 DB 争议",牵动状态机(?→disputed 现全要角色+证据)—— 明确归 B7b。
 *   - 读走 RFC-016 异步 seam(dbOne);本文件零同步 prepare 站点(routes:seam-check 守)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'

interface OnChainResult { ok: boolean; txHash?: string; error?: string }

export interface UsdcEscrowArbiterRouteDeps {
  db: Database.Database
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  /** 已由 server.ts 绑好 arbiter walletClient / publicClient / contractAddress 的注入闭包(测试注入 fake)。 */
  resolveDisputeOnChain: (args: { orderId: string; buyerRefund: bigint }) => Promise<OnChainResult>
  flagDisputeOnChain: (args: { orderId: string }) => Promise<OnChainResult>
  /** 审计网络标注('mainnet' | 'testnet')。 */
  network: string
}

interface OrderRow { id: string; status: string; payment_rail: string; buyer_id: string; seller_id: string | null }
interface IntentRow { amount_units: number; status: string }

// DB 已终结的态:此时 arbiter 裁决几乎必是误操作 / DB-链上分歧,停下让人工核(链上 state 才是权威门,由 signer 前置校验)。
const TERMINAL = new Set(['completed', 'cancelled', 'refunded_full', 'refunded_partial', 'resolved_for_seller', 'dispute_dismissed'])

export function registerUsdcEscrowArbiterRoutes(app: Application, deps: UsdcEscrowArbiterRouteDeps): void {
  const { requireProtocolAdmin, consumeGateToken, logAdminAction, network } = deps
  const err = (res: Response, status: number, code: string, msg: string): void => void res.status(status).json({ error: msg, error_code: code })

  // 共用:auth + 订单/本轨/未终结校验 → 返回 order,或已写响应返回 null。
  const loadResolvableOrder = async (req: Request, res: Response, admin: Record<string, unknown>, action: string): Promise<OrderRow | null> => {
    const orderId = String(req.params.orderId || '')
    const order = await dbOne<OrderRow>('SELECT id, status, payment_rail, buyer_id, seller_id FROM orders WHERE id = ?', [orderId])
    if (!order) { logAdminAction(admin.id as string, action, 'order', orderId, { ok: false, reason: 'not_found' }); err(res, 404, 'ORDER_NOT_FOUND', '订单不存在'); return null }
    if (order.payment_rail !== 'usdc_escrow') { logAdminAction(admin.id as string, action, 'order', orderId, { ok: false, reason: 'wrong_rail', rail: order.payment_rail }); err(res, 409, 'USDC_ESCROW_ARBITER_WRONG_RAIL', '该操作仅适用于 USDC 合约担保订单'); return null }
    if (TERMINAL.has(order.status)) { logAdminAction(admin.id as string, action, 'order', orderId, { ok: false, reason: 'already_final', status: order.status }); err(res, 409, 'USDC_ESCROW_ARBITER_ALREADY_FINAL', '订单已终结,不可再裁决(如与链上状态分歧请先人工核对)'); return null }
    return order
  }

  // POST /api/admin/usdc-escrow/:orderId/resolve —— arbiter 裁决(链上 arbiterResolve;buyerRefund 6dp 整数单位)。
  app.post('/api/admin/usdc-escrow/:orderId/resolve', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const order = await loadResolvableOrder(req, res, admin, 'usdc_escrow_arbiter_resolve'); if (!order) return
    const orderId = order.id
    // ★ P1 收口门(B7a round-2):resolve 只在 DB 已 disputed 时放行。—— 每个被认可的链上 Resolved 必然落
    //   applyUsdcEscrowResolved 的 disputed 分支正常收敛(状态→终态 + fee 镜像 + intent→resolved);对 delivered/
    //   paid 等非 disputed 单发链上 arbiterResolve,则 Resolved 只落 default 分支(仅 alert、不 transition、
    //   不 mirror)→ 订单永卡 / intent 卡 funded / fee 缺行,连 sweep(只选 disputed)也救不回。这里门控前置于
    //   Passkey 消费与链上调用(非 disputed 单绝不烧 Passkey、绝不动链)。
    //   注:不合作 / 丢钱包买家的端到端 DB 收敛需要"系统/arbiter 代开 DB 争议"(现 ?→disputed 全要 buyer/seller/
    //   logistics 角色 + evidence,system/arbiter 无入口)—— 那是状态机设计决策,明确归 B7b(设计 system/arbiter
    //   开争议入口 + 证据豁免语义),本轮绝不改状态机。合作型路径已闭合:买家在 App 正常开 DB 争议 + B6b-2 链上
    //   flagDispute → DB 与链皆 disputed → admin resolve → Resolved → 正常收敛。
    if (order.status !== 'disputed') {
      logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: false, reason: 'not_disputed', status: order.status })
      return void err(res, 409, 'USDC_ESCROW_ARBITER_NOT_DISPUTED', '订单未处于争议态,无法链上裁决;请先在订单页开启争议 / Order is not in a disputed state — open a dispute on the order page before on-chain arbitration')
    }
    // 金额门:buyer_refund_units 整数(6dp)∈ [0, intent.amount_units](BigInt)。
    const intent = await dbOne<IntentRow>('SELECT amount_units, status FROM usdc_escrow_intents WHERE order_id = ?', [orderId])
    if (!intent) { logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: false, reason: 'no_intent' }); return void err(res, 409, 'USDC_ESCROW_ARBITER_NO_INTENT', '该订单无 USDC 担保凭证,无法裁决') }
    const rawRefund = req.body?.buyer_refund_units
    const refundNum = typeof rawRefund === 'number' ? rawRefund : (typeof rawRefund === 'string' && /^\d+$/.test(rawRefund.trim()) ? Number(rawRefund.trim()) : NaN)
    if (!Number.isInteger(refundNum) || refundNum < 0) { logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: false, reason: 'bad_refund' }); return void err(res, 400, 'USDC_ESCROW_ARBITER_BAD_REFUND', 'buyer_refund_units 须为非负整数(USDC 6dp 单位)') }
    const buyerRefund = BigInt(refundNum)
    if (buyerRefund > BigInt(intent.amount_units)) { logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: false, reason: 'refund_over_amount', buyer_refund: refundNum, amount: intent.amount_units }); return void err(res, 400, 'USDC_ESCROW_ARBITER_BAD_REFUND', 'buyer_refund_units 超过托管金额') }
    // ★ 现场真人 Passkey(purpose 绑动作 + purpose_data.order_id 绑本单)—— 移动真钱前的最后一道人门。失败留痕。
    const gate = consumeGateToken(admin.id as string, req.body?.webauthn_token as string | undefined, 'usdc_escrow_arbiter_resolve', (d) => (d as { order_id?: string } | null)?.order_id === orderId)
    if (!gate.ok) { logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: false, gate: gate.reason }); return void err(res, 412, 'HUMAN_PRESENCE_REQUIRED', gate.reason || '此操作需现场真人 Passkey 确认') }
    // 链上裁决(signer 前置读链上态断言 Disputed + 边界;失败不烧 gas / 不假成功)。
    const r = await deps.resolveDisputeOnChain({ orderId, buyerRefund })
    if (!r.ok) {
      logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: false, buyer_refund: refundNum, error: r.error, tx_hash: r.txHash ?? null, network })
      if (r.error === 'not configured') return void err(res, 409, 'USDC_ESCROW_NOT_CONFIGURED', 'USDC 合约担保轨未配置(合约地址缺失)')
      return void res.status(502).json({ error: '链上裁决失败:' + (r.error || '未知错误'), error_code: 'USDC_ESCROW_ARBITER_RESOLVE_FAILED', ...(r.txHash ? { tx_hash: r.txHash } : {}) })
    }
    logAdminAction(admin.id as string, 'usdc_escrow_arbiter_resolve', 'order', orderId, { ok: true, buyer_refund: refundNum, tx_hash: r.txHash, network })
    res.json({ success: true, tx_hash: r.txHash, note: '链上裁决交易已提交;订单 DB 状态由链上 Resolved 事件确认后收敛(约 1–2 分钟)。 / Arbiter ruling tx submitted; the order status settles once the on-chain Resolved event is confirmed (~1–2 min).' })
  })

  // POST /api/admin/usdc-escrow/:orderId/flag-dispute —— arbiter 冻结(链上 flagDispute;买家丢钱包/不配合)。
  app.post('/api/admin/usdc-escrow/:orderId/flag-dispute', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const order = await loadResolvableOrder(req, res, admin, 'usdc_escrow_arbiter_flag'); if (!order) return
    const orderId = order.id
    const intent = await dbOne<IntentRow>('SELECT amount_units, status FROM usdc_escrow_intents WHERE order_id = ?', [orderId])
    if (!intent) { logAdminAction(admin.id as string, 'usdc_escrow_arbiter_flag', 'order', orderId, { ok: false, reason: 'no_intent' }); return void err(res, 409, 'USDC_ESCROW_ARBITER_NO_INTENT', '该订单无 USDC 担保凭证,无法冻结') }
    const gate = consumeGateToken(admin.id as string, req.body?.webauthn_token as string | undefined, 'usdc_escrow_arbiter_flag', (d) => (d as { order_id?: string } | null)?.order_id === orderId)
    if (!gate.ok) { logAdminAction(admin.id as string, 'usdc_escrow_arbiter_flag', 'order', orderId, { ok: false, gate: gate.reason }); return void err(res, 412, 'HUMAN_PRESENCE_REQUIRED', gate.reason || '此操作需现场真人 Passkey 确认') }
    const r = await deps.flagDisputeOnChain({ orderId })
    if (!r.ok) {
      logAdminAction(admin.id as string, 'usdc_escrow_arbiter_flag', 'order', orderId, { ok: false, error: r.error, tx_hash: r.txHash ?? null, network })
      if (r.error === 'not configured') return void err(res, 409, 'USDC_ESCROW_NOT_CONFIGURED', 'USDC 合约担保轨未配置(合约地址缺失)')
      return void res.status(502).json({ error: '链上冻结失败:' + (r.error || '未知错误'), error_code: 'USDC_ESCROW_ARBITER_FLAG_FAILED', ...(r.txHash ? { tx_hash: r.txHash } : {}) })
    }
    logAdminAction(admin.id as string, 'usdc_escrow_arbiter_flag', 'order', orderId, { ok: true, tx_hash: r.txHash, network })
    res.json({ success: true, tx_hash: r.txHash, note: '链上冻结交易已提交;订单 DB 状态由链上 Disputed 事件确认。 / Freeze tx submitted; reflected once the on-chain Disputed event is confirmed.' })
  })
}
