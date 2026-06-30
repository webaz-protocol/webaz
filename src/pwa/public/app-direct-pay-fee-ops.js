// Direct Pay (Rail 1) — ADMIN 商户运营 hub + 平台服务费(预充值)账户。UI ONLY(PR-B)。
//   hub 把散落的直付 admin 功能归类(资格合规 / 平台服务费 / 上线控制),只链接既有路由。
//   fee 账户调既有 ROOT + 真人 Passkey 端点(admin-direct-receive-deposits):
//     GET  /admin/direct-receive/fee-account/:seller_id        (ROOT 只读)
//     POST /admin/direct-receive/fee-prepay  (purpose direct_pay_fee_prepay_record)
//     POST /admin/direct-receive/fee-adjust  (purpose direct_pay_fee_adjust)
//     POST /admin/direct-receive/fee-refund  (purpose direct_pay_fee_refund)
//   钱相关写动作均 requestPasskeyGate(purpose, body) → POST(purpose_data 与 body 逐字绑定)。
//   不碰 buyer wallet/escrow/order/状态机;预充值 = 商家平台服务费预付款,非买家货款/escrow/保证金。

window.renderAdminDirectPayHub = function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  const root = (state.user.admin_type || 'root') === 'root'
  const grp = (title, cards) => `<div style="font-size:13px;font-weight:700;color:#374151;margin:14px 0 6px">${title}</div>${cards}`
  app.innerHTML = shell(`
    <h1 class="page-title">💳 ${t('Direct Pay 商户运营')}</h1>
    <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin/protocol')">${t('返回协议管理')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:6px">${t('直付(Rail 1)商户运营集中入口:资格合规、平台服务费预充值、上线控制。')}</div>
    ${root ? grp(t('资格与合规'),
      adminLinkCard('🧾', t('商户合规录入'), t('KYB / 制裁筛查结论'), '#admin/compliance') +
      adminLinkCard('🪙', t('履约保证金缓交审批'), t('缓交申请 + 压低额度'), '#admin/deferrals') +
      adminLinkCard('🔖', t('逐产品直付验证'), t('核验商品外链验证码'), '#admin/product-verifications') +
      adminLinkCard('🏬', t('店铺认证审核'), t('核验店铺外链 + 免逐品'), '#admin/store-verifications')) : ''}
    ${root ? grp(t('平台服务费(预充值)'),
      adminLinkCard('💰', t('预充值与账户'), t('充值 / 调整 / 退款 / 余额 / 应收'), '#admin/dp-fee')) : ''}
    ${grp(t('上线控制'),
      adminLinkCard('⚙️', t('直付参数'), t('开关 / 地区 / 单笔上限'), '#admin/params'))}
    <div style="font-size:12px;color:#6b7280;margin-top:12px">${t('就绪报告(CLI):')} <code>npm run direct-pay:readiness</code></div>
  `, 'admin')
}

// USDC 显示(units → 去尾零)
function _dpFeeFmt(u) { return (Number(u || 0) / 1e6).toFixed(6).replace(/\.?0+$/, '') + ' USDC' }
// 金额输入(USDC 小数)→ 整数 base-units;非法 → NaN
function _dpFeeUnits(id) { const e = document.getElementById(id); const v = e ? parseFloat(e.value) : NaN; return Number.isFinite(v) ? Math.round(v * 1e6) : NaN }
function _dpFeeStr(id) { const e = document.getElementById(id); return e ? e.value.trim() : '' }

window.renderAdminDirectPayFeeOps = function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  if ((state.user.admin_type || 'root') !== 'root') { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限根管理员')}</div>`, 'admin'); return }
  const inp = (id, ph, num) => `<input id="${id}" ${num ? 'type="number" step="any"' : ''} placeholder="${ph}" style="width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">`
  const meth = (id) => `<select id="${id}" style="width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"><option value="usdc">USDC</option><option value="fiat">${t('法币 fiat')}</option></select>`
  const card = (inner) => `<div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">${inner}</div>`
  app.innerHTML = shell(`
    <h1 class="page-title">💰 ${t('平台服务费预充值与账户')}</h1>
    <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin/dp-ops')">${t('返回 Direct Pay 商户运营')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:6px">${t('预充值 = 商家平台服务费预付款(非买家货款 / 非 escrow / 非保证金)。链下实际收款/退款由你核实后在此登记;均需真人 Passkey。')}</div>
    ${card(`<div style="font-size:13px;font-weight:700;margin-bottom:8px">${t('卖家用户 ID')}</div>${inp('fee-seller', t('卖家用户 ID(seller user id)'))}<button class="btn btn-primary btn-sm" style="margin-top:8px;width:auto" onclick="window.dpFeeLoad()">${t('加载账户')}</button>`)}
    <div id="fee-acct"></div>
    ${card(`<div style="font-size:13px;font-weight:700;margin-bottom:8px">➕ ${t('记录预充值(收款)')}</div><div style="display:flex;flex-direction:column;gap:6px">${inp('fee-topup-amt', t('金额 USDC'), true)}${meth('fee-topup-method')}${inp('fee-topup-ev', t('收款凭证号 evidence_ref(选填)'))}${inp('fee-topup-note', t('备注(选填)'))}<button class="btn btn-primary btn-sm" style="align-self:flex-start;font-size:12px" onclick="window.dpFeeTopup()">${t('记录预充值(真人 Passkey)')}</button></div>`)}
    ${card(`<div style="font-size:13px;font-weight:700;margin-bottom:8px">✏️ ${t('账务更正(可正可负,非退款)')}</div><div style="display:flex;flex-direction:column;gap:6px">${inp('fee-adj-amt', t('更正额 USDC(负数=调减)'), true)}${inp('fee-adj-reason', t('原因(必填)'))}<button class="btn btn-outline btn-sm" style="align-self:flex-start;font-size:12px" onclick="window.dpFeeAdjust()">${t('记录更正(真人 Passkey)')}</button></div>`)}
    ${card(`<div style="font-size:13px;font-weight:700;margin-bottom:8px">↩️ ${t('退款(真实退还未消耗预付款)')}</div><div style="display:flex;flex-direction:column;gap:6px">${inp('fee-ref-amt', t('退款额 USDC'), true)}${meth('fee-ref-method')}${inp('fee-ref-ev', t('退款凭证号 evidence_ref(选填)'))}${inp('fee-ref-reason', t('原因(选填)'))}<button class="btn btn-outline btn-sm" style="align-self:flex-start;font-size:12px;color:#b45309;border-color:#fcd34d" onclick="window.dpFeeRefund()">${t('退款(真人 Passkey)')}</button></div>`)}
  `, 'admin')
}

