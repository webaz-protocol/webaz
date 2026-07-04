/**
 * 商家履约保证金条款(B 决策前置,2026-07-05)。
 *
 * 为什么存在:罚没/退还必须有【商家缴纳前显式同意】的合同依据 —— 没有条款文本,罚没在合同法上站不住
 *   (SG 语境:罚没条款须像"约定履约损害赔偿"而非"惩罚",penalty clause 可能不可执行,故文本刻意
 *   采用 liquidated-damages 表述并写明用途去向)。条款版本化:缴纳申报时快照 terms_version 进 deposit 行,
 *   新版本只影响之后的缴纳;版本串同时作为 rail-clearance 的 policy_version(可审计对齐)。
 *
 * 变更本文本 = 变更商家合同条款:必须 bump BOND_TERMS.version,且只对新申报生效。
 */

export const BOND_TERMS = {
  version: 'bond-terms.v1.2026-07-05',
  zh: `【商家履约保证金条款 v1】
1. 性质:本保证金是你(商家)向 WebAZ 平台缴纳的【履约担保物】(security deposit),用于担保你在直付(direct_p2p)交易中的履约义务。它不是投资、不是存款、不是买家资金,也不产生利息。
2. 金额与币种:按平台公示档位(当前 T0 = 500 USDC 等值;固定 token 数,档位参考 ≈ S$500,非实时汇率换算)。可按平台公示的收款账户以 USDC 或对应法币缴纳;跨币种等值由平台运营在核实到账时按公示口径认定。
3. 生效:缴纳后须经平台运营核实真实到账并确认锁定方才生效;申报本身不授予任何资格。
4. 退还:你可申请退出并退还保证金。前提是【无任何未了结的直付责任】(在途订单、售后/退货流程、争议、待复核罚没、平台服务费欠费等),并经过平台公示的冷静期;冷静期内你的直付资格暂停,期间可随时撤销申请。退还在协议外原路/约定方式完成并留痕。
5. 罚没(约定履约损害赔偿):仅当直付交易争议经平台仲裁【裁定你承担责任】后,平台方可发起罚没提案;提案设有公示冷静期(即你的申诉窗口),期满经人工复核后执行。你同意:被执行的罚没金额作为【约定的履约损害赔偿与生态修复金】全额转入平台处罚金专户 —— 该专户只进不出、不用于平台收益、不向个案裁决者发放,用途受治理公示约束。
6. 链上风险:以 USDC 缴纳时,链、地址、金额由你自行核对;错链/错地址造成的损失由你承担。
7. 条款版本:本条款版本化。你每次缴纳申报时同意的版本会被记录;条款更新只影响之后的新缴纳。
8. 你确认:已阅读并理解上述条款,自愿缴纳。`,
  en: `[Merchant Performance Bond Terms v1]
1. Nature: this bond is a SECURITY DEPOSIT you (the merchant) place with the WebAZ platform to secure your fulfilment obligations in Direct Pay (direct_p2p) trades. It is not an investment, not a deposit account, not buyer funds, and bears no interest.
2. Amount & currency: per the published tier (currently T0 = 500 USDC equivalent; a fixed token amount — the "≈ S$500" label is a tier reference, not a live FX conversion). Payable in USDC or the corresponding fiat via the platform's published receiving accounts; cross-currency equivalence is determined by platform operations at verification time per the published basis.
3. Effectiveness: the bond takes effect only after platform operations verify the actual arrival of funds and confirm the lock; a declaration by itself grants nothing.
4. Refund: you may request exit and refund, provided you have NO outstanding Direct Pay liabilities (open orders, after-sales/return flows, disputes, pending slash reviews, unpaid platform service fees, etc.) and after the published cooling window; your Direct Pay eligibility is suspended during the window and you may cancel the request at any time. The refund is completed off-protocol via the original/agreed channel and recorded.
5. Slash (agreed liquidated damages): only after a Direct Pay dispute is RULED against you by platform arbitration may the platform open a slash proposal; the proposal carries a published cooling window (your appeal window) and is executed after human review. You agree that a slashed amount, as AGREED LIQUIDATED DAMAGES and ecosystem-remediation funds, is transferred in full to the platform's penalty reserve — inflow-only, never platform profit, never paid to per-case adjudicators, with usage bound by published governance.
6. On-chain risk: when paying in USDC you are responsible for verifying the chain, address and amount; losses from wrong-chain/wrong-address transfers are yours.
7. Versioning: these terms are versioned. The version you agree to at each declaration is recorded; updates affect only subsequent deposits.
8. You confirm you have read and understood these terms and deposit voluntarily.`,
} as const
