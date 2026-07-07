// 统一仲裁台 · decline_contest 裁决 UI(PR3)。与 app-decline-contest-ui.js(PR2,已达 ceiling)分开新建。
//   仲裁员两选裁决表单 + admin 兜底裁决 + 升级/落定通知模板。全局(t/GET/POST/state/handleArbitrate/requestPasskeyGate)运行时就绪。
(function () {
  // 仲裁员两选裁决表单。复用 window.handleArbitrate —— radio name/reason id/msg id 与通用裁决一致,提交 POST /api/disputes/:id/arbitrate,
  //   后端按 dispute_type 分流到唯一 resolver(dispute CAS + COI + assignment + 终态 completed + 结算,单事务)。
  window.dcRulingForm = function (dispute) {
    var radio = function (val, label) {
      return '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid #e9d5ff;border-radius:6px;cursor:pointer;font-size:13px"><input type="radio" name="arb-ruling-radio" value="' + val + '" style="margin-top:2px"> <span>' + label + '</span></label>'
    }
    return '' +
      '<div style="margin-top:12px;border:1px solid #e9d5ff;background:#faf5ff;border-radius:8px;padding:12px">' +
        '<div style="font-weight:600;font-size:13px;color:#6b21a8;margin-bottom:8px">⚖ ' + t('拒单举证仲裁裁决') + '</div>' +
        '<div id="arbitrate-msg"></div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px">' +
          radio('decline_no_fault_upheld', t('维持无责 —— 全退买家 + 退卖家质押,零罚没')) +
          radio('decline_fault_confirmed', t('驳回举证,判卖家违约 —— 退款买家 + 罚没质押')) +
        '</div>' +
        '<textarea class="form-control" id="arb-reason" rows="3" placeholder="' + t('裁定理由(必填)') + '" style="width:100%;margin-bottom:8px"></textarea>' +
        '<button class="btn btn-primary btn-sm" style="width:auto" onclick="handleArbitrate(\'' + dispute.id + '\')">' + t('确认裁定') + '</button>' +
      '</div>'
  }

  // admin 兜底裁决(管理面)。仅 decline_contest 且仲裁窗口(arbitrate_deadline)已过时给按钮;窗口未过后端 FALLBACK_TOO_EARLY。
  window.dcAdminResolveBtn = function (d) {
    if (!d || d.dispute_type !== 'decline_contest' || !d.arbitrate_deadline) return ''
    if (new Date().toISOString() <= d.arbitrate_deadline) return ''   // 仲裁员优先:窗口内不给 admin 兜底入口
    var b = function (dec, label, bg) { return '<button class="btn btn-sm" style="width:auto;background:' + bg + ';color:#fff;font-size:12px" onclick="dcAdminResolve(\'' + d.id + '\',\'' + dec + '\')">' + label + '</button>' }
    return '<div style="display:flex;gap:6px;margin-top:6px">🛡️ ' + b('decline_no_fault_upheld', t('兜底·维持无责'), '#16a34a') + b('decline_fault_confirmed', t('兜底·判违约'), '#dc2626') + '</div>'
  }
  window.dcAdminResolve = async function (disputeId, decision) {
    var reason = window.prompt(t('裁定理由(必填)'))
    if (!reason || !reason.trim()) return
    var tk
    try { tk = await requestPasskeyGate('arbitrate', { dispute_id: disputeId, action: 'decline_contest_resolve', decision: decision }) }
    catch (e) { window.alert(t('此操作需现场真人 Passkey 验证')); return }
    var res = await POST('/admin/disputes/' + disputeId + '/decline-contest-resolve', { decision: decision, reason: reason, webauthn_token: tk })
    if (res && res.error) { window.alert(res.error); return }
    window.alert(t('裁决已执行'))
    if (typeof renderAdminDisputes === 'function') renderAdminDisputes(document.getElementById('app'), {})
  }

  // 双语通知模板(升级 + 落定);运行时挂载到 NOTIF_TEMPLATES。
  if (window.NOTIF_TEMPLATES) {
    window.NOTIF_TEMPLATES['arb_decline_contest_escalated'] = function () {
      return { title: '⏰ ' + t('拒单举证仲裁已超时,请尽快裁决'), body: t('一笔拒单举证仲裁已过仲裁窗口仍未裁决,已进入 admin 兜底窗口 —— 请尽快处理,否则将自动判卖家违约。') }
    }
    window.NOTIF_TEMPLATES['arb_decline_contest_resolved'] = function (p) {
      var upheld = p && p.decision === 'decline_no_fault_upheld'
      return { title: (upheld ? '✅ ' : '⚖ ') + (upheld ? t('拒单举证仲裁:维持无责') : t('拒单举证仲裁:驳回,判卖家违约')),
        body: upheld ? t('仲裁认定卖家客观无责:买家已全额退款,卖家质押已退回,无罚没。订单已结。') : t('仲裁驳回卖家举证,判卖家违约:买家已退款,卖家质押按违约处置。订单已结。') }
    }
  }
})()
