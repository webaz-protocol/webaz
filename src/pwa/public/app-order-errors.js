// 交易流程错误码 → 双语文案。后端各路由返回 { error, error_code };前端统一经此映射为 t() 双语,
//   避免把中文 error 原样弹给英文界面(如 NOT_ORDER_BUYER 未映射→回退原始中文,即"只能确认自己订单的风险披露"混入英文 UI 的 bug)。
//   覆盖 orders-action(/orders/:id/action + confirm-in-person)与 direct-pay-disclosure-acks 的用户可达 error_code。
//   dpErrorText(直付可用性/建单)也回退查此表。新增后端 error_code 须补此表 —— test-order-errors.ts 完整性守。
//   中文 t(),英文 i18n.js _EN(双语 parity 同样由 test-order-errors.ts 守)。
window.orderErrorLookup = (code) => ({
  // 角色 / 所有权
  NOT_ORDER_BUYER: t('只能操作自己的订单'),
  NOT_ORDER_SELLER: t('你不是本订单的卖家'),
  NOT_ORDER_LOGISTICS: t('你不是本订单的物流方'),
  NOT_ORDER_PARTY: t('只有买卖双方可操作'),
  TRUSTED_ROLE_NO_TRADE: t('运营角色账号不可参与订单流转'),
  // 状态门
  NOT_ACCEPTED: t('仅可在待发货阶段进行此操作'),
  NOT_PAYMENT_QUERY: t('仅可在货款协商阶段进行此操作'),
  NOT_DISPUTED: t('仅可在争议阶段撤回'),
  NOT_DIRECT_PAY: t('该操作仅适用于直付订单'),
  NOT_DIRECT_PAY_WINDOW: t('该操作仅适用于直付订单的付款窗口/协商阶段'),
  NOT_DIRECT_PAY_ORDER: t('风险披露仅适用于直付订单'),
  NOT_IN_PERSON: t('该订单不是面交订单'),
  NOT_CONFIRMABLE_IN_PERSON: t('当前订单状态不可确认面交完成'),
  HAS_PENDING_CLAIM: t('存在进行中的验证任务,暂不可确认'),
  // 货款协商 / 争议 / 撤回
  GRACE_NOT_ELAPSED: t('买家响应宽限期未过,暂不可申请取消'),
  DISPUTE_ALREADY_RULED: t('争议已裁定,不可撤回'),
  NOT_PAYMENT_QUERY_DISPUTE: t('仅可撤回由货款协商升级的仲裁;履约类争议(货损/货不对版)须经仲裁裁定'),
  WITHDRAW_FAILED: t('撤回失败,请重试'),
  CANCEL_FAILED: t('取消失败,请重试'),
  DIRECT_PAY_SETTLE_FAILED: t('直付完成结算失败,订单未完成,可重试'),
  ORDER_NOT_DELIVERED: t('订单尚未送达,暂不可确认收货'),
  // RFC-007 拒单 / 举证
  NOT_PROVISIONAL_DECLINE: t('本订单不是可举证的临时判责状态'),
  ALREADY_CONTESTED: t('已在仲裁中,无需重复发起'),
  CONTEST_WINDOW_CLOSED: t('举证窗口已过期'),
  DECLINE_REASON_INVALID: t('拒单理由无效'),
  DECLINE_WRONG_STATUS: t('当前状态不可拒单'),
  DECLINE_SETTLEMENT_FAILED: t('拒单结算失败,请重试'),
  // 直付 RISK 动作门(mark_paid/confirm/confirm_in_person 缺披露/缺 Passkey)。与 dpErrorText 同文案,
  //   保证无论走 dpHandleAction(dpErrorText)还是通用 handleAction(orderErrorText)路径都双语一致。
  DISCLOSURE_NOT_ACKED: t('需先完成两次风险披露确认(D1 + D2)'),
  HUMAN_PRESENCE_REQUIRED: t('需现场真人 Passkey 确认'),
  PASSKEY_REQUIRED_FOR_DIRECT_PAY: t('直付需要先注册 Passkey'),
  // 通用
  ORDER_NOT_FOUND: t('订单不存在'),
  MISSING_ORDER_ID: t('缺少订单号'),
  INVALID_STAGE: t('无效的披露阶段参数'),
}[code])

// 统一取文案:先查映射,未命中回退后端原始 error(仍是文案而非裸 JSON),再回退通用兜底。
window.orderErrorText = (code, fallback) => (code && window.orderErrorLookup(code)) || fallback || t('操作失败,请重试')
