/**
 * Direct Pay (Rail 1) — 风险披露 ack 端点 (PR-4d)。薄 route adapter:复用 #87 helper
 *   (recordDisclosureAck / disclosureStageAcked / requireBothDisclosuresAcked / getBuyerDisclosures),
 *   【不】重写任何规则。server.ts 只 import + register;业务逻辑全在本模块。
 *
 * 语义(诚实边界):ack = "真人本人已阅读并确认风险披露" —— 【不】代表付款完成,【不】代表 WebAZ 提供
 *   担保 / 维权 / 退款。本 PR 只新增 D1/D2 ack 端点;mark_paid / confirm / confirm-in-person 真正接
 *   requireBothDisclosuresAcked 留到 4e(本 PR【不】声称订单动作已被披露门保护)。
 *
 * human-only(P1 修正 —— 不用 agent_reputation 启发式,那张表普通用户永久 key 也会进,既误杀真人又挡不住 agent):
 *   POST ack 走 #87 的 requireDirectPayHumanPasskey(① 必须绑 Passkey;② 一次性 purpose-bound 真人
 *   WebAuthn gate token)—— 现场真人才能签收,agent 无 live assertion 过不了。这是签收证据层的真凭据。
 *   (这是 requireDirectPayHumanPasskey 的首次接线;它只盖【ack 端点】,不是 4e 的订单动作门。)
 * 绑定:仅 payment_rail='direct_p2p' 单,且调用者 === order.buyer_id。GET 为只读状态查询(本人),不要求 gate token。
 * 不改订单状态,不动 wallet/settlement/escrow/refund/base-bond。GET 披露文案【仅买家视角】,绝不含卖家机制。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'
import { STAGE, recordDisclosureAck, disclosureStageAcked, requireBothDisclosuresAcked, getBuyerDisclosures, type DisclosureStage } from '../../direct-pay-disclosures.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'

export interface DirectPayDisclosureAckDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  /** 一次性真人 WebAuthn gate token 消费器(server.ts createHumanPresence 注入)。 */
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

const VALID_STAGES: DisclosureStage[] = [STAGE.PRE_SELECT, STAGE.PRE_CONFIRM]

export function registerDirectPayDisclosureAckRoutes(app: Application, deps: DirectPayDisclosureAckDeps): void {
  const { db, auth, generateId, consumeGateToken } = deps

  /** 订单存在 + direct_p2p + 调用者本人是 buyer。返回 order 或 null(已写错误响应)。 */
  async function requireOwnDirectPayOrder(orderId: string | undefined, res: Response, user: Record<string, unknown>):
    Promise<{ id: string; buyer_id: string; payment_rail: string; status: string } | null> {
    if (!orderId) { res.status(400).json({ error: '缺少 order_id', error_code: 'MISSING_ORDER_ID' }); return null }
    const order = await dbOne<{ id: string; buyer_id: string; payment_rail: string; status: string }>(
      'SELECT id, buyer_id, payment_rail, status FROM orders WHERE id = ?', [orderId])
    if (!order) { res.status(404).json({ error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }); return null }
    if (order.payment_rail !== 'direct_p2p') { res.status(409).json({ error: '风险披露仅适用于直付(direct_p2p)订单', error_code: 'NOT_DIRECT_PAY_ORDER' }); return null }
    if (order.buyer_id !== user.id) { res.status(403).json({ error: '只能确认自己订单的风险披露', error_code: 'NOT_ORDER_BUYER' }); return null }
    return order
  }

  // POST — 记录 ack。stage = pre_select | pre_confirm | both。需现场真人(Passkey + gate token)。幂等(INSERT OR IGNORE)。
  //   'both'(2026-07-04 用户决策,contract v14):两屏披露【仍各自展示并确认】(文本证据不减),但一次真人 ceremony
  //   可覆盖两个 stage → 落库仍是【两行】ack(各带 notice_version+acked_at,requireBothDisclosuresAcked 证据模型不变);
  //   变化仅是"人在场证明"从两次合并为一次(首单 Passkey 3→2;mark_paid 的独立 RISK 门不变)。token purpose_data 绑
  //   stage:'both' —— 单 stage token 冒充不了 both,both token 也重放不了单 stage(一次性消费 + validate 精确匹配)。
  app.post('/api/direct-pay/disclosure-acks', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const stage = req.body?.stage as DisclosureStage | 'both'
    if (stage !== 'both' && !VALID_STAGES.includes(stage as DisclosureStage)) return void res.status(400).json({ error: `无效 stage(只允许 ${VALID_STAGES.join('|')}|both)`, error_code: 'INVALID_STAGE' })
    const order = await requireOwnDirectPayOrder(req.body?.order_id as string | undefined, res, user); if (!order) return
    // human-only:现场真人 Passkey 二次确认。purpose 用【固定白名单值】(/api/webauthn/auth/start 才放行申请 challenge);
    //   order+stage 绑定走 purpose_data + validate(杜绝跨单/跨阶段复用 token),不能塞进 purpose 字符串(那样真实 UI 拿不到 token)。
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: user.id as string, webauthnToken: req.body?.webauthn_token as string | undefined,
      purpose: 'direct_pay_disclosure_ack',
      validate: (data) => { const d = data as { order_id?: string; stage?: string } | null; return !!d && d.order_id === order.id && d.stage === stage },
    })
    if (!gate.ok) return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    for (const s of (stage === 'both' ? VALID_STAGES : [stage as DisclosureStage])) recordDisclosureAck(db, { orderId: order.id, buyerId: user.id as string, stage: s, ackId: generateId('dpa') })
    return void res.json({
      ok: true, stage,
      both: requireBothDisclosuresAcked(db, order.id).ok,
      note: 'ack = 真人本人已阅读并确认风险披露;不代表付款完成,不代表 WebAZ 提供担保/维权/退款',
    })
  })

  // GET — 查询某单两次 ack 状态 + 买家视角披露文案(无卖家机制)。只读(本人),不需 gate token。
  app.get('/api/direct-pay/disclosure-acks/:orderId', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await requireOwnDirectPayOrder(req.params.orderId, res, user); if (!order) return
    const d = getBuyerDisclosures()
    return void res.json({
      order_id: order.id,
      acked: { pre_select: disclosureStageAcked(db, order.id, STAGE.PRE_SELECT), pre_confirm: disclosureStageAcked(db, order.id, STAGE.PRE_CONFIRM) },
      both: requireBothDisclosuresAcked(db, order.id).ok,
      disclosures: {
        pre_select: { zh: d.preSelect.zh, en: d.preSelect.en, version: d.preSelect.version },
        pre_confirm: { zh: d.preConfirm.zh, en: d.preConfirm.en, version: d.preConfirm.version },
      },
    })
  })
}
