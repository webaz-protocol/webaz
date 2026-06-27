/**
 * Direct Pay (Rail 1) 披露(两次风险提醒)—— 契约层证据,非 UI 事后。设计稿 §2 (Rev 2026-06-27e+)。
 *
 * 两次【分别】发生的提醒,各记一行(append-only,direct_pay_disclosure_acks,UNIQUE(order_id,stage)):
 *   - PRE_SELECT  (展示/选择直付前):D1「本单无经济保障…」。**买家单视角,绝不含卖家机制(质押/平台费)**。
 *   - PRE_CONFIRM (最终下单/确认付款前):D2 paid-but-timeout + 最终风险再确认。
 * 最终确认逻辑【只在两 stage 都 ack 且版本为当前时】放行(requireBothDisclosuresAcked)。
 * 每行带 notice_version + acked_at → 可证两次分别发生、第二次在最终确认前。
 * 跨方铁律:只暴露买家自己的部分;卖家机制绝不进 D1/D2。
 *
 * 路由分工(Phase 4):PRE_SELECT 在买家选择直付时 recordDisclosureAck;PRE_CONFIRM 在「我已付款」/
 *   最终确认时 recordDisclosureAck,且该最终转移前先跑 requireBothDisclosuresAcked 作契约门。
 */
import type Database from 'better-sqlite3'

export const STAGE = { PRE_SELECT: 'pre_select', PRE_CONFIRM: 'pre_confirm' } as const
export type DisclosureStage = typeof STAGE[keyof typeof STAGE]

/** D1 = PRE_SELECT 提醒(买家单视角,无任何卖家机制)。 */
export const D1 = {
  stage: STAGE.PRE_SELECT,
  version: 'd1.v1.2026-06-27',
  zh: '本单无经济保障,出问题不退款,仅对卖家作信誉处罚。请自行判断风险后付款。',
  en: 'This order has NO economic protection: no refund if it goes wrong, only reputation penalties on the seller. Decide your own risk before paying.',
}
/** D2 = PRE_CONFIRM 提醒(paid-but-timeout + 最终风险再确认)。 */
export const D2 = {
  stage: STAGE.PRE_CONFIRM,
  version: 'd2.v1.2026-06-27',
  zh: "付款后请立即点'我已付款';若窗口过期你须发起争议,本档不退款、仅信誉处罚。确认承担风险后再付款。",
  en: "Mark 'I have paid' immediately after paying; if the window lapses you must raise a dispute — this tier issues no refund, only reputation penalties. Confirm you accept the risk before paying.",
}

const STAGE_VERSION: Record<DisclosureStage, string> = { [STAGE.PRE_SELECT]: D1.version, [STAGE.PRE_CONFIRM]: D2.version }

/** 买家面披露载荷(只含买家自己的部分)。 */
export function getBuyerDisclosures(): { preSelect: typeof D1; preConfirm: typeof D2 } {
  return { preSelect: D1, preConfirm: D2 }
}

/** 记录一次提醒 ack(append-only;同单同 stage 幂等)。stage 决定 notice_version。 */
export function recordDisclosureAck(db: Database.Database, args: { orderId: string; buyerId: string; stage: DisclosureStage; ackId: string }): void {
  db.prepare(`INSERT OR IGNORE INTO direct_pay_disclosure_acks (id, order_id, buyer_id, stage, notice_version, acked_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(args.ackId, args.orderId, args.buyerId, args.stage, STAGE_VERSION[args.stage])
}

/** 某 stage 是否已 ack(且版本为当前)。 */
export function disclosureStageAcked(db: Database.Database, orderId: string, stage: DisclosureStage): boolean {
  return !!db.prepare('SELECT 1 FROM direct_pay_disclosure_acks WHERE order_id = ? AND stage = ? AND notice_version = ?')
    .get(orderId, stage, STAGE_VERSION[stage])
}

export interface DisclosureGate { ok: boolean; error_code?: string; reason?: string; missing?: DisclosureStage[] }

/**
 * 最终确认契约门:pre_select + pre_confirm 两次提醒都已 ack 且版本为当前,才放行。
 * 缺任一 → 硬失败(最终确认/付款确认拒绝)。这是「无经济保障、风险自担」边界的证据门 —— 不可压成单次 ack。
 */
export function requireBothDisclosuresAcked(db: Database.Database, orderId: string): DisclosureGate {
  const missing: DisclosureStage[] = []
  if (!disclosureStageAcked(db, orderId, STAGE.PRE_SELECT)) missing.push(STAGE.PRE_SELECT)
  if (!disclosureStageAcked(db, orderId, STAGE.PRE_CONFIRM)) missing.push(STAGE.PRE_CONFIRM)
  if (missing.length) return { ok: false, error_code: 'DISCLOSURE_NOT_ACKED', reason: `直付最终确认前必须完成两次风险提醒:缺 ${missing.join(',')}`, missing }
  return { ok: true }
}
