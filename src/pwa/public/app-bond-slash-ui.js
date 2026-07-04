// 保证金罚没 UI(B3)。UI ONLY —— 口径校验/冷静期/幂等全在后端。人工铁律:提案→冷静期→ROOT+Passkey 执行。
//   注入:卖家卡 bondSlashNotice(s)(app-bond-ui 净零 hook);admin 队列页追加提案区(包装 bondAdmHydrate)。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), p) })
  Object.assign(window.NOTIF_TEMPLATES, {
    bond_slash_proposed: P('⚠️', '保证金罚没提案(待复核)', '因争议 {dispute} 裁定卖家责任,平台已发起保证金罚没提案。冷静期 {days} 天内如有异议请联系平台并提供依据;冷静期满后将复核执行(全额罚没,进入处罚金专户,平台不获益)。'),
    bond_slash_cancelled: P('✅', '保证金罚没提案已撤销', '此前的罚没提案经复核已撤销,你的保证金不受影响。'),
    bond_slash_executed: P('❌', '保证金已罚没', '依据争议 {dispute} 的卖家责任裁定,你的履约保证金已全额罚没(进入处罚金专户,平台不获益),直付资格已吊销。重新缴纳保证金并通过审核后可再次申请开通。'),
  })

  // 卖家卡:待复核提案警示(冷静期=申诉窗)
  window.bondSlashNotice = (s) => {
    const p = s.pending_slash
    if (!p) return ''
    return `<div style="margin-top:8px;padding:8px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:12px;color:#991b1b">
      ⚠️ ${t('保证金罚没提案待复核')}:${t('依据争议')} ${escHtml(p.dispute_id)}${p.reason ? ` · ${escHtml(p.reason)}` : ''}<br>
      ${t('冷静期至')} ${fmtTime(p.cooling_until)} —— ${t('如有异议请在此期间联系平台并提供依据。')}</div>`
  }

  // admin:队列页追加"罚没提案"区(包装既有 hydrate;容器自建,不动 capped 文件)
  const _origHydrate = window.bondAdmHydrate
  window.bondAdmHydrate = async (status) => {
    await _origHydrate(status)
    const box = document.getElementById('bond-adm-box'); if (!box) return
    let sec = document.getElementById('bond-slash-sec')
    if (!sec) { box.insertAdjacentHTML('afterend', `<div id="bond-slash-sec" style="margin-top:16px"></div>`); sec = document.getElementById('bond-slash-sec') }
    const r = await GET('/admin/direct-receive/bond-slash').catch(() => null)
    const items = (r && r.proposals) || []
    sec.innerHTML = `<h2 style="font-size:15px;font-weight:700;margin-bottom:8px">⚖️ ${t('罚没提案')}(${t('人工铁律:提案→冷静期→Passkey 执行,绝不自动')})</h2>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px">${t('仅「仲裁裁定卖家责的直付争议」可提案(refund_buyer / partial_refund);v1 全额罚没,进处罚金专户(只进不出),平台不获益。对 locked 行用下方表单提案。')}</div>
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
        <input class="form-control" id="bslash-dep" placeholder="${t('deposit_id')}" style="flex:1;min-width:120px;font-size:12px">
        <input class="form-control" id="bslash-dsp" placeholder="${t('依据 dispute_id')}" style="flex:1;min-width:120px;font-size:12px">
        <input class="form-control" id="bslash-note" placeholder="${t('说明(卖家可见,可选)')}" style="flex:2;min-width:160px;font-size:12px">
        <button class="btn btn-outline btn-sm" style="width:auto;font-size:11px" onclick="bondSlashPropose()">${t('发起提案')}</button>
      </div>
      ${items.length === 0 ? `<div class="alert alert-info">${t('暂无罚没提案')}</div>` : items.map(p => `
      <div class="card" style="font-size:12px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><strong>${escHtml(p.seller_name || p.seller_id)}</strong> · ${t('依据争议')} ${escHtml(p.dispute_id)} · ${t('存款')} ${escHtml(p.deposit_id)}</div>
          <div><strong>${({ proposed: t('待执行(冷静期)'), executed: t('已执行'), cancelled: t('已撤销') })[p.status] || p.status}</strong></div>
        </div>
        <div style="color:#6b7280;margin-top:4px">${p.reason ? escHtml(p.reason) + ' · ' : ''}${t('冷静期至')} ${fmtTime(p.cooling_until)} · ${fmtTime(p.proposed_at)}</div>
        ${p.status === 'proposed' ? `<div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-primary btn-sm" style="width:auto;font-size:11px" onclick="bondSlashExecute('${p.id}')">${t('执行罚没(Passkey;冷静期未满会被拒)')}</button>
          <button class="btn btn-outline btn-sm" style="width:auto;font-size:11px" onclick="bondSlashCancel('${p.id}')">${t('撤销提案')}</button>
        </div>` : ''}
      </div>`).join('')}`
  }
  window.bondSlashPropose = async () => {
    const dep = (document.getElementById('bslash-dep')?.value || '').trim()
    const dsp = (document.getElementById('bslash-dsp')?.value || '').trim()
    if (!dep || !dsp) return void toast$(t('须提供 deposit_id 与依据 dispute_id'), 'error')
    const r = await POST('/admin/direct-receive/bond-slash/propose', { deposit_id: dep, dispute_id: dsp, reason: (document.getElementById('bslash-note')?.value || '').trim() || undefined })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('提案已发起,卖家已通知(冷静期=申诉窗)'), 'success'); window.bondAdmHydrate()
  }
  window.bondSlashExecute = async (id) => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认执行罚没?保证金将全额进入处罚金专户(不可逆),卖家直付资格吊销。'), t('执行罚没'), { danger: true }))) return
    let token
    try { token = await requestPasskeyGate('direct_pay_bond_slash', { proposal_id: id }) }
    catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
    const r = await POST(`/admin/direct-receive/bond-slash/${id}/execute`, { webauthn_token: token })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('罚没已执行,卖家已通知'), 'success'); window.bondAdmHydrate()
  }
  window.bondSlashCancel = async (id) => {
    const note = prompt(t('撤销说明(卖家可见,可空)'), '') ?? ''
    const r = await POST(`/admin/direct-receive/bond-slash/${id}/cancel`, { note })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('提案已撤销'), 'success'); window.bondAdmHydrate()
  }
})()
