/**
 * Direct Pay (Rail 1) — 卖家收款说明(payment instruction)只读 helper (PR-4c)。
 *
 * ⚠️ 这【不是】payment rail / payment method / PSP / escrow / 币种路由。WebAZ 只【存储 + 读取】卖家自填的
 *   展示文本(场外结算用),【绝不】验证、路由、托管、判断币种,也【不】做 crypto/fiat allowlist。命名刻意避开
 *   payment_method / payment_provider,以免被误读为 WebAZ 具备支付能力。
 */
import type Database from 'better-sqlite3'

export interface PaymentInstruction { id: string; instruction: string; label: string | null }

/** 卖家当前 active 收款说明(最新一条)。无则 null → 调用方必须 fail-closed,不创建直付订单。 */
export function getActivePaymentInstruction(db: Database.Database, sellerId: string): PaymentInstruction | null {
  const r = db.prepare(
    "SELECT id, instruction, label FROM direct_receive_payment_instructions WHERE seller_id = ? AND status = 'active' ORDER BY updated_at DESC, created_at DESC LIMIT 1",
  ).get(sellerId) as PaymentInstruction | undefined
  return r ?? null
}
