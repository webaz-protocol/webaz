// 直付(非托管)争议的 rail-aware 展示文案。UI ONLY。
//   非托管裁决 = 仅信誉:协议不持货款,【不退款、不释放资金、不收仲裁费】。故订单终态标签、时间线、仲裁面板都【绝不】
//   出现"全额退款/部分退款/资金释放/仲裁费"等托管语义;改用胜负/责任(信誉裁决)语义。托管(escrow)订单沿用原文案。
//   面向用户中文走 t(),英文在 i18n.js _EN(双语 parity 由 test-direct-pay-ui.ts 守)。
window.dpTerminalBadge = (status) => ({ refunded_full: ['blue', t('买家胜诉(信誉裁决)')], refunded_partial: ['blue', t('部分责任(信誉裁决)')], resolved_for_seller: ['green', t('卖家胜诉(信誉裁决)')] })[status] || null
window.dpTerminalLabel = (status) => ({ refunded_full: t('买家胜诉(信誉裁决)'), refunded_partial: t('部分责任(信誉裁决)') })[status] || null

// 仲裁面板顶部提示:非托管 → "仅信誉裁决,不涉资金";托管 → 原仲裁费提示。
window.dpArbFeeNote = (rail) => rail === 'direct_p2p'
  ? `<div style="font-size:12px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:6px 10px;margin-bottom:8px">🏷️ ${t('非托管(直付)争议:仅信誉裁决,不发生退款 / 资金释放 / 仲裁费。')}</div>`
  : `<div style="font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:6px 10px;margin-bottom:8px">💰 败诉方须缴纳仲裁费：订单金额 × 1%（最低 1 WAZ）。部分退款时双方各付 0.5%。仲裁费 50% 归仲裁员，50% 归协议。</div>`

// 仲裁裁定选项:非托管用胜负/责任(信誉裁决)语义;托管保留原退款/释放语义。返回 [value,label][]。
// direct_p2p 无金额/无赔付,故【不含】liability_split(多方赔付分配是托管/物流概念);只保留胜负/部分责任的信誉裁决。
window.dpArbRulingOptions = (rail) => rail === 'direct_p2p'
  ? [['refund_buyer', '🔵 ' + t('判买家胜诉(信誉裁决)')], ['release_seller', '🟢 ' + t('判卖家胜诉(信誉裁决)')], ['partial_refund', '🟡 ' + t('判部分责任(信誉裁决)')]]
  : [['refund_buyer', '🔵 全额退款买家（买家胜诉，卖家承担）'], ['release_seller', '🟢 资金释放给卖家（卖家胜诉）'], ['partial_refund', '🟡 部分退款（折中，需填金额）'], ['liability_split', '⚖️ 责任分配（指定各方赔付额）']]
