// WebAZ — Account Settings domain (classic multi-script split, slice H / app-account.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// Top-level functions / window.* handlers are global; pages run on route/click
// (after app.js loads), so cross-file globals (GET/POST/PATCH/DELETE/state/shell/
// escHtml/navigate/t/toast$/confirmModal/requireApiKeyPassword/openPasswordPromptModal/
// toggleApiKey/copyApiKey/switchRole/addRole/doRequestPersist/isAdmin/persistApiKey/
// renderLogin/...) resolve at call time. No import/export.
//
// Pure relocation of the #me/settings + #me/advanced surfaces: renderProfile (the
// settings page), renderMyAdvanced, the renderMySettings alias, Passkey-LIST UI
// actions (refreshPasskeyList/doAddPasskey/doDeletePasskey/doToggleWebAuthnRequired),
// and the profile-edit handlers (handle/name/social/feed-visibility/block/unblock/
// default-address/email-bind).
//
// INTENTIONALLY LEFT IN app.js (called cross-file): the auth-boot / sensitive
// layer — bootAuth, renderLogin/renderRecover, doLogin/doRegister, persistApiKey/
// clearPersistedApiKey, the WebAuthn gate helpers, and the SHARED sensitive
// helpers confirmModal / requireApiKeyPassword / openPasswordPromptModal (also used
// by wallet/reveal-key), doRequestPersist, the api-key visibility + password-modal +
// role middle-zone (apiKeyVisible/toggleApiKey/copyApiKey/switchRole/addRole), and
// useKey. No money/order/payment/wallet/status path. No UI/behavior change.

// ─── 个人资料 & 设置 ──────────────────────────────────────────

// 2026-05-24 重命名 #profile → #me/settings 的 alias；保留 renderProfile 名供旧路径兼容
async function renderMySettings(app) { return renderProfile(app) }

