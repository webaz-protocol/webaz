// WebAZ — Profile / Social / My-Home domain (classic multi-script split, slice G / app-profile.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n.js -> app-admin.js -> app-contribution.js -> app-ai.js -> app-discover.js -> app-profile.js -> app.js
// (after app-discover.js, since profile/nearby feeds call productCardHtml/
// discoverGoodsTabs which live there). Top-level functions / window.* handlers
// are global; pages run on route/click (after app.js loads), so cross-file
// globals (GET/POST/state/shell/escHtml/navigate/t/toast$/skeleton$/pageHeader/
// PAGE_HEADER_GRADIENTS/feedActor/feedEmpty/pageHotFeedToggle/copyAnchor/
// toggleFollow/kpiGrid/card/productCardHtml/...) resolve at call time. No import/export.
//
// Pure relocation of: #u/<id> user profile (+ reputation wall, metrics, content
// tabs, content/shares feeds), #follows, #nearby + nearby feed, and the #me
// home variants (trusted/seller/buyer/dispatcher). Auth/security, seller
// workbench/product-edit, cart/order/payment/wallet/status surfaces stay in app.js.
//
// No money/order/payment/wallet/status path; no auth/security function moved.
// No UI/behavior change.

// ─── P14.5：用户主页 #u/<user_id> ─────────────────────
// D2 信誉徽章墙 — 4 维度聚合
function renderReputationWall(badges) {
  const tiles = []
  if (badges.commercial) {
    const c = badges.commercial
    tiles.push({ icon: c.emoji, label: t('商业 ' + c.label), value: c.score + ' rep', color: c.color, bg: c.color + '15' })
  }
  if (badges.agent) {
    const lvlMap = { legend:{ label:'传奇', color:'#dc2626' }, quality:{ label:'优质', color:'#9333ea' }, trusted:{ label:'信赖', color:'#4f46e5' }, new:{ label:'新手', color:'#9ca3af' } }
    const m = lvlMap[badges.agent.level] || { label: badges.agent.level, color: '#6b7280' }
    // P1.2: score 可能 undefined（非 owner 视角已脱敏）— 用 level 名替代
    const valueStr = badges.agent.score != null ? 'trust ' + badges.agent.score : badges.agent.level
    tiles.push({ icon: '🤖', label: t('Agent ' + m.label), value: valueStr, color: m.color, bg: m.color + '15' })
  }
  if (badges.charity && badges.charity.prestige > 0) {
    const c = badges.charity
    const badgeEmoji = { diamond:'💎', gold:'🥇', silver:'🥈', bronze:'🥉' }[c.badge] || '🌱'
    tiles.push({ icon: badgeEmoji, label: t('慈善 ') + (c.badge || 'none'), value: c.prestige + ' ' + t('威望'), color: '#dc2626', bg: '#fef2f2' })
  }
  if (badges.verifier) {
    tiles.push({ icon: '🔍', label: t('审核员'), value: badges.verifier.tier, color: '#0891b2', bg: '#ecfeff' })
  }
  if (tiles.length === 0) return ''
  return `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e0e7ff">
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px;font-weight:600">🏆 ${t('信誉徽章')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${tiles.map(tile => `
          <div style="display:inline-flex;align-items:center;gap:6px;background:${tile.bg};color:${tile.color};padding:5px 11px;border-radius:99px;font-size:11px;font-weight:600;border:1px solid ${tile.color}30">
            <span style="font-size:14px">${tile.icon}</span>
            <span>${tile.label}</span>
            <span style="opacity:0.7;font-weight:400">· ${tile.value}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

// 信誉 + 参与度指标块（用 /api/users/:id 已返回的数据，无需额外请求）
function profileMetricsCard(data) {
  const c = (data.badges && data.badges.commercial) || { emoji: '🌱', label: t('新手'), score: 0 }
  const charity = data.badges && data.badges.charity
  const verifier = data.badges && data.badges.verifier
  const ageDays = data.created_at
    ? Math.max(0, Math.floor((Date.now() - new Date(String(data.created_at).replace(' ', 'T') + 'Z').getTime()) / 86400_000))
    : null
  const metric = (label, val) => `
    <div style="text-align:center;flex:1;min-width:0">
      <div style="font-size:18px;font-weight:700;color:#1f2937">${val}</div>
      <div style="font-size:10px;color:#9ca3af;margin-top:2px">${label}</div>
    </div>`
  const extraBadges = [
    charity && (charity.fulfilled > 0 || charity.made > 0) ? `<span style="background:#fef2f2;color:#dc2626;border-radius:99px;padding:3px 9px;font-size:11px">💝 ${t('圆梦')} ${charity.fulfilled || 0} · ${t('许愿')} ${charity.made || 0}</span>` : '',
    verifier ? `<span style="background:#eff6ff;color:#2563eb;border-radius:99px;padding:3px 9px;font-size:11px">🔍 ${t('验证员')} ${escHtml(verifier.tier || '')}</span>` : '',
  ].filter(Boolean).join('')
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-size:20px">${c.emoji}</span>
          <div>
            <div style="font-size:14px;font-weight:700;color:${c.color || '#1f2937'}">${t('信誉')}·${escHtml(c.label)}</div>
            <div style="font-size:11px;color:#9ca3af">${t('信誉分')} ${c.score || 0}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;padding:8px 0;border-top:1px solid #f3f4f6">
          ${metric(t('完成购买'), Number(data.purchase_count || 0))}
          ${metric(t('累计售出'), Number(data.sales_count || 0))}
          ${ageDays != null ? metric(t('入驻天数'), ageDays) : ''}
        </div>
        ${extraBadges ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${extraBadges}</div>` : ''}
      </div>
    </div>`
}

async function renderUserProfile(app, userId) {
  if (!userId) return navigate('#buy')
  // 'me' 别名 → 当前登录用户 ID（保持 URL 友好）
  if (userId === 'me') {
    if (!state.user?.id) return navigate('#login')
    userId = state.user.id
  }
  app.innerHTML = shell(skeleton$('profile'), null)

  const [data, blockStatus] = await Promise.all([
    GET(`/users/${userId}`),
    GET(`/blocklist/${userId}/status`).catch(() => ({ blocked: false })),
  ])
  if (data.error) return void (app.innerHTML = shell(alert$('error', data.error), null))

  const isOwner = data.is_owner
  // 存视图上下文供 switchProfileTab 用（非 owner 也能切 tab）；每次进主页重置到 笔记
  state._profileViewId = data.id
  state._profileIsOwner = isOwner
  state._profileTab = 'shares'
  const isBlocked = !!blockStatus.blocked
  const heroColor = isOwner ? 'linear-gradient(135deg,#eef2ff,#faf5ff)' : 'linear-gradient(135deg,#fff,#f9fafb)'
  const roleEmoji = { buyer: '🛍️', seller: '🏪', verifier: '🔍', logistics: '🚚', arbitrator: '⚖️', admin: '🛡' }[data.role] || '👤'

  const followBtn = isOwner ? '' : `
    <button class="btn ${data.is_following ? 'btn-outline' : 'btn-primary'} btn-sm"
            style="width:auto;padding:6px 18px"
            data-following="${data.is_following ? '1' : '0'}"
            onclick="toggleFollow('${data.id}', this)">${data.is_following ? t('已关注') : t('关注')}</button>`

  // 钱包/资产已移除 — 个人主页只保留 P2P 节点的社交/商业分享属性
  // 钱包入口请前往 #profile（个人资料 & 设置）

  // 小红书风格 hero（居中大头像 + bio + 3 数字 KPI）
  const heroBg = isOwner
    ? 'background:linear-gradient(180deg,#fef3f2 0%,#fff 80%)'
    : 'background:linear-gradient(180deg,#fdf4ff 0%,#fff 80%)'

  app.innerHTML = shell(`
    <div class="card" style="margin-bottom:14px;${heroBg};border:none;padding:24px 16px 16px 16px;text-align:center">
      <!-- 居中大头像 -->
      <div style="width:88px;height:88px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:44px;box-shadow:0 4px 12px rgba(0,0,0,0.08);margin:0 auto 12px auto">${roleEmoji}</div>

      <!-- 名字 + handle -->
      <div style="font-size:20px;font-weight:700;color:#1f2937;margin-bottom:2px">${escHtml(data.name)}</div>
      <div style="font-size:11px;color:#9ca3af;margin-bottom:10px">@${data.id}</div>

      <!-- bio -->
      ${data.bio
        ? `<div style="font-size:13px;color:#4b5563;line-height:1.5;max-width:480px;margin:0 auto 12px auto;padding:0 12px">${escHtml(data.bio)}</div>`
        : (isOwner ? `<div style="font-size:12px;color:#9ca3af;margin-bottom:12px;font-style:italic">${t('（设置一句话简介让人记住你）')}</div>` : '')}

      ${data.search_anchor ? `<div style="margin:0 0 12px 0">${searchAnchorBadge(data.search_anchor)}</div>` : ''}

      <!-- 3 数字 KPI（关注 / 粉丝 / 获赞）小红书风格 -->
      <div style="display:flex;justify-content:center;gap:8px;margin-bottom:14px">
        <a href="#follows" style="flex:1;max-width:120px;color:inherit;text-decoration:none;padding:6px">
          <div style="font-size:18px;font-weight:700;color:#1f2937">${data.following}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t('关注')}</div>
        </a>
        <a href="#follows" style="flex:1;max-width:120px;color:inherit;text-decoration:none;padding:6px">
          <div style="font-size:18px;font-weight:700;color:#1f2937">${data.followers}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t('粉丝')}</div>
        </a>
        <div style="flex:1;max-width:120px;padding:6px">
          <div style="font-size:18px;font-weight:700;color:#1f2937">${data.likes_received || 0}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t('获赞')}</div>
        </div>
      </div>

      ${data.badges ? `<div style="margin-bottom:12px">${renderReputationWall(data.badges)}</div>` : ''}

      <!-- 动作按钮居中 -->
      <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
        ${followBtn}
        ${isOwner ? `<button class="btn btn-outline btn-sm" style="width:auto;padding:6px 18px" onclick="toggleProfileEditor()">📝 ${t('编辑资料')}</button>` : ''}
        ${!isOwner ? `<button class="btn btn-outline btn-sm" style="width:auto;padding:6px 14px;color:${isBlocked ? '#dc2626' : '#9ca3af'}" onclick="toggleBlock('${data.id}', ${isBlocked})">${isBlocked ? '✓ ' + t('已拉黑（点击解除）') : '🚫 ' + t('拉黑')}</button>` : ''}
      </div>
    </div>

    ${profileMetricsCard(data)}

    ${isOwner ? `
    <!-- 📝 inline 社交资料编辑（默认折叠）-->
    <div id="profile-editor-card" class="card" style="margin-bottom:16px;display:none">
      <div class="card-body">
        <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">📝 ${t('个人资料')}</div>

        <div style="margin-bottom:14px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px">${t('一句话简介')} <span style="color:#9ca3af;font-size:11px">(${t('≤ 120 字')})</span></div>
          <input class="form-control" id="bio-inp" placeholder="${t('例如：一句话介绍你自己')}" style="font-size:13px" value="${escHtml(data.bio || '')}" maxlength="120">
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:13px;color:#374151;margin-bottom:6px">🔍 ${t('流量口令')} <span style="color:#9ca3af;font-size:11px">(${t('≤ 40 字，字母/数字/汉字/-_.')})</span></div>
          <div style="display:flex;gap:8px">
            <input class="form-control" id="anchor-inp" placeholder="${t('例如：好记的字母或数字组合')}" style="font-size:13px;flex:1" value="${escHtml(data.search_anchor || '')}" maxlength="40">
            <button class="btn btn-primary btn-sm" style="white-space:nowrap" onclick="saveSocialProfile()">${t('保存')}</button>
          </div>
          <p style="font-size:11px;color:#9ca3af;margin-top:4px">${t('在 TikTok / 小红书 口播这个口令，粉丝在 WebAZ 搜它就能找到你')}</p>
        </div>

        <div style="display:flex;align-items:center;gap:10px;padding-top:10px;border-top:1px solid #f3f4f6">
          <input type="checkbox" id="feed-visible-tg" style="width:16px;height:16px" ${data.feed_visible ? 'checked' : ''} onchange="toggleFeedVisible(this.checked)">
          <label for="feed-visible-tg" style="font-size:13px;cursor:pointer">${t('在公开动态流显示我的活动')}</label>
        </div>
        <p style="font-size:11px;color:#9ca3af;margin-top:4px;margin-left:26px">${t('关闭后，你的购买/匹配/分润事件不会出现在 发现好物 > 动态')}</p>

        <div id="social-msg" style="margin-top:10px"></div>

        <div style="margin-top:14px;padding-top:10px;border-top:1px solid #f3f4f6;font-size:12px">
          <a href="#follows" style="color:#4f46e5;text-decoration:none">→ ${t('我的关注/粉丝')}</a>
        </div>
      </div>
    </div>
    ` : ''}

    ${isOwner ? `
    <!-- 🔎 claim 验证活动（社交行为面板）— 仅自己可见 -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">🔎 ${t('验证活动')}</div>
          <div style="font-size:10px;color:#9ca3af">${t('参与协议级仲裁')}</div>
        </div>
        <div id="claim-verify-inline">
          <div style="font-size:12px;color:#9ca3af;padding:14px;text-align:center">${t('加载中...')}</div>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- 内容分类 tabs（笔记/测评/二手/拍卖/商品 + owner 转发/赞/收藏）-->
    <div id="user-shares-feed" class="card" style="margin-bottom:16px">
      <div class="card-body">
        ${profileContentTabs(isOwner, data.role, state._profileTab || 'shares')}
        ${isOwner ? `
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px" onclick="quickCreateFromProfile('anchor')" title="${t('选订单 → 添加口令')}">🔗 ${t('添加口令')}</button>
          <button class="btn btn-primary btn-sm" style="font-size:11px;padding:4px 10px" onclick="quickCreateFromProfile('note')" title="${t('选订单 → 创作笔记')}">📝 ${t('创作笔记')}</button>
        </div>` : ''}
        <div id="user-shares-list">
          <div style="font-size:12px;color:#9ca3af;padding:14px;text-align:center">${t('加载中...')}</div>
        </div>
      </div>
    </div>

    ${!isOwner ? `<div class="alert" style="font-size:12px;color:#6b7280;background:#f9fafb;border-color:#f3f4f6">ℹ️ ${t('查看 TA 在 WebAZ 上发布的所有公开内容')}</div>` : ''}
  `, isOwner ? 'me' : null)

  // 异步加载内容 feed（按当前 tab 分发）
  loadProfileTab(userId, isOwner, state._profileTab || 'shares')
  // M7.3c 修订：claim 验证 inline 注入（仅自己个人主页）
  if (isOwner) injectClaimVerifyPanel('claim-verify-inline')
}

// 内容分类 tab 栏（横向滚动）— 笔记/测评/二手/拍卖/[商品(卖家)] + [转发/赞/收藏(owner)]
function profileContentTabs(isOwner, role, active) {
  const tabs = [
    { k: 'shares', label: t('笔记') },
    { k: 'reviews', label: '⭐ ' + t('测评') },
    { k: 'secondhand', label: '♻️ ' + t('二手') },
    { k: 'auctions', label: '🔨 ' + t('拍卖') },
    ...(role === 'seller' ? [{ k: 'products', label: '🛍 ' + t('商品') }] : []),
    ...(isOwner ? [
      { k: 'reposted', label: '🔁 ' + t('转发') },
      { k: 'liked', label: '❤ ' + t('赞') },
      { k: 'bookmarked', label: '★ ' + t('收藏') },
    ] : []),
  ]
  return `<div style="display:flex;gap:18px;border-bottom:1px solid #f3f4f6;margin-bottom:12px;overflow-x:auto;-webkit-overflow-scrolling:touch">
    ${tabs.map(tb => {
      const on = tb.k === active
      return `<button onclick="switchProfileTab('${tb.k}')" id="ptab-${tb.k}" style="flex:0 0 auto;background:none;border:none;padding:8px 0;cursor:pointer;font-size:14px;font-weight:${on ? '600' : '500'};color:${on ? '#1f2937' : '#9ca3af'};border-bottom:2px solid ${on ? '#dc2626' : 'transparent'};white-space:nowrap">${tb.label}</button>`
    }).join('')}
  </div>`
}

// tab 分发：笔记类走 loadUserSharesFeed；测评/二手/拍卖/商品走 loadUserContentFeed
function loadProfileTab(userId, isOwner, tab) {
  if (['reviews', 'secondhand', 'auctions', 'products'].includes(tab)) {
    return loadUserContentFeed(userId, tab)
  }
  return loadUserSharesFeed(userId, isOwner, tab)
}

// 测评/二手/拍卖/商品 内容加载
async function loadUserContentFeed(userId, tab) {
  const wrap = document.getElementById('user-shares-list')
  if (!wrap) return
  wrap.innerHTML = `<div style="font-size:12px;color:#9ca3af;padding:14px;text-align:center">${t('加载中...')}</div>`
  const data = await GET(`/users/${userId}/${tab}`).catch(() => ({ items: [] }))
  const items = data.items || []
  if (items.length === 0) {
    const empty = {
      reviews: t('TA 还没写过测评'),
      secondhand: t('TA 没有在售的二手'),
      auctions: t('TA 没有进行中的拍卖'),
      products: t('TA 没有在售商品'),
    }[tab] || t('暂无内容')
    wrap.innerHTML = `<div style="font-size:12px;color:#9ca3af;padding:18px;text-align:center">${empty}</div>`
    return
  }
  const firstImg = (imgsJson) => { try { const a = JSON.parse(imgsJson || '[]'); return Array.isArray(a) && a[0] ? a[0] : null } catch { return null } }
  let html = ''
  if (tab === 'reviews') {
    html = items.map(r => `
      <div onclick="navigate('#order-product/${r.product_id}')" style="padding:10px 4px;border-bottom:1px solid #f3f4f6;cursor:pointer">
        <div style="font-size:13px;font-weight:500;margin-bottom:2px">${'★'.repeat(Number(r.stars) || 0)}<span style="color:#d1d5db">${'★'.repeat(5 - (Number(r.stars) || 0))}</span> <span style="color:#6b7280;font-size:12px">${escHtml(r.product_title || '')}</span></div>
        ${r.comment ? `<div style="font-size:12px;color:#4b5563;line-height:1.5">${escHtml(r.comment)}</div>` : ''}
        ${r.reply ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px;padding-left:8px;border-left:2px solid #e5e7eb">${t('卖家回复')}: ${escHtml(r.reply)}</div>` : ''}
        <div style="font-size:10px;color:#9ca3af;margin-top:4px">${fmtTime(r.created_at)}</div>
      </div>`).join('')
  } else if (tab === 'secondhand') {
    const CG = { brand_new: t('全新'), like_new: t('几乎全新'), lightly_used: t('轻度使用'), well_used: t('使用明显'), heavily_used: t('重度使用') }
    html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${items.map(s => {
      const img = firstImg(s.images)
      return `<div onclick="navigate('#secondhand/item/${s.id}')" style="background:#fff;border:1px solid #f3f4f6;border-radius:10px;overflow:hidden;cursor:pointer">
        ${img ? `<img src="${escHtml(img)}" style="width:100%;aspect-ratio:1;object-fit:cover;display:block" onerror="this.style.display='none'">` : `<div style="aspect-ratio:1;background:#f9fafb;display:flex;align-items:center;justify-content:center;font-size:32px">♻️</div>`}
        <div style="padding:8px">
          <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(s.title)}</div>
          <div style="font-size:13px;font-weight:700;color:#dc2626;margin-top:2px">${s.price} WAZ</div>
          <div style="font-size:10px;color:#9ca3af;margin-top:2px">${CG[s.condition_grade] || s.condition_grade}${s.status === 'reserved' ? ' · ' + t('已预订') : ''}</div>
        </div>
      </div>`
    }).join('')}</div>`
  } else if (tab === 'auctions') {
    html = items.map(a => `
      <div onclick="navigate('#auction/${a.id}')" style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px;border-bottom:1px solid #f3f4f6;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🔨 ${escHtml(a.title)}</div>
          <div style="font-size:11px;color:#6b7280">${t('当前价')} ${a.current_price} WAZ · ${a.bid_count || 0} ${t('次出价')}</div>
        </div>
        <span style="font-size:13px;color:#9ca3af">›</span>
      </div>`).join('')
  } else if (tab === 'products') {
    html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${items.map(p => {
      const img = firstImg(p.images)
      return `<div onclick="navigate('#order-product/${p.id}')" style="background:#fff;border:1px solid #f3f4f6;border-radius:10px;overflow:hidden;cursor:pointer">
        ${img ? `<img src="${escHtml(img)}" style="width:100%;aspect-ratio:1;object-fit:cover;display:block" onerror="this.style.display='none'">` : `<div style="aspect-ratio:1;background:#f9fafb;display:flex;align-items:center;justify-content:center;font-size:32px">${getCategoryIcon(p.category)}</div>`}
        <div style="padding:8px">
          <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.title)}</div>
          <div style="font-size:13px;font-weight:700;color:#1f2937;margin-top:2px">${p.price} WAZ</div>
          <div style="font-size:10px;color:#9ca3af;margin-top:2px">✅ ${p.completion_count || 0} · ❤ ${p.total_likes || 0}</div>
        </div>
      </div>`
    }).join('')}</div>`
  }
  wrap.innerHTML = html
}

// 📝 切换个人资料编辑卡
window.toggleProfileEditor = () => {
  const card = document.getElementById('profile-editor-card')
  if (!card) return
  card.style.display = card.style.display === 'none' ? '' : 'none'
  if (card.style.display !== 'none') card.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// 个人主页 tabs 切换（支持 笔记/测评/二手/拍卖/商品/转发/赞/收藏，owner + 非 owner）
window.switchProfileTab = (tab) => {
  state._profileTab = tab
  // 视觉 active 切换（遍历所有 ptab-* 按钮，兼容动态 tab 集）
  document.querySelectorAll('[id^="ptab-"]').forEach(el => {
    const active = el.id === 'ptab-' + tab
    el.style.color = active ? '#1f2937' : '#9ca3af'
    el.style.fontWeight = active ? '600' : '500'
    el.style.borderBottomColor = active ? '#dc2626' : 'transparent'
  })
  const userId = state._profileViewId || state.user?.id
  if (userId) loadProfileTab(userId, !!state._profileIsOwner, tab)
}

// 📺 加载用户内容 feed（shareables + manifests）
// tab: 'shares' (默认 我的笔记) | 'liked' (我赞过)
async function loadUserSharesFeed(userId, isOwner, tab) {
  tab = tab || state._profileTab || 'shares'
  state._profileTab = tab
  const wrap = document.getElementById('user-shares-list')
  if (!wrap) return
  wrap.innerHTML = `<div style="font-size:12px;color:#9ca3af;padding:14px;text-align:center">${t('加载中...')}</div>`

  let url
  if (tab === 'liked')           url = `/users/me/liked-shareables`
  else if (tab === 'bookmarked') url = `/users/me/bookmarked-shareables`
  else                           url = isOwner ? '/shareables/me' : `/users/${userId}/shareables`

  let shareables = []
  let manifests = []
  try {
    const [s, m] = await Promise.all([
      GET(url).catch(() => ({ shareables: [] })),
      // 仅 shares tab + owner 才拉 manifests（其他 tab 不含 manifest）
      (tab === 'shares' && isOwner) ? GET('/manifests/me').catch(() => ({ manifests: [] })) : Promise.resolve({ manifests: [] }),
    ])
    shareables = s.shareables || s.items || []
    manifests  = m.manifests || []
  } catch {}

  // 'shares' (原创) vs 'reposted' (转发别人) — 按 parent_id 前端过滤
  // 数据源都是 /shareables/me，差别在 parent_id 字段
  if (tab === 'shares')        shareables = shareables.filter(s => !s.parent_id)
  else if (tab === 'reposted') shareables = shareables.filter(s => s.parent_id)

  const total = shareables.length + manifests.length
  if (total === 0) {
    const emptyMsg =
      tab === 'reposted'   ? t('还没转发过任何笔记 — 在他人笔记页点 🔁 转发') :
      tab === 'liked'      ? t('还没赞过任何笔记 — 看到喜欢的就点 ❤') :
      tab === 'bookmarked' ? t('还没收藏任何笔记 — 看到想保存的就点 ★') :
      (isOwner ? t('还没有原创内容 — 添加 YouTube/TikTok/小红书 链接或在 WebAZ 直接创作') : t('TA 还没发布任何内容'))
    wrap.innerHTML = `<div style="font-size:12px;color:#9ca3af;padding:18px;text-align:center">${emptyMsg}</div>`
    return
  }
  const platformIcon = (p) => ({ youtube: '📺', tiktok: '🎵', xiaohongshu: '📕', bilibili: '🅱', instagram: '📷', twitter: '🐦' }[p] || '🔗')

  // 小红书风格双列瀑布流卡片：图 + 标题 + 元信息 + ❤
  const shareableCard = (s) => {
    const isNote = s.type === 'note'
    // 笔记的图：photo_hashes 第一张；外链：thumbnail_url；都没就 emoji 占位
    const hash = isNote && Array.isArray(s.photo_hashes) ? s.photo_hashes[0] : null
    const imgSrc = hash ? `/api/notes/photo/${hash}` : s.thumbnail_url
    const clickAction = isNote
      ? `navigate('#note/${s.id}')`
      : (s.external_url ? `window.open('${escHtml(s.external_url)}', '_blank')` : `navigate('#u/${userId}')`)
    return `
    <div onclick="${clickAction}" style="background:#fff;border-radius:10px;overflow:hidden;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.06);break-inside:avoid;margin-bottom:8px;transition:transform 0.15s;position:relative" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
      ${s.parent_id ? `<div style="position:absolute;top:6px;right:6px;background:rgba(255,255,255,0.9);color:#4f46e5;font-size:10px;font-weight:600;padding:2px 6px;border-radius:99px;z-index:1">🔁 ${t('转发')}</div>` : ''}
      ${imgSrc
        ? `<img src="${escHtml(imgSrc)}" style="width:100%;height:auto;display:block;background:#f3f4f6" onerror="this.style.display='none'">`
        : `<div style="aspect-ratio:1/1;background:#f9fafb;display:flex;align-items:center;justify-content:center;font-size:48px">${platformIcon(s.external_platform || s.type)}</div>`}
      <div style="padding:8px 10px">
        <div style="font-size:13px;font-weight:500;color:#1f2937;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px">${escHtml(s.title || s.external_url || '(无标题)')}</div>
        ${isNote && noteAuthBadges(s.badges, 'sm') ? `<div style="margin-top:4px">${noteAuthBadges(s.badges, 'sm')}</div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:10px;color:#9ca3af">
          <span>${platformIcon(s.external_platform || s.type)} ${s.click_count || 0} 👁</span>
          <span>❤ ${s.like_count || 0}</span>
        </div>
        ${isOwner ? `
          <div style="display:flex;gap:4px;margin-top:6px">
            <button onclick="event.stopPropagation();showQRModal('${location.origin}/s/${s.id}', '${escHtml((s.title || '').slice(0,30)).replace(/'/g, '&#39;')}')" style="flex:1;font-size:10px;padding:4px 6px;border:1px solid #e5e7eb;background:#fff;border-radius:6px;cursor:pointer">📱 QR</button>
            <button onclick="event.stopPropagation();deleteShareable('${s.id}')" style="flex:1;font-size:10px;padding:4px 6px;border:1px solid #fecaca;color:#dc2626;background:#fff;border-radius:6px;cursor:pointer">${t('删除')}</button>
          </div>` : ''}
      </div>
    </div>`
  }
  const manifestCard = (m) => `
    <div style="background:#fff;border-radius:10px;overflow:hidden;break-inside:avoid;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      ${m.thumbnail_data_uri ? `<img src="${m.thumbnail_data_uri}" style="width:100%;height:auto;display:block">` : `<div style="aspect-ratio:1/1;background:#e0e7ff;display:flex;align-items:center;justify-content:center;font-size:48px">📦</div>`}
      <div style="padding:8px 10px">
        <div style="font-size:13px;font-weight:500;color:#1f2937;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px">${escHtml(m.title || t('(原生内容)'))}</div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:#9ca3af">
          <span>P2P · ${(m.byte_size/1024).toFixed(0)}KB</span>
          <span>${fmtTime(m.created_at)}</span>
        </div>
        ${isOwner ? `<button onclick="takedownManifest('${m.hash}')" style="width:100%;margin-top:6px;font-size:10px;padding:4px;border:1px solid #fecaca;color:#dc2626;background:#fff;border-radius:6px;cursor:pointer">${t('下架')}</button>` : ''}
      </div>
    </div>`

  // CSS column 实现真瀑布流（不同高度图片自然错开）
  wrap.innerHTML = `
    <div style="column-count:2;column-gap:8px;padding:4px">
      ${shareables.map(shareableCard).join('')}
      ${manifests.map(manifestCard).join('')}
    </div>`
}

// P-AI V2 multi-provider assistant (provider registry/chain, AI IndexedDB, tool
// calling, LLM transport, task state machine, #ai-recommend/#ai-demo renders +
// ai* handlers) → moved to app-ai.js (classic split, slice E). aiCallLLM /
// aiGetProvider stay global there and are still called cross-file from app.js.

// ─── P14.5：关注/粉丝双 tab 列表 #follows ─────────────────────
async function renderFollows(app) {
  if (!state.user) return navigate('#login')
  app.innerHTML = shell(`
    <h1 class="page-title">👥 ${t('我的网络')}</h1>
    <div style="display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid #e5e7eb">
      <button class="follows-tab" data-k="following" onclick="setFollowsTab('following')" style="background:none;border:none;padding:8px 14px;font-size:13px;cursor:pointer;border-bottom:2px solid ${(state.followsTab||'following')==='following'?'#4f46e5':'transparent'};color:${(state.followsTab||'following')==='following'?'#4f46e5':'#6b7280'};font-weight:${(state.followsTab||'following')==='following'?'600':'400'}">👤 ${t('我关注的')}</button>
      <button class="follows-tab" data-k="followers" onclick="setFollowsTab('followers')" style="background:none;border:none;padding:8px 14px;font-size:13px;cursor:pointer;border-bottom:2px solid ${(state.followsTab||'following')==='followers'?'#4f46e5':'transparent'};color:${(state.followsTab||'following')==='followers'?'#4f46e5':'#6b7280'};font-weight:${(state.followsTab||'following')==='followers'?'600':'400'}">👥 ${t('粉丝')}</button>
    </div>
    <div id="follows-list">${skeleton$('list')}</div>
  `, null)

  const data = await GET('/follows/me')
  const tab = state.followsTab || 'following'
  const arr = tab === 'following' ? (data.following || []) : (data.followers || [])
  const myFollowing = new Set((data.following || []).map(u => u.id))

  if (arr.length === 0) {
    document.getElementById('follows-list').innerHTML = `
      <div class="empty" style="padding:40px 20px">
        <div class="empty-icon">${tab === 'following' ? '👥' : '✨'}</div>
        <div class="empty-text">${tab === 'following' ? t('你还没有关注任何人') : t('还没有粉丝 — 多发动态吸引关注吧')}</div>
        ${tab === 'following' ? `<button class="btn btn-outline btn-sm" style="margin-top:12px;width:auto" onclick="navigate('#discover')">${t('去发现好物 →')}</button>` : ''}
      </div>`
    return
  }

  const roleEmoji = { buyer: '🛍️', seller: '🏪', verifier: '🔍', logistics: '🚚', arbitrator: '⚖️', admin: '🛡' }
  const rows = arr.map(u => {
    const isFollowing = myFollowing.has(u.id)
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 4px;border-bottom:1px solid #f3f4f6;cursor:pointer" onclick="if(event.target.tagName!=='BUTTON')navigate('#u/${u.id}')">
        <div style="width:40px;height:40px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${roleEmoji[u.role] || '👤'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(u.name)}</div>
          <div style="font-size:11px;color:#9ca3af">@${u.id} · ${fmtTime(u.created_at)}</div>
        </div>
        ${u.id === state.user.id ? '' : `
          <button class="btn ${isFollowing ? 'btn-outline' : 'btn-primary'} btn-sm" style="width:auto;padding:5px 14px;font-size:12px"
                  data-following="${isFollowing ? '1' : '0'}"
                  onclick="event.stopPropagation();toggleFollow('${u.id}', this)">${isFollowing ? t('已关注') : t('关注')}</button>`}
      </div>`
  }).join('')
  document.getElementById('follows-list').innerHTML = rows
}

window.setFollowsTab = (k) => {
  state.followsTab = k
  renderFollows(document.getElementById('app'))
}

// ─── P15 雷达扫描 #nearby（QVOD 风格匿名聚合）─────────────────────
// 雷达扫描 MVP (2026-05-29)：scope 范围档(本格/周边/同城/全网) + window 时间窗(24h/7d/30d)
const NEARBY_SCOPES = [
  { k: 'cell',      label: '本格',  needsGeo: true  },
  { k: 'neighbors', label: '周边',  needsGeo: true  },
  { k: 'region',    label: '同城',  needsGeo: false },
  { k: 'global',    label: '全网',  needsGeo: false },
]
const NEARBY_WINDOWS = [['24h', '24h'], ['7d', '7天'], ['30d', '30天']]
window.setNearbyScope = (s) => { state._nearbyScope = s; renderNearby(document.getElementById('app')) }
window.setNearbyWindow = (w) => { state._nearbyWindow = w; renderNearby(document.getElementById('app')) }

async function renderNearby(app) {
  if (!state.user) return navigate('#login')
  const esc = (s) => String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;')
  // 默认 global(全网)：无需定位、最广、真实活动最早可见(冷启动友好)
  const scope = state._nearbyScope || 'global'
  const win = state._nearbyWindow || '7d'
  app.innerHTML = shell(skeleton$('list'), 'discover')

  const data = await GET('/nearby?scope=' + encodeURIComponent(scope) + '&window=' + encodeURIComponent(win))
  if (data.error) return void (app.innerHTML = shell(alert$('error', data.error), 'discover'))

  // 范围档 chips（本格/周边需定位 → 无定位时点击转授权）
  const scopeChips = `<div style="display:flex;gap:6px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch">
    ${NEARBY_SCOPES.map(s => {
      const on = s.k === scope
      return `<button onclick="setNearbyScope('${s.k}')" style="flex:0 0 auto;padding:6px 14px;border-radius:99px;font-size:13px;font-weight:${on ? '600' : '400'};cursor:pointer;border:1px solid ${on ? '#6366f1' : '#e5e7eb'};background:${on ? '#6366f1' : '#fff'};color:${on ? '#fff' : '#374151'}">${t(s.label)}</button>`
    }).join('')}
  </div>`
  // 时间窗 chips
  const winChips = `<div style="display:flex;gap:6px;margin-bottom:10px">
    ${NEARBY_WINDOWS.map(([k, l]) => {
      const on = k === win
      return `<button onclick="setNearbyWindow('${k}')" style="flex:0 0 auto;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer;border:1px solid ${on ? '#0284c7' : '#e5e7eb'};background:${on ? '#e0f2fe' : '#fff'};color:${on ? '#0369a1' : '#6b7280'}">${t(l)}</button>`
    }).join('')}
  </div>`
  const controls = `${scopeChips}${winChips}`

  // 本格/周边 缺定位 → 授权卡（保留 chips，用户可切同城/全网）
  if (!data.has_location) {
    app.innerHTML = shell(`
      ${renderSmartBuyHeader('nearby')}
      ${discoverGoodsTabs('nearby')}
      ${pageHotFeedToggle('#nearby', '#nearby/feed', { hotIcon: '🛰', hotLabel: t('雷达') })}
      ${controls}
      <div class="card" style="background:linear-gradient(135deg,#f0f9ff,#eef2ff);border-color:#bae6fd">
        <div style="text-align:center;padding:14px 0">
          <div style="font-size:48px;margin-bottom:10px">🌐</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">${t('看看你这片在买什么')}</div>
          <p style="font-size:13px;color:#374151;margin-bottom:6px">${t('隐私级聚合 · 不暴露任何买家身份')}</p>
          <p style="font-size:12px;color:#6b7280;margin-bottom:16px">${t('「本格 / 周边」需要定位；「同城 / 全网」无需定位即可看')}</p>
          <button class="btn btn-primary" style="width:auto;padding:10px 24px" onclick="requestLocation()">📍 ${t('授权位置')}</button>
          <div style="margin-top:12px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="setNearbyScope('region')">🏙 ${t('先看同城')}</button></div>
          <p style="font-size:11px;color:#9ca3af;margin-top:14px">${t('我们只存储 0.1° 精度（约 11km × 11km 格子），不会暴露你的精确坐标')}</p>
        </div>
      </div>
    `, 'discover')
    return
  }

  const agg = data.aggregate || {}
  const sufficient = data.sufficient
  const scopeLabel = data.scope_label || ''
  // 下一档（用于"放大范围"CTA）
  const nextScope = { cell: 'neighbors', neighbors: 'region', region: 'global', global: null }[scope]
  const nextLabel = { neighbors: '周边', region: '同城', global: '全网' }[nextScope] || ''

  // 范围不足（G 强化空状态）：清楚提示 + 一键放大 + 邀请（仅本格/周边）
  const renderInsufficientCard = () => {
    const inviteLink = `${location.origin}/r/${state.user?.handle || state.user?.id || ''}`
    const enlargeBtn = nextScope
      ? `<button class="btn btn-primary btn-sm" style="width:auto" onclick="setNearbyScope('${nextScope}')">🔭 ${t('放大到')}${t(nextLabel)}</button>`
      : `<button class="btn btn-primary btn-sm" style="width:auto" onclick="navigate('#discover')">🔥 ${t('看全网热门')}</button>`
    const inviteBtns = (scope === 'cell' || scope === 'neighbors')
      ? `<button class="btn btn-outline btn-sm" style="width:auto" onclick="showQRModal('${esc(inviteLink)}','📍 ${t('邀请邻居')}')">📱 ${t('邀请邻居')}</button>`
      : ''
    return `
      <div class="card" style="background:#fffbeb;border-color:#fde68a">
        <div style="font-size:14px;font-weight:600;color:#92400e;margin-bottom:6px">📡 ${t('扫描结果')}：${escHtml(scopeLabel)} ${t('人气不足')}</div>
        <p style="font-size:12px;color:#78350f;margin-bottom:12px">${t('该范围近')}${win === '24h' ? '24h' : win === '30d' ? t('30天') : t('7天')}${t('活跃 < 3 人 — 隐私保护（k≥3）下不显示聚合')}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${enlargeBtn}
          ${inviteBtns}
        </div>
      </div>`
  }

  const renderAggCard = () => `
    <div class="card" style="background:linear-gradient(135deg,#ecfdf5,#f0fdf4);border-color:#bbf7d0">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:13px">
        <div>
          <div style="color:#6b7280;font-size:11px;margin-bottom:2px">${t('活跃买家')}</div>
          <div style="font-size:24px;font-weight:700;color:#16a34a">${agg.active_users >= 0 ? agg.active_users : '—'}<span style="font-size:11px;font-weight:400;color:#9ca3af"> ${t('人')}</span></div>
        </div>
        <div>
          <div style="color:#6b7280;font-size:11px;margin-bottom:2px">${t('成交订单')}</div>
          <div style="font-size:24px;font-weight:700;color:#0284c7">${agg.orders >= 0 ? agg.orders : '—'}<span style="font-size:11px;font-weight:400;color:#9ca3af"> ${t('单')}</span></div>
        </div>
      </div>
    </div>`

  // scoped 搜索 — 客户端过滤 top_products by title
  const nq = (state._nearbyQ || '').toLowerCase()
  const topProductsRaw = data.top_products || []
  const topProductsFiltered = nq ? topProductsRaw.filter(p => (p.title || '').toLowerCase().includes(nq)) : topProductsRaw
  const topProductsHtml = topProductsFiltered.length === 0
    ? `<div style="font-size:12px;color:#9ca3af;padding:14px;text-align:center">${nq ? t('当前关键词无匹配') : t('该范围内还没有 ≥ 3 人买过同一商品')}</div>`
    : topProductsFiltered.map(p => `
        <div onclick="navigate('#order-product/${p.id}')" style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px;border-bottom:1px solid #f3f4f6;cursor:pointer">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            <div style="width:38px;height:38px;border-radius:8px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${getCategoryIcon(p.category)}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.title)}</div>
              <div style="font-size:11px;color:#6b7280">${p.price} WAZ · 🔥 ${p.buyers} ${t('人买')}</div>
            </div>
          </div>
          <span style="font-size:13px;color:#9ca3af">›</span>
        </div>`).join('')

  const topCatsHtml = (data.top_categories || []).length === 0
    ? `<div style="font-size:12px;color:#9ca3af;padding:10px;text-align:center">${t('暂无可显示的类目')}</div>`
    : `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:6px 0">
        ${(data.top_categories || []).map(c => `
          <span style="background:#f3f4f6;border-radius:14px;padding:5px 12px;font-size:12px">
            ${getCategoryIcon(c.category)} ${escHtml(c.category)} · <strong>${c.orders}</strong>
          </span>`).join('')}
      </div>`

  // 范围信息行
  const scopeInfoLine = (() => {
    const stale = (data.location_stale_days != null && data.location_stale_days > 30)
      ? `<a href="#" onclick="event.preventDefault();requestLocation()" style="color:#dc2626;margin-left:6px">⚠ ${t('位置已过期')} ${data.location_stale_days}${t('天，点此刷新')}</a>` : ''
    return `<div style="font-size:11px;color:#9ca3af;margin-bottom:10px">📡 ${escHtml(scopeLabel)} · ${t('k-anonymity ≥')} ${data.k_threshold} ${stale}</div>`
  })()

  const winLabel = win === '24h' ? '24h' : win === '30d' ? t('30天') : t('7天')
  app.innerHTML = shell(`
    ${renderSmartBuyHeader('nearby')}
    ${discoverGoodsTabs('nearby')}
    ${pageHotFeedToggle('#nearby', '#nearby/feed', { hotIcon: '🛰', hotLabel: t('雷达') })}
    ${controls}
    ${scopeInfoLine}

    ${sufficient ? renderAggCard() : renderInsufficientCard()}

    ${sufficient ? `
    <div class="card" style="margin-top:12px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">🔥 ${winLabel} ${t('热门商品')}</div>
      ${topProductsHtml}
    </div>

    <div class="card" style="margin-top:12px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">🏷 ${winLabel} ${t('热门类目')}</div>
      ${topCatsHtml}
    </div>` : ''}

    <div id="nearby-sh-strip" style="margin-top:14px"></div>

    <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="requestLocation()">📍 ${t('重设位置')}</button>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="clearLocation()">🚫 ${t('清除位置')}</button>
    </div>
  `, 'discover')
  shInjectStrip('nearby-sh-strip', { limit: 6, kind: 'nearby' })
}

// 请求/重设位置（geolocation 拿坐标 → 截断 0.1° → POST 保存；HTTP 站点回退手动输入）
// 2026-05-24 P1-5：复制 nearby 邀请文案
window.copyNearbyInvite = () => {
  const ta = document.getElementById('nearby-invite-tpl')
  if (!ta) return
  ta.select()
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(ta.value).then(() => toast(t('文案已复制')))
    } else {
      document.execCommand('copy')
      toast(t('文案已复制'))
    }
  } catch { toast(t('复制失败 — 请手动选中')) }
}

window.requestLocation = () => {
  // Geolocation API 要求 secure context（HTTPS 或 localhost）
  // 手机访问 http://192.168.x.x:3000 时浏览器直接拒绝，err.message 通常为空
  if (!window.isSecureContext || !navigator.geolocation) {
    return openManualLocationModal(
      !window.isSecureContext
        ? t('当前为 HTTP 不安全连接，浏览器禁止自动定位 — 请改用手动选择')
        : t('浏览器不支持地理定位 — 请改用手动选择')
    )
  }
  toast$(t('正在获取位置…'))
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = Math.round(pos.coords.latitude  * 10) / 10
      const lng = Math.round(pos.coords.longitude * 10) / 10
      const res = await POST('/profile/set-location', { lat, lng })
      if (res.error) toast$(res.error, 'error')
      else {
        toast$(t('位置已更新（约 11km 精度）'))
        renderNearby(document.getElementById('app'))
      }
    },
    (err) => {
      const codeMsg = {
        1: t('位置权限被拒 — 请在浏览器/系统设置中允许后重试'),
        2: t('无法获取位置（GPS 或网络问题）'),
        3: t('定位超时，请重试'),
      }[err.code] || (err.message || t('未知错误'))
      // 不直接 toast 错误，引导到手动输入（保证总有出路）
      openManualLocationModal(codeMsg)
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
  )
}

// 手动选位置 — geolocation 不可用时的兜底入口
// 提供常见城市快速选择 + 自定义 lat/lng 输入
window.openManualLocationModal = (reason) => {
  const cities = [
    { name: '北京',   lat: 39.9, lng: 116.4 },
    { name: '上海',   lat: 31.2, lng: 121.5 },
    { name: '广州',   lat: 23.1, lng: 113.3 },
    { name: '深圳',   lat: 22.5, lng: 114.1 },
    { name: '杭州',   lat: 30.3, lng: 120.2 },
    { name: '成都',   lat: 30.7, lng: 104.1 },
    { name: '武汉',   lat: 30.6, lng: 114.3 },
    { name: '西安',   lat: 34.3, lng: 108.9 },
  ]
  const cityBtns = cities.map(c =>
    `<button onclick="setManualLocation(${c.lat}, ${c.lng})" style="padding:8px 6px;border-radius:8px;background:#f3f4f6;border:1px solid #e5e7eb;cursor:pointer;font-size:13px;color:#374151">${t(c.name)}</button>`
  ).join('')
  _openModal(`
    <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">📍 ${t('手动选择位置')}</h2>
    ${reason ? `<div style="font-size:12px;color:#92400e;background:#fef3c7;padding:8px 10px;border-radius:6px;margin-bottom:12px;line-height:1.5">⚠ ${escHtml(reason)}</div>` : ''}
    <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${t('常见城市')}</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px">${cityBtns}</div>
    <details>
      <summary style="font-size:12px;color:#6366f1;cursor:pointer;padding:4px 0">${t('自定义经纬度（高级）')}</summary>
      <div style="padding:8px 0;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label style="font-size:11px;color:#6b7280">${t('纬度 lat')}</label><input id="loc-lat" type="number" step="0.1" placeholder="39.9" class="form-control" style="font-size:13px"></div>
        <div><label style="font-size:11px;color:#6b7280">${t('经度 lng')}</label><input id="loc-lng" type="number" step="0.1" placeholder="116.4" class="form-control" style="font-size:13px"></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:8px;padding:6px 14px" onclick="setManualLocation(Number(document.getElementById('loc-lat').value), Number(document.getElementById('loc-lng').value))">${t('使用此坐标')}</button>
    </details>
    <div style="text-align:right;margin-top:12px">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">${t('取消')}</button>
    </div>
  `)
}

window.setManualLocation = async (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast$(t('请输入有效的经纬度'), 'error')
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return toast$(t('经纬度超出有效范围'), 'error')
  const latR = Math.round(lat * 10) / 10
  const lngR = Math.round(lng * 10) / 10
  const res = await POST('/profile/set-location', { lat: latR, lng: lngR })
  if (res.error) return toast$(res.error, 'error')
  closeModal()
  toast$(t('位置已更新'))
  renderNearby(document.getElementById('app'))
}

window.clearLocation = async () => {
  if (!confirm(t('确认清除已存储的位置？清除后将无法查看雷达扫描。'))) return
  const res = await POST('/profile/clear-location', {})
  if (res.error) return toast$(res.error, 'error')
  toast$(t('位置已清除'))
  renderNearby(document.getElementById('app'))
}

// 2026-05-24 雷达扫描 · 动态：附近匿名聚合 + 24h 时段切片
async function renderNearbyFeed(app) {
  if (!state.user) return navigate('#login')
  app.innerHTML = shell(loading$(), 'discover')
  const data = await GET('/nearby').catch(() => null)
  let body
  if (!data || data.error || !data.has_location) {
    body = feedEmpty('📡', t('请先在 好物 tab 授权位置'), t('去授权'), '#nearby')
  } else {
    const agg = data.aggregate || {}
    const topCats = agg.top_categories || []
    const topProducts = agg.top_products_24h || []
    body = `
      <div class="card" style="padding:14px;background:linear-gradient(135deg,#f0f9ff,#eef2ff);border-color:#bae6fd;margin-bottom:10px">
        <div style="font-size:12px;color:#374151;margin-bottom:6px">📍 ${data.cell.approx_km}km × ${data.cell.approx_km}km · k-anonymity ≥ ${data.k_threshold}</div>
        <div style="font-size:13px;color:#1e40af">${agg.active_users_24h > 0 ? `👥 ${agg.active_users_24h} ${t('位邻居 24h 活跃')}` : t('该区域近 24h 活动稀少')}</div>
      </div>
      ${topCats.length > 0 ? `
        <h3 style="font-size:13px;font-weight:700;margin:14px 0 8px">🏷 ${t('近 24h 同城热门品类')}</h3>
        ${topCats.slice(0,5).map((c, i) => `
          <div class="card" style="padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
            <div style="font-size:18px;font-weight:800;color:${i<3?'#dc2626':'#9ca3af'};min-width:24px;text-align:center">${i+1}</div>
            <div style="flex:1">
              <div style="font-size:13px;color:#1f2937">${getCategoryIcon(c.category)} ${escHtml(c.category || t('未分类'))}</div>
              <div style="font-size:11px;color:#6b7280">🛒 ${c.purchase_count} ${t('单')} · 👥 ${c.buyer_count} ${t('人买')}</div>
            </div>
          </div>`).join('')}` : ''}
      ${topProducts.length > 0 ? `
        <h3 style="font-size:13px;font-weight:700;margin:14px 0 8px">🔥 ${t('近 24h 同城热销商品')}</h3>
        ${topProducts.slice(0,5).map(p => `
          <div class="card" style="padding:10px 12px;margin-bottom:6px;cursor:pointer" onclick="navigate('#order-product/${p.id}')">
            <div style="font-size:13px;font-weight:600">${escHtml(p.title)} <span style="color:#dc2626;font-weight:700">${p.price} WAZ</span></div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px">🛒 ${p.buy_count} ${t('单')} · 同城共鸣</div>
          </div>`).join('')}` : ''}
    `
  }
  app.innerHTML = shell(`
    ${renderSmartBuyHeader('nearby')}
    ${discoverGoodsTabs('nearby')}
    ${pageHotFeedToggle('#nearby', '#nearby/feed', { hotIcon: '🛰', hotLabel: t('雷达') })}
    <h2 style="font-size:16px;font-weight:700;margin:14px 0 10px">📡 ${t('附近动态')}</h2>
    <div style="font-size:11px;color:#6b7280;margin-bottom:14px">${t('同城匿名聚合 · k≥3 保护身份')}</div>
    ${body}
  `, 'discover')
}

// ─── #me 受信角色专属（admin / verifier / logistics / arbitrator）────────
async function renderTrustedMyHome(app, role) {
  app.innerHTML = shell(loading$(), 'me')
  try {
    const n = await GET('/notifications?unread=1').catch(() => null)
    if (n) state.unread = n.unread || 0
  } catch {}

  const profileRes = await GET('/profile').catch(() => null)
  const wal = profileRes?.wallet || { balance: 0, staked: 0 }

  // logistics / arbitrator 是 trusted role 但非 isTrustedRole 限制集（仅 admin/verifier 禁钱包）
  // 因此他们可参与慈善捐款（普通用户铁律）
  const canDonate = role === 'logistics' || role === 'arbitrator'
  // Wave B-4: 物流绩效卡（仅 logistics 拉）
  const perfRes = role === 'logistics' ? await GET('/logistics/me/performance').catch(() => null) : null
  // Wave D-5: verifier / arbitrator KPI
  const verifierKpi = role === 'verifier' ? await GET('/verifier/me/kpi').catch(() => null) : null
  const arbitratorKpi = role === 'arbitrator' ? await GET('/arbitrator/me/kpi').catch(() => null) : null
  const charityRes = canDonate ? await GET('/charity/me').catch(() => null) : null
  const charity = charityRes && !charityRes.error ? charityRes : null
  const rep = charity?.reputation || {}
  const pendingRepays = (charity?.pending_repayments || []).length

  const roleMeta = {
    admin:      { icon: '🛡', label: t('管理员'),  home: '#admin',          homeLabel: t('管理后台') },
    verifier:   { icon: '🔍', label: t('审核员'),  home: '#verify-tasks',   homeLabel: t('审核任务') },
    logistics:  { icon: '🚚', label: t('物流'),    home: '#seller',         homeLabel: t('配送任务') },
    arbitrator: { icon: '⚖',  label: t('仲裁员'),  home: '#seller',         homeLabel: t('仲裁台') },
  }[role] || { icon: '👤', label: role, home: '#', homeLabel: t('首页') }

  const card = (icon, label, sub, hash, badge) => `
    <div class="card" onclick="location.hash='${hash}'" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px;position:relative">
      <div style="font-size:24px;flex-shrink:0">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>` : ''}
      </div>
      ${badge ? `<div style="background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:2px 7px;min-width:18px;text-align:center;flex-shrink:0">${badge}</div>` : ''}
    </div>`

  // 头部：身份 + 权责分离声明（与各角色 hub 主题色同步 — 跨角色一致性）
  const [c1, c2] = PAGE_HEADER_GRADIENTS[role] || PAGE_HEADER_GRADIENTS.admin
  const header = `
    <div class="card" style="padding:16px;margin-bottom:14px;background:linear-gradient(135deg,${c1},${c2});color:#fff">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:32px">${roleMeta.icon}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px">${escHtml(state.user.name || state.user.handle)}</div>
          <div style="font-size:11px;opacity:0.85;margin-top:2px">@${escHtml(state.user.handle || '')} · ${roleMeta.label} · 🔒 ${t('受信角色')}${role === 'admin' ? ' · ' + t('不可个人交易') : ''}</div>
        </div>
      </div>
      <div onclick="location.hash='${roleMeta.home}'" style="cursor:pointer;padding:10px 12px;background:rgba(255,255,255,0.12);border-radius:8px;display:flex;justify-content:space-between;align-items:center;font-size:12px">
        <span style="font-weight:600">${roleMeta.icon} ${roleMeta.homeLabel}</span>
        <span style="opacity:0.85">→</span>
      </div>
    </div>
  `

  // 角色专属工作入口（按角色不同）
  let workGrid = ''
  if (role === 'admin') {
    // admin 不应有钱包/交易；通过 hub tab 完成所有治理工作
    // root admin: 隐式 all 权限 + 可管理其他 admin
    // regional admin: 限定 scope + admin_permissions JSON 控制可见性
    const adminType = state.user.admin_type || 'root'
    const isRoot = adminType === 'root'
    const adminScope = state.user.admin_scope || 'global'
    let adminPerms = []
    try { adminPerms = JSON.parse(state.user.admin_permissions || '[]') } catch {}
    const canDo = (perm) => isRoot || adminPerms.includes('all') || adminPerms.includes(perm)
    const typeBadge = isRoot
      ? `<span style="background:#fee2e2;color:#991b1b;font-size:10px;padding:1px 8px;border-radius:99px;font-weight:700;margin-left:6px">🔱 ROOT</span>`
      : `<span style="background:#dbeafe;color:#1e40af;font-size:10px;padding:1px 8px;border-radius:99px;font-weight:700;margin-left:6px">🌏 ${adminScope.toUpperCase()}</span>`
    workGrid = `
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px;display:flex;align-items:center">🏛 ${t('治理工作台')}${typeBadge}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('📊', t('概览'),       t('KPI + 异常告警'),       '#admin')}
        ${card('📈', t('协议指标看板'), t('DAU / GMV / 争议率'),    '#admin/kpi')}
        ${canDo('protocol') ? card('⚙️', t('协议参数'), t('费率 / 奖励 / 上限'), '#admin/params') : ''}
        ${canDo('users') ? card('🔎', t('用户活动 timeline'), t('任意用户完整事件流'), '#admin/timeline') : ''}
        ${canDo('users') ? card('🛡', t('风控告警'), t('可疑账户 / 一键暂停'), '#admin/risk') : ''}
        ${canDo('users') ? card('🆔', t('KYC 审核'), t('待审实名认证'), '#admin/kyc') : ''}
        ${canDo('users') ? card('📥', t('数据导出'), t('全平台 CSV 报表'), '#admin/export') : ''}
        ${canDo('protocol') ? card('📒', t('平台财务'), t('协议费 vs 拨付 月度'), '#admin/finance') : ''}
        ${card('📡', t('实时事件 stream'), t('全局事件 SSE 推流'), '#admin/events')}
        ${canDo('protocol') ? card('🩺', t('系统健康'), t('DB / RPC / 内存'), '#admin/health') : ''}
        ${canDo('users')        ? card('👥', t('用户与权限'), t('用户 / 申请 / 申诉 / 配额'), '#admin/users') : ''}
        ${canDo('content')      ? card('📦', t('内容管理'),   t('商品 / 订单 / 举报'),    '#admin/content') : ''}
        ${canDo('content')      ? card('📌', t('编辑精选'),   t('每周推荐 / 商品 / 卖家'), '#admin/editor-picks') : ''}
        ${canDo('arbitration')  ? card('⚖', t('仲裁审核'),   t('争议 / 验证任务'),       '#admin/arbitration') : ''}
        ${canDo('users') ? card('📥', t('用户反馈'), t('工单 / bug / 申诉'), '#admin-feedback') : ''}
        ${canDo('protocol')     ? card('⚛', t('协议管理'),   t('Tokenomics / 金库 / 拨款 / 审计'), '#admin/protocol') : ''}
        ${isRoot ? card('💳', t('支付选项'), t('多链 / 多区域 / 多渠道'), '#admin-payments') : ''}
        ${isRoot ? card('🛡', t('管理员账号'), t('创建 / 撤销 admin（仅 root）'), '#admin/manage-admins') : ''}
      </div>
      ${!isRoot ? `<div style="margin-top:6px;padding:8px 12px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:8px;font-size:11px;color:#92400e;line-height:1.5">🌏 <strong>${t('区域管理员')}</strong> · ${t('范围')}：${adminScope} · ${t('权限')}：${adminPerms.join(' / ') || t('无')}<br>${t('如需扩展权限或管理其他 admin，请联系 root 管理员。')}</div>` : ''}
    `
  } else if (role === 'verifier') {
    // verifier 受铁律 isTrustedRole 限制：无钱包 / 无交易 / 无慈善
    workGrid = `
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🔍 ${t('审核工作')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('🔍', t('审核任务'),   t('可接 / 已接未投 / 已投'),  '#verify-tasks')}
        ${card('📩', t('我要申诉'),   t('针对争议判定'),             '#verifier-appeal')}
        ${card('📦', t('订单记录'),   t('我审核相关'),                '#orders')}
      </div>
    `
  } else if (role === 'logistics') {
    workGrid = `
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🚚 ${t('配送工作')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('🚚', t('配送任务'),   t('待揽收 / 在途 / 待投递'),  '#seller')}
        ${card('📦', t('历史记录'),   t('我配送过的'),               '#orders')}
        ${card('💬', t('客户消息'),   t('协调买家 / 卖家'),          '#chats')}
      </div>
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">💰 ${t('个人')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('💰', t('钱包'),       `${Number(wal.balance).toFixed(2)} WAZ`, '#wallet')}
      </div>
    `
  } else if (role === 'arbitrator') {
    workGrid = `
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">⚖ ${t('仲裁工作')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('⚖',  t('仲裁台'),     t('待响应 / 仲裁中 / 已结'),  '#seller')}
        ${card('📦', t('记录'),       t('我裁定过的'),               '#orders')}
        ${card('💬', t('双方沟通'),   t('当事方协调'),               '#chats')}
      </div>
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">💰 ${t('个人')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('💰', t('钱包'),       `${Number(wal.balance).toFixed(2)} WAZ`, '#wallet')}
      </div>
    `
  }

  // 社交与发现（仅 logistics / arbitrator — 受信角色但非交易禁集）
  const socialGrid = canDonate ? `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🧭 ${t('社交与发现')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📍', t('附近'), t('同城节点 · 面交可达'), '#nearby')}
      ${card('🏆', t('排行榜'), t('热门 / 创作者 / 威望'), '#leaderboard')}
    </div>
  ` : ''

  // 公益折叠区（仅 logistics / arbitrator — 普通用户铁律允许；admin/verifier 严禁）
  const charitySection = canDonate ? `
    <details style="margin:14px 0 10px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
      <summary style="padding:10px 14px;cursor:pointer;font-size:13px;color:#6b7280;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>🌸 ${t('公益')}</span>
        <span style="font-size:11px;color:#9ca3af">${rep.badge_tier && rep.badge_tier !== 'none' ? rep.badge_tier + ' · ' : ''}${t('威望')} ${Number(rep.prestige_score||0).toFixed(0)}</span>
      </summary>
      <div style="padding:8px;border-top:1px solid #f3f4f6;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${card('🌸', t('许愿池'), pendingRepays ? pendingRepays + ' ' + t('待还愿') : t('浏览许愿 / 为他人圆梦'), '#wishes', pendingRepays || '')}
        ${card('💝', t('慈善基金'), t('捐款 · 公开账目'), '#wish/fund')}
        ${card('📚', t('我的慈善'), t('我的许愿 / 捐款 / 圆梦记录'), '#wish/mine')}
        ${card('🎁', t('圆梦故事'), t('已圆愿公开故事板'), '#wish/stories')}
      </div>
    </details>
  ` : ''

  // 2026-05-24 「个人资料」tile 已删 — Settings sub-tab 紧邻面板 1 click 可达
  const commonGrid = `
    <div style="margin-top:10px;padding:8px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:8px;font-size:11px;color:#6b7280;line-height:1.5">
      🔒 <strong>${t('权责分离')}</strong>: ${t('受信角色不能自助添加 buyer / seller 等其他身份，避免利益冲突。')}
    </div>
  `

  // Wave B-4: 物流绩效卡 HTML（仅 logistics）
  let perfCard = ''
  if (role === 'logistics' && perfRes && !perfRes.error) {
    // P2-5: 样本不足提示 — 评估单数 < 10 时百分比不稳定，显式标注
    const evaluatedSamples = (perfRes.pickup.on_time || 0) + (perfRes.pickup.overdue || 0)
      + (perfRes.delivery.on_time || 0) + (perfRes.delivery.overdue || 0)
    const lowSample = evaluatedSamples < 10
    const pct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%'
    const hr = (v) => v == null ? '—' : v.toFixed(1) + ' ' + t('小时')
    const color = (v, good, warn) => {
      if (v == null) return '#9ca3af'
      if (lowSample) return '#6b7280'  // 样本不足 → 灰色，避免误导
      return v >= good ? '#16a34a' : v >= warn ? '#d97706' : '#dc2626'
    }
    perfCard = `
      <div class="card" style="background:linear-gradient(135deg,#ecfdf5,#f0fdfa);border:1px solid #a7f3d0;margin-bottom:14px;padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:14px;font-weight:700">📊 ${t('物流绩效')} <span style="font-size:11px;color:#6b7280;font-weight:400">${t('近')} ${perfRes.window_days} ${t('天')}</span></div>
          <div style="font-size:11px;color:#9ca3af">${perfRes.total_orders} ${t('单')}</div>
        </div>
        ${lowSample ? `<div style="background:#fef3c7;border:1px dashed #f59e0b;color:#92400e;padding:6px 10px;border-radius:6px;font-size:11px;margin-bottom:10px">⚠ ${t('样本不足（评估单数 <10），百分比仅供参考')}</div>` : ''}
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
          <div>
            <div style="font-size:18px;font-weight:700;color:${color(perfRes.pickup.on_time_rate, 0.9, 0.7)}">${pct(perfRes.pickup.on_time_rate)}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px">${t('准时揽收率')}</div>
            <div style="font-size:10px;color:#9ca3af">${t('中位')} ${hr(perfRes.pickup.median_hours)}</div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:700;color:${color(perfRes.delivery.on_time_rate, 0.9, 0.7)}">${pct(perfRes.delivery.on_time_rate)}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px">${t('准时投递率')}</div>
            <div style="font-size:10px;color:#9ca3af">${t('中位')} ${hr(perfRes.delivery.median_hours)}</div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:700;color:${color(perfRes.disputes.loss_rate == null ? 1 : 1 - perfRes.disputes.loss_rate, 0.9, 0.7)}">${perfRes.disputes.total}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px">${t('争议数')}</div>
            <div style="font-size:10px;color:#9ca3af">${t('败诉')} ${perfRes.disputes.lost}</div>
          </div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:#6b7280;display:flex;justify-content:space-between">
          <span>${t('在途')} ${perfRes.in_progress}</span>
          <span>${t('已投递')} ${perfRes.delivered}</span>
          <span>${t('已完成')} ${perfRes.completed}</span>
        </div>
      </div>
    `
  }

  // Wave D-5: verifier KPI 卡
  let verifierCard = ''
  if (role === 'verifier' && verifierKpi && !verifierKpi.error) {
    const acc = verifierKpi.cumulative.accuracy
    const accColor = acc == null ? '#9ca3af' : acc >= 0.9 ? '#16a34a' : acc >= 0.7 ? '#d97706' : '#dc2626'
    verifierCard = `
      <div class="card" style="background:linear-gradient(135deg,#f5f3ff,#fff);border:1px solid #c4b5fd;margin-bottom:14px;padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:14px;font-weight:700">🔍 ${t('审核员绩效')} <span style="font-size:11px;color:#6b7280;font-weight:400">${verifierKpi.tier || '—'}</span></div>
          <div style="font-size:11px;color:#9ca3af">${t('近')} ${verifierKpi.window_days} ${t('天')}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
          <div>
            <div style="font-size:18px;font-weight:700;color:#7c3aed">${verifierKpi.cumulative.tasks_done}</div>
            <div style="font-size:10px;color:#6b7280">${t('累计任务')}</div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:700;color:${accColor}">${acc == null ? '—' : (acc * 100).toFixed(1) + '%'}</div>
            <div style="font-size:10px;color:#6b7280">${t('准确率')} <span style="color:#9ca3af">(${t('全期')})</span></div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:700;color:#16a34a">${Number(verifierKpi.total_earned_waz || 0).toFixed(2)}</div>
            <div style="font-size:10px;color:#6b7280">${t('累计收益')} WAZ</div>
          </div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:#6b7280;display:flex;justify-content:space-between">
          <span>${t('窗口投票')} ${verifierKpi.window.votes}</span>
          <span>${t('今日配额')} ${verifierKpi.tasks_today}/${verifierKpi.daily_quota}</span>
          <span>${t('验证权')} ${verifierKpi.verify_rights}</span>
        </div>
      </div>
    `
  }

  // Wave D-5: arbitrator KPI 卡
  let arbitratorCard = ''
  if (role === 'arbitrator' && arbitratorKpi && !arbitratorKpi.error) {
    arbitratorCard = `
      <div class="card" style="background:linear-gradient(135deg,#fef3c7,#fff);border:1px solid #fcd34d;margin-bottom:14px;padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:14px;font-weight:700">⚖ ${t('仲裁员绩效')}</div>
          <div style="font-size:11px;color:#9ca3af">${t('近')} ${arbitratorKpi.window_days} ${t('天')}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
          <div>
            <div style="font-size:18px;font-weight:700;color:#92400e">${arbitratorKpi.cumulative.total}</div>
            <div style="font-size:10px;color:#6b7280">${t('累计裁决')}</div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:700;color:${arbitratorKpi.pending > 0 ? '#dc2626' : '#16a34a'}">${arbitratorKpi.pending}</div>
            <div style="font-size:10px;color:#6b7280">${t('待处理')}</div>
          </div>
          <div>
            <div style="font-size:18px;font-weight:700;color:#16a34a">${Number(arbitratorKpi.total_earned_waz || 0).toFixed(2)}</div>
            <div style="font-size:10px;color:#6b7280">${t('累计收益')} WAZ</div>
          </div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:#6b7280">${t('裁定分布')}: ${t('退买家')} ${arbitratorKpi.cumulative.refund_buyer} · ${t('部分退')} ${arbitratorKpi.cumulative.partial_refund} · ${t('归卖家')} ${arbitratorKpi.cumulative.release_seller}</div>
      </div>
    `
  }

  app.innerHTML = shell(mySubTabsHTML('dashboard') + header + perfCard + verifierCard + arbitratorCard + workGrid + socialGrid + commonGrid + charitySection, 'me')
}

// ─── 卖家 #me 专业版（剥离慈善/排行/社交；聚焦商品+订单+资金）───────
async function renderSellerMyHome(app) {
  try { refreshCartBadge() } catch {}
  try {
    const n = await GET('/notifications?unread=1').catch(() => null)
    if (n) state.unread = n.unread || 0
  } catch {}
  try { await refreshAnnouncementsBadge() } catch {}

  const [profileRes, ordersRes, rfqsRes, skillsRes, agentRes, charityRes, claimTasksRes, returnsRes] = await Promise.all([
    GET('/profile').catch(() => null),
    GET('/orders').catch(() => []),
    GET('/rfqs?limit=50').catch(() => []),
    GET('/skills/mine').catch(() => []),
    GET('/agents/me/reputation').catch(() => null),
    GET('/charity/me').catch(() => null),
    GET('/claim-tasks/mine').catch(() => null),
    GET('/return-requests?role=seller&status=pending').catch(() => null),
  ])
  const pendingReturns = (returnsRes?.items || []).length
  const profile = profileRes && !profileRes.error ? profileRes : null
  const wal = { balance: Number(profile?.wallet?.balance || 0), staked: Number(profile?.wallet?.staked || 0) }
  const orders = Array.isArray(ordersRes) ? ordersRes : []
  const myUid = state.user.id
  const sellOrders = orders.filter(o => o.seller_id === myUid)
  const toShip = sellOrders.filter(o => ['paid','accepted'].includes(o.status)).length
  const inDispute = sellOrders.filter(o => o.status === 'disputed').length
  const rfqs = Array.isArray(rfqsRes) ? rfqsRes : []
  const openRfqs = rfqs.filter(r => r.status === 'open').length
  const mySkills = Array.isArray(skillsRes) ? skillsRes : []
  const skillCount = mySkills.length
  const activeSubs = mySkills.filter(s => s.subscribed_count > 0 || s.is_subscribed).length
  const charity = charityRes && !charityRes.error ? charityRes : null
  const rep = charity?.reputation || {}
  const pendingRepays = (charity?.pending_repayments || []).length
  // 索赔验证任务：卖家被诉 + 卖家主动核实
  // 注：外部审核员仅 buyer 可申请，seller 不可（业务规则）
  const myClaimTasks = claimTasksRes && !claimTasksRes.error
    ? ((claimTasksRes.as_seller || []).length + (claimTasksRes.as_buyer || []).length) : 0
  const agentLevel = agentRes?.level || 'new'
  const agentTrust = Math.round(agentRes?.trust_score || 0)
  const agentBandColor = { legend:'#dc2626', quality:'#9333ea', trusted:'#4f46e5', new:'#9ca3af' }[agentLevel] || '#6b7280'

  const card = (icon, label, sub, hash, badge, accent) => `
    <div class="card" onclick="location.hash='${hash}'" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px;position:relative${accent ? ';border-left:3px solid '+accent : ''}">
      <div style="font-size:24px;flex-shrink:0">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>` : ''}
      </div>
      ${badge ? `<div style="background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:2px 7px;min-width:18px;text-align:center;flex-shrink:0">${badge}</div>` : ''}
    </div>`

  const header = `
    <div class="card" style="padding:16px;margin-bottom:14px;background:linear-gradient(135deg,#7c2d12,#9a3412);color:#fff">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:28px">🏪</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px">${escHtml(state.user.name || state.user.handle)}</div>
          <div style="font-size:11px;opacity:0.85;margin-top:2px">@${escHtml(state.user.handle || '')} · ${t('卖家')}</div>
        </div>
      </div>
      <div onclick="location.hash='#wallet'" style="cursor:pointer;padding:10px 12px;background:rgba(255,255,255,0.12);border-radius:8px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:10px;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px">${t('钱包余额')}</div>
          <div style="font-size:22px;font-weight:800;line-height:1.2">${Number(wal.balance).toFixed(2)} <span style="font-size:13px;font-weight:600">WAZ</span></div>
          ${wal.staked > 0 ? `<div style="font-size:10px;opacity:0.75;margin-top:2px">${t('已锁定')} ${Number(wal.staked).toFixed(2)} WAZ</div>` : ''}
        </div>
        <div style="font-size:18px;opacity:0.85">→</div>
      </div>
    </div>
  `

  // 2026-05-24 agentDash 移除 — Advanced sub-tab 的 heroAgent 已展示同样 Agent trust + skill 统计

  const workGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">⚡ ${t('工作中心')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📦', t('订单管理'), toShip > 0 ? toShip + ' ' + t('待发货') : t('全部已发货'), '#orders', toShip || '', toShip > 0 ? '#f59e0b' : '')}
      ${card('💎', t('抢单（RFQ）'), openRfqs > 0 ? openRfqs + ' ' + t('个公开求购') : t('暂无求购'), '#rfqs', openRfqs > 0 ? String(openRfqs) : '')}
      ${card('🏪', t('店铺管理'), t('商品 / 营销 / Skill'), '#seller')}
      ${card('🎨', t('店铺主页'), t('编辑公开店铺装饰'), '#shop-edit')}
      ${card('↩', t('退货管理'), pendingReturns > 0 ? pendingReturns + ' ' + t('待处理') : t('数据 / 历史'), '#returns', pendingReturns || '', pendingReturns > 0 ? '#dc2626' : '')}
      ${card('📊', t('销售分析'), t('GMV / 复购 / 转化'), '#analytics')}
      ${card('⚡', t('我的促销'), t('限时降价管理'), '#my-flash')}
      ${card('🎁', t('签到 / 任务'), t('每日 WAZ + 成长奖励'), '#checkin')}
    </div>
    ${inDispute > 0 ? `<div onclick="location.hash='#orders'" class="card" style="padding:10px 14px;margin-bottom:10px;cursor:pointer;border-left:3px solid #dc2626;background:#fef2f2;display:flex;align-items:center;gap:8px"><div style="font-size:20px">⚖</div><div style="flex:1;font-size:13px;color:#991b1b">${inDispute} ${t('个争议待处理')}</div><div style="font-size:18px;color:#dc2626">→</div></div>` : ''}
  `

  // 销售扩展（seller 限定的销售形式 — 拍卖 / 跟卖 / P2P / 链接对标 / 二手）
  const marketGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🛍️ ${t('销售扩展')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🔨', t('加价竞拍'), t('限量稀缺 · 发起拍卖'), '#auctions')}
      ${card('🏬', t('跟卖加入'), t('多商家同款 · 抢市占'), '#listings')}
      ${card('📋', t('我的跟卖'), t('已上架 listings · 价格竞争位'), '#listings/mine')}
      ${card('🌐', t('P2P 商店'), t('数字商品 / 服务 / 加密发货'), '#p2p-shop')}
      ${card('🔗', t('链接对标'), t('外部独家价 · 链接认领'), '#seller')}
      ${card('♻️', t('个人闲置'), t('二手集市 · 公私分离'), '#secondhand')}
    </div>
  `

  // 2026-05-24 toolGrid 整段移除：4 个 tile 全是 Advanced sub-tab 重复（Auto-bid/Webhook/Timeline）+ 数据中心 重复 店铺管理
  const toolGrid = ''

  // 卖家账户：只留钱包；个人资料/设置已在 Settings sub-tab
  const commsGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">💰 ${t('账户')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('💰', t('钱包'), `${Number(wal.balance).toFixed(2)} WAZ`, '#wallet')}
    </div>
  `

  // 社交与发现（卖家弱网络 — 同城商家 + 排行）
  const socialGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🧭 ${t('社交与发现')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📍', t('附近'), t('同城节点 · 面交可达'), '#nearby')}
      ${card('🏆', t('排行榜'), t('热门商品 / 创作者 / 威望'), '#leaderboard')}
    </div>
  `

  // 公益：折叠次要区（卖家可参与，与 buyer 对等；admin/verifier 禁参）
  const charitySection = `
    <details style="margin:14px 0 10px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
      <summary style="padding:10px 14px;cursor:pointer;font-size:13px;color:#6b7280;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>🌸 ${t('公益')}</span>
        <span style="font-size:11px;color:#9ca3af">${rep.badge_tier && rep.badge_tier !== 'none' ? rep.badge_tier + ' · ' : ''}${t('威望')} ${Number(rep.prestige_score||0).toFixed(0)}</span>
      </summary>
      <div style="padding:8px;border-top:1px solid #f3f4f6;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${card('🌸', t('许愿池'), pendingRepays ? pendingRepays + ' ' + t('待还愿') : t('浏览许愿 / 为他人圆梦'), '#wishes', pendingRepays || '')}
        ${card('💝', t('慈善基金'), t('捐款 · 公开账目'), '#wish/fund')}
        ${card('📚', t('我的慈善'), t('我的许愿 / 捐款 / 圆梦记录'), '#wish/mine')}
        ${card('🎁', t('圆梦故事'), t('已圆愿公开故事板'), '#wish/stories')}
      </div>
    </details>
  `

  // 信任与协议（卖家：索赔被诉响应 — 注：外部审核员仅限 buyer 角色申请，seller 不可）
  const trustGrid = (myClaimTasks > 0) ? `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🛡 ${t('信任与协议')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🔎', t('我的验证'), myClaimTasks + ' ' + t('个索赔任务'), '#verify', myClaimTasks)}
    </div>
  ` : ''

  // 顺序：工作中心 → 销售扩展 → 效率工具 → 资金/沟通 → 信任与协议（条件显示）→ 社交发现 → 公益折叠
  app.innerHTML = shell(mySubTabsHTML('dashboard') + header + workGrid + marketGrid + commsGrid + trustGrid + socialGrid + charitySection, 'me')
}

// ─── 买家 #me 专业版（聚焦购物/订单/AI；慈善折叠次要） ────────
async function renderBuyerMyHome(app) {
  try { refreshCartBadge() } catch {}
  try {
    const n = await GET('/notifications?unread=1').catch(() => null)
    if (n) state.unread = n.unread || 0
  } catch {}
  try { await refreshAnnouncementsBadge() } catch {}

  const [profileRes, ordersRes, charityRes, skillsRes, agentRes, eligibilityRes, claimTasksRes, verifierStatusRes, arbEligibilityRes, arbStatusRes] = await Promise.all([
    GET('/profile').catch(() => null),
    GET('/orders').catch(() => []),
    GET('/charity/me').catch(() => null),
    GET('/skills/mine').catch(() => []),
    GET('/agents/me/reputation').catch(() => null),
    GET('/verifier/eligibility').catch(() => null),
    GET('/claim-tasks/mine').catch(() => null),
    GET('/verifier/status').catch(() => null),
    GET('/arbitrator/eligibility').catch(() => null),
    GET('/arbitrator/status').catch(() => null),
  ])
  const profile = profileRes && !profileRes.error ? profileRes : null
  const wal = { balance: Number(profile?.wallet?.balance || 0), staked: Number(profile?.wallet?.staked || 0) }
  const orders = Array.isArray(ordersRes) ? ordersRes : []
  const myUid = state.user.id
  const buyOrders = orders.filter(o => o.buyer_id === myUid)
  const toPay = buyOrders.filter(o => o.status === 'created').length
  const toReceive = buyOrders.filter(o => ['shipped','picked_up','in_transit','delivered'].includes(o.status)).length
  const inDispute = buyOrders.filter(o => o.status === 'disputed').length
  const charity = charityRes && !charityRes.error ? charityRes : null
  const rep = charity?.reputation || {}
  const pendingRepays = (charity?.pending_repayments || []).length
  const mySkills = Array.isArray(skillsRes) ? skillsRes : []
  const skillCount = mySkills.length
  const agentLevel = agentRes?.level || 'new'
  const agentTrust = Math.round(agentRes?.trust_score || 0)
  const agentBandColor = { legend:'#dc2626', quality:'#9333ea', trusted:'#4f46e5', new:'#9ca3af' }[agentLevel] || '#6b7280'
  // 外部审核员状态机（仅 buyer 可申请）：
  //   none / rejected → 资格 OK 时显示申请 tile
  //   pending → 申请审核中（不可再点）
  //   approved (whitelist 存在) → 外部审核员 — 显示审核任务等入口
  // 注：getVerifierState 在 whitelist 存在时返回 tier 名（'trial-1' 等），不是 'approved'
  const verifierEligible = eligibilityRes && !eligibilityRes.error && eligibilityRes.eligible === true
  const verifierState = (verifierStatusRes && !verifierStatusRes.error) ? verifierStatusRes.state : 'none'
  // 判 approved：whitelist 行存在（is_system=0 才是外部，但 buyer 走此路径肯定 is_system=0）
  const isExternalVerifier = !!(verifierStatusRes?.whitelist)
  const verifierPending = verifierState === 'pending'
  const verifierSuspended = verifierState === 'suspended' || verifierState === 'cooldown'
  const verifierTier = verifierStatusRes?.tier || null
  const verifierRemaining = Number(verifierStatusRes?.remaining ?? 0)
  // 索赔验证记录：买家相关任务数（发起 + 被诉，buyer 只会是 buyer 视角）
  const myClaimTasks = claimTasksRes && !claimTasksRes.error ? (claimTasksRes.as_buyer || []).length : 0
  // 外部审核员相关任务（作为 verifier 视角）
  const verifierTasks = claimTasksRes && !claimTasksRes.error ? (claimTasksRes.as_verifier || []).length : 0
  // 外部仲裁员状态机（与 verifier 平行）
  const arbEligible = arbEligibilityRes && !arbEligibilityRes.error && arbEligibilityRes.eligible === true
  const arbState = (arbStatusRes && !arbStatusRes.error) ? arbStatusRes.state : 'none'
  const isExternalArb = !!(arbStatusRes?.whitelist)
  const arbPending = arbState === 'pending'

  const card = (icon, label, sub, hash, badge, accent) => `
    <div class="card" onclick="location.hash='${hash}'" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px;position:relative${accent ? ';border-left:3px solid '+accent : ''}">
      <div style="font-size:24px;flex-shrink:0">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>` : ''}
      </div>
      ${badge ? `<div style="background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:2px 7px;min-width:18px;text-align:center;flex-shrink:0">${badge}</div>` : ''}
    </div>`

  const header = `
    <div class="card" style="padding:16px;margin-bottom:14px;background:linear-gradient(135deg,#1e3a8a,#1e40af);color:#fff">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:28px">🛒</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px">${escHtml(state.user.name || state.user.handle)}</div>
          <div style="font-size:11px;opacity:0.85;margin-top:2px">@${escHtml(state.user.handle || '')} · ${t('买家')}</div>
        </div>
      </div>
      <div onclick="location.hash='#wallet'" style="cursor:pointer;padding:10px 12px;background:rgba(255,255,255,0.12);border-radius:8px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:10px;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px">${t('钱包余额')}</div>
          <div style="font-size:22px;font-weight:800;line-height:1.2">${Number(wal.balance).toFixed(2)} <span style="font-size:13px;font-weight:600">WAZ</span></div>
          ${wal.staked > 0 ? `<div style="font-size:10px;opacity:0.75;margin-top:2px">${t('已锁定')} ${Number(wal.staked).toFixed(2)} WAZ</div>` : ''}
        </div>
        <div style="font-size:18px;opacity:0.85">→</div>
      </div>
    </div>
  `

  // 2026-05-24 agentDash 移除 — Advanced sub-tab heroAgent 已展示

  // 我的购物 — 个人交易记录 + 个人资产（去掉发现页内容：限时促销/群组团购/精选/评测/动态/AI 推荐 → 发现 tab）
  const shopGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🛒 ${t('我的购物')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📦', t('我的订单'), toPay > 0 ? toPay + ' ' + t('待付款') : (toReceive > 0 ? toReceive + ' ' + t('待收货') : t('全部完成')), '#orders', (toPay || toReceive) || '', toPay > 0 ? '#dc2626' : (toReceive > 0 ? '#f59e0b' : ''))}
      ${card('🧺', t('购物车'), state.cartCount ? `${state.cartCount} ${t('件')}` : t('空'), '#cart', state.cartCount || '')}
      ${card('❤', t('心愿单'), t('喜欢的商品 · 降价提醒'), '#wishlist')}
      ${card('⏰', t('补货提醒'), t('缺货商品到货通知'), '#waitlist')}
      ${card('🤝', t('我关注'), t('卖家 / 商品'), '#follows')}
      ${card('↩', t('我的退货'), t('退货申请 / 进度'), '#returns')}
      ${card('🎟️', t('我的优惠券'), t('可用券 · 使用历史'), '#my-coupons')}
      ${state.user?.mlm_ui_visible !== false ? card('🎁', t('邀请奖励'), t('邀请码 · 收益 · 邀请人'), '#referral') : ''}
    </div>
    ${inDispute > 0 ? `<div onclick="location.hash='#orders'" class="card" style="padding:10px 14px;margin-bottom:10px;cursor:pointer;border-left:3px solid #dc2626;background:#fef2f2;display:flex;align-items:center;gap:8px"><div style="font-size:20px">⚖</div><div style="flex:1;font-size:13px;color:#991b1b">${inDispute} ${t('个争议待处理')}</div><div style="font-size:18px;color:#dc2626">→</div></div>` : ''}
  `

  // 我的市场记录 — buyer 视角的 my-* 入口（不含跟卖：跟卖是卖家行为；不含拍卖：buyer 没有 auction/mine 概念）
  const marketGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">📋 ${t('我的市场记录')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📝', t('我的笔记'), state.user?.mlm_ui_visible !== false ? t('购买体验分享 · 返佣') : t('购买体验分享 · 公益贡献'), '#me/notes')}
      ${card('💬', t('我的求购'), t('我发布的求购单'), '#rfq/mine')}
      ${card('♻️', t('我的二手'), t('我发布的闲置'), '#secondhand/mine')}
      ${card('🎁', t('我的测评'), t('测评免单申请 + 进度'), '#trials')}
    </div>
  `

  // 2026-05-24 Skill / Auto-bid / Timeline 都已在 Advanced sub-tab，此处仅留高频 签到
  const aiGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🎁 ${t('日常')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🎁', t('签到 / 任务'), t('每日 WAZ + 成长奖励'), '#checkin')}
    </div>
  `

  // 2026-05-24 客服/反馈/我的 agents 都已迁移：
  // - 反馈/客服 → 消息中心的「客服」sub-tab（含「+ 新建反馈」按钮）
  // - 我的 agents → #me/advanced sub-tab
  const commsGrid = ''

  // 公益：折叠次要区（买家可主动参与，但不抢主流）— 扩展 4 tile 覆盖捐款/圆梦/我的慈善
  const charitySection = `
    <details style="margin:14px 0 10px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
      <summary style="padding:10px 14px;cursor:pointer;font-size:13px;color:#6b7280;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>🌸 ${t('公益')}</span>
        <span style="font-size:11px;color:#9ca3af">${rep.badge_tier && rep.badge_tier !== 'none' ? rep.badge_tier + ' · ' : ''}${t('威望')} ${Number(rep.prestige_score||0).toFixed(0)}</span>
      </summary>
      <div style="padding:8px;border-top:1px solid #f3f4f6;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${card('🌸', t('许愿池'), pendingRepays ? pendingRepays + ' ' + t('待还愿') : t('浏览许愿 / 为他人圆梦'), '#wishes', pendingRepays || '')}
        ${card('💝', t('慈善基金'), t('捐款 · 公开账目'), '#wish/fund')}
        ${card('📚', t('我的慈善'), t('我的许愿 / 捐款 / 圆梦记录'), '#wish/mine')}
        ${card('🏆', t('排行榜'), t('热门 / 创作者 / 威望'), '#leaderboard')}
      </div>
    </details>
  `

  // 社交与发现 — 已移除（附近/雷达扫描 属于发现页内容）
  const socialGrid = ''

  // 信任与协议 — 两个独立状态机（verifier + arbitrator）+ 通用索赔任务 tile
  // ① 外部审核员区（4 状态）
  let verifierSection = ''
  if (isExternalVerifier) {
    const tierBadge = verifierTier ? `<span style="background:#dcfce7;color:#166534;font-size:10px;padding:1px 7px;border-radius:99px;font-weight:600;margin-left:6px">${verifierTier}</span>` : ''
    verifierSection = `
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px;display:flex;align-items:center">🔍 ${t('外部审核员')}${tierBadge}<span style="font-size:10px;color:#9ca3af;margin-left:6px">${t('今日剩余')} ${verifierRemaining}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('🔍', t('审核任务'), t('可接 / 已接未投 / 已投'), '#verify-tasks', verifierTasks || '')}
        ${card('📩', t('我要申诉'), t('针对争议判定'), '#verifier-appeal')}
      </div>
    `
  } else if (verifierPending) {
    verifierSection = `
      <div class="card" style="padding:12px;margin:14px 0 10px;background:linear-gradient(135deg,#fef3c7,#fde68a);border-color:#fbbf24;display:flex;align-items:center;gap:10px">
        <div style="font-size:22px">⏳</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#92400e">${t('审核员申请审核中')}</div>
          <div style="font-size:11px;color:#92400e;opacity:0.85;margin-top:2px">${t('管理员审批后将通知你')}</div>
        </div>
      </div>
    `
  } else if (verifierEligible) {
    verifierSection = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('🎖', t('申请审核员'), t('资格已达标 — 申请加入'), '#apply-verifier')}
      </div>
    `
  }

  // ② 外部仲裁员区（4 状态 — 与 verifier 平行）
  let arbSection = ''
  if (isExternalArb) {
    arbSection = `
      <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px;display:flex;align-items:center">⚖ ${t('外部仲裁员')}<span style="background:#ede9fe;color:#6b21a8;font-size:10px;padding:1px 7px;border-radius:99px;font-weight:600;margin-left:6px">${t('已批准')}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('⚖', t('仲裁台'), t('待响应 / 仲裁中 / 已结'), '#disputes')}
      </div>
    `
  } else if (arbPending) {
    arbSection = `
      <div class="card" style="padding:12px;margin:14px 0 10px;background:linear-gradient(135deg,#ede9fe,#ddd6fe);border-color:#a78bfa;display:flex;align-items:center;gap:10px">
        <div style="font-size:22px">⏳</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#6b21a8">${t('仲裁员申请审核中')}</div>
          <div style="font-size:11px;color:#6b21a8;opacity:0.85;margin-top:2px">${t('管理员审批后将通知你')}</div>
        </div>
      </div>
    `
  } else if (arbEligible) {
    arbSection = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${card('⚖', t('申请仲裁员'), t('资格已达标 — 申请加入'), '#apply-arbitrator')}
      </div>
    `
  }

  // 阶段 4(#1093):新治理 onboarding 入口 — 始终可访问我的治理岗位面板(卸任 / 申诉 / 历史)
  const governanceMeSection = (isExternalArb || isExternalVerifier) ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🏛', t('我的治理岗位'), t('在岗 / 申诉 / 卸任'), '#governance-me')}
    </div>
  ` : ''

  // ③ 通用索赔任务 tile
  const claimsTile = myClaimTasks > 0 ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('🔎', t('我的验证'), myClaimTasks + ' ' + t('个索赔任务'), '#verify', myClaimTasks)}
    </div>
  ` : ''

  // 拼装：有内容才显标题
  const hasAnyTrust = verifierSection || arbSection || claimsTile || governanceMeSection
  const trustGrid = hasAnyTrust ? `
    ${(!isExternalVerifier && !isExternalArb) ? `<div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🛡 ${t('信任与协议')}</div>` : ''}
    ${verifierSection}
    ${arbSection}
    ${governanceMeSection}
    ${claimsTile}
  ` : ''

  // 账户与配置 — 个人配置集中区
  const settingsGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">⚙️ ${t('账户与配置')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📍', t('收货地址簿'), t('常用地址 · 一键填充'), '#addresses')}
      ${card('🆔', t('实名认证'), t('提升账户可信度'), '#kyc')}
      ${card('🚫', t('我的黑名单'), t('屏蔽不想看的人'), '#blocklist')}
      ${card('👁', t('公开主页'), '@' + (state.user.handle || state.user.name), '#u/' + state.user.id)}
      ${card('🏛', t('协议治理'), t('参数公开 · 变更可追溯'), '#governance')}
    </div>
  `

  // 顺序：我的购物 → 我的市场记录 → Agent 进阶 → 通信 → 信任与协议（条件显示）→ 公益折叠 → 账户与配置
  app.innerHTML = shell(mySubTabsHTML('dashboard') + header + notePromptPlaceholder('me') + shopGrid + marketGrid + aiGrid + commsGrid + trustGrid + socialGrid + charitySection + settingsGrid, 'me')
  hydrateNotePrompt('me')
}

// ─── #me 私人 hub ──────────────────────────────────────────────
// 2026-05-24 #me sticky sub-tab 助手 — Dashboard / 设置 / 高级
window.mySubTabsHTML = function(active) {
  const tab = (key, icon, label) => {
    const isActive = active === key
    return `<button onclick="navigate('#me${key === 'dashboard' ? '' : '/' + key}')" style="
      flex:1;background:${isActive ? '#4f46e5' : '#fff'};color:${isActive ? '#fff' : '#374151'};
      border:1px solid ${isActive ? '#4f46e5' : '#e5e7eb'};border-radius:99px;
      padding:8px 4px;font-size:12px;font-weight:600;cursor:pointer;
      display:flex;align-items:center;justify-content:center;gap:5px;min-width:0
    ">${icon}<span>${label}</span></button>`
  }
  return `<div style="display:flex;gap:6px;margin-bottom:14px;position:sticky;top:60px;z-index:5;background:rgba(249,250,251,0.95);backdrop-filter:blur(8px);padding:8px 0">
    ${tab('dashboard', '🏠', t('面板'))}
    ${tab('settings',  '⚙️', t('设置'))}
    ${tab('advanced',  '🚀', t('高级'))}
  </div>`
}

async function renderMyHome(app, subTab) {
  if (!state.user) { renderLogin(); return }
  subTab = subTab || 'dashboard'

  // settings / advanced sub-tabs 走独立 renderer
  if (subTab === 'settings') return renderMySettings(app)
  if (subTab === 'advanced') return renderMyAdvanced(app)

  // dashboard: 按角色分支（现有 renderer 内部会注入 mySubTabsHTML）
  app.innerHTML = shell(loading$(), 'me')
  const role = state.user.role
  const TRUSTED_ROLES = ['admin', 'verifier', 'logistics', 'arbitrator']
  if (TRUSTED_ROLES.includes(role)) {
    return renderTrustedMyHome(app, role)
  }
  if (role === 'seller') {
    return renderSellerMyHome(app)
  }
  if (role === 'buyer') {
    return renderBuyerMyHome(app)
  }

  // P1.3 修复：进入 #me 前主动刷新 cart + 通知 + 未读数
  try { refreshCartBadge() } catch {}
  try {
    const n = await GET('/notifications?unread=1').catch(() => null)
    if (n) state.unread = n.unread || 0
  } catch {}

  // 并行拉关键数据：wallet, charity, agent reputation, skills mine
  const [profileRes, charityRes, agentRes, skillsRes] = await Promise.all([
    GET('/profile').catch(e => ({ error: '_net_' })),
    GET('/charity/me').catch(e => ({ error: '_net_' })),
    GET('/agents/me/reputation').catch(() => null),
    GET('/skills/mine').catch(() => []),
  ])
  const profile = profileRes?.error ? null : profileRes
  const charity = charityRes?.error ? null : charityRes
  const agentRep = agentRes
  const mySkills = Array.isArray(skillsRes) ? skillsRes : []
  // P1.1 + P2.3 修复：NaN 兜底 + 显示加载错误
  const wal = { balance: Number(profile?.wallet?.balance || 0), staked: Number(profile?.wallet?.staked || 0) }
  const rep = charity?.reputation || {}
  const pendingRepays = (charity?.pending_repayments || []).length
  const loadErrors = []
  if (!profile) loadErrors.push(t('钱包'))
  if (!charity) loadErrors.push(t('慈善'))

  // P2.2 修复：长 sub 文本 ellipsis 避免高度跳动
  const card = (icon, label, sub, hash, badge) => `
    <div class="card" onclick="location.hash='${hash}'" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px;position:relative">
      <div style="font-size:24px;flex-shrink:0">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
        ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>` : ''}
      </div>
      ${badge ? `<div style="background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:2px 7px;min-width:18px;text-align:center;flex-shrink:0">${badge}</div>` : ''}
    </div>`

  // D3 Agent 仪表盘 widget — 我的 Agent 在做什么
  const skillCount = mySkills.length
  const activeSubs = mySkills.filter(s => s.subscribed_count > 0 || s.is_subscribed).length
  const agentLevel = agentRep?.level || 'new'
  const agentTrust = Math.round(agentRep?.trust_score || 0)
  const agentBandColor = { legend:'#dc2626', quality:'#9333ea', trusted:'#4f46e5', new:'#9ca3af' }[agentLevel] || '#6b7280'
  // 2026-05-24 agentDash 移除 — Advanced sub-tab heroAgent 已展示

  // 通用入口（通知 / 私信归"消息"tab 专管，此处不重复）
  const commonGrid = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('💰', t('钱包'), `${Number(wal.balance).toFixed(2)} WAZ`, '#wallet')}
      ${card('📦', t('订单'), t('我买我卖'), '#orders')}
      ${card('🌸', t('慈善许愿'), `${rep.badge_tier && rep.badge_tier !== 'none' ? rep.badge_tier + ' · ' : ''}${t('威望')} ${Number(rep.prestige_score||0).toFixed(0)}`, '#wishes', pendingRepays || '')}
      ${card('🏆', t('排行榜'), t('热门 / 创作者 / 威望'), '#leaderboard')}
    </div>
  `

  // 买家专属
  const buyerGrid = role === 'buyer' ? `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">📡 ${t('买家专区')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('📡', t('分享管理'), t('推广 / 邀请 / 佣金'), '#promoter')}
      ${card('🤖', t('AI 推荐'), t('给我推商品'), '#ai-recommend')}
      ${card('🛒', t('购物车'), state.cartCount ? `${state.cartCount} ${t('件')}` : t('空'), '#cart')}
      ${card('🤝', t('我关注'), t('卖家 / 商品'), '#follows')}
    </div>
  ` : ''

  // 卖家专属（上移：放通用前更显眼）
  const sellerGrid = role === 'seller' ? `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">🏪 ${t('卖家专区')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('💎', t('我的拍卖'), t('发布 / 中标记录'), '#auction/mine')}
      ${card('🌐', t('P2P 原生商店'), t('本地节点商品'), '#p2p-shop')}
      ${card('⚡', t('Skill 市场'), t('我的技能 / 订阅'), '#skills')}
      ${card('🤖', t('自动报价'), t('auto_bid 配置'), '#auto-bid')}
      ${card('📊', t('数据中心'), t('销售分析 / 趋势'), '#seller')}
      ${card('🎓', t('Skill 训练营'), t('如何高效使用'), '#skills')}
    </div>
  ` : ''

  // 本月统计折叠（所有角色）— 数据从已有 charity 接口取
  const monthlyStats = `
    <details style="margin-bottom:10px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
      <summary style="padding:10px 14px;cursor:pointer;font-size:13px;color:#374151;font-weight:600">📈 ${t('本月统计')}</summary>
      <div style="padding:8px 14px;border-top:1px solid #f3f4f6;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px;text-align:center">
        <div><div style="font-size:18px;font-weight:700;color:#4f46e5">${rep.wishes_made || 0}</div><div style="color:#9ca3af">${t('许愿')}</div></div>
        <div><div style="font-size:18px;font-weight:700;color:#dc2626">${rep.wishes_fulfilled || 0}</div><div style="color:#9ca3af">${t('圆梦')}</div></div>
        <div><div style="font-size:18px;font-weight:700;color:#9333ea">${Number(rep.donation_total||0).toFixed(1)}</div><div style="color:#9ca3af">${t('捐款 WAZ')}</div></div>
      </div>
    </details>
  `

  // 公开主页 + 设置 + 高级工具（所有角色）
  const settingsGrid = `
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">⚙️ ${t('账户')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${card('👁', t('公开主页'), '@' + (state.user.handle || state.user.name), '#u/' + state.user.id)}
      ${card('🏛', t('协议治理'), t('参数公开 · 变更可追溯'), '#governance')}
    </div>
  `

  const header = `
    <div class="card" style="padding:16px;margin-bottom:14px;background:linear-gradient(135deg,#eef2ff,#f0f9ff)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:28px">👤</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px">${escHtml(state.user.name || state.user.handle)}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">@${escHtml(state.user.handle || '')} · ${t({buyer:'买家',seller:'卖家',admin:'管理员',logistics:'物流',arbitrator:'仲裁',verifier:'审核员'}[role] || role)}</div>
        </div>
      </div>
      <div onclick="location.hash='#wallet'" style="cursor:pointer;padding:10px 12px;background:rgba(255,255,255,0.6);border-radius:8px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">${t('钱包余额')}</div>
          <div style="font-size:22px;font-weight:800;color:#3730a3;line-height:1.2">${Number(wal.balance).toFixed(2)} <span style="font-size:13px;font-weight:600">WAZ</span></div>
          ${wal.staked > 0 ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px">${t('已锁定')} ${Number(wal.staked).toFixed(2)} WAZ</div>` : ''}
        </div>
        <div style="font-size:18px;color:#4f46e5">→</div>
      </div>
    </div>
  `

  // P2.3 加载错误提示
  const errBanner = loadErrors.length > 0 ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:8px 12px;border-radius:8px;font-size:11px;margin-bottom:10px">
      ⚠ ${t('部分数据加载失败')}: ${loadErrors.join(' · ')} · <a href="javascript:renderMyHome(document.getElementById('app'))" style="color:#b91c1c;text-decoration:underline">${t('重试')}</a>
    </div>
  ` : ''
  // 卖家专区上移到 commonGrid 前；其他角色保持原顺序
  // Agent dash 始终在头部之下、内容区之上
  const sections = role === 'seller'
    ? header + errBanner + sellerGrid + commonGrid + monthlyStats + settingsGrid
    : header + errBanner + commonGrid + buyerGrid + monthlyStats + settingsGrid
  app.innerHTML = shell(mySubTabsHTML('dashboard') + sections, 'me')
}
