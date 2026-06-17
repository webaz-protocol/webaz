/**
 * RFC-011 §⑧ 经济参与索引 —— 外部 actor 进入协议【价值流】的统一契约面。
 *
 * 价值参与 = liability_tiers 里最高的 `value_participant` 层:不只是读(①)/写(②),
 * 而是【赚费 + 押抵押 + 承担守恒的连带责任】。本表把【已存在 + 已 enforce】的角色串起来。
 *
 * doc=code 纪律(同 ④⑤⑥):
 *   - 费率/门槛【请求时实时从 protocol_params 读】(getParam 注入),永不和 enforced 经济漂移 —— 反 #1094 装饰化。
 *   - 守恒是硬不变量:所有罚没【再分配,绝不增发】(settleFault)。
 *   - 诚实 status:已上线角色标 live;通用第三方承保方(无真实需求)标 scaffolded → 自有 RFC + enters-core 门控,不过早造接口。
 *
 * 公平三原则锚:公开透明 / 谁责任谁承担 / 无责方零成本。
 */
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'

export type ParamGetter = <T>(key: string, fallback: T) => T

const GH = 'https://github.com/webaz-protocol/webaz/blob/main'
const BASE = 'https://webaz.xyz'

export function buildEconomicParticipation(getParam: ParamGetter) {
  const num = (k: string, f: number) => getParam<number>(k, f)

  return {
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    note: 'RFC-011 §⑧. The roles by which an external actor enters the protocol VALUE flow (earns fees / posts collateral / bears conserved liability) — the highest liability tier (value_participant). Rates & thresholds are read LIVE from protocol_params at request time (doc=code: this index can never drift from the enforced economics). Honesty: roles marked status=live are enforced today; status=scaffolded means the hook exists but generic third-party onboarding awaits its own RFC + real demand (enters-core test).',
    principles: {
      fairness: ['public & transparent', 'liability follows the responsible party', 'zero cost to the faultless party'],
      conservation: 'Every settlement conserves value: a forfeit F is REDISTRIBUTED (protocol ≤ its fee, fund_base excluded / promoters capped at their original commission / the harmed buyer gets ≥50% of the post-fee remainder AND absorbs any unused-commission residual — so the buyer can exceed 50%) — never minted. See engine.settleFault.',
      bootstrap_no_forfeit: 'RFC-008: an order with stake_backing=0 (bootstrap / require_seller_stake=0) incurs ZERO forfeit and never touches the participant\'s free balance. Real forfeit applies only to staked orders.',
    },
    enter_value_flow: 'A value participant is in the accountability net via api_key→passport AND collateral/reputation-bound. Highest liability tier. See /.well-known/webaz-integration.json#liability_tiers.value_participant.',
    roles: [
      {
        role: 'seller_shop',
        enters_as: 'lists products + fulfills orders',
        earns: { source: 'sale proceeds minus protocol fee', protocol_fee_rate: num('protocol_fee_rate_shop', 0.02), fee_hard_cap: 0.02, fee_note: 'RFC-008 hard cap 2%, can only decrease; pre-launch may be waived lower.' },
        collateral: { required: num('require_seller_stake', 0) === 1, param: 'require_seller_stake', model: 'RFC-008 stake_backing per order; bootstrap (=0) → zero forfeit.' },
        liability: { fault_states: ['fault_seller'], penalty_rate: num('fault_penalty_rate', 0.30), penalty_note: 'decoupled from stake rate; staked orders forfeit from stake then free balance; bootstrap orders exempt.', settlement: 'engine.settleFault (conserved)' },
        gate: 'api_key (authenticated_write)',
        status: 'live',
        enforced_by: 'routes/orders-create.ts + layer0 engine.settleFault',
      },
      {
        role: 'seller_secondhand',
        enters_as: 'lists used items + fulfills',
        earns: { source: 'sale proceeds minus protocol fee', protocol_fee_rate: num('protocol_fee_rate_secondhand', 0.01), fee_hard_cap: 0.02, fee_note: 'RFC-008 hard cap 2%, can only decrease.' },
        collateral: { required: num('require_seller_stake', 0) === 1, param: 'require_seller_stake', model: 'same RFC-008 stake model as seller_shop.' },
        liability: { fault_states: ['fault_seller'], penalty_rate: num('fault_penalty_rate', 0.30), settlement: 'engine.settleFault (conserved)' },
        gate: 'api_key (authenticated_write)',
        status: 'live',
        enforced_by: 'routes/orders-create.ts + engine.settleFault',
      },
      {
        role: 'promoter',
        enters_as: 'shares a product link; earns commission on attributed sales',
        earns: { source: 'commission on attributed order', default_commission_rate: num('default_commission_rate', 0.05), rate_note: 'per-product, seller-set; default shown here.' },
        collateral: { required: false, model: 'none; promoter takes no fulfillment liability.' },
        liability: { fault_states: [], note: 'on a fault settlement a promoter\'s payout is clawed back but capped at the original commission (conservation) — never negative.' },
        gate: 'api_key (authenticated_write)',
        status: 'live',
        enforced_by: 'commission attribution + engine.settleFault forfeit distribution',
      },
      {
        role: 'logistics',
        enters_as: 'carries the order; reports pickup/transit/delivery evidence',
        earns: { source: 'order-specific logistics fee (negotiated off-protocol / per-order, NOT a global protocol param)', protocol_param: null },
        collateral: { required: false, optional_hook: 'insurance_cap', model: 'a carrier may set insurance_cap on an order; loss above the cap is covered by the protocol fund (buyer still fully compensated).' },
        liability: { fault_states: ['fault_logistics'], settlement: 'engine.settleFault (conserved); carrier bears loss up to insurance_cap.' },
        gate: 'api_key (authenticated_write) + evidence (gps/photo) on transitions',
        status: 'live',
        enforced_by: 'L0-2 state machine transitions + L3-1 dispute-engine (insurance_cap)',
      },
      {
        role: 'anchor_verifier',
        enters_as: 'independently verifies a seller\'s external-anchor (real-world ownership/authenticity) claim by voting',
        earns: { source: 'verification_fee the seller attached to the anchor, split evenly among correct (content_matches=1) voters on community upgrade', recommended_fee: 2.0, fee_note: 'seller-set per anchor (may be 0 = community verification off); not a global param.' },
        collateral: { required: true, field: 'verifier_whitelist.stake_amount', model: 'staked to join the verifier whitelist.' },
        liability: { fault_states: ['verifier_error'], penalty: 'on an error, 50% of stake_amount forfeited from staked balance.', settlement: 'anchor-engine + verifier_whitelist' },
        gate: `reputation ≥ ${num('governance_onboarding.verifier_min_reputation', 90)} (param) + live WebAuthn per vote (iron-rule)`,
        status: 'live',
        enforced_by: 'L1-2 anchor-engine (fee split) + verifier_whitelist (stake/forfeit)',
      },
      {
        role: 'arbitrator',
        enters_as: 'adjudicates disputes (objective-claimed non-acceptance, fault contests)',
        earns: { source: 'a per-dispute arbitration fee (today: 50% of orderAmount×1%, paid by the loser). Compensated, NOT fee-maximizing — pay must stay independent of the ruling; see RFC-013 (decouples pay from ruling direction + fixes the latent "rule against who can pay" bias).', rfc: `${GH}/docs/rfcs/RFC-013-arbitrator-compensation-independence.md` },
        collateral: { required: false, model: 'reputation-bound rather than stake-bound; mis-adjudication damages reputation.' },
        liability: { note: 'accountable via reputation + audit log; iron-rule human presence required.' },
        gate: `reputation ≥ ${num('governance_onboarding.arbitrator_min_reputation', 95)} (param) + live WebAuthn per ruling (iron-rule)`,
        status: 'live',
        enforced_by: 'L3-1 dispute-engine + governance onboarding gates',
      },
      {
        role: 'skill_author',
        enters_as: 'publishes a knowledge skill to the skill market; earns on sales',
        earns: { source: 'sale price minus protocol fee', skill_fee_rate: num('skill_fee_rate', 0.05), payout_note: 'author nets price × (1 − skill_fee_rate). Independent revenue stream — NOT routed into commission/PV.' },
        collateral: { required: false },
        liability: { note: 'subject to skill-market review + meta-rules; refunds per market policy.' },
        gate: 'api_key (authenticated_write) + skill-market review',
        status: 'live',
        enforced_by: 'skill-market engine + admin review',
      },
      {
        role: 'insurer',
        enters_as: '(generic third-party underwriter) prices & carries order risk for a premium',
        earns: { source: 'order insurance premium', order_insurance_rate: num('order_insurance_rate', 0.01), today: 'buyer opt-in premium accrues at the protocol rate; there is NOT yet a generic external-underwriter market.' },
        collateral: { required: true, model: 'an external underwriter would post collateral backing its book — to be defined.' },
        liability: { note: 'would pay out covered losses; bound by collateral.' },
        gate: 'TBD (own RFC)',
        status: 'scaffolded',
        spec: `${GH}/docs/rfcs/RFC-012-external-risk-underwriter.md`,
        why_not_live: 'No real underwriters yet. Per the enters-core test (≥N independent integrators × cross-party trust × not reconstructable), generic underwriter onboarding is specified in RFC-012 (collateralized risk-cover bound to RFC-008; NOT licensed insurance) and gated on real demand — we do not pre-build the interface.',
        enforced_by: 'order_insurance_rate premium (live) + insurance_cap fund backstop (live); generic underwriter onboarding: to-build',
      },
    ],
    human_gates: 'arbitrate / verifier-vote / large withdraw require a live WebAuthn ceremony regardless of scope (iron-rule).',
    references: {
      economic_model: `${BASE}/docs/ECONOMIC-MODEL.md`,   // 协议自服务(公开经济模型)
      rfc_008: `${GH}/docs/rfcs/RFC-008-merchant-cost-collateral.md`,
      rfc_011: `${GH}/docs/rfcs/RFC-011-agent-native-integration-contract.md`,
      rfc_012_underwriter: `${GH}/docs/rfcs/RFC-012-external-risk-underwriter.md`,
      liability_tiers: 'https://webaz.xyz/.well-known/webaz-integration.json',
    },
  }
}
