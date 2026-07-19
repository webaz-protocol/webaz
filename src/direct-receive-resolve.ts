/**
 * Direct Pay (Rail 1) — 收款目的地【单一解析真源】。
 *
 * 背景 / 根因(2026-07-19):收款信息有两套并存模型 ——
 *   ① 旧·单条指令 direct_receive_payment_instructions(至多一条 active,getActivePaymentInstruction)
 *   ② 新·多账户   direct_receive_accounts(一卖家多个 active,买家自选其一,getAccount)
 * 而 direct-pay-create 的"买家未选(omit)"分支此前【只回落旧模型】,读不到新模型 → 只在新模型里配了收款
 * 账户、没有旧单条指令的卖家(真实案例 @holden),买家 omit account_id 时被误判"无收款说明"(NO_PAYMENT_INSTRUCTION),
 * 且审批页据此误标"卖家未配置收款账户"。本 helper 统一 omit 的解析,严格【向后兼容 + 加性】:
 *
 *   chosen(有效且属本卖家 active)→ 用它
 *   否则 legacy 单条指令存在 → 用它            (与既有行为逐字一致,不改动老卖家)
 *   否则该卖家【恰好一个】active 账户 → 用它    (★新增:修新模型-无 legacy 卖家的 omit 回落)
 *   否则 → 不可解析(0 账户;或 >1 账户且无 legacy → 目的地不唯一,买家必须显式选择)
 *
 * 只读卖家配置,绝不碰 wallet/escrow/settlement/order。返回的 instruction 是收款原文 —— 仅供
 * 服务端 create 写入既有【披露门保护】的 instructionSnapshot;调用方【绝不】把 instruction 投影给 agent/审批卡。
 */
import type Database from 'better-sqlite3'
import { getAccount, listSellerAccounts } from './direct-receive-accounts.js'
import { getActivePaymentInstruction } from './direct-receive-payment-instruction.js'

export type ReceiveSource = 'chosen' | 'legacy_instruction' | 'sole_active_account' | 'none'

export interface ResolvedReceive {
  resolvable: boolean
  source: ReceiveSource
  account_id: string | null       // 新模型账户 id(legacy 路径 = null)
  method: string | null           // 非敏感元数据(可投影)
  currency: string | null         // 非敏感元数据(可投影)
  label: string | null            // 非敏感元数据(可投影)
  instruction: string | null      // ★收款原文:仅服务端 create 写披露门快照;绝不投影给 agent/审批卡
}

const NONE: ResolvedReceive = { resolvable: false, source: 'none', account_id: null, method: null, currency: null, label: null, instruction: null }

export function resolveDirectReceive(db: Database.Database, sellerId: string, chosenAccountId?: string | null): ResolvedReceive {
  if (chosenAccountId) {
    const acc = getAccount(db, chosenAccountId)
    if (!acc || acc.seller_id !== sellerId || acc.status !== 'active') return NONE   // 选了但无效 → fail-closed(调用方据此报 DIRECT_RECEIVE_ACCOUNT_INVALID)
    return { resolvable: true, source: 'chosen', account_id: acc.id, method: acc.method, currency: acc.currency, label: acc.label, instruction: acc.instruction }
  }
  // 未选:先 legacy(逐字保留既有行为),再唯一 active 账户(修新模型卖家)。
  const instr = getActivePaymentInstruction(db, sellerId)
  if (instr) return { resolvable: true, source: 'legacy_instruction', account_id: null, method: null, currency: null, label: instr.label, instruction: instr.instruction }
  const active = listSellerAccounts(db, sellerId)   // 仅 active
  if (active.length === 1) {
    const a = active[0]
    return { resolvable: true, source: 'sole_active_account', account_id: a.id, method: a.method, currency: a.currency, label: a.label, instruction: a.instruction }
  }
  // 0 个账户,或 >1 个 active 账户且无 legacy(目的地不唯一)→ 买家必须显式选择 → 不可解析(omit)。
  return { ...NONE }
}