// 2026-05-24 高级 sub-tab：Agent / Skill / Timeline / Webhook / 治理（聚合协议级深度工具）
async function renderMyAdvanced(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const role = state.user.role
  const isTrusted = ['admin', 'verifier', 'logistics', 'arbitrator'].includes(role)
  const [agentRes, skillsRes, ocRes] = await Promise.all([
    GET('/agents/me/reputation').catch(() => null),
    GET('/skills/mine').catch(() => []),
    GET('/me/operator-claims').catch(() => null),
  ])
  const trustScore = Math.round(agentRes?.trust_score || 0)
  const level = agentRes?.level || 'new'
  const lvlColor = { legend: '#dc2626', quality: '#9333ea', trusted: '#4f46e5', new: '#9ca3af' }[level] || '#6b7280'
  const skillCount = (Array.isArray(skillsRes) ? skillsRes : []).length
  // 贡献归属入口:admin 常驻;普通用户仅当确有 operator-claim 关系(pending/active/history)时才显示,保持清爽
  const hasOperatorClaim = !!(ocRes && Array.isArray(ocRes.relationships) && ocRes.relationships.length)

  const card = (icon, label, sub, hash) => `
    <div class="card" onclick="location.hash='${hash}'" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px">
      <div style="font-size:24px;flex-shrink:0">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px">${label}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${sub}</div>` : ''}
      </div>
      <div style="color:#9ca3af">›</div>
    </div>`

  const heroAgent = `
    <div class="card" style="padding:14px;margin-bottom:14px;background:linear-gradient(135deg,#eef2ff,#faf5ff);border:1px solid #c7d2fe">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:32px">🤖</div>
        <div style="flex:1">
          <div style="font-size:13px;color:#6b7280">${t('我的 Agent 等级')}</div>
          <div style="font-size:22px;font-weight:800;color:${lvlColor}">${trustScore} <span style="font-size:11px;color:#6b7280">trust</span> · ${level}</div>
        </div>
        <a href="#my-agents" style="font-size:12px;color:#4f46e5;text-decoration:none;white-space:nowrap">${t('详情')} ›</a>
      </div>
    </div>
  `

  const sections = `
    ${mySubTabsHTML('advanced')}
    <h2 style="font-size:18px;font-weight:700;margin-bottom:12px">🚀 ${t('高级')}</h2>
    ${heroAgent}

    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🤖 ${t('Agent 治理')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🤖', t('我的 agents'), t('谁替我做事 · 撤销控制'), '#my-agents')}
      ${card('⚡', t('卖家自动化'), skillCount > 0 ? skillCount + ' ' + t('个') : t('未发布'), '#skills')}
      ${!isTrusted ? card('🪄', t('AI 推荐'), t('给我推商品'), '#ai-recommend') : ''}
      ${role === 'seller' ? card('🎯', t('Auto-bid'), t('RFQ 自动报价'), '#auto-bid') : ''}
    </div>

    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">📜 ${t('Webhook / Timeline')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📜', t('Timeline'), t('全部事件按时间排列'), '#me/timeline')}
      ${card('📡', t('Webhook'), t('订阅事件 push 到外部端点'), '#me/webhooks')}
      ${(role === 'admin' || hasOperatorClaim) ? card('🪪', t('贡献归属'), t('待确认的 admin 关联 / 关联记录'), '#me/operator-claims') : ''}
    </div>

    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🧠 ${t('技能市场')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🧠', t('技能市场'), t('发布 / 购买知识技能'), '#skill-market')}
      ${card('📚', t('我的技能库'), t('已购买的技能'), '#skill-market/library')}
    </div>

    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🏛 ${t('协议参与')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🏛', t('协议治理'), t('参数公开 · 变更可追溯'), '#governance')}
      ${card('⚖', t('判例库'), t('争议判决公开'), '#judgments')}
      ${card('🛠', t('我的共建'), t('贡献 / GitHub 认领 / 建设信誉 — 无购买门槛'), '#my-contributions')}
      ${card('📋', t('公开共建任务'), t('浏览可认领任务、提交建议、参与共建'), '#contribute/tasks')}
      ${card('🎁', t('分享分润管理'), t('分享佣金 / PV / escrow · 经济关系登记'), '#rewards-me')}
    </div>

    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">📧 ${t('联系我们')}</div>
    <a href="mailto:contact@webaz.xyz" class="card" style="padding:14px;display:flex;align-items:center;gap:10px;min-height:64px;text-decoration:none;color:inherit">
      <div style="font-size:24px;flex-shrink:0">📧</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px">contact@webaz.xyz</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t('合作 / 反馈 / 合规咨询')}</div>
      </div>
      <div style="color:#9ca3af">›</div>
    </a>
  `
  app.innerHTML = shell(sections, 'me')
}

async function renderProfile(app) {
  if (state.apiKey && !state.user) { const me = await GET('/me'); if (!me.error) state.user = me } app.innerHTML = shell(loading$(), 'me')   // 自愈(修"切角色/改密后假登出"):switchRole/addRole/set-password 置空 state.user 后绕过 render() 路由直调本函数,shell 曾画成未登录(header 变登录钮/底栏错乱,不自愈) → 先权威重取再画
  const [data, blocklist] = await Promise.all([
    GET('/profile'),
    GET('/blocklist/me').catch(() => ({ blocked: [] })),
  ])
  if (data.error) return void (app.innerHTML = shell(alert$('error', data.error), 'me'))

  const roles = data.roles || [data.role]
  // 自助可加角色 = 只有 buyer/seller；其余需走申请流程；admin 不显示
  const SELF_SERVE_ROLES = ['buyer', 'seller']
  const APPLY_ROLES      = ['verifier', 'logistics', 'arbitrator']
  const allRoles  = [...SELF_SERVE_ROLES, ...APPLY_ROLES]
  const roleLabels = { buyer: t('买家'), seller: t('卖家'), logistics: t('物流'), arbitrator: t('仲裁员'), verifier: t('审核员'), admin: t('管理员') }
  const roleIcons  = { buyer: '🛍️', seller: '🏪', logistics: '🚚', arbitrator: '⚖️', verifier: '🔍', admin: '🛡' }
  const addable = allRoles.filter(r => !roles.includes(r))
  // 受信角色：admin / verifier / logistics / arbitrator — 隐藏交易/社交相关 UI
  const TRUSTED_ROLES = ['admin', 'verifier', 'logistics', 'arbitrator']
  const isTrustedRole = TRUSTED_ROLES.includes(data.role) || roles.some(r => ['admin','verifier'].includes(r))
  // 受信角色显示的"已有角色" chip 只展示受信角色（隐藏 buyer/seller，即使账户有遗留多角色）
  const visibleRoles = isTrustedRole ? roles.filter(r => TRUSTED_ROLES.includes(r)) : roles

  app.innerHTML = shell(`
    ${mySubTabsHTML('settings')}
    <div class="page-header"><h2>${t('👤 个人资料 & 设置')}</h2></div>
    <div id="profile-msg"></div>

    <!-- 账户（昵称 ✏️ + API Key）-->
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">👤 ${t('账户')}</div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:4px">${t('昵称')}</div>
        <div id="nick-view" style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <div style="font-size:18px;font-weight:600;flex:1;min-width:0;word-break:break-word">${escHtml(data.name)}</div>
          <button onclick="toggleNickEdit(true)" title="${t('修改昵称')}" style="background:none;border:none;cursor:pointer;font-size:16px;padding:4px 6px;border-radius:6px;color:#6366f1">✏️</button>
        </div>
        <div id="nick-edit" style="display:none;margin-bottom:14px">
          <div style="display:flex;gap:6px">
            <input class="form-control" id="new-name-inp" placeholder="${t('输入新昵称')}" style="flex:1;font-size:14px" value="${escHtml(data.name)}" maxlength="40">
            <button class="btn btn-primary btn-sm" style="white-space:nowrap;padding:6px 12px" onclick="doChangeName()">${t('保存')}</button>
            <button class="btn btn-outline btn-sm" style="white-space:nowrap;padding:6px 10px" onclick="toggleNickEdit(false)">${t('取消')}</button>
          </div>
          <p style="font-size:11px;color:#9ca3af;margin-top:4px">${t('昵称可重复，1–40 字符（公开身份请用下方用户名）')}</p>
          <div id="change-name-msg" style="margin-top:6px"></div>
        </div>

        <!-- 用户名 @handle -->
        <div style="font-size:13px;color:#6b7280;margin-bottom:4px">${t('用户名')} <span style="color:#9ca3af;font-size:11px">${t('（公开唯一标识，7 天可改 1 次）')}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <div style="flex:1;min-width:0;font-size:15px;font-weight:500;color:#3730a3;word-break:break-all">@${escHtml(data.handle || '—')}</div>
          <button class="btn btn-outline btn-sm" onclick="openChangeHandleModal()" style="white-space:nowrap;font-size:11px;padding:5px 10px">${t('修改')}</button>
        </div>

        <!-- 永久分享推荐码 — 受信角色不展示（无分享/邀请需求）-->
        ${!isTrustedRole ? `
        <div style="font-size:13px;color:#6b7280;margin-bottom:4px">${t('永久分享推荐码')} <span style="color:#9ca3af;font-size:11px">${t('（不可改，用于邀请链 / agent 引用等）')}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <code style="background:#fef3c7;color:#78350f;padding:6px 14px;border-radius:6px;font-size:18px;font-weight:700;letter-spacing:2px;font-family:monospace">${escHtml(data.permanent_code || '—')}</code>
          <button class="btn btn-outline btn-sm" onclick="copyText('${escHtml(data.permanent_code || '')}').then(ok=>toast$(ok?t('已复制'):t('复制失败，请手动复制'),ok?'success':'error'))" style="white-space:nowrap;font-size:11px;padding:5px 10px">${t('复制')}</button>
        </div>` : ''}

        <div style="font-size:13px;color:#6b7280;margin-bottom:4px">API Key <span style="color:#9ca3af;font-size:11px">${t('（你的唯一身份凭证，请妥善保管）')}</span></div>
        <div style="display:flex;align-items:center;gap:6px">
          <code id="apikey-display" style="background:#f3f4f6;padding:6px 10px;border-radius:6px;font-size:12px;flex:1;word-break:break-all;filter:blur(4px);user-select:none">${data.api_key}</code>
          <button class="btn btn-outline btn-sm" onclick="toggleApiKey()" id="btn-reveal" style="white-space:nowrap;font-size:11px;padding:5px 10px">${t('显示')}</button>
          <button class="btn btn-outline btn-sm" onclick="copyApiKey('${data.api_key}')" style="white-space:nowrap;font-size:11px;padding:5px 10px">${t('复制')}</button>
        </div>
      </div>
    </div>

    <!-- 2026-05-24：删钱包卡 — 与面板首行 (#me 第 1 个 tile) 重复 -->

    <!-- 角色管理 -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">🎭 ${t('角色管理')}</div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:8px">${t('已有角色')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
          ${visibleRoles.map(r => `
            <button onclick="switchRole('${r}', this)" style="
              display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;cursor:pointer;border:2px solid;
              ${r === data.role ? 'background:#eff6ff;border-color:#3b82f6;color:#1d4ed8;font-weight:600' : 'background:#f9fafb;border-color:#e5e7eb;color:#374151'}
            " title="${r === data.role ? t('当前激活') : t('点击切换')}">
              ${roleIcons[r]} ${roleLabels[r]}
              ${r === data.role ? `<span style="font-size:11px;color:#3b82f6">${t('● 激活')}</span>` : ''}
            </button>
          `).join('')}
        </div>

        ${roles.some(r => ['admin','verifier'].includes(r)) ? `
          <!-- 受信角色锁：不展示添加按钮 + 明示理由 -->
          <div style="padding:12px 14px;background:#fef9c3;border:1px solid #fde047;border-radius:8px;font-size:12px;color:#78350f;line-height:1.6">
            🔒 <strong>${t('受信角色身份锁定')}</strong><br>
            ${t('权责分离原则：管理员 / 审核员不能自助添加 buyer / seller 等其他身份，避免利益冲突（如自卖自买、自审自核）。如需购买或销售，请用其他账号注册。')}
          </div>
        ` : addable.length > 0 ? `
          <div style="font-size:13px;color:#6b7280;margin-bottom:8px">${t('添加新角色')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            ${addable.filter(r => SELF_SERVE_ROLES.includes(r)).map(r => `
              <button onclick="addRole('${r}', this)" style="
                display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;cursor:pointer;
                background:#f9fafb;border:2px dashed #d1d5db;color:#6b7280
              ">${roleIcons[r]} + ${roleLabels[r]}</button>
            `).join('')}
          </div>
          ${addable.filter(r => APPLY_ROLES.includes(r)).length > 0 ? `
            <div style="font-size:13px;color:#6b7280;margin:12px 0 6px">${t('需通过申请获得')}</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              ${addable.filter(r => APPLY_ROLES.includes(r)).map(r => {
                if (r === 'verifier') {
                  return `<button onclick="navigate('#apply-verifier')" style="
                    display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;cursor:pointer;
                    background:#eef2ff;border:2px solid #6366f1;color:#4338ca
                  ">${roleIcons[r]} 📥 ${t('申请')} ${roleLabels[r]}</button>`
                }
                return `<button disabled title="${t('请联系管理员申请此角色')}" style="
                  display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;cursor:not-allowed;
                  background:#f9fafb;border:2px solid #e5e7eb;color:#9ca3af
                ">${roleIcons[r]} 🔒 ${roleLabels[r]} <span style="font-size:11px">(${t('联系管理员')})</span></button>`
              }).join('')}
            </div>
          ` : ''}
        ` : `<div style="font-size:13px;color:#6b7280">${t('已拥有全部可自助角色')}</div>`}
      </div>
    </div>

    <!-- 2026-05-24 社交资料/我的分享 入口移除 — Dashboard "👁 公开主页" tile 已覆盖（同 #u/:id 目标）-->

    <!-- M7.2.7：A2 黑名单 — 降权到次要位置，默认折叠（卡片放在偏好之后，作为辅助管理项）-->
    <!-- 内容下移见下方 -->


    <!-- 默认配送地址 — 受信角色不展示（无下单需求） -->
    ${!isTrustedRole ? `
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">📦 ${t('默认配送地址')}</div>
            <a href="#addresses" style="font-size:10px;color:#6366f1;text-decoration:none">📍 ${t('地址簿（多地址管理）')} →</a>
          </div>
          <button class="btn btn-outline btn-sm" id="addr-edit-toggle" style="width:auto;font-size:12px;padding:4px 12px" onclick="toggleAddressEdit(true)">${addressSummaryText(data.default_address) ? t('编辑') : t('添加')}</button>
        </div>

        <!-- 折叠态摘要 -->
        <div id="addr-summary">
          ${(() => {
            const a = data.default_address || {}
            const sum = addressSummaryText(a)
            if (!sum) return `<div style="padding:12px;font-size:12px;color:#9ca3af;text-align:center;background:#f9fafb;border-radius:6px">${t('尚未设置默认地址，点击「添加」开始')}</div>`
            const detail = [a.line1, a.line2].filter(Boolean).join(' · ')
            return `<div style="padding:10px 12px;background:#f9fafb;border-radius:6px;font-size:13px;color:#374151;line-height:1.6;cursor:pointer" onclick="toggleAddressEdit(true)">
              <div style="font-weight:500">${escHtml(sum)}</div>
              ${detail ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${escHtml(detail)}${a.postal_code ? ' · ' + escHtml(a.postal_code) : ''}</div>` : ''}
            </div>`
          })()}
        </div>

        <!-- 展开态完整表单 -->
        <div id="addr-form" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid #f3f4f6">
          <p style="font-size:11px;color:#6b7280;margin-bottom:10px">${t('智能下单按此地址过滤不可派送商品；下单页可临时改。带 * 为必填。')}</p>

          <!-- 历史地址（最近 3 条，本地保存）-->
          <div id="addr-history-wrap" style="margin-bottom:14px"></div>

          <div style="margin-bottom:10px">
            <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 10px" onclick="addressPasteSmartFill()">📋 ${t('粘贴智能识别')}</button>
          </div>
        ${(() => {
          const a = data.default_address || {}
          return `
        <div style="margin-bottom:10px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('收件人姓名')} <span style="color:#dc2626">*</span></div>
          <input class="form-control" id="addr-recipient-inp" style="font-size:13px" maxlength="40" value="${escHtml(a.recipient_name || '')}" placeholder="${t('例：陈小明')}">
        </div>
        <div style="margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('主要联系方式')} <span style="color:#dc2626">*</span></div>
            <input class="form-control" id="addr-phone1-inp" style="font-size:13px" maxlength="30" value="${escHtml(a.phone1 || '')}" placeholder="${t('手机/电话')}">
          </div>
          <div>
            <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('备用联系方式')}</div>
            <input class="form-control" id="addr-phone2-inp" style="font-size:13px" maxlength="30" value="${escHtml(a.phone2 || '')}" placeholder="${t('可选')}">
          </div>
        </div>
        <div style="margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          <div>
            <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('国家/地区')} <span style="color:#dc2626">*</span></div>
            <input class="form-control" id="addr-country-inp" style="font-size:13px" maxlength="40" value="${escHtml(a.country || '中国')}" placeholder="${t('如：中国')}">
          </div>
          <div>
            <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('省/州')} <span style="color:#dc2626">*</span></div>
            <input class="form-control" id="addr-state-inp" style="font-size:13px" maxlength="40" value="${escHtml(a.state || '')}" placeholder="${t('如：上海/广东')}">
          </div>
          <div>
            <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('城市')} <span style="color:#dc2626">*</span></div>
            <input class="form-control" id="addr-city-inp" style="font-size:13px" maxlength="40" value="${escHtml(a.city || '')}" placeholder="${t('如：浦东新区')}">
          </div>
        </div>
        <div style="margin-bottom:10px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('地址行 1')} <span style="color:#dc2626">*</span></div>
          <input class="form-control" id="addr-line1-inp" style="font-size:13px" maxlength="100" value="${escHtml(a.line1 || '')}" placeholder="${t('如：张江路 123 号')}">
        </div>
        <div style="margin-bottom:10px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('地址行 2')}</div>
          <input class="form-control" id="addr-line2-inp" style="font-size:13px" maxlength="100" value="${escHtml(a.line2 || '')}" placeholder="${t('楼号/单元/房号（可选）')}">
        </div>
        <div style="margin-bottom:14px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('邮政编码')}</div>
          <input class="form-control" id="addr-postal-inp" style="font-size:13px" maxlength="20" value="${escHtml(a.postal_code || '')}" placeholder="${t('如：201203（可选）')}">
        </div>
        `})()}
          <p style="font-size:11px;color:#9ca3af;margin-bottom:8px">${t('「省/州」用于配送过滤匹配，需要与商品「发货地」一致（如「全国」或包含你的省份）')}</p>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" style="white-space:nowrap" onclick="saveDefaultAddress()">${t('保存')}</button>
            <button class="btn btn-outline btn-sm" style="white-space:nowrap" onclick="toggleAddressEdit(false)">${t('取消')}</button>
          </div>
          <div id="addr-msg" style="margin-top:8px"></div>
        </div>
      </div>
    </div>` : ''}

    <!-- 2026-05-24 我的二手 入口移除 — Dashboard "♻️ 我的二手" tile 已覆盖（同 #secondhand/mine 目标）-->


    <!-- 账户安全（密码 + 邮箱合并）-->
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">🔐 ${t('账户安全')}</div>

        <!-- 登录密码 -->
        <div style="padding-bottom:14px;border-bottom:1px solid #f3f4f6;margin-bottom:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:13px;color:#374151;font-weight:500">🔒 ${t('登录密码')}</div>
            <div style="font-size:12px;color:${data.has_password ? '#16a34a' : '#9ca3af'}">${data.has_password ? '✓ ' + t('已设置') : t('未设置')}</div>
          </div>
          ${data.has_password ? `
            <details>
              <summary style="font-size:12px;color:#6366f1;cursor:pointer">${t('修改密码 / 移除密码')}</summary>
              <div style="margin-top:10px">
                <input class="form-control" id="pwd-old"  type="password" placeholder="${t('原密码')}"   style="margin-bottom:8px;font-size:13px">
                <input class="form-control" id="pwd-new"  type="password" placeholder="${t('新密码（至少 8 字符）')}" style="margin-bottom:8px;font-size:13px">
                <input class="form-control" id="pwd-new2" type="password" placeholder="${t('再次输入新密码')}" style="margin-bottom:8px;font-size:13px">
                <button class="btn btn-primary btn-sm" onclick="doSetPassword()">${t('修改密码')}</button>
                <button class="btn btn-outline btn-sm" style="margin-left:6px;color:#dc2626;border-color:#dc2626" onclick="doRemovePassword()">${t('移除密码')}</button>
                <div id="pwd-msg" style="margin-top:8px"></div>
              </div>
            </details>
          ` : `
            <details>
              <summary style="font-size:12px;color:#6366f1;cursor:pointer">${t('设置密码（可用「名称 + 密码」登录）')}</summary>
              <div style="margin-top:10px">
                <input class="form-control" id="pwd-new"  type="password" placeholder="${t('新密码（至少 8 字符）')}" style="margin-bottom:8px;font-size:13px">
                <input class="form-control" id="pwd-new2" type="password" placeholder="${t('再次输入新密码')}" style="margin-bottom:8px;font-size:13px">
                <button class="btn btn-primary btn-sm" onclick="doSetPassword()">${t('设置密码')}</button>
                <div id="pwd-msg" style="margin-top:8px"></div>
              </div>
            </details>
          `}
        </div>

        <!-- 邮箱 -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:13px;color:#374151;font-weight:500">📧 ${t('找回邮箱')}</div>
            <div style="font-size:12px;color:${data.email_verified ? '#16a34a' : '#9ca3af'}">${data.email_verified ? '✓ ' + escHtml(data.email) : t('未绑定')}</div>
          </div>
          ${data.email_verified ? `
            <div style="font-size:11px;color:#9ca3af">${t('遗失密钥可通过此邮箱找回。修改/解绑功能即将上线。')}</div>
          ` : `
            <details>
              <summary style="font-size:12px;color:#6366f1;cursor:pointer">${t('绑定邮箱')}</summary>
              <div style="margin-top:10px">
                <div id="bind-step1">
                  <input class="form-control" id="bind-email-inp" placeholder="your@example.com" style="margin-bottom:8px;font-size:13px">
                  <button class="btn btn-outline btn-sm" onclick="doSendBindCode()">${t('发送验证码')}</button>
                  <div id="bind-msg1" style="margin-top:8px"></div>
                </div>
                <div id="bind-step2" style="display:none">
                  <div id="bind-target-hint" style="font-size:12px;color:#6b7280;margin-bottom:8px"></div>
                  <input class="form-control" id="bind-code-inp" placeholder="${t('6 位验证码')}" maxlength="6" style="margin-bottom:8px;font-size:13px">
                  <button class="btn btn-primary btn-sm" onclick="doConfirmBindEmail()">${t('确认绑定')}</button>
                  <button class="btn btn-outline btn-sm" onclick="bindBackToStep1()" style="margin-left:6px">${t('重发')}</button>
                  <div id="bind-msg2" style="margin-top:8px"></div>
                </div>
              </div>
            </details>
          `}
        </div>

        <!-- 活跃会话 (P1 安全) -->
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid #f3f4f6">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:13px;color:#374151;font-weight:500">🛡 ${t('活跃会话')}</div>
            <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px;color:#dc2626;border-color:#fca5a5" onclick="openLogoutAllModal()">${t('一键全登出')}</button>
          </div>
          <div style="font-size:11px;color:#9ca3af;margin-bottom:8px">${t('查看每个已登录设备/位置；可吊销可疑会话')}</div>
          <details>
            <summary style="font-size:12px;color:#6366f1;cursor:pointer">${t('查看所有活跃会话 →')}</summary>
            <div id="sessions-list" style="margin-top:10px;font-size:12px;color:#9ca3af">${t('点击展开加载...')}</div>
          </details>
        </div>
      </div>
    </div>

    <!-- 安全与存储 -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">🔐 ${t('安全与存储')}</div>
        <div id="storage-persist-row" style="font-size:12px;color:#6b7280;padding:8px 0">${t('检测存储持久化状态…')}</div>
        <div style="font-size:11px;color:#9ca3af;line-height:1.6;margin-top:6px;margin-bottom:14px">
          ${t('iOS Safari 7 天未活跃可能清理本地数据。妥善记下永久码 + recovery_code（在 API Key 卡片），任何时候能找回账户。')}
        </div>

        <div style="border-top:1px solid #f3f4f6;padding-top:12px">
          <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px">🔑 ${t('Passkey / 生物识别')}</div>
          <div style="font-size:11px;color:#9ca3af;line-height:1.6;margin-bottom:10px">
            ${t('提现等敏感操作可要求设备指纹 / Face ID 二次确认。私钥不离开你的手机，手机丢失也不会泄露。')}
          </div>
          <div id="passkey-list" style="font-size:12px;color:#6b7280">${t('加载中…')}</div>
          <a onclick="navigate('#agents')" style="display:block;margin-top:12px;font-size:12px;color:#4f46e5;cursor:pointer">🔌 ${t('已连接的 Agent')} →</a>
        </div>
      </div>
    </div>

    <!-- 偏好 -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">⚙️ ${t('偏好')}</div>

        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <div>
            <div style="font-size:13px;color:#374151;font-weight:500">🌐 ${t('语言')}</div>
            <div style="font-size:11px;color:#9ca3af">${t('UI 显示语言')}</div>
          </div>
          <button onclick="toggleLang()" class="btn btn-outline btn-sm" style="font-size:11px;padding:5px 12px;white-space:nowrap">${window._lang === 'en' ? '中文' : 'English'}</button>
        </div>

        ${!isTrustedRole ? `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 6px;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:#374151;font-weight:500">🌍 ${t('国家 / 地区')}</div>
            <div style="font-size:11px;color:${state.user?.region ? '#9ca3af' : '#dc2626'}">${state.user?.region ? regionLabel(state.user.region) : t('未设置 — 请选择')}</div>
          </div>
          <select id="profile-region-select" class="form-control" onchange="doSaveRegion(this.value)" style="font-size:12px;padding:5px 8px;width:auto;min-width:140px">
            <option value="">${t('请选择…')}</option>
            <option value="china" ${state.user?.region === 'china' ? 'selected' : ''}>🇨🇳 ${t('中国')}</option>
            <option value="us" ${state.user?.region === 'us' ? 'selected' : ''}>🇺🇸 ${t('美国')}</option>
            <option value="eu" ${state.user?.region === 'eu' ? 'selected' : ''}>🇪🇺 ${t('欧盟')}</option>
            <option value="india" ${state.user?.region === 'india' ? 'selected' : ''}>🇮🇳 ${t('印度')}</option>
            <option value="singapore" ${state.user?.region === 'singapore' ? 'selected' : ''}>🇸🇬 ${t('新加坡')}</option>
            <option value="global_north" ${state.user?.region === 'global_north' ? 'selected' : ''}>🌏 ${t('其他发达地区')}</option>
            <option value="global" ${state.user?.region === 'global' ? 'selected' : ''}>🌐 ${t('其他地区')}</option>
          </select>
        </div>` : ''}
      </div>
    </div>

    <!-- M7.2.7：黑名单（社交功能；受信角色不展示）-->
    ${!isTrustedRole ? (() => {
      const list = blocklist.blocked || []
      return `<details class="card" style="margin-bottom:12px"><summary style="padding:12px 16px;font-size:13px;color:#6b7280;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center">
        <span>🚫 ${t('我的黑名单')} <span style="color:#9ca3af">(${list.length})</span></span>
        <span style="font-size:11px;color:#9ca3af">${list.length === 0 ? t('暂无') : t('展开管理')} ▸</span>
      </summary>
      ${list.length > 0 ? `<div class="card-body" style="border-top:1px solid #f3f4f6;padding-top:10px">
        <p style="font-size:11px;color:#6b7280;margin-bottom:10px">${t('被拉黑的用户的商品和动态对你不可见')}</p>
        ${list.map(b => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f3f4f6">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500"><a href="#u/${b.blocked_id}" style="color:#374151">${escHtml(b.blocked_name || b.blocked_id)}</a></div>
              <div style="font-size:11px;color:#9ca3af">${b.reason ? escHtml(b.reason) + ' · ' : ''}${fmtTime(b.created_at)}</div>
            </div>
            <button class="btn btn-outline btn-sm" style="width:auto;padding:4px 10px;font-size:11px" onclick="unblockUser('${b.blocked_id}')">${t('解除')}</button>
          </div>`).join('')}
      </div>` : ''}
      </details>`
    })() : ''}

    <!-- 关于 -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">ℹ️ ${t('关于')}</div>

        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
          <span style="color:#374151">${t('版本')}</span>
          <span style="color:#9ca3af;font-family:monospace;font-size:12px">WebAZ ${window._version || '0.1.8'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
          <span style="color:#374151">${t('协议')}</span>
          <a href="https://github.com/webaz-protocol/webaz" target="_blank" style="color:#6366f1;text-decoration:none;font-size:12px">${t('源码仓库')} ↗</a>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
          <span style="color:#374151">🔔 ${t('推送通知')}</span>
          <a href="#push-settings" style="color:#6366f1;text-decoration:none;font-size:12px">${t('订单 / 评价 / 降价')} →</a>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:13px">
          <span style="color:#374151">${t('帮助')}</span>
          <a href="#promoter" style="color:#6366f1;text-decoration:none;font-size:12px">${t('成长任务指引')} →</a>
        </div>
      </div>
    </div>

    <!-- 2026-05-24 危险区：退出 / 注销分组醒目化 -->
    <div style="margin-top:20px;padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px">
      <div style="font-size:11px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">⚠ ${t('危险区')}</div>
      <button class="btn" onclick="logout()" style="width:100%;background:#fff;color:#dc2626;border:2px solid #dc2626;padding:10px;font-weight:600;border-radius:8px;margin-bottom:8px;cursor:pointer">🚪 ${t('退出登录')}</button>
      <div style="font-size:11px;color:#6b7280;text-align:center;line-height:1.5">${t('退出后可重新登录；本机 api_key 缓存会清除')}</div>
    </div>
  `, 'me')

  // 异步：检测并尝试申请 persistent storage，更新提示行
  ;(async () => {
    const row = document.getElementById('storage-persist-row')
    if (!row) return
    const supported = !!navigator.storage?.persisted
    if (!supported) {
      row.innerHTML = `<span style="color:#9ca3af">${t('浏览器不支持持久化 API（极旧浏览器）— 数据可能随时清理')}</span>`
      return
    }
    let persisted = await isStoragePersistent()
    if (!persisted) {
      // 当前未授权 → 主动申请一次
      try { persisted = await navigator.storage.persist() } catch {}
    }
    if (persisted) {
      row.innerHTML = `<span style="color:#16a34a">✓ ${t('存储已持久化 — 系统不会自动清理')}</span>`
    } else {
      row.innerHTML = `<span style="color:#d97706">⚠ ${t('存储非持久化 — iOS Safari 长期未打开可能清理。建议常用，并 +PWA 装到桌面提高优先级')}</span>
        <a href="#" onclick="event.preventDefault(); doRequestPersist()" style="margin-left:6px;color:#4f46e5;font-size:11px">${t('再次申请')}</a>`
    }
  })()

  // 加载 Passkey 列表
  refreshPasskeyList()
}

async function refreshPasskeyList() {
  const el = document.getElementById('passkey-list')
  if (!el) return
  if (!isWebAuthnSupported()) {
    el.innerHTML = `<span style="color:#9ca3af">${t('当前设备不支持 Passkey（请用支持 WebAuthn 的浏览器）')}</span>`
    return
  }
  const data = await GET('/webauthn/credentials').catch(() => ({ credentials: [], settings: {} }))
  const creds = data.credentials || []
  const required = !!data.settings?.required_for_withdraw

  const list = creds.length === 0
    ? `<div style="color:#9ca3af;font-size:11px;padding:8px 0">${t('还未注册任何 Passkey')}</div>`
    : creds.map(c => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:6px;font-size:11px">
          <span style="font-size:18px">🔑</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.device_label || c.id.slice(0, 18) + '…')}</div>
            <div style="color:#9ca3af;font-size:10px">${t('注册于')} ${fmtTime(c.created_at)}${c.last_used_at ? ` · ${t('上次用于')} ${fmtTime(c.last_used_at)}` : ''}</div>
          </div>
          <button onclick="doDeletePasskey('${c.id}')" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:12px;padding:0 6px">${t('删除')}</button>
        </div>`).join('')

  el.innerHTML = `
    ${list}
    <button class="btn btn-outline btn-sm" style="width:auto;padding:5px 12px;font-size:11px;margin-top:4px" onclick="doAddPasskey()">+ ${t('注册新 Passkey')}</button>
    ${creds.length > 0 ? `
    <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer">
        <input type="checkbox" id="wac-require-withdraw" ${required ? 'checked' : ''} onchange="doToggleWebAuthnRequired(this.checked)" style="width:14px;height:14px">
        ${t('提现操作需 Passkey 二次确认')}
      </label>
    </div>` : ''}
  `
}

