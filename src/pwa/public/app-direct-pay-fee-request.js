// 平台服务费【预充值申请】—— 卖家侧 UI。看平台收款方式(据此线下付款)→ 填金额+凭据申请 → 看自己申请状态 → 撤销 pending。
//   申请【不动钱、不 Passkey】(申请不授予任何东西);真正入账由平台核实真实到账后确认。凭据必填 —— 杜绝"场外直接付、无据可查"。
//   面向用户中文走 t(),英文在 i18n.js;双语 parity 由 test-direct-pay-ui.ts 守。

window.dpFeeReqStatus = (s) => ({ pending: t('待审核'), approved: t('已入账'), rejected: t('已驳回'), cancelled: t('已撤销') }[s] || s)
// 金额(USDC 小数)→ base units(1 WAZ=1e6;正数、≤6 位小数)。非法 → NaN。
window.dpFeeReqUnits = (id) => {
  const e = document.getElementById(id); const raw = e ? e.value.trim() : ''
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) return NaN
  const [i, f = ''] = raw.split('.'); return Number(i) * 1e6 + Number((f + '000000').slice(0, 6))
}

window.dpFeeRequestSection = () => `
  <div class="card" style="margin-bottom:12px">
    <div style="font-size:14px;font-weight:700;margin-bottom:6px">➕ ${t('申请平台服务费预充值')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('按下列平台收款方式线下付款后,填金额和付款凭证号提交申请;平台核实真实到账后为你入账。申请本身不划扣任何款项。')}</div>
    <div id="dp-feereq-box">${loading$()}</div>
  </div>`

window.dpHydrateFeeRequest = async () => {
  const box = document.getElementById('dp-feereq-box'); if (!box) return
  const [accR, reqR] = await Promise.all([GET('/direct-receive/platform-receive-accounts'), GET('/direct-receive/fee-prepay-requests')])
  const accounts = (accR && accR.accounts) || []
  const requests = (reqR && reqR.requests) || []
  const acctList = accounts.length ? accounts.map(a => `
    <div style="border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;padding:8px 10px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px">
      <div style="min-width:0">
        <div style="font-size:12px;font-weight:700">${a.label ? escHtml(a.label) : (a.method ? escHtml(a.method) : t('平台收款方式'))}${a.currency ? ` · ${escHtml(a.currency)}` : ''}</div>
        <div style="font-size:12px;color:#374151;white-space:pre-wrap;word-break:break-word">${escHtml(a.instruction)}</div>
      </div>
      ${a.qr_data_uri ? `<img src="${a.qr_data_uri}" alt="${t('收款二维码')}" style="width:64px;height:64px;object-fit:contain;border-radius:6px;flex:0 0 auto">` : ''}
    </div>`).join('') : `<div style="font-size:12px;color:#9ca3af">${t('平台暂未配置收款方式,请联系平台')}</div>`
  const opts = accounts.map(a => `<option value="${escHtml(a.id)}">${a.label ? escHtml(a.label) : (a.method ? escHtml(a.method) : a.id)}${a.currency ? ` · ${escHtml(a.currency)}` : ''}</option>`).join('')
  const reqRows = requests.length ? requests.map(r => `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:6px 10px;margin-bottom:6px;font-size:12px">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <span><b>${(r.amount_units / 1e6).toFixed(2)}</b> ${escHtml(r.currency || 'USDC')} · <span style="color:#6b7280">${window.dpFeeReqStatus(r.status)}</span></span>
        ${r.status === 'pending' ? `<button class="btn btn-outline btn-sm" style="font-size:11px;padding:2px 8px" onclick="dpCancelFeeRequest('${r.id}')">${t('撤销')}</button>` : ''}
      </div>
      <div style="color:#9ca3af;margin-top:2px">${t('凭证')}: ${escHtml(r.evidence_ref)}${r.review_note ? ` · ${escHtml(r.review_note)}` : ''}</div>
    </div>`).join('') : `<div style="font-size:12px;color:#9ca3af">${t('暂无申请记录')}</div>`
  box.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">${t('平台收款方式(据此付款)')}</div>
    ${acctList}
    <div id="dp-feereq-msg" style="margin-top:8px"></div>
    <div class="form-group" style="margin-top:8px"><label class="form-label">${t('充值金额 USDC')}</label><input class="form-control" id="dp-feereq-amt" type="number" step="any" min="0" placeholder="${t('如 50')}"></div>
    ${accounts.length ? `<div class="form-group"><label class="form-label">${t('付给哪个平台收款方式')}</label><select class="form-control" id="dp-feereq-acct">${opts}</select></div>` : ''}
    <div class="form-group"><label class="form-label">${t('付款凭证号 evidence_ref')} <span style="color:#dc2626">*</span> <span style="font-size:11px;color:#9ca3af">${t('(转账流水号 / 交易 ID,必填)')}</span></label><input class="form-control" id="dp-feereq-ev" maxlength="200" placeholder="${t('如银行流水号 / 链上 txid')}"></div>
    <div class="form-group"><label class="form-label">${t('备注(可选)')}</label><input class="form-control" id="dp-feereq-note" maxlength="500"></div>
    <button class="btn btn-primary btn-sm" onclick="dpSubmitFeeRequest()">${t('提交申请')}</button>
    <div style="font-size:12px;font-weight:600;color:#374151;margin:14px 0 4px">${t('我的申请')}</div>
    ${reqRows}`
}

window.dpSubmitFeeRequest = async () => {
  const msg = document.getElementById('dp-feereq-msg')
  const show = (type, m) => { if (msg) msg.innerHTML = alert$(type, m); else if (typeof toast$ === 'function') toast$(m, type) }
  const amount_units = window.dpFeeReqUnits('dp-feereq-amt')
  if (!(amount_units > 0)) { show('error', t('请填写正数充值金额')); return }
  const evidence_ref = document.getElementById('dp-feereq-ev')?.value?.trim() || ''
  if (!evidence_ref) { show('error', t('付款凭证号必填(不能无据)')); return }
  const platform_account_id = document.getElementById('dp-feereq-acct')?.value || null
  const evidence_note = document.getElementById('dp-feereq-note')?.value?.trim() || null
  const r = await POST('/direct-receive/fee-prepay-request', { amount_units, platform_account_id, evidence_ref, evidence_note })
  if (r.error) { show('error', r.error || t('提交失败,请重试')); return }
  if (typeof toast$ === 'function') toast$(t('申请已提交,等待平台核实入账'), 'success')
  window.dpHydrateFeeRequest()
}

window.dpCancelFeeRequest = async (id) => {
  const go = await confirmModal(t('确定撤销这条预充值申请?'), t('撤销'), { danger: true })
  if (!go) return
  const r = await POST('/direct-receive/fee-prepay-request/' + id + '/cancel', {})
  if (r.error) { if (typeof toast$ === 'function') toast$(r.error, 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已撤销'), 'success'); window.dpHydrateFeeRequest()
}