window.dpFeeLoad = async function () {
  const sid = _dpFeeStr('fee-seller'); const box = document.getElementById('fee-acct'); if (!box) return
  if (!sid) { box.innerHTML = ''; return }
  const r = await GET('/admin/direct-receive/fee-account/' + encodeURIComponent(sid))
  if (!r || !r.account) { box.innerHTML = `<div class="alert alert-error">${t('加载失败')}</div>`; return }
  const a = r.account
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span style="color:#6b7280">${k}</span><span style="font-weight:600">${v}</span></div>`
  box.innerHTML = `<div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
    <div style="font-size:15px;font-weight:700;margin-bottom:6px">${t('可用预充值余额')}: <span style="color:${a.availableUnits < 0 ? '#dc2626' : '#059669'}">${_dpFeeFmt(a.availableUnits)}</span></div>
    ${row(t('累计预充值'), _dpFeeFmt(a.topupUnits))}
    ${row(t('已计提平台费'), _dpFeeFmt(a.accruedUnits))}
    ${row(t('账务更正合计'), _dpFeeFmt(a.adjustmentUnits))}
    ${row(t('已退款合计'), _dpFeeFmt(a.refundUnits))}
    ${row(t('在途单预估费'), _dpFeeFmt(a.openEstFeeUnits))}
    ${row(t('首单宽限'), a.graceEligible ? t('是(尚未成交)') : t('否(已用/有在途)'))}
  </div>`
}

async function _dpFeeAction(purpose, path, bind, extraBody, okMsg) {
  const token = await requestPasskeyGate(purpose, bind)
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(path, { ...bind, ...extraBody, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(okMsg)
  window.dpFeeLoad()
}

window.dpFeeTopup = function () {
  const seller_id = _dpFeeStr('fee-seller'); const amount_units = _dpFeeUnits('fee-topup-amt')
  if (!seller_id || !(amount_units > 0)) { if (typeof toast$ === 'function') toast$(t('请填写卖家 ID 和正数金额'), 'error'); return }
  const bind = { seller_id, amount_units, method: _dpFeeStr('fee-topup-method') || 'usdc', evidence_ref: _dpFeeStr('fee-topup-ev') }
  return _dpFeeAction('direct_pay_fee_prepay_record', '/admin/direct-receive/fee-prepay', bind, { note: _dpFeeStr('fee-topup-note') }, t('预充值已记录'))
}

window.dpFeeAdjust = function () {
  const seller_id = _dpFeeStr('fee-seller'); const delta_units = _dpFeeUnits('fee-adj-amt'); const reason = _dpFeeStr('fee-adj-reason')
  if (!seller_id || !Number.isFinite(delta_units) || delta_units === 0 || !reason) { if (typeof toast$ === 'function') toast$(t('请填写卖家 ID、非零更正额、原因'), 'error'); return }
  const bind = { seller_id, delta_units, reason }
  return _dpFeeAction('direct_pay_fee_adjust', '/admin/direct-receive/fee-adjust', bind, {}, t('账务更正已记录'))
}

window.dpFeeRefund = function () {
  const seller_id = _dpFeeStr('fee-seller'); const amount_units = _dpFeeUnits('fee-ref-amt')
  if (!seller_id || !(amount_units > 0)) { if (typeof toast$ === 'function') toast$(t('请填写卖家 ID 和正数退款额'), 'error'); return }
  const bind = { seller_id, amount_units, method: _dpFeeStr('fee-ref-method') || 'usdc', evidence_ref: _dpFeeStr('fee-ref-ev') }
  return _dpFeeAction('direct_pay_fee_refund', '/admin/direct-receive/fee-refund', bind, { reason: _dpFeeStr('fee-ref-reason') }, t('退款已记录'))
}