window.doAddPasskey = async () => {
  const label = prompt(t('给这个设备起个名（例：iPhone 15 / 工作机）'), '') || ''
  const ok = await doRegisterPasskey(label.trim())
  if (ok) refreshPasskeyList()
}

window.doDeletePasskey = async (id) => {
  if (!confirm(t('删除后该 Passkey 不能用于二次确认，确定？'))) return
  // #1044 — 删 Passkey 自身需要先用同账号下任意一把 Passkey ceremony 拿 token,堵"失窃 Passkey 不需 Passkey 即可删它"漏洞
  let token
  try {
    token = await requestPasskeyGate('delete_passkey', { credential_id: id })
  } catch (e) {
    alert(t('需要先用 Passkey 验证身份才能删除：') + (e?.message || e))
    return
  }
  const r = await api('DELETE', '/webauthn/credentials/' + encodeURIComponent(id), { webauthn_token: token })
  if (r.error) { alert(r.error); return }
  refreshPasskeyList()
}

window.doToggleWebAuthnRequired = async (enabled) => {
  const r = await POST('/webauthn/settings', { required_for_withdraw: !!enabled })
  if (r.error) { alert(r.error); refreshPasskeyList(); return }
}

window.openChangeHandleModal = async () => {
  const profile = await GET('/profile')
  if (profile.error) return toast$(profile.error, 'error')
  const log = profile.handle_change_log || []
  const N = log.length   // 累计已改名次数
  const lastAt = profile.handle_last_changed_at
  const nextRequiredMonths = N * 12   // 本次改名需距上次至少 N × 12 个月（第 1 次 = 0）
  const afterThisRequiredMonths = (N + 1) * 12   // 本次改名成功后，下次需等的月数

  // 冷却状态
  let cooldownInfo = ''
  let cooldownActive = false
  if (lastAt && N > 0) {
    const lastMs = new Date(lastAt).getTime()
    const sinceMs = Date.now() - lastMs
    const requiredMs = nextRequiredMonths * 30 * 86400_000
    if (sinceMs < requiredMs) {
      cooldownActive = true
      const remainMs = requiredMs - sinceMs
      const remainMonths = Math.ceil(remainMs / (30 * 86400_000))
      cooldownInfo = `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;font-size:11px;color:#92400e;margin-bottom:10px;line-height:1.6">
        ⏳ <strong>${t('冷却中')}</strong>${t('：第')} ${N + 1} ${t('次改名需距上次至少')} <strong>${nextRequiredMonths}</strong> ${t('个月')}<br>
        ${t('还差约')} <strong>${remainMonths}</strong> ${t('个月')}
      </div>`
    }
  }

  // 累进规则提示（即使当前可改，也告知未来代价）
  const policyHint = `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 12px;font-size:11px;color:#1e40af;margin-bottom:10px;line-height:1.6">
      <strong>📋 ${t('累进式冷却规则')}</strong><br>
      ${t('第 1 次改名：随时')}<br>
      ${t('第 2 次：距第 1 次至少 12 个月')}<br>
      ${t('第 3 次：距第 2 次至少 24 个月')}<br>
      ${t('第 N 次：距上次至少 (N-1) × 12 个月')}<br>
      <span style="color:#475569">${t('原因：handle 是流量口令前缀，频繁改名会让累计推广信誉断层。')}</span>
    </div>`

  // 现状摘要
  const summary = `
    <div style="background:#f9fafb;border-radius:6px;padding:8px 10px;font-size:11px;color:#374151;margin-bottom:10px;line-height:1.6">
      ${t('你已改名')} <strong>${N}</strong> ${t('次')}${lastAt ? ` · ${t('上次')} ${fmtTime(lastAt)}` : ''}<br>
      ${cooldownActive ? '' : `<span style="color:#16a34a">✓ ${t('当前可以改名')}</span> · ${t('改名后下次需等')} <strong>${afterThisRequiredMonths}</strong> ${t('个月')}`}
    </div>`

  _openModal(`
    <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">${t('修改用户名')}</h2>
    <p style="font-size:12px;color:#6b7280;margin-bottom:10px">${t('公开唯一标识，3–20 字符，仅小写字母 / 数字 / . _')}</p>
    ${policyHint}
    ${summary}
    ${cooldownInfo}
    <div class="form-group">
      <label class="form-label">${t('当前')}</label>
      <code style="display:block;padding:8px;background:#f9fafb;border-radius:6px;font-size:14px">@${escHtml(profile.handle || '')}</code>
    </div>
    <div class="form-group">
      <label class="form-label">${t('新用户名')}</label>
      <input id="new-handle-inp" class="form-control" placeholder="${t('例如 season_2026')}" maxlength="20" ${cooldownActive ? 'disabled' : ''}>
    </div>
    <div id="ch-handle-msg"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-outline" style="flex:1" onclick="closeModal()">${t('取消')}</button>
      <button class="btn btn-primary" style="flex:1" onclick="doChangeHandle()" ${cooldownActive ? 'disabled style="opacity:0.5;flex:1"' : ''}>${cooldownActive ? '⏳ ' + t('冷却中') : t('保存')}</button>
    </div>
  `)
  if (!cooldownActive) setTimeout(() => document.getElementById('new-handle-inp')?.focus(), 50)
}

