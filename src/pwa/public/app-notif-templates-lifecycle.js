// 订单流遍历审计(2026-07)补齐的通知 i18n 模板:自动执法(超时判责/自动确认/undeliverable)、
//   细粒度裁定终态、直付取消、协商取消。UI ONLY,与 app-notif-templates-orders.js 同机制:
//   服务端落库 template_key + params,此处按 viewer locale 用 t() 渲染;_dp = direct_p2p 非托管分轨。
//   新文件而非续写 orders 文件:复杂度 ratchet(顶格文件禁增行)。新模板句对已进 i18n.js。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), { logistics: t('物流方'), ...p }) })
  Object.assign(window.NOTIF_TEMPLATES, {
    ord_created_cancelled: P('🚫', '订单已取消', '订单「{product}」已取消(付款前)。'),
    ord_shipped_fault_logistics: P('⏰', '物流超时', '物流方超时未揽收,已自动记录违约。'),
    ord_picked_up_fault_logistics: P('⏰', '物流超时', '物流方超时未投递,已自动记录违约。'),
    ord_fault_seller_completed: P('⚖️', '卖家违约处置完成,订单已关闭', '订单「{product}」违约处置完成:{amount} WAZ 已全额退回买家,卖家质押已按违约罚没。'),
    ord_fault_seller_completed_dp: P('⚖️', '卖家违约处置完成,订单已关闭', '订单「{product}」已按卖家违约关闭。直付非托管:平台不持货款、无平台退款 —— 如你已场外付款,请通过订单聊天与卖家协商退款;卖家违约已记入信誉。'),
    ord_fault_logistics_completed: P('⚖️', '物流违约处置完成,订单已关闭', '订单「{product}」物流违约处置完成,已按协议从物流质押赔付/退款。'),
    ord_fault_logistics_completed_dp: P('⚖️', '物流违约处置完成,订单已关闭', '订单「{product}」已按物流违约关闭(非托管:不涉平台资金;违约已记录)。'),
    ord_fault_buyer_completed: P('⚖️', '买家责任处置完成,订单已关闭', '订单「{product}」买家责任处置完成,资金已按协议结算给卖家。'),
    ord_fault_buyer_completed_dp: P('⚖️', '买家责任处置完成,订单已关闭', '订单「{product}」已按买家责任关闭(非托管:不涉平台资金,仅信誉记录)。'),
    ord_delivery_failed_reported: P('📮', '卖家举证未派送成功', '订单「{product}」:卖家/物流举证包裹按订单地址投递被退回/拒收。如你认为举证不实,请在窗口内发起争议;逾期未争议将落定为买家责任。'),
    ord_delivery_failed_fault_buyer: P('⚖️', '未派送成功责任落定', '订单「{product}」:买家未在窗口内争议,未派送成功责任落定为买家。'),
    ord_delivery_failed_fault_buyer_dp: P('⚖️', '未派送成功责任落定', '订单「{product}」:买家未在窗口内争议,责任落定为买家,订单关闭(非托管:仅信誉记录,不涉资金)。'),
    ord_delivery_failed_return_pending: P('📦', '等待退货确认', '订单「{product}」责任已落定,托管资金保持锁定等待货物退回:卖家确认收到退货后按成本扣除结算;卖家逾期未确认将默认全款退回买家。'),
    ord_return_pending_completed: P('✅', '退货流程已结算', '订单「{product}」退货流程收口,托管资金已按协议结算(卖家确认收货=扣除退程成本后退款;卖家逾期未确认=默认全款退回买家)。'),
    ord_picked_up_disputed: P('⚠️', '发生争议', '订单「{product}」出现争议,请提交相关证据。'),
    ord_disputed_resolved_seller: P('⚖️', '争议裁定:卖家胜诉', '订单「{product}」争议已裁定卖家胜诉,资金已释放给卖家。'),
    ord_disputed_resolved_seller_dp: P('⚖️', '争议裁定:卖家胜诉', '订单「{product}」争议已裁定卖家胜诉(直付为信誉裁决,不涉资金流转)。'),
    ord_disputed_refunded_partial: P('⚖️', '争议裁定:部分退款', '订单「{product}」争议已裁定,已按裁定部分退款给买家。'),
    ord_disputed_refunded_partial_dp: P('⚖️', '争议裁定:部分退款', '订单「{product}」争议已裁定部分责任(直付为信誉裁决,非托管不涉平台退款)。'),
    ord_disputed_refunded_full: P('⚖️', '争议裁定:支持买家', '订单「{product}」争议已裁定全额退款,{amount} WAZ 已退回买家。'),
    ord_disputed_refunded_full_dp: P('⚖️', '争议裁定:支持买家', '订单「{product}」争议已裁定支持买家。直付非托管:平台无资金可退,退款由双方场外处理;卖家信誉处罚已记录。'),
    ord_disputed_dismissed: P('⚖️', '争议已驳回', '订单「{product}」的争议被驳回(无效),订单维持原结论。'),
    ord_dpw_cancelled: P('🚫', '直付订单已取消', '买家在付款前取消了订单「{product}」,平台费质押已释放,库存已回补。'),
    ord_deu_cancelled: P('🚫', '直付订单已关闭', '订单「{product}」已关闭(付款窗口超时,买家确认未付款)。'),
    mc_proposed: P('🤝', '对方提议协商取消', '订单「{product}」:对方提议无责协商取消,请到订单页处理(同意/拒绝)。'),
    mc_done: P('🤝', '协商取消达成,订单已关闭', '订单「{product}」双方协商一致无责取消:货款已全额退回买家,卖家质押已退还,双方信誉不受影响。'),
    mc_done_dp: P('🤝', '协商取消达成,订单已关闭', '订单「{product}」双方协商一致无责取消(非托管:零资金操作,场外款项以双方约定为准),双方信誉不受影响。'),
    mc_declined: P('🤝', '协商取消被拒绝', '订单「{product}」:对方拒绝了协商取消提议,订单维持原状态。'),
  })
})()
