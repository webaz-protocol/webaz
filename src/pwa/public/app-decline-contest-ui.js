// 统一仲裁台 · decline_contest(拒单举证仲裁)前端渲染 + 待办角标。
//   app.js / app-arbitrator-admin.js 都在 LOC ceiling 上(零余量),故所有渲染逻辑集中在此(非 pinned 域文件),
//   pinned 文件侧只做 net-zero 的 window.* 调用。全局(t / GET / state)由 app.js 等 classic script 提供,运行时已就绪。
(function () {
  var isDC = function (d) { return d && d.dispute_type === 'decline_contest' }

  // ① 列表行类型徽章(紫色 = 仲裁色系,镜像现有 arbitration chip)。
  window.dcChip = function (d) {
    return isDC(d)
      ? '<span style="display:inline-flex;align-items:center;gap:3px;background:#faf5ff;color:#6b21a8;padding:0 6px;border-radius:99px;font-size:10px;font-weight:600;margin-right:5px">⚖ ' + t('拒单举证仲裁') + '</span>'
      : ''
  }

  // ② 详情页:PR3 打通专用裁决前,decline_contest 的裁决通道 fail-closed —— 用只读提示卡【替代】裁决表单(不显示会 409 的按钮)。
  window.dcNotice = function (dispute) {
    return '' +
      '<div class="card" style="margin-top:12px;border:1px solid #e9d5ff;background:#faf5ff;border-radius:8px;padding:12px">' +
        '<div style="font-weight:600;font-size:13px;color:#6b21a8;margin-bottom:4px">⚖ ' + t('拒单举证仲裁') + '</div>' +
        '<div style="font-size:12px;color:#6b7280;line-height:1.6">' + t('卖家主张客观无责并已举证。裁决通道即将开放——届时可裁定:维持无责(全退买家+退卖家质押)或驳回(判卖家违约)。') + '</div>' +
        '<div style="font-size:12px;color:#9ca3af;margin-top:6px">⏳ ' + t('裁决通道即将开放') + '</div>' +
      '</div>'
  }

  // ③ 待办角标:拉 pending-count → 写 state.arbPending → 就地刷新 .arb-badge(不整页重渲染,镜像 chats-badge 的 updateAggregate)。
  window.refreshArbBadge = async function () {
    try {
      if (!(window.state && window.state.canArbitrate)) return
      var r = await GET('/arbitrator/pending-count')
      window.state.arbPending = (r && typeof r.count === 'number') ? r.count : 0
      var n = window.state.arbPending
      document.querySelectorAll('.arb-badge').forEach(function (b) {
        b.textContent = n > 0 ? n : ''
        b.style.display = n > 0 ? 'inline' : 'none'
      })
    } catch (e) { /* 角标非关键,静默 */ }
  }

  // ④ 双语通知模板(app-notif-templates.js 在 ceiling 上,故在此运行时挂载;title 约定「emoji+空格」开头 → 列表当图标)。
  if (window.NOTIF_TEMPLATES) {
    window.NOTIF_TEMPLATES['arb_decline_contest_new'] = function () {
      return { title: '⚖ ' + t('新的拒单举证仲裁待处理'), body: t('一笔卖家客观拒单举证已进入统一仲裁台,等待仲裁员裁决。') }
    }
  }
})()