window.doChangeHandle = async () => {
  const handle = document.getElementById('new-handle-inp')?.value?.trim() || ''
  const msg = document.getElementById('ch-handle-msg')
  if (!handle) { if (msg) msg.innerHTML = alert$('error', t('请填写新用户名')); return }
  // 二次确认：累进冷却的代价要在用户主动点 OK 之前再清晰一次
  const profile = await GET('/profile').catch(() => null)
  if (profile) {
    const N = (profile.handle_change_log || []).length
    const nextWait = (N + 1) * 12
    const confirmMsg = t('确认改名为 @') + handle + '？\n\n'
      + t('这是你的第 ') + (N + 1) + t(' 次改名。\n')
      + t('改名后，下次改名需距本次至少 ') + nextWait + t(' 个月。\n\n')
      + t('handle 是你的流量口令前缀 — 已发布到外站视频/帖子的旧 anchor 仍然有效，但新 anchor 必须使用新 handle。')
    if (!confirm(confirmMsg)) return
  }
  // handle 是公开身份，泄露后果显著 — 强制密码二次验证
  const ok = await requireApiKeyPassword()
  if (!ok) return
  if (msg) msg.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('保存中...')}</div>`
  const res = await POST('/profile/change-handle', { handle })
  if (res.error) { if (msg) msg.innerHTML = alert$('error', res.error); return }
  closeModal()
  state.user = null
  const nextHint = res.next_change_required_months ? ` · ${t('下次改名需等')} ${res.next_change_required_months} ${t('个月')}` : ''
  toast$(t('用户名已更新') + nextHint)
  setTimeout(() => renderProfile(document.getElementById('app')), 500)
}

window.toggleNickEdit = (editing) => {
  const view = document.getElementById('nick-view')
  const edit = document.getElementById('nick-edit')
  if (!view || !edit) return
  view.style.display = editing ? 'none' : 'flex'
  edit.style.display = editing ? '' : 'none'
  if (editing) setTimeout(() => document.getElementById('new-name-inp')?.focus(), 50)
}

window.doChangeName = async () => {
  const newName = document.getElementById('new-name-inp')?.value?.trim()
  const msgEl = document.getElementById('change-name-msg')
  if (!msgEl) return
  if (!newName) { msgEl.innerHTML = alert$('error', t('请填写新昵称')); return }
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('保存中...')}</div>`
  const res = await POST('/profile/change-name', { name: newName })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  state.user = null
  msgEl.innerHTML = alert$('success', t('昵称已更新'))
  setTimeout(() => renderProfile(document.getElementById('app')), 800)
}

