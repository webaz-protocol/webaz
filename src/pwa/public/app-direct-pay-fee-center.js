// Direct Pay (Rail 1) — SELLER 平台服务费账户 section(PR-C)。UI ONLY。
//   卖家自查【本人】平台服务费预充值余额 / 已计提 / 退款 / 在途预估 / 首单宽限。
//   数据来自 GET /api/direct-receive/my-fee-account(requireSeller,仅本人;买家侧不展示)。
//   预充值 = 商家平台服务费预付款(非买家货款 / 非 escrow / 非保证金);充值由平台核实收款后由 admin 登记,卖家不自助。
//   纯读;不碰 wallet/escrow/settlement/refund/钱路。section 形态,嵌入卖家「设置」子页(与 readiness/缓交/验证/收款说明并列)。

function _dpFeeFmt2(u) { return (Number(u || 0) / 1e6).toFixed(6).replace(/\.?0+$/, '') + ' USDC' }

window.dpSellerFeeSection = () => `
  <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
    <div style="font-size:14px;font-weight:700;margin-bottom:4px">💰 ${t('平台服务费账户(仅你可见)')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('直付平台服务费的预充值余额与已计提明细;预充值由平台核实收款后登记,如需充值请联系平台。')}</div>
    <div id="dp-seller-fee">${typeof loading$ === 'function' ? loading$() : ''}</div>
  </div>`

window.dpHydrateSellerFee = async () => {
  const box = document.getElementById('dp-seller-fee')
  if (!box) return
  const r = await GET('/direct-receive/my-fee-account')
  if (!r || r.error || !r.account) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试')}</div>`; return }
  const a = r.account
  const owed = Number(a.availableUnits) < 0
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span style="color:#6b7280">${k}</span><span style="font-weight:600">${v}</span></div>`
  box.innerHTML = `
    <div style="font-size:15px;font-weight:700;margin-bottom:6px">${owed ? t('待补平台服务费') : t('可用预充值余额')}: <span style="color:${owed ? '#dc2626' : '#059669'}">${_dpFeeFmt2(Math.abs(Number(a.availableUnits)))}</span></div>
    ${owed ? `<div style="font-size:12px;color:#b45309;line-height:1.6;margin-bottom:6px">${t('余额不足时新直付订单会被暂停,请联系平台补充平台服务费预充值。')}</div>` : ''}
    ${row(t('累计预充值'), _dpFeeFmt2(a.topupUnits))}
    ${row(t('已计提平台费'), _dpFeeFmt2(a.accruedUnits))}
    ${Number(a.adjustmentUnits) !== 0 ? row(t('账务更正合计'), _dpFeeFmt2(a.adjustmentUnits)) : ''}
    ${row(t('已退款合计'), _dpFeeFmt2(a.refundUnits))}
    ${row(t('在途单预估费'), _dpFeeFmt2(a.openEstFeeUnits))}
    ${a.graceEligible ? `<div style="font-size:12px;color:#059669;margin-top:6px">${t('首单宽限可用:你的第一笔直付无需预充值。')}</div>` : ''}`
}
