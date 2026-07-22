/**
 * RFC-029 Design A — seller-supported payment OPTIONS enumerator (the confirm-page menu source).
 *
 * Given a product/seller/amount, returns the flat list of payment options the BUYER may choose from:
 *   - escrow (the universal fallback — no per-seller escrow opt-out exists today; sim disclosure), plus
 *   - one option per the seller's supported direct-receive method, but ONLY when the direct-pay
 *     product gate passes (directPayProductAvailability) AND a receive destination actually exists.
 *
 * The direct-receive universe = each ACTIVE ACCOUNT (the new multi-account model). The old single
 * `direct_receive_payment_instructions` (legacy) is deliberately NOT offered as a buyer-choosable
 * option: it has no account id, so `direct_receive_account_id` would be null and the Passkey-bound
 * params_hash would bind null — a late resolveDirectReceive(null) could snap to a DIFFERENT destination
 * (changed/deactivated legacy, or sole-active fallthrough) after the human reviewed one (Codex BLOCKER,
 * MA5 consent integrity). A concrete account id, by contrast, is hash-bound and create REJECTS (never
 * silent-switches) if it is deactivated. Legacy-only sellers therefore appear as escrow-only here until
 * they add an account; the existing agent-supplied direct_p2p flow (which resolves legacy) is unchanged.
 * The account that resolveDirectReceive would auto-pick (no explicit choice) is flagged `recommended`
 * (a soft default / pre-selection only) — every supported option stays selectable, so a recommendation
 * NEVER shrinks the menu (threat MA3). Pure read: no wallet/escrow/state-machine, no PII in the option
 * (label is the seller-declared display label; the raw receiving instruction is revealed only at order
 * time after disclosure acks, exactly as today).
 */
import type Database from 'better-sqlite3'
import { directPayProductAvailability } from './direct-pay-availability-check.js'
import { resolveDirectReceive } from './direct-receive-resolve.js'
import { listSellerAccounts } from './direct-receive-accounts.js'

export interface PaymentOption {
  option_id: string                       // stable per option: 'escrow' | 'direct:legacy' | 'direct:<account_id>'
  rail: 'escrow' | 'direct_p2p'
  method: string | null                   // seller-declared method label (PayNow / bank / USDC …); null for legacy/escrow
  recipient_label: string | null          // seller-declared display label; never the raw receiving instruction
  direct_receive_account_id: string | null
  settlement_note: string                 // honest per-option disclosure (escrow = sim; direct = non-custodial)
  recommended: boolean                    // soft default (resolveDirectReceive auto-pick) — never removes other options
}

const ESCROW_NOTE = '模拟托管测试轨 —— 批准后从你的钱包扣款入(模拟)托管;金额以 USDC 显示为别名,不代表真实 USDC 或法币结算'
const DIRECT_NOTE = '直付:你按卖家收款说明直接付卖家;WebAZ 不托管本金,实际付款方式/币种以确认页面为准'

export interface PaymentOptionsArgs {
  productId: string
  sellerId: string
  amountUnits: number
  getProtocolParam: <T>(key: string, fallback: T) => T
}

/** The seller-supported + gate-passing payment options for this order (escrow + eligible direct methods). */
export function sellerSupportedPaymentOptions(db: Database.Database, args: PaymentOptionsArgs): PaymentOption[] {
  const options: PaymentOption[] = [
    // Escrow is the universal fallback (no per-seller opt-out today) — always offered, honest sim note.
    { option_id: 'escrow', rail: 'escrow', method: null, recipient_label: null, direct_receive_account_id: null, settlement_note: ESCROW_NOTE, recommended: false },
  ]

  // Direct-pay options only when the product/seller gate passes (same predicate the create path uses).
  // ONLY concrete active accounts are offered (each hash-bindable via its account id). The null-account
  // legacy path is intentionally excluded — see the module header (Codex BLOCKER / MA5).
  const avail = directPayProductAvailability(db, args)
  if (avail.available) {
    const dflt = resolveDirectReceive(db, args.sellerId)   // the auto-pick used when the buyer makes no explicit choice
    for (const a of listSellerAccounts(db, args.sellerId)) {   // active accounts only
      // `recommended` only when the auto-pick is THIS concrete account (never for the legacy fallthrough).
      options.push({ option_id: `direct:${a.id}`, rail: 'direct_p2p', method: a.method, recipient_label: a.label, direct_receive_account_id: a.id, settlement_note: DIRECT_NOTE, recommended: dflt.resolvable && dflt.source === 'sole_active_account' && dflt.account_id === a.id })
    }
  }
  return options
}