// P14.5 社交资料保存
window.saveSocialProfile = async () => {
  const bio    = document.getElementById('bio-inp')?.value || ''
  const anchor = document.getElementById('anchor-inp')?.value || ''
  const msgEl  = document.getElementById('social-msg')
  if (!msgEl) return
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('保存中...')}</div>`
  const res = await api('PATCH', '/profile', { bio, search_anchor: anchor })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', t('已保存'))
  setTimeout(() => { msgEl.innerHTML = '' }, 1500)
}

window.toggleFeedVisible = async (checked) => {
  const res = await api('PATCH', '/profile', { feed_visible: checked ? 1 : 0 })
  if (res.error) toast$(res.error, 'error')
  else toast$(checked ? t('已开启动态展示') : t('已隐藏动态'))
}

// A2：拉黑/解除拉黑
window.toggleBlock = async (userId, currentlyBlocked) => {
  if (currentlyBlocked) {
    if (!confirm(t('确认解除拉黑？将再次看到该用户的商品和动态。'))) return
    const r = await DELETE(`/blocklist/${userId}`)
    if (r.error) return toast$(r.error, 'error')
    toast$(t('已解除拉黑'))
  } else {
    const reason = prompt(t('拉黑原因（可选）'), '')
    if (reason === null) return
    const r = await POST(`/blocklist/${userId}`, { reason })
    if (r.error) return toast$(r.error, 'error')
    toast$(t('已拉黑'))
  }
  renderUserProfile(document.getElementById('app'), userId)
}

window.unblockUser = async (userId) => {
  if (!confirm(t('解除对该用户的拉黑？'))) return
  const r = await DELETE(`/blocklist/${userId}`)
  if (r.error) return toast$(r.error, 'error')
  toast$(t('已解除'))
  renderProfile(document.getElementById('app'))
}

// 地址摘要：用于折叠态显示
function addressSummaryText(a) {
  if (!a) return ''
  const hasAny = ['recipient_name','line1','country','state','city','phone1'].some(k => (a[k] || '').trim())
  if (!hasAny) return ''
  const parts = []
  if (a.recipient_name) parts.push(a.recipient_name)
  const region = [a.country, a.state, a.city].filter(Boolean).join('·')
  if (region) parts.push(region)
  if (a.phone1) {
    const p = String(a.phone1).replace(/\s/g, '')
    parts.push(p.length >= 8 ? p.replace(/(\d{3,4})\d+(\d{3,4})/, '$1****$2') : p)
  }
  return parts.join(' · ')
}

// 历史地址：localStorage 最近 3 条
function addressHistoryGet() {
  try { return JSON.parse(localStorage.getItem('webaz_addr_history') || '[]') } catch { return [] }
}
function addressHistoryPush(a) {
  if (!a || !a.recipient_name || !a.line1) return
  const list = addressHistoryGet()
  const key = `${a.recipient_name}|${a.line1}|${a.city || ''}`
  const filtered = list.filter(h => `${h.recipient_name}|${h.line1}|${h.city || ''}` !== key)
  filtered.unshift({ ...a, ts: Date.now() })
  localStorage.setItem('webaz_addr_history', JSON.stringify(filtered.slice(0, 3)))
}

function renderAddressHistory() {
  const wrap = document.getElementById('addr-history-wrap')
  if (!wrap) return
  const list = addressHistoryGet()
  if (!list.length) { wrap.innerHTML = ''; return }
  wrap.innerHTML = `
    <div style="font-size:12px;color:#6b7280;margin-bottom:6px">📜 ${t('历史地址')}</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${list.map((h, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f9fafb;border-radius:6px;border:1px solid #f3f4f6;cursor:pointer" onclick="applyAddressHistory(${i})" title="${t('点击填入')}">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;color:#374151;font-weight:500">${escHtml(addressSummaryText(h) || h.line1 || '')}</div>
            <div style="font-size:11px;color:#9ca3af;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml([h.line1, h.line2].filter(Boolean).join(' · '))}</div>
          </div>
          <button onclick="event.stopPropagation();removeAddressHistory(${i})" title="${t('删除')}" style="background:none;border:none;cursor:pointer;color:#9ca3af;font-size:14px;padding:2px 6px">✕</button>
        </div>`).join('')}
    </div>
  `
}

window.applyAddressHistory = (idx) => {
  const list = addressHistoryGet()
  const h = list[idx]; if (!h) return
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || '' }
  set('addr-recipient-inp', h.recipient_name)
  set('addr-phone1-inp',    h.phone1)
  set('addr-phone2-inp',    h.phone2)
  set('addr-country-inp',   h.country || '中国')
  set('addr-state-inp',     h.state)
  set('addr-city-inp',      h.city)
  set('addr-line1-inp',     h.line1)
  set('addr-line2-inp',     h.line2)
  set('addr-postal-inp',    h.postal_code)
  toast$(t('已填入历史地址，可继续编辑或直接保存'))
}

window.removeAddressHistory = (idx) => {
  const list = addressHistoryGet()
  list.splice(idx, 1)
  localStorage.setItem('webaz_addr_history', JSON.stringify(list))
  renderAddressHistory()
}

window.toggleAddressEdit = (editing) => {
  const sum = document.getElementById('addr-summary')
  const form = document.getElementById('addr-form')
  const btn = document.getElementById('addr-edit-toggle')
  if (!sum || !form) return
  sum.style.display = editing ? 'none' : ''
  form.style.display = editing ? '' : 'none'
  if (btn) btn.textContent = editing ? t('收起') : (sum.querySelector('div[onclick]') ? t('编辑') : t('添加'))
  if (btn) btn.setAttribute('onclick', editing ? 'toggleAddressEdit(false)' : 'toggleAddressEdit(true)')
  if (editing) renderAddressHistory()
}

// P-Polish 2：保存默认配送地址（结构化字段）
window.saveDefaultAddress = async () => {
  const get = (id) => document.getElementById(id)?.value?.trim() || ''
  const msg = document.getElementById('addr-msg')
  if (!msg) return
  msg.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('保存中...')}</div>`
  const payload = {
    line1:           get('addr-line1-inp'),
    line2:           get('addr-line2-inp'),
    country:         get('addr-country-inp'),
    state:           get('addr-state-inp'),
    city:            get('addr-city-inp'),
    recipient_name:  get('addr-recipient-inp'),
    phone1:          get('addr-phone1-inp'),
    phone2:          get('addr-phone2-inp'),
    postal_code:     get('addr-postal-inp'),
  }
  const res = await POST('/profile/default-address', payload)
  if (res.error) { msg.innerHTML = alert$('error', res.error); return }
  state.profileMini = null
  addressHistoryPush(payload)
  msg.innerHTML = alert$('success', t('已保存'))
  setTimeout(() => renderProfile(document.getElementById('app')), 800)
}

// P-Polish 2：粘贴智能识别（提取电话/邮编/省市 + 剩余进 line1）
window.addressPasteSmartFill = async () => {
  let pasted = ''
  try { pasted = await navigator.clipboard.readText() } catch {}
  if (!pasted) {
    pasted = prompt(t('粘贴完整地址（如电商站点复制的多行地址）'), '') || ''
  }
  if (!pasted.trim()) return toast$(t('未读到内容'), 'error')

  let remaining = pasted.replace(/\r\n/g, '\n').trim()
  const fill = (id, v) => { const el = document.getElementById(id); if (el && !el.value.trim()) el.value = v }

  // 电话识别（中国 11 位 / 国际 +xx 形式 / 座机 区号-号码）
  const phones = []
  remaining = remaining.replace(/(\+?\d[\d\s\-]{7,}\d)/g, (m) => { phones.push(m.replace(/\s/g, '')); return ' ' })
  if (phones[0]) fill('addr-phone1-inp', phones[0])
  if (phones[1]) fill('addr-phone2-inp', phones[1])

  // 邮政编码（中国 6 位 / 美国 5 位 / 国际带连字符）
  const postal = remaining.match(/(?<!\d)(\d{6}|\d{5}(?:-\d{4})?)(?!\d)/)
  if (postal) { fill('addr-postal-inp', postal[1]); remaining = remaining.replace(postal[1], ' ') }

  // 省/市识别（含 省/市/自治区/特别行政区）
  const provinceMatch = remaining.match(/([一-龥]{2,15}(?:省|自治区|特别行政区|市))/)
  if (provinceMatch) { fill('addr-state-inp', provinceMatch[1].replace(/(省|市)$/,'')); remaining = remaining.replace(provinceMatch[1], ' ') }
  const cityMatch = remaining.match(/([一-龥]{2,15}(?:市|区|县|州|镇))/)
  if (cityMatch) { fill('addr-city-inp', cityMatch[1]); remaining = remaining.replace(cityMatch[1], ' ') }

  // 默认国家 = 中国（若已有省市可推断）
  fill('addr-country-inp', '中国')

  // 收件人识别（独立短行 2-6 字符纯汉字）
  const lines = remaining.split(/\n+/).map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (!document.getElementById('addr-recipient-inp').value && /^[一-龥]{2,6}$/.test(line)) {
      fill('addr-recipient-inp', line)
      remaining = remaining.replace(line, ' ')
      break
    }
  }

  // 剩余整段塞 line1
  const cleaned = remaining.replace(/\s+/g, ' ').trim()
  if (cleaned) {
    if (cleaned.length <= 100) fill('addr-line1-inp', cleaned)
    else {
      fill('addr-line1-inp', cleaned.slice(0, 100))
      fill('addr-line2-inp', cleaned.slice(100, 200))
    }
  }
  toast$(t('已智能填充，请检查必填项并保存'))
}

window.bindBackToStep1 = () => {
  document.getElementById('bind-step1').style.display = ''
  document.getElementById('bind-step2').style.display = 'none'
  const m = document.getElementById('bind-msg1'); if (m) m.innerHTML = ''
}

window.doSendBindCode = async () => {
  const email = document.getElementById('bind-email-inp')?.value?.trim()
  const msg = document.getElementById('bind-msg1')
  if (!email) { msg.innerHTML = alert$('error', t('请填写邮箱')); return }
  msg.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('发送中...')}</div>`
  const res = await POST('/profile/bind-email', { email })
  if (res.error) { msg.innerHTML = alert$('error', res.error); return }
  msg.innerHTML = ''
  document.getElementById('bind-step1').style.display = 'none'
  document.getElementById('bind-step2').style.display = ''
  const hint = document.getElementById('bind-target-hint')
  hint.textContent = t('验证码已发送至 ') + res.target_hint + (res.dev_code ? ` (dev: ${res.dev_code})` : '')
  document.getElementById('bind-code-inp').dataset.email = email
}

window.doConfirmBindEmail = async () => {
  const codeInp = document.getElementById('bind-code-inp')
  const email = codeInp?.dataset?.email
  const code = codeInp?.value?.trim()
  const msg = document.getElementById('bind-msg2')
  if (!code) { msg.innerHTML = alert$('error', t('请填写验证码')); return }
  msg.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('验证中...')}</div>`
  const res = await POST('/profile/confirm-email', { email, code })
  if (res.error) { msg.innerHTML = alert$('error', res.error); return }
  msg.innerHTML = alert$('success', t('邮箱绑定成功'))
  state.user = null
  setTimeout(() => renderProfile(document.getElementById('app')), 800)
}
