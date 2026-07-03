// 共建运营 admin hub —— 把散落在主 admin 面板的「共建(社区建设)」功能归到一处。UI ONLY,只链接既有路由,
//   不改任何后端/权限(每个子页自身的鉴权不变)。镜像 Direct Pay 商户运营 hub 的结构。
//   分区:共建建议收件箱(全 admin) / 建任务治理(root) / 贡献账号归属(自助 + root 审批)。中文 t(),英文 i18n.js _EN。

window.renderAdminContributionHub = function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  const root = (state.user.admin_type || 'root') === 'root'
  const grp = (title, cards) => `<div style="font-size:13px;font-weight:700;color:#374151;margin:14px 0 6px">${title}</div>${cards}`
  app.innerHTML = shell(`
    <h1 class="page-title">🌱 ${t('共建运营')}</h1>
    <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin/protocol')">${t('返回协议管理')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:6px">${t('共建(社区建设)集中入口:外部建议收件箱、建任务治理、贡献账号归属。')}</div>
    ${grp(t('共建建议(收件箱)'),
      adminLinkCard('🛠️', t('任务建议收件箱'), t('陌生人 / agent 提交的共建任务建议;审阅 → 转正式任务'), '#admin/task-proposals') +
      adminLinkCard('📨', t('Welcome 提交'), t('#welcome 留下的邮箱订阅 + 建议'), '#admin/public-ideas'))}
    ${root ? grp(t('建任务治理'),
      adminLinkCard('🎟️', t('建任务额度审核'), t('非根管理员的建任务扩容申请;批准 = 限时计数授权(仅 root)'), '#admin/quota-requests')) : ''}
    ${grp(t('贡献账号归属'),
      adminLinkCard('🔗', t('关联个人贡献账号'), t('把本管理席位的协调贡献归属到你的真实个人账号(需对方确认 + root 审批)'), '#me/operator-claims') +
      (root ? adminLinkCard('🪪', t('操作席位关联审批'), t('管理席位→个人贡献账号的关联申请;确认 + 审批 / 撤销(仅 root)'), '#admin/operator-claims') : ''))}
  `, 'admin')
}
