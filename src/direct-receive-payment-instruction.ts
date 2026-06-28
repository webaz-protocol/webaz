/**
 * Direct Pay (Rail 1) — 卖家收款说明(payment instruction)读写 helper (PR-4c / 4f-a)。
 *
 * ⚠️ 这【不是】payment rail / payment method / PSP / escrow / 币种路由。WebAZ 只【存储 + 读取】卖家自填的
 *   展示文本(场外结算用),【绝不】验证、路由、托管、判断币种,也【不】做 crypto/fiat allowlist。命名刻意避开
 *   payment_method / payment_provider,以免被误读为 WebAZ 具备支付能力。
 *
 * 写入(4f-a):每个 seller 至多一条 active —— set 在一个【同步事务】内先停用旧 active 再插入新 active,
 *   绝不留下多条 active 竞争。不碰 buyer wallet / escrow / settlement / refund / order status。
 */
import type Database from 'better-sqlite3'

export interface PaymentInstruction { id: string; instruction: string; label: string | null }

/** instruction / label 文本上限(纯展示文本,防滥用;非业务语义)。 */
export const MAX_INSTRUCTION_LEN = 500
export const MAX_LABEL_LEN = 40

/** 卖家当前 active 收款说明(最新一条)。无则 null → 调用方必须 fail-closed,不创建直付订单。 */
export function getActivePaymentInstruction(db: Database.Database, sellerId: string): PaymentInstruction | null {
  const r = db.prepare(
    "SELECT id, instruction, label FROM direct_receive_payment_instructions WHERE seller_id = ? AND status = 'active' ORDER BY updated_at DESC, created_at DESC LIMIT 1",
  ).get(sellerId) as PaymentInstruction | undefined
  return r ?? null
}

/**
 * 设置/替换卖家当前 active 收款说明。原子:同一同步事务内先把该 seller 所有 active 置 inactive,再插入一条新 active。
 *   保证至多一条 active。instruction/label 调用方需先 trim + 校验非空/长度;此处只信任已校验入参并落库。
 *   只写 direct_receive_payment_instructions,绝不碰 wallet/escrow/settlement/order。
 */
export function setActivePaymentInstruction(
  db: Database.Database, sellerId: string,
  args: { instruction: string; label: string | null },
  generateId: (prefix: string) => string,
): PaymentInstruction {
  const id = generateId('dri')
  db.transaction(() => {
    db.prepare("UPDATE direct_receive_payment_instructions SET status = 'inactive', updated_at = datetime('now') WHERE seller_id = ? AND status = 'active'").run(sellerId)
    db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES (?, ?, ?, ?, 'active')").run(id, sellerId, args.instruction, args.label)
  })()
  return { id, instruction: args.instruction, label: args.label }
}

/** 停用卖家当前所有 active 收款说明。返回是否有行被停用(false = 本来就没有 active)。 */
export function deactivatePaymentInstruction(db: Database.Database, sellerId: string): boolean {
  const info = db.prepare("UPDATE direct_receive_payment_instructions SET status = 'inactive', updated_at = datetime('now') WHERE seller_id = ? AND status = 'active'").run(sellerId)
  return info.changes > 0
}
