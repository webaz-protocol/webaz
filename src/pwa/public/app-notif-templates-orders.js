// 订单状态转移通知 i18n 模板(N1 迁移收口)。UI ONLY —— 服务端 notifyTransition 落库
//   template_key + params {buyer,seller,product,amount,logistics};此处按 viewer locale 用 t() 渲染。
//   注册进 app-notif-templates.js 的 window.NOTIF_TEMPLATES(本文件在其后加载);旧行/未知 key 回退中文。
//   _dp 变体 = direct_p2p 资金语义分轨(非托管:绝无"资金已释放/退回"话术)。新模板加 i18n.js 双语句对。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), { logistics: t('物流方'), ...p }) })
  Object.assign(window.NOTIF_TEMPLATES, {
    ord_created_paid: P('🛍️', '新订单', '{buyer} 下单了「{product}」,金额 {amount} WAZ。请在 24h 内接单,否则自动退款。'),
    ord_paid_accepted: P('✅', '卖家已接单', '{seller} 已接受你的订单,预计 5 天内发货。'),
    ord_paid_cancelled: P('❌', '订单已取消', '订单「{product}」已取消,{amount} WAZ 将原路退回。'),
    ord_accepted_shipped: P('📦', '商品已发货', '{seller} 已发货,物流 48h 内揽收后你可以追踪包裹。'),
    ord_shipped_picked_up: P('🚚', '物流已揽收', '包裹已由 {logistics} 揽收,正在运输中。'),
    ord_picked_up_in_transit: P('🚛', '包裹运输中', '你的「{product}」正在运输途中。'),
    ord_in_transit_delivered: P('📬', '包裹已投递', '你的包裹已送达,请确认收货。72 小时内未确认将自动完成。'),
    ord_delivered_confirmed: P('💰', '买家确认收货', '{buyer} 已确认收货,{amount} WAZ 结算中。'),
    ord_delivered_confirmed_dp: P('✅', '买家确认收货', '{buyer} 已确认收货,订单完成。直付为非托管:货款由你与买家场外结算,协议不代收、无平台资金入账。'),
    ord_confirmed_completed: P('✅', '交易完成,资金到账', '订单「{product}」交易完成,收益已入账,查看钱包确认。'),
    ord_confirmed_completed_dp: P('✅', '交易完成', '订单「{product}」交易完成。直付为非托管:无平台资金结算,货款以你与买家场外结算为准。'),
    ord_paid_disputed: P('⚠️', '买家发起争议', '{buyer} 对订单「{product}」发起了争议。请在 48 小时内提交反驳证据,否则协议自动裁定退款。'),
    ord_accepted_disputed: P('⚠️', '买家发起争议', '{buyer} 对订单「{product}」发起了争议,请在 48h 内回应。'),
    ord_shipped_disputed: P('⚠️', '发生争议', '订单「{product}」出现争议,请提交相关证据。'),
    ord_in_transit_disputed: P('⚠️', '运输中发生争议', '订单「{product}」运输过程中发生争议,请及时回应。'),
    ord_delivered_disputed: P('⚠️', '买家对收货发起争议', '{buyer} 声称货物有问题,已发起争议。请在 48h 内提交证据。'),
    ord_disputed_completed: P('⚖️', '争议裁定:卖家胜诉', '订单「{product}」争议已裁定,资金已释放给卖家。'),
    ord_disputed_completed_dp: P('⚖️', '争议裁定:卖家胜诉', '订单「{product}」争议已裁定:卖家胜诉(直付为信誉裁决,不涉资金流转)。'),
    ord_disputed_cancelled: P('⚖️', '争议裁定:退款买家', '订单「{product}」争议已裁定,{amount} WAZ 已退回买家。'),
    ord_disputed_cancelled_dp: P('⚖️', '争议裁定:支持买家', '订单「{product}」争议已裁定支持买家。直付非托管:平台无资金可退,退款由双方场外处理;卖家信誉处罚已记录。'),
    ord_paid_fault_seller: P('⏰', '卖家超时违约', '卖家超时未接单,订单已自动取消,{amount} WAZ 退款处理中。'),
    ord_accepted_fault_seller: P('⏰', '卖家超时未发货', '卖家超时未发货,订单已判违约,资金退回。'),
    ord_accepted_fault_seller_dp: P('⏰', '卖家超时未发货', '卖家超时未发货,订单已判卖家违约并关闭(直付非托管:平台无资金可退,违约已记入卖家信誉;如已场外付款,请通过订单聊天与卖家协商退款)。'),
    ord_in_transit_fault_logistics: P('⏰', '物流超时', '物流方超时未完成投递,已自动记录违约。'),
    ord_accepted_payment_query: P('🔎', '卖家未收到货款', '卖家报告尚未收到「{product}」的货款,请核实:若确已付款请提供付款参考,若未付款可取消订单。直付非托管,协议不代收/不退款。'),
    ord_payment_query_accepted: P('✅', '卖家已确认收款', '卖家已确认收到「{product}」的货款,订单恢复,等待发货。'),
    ord_payment_query_disputed: P('⚖️', '货款协商升级举证仲裁', '「{product}」货款协商未果,已进入举证仲裁(证据制信誉裁决,非托管:不涉退款/放款)。请提交证据。'),
    ord_disputed_payment_query: P('↩️', '仲裁已撤回,回到协商', '「{product}」的仲裁申请已撤回,回到买卖双方协商。'),
    ord_payment_query_cancelled: P('🚫', '直付订单已取消(协商)', '「{product}」订单已取消(货款协商未达成)。直付非托管,无平台退款。'),
    // ── N3:平台服务费预充值申请三向通知(admin 待审 / 卖家获批 / 卖家被拒)──
    dp_fee_prepay_requested: P('💳', '新预充值申请待审', '卖家 {seller} 申请平台服务费预充值 {amount} USDC,请到 admin 后台核对到账后处理。'),
    dp_fee_prepay_approved: P('✅', '预充值已确认入账', '你的平台服务费预充值 {amount} USDC 已确认入账,直付新单额度已恢复。'),
    dp_fee_prepay_rejected: P('❌', '预充值申请未通过', '你的平台服务费预充值申请未通过{note}。请核对付款凭据后重新提交,或联系平台。'),
  })
})()
