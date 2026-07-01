// WebAZ — Discover / Search / Feed domain (classic multi-script split, slice F / app-discover.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// Top-level functions / window.* handlers are global; these pages run only on
// route/click (after app.js loads), so cross-file globals (GET/POST/state/shell/
// escHtml/navigate/t/toast$/skeleton$/productImageGallery/feedActor/feedEmpty/
// pageHotFeedToggle/ensureProfileMini/...) resolve at call time. No import/export.
//
// Pure relocation of the browse/discover surfaces: shop entry + smart-buy header,
// the intent-driven #buy search flow, #discover + type/sort chips + feed views,
// #new arrivals, and #search results. Domain-only helpers move with them
// (buyResultCardHtml/computeBuyReasons/smartRecognitionLine/saveRecentSearch/
// searchByKeyword/productCardHtml). Platform-wide helpers (toast$/skeleton$/
// feedActor/feedEmpty/pageHotFeedToggle/ensureProfileMini/productImageGallery/…)
// and the profile/nearby/product-detail/cart/order surfaces stay in app.js.
//
// No money/order/payment/wallet/cart/dispute/status path. No UI/behavior change.

// ─── 商店页 ───────────────────────────────────────────────────

async function renderShop(app, opts = {}) {
  const activeTab = opts.expand ? 'agent-buy' : 'shop'
  app.innerHTML = shell(loading$(), activeTab)
  const products = await GET('/products')

  const grid = products.length === 0
    ? `<div class="empty"><div class="empty-icon">🛍️</div><div class="empty-text">${t('暂无商品')}</div></div>`
    : `<div class="product-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${escHtml(p.title)}</div>
              <div class="product-price">${p.price} <span style="font-size:11px;font-weight:400">WAZ</span></div>
              <div class="product-seller">${repBadge(p.rep_level)}@${escHtml(p.seller_name)}</div>
            </div>
          </div>`).join('')}
       </div>`

  const compactBanner = `
    <div onclick="navigate('#shop/agent')" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:12px;padding:14px 16px;margin-bottom:16px;cursor:pointer;display:flex;align-items:center;gap:12px">
      <span style="font-size:28px">🤖</span>
      <div>
        <div style="color:#fff;font-weight:600;font-size:14px">${t('智能下单')}</div>
        <div style="color:rgba(255,255,255,0.8);font-size:12px">${t('粘贴任意平台链接，AI 帮你找更优方案')}</div>
      </div>
      <span style="margin-left:auto;color:rgba(255,255,255,0.7);font-size:18px">›</span>
    </div>`

  const expandedAgentBuy = `
    <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,#eef2ff,#faf5ff);border-color:#c7d2fe">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:22px">🤖</span>
          <strong style="font-size:15px">${t('智能下单')}</strong>
        </div>
        <button class="btn btn-outline btn-sm" style="width:auto;padding:4px 10px" onclick="navigate('#shop')">${t('收起')}</button>
      </div>
      <p style="color:#6b7280;font-size:12px;margin-bottom:10px">${t('粘贴商品链接，AI 自动搜索 WebAZ 更优方案，可一键下单')}</p>
      <div class="form-group">
        <label class="form-label" style="font-size:12px">${t('商品链接')}</label>
        <input class="form-control" id="ab-url" placeholder="${t('粘贴淘宝 / 京东 / 亚马逊等链接')}" style="font-size:13px">
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:12px">${t('收货地址')}</label>
        <input class="form-control" id="ab-addr" placeholder="${t('省市区街道，用于自动下单')}" style="font-size:13px">
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <input type="checkbox" id="ab-auto" style="width:16px;height:16px">
        <label for="ab-auto" style="font-size:12px;cursor:pointer">${t('找到更优方案后自动下单（否则仅展示比价结果）')}</label>
      </div>
      <button class="btn btn-primary" id="ab-btn" onclick="doAgentBuy()">${t('开始分析')}</button>
      <div id="ab-result"></div>
    </div>`

  const agentBuyBanner = state.user?.role === 'buyer'
    ? (opts.expand ? expandedAgentBuy : compactBanner)
    : ''

  app.innerHTML = shell(`
    <h1 class="page-title">${t('发现好物')}</h1>
    ${agentBuyBanner}
    <div class="search-bar">
      <div class="search-input-wrap" id="search-wrap">
        <input class="search-input" id="search-inp" placeholder="${t('搜索 / 粘贴外链或分享文本')}" onkeydown="if(event.key==='Enter')doSearch()" oninput="toggleSearchClear()">
        <button type="button" class="search-clear" onclick="clearSearchInput()" aria-label="${t('清空')}">×</button>
      </div>
      <button class="btn btn-primary btn-sm" style="width:auto;padding:10px 12px" onclick="doSearch()" title="${t('一字不差完全匹配')}">${t('精准')}</button>
      <button class="btn btn-outline btn-sm" style="width:auto;padding:10px 12px" onclick="doFuzzySearch()" title="${t('部分匹配（命中≥50%）')}">${t('模糊')}</button>
    </div>
    <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#skills')">${t('⚡ Skill 市场')}</button>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#verify-tasks')">${t('🛡️ 验证任务')}</button>
    </div>
    <div id="product-list">${grid}</div>
  `, activeTab)
}

// ─── P10：智能购买 / 发现好物 / 新品发现 ─────────────────────

// 统一头部：输入框（左侧扫码 + 粘贴气泡 + 右侧清空 ×）+ 主搜索按钮 + 拍照搜图
// active='discover'/'new'/'nearby' → 发现页群组，placeholder 提示"模糊匹配"，预填上次搜索词
// active='buy' (default) → 智能下单页，placeholder 提示"精确匹配"
function renderSmartBuyHeader(active) {
  // 2026-05-24 #975：6 子页 + #buy 各自独立 scope（state key + placeholder + 输入 name）
  // autocomplete=off + 每个 scope 的 input name 唯一，阻断浏览器跨页 autofill / 历史合并
  const SCOPE = {
    buy:       { ph: '精确匹配：商品标题 / 外链 / 口令 / hash',         key: null,           name: 'webaz-q-buy' },
    discover:  { ph: '模糊搜索：标题 / 描述 / 类目 ｜ 精准匹配',          key: '_discoverQ',   name: 'webaz-q-discover' },
    new:       { ph: '搜新品：未成交的最新上架（标题 / 描述）',           key: '_newQ',        name: 'webaz-q-new' },
    nearby:    { ph: '在你 11km 雷达内搜：top 热门商品标题',              key: '_nearbyQ',     name: 'webaz-q-nearby' },
    auctions:  { ph: '在拍卖 + 二手内搜：标题 / 备注',                   key: '_aucQ',        name: 'webaz-q-auctions' },
    rfq:       { ph: '在求购单内搜：标题 / 备注',                        key: '_rfqQ',        name: 'webaz-q-rfq' },
    wishes:    { ph: '在许愿池内搜：标题 / 内容',                        key: '_wishQ',       name: 'webaz-q-wishes' },
  }
  const sc = SCOPE[active] || SCOPE.buy
  const placeholder = t(sc.ph)
  const prefill = sc.key ? (state[sc.key] || '') : ''
  const inputName = sc.name
  const isDiscover = active === 'discover' || active === 'new' || active === 'nearby'
  return `
    <div class="smart-buy-header" style="margin-bottom:14px">
      <div class="search-bar">
        <div class="search-input-wrap sbh-with-leading${prefill ? ' has-value' : ''}" id="sbh-search-wrap">
          <button type="button" class="sbh-leading-scan" onclick="startQrScan()" aria-label="${t('扫码')}" title="${t('扫码（二维码 / 条码）')}">${SVG_SCAN}</button>
          <input id="sbh-search-inp" class="search-input"
                 name="${inputName}"
                 autocomplete="off"
                 autocorrect="off"
                 autocapitalize="off"
                 spellcheck="false"
                 data-form-type="search"
                 data-1p-ignore="true"
                 placeholder="${placeholder}"
                 value="${escAttr(prefill)}"
                 onkeydown="if(event.key==='Enter')smartHeaderSearch()"
                 oninput="toggleSbhClear()"
                 onfocus="checkClipboardForSmartBuy()"
                 onblur="setTimeout(hidePasteFloat, 200)">
          <button type="button" id="sbh-paste-float" class="sbh-paste-float" onclick="usePasteHint()" style="display:none">
            ${SVG_PASTE}
            <span>${t('粘贴')}</span>
          </button>
          <button type="button" class="search-clear" onclick="clearSbhInput()" aria-label="${t('清空')}">×</button>
        </div>
        <button class="btn btn-primary btn-sm" style="width:auto;padding:10px 14px;display:inline-flex;align-items:center;justify-content:center" onclick="smartHeaderSearch()" title="${t('搜索')}">${SVG_SEARCH}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;padding:10px 12px;display:inline-flex;align-items:center;justify-content:center" onclick="startVisualSearch()" title="${t('拍照搜图')}">${SVG_CAMERA}</button>
        <input type="file" id="sbh-visual-file" accept="image/*" capture="environment" style="display:none" onchange="onVisualSearchPick(event)">
      </div>
      ${isDiscover && prefill ? `<div style="margin-top:6px;font-size:11px;color:var(--gray-500);display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span>🔎 ${t('正在筛选')}: <strong style="color:var(--gray-700)">${escHtml(prefill)}</strong>${state._discoverMatchMode === 'fuzzy' ? ` <span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:600;margin-left:4px">${t('模糊匹配')}</span>` : state._discoverMatchMode === 'strict' ? ` <span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:600;margin-left:4px">${t('精确匹配')}</span>` : ''}</span><button onclick="clearDiscoverQuery()" style="background:none;border:none;color:var(--primary);font-size:11px;cursor:pointer;padding:0">${t('清除筛选')}</button></div>` : ''}
    </div>`
}

// 拍照搜图 — 调原生相机或相册选图；后端 /api/ai/image-search 尚未实现，先把图片预填到 input 并提示
window.startVisualSearch = () => {
  const f = document.getElementById('sbh-visual-file')
  if (f) f.click()
}

window.onVisualSearchPick = async (e) => {
  const file = e.target.files?.[0]
  e.target.value = ''  // 允许同一文件再次选择
  if (!file) return
  // P0 占位：图像搜索后端待接入；先告知用户
  // 后续可改为 POST /api/ai/image-search (multipart) → 返回 candidates，渲染到 smart-results
  toast$(t('拍照搜图功能即将上线 — 已暂存图片：') + file.name)
}

// 剪贴板智能识别：输入框 focus 时尝试读 clipboard；命中则在输入框上方浮出"粘贴链接"按钮（iOS 风格）
window.checkClipboardForSmartBuy = async () => {
  if (window.__sbhPasteChecked) return
  window.__sbhPasteChecked = true
  if (!navigator.clipboard?.readText) return
  let txt = ''
  try { txt = (await navigator.clipboard.readText()).trim() } catch { return }
  if (!txt) return
  if (txt.length < 4 || txt.length > 500) return
  if (txt.split('\n').length > 3) return
  const inp = document.getElementById('sbh-search-inp')
  if (!inp) return
  if (inp.value.trim() === txt || inp.value.trim()) return  // 已有输入不打扰
  const isUrl = /^https?:\/\//i.test(txt) || /https?:\/\/\S+/i.test(txt)
  const looksLikeProduct = isUrl || /^[^\s,，。！？!?;；][一-龥\w\s\-+().×\/]{3,80}$/.test(txt)
  if (!looksLikeProduct) return
  window.__sbhPasteText = txt
  const fb = document.getElementById('sbh-paste-float')
  if (fb) {
    fb.title = (txt.length > 60 ? txt.slice(0, 60) + '…' : txt)
    fb.style.display = 'inline-flex'
    fb.classList.add('sbh-paste-float-in')
  }
}

window.hidePasteFloat = () => {
  const fb = document.getElementById('sbh-paste-float')
  if (fb) fb.style.display = 'none'
}

window.usePasteHint = () => {
  const txt = window.__sbhPasteText
  const inp = document.getElementById('sbh-search-inp')
  if (!inp || !txt) { hidePasteFloat(); return }
  inp.value = txt
  inp.dispatchEvent(new Event('input'))
  hidePasteFloat()
  window.__sbhPasteText = null
  smartHeaderSearch()
}

// 通用语音输入 helper — 复用 WebSpeech API，UI 通用化
window.startVoiceInput = (inputId, onResult) => {
  const SR = window.webkitSpeechRecognition || window.SpeechRecognition
  if (!SR) {
    // iOS Safari 没有 Web Speech API — 引导用户用系统键盘麦克风键（输入法栏）
    const inp = document.getElementById(inputId)
    if (inp) inp.focus()
    alert(t('此浏览器无内置语音 — 请点击输入框后用键盘上的 🎤 键说话'))
    return
  }
  const inp = document.getElementById(inputId)
  if (!inp) return
  const btn = document.getElementById('sbh-voice-btn') || document.querySelector(`button[onclick*="${inputId}"]`)
  const rec = new SR()
  rec.lang = (window._lang === 'en' ? 'en-US' : 'zh-CN')
  rec.interimResults = true
  rec.continuous = false
  if (btn) { btn.style.background = '#dc2626'; btn.style.color = '#fff'; btn.innerHTML = SVG_MIC_REC }
  rec.onresult = (e) => {
    let txt = ''
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript
    inp.value = txt
    inp.dispatchEvent(new Event('input'))
  }
  rec.onend = () => {
    if (btn) { btn.style.background = ''; btn.style.color = ''; btn.innerHTML = SVG_MIC }
    if (typeof onResult === 'function' && inp.value.trim()) setTimeout(onResult, 100)
  }
  rec.onerror = (e) => {
    if (btn) { btn.style.background = ''; btn.style.color = ''; btn.innerHTML = SVG_MIC }
    if (e.error === 'not-allowed') alert(t('请允许麦克风权限'))
  }
  try { rec.start() } catch (e) { console.warn('SR start failed', e) }
}

window.toggleSbhClear = () => {
  const inp = document.getElementById('sbh-search-inp')
  const wrap = document.getElementById('sbh-search-wrap')
  if (inp && wrap) wrap.classList.toggle('has-value', !!inp.value)
  // 用户开始输入 → 隐藏剪贴板悬浮按钮（不再打扰）
  if (inp && inp.value) hidePasteFloat()
}
window.clearSbhInput = () => {
  const inp = document.getElementById('sbh-search-inp')
  if (inp) { inp.value = ''; inp.focus(); toggleSbhClear() }
  // 发现/新品/附近：清掉 DOM 输入的同时也清掉 state 里的查询，否则切换 banner 会被 prefill 回来
  if (state._discoverQ) {
    state._discoverQ = ''
    const h = location.hash
    if (h.startsWith('#discover/new')) renderNewArrivals(document.getElementById('app'))
    else if (h.startsWith('#discover')) renderDiscover(document.getElementById('app'))
    else if (h.startsWith('#nearby'))   { try { renderNearby(document.getElementById('app')) } catch {} }
  }
}

// 清除当前发现页的模糊查询并重渲
window.clearDiscoverQuery = () => {
  state._discoverQ = ''
  if (location.hash.startsWith('#discover/new')) renderNewArrivals(document.getElementById('app'))
  else renderDiscover(document.getElementById('app'))
}

// 6-pill 顶部 banner 切换：换 tab 时清掉旧的模糊查询，避免不同板块互相串味
window.switchDiscoverBanner = (hash) => {
  state._discoverQ = ''
  location.hash = hash
}

// 从智能下单 "无精确匹配" → 一键带 query 跳发现页并触发模糊搜索
window.goDiscoverWithQuery = (q) => {
  state._discoverQ = String(q || '').trim()
  navigate('#discover')
}
window.smartHeaderSearch = () => {
  const raw = document.getElementById('sbh-search-inp')?.value?.trim() || ''
  const h = location.hash
  const app = document.getElementById('app')
  // 2026-05-24 #974：scoped 搜索路由表 — 每个域用各自 query state
  const scopeMap = [
    { test: h => h.startsWith('#discover/new'), key: '_newQ',      render: () => renderNewArrivals(app) },
    { test: h => h.startsWith('#discover'),     key: '_discoverQ', render: () => renderDiscover(app) },
    { test: h => h.startsWith('#nearby'),       key: '_nearbyQ',   render: () => { try { renderNearby(app) } catch {} } },
    { test: h => h.startsWith('#auctions/feed'),key: '_aucQ',      render: () => renderAuctionsFeed(app) },
    { test: h => h.startsWith('#auctions'),     key: '_aucQ',      render: () => renderAuctionBoard(app) },
    { test: h => h.startsWith('#secondhand'),   key: '_aucQ',      render: () => { _shFilters.q = state._aucQ || ''; renderSecondhandMarket(app) } },
    { test: h => h.startsWith('#rfq/new/feed'), key: '_rfqQ',      render: () => renderRfqFeed(app) },
    { test: h => h.startsWith('#rfq/new'),      key: '_rfqQ',      render: () => renderRfqCreate(app) },
    { test: h => h.startsWith('#rfqs'),         key: '_rfqQ',      render: () => renderRfqBoard(app) },
    { test: h => h.startsWith('#wishes/feed'),  key: '_wishQ',     render: () => renderWishesFeed(app) },
    { test: h => h.startsWith('#wishes'),       key: '_wishQ',     render: () => renderWishBoard(app) },
  ]
  const scope = scopeMap.find(s => s.test(h))

  // 空输入：清掉旧 query 重渲
  if (!raw) {
    if (scope) {
      const hadQuery = !!state[scope.key]
      state[scope.key] = ''
      if (hadQuery) scope.render()
    }
    return
  }
  // 智能下单 (#buy) → 协议级精确匹配
  if (h === '#buy' || h === '#' || h === '') {
    smartSearchExec(raw)
    return
  }
  // 域内搜索 — 留在本页过滤
  if (scope) {
    state[scope.key] = raw
    scope.render()
    return
  }
  // 其他页面 → 暂存 + 跳转 #buy
  sessionStorage.setItem('webaz_pending_search', raw)
  navigate('#buy')
}

// M7.1：智能下单 = 意图驱动 (intent-driven) 购买入口
// 删除 filter 面板（filter 是浏览工具，与 intent-driven 冲突）
// 删除批量粘贴 details（批量场景去 MCP / agent SDK）
// 页面只展示：搜索框 + 空状态引导 / 搜索结果
async function renderBuy(app) {
  app.innerHTML = shell(loading$(), 'buy')
  await ensureProfileMini()
  // 每次进 #buy 都重置剪贴板检查（不主动 read — 等输入框 focus 触发，符合浏览器手势策略）
  window.__sbhPasteChecked = false

  // 未登录 + 有分享 ctx → 顶部 hero banner（引导注册）
  const heroBanner = !state.user ? renderShareBanner('hero') : ''

  // 最近搜过（localStorage，最多 8 条）
  const recent = (() => {
    try { return JSON.parse(localStorage.getItem('webaz_recent_searches') || '[]').slice(0, 8) } catch { return [] }
  })()
  const recentChips = state.user && recent.length > 0 ? `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:#9ca3af;margin-bottom:6px">${t('最近搜过')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${recent.map(q => `<button onclick="repeatSearch(${JSON.stringify(q).replace(/"/g, '&quot;')})" style="padding:4px 10px;border-radius:99px;background:#f3f4f6;border:1px solid #e5e7eb;font-size:11px;color:#374151;cursor:pointer;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(q)}</button>`).join('')}
        <button onclick="clearRecentSearches()" style="padding:4px 10px;border-radius:99px;background:transparent;border:1px dashed #d1d5db;font-size:11px;color:#9ca3af;cursor:pointer">${t('清空')}</button>
      </div>
    </div>
  ` : ''

  // AI 助手快捷入口（仅登录）— 跳转 #ai-recommend 全屏页（深度对话/任务）
  // "让 AI 帮我搜" 入口已撤除（保留悬浮 🤖 FAB + 我的页 AI 推荐 tile 作为入口）
  const aiShortcut = ''

  app.innerHTML = shell(`
    ${heroBanner}
    ${notePromptPlaceholder('buy')}
    ${!state.user && readShareCtx()?.sponsor_id ? `<div style="margin-bottom:12px;text-align:center"><button class="btn btn-primary" onclick="location.hash='#login'">📝 ${t('注册解锁全部功能')}</button></div>` : ''}
    ${renderSmartBuyHeader('buy')}
    ${aiShortcut}
    ${recentChips}
    <div id="smart-results">${renderBuyEmptyState()}</div>
  `, 'buy')
  hydrateNotePrompt('buy')

  // 跨页搜索接续：上一页的 header 搜索 → 跳到 #buy 后取出执行
  const pending = sessionStorage.getItem('webaz_pending_search')
  if (pending) {
    sessionStorage.removeItem('webaz_pending_search')
    setTimeout(() => {
      const hdr = document.getElementById('sbh-search-inp')
      if (hdr) { hdr.value = pending; smartSearchExec(pending) }
    }, 80)
  }
}

// 识别回显行：让"系统把你的输入判定为哪种表达式"对用户可见（易懂）
// kind: keyword | url | anchor | hash；detail = 关键词 / 口令 code（会被转义）
function smartRecognitionLine(kind, detail) {
  const d = escHtml(String(detail || '').trim())
  const map = {
    keyword: '🔍 ' + t('按商品标题精确匹配') + (d ? ` 「${d}」` : ''),
    url:     '🔗 ' + t('识别为外部链接 · 正为你比价 WebAZ 同款'),
    anchor:  '🎫 ' + t('识别为达人口令') + (d ? ` @${d}` : '') + ' · ' + t('正在跳转 TA 推荐'),
    hash:    '🔖 ' + t('识别为内容指纹 · 正在打开来源验证'),
  }
  const txt = map[kind]
  if (!txt) return ''
  return `<div style="font-size:12px;color:#4338ca;background:#eef2ff;border:1px solid #e0e7ff;border-radius:8px;padding:8px 12px;margin-bottom:10px;line-height:1.5">${txt}</div>`
}

// 空状态：引导 intent + 求购单引导 + 隐性卖家入口（不主动推荐分发）
function renderBuyEmptyState() {
  const rfqTarget = !state.user ? '#login' : '#rfq/new'
  return `
    <div style="margin-top:20px">
      <div class="card" style="background:linear-gradient(135deg,#eef2ff 0%,#faf5ff 100%);border-color:#c7d2fe;padding:18px">
        <div style="font-size:15px;font-weight:700;color:#4338ca;margin-bottom:10px">🎯 ${t('智能下单 = 知道要买什么，帮你买')}</div>
        <div style="font-size:12px;color:#4b5563;line-height:1.8;margin-bottom:12px">
          · ${t('输入商品标题 → 直达对应商品下单')}<br>
          · ${t('粘贴外部链接 → WebAZ 同款推荐')}<br>
          · ${t('输入口令 @xxx → 跳到达人推荐的商品')}<br>
          · ${t('输入 P2P 内容 hash → 验证内容来源')}
        </div>
        <div style="font-size:11px;color:#9ca3af">${t('协议级承诺：不做模糊推测，不主动推荐分发')}</div>
      </div>

      <div style="margin-top:14px;padding:12px 14px;background:#fff;border:1px dashed #bfdbfe;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="font-size:12px;color:#1e40af;line-height:1.5">
          💬 ${t('找不到合适商品？发个求购单让卖家来抢')}
        </div>
        <a href="${rfqTarget}" style="font-size:12px;color:#1d4ed8;font-weight:600;text-decoration:none;white-space:nowrap">${t('发求购单 →')}</a>
      </div>

      <div style="margin-top:10px;padding:12px 14px;background:#fff;border:1px dashed #fde68a;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="font-size:12px;color:#78350f;line-height:1.5">
          🛒 ${t('你也想让你的商品出现在这里？')}
        </div>
        <a href="javascript:void(0)" onclick="goCreateListingFromBuy('')" style="font-size:12px;color:#92400e;font-weight:600;text-decoration:none;white-space:nowrap;cursor:pointer">${t('上架商品 →')}</a>
      </div>
    </div>`
}

// 无匹配状态：iOS 风极简 — 三层卡片：诚实告知 + 模糊搜索引导 + 上架 CTA
// 上架卡片只露最简引导，详细原因 / 步骤折叠到 <details> 里
function renderBuyNoMatchState(query) {
  const ctaLabel = !state.user ? t('注册并上架商品') : t('我也要上架商品')
  const safeQAttr = escAttr(String(query || '').trim())
  return `
    <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">

      ${smartRecognitionLine('keyword', query)}

      <!-- 1. 诚实告知（回显输入 + 友好解释）-->
      <div style="padding:14px 16px;background:#fff;border:0.5px solid #e5e7eb;border-radius:12px">
        <div style="font-size:15px;font-weight:600;color:#1f2937;margin-bottom:4px">${t('没找到完全一致的商品')}</div>
        <div style="font-size:12px;color:#8e8e93;line-height:1.5">${t('智能下单按商品标题精确匹配，该商品可能还没上架 — 试试下面两种方式。')}</div>
      </div>

      <!-- 2. 模糊搜索（次要 CTA） -->
      <button data-q="${safeQAttr}" onclick="goDiscoverWithQuery(this.dataset.q)" style="padding:14px 16px;background:#fff;border:0.5px solid #e5e7eb;border-radius:12px;display:flex;justify-content:space-between;align-items:center;width:100%;cursor:pointer;font:inherit;text-align:left">
        <div>
          <div style="font-size:14px;font-weight:500;color:#1f2937">${t('换个方式搜')}</div>
          <div style="font-size:12px;color:#8e8e93;margin-top:2px">${t('发现页支持模糊匹配')}</div>
        </div>
        <span style="color:#007aff;font-size:14px;font-weight:500">${t('去模糊搜索')} →</span>
      </button>

      <!-- 3. 上架 CTA（主推） — 极简化：标题 + 一句话 + 大按钮 + 折叠详情 -->
      <div style="padding:18px 16px 14px;background:#fff;border:0.5px solid #e5e7eb;border-radius:12px">
        <div style="font-size:15px;font-weight:600;color:#1f2937;margin-bottom:4px">${t('让你的商品也出现在这里')}</div>
        <div style="font-size:12px;color:#8e8e93;line-height:1.5;margin-bottom:14px">${t('上架后买家精准搜索时即可命中。')}</div>

        <button data-q="${safeQAttr}" onclick="goCreateListingFromBuy(this.dataset.q)" style="width:100%;padding:13px;background:#007aff;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;letter-spacing:0.1px">
          ${ctaLabel}
        </button>

        <details style="margin-top:12px">
          <summary style="font-size:12px;color:#007aff;cursor:pointer;list-style:none;text-align:center;padding:4px">${t('了解详情')}</summary>
          <div style="margin-top:12px;padding-top:12px;border-top:0.5px solid #f3f4f6">
            <div style="font-size:12px;font-weight:600;color:#1f2937;margin-bottom:6px">${t('为什么上架到 WebAZ')}</div>
            <div style="font-size:12px;color:#3c3c43;line-height:1.7;margin-bottom:12px">
              ${t('协议费仅 2% · 分享成交拿 commission · 链上稳定币直达 · Agent 自动比价命中')}
            </div>
            <div style="font-size:12px;font-weight:600;color:#1f2937;margin-bottom:6px">${t('上架只需 3 步')}</div>
            <div style="font-size:12px;color:#3c3c43;line-height:1.7">
              ${t('① 注册或登录（已登录可直接进卖家中心）')}<br>
              ${t('② 粘贴外部链接 → 系统自动提取标题、价格、alias')}<br>
              ${t('③ 设你的 WebAZ 价 → 一键上架（首单成交时自动锁定 stake）')}
            </div>
            <div style="font-size:11px;color:#8e8e93;margin-top:12px">${t('零月费 · 零上架成本 · 协议级买家保护（托管 + 仲裁 + 卖家信誉公开）')}</div>
          </div>
        </details>
      </div>

      ${query ? `<div style="font-size:11px;color:#8e8e93;text-align:center;margin-top:6px">${t('当前搜索')}：「${escHtml(query)}」 · ${t('换个关键词重试')}</div>` : ''}
    </div>`
}

// M7.1：智能识别 + 路由（URL → 比价；hex hash → P2P；关键词 → 精准搜索）
// 入口统一为 header 搜索框（id sbh-search-inp）；不再从 #smart-search textarea 读
window.repeatSearch = (q) => {
  const inp = document.getElementById('sbh-search-inp')
  if (inp) inp.value = q
  smartSearchExec(q)
}
window.clearRecentSearches = () => {
  localStorage.removeItem('webaz_recent_searches')
  renderBuy(document.getElementById('app'))
}
function saveRecentSearch(q) {
  if (!q || q.length < 2 || q.length > 100) return
  try {
    const arr = JSON.parse(localStorage.getItem('webaz_recent_searches') || '[]')
    const filtered = arr.filter(x => x !== q)
    filtered.unshift(q)
    localStorage.setItem('webaz_recent_searches', JSON.stringify(filtered.slice(0, 20)))
  } catch {}
}

window.smartSearchExec = async (overrideQuery) => {
  const raw = (overrideQuery || document.getElementById('sbh-search-inp')?.value || '').trim()
  const results = document.getElementById('smart-results')
  if (!results) return
  if (!raw) { results.innerHTML = renderBuyEmptyState(); return }
  saveRecentSearch(raw)

  const urls = extractUrls(raw)
  const addr = state.profileMini?.default_address_text

  // URL 比价（保留 agent-buy 流程；auto_buy 已删除 — 走默认 non-auto）
  if (urls.length > 0) {
    results.innerHTML = loading$()
    if (urls.length > 1) {
      results.innerHTML = `<div id="ab-result"></div>`
      await doBatchBuy(urls, addr || '', false)
    } else {
      const res = await POST('/agent-buy', { source_url: urls[0], shipping_address: addr || undefined, auto_buy: false })
      if (res.error) results.innerHTML = alert$('error', res.error)
      else { addPasteHistory(urls[0]); renderAgentBuyResultInto(results, res) }
    }
    return
  }

  // P2P 内容 hash
  if (/^[a-f0-9]{64}$/.test(raw)) {
    results.innerHTML = smartRecognitionLine('hash')
    toast$(t('识别为内容指纹 · 正在打开来源验证'))
    openNativeReview(raw)
    return
  }

  // 口令 anchor：以 @ 开头或长度 7-20 全字母数字（含数字）→ 跳 #anchor 走 lookup
  if (/^@[a-z0-9._]{6,20}$/i.test(raw)) {
    const code = raw.slice(1).toLowerCase()
    toast$(t('识别为达人口令') + ` @${code} · ` + t('正在跳转 TA 推荐'))
    navigate('#anchor?code=' + code)
    return
  }

  // 关键字搜索
  await searchByKeyword(raw)
}

function renderAgentBuyResultInto(container, res) {
  const recColor = { buy_webaz: '#16a34a', buy_source: '#2563eb', no_match: '#6b7280' }[res.recommendation] || '#6b7280'
  const recLabel = { buy_webaz: t('✅ 推荐 WebAZ 方案'), buy_source: t('🔗 建议继续在原平台购买'), no_match: t('😕 暂未找到合适替代') }[res.recommendation] || ''
  const bestCard = res.best_product ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;margin:12px 0">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px">${escHtml(res.best_product.title)}</div>
      <div style="font-size:18px;font-weight:700;color:#16a34a;margin-bottom:4px">${res.best_product.price} WAZ</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${escHtml(res.best_product.agent_summary || '')}</div>
      ${!res.auto_bought ? `<button class="btn btn-primary btn-sm" style="width:auto" onclick="navigate('#order-product/${res.best_product.id}')">${t('查看并下单')}</button>` : ''}
    </div>` : ''
  const orderCard = res.auto_bought ? `
    <div class="alert alert-success" style="margin-top:12px">
      <strong>${t('已自动下单！')}</strong> ${t('订单号')}：<a href="#order/${res.order_id}" style="color:#16a34a;font-weight:600">${res.order_id}</a><br>
      <span style="font-size:12px">${t('金额')}：${res.verified_price} WAZ ${t('（已从钱包托管）')}</span>
    </div>` : ''
  const altList = res.webaz_products?.length > 0 ? `
    <div style="margin-top:16px">
      <div style="font-size:12px;color:#9ca3af;margin-bottom:8px">${t('WebAZ 上的相关商品')}</div>
      ${res.webaz_products.map(p => `
        <div onclick="navigate('#order-product/${p.id}')" style="background:${p.url_match ? '#f0fdf4' : '#f9fafb'};border:1px solid ${p.url_match ? '#bbf7d0' : '#f3f4f6'};border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:13px;font-weight:500">${p.url_match ? '🎯 ' : ''}${escHtml(p.title)}</div>
            <div style="font-size:11px;color:#6b7280">${escHtml(p.agent_summary || '')}${p.url_match ? ` · <span style="color:#16a34a">${t('同款商品')}</span>` : ''}</div>
          </div>
          <div style="font-weight:700;color:#1d4ed8;white-space:nowrap;margin-left:8px">${p.price} WAZ</div>
        </div>`).join('')}
    </div>` : ''
  container.innerHTML = `
    ${smartRecognitionLine('url')}
    <div class="card" style="margin-top:12px">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px">${t('原商品')}：${escHtml(res.source?.title || '')}${res.source?.price_cny ? ` · ¥${res.source.price_cny}` : ''}</div>
      <div style="font-weight:700;font-size:15px;color:${recColor};margin-bottom:8px">${recLabel}</div>
      <div style="font-size:14px;line-height:1.5;color:#374151">${escHtml(res.reason || '')}</div>
      ${res.savings_note ? `<div style="font-size:12px;color:#16a34a;margin-top:4px">💰 ${escHtml(res.savings_note)}</div>` : ''}
      ${bestCard}${orderCard}${altList}
    </div>`
}

async function searchByKeyword(q) {
  state._lastSearchQ = q
  const results = document.getElementById('smart-results')
  results.innerHTML = loading$()
  // M7.1：精准匹配 — 不再带 category / max_price / handling 等 filter；仅 ship_to 仍 honor 地址（保证可派送）
  const ship_to = state.profileMini?.default_address_region || ''
  const qs = new URLSearchParams({ q })
  if (ship_to) qs.set('ship_to', ship_to)
  const filtered = await GET('/products?' + qs.toString())

  if (filtered.length === 0 && ship_to) {
    const all = await GET(`/products?q=${encodeURIComponent(q)}`)
    if (all.length > 0) {
      results.innerHTML = `
        ${smartRecognitionLine('keyword', q)}
        <div class="alert alert-warn" style="margin-top:12px">
          <strong>${t('找到')} ${all.length} ${t('个相关商品，但都无法派送到')} ${escHtml(ship_to)}</strong>
          <div style="font-size:11px;margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-outline btn-sm" style="width:auto;padding:4px 10px;font-size:11px" onclick="searchByKeywordNoFilterFromState()">${t('查看全部（含不可派送）')}</button>
            <a href="#profile" style="color:#4f46e5">${t('改默认地址')}</a>
          </div>
        </div>`
      return
    }
  }
  if (filtered.length === 0) {
    results.innerHTML = renderBuyNoMatchState(q)
    return
  }
  renderKeywordProducts(results, filtered, ship_to)
}

window.searchByKeywordNoFilter = async (q) => {
  state._lastSearchQ = q
  const results = document.getElementById('smart-results')
  results.innerHTML = loading$()
  const all = await GET(`/products?q=${encodeURIComponent(q)}`)
  if (all.length === 0) { results.innerHTML = renderBuyNoMatchState(q); return }
  renderKeywordProducts(results, all, null)
}

// M-1 fix：不再把 q 串入 onclick HTML（避免反射型 XSS），改读 state 里的最近搜索词
window.searchByKeywordNoFilterFromState = () => {
  const q = state._lastSearchQ || ''
  if (!q) return
  return window.searchByKeywordNoFilter(q)
}

// M7.1：三段式 result card — 商品信息 + 推荐理由（核心 + 折叠）+ 操作区
function renderKeywordProducts(container, products, ship_to) {
  container.innerHTML = `
    ${smartRecognitionLine('keyword', state._lastSearchQ || '')}
    <div style="margin-top:8px">
      <div style="font-size:11px;color:#6b7280;margin-bottom:10px">
        🎯 ${t('找到')} ${products.length} ${t('个精准匹配的商品')}${ship_to ? ` · ${t('可派送到')} ${escHtml(ship_to)}` : ''}
      </div>
      ${products.map(buyResultCardHtml).join('')}
    </div>`
}

// 单张三段式结果卡：商品基础信息 + 推荐理由（核心 3 条永显 + 折叠详情）+ 操作
function buyResultCardHtml(p) {
  // ── 推荐理由计算（M7.1 仅基于现有字段；M7.2 接 insights endpoint）──
  const reasons = computeBuyReasons(p)
  // 核心 3 条（永显）
  const coreReasons = reasons.slice(0, 3)
  // 折叠详情（其余）
  const moreReasons = reasons.slice(3)
  // 商品类型 badge
  const typeBadge = p.product_type && p.product_type !== 'retail'
    ? `<span style="display:inline-block;font-size:10px;background:#e0e7ff;color:#4338ca;padding:1px 7px;border-radius:99px;margin-left:6px">${t({ wholesale:'批发', service:'服务', digital:'数字' }[p.product_type] || p.product_type)}</span>`
    : ''
  // 稀缺
  const lowStockChip = p.low_stock > 0
    ? `<span style="display:inline-block;font-size:10px;background:#fee2e2;color:#dc2626;padding:1px 7px;border-radius:99px;margin-left:6px;font-weight:600">⚡ ${t('仅剩')} ${p.low_stock} ${t('件')}</span>`
    : ''
  // S5 性价比认证 chip
  const valueBadgeChip = Number(p.value_badge) === 1
    ? `<span style="display:inline-block;font-size:10px;background:linear-gradient(135deg,#fef9c3,#fde68a);color:#854d0e;padding:1px 7px;border-radius:99px;margin-left:6px;font-weight:600;border:1px solid #fcd34d" title="${t('极致性价比认证')} · ${t('类目第')} ${p.value_badge_rank || '?'} ${t('名')}">💎 ${t('性价比')}</span>`
    : ''

  return `
    <div class="card" style="margin-bottom:12px;padding:14px">
      <!-- ① 商品基础信息 -->
      <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:10px">
        <div style="font-size:36px;flex-shrink:0;line-height:1">${getCategoryIcon(p.category)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.4;margin-bottom:4px">${escHtml(p.title)}${typeBadge}${valueBadgeChip}${lowStockChip}</div>
          <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
            <span style="font-size:20px;font-weight:700;color:#4f46e5">${p.price}</span>
            <span style="font-size:11px;color:#6b7280">WAZ</span>
          </div>
          <div style="font-size:11px;color:#6b7280">
            ${repBadge(p.rep_level)} @${escHtml(p.seller_name)} · ${p.sales_count || 0} ${t('单完成')}
          </div>
        </div>
      </div>

      <!-- ② 推荐理由（核心永显 + 折叠详情）-->
      <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px;font-weight:600">🎯 ${t('推荐理由')}</div>
        ${coreReasons.length > 0
          ? coreReasons.map(r => `<div style="font-size:12px;color:${r.color || '#374151'};margin-bottom:4px;line-height:1.5">${r.icon || '✓'} ${r.text}</div>`).join('')
          : `<div style="font-size:11px;color:#9ca3af">${t('暂无明显推荐理由 — 协议级公平展示')}</div>`}
        ${moreReasons.length > 0 ? `
          <details style="margin-top:6px">
            <summary style="font-size:11px;color:#6366f1;cursor:pointer;list-style:none">▸ ${t('更多理由')} (${moreReasons.length})</summary>
            <div style="padding-top:6px;border-top:1px solid #e5e7eb;margin-top:6px">
              ${moreReasons.map(r => `<div style="font-size:11px;color:${r.color || '#6b7280'};margin-bottom:3px;line-height:1.5">${r.icon || '·'} ${r.text}</div>`).join('')}
            </div>
          </details>` : ''}
        <button disabled title="${t('M7.3 即将上线')}" style="margin-top:8px;font-size:11px;color:#9ca3af;background:#fff;border:1px dashed #d1d5db;border-radius:6px;padding:4px 10px;cursor:not-allowed">🔍 ${t('对推荐理由发起验证')} <span style="font-size:9px">(${t('即将上线')})</span></button>
      </div>

      <!-- ③ 操作区 -->
      <div style="display:flex;gap:8px">
        <button onclick="navigate('#order-product/${p.id}')" style="flex:1;padding:10px;background:#fff;color:#4f46e5;border:1.5px solid #4f46e5;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">👁 ${t('详情')}</button>
        <button onclick="navigate('#order-product/${p.id}')" style="flex:1;padding:10px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">🛒 ${t('立即下单')}</button>
      </div>
    </div>`
}

// M7.1 客户端推荐理由计算（基于现有 API 字段）
// M7.2 将接 /api/products/:id/insights，拿到更准确的对标 / 估算
function computeBuyReasons(p) {
  const reasons = []
  // ── 核心：价格优势（vs 外链 source_price）──
  if (p.source_price && p.source_price > p.price) {
    const save = Math.round((p.source_price - p.price) * 100) / 100
    const pct = Math.round((save / p.source_price) * 100)
    reasons.push({ icon: '💰', color: '#16a34a', text: `${t('比外部平台省')} ${save} WAZ (${pct}% ${t('优惠')})` })
  }
  // ── 核心：分享佣金估算 ──
  if (p.commission_rate && Number(p.commission_rate) > 0) {
    const l1 = Math.round(p.price * Number(p.commission_rate) * 0.70 * 100) / 100
    if (l1 > 0) reasons.push({ icon: '🔗', color: '#7c3aed', text: `${t('分享后可得 L1 佣金 ≈')} ${l1} WAZ` })
  }
  // ── 核心：协议保障 ──
  reasons.push({ icon: '🛡', text: t('资金托管 + 仲裁 + 卖家质押保障') })
  // ── 详情：商品成交 ──
  if (p.sales_count > 0) reasons.push({ icon: '🔥', text: `${p.sales_count} ${t('人真实购买')}` })
  // ── 详情：卖家信誉 ──
  if (p.rep_level && p.rep_level !== 'new') {
    const levelLabel = { trusted: t('可信'), quality: t('优质'), star: t('明星'), legend: t('传奇') }[p.rep_level] || p.rep_level
    reasons.push({ icon: '⭐', text: `${t('卖家信誉')}: ${levelLabel}` })
  }
  // ── 详情：退货 / 质保 ──
  if (p.return_days) reasons.push({ icon: '↩️', text: `${p.return_days} ${t('天无理由退货')}` })
  if (p.warranty_days && p.warranty_days > 0) reasons.push({ icon: '🔧', text: `${p.warranty_days} ${t('天质保')}` })
  // ── 详情：发货时效 ──
  if (p.handling_hours) reasons.push({ icon: '⏱', text: `${p.handling_hours} ${t('小时内发货')}` })
  // ── 详情：稀缺 ──
  if (p.low_stock > 0) reasons.push({ icon: '⚡', color: '#dc2626', text: `${t('仅剩')} ${p.low_stock} ${t('件 · 快速决策')}` })
  // [M7.2 接入]：creator unique_sharer_count / 历史最低价 / 同款卖家数 / 验证状态 / 个人化
  return reasons
}

async function renderDiscover(app) {
  app.innerHTML = shell(loading$(), 'discover')
  // 2026-05-24 迁移到 hash 路由（#discover = 好物 / #discover/feed = 动态）
  // 与其他 5 个子页一致，支持 URL 分享 + 浏览器后退
  const subTabs = pageHotFeedToggle('#discover', '#discover/feed')

  // goods — 里程碑 2：cursor 分页 + 加载更多 / 里程碑 5：sort chip / 里程碑 6：type chip
  // D4 智能默认：先用 state，再回退到 localStorage，再回退到默认
  const sort = state._discoverSort || (() => { try { return localStorage.getItem('webaz_pref_discover_sort') } catch { return null } })() || 'trending'
  const ptype = state._discoverType || (() => { try { return localStorage.getItem('webaz_pref_discover_type') } catch { return null } })() || 'retail'
  state._discoverSort = sort
  state._discoverType = ptype
  const dq = state._discoverQ || ''
  const qsBase = `has_sales=true&sort=${sort}&product_type=${ptype}${dq ? '&fuzzy=true&q=' + encodeURIComponent(dq) : ''}`
  const { items: products, cursor, matchMode } = await GET_WITH_CURSOR(`/products?${qsBase}`)
  state._discoverMatchMode = matchMode
  state._discoverCursor = cursor
  const grid = products.length === 0
    ? `<div class="empty"><div class="empty-icon">🌱</div><div class="empty-text">${t('还没有商品被成交')}</div><button class="btn btn-outline btn-sm" style="margin-top:12px;width:auto" onclick="navigate('#discover/new')">${t('看新品发现 →')}</button></div>`
    : `<div class="product-grid" id="discover-grid">
        ${products.map(p => productCardHtml(p, true)).join('')}
       </div>` + (cursor ? `<div id="discover-more" style="text-align:center;margin-top:16px"><button class="btn btn-outline" style="width:auto;padding:8px 24px" onclick="loadMoreDiscover('${qsBase}','discover-grid','discover-more')">${t('加载更多')}</button></div>` : '')
  // sectionStrip 已并入 discoverNavTabs 顶部 6-pill 横滑条，此处不再渲染独立第二行
  const sectionStrip = ''

  // sort + type 合并为可折叠 filter（默认折叠，sort 名 + type 名作摘要）
  const sortLabel = ({trending:'🔥 '+t('热门'), recommended:'📣 '+t('推荐多'), seller_win_rate:'⚖️ '+t('胜诉率'), newest:'🆕 '+t('最新'), rating:'⭐ '+t('信誉'), price_asc:'💰 '+t('价格 ↑'), random:'🎲 '+t('随机')}[sort]) || sort
  const typeLabel = ({retail:'🛍️ '+t('零售'), wholesale:'📦 '+t('批发'), service:'🛠️ '+t('服务'), digital:'💾 '+t('数字')}[ptype]) || ptype
  const filterPanel = `
    <details style="margin-bottom:10px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
      <summary style="padding:8px 12px;cursor:pointer;font-size:12px;color:#374151;display:flex;justify-content:space-between;align-items:center">
        <span>🔧 ${t('筛选')}</span>
        <span style="color:#6b7280;font-size:11px">${sortLabel} · ${typeLabel}</span>
      </summary>
      <div style="padding:8px 12px;border-top:1px solid #f3f4f6">
        ${renderSortChips(sort, 'discover')}
        ${renderTypeChips(ptype, 'discover')}
      </div>
    </details>
  `

  app.innerHTML = shell(`
    ${preLaunchBannerHTML()}
    ${renderSmartBuyHeader('discover')}
    ${discoverGoodsTabs('recommend')}
    ${subTabs}
    ${sectionStrip}
    ${filterPanel}
    <div style="font-size:11px;color:#9ca3af;margin-bottom:10px">
      ${t('只展示真实成交且好评推荐的内容，用户共建非平台算法推荐')}
    </div>
    <div id="product-list">${grid}</div>
    <div id="discover-sh-strip" style="margin-top:24px"></div>
  `, 'discover')
  // M8 非主流引入：在主商品 feed 之后，社交化呈现"邻里闲置"
  shInjectStrip('discover-sh-strip', { limit: 5 })

  // #1051 Schema.org ItemList — 搜索引擎可取作 SERP / 购物 agent 可一次读完前 20 个商品
  // #1053 每个 Product 加 inLanguage + name 多语言数组(i18n_titles 有别名时)
  try {
    setJsonLd({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'WebAZ Discover — verified-sales products',
      numberOfItems: products.length,
      itemListElement: products.slice(0, 20).map((pp, idx) => {
        const img = (pp.images || '').split(',').map(s => s.trim()).filter(s => /^(https?:|\/|data:)/.test(s))[0]
        const lang = pp._lang || 'zh'
        const titles = pp.i18n_titles && typeof pp.i18n_titles === 'object' ? pp.i18n_titles : {}
        const altCount = Object.entries(titles).filter(([k, v]) => k !== lang && v).length
        const nameField = altCount > 0
          ? [{ '@value': String(pp.title || ''), '@language': lang },
             ...Object.entries(titles).filter(([k, v]) => k !== lang && v).map(([k, v]) => ({ '@value': String(v), '@language': k }))]
          : pp.title
        return {
          '@type': 'ListItem',
          position: idx + 1,
          item: {
            '@type': 'Product',
            name: nameField,
            url: location.origin + '/#order-product/' + pp.id,
            ...(img ? { image: img } : {}),
            offers: { '@type': 'Offer', price: pp.price, priceCurrency: pp.currency || 'WAZ' },
          },
        }
      }),
    })
  } catch { /* never break the page */ }
}

// 里程碑 6：product_type chip
function renderTypeChips(active, ctx) {
  const opts = [
    { k: 'retail',    label: t('零售'),   icon: '🛍️' },
    { k: 'wholesale', label: t('批发'),   icon: '📦' },
    { k: 'service',   label: t('服务'),   icon: '🛠️' },
    { k: 'digital',   label: t('数字'),   icon: '💾' },
  ]
  return `
    <div style="display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
      ${opts.map(o => `
        <button onclick="setTypeChip('${ctx}','${o.k}')"
          style="white-space:nowrap;border:1px solid ${active===o.k?'#ea580c':'#e5e7eb'};background:${active===o.k?'#fff7ed':'#fff'};color:${active===o.k?'#ea580c':'#374151'};padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-weight:${active===o.k?'600':'400'}">
          <span style="margin-right:3px">${o.icon}</span>${o.label}
        </button>
      `).join('')}
    </div>`
}

window.setTypeChip = (ctx, ptype) => {
  if (ctx === 'discover') state._discoverType = ptype
  else if (ctx === 'new') state._newType = ptype
  // D4 智能默认：持久化
  try { localStorage.setItem('webaz_pref_' + ctx + '_type', ptype) } catch {}
  const app = document.getElementById('app')
  if (ctx === 'discover') renderDiscover(app)
  else if (ctx === 'new')  renderNewArrivals(app)
}

// 里程碑 5-d/e：sort chip row（横向）
// 2026-05-24 #977：ctx='new' 时 chip 标签 + hint 切换到卖家维度（新品本身无数据累计）
function renderSortChips(active, ctx) {
  const isNew = ctx === 'new'
  const opts = isNew ? [
    { k: 'trending',        label: t('热门卖家'),   icon: '🔥' },
    { k: 'recommended',     label: t('推荐卖家'),   icon: '📣' },
    { k: 'seller_win_rate', label: t('胜诉率'),    icon: '⚖️' },
    { k: 'newest',          label: t('最新'),     icon: '🆕' },
    { k: 'rating',          label: t('卖家信誉'),   icon: '⭐' },
    { k: 'price_asc',       label: t('价格 ↑'),   icon: '💰' },
    { k: 'random',          label: t('随机探索'), icon: '🎲' },
  ] : [
    { k: 'trending',        label: t('热门'),     icon: '🔥' },
    { k: 'recommended',     label: t('推荐多'),    icon: '📣' },
    { k: 'seller_win_rate', label: t('胜诉率'),    icon: '⚖️' },
    { k: 'newest',          label: t('最新'),     icon: '🆕' },
    { k: 'rating',          label: t('信誉'),     icon: '⭐' },
    { k: 'price_asc',       label: t('价格 ↑'),   icon: '💰' },
    { k: 'random',          label: t('随机探索'), icon: '🎲' },
  ]
  // 2026-05-24 P1-3：sort 解释文案 —— 让用户知道当前排序的依据
  const sortHint = isNew ? {
    trending:        t('卖家累计成交量降序（新品无产品级数据，按卖家维度）'),
    recommended:     t('卖家累计被推荐买家数（新品无产品级数据，按卖家维度）'),
    seller_win_rate: t('卖家历史争议胜诉率（越高越靠谱）'),
    newest:          t('按上架时间倒序'),
    rating:          t('卖家平均星级'),
    price_asc:       t('价格从低到高'),
    random:          t('完全随机 · 探索冷门新品'),
  }[active] : {
    trending:        t('近 7 天成交量 × 好评率，社区共建非平台算法'),
    recommended:     t('被推荐次数最多（达人 + 普通买家）'),
    seller_win_rate: t('卖家历史争议胜诉率（越高越靠谱）'),
    newest:          t('按上架时间倒序'),
    rating:          t('卖家平均星级'),
    price_asc:       t('价格从低到高'),
    random:          t('完全随机 · 探索冷门好物'),
  }[active]
  return `
    <div style="display:flex;gap:6px;margin-bottom:6px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
      ${opts.map(o => `
        <button onclick="setSortChip('${ctx}','${o.k}')"
          class="sort-chip"
          style="white-space:nowrap;border:1px solid ${active===o.k?'#4f46e5':'#e5e7eb'};background:${active===o.k?'#eef2ff':'#fff'};color:${active===o.k?'#4f46e5':'#374151'};padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-weight:${active===o.k?'600':'400'}">
          <span style="margin-right:3px">${o.icon}</span>${o.label}
        </button>
      `).join('')}
      ${active === 'random' ? `<button onclick="renderDiscover(document.getElementById('app'))" style="margin-left:4px;border:none;background:transparent;color:#4f46e5;font-size:12px;cursor:pointer">🔄 ${t('换一批')}</button>` : ''}
    </div>
    ${sortHint ? `<div style="font-size:10px;color:#9ca3af;margin-bottom:10px;padding-left:2px">ℹ️ ${sortHint}</div>` : ''}`
}

window.setSortChip = (ctx, sort) => {
  if (ctx === 'discover') state._discoverSort = sort
  else if (ctx === 'new') state._newSort = sort
  else if (ctx === 'search') state._searchSort = sort
  // D4 智能默认：持久化
  try { localStorage.setItem('webaz_pref_' + ctx + '_sort', sort) } catch {}
  const app = document.getElementById('app')
  if (ctx === 'discover')      renderDiscover(app)
  else if (ctx === 'new')       renderNewArrivals(app)
  else if (ctx === 'search' && state._lastSearchQ) searchByKeyword(state._lastSearchQ)
}

function productCardHtml(p, showSales) {
  // 里程碑 6: 类型标签 + 库存稀缺
  const typeBadge = p.product_type && p.product_type !== 'retail'
    ? `<span style="display:inline-block;font-size:9px;background:#e0e7ff;color:#4338ca;padding:1px 6px;border-radius:99px;margin-left:4px">${t({ wholesale:'批发', service:'服务', digital:'数字' }[p.product_type] || p.product_type)}</span>`
    : ''
  const lowStockBadge = p.low_stock > 0
    ? `<div style="font-size:11px;color:#dc2626;margin-top:3px;font-weight:600">⚡ ${t('仅剩')} ${p.low_stock} ${t('件')}</div>`
    : ''
  const trust = sellerTrustLine(p)
  // 排版规则：每行独立、可单独 ellipsis，长字符不会挤压相邻信息
  //  L1 title (CSS 已限 2 行 ellipsis)
  //  L2 price + WAZ
  //  L3 @sellerName    ← 单独一行，ellipsis 保护
  //  L4 ⭐可信 · 12 单  ← 信誉行，浅灰
  //  L5 🔥 3 已购 · 📣 3 推荐  ← 销量信号，绿字
  return `<div class="product-card" onclick="navigate('#order-product/${p.id}')">
    <div class="product-img">${getCategoryIcon(p.category)}</div>
    <div class="product-body">
      <div class="product-name">${escHtml(p.title)}${typeBadge}</div>
      <div class="product-price">${p.price} <span style="font-size:11px;font-weight:400">WAZ</span></div>
      <div class="product-seller">${t('卖家')}：@${escHtml(p.seller_name)}</div>
      ${p.seller_created_at ? `<div style="font-size:10px;color:#9ca3af;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t('入驻时长')}：${joinDuration(p.seller_created_at)}</div>` : ''}
      ${trust ? `<div style="font-size:10px;color:#6b7280;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${trust}</div>` : ''}
      ${lowStockBadge}
      ${p.trial_quota_remaining > 0 ? `<div style="font-size:11px;color:#9333ea;margin-top:3px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🎁 ${t('测评免单 剩')} ${p.trial_quota_remaining} ${t('名额')}</div>` : ''}
      ${showSales ? (() => {
        const sales = Number(p.sales_count) || 0
        const rec = Number(p.recommend_count) || 0
        const pct = sales > 0 ? Math.min(100, Math.round((rec / sales) * 100)) : null
        return `<div style="font-size:11px;color:#16a34a;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🔥 ${sales} ${t('已购')}${rec > 0 ? ` · 📣 ${rec} ${t('推荐')}` : ''}${pct !== null ? ` · ${t('推荐比例')}：${pct}%` : ''}</div>`
      })() : ''}
    </div>
  </div>`
}

window.loadMoreDiscover = async (qsBase, gridId, moreId) => {
  const grid = document.getElementById(gridId)
  const moreWrap = document.getElementById(moreId)
  if (!grid || !state._discoverCursor) return
  if (moreWrap) moreWrap.innerHTML = `<span style="font-size:12px;color:#9ca3af">${t('加载中…')}</span>`
  const { items, cursor } = await GET_WITH_CURSOR(`/products?${qsBase}&cursor=${encodeURIComponent(state._discoverCursor)}`)
  state._discoverCursor = cursor
  const showSales = qsBase.includes('has_sales=true')
  grid.insertAdjacentHTML('beforeend', items.map(p => productCardHtml(p, showSales)).join(''))
  if (cursor) {
    if (moreWrap) moreWrap.innerHTML = `<button class="btn btn-outline" style="width:auto;padding:8px 24px" onclick="loadMoreDiscover('${qsBase}','${gridId}','${moreId}')">${t('加载更多')}</button>`
  } else if (moreWrap) {
    moreWrap.innerHTML = `<span style="font-size:12px;color:#9ca3af">${t('没有更多了')}</span>`
  }
}

// 2026-05-24 setDiscoverTab 兼容旧调用 — 改路由跳转
window.setDiscoverTab = (k) => {
  navigate(k === 'feed' ? '#discover/feed' : '#discover')
}

// 2026-05-24 推荐好物 · 动态 view（独立 renderer，与其他子页一致）
async function renderDiscoverFeed(app) {
  state.feedScope = state.feedScope || 'all'
  app.innerHTML = shell(`
    ${renderSmartBuyHeader('discover')}
    ${discoverGoodsTabs('recommend')}
    ${pageHotFeedToggle('#discover', '#discover/feed')}
    <div id="feed-view">${loading$()}</div>
  `, 'discover')
  await renderFeedView()
}

// 📡 动态 — 3 sub: 全网事件流 / 关注事件流 / 排行榜（多维度聚合）
async function renderFeedView() {
  const scope = state.feedScope || 'all'   // 'all' | 'following' | 'rank'
  const view = document.getElementById('feed-view')
  if (!view) return
  const scopePill = (k, icon, label) => {
    const active = scope === k
    return `<button class="btn ${active ? 'btn-primary' : 'btn-outline'} btn-sm" style="width:auto;padding:5px 14px;font-size:12px" onclick="setFeedScope('${k}')">${icon} ${label}</button>`
  }
  const scopeTabs = `
    <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
      ${scopePill('all',       '🌐', t('全网'))}
      ${scopePill('following', '👥', t('我关注的'))}
      ${scopePill('rank',      '🏆', t('排行榜'))}
    </div>`

  // 排行榜 sub：4 mini 榜单聚合渲染
  if (scope === 'rank') {
    view.innerHTML = scopeTabs + `<div id="feed-rank-body">${loading$()}</div>`
    await renderFeedRanks()
    return
  }

  // D3 笔记 strip — 顶部显示热门笔记（点 navigate 跳 #note/<id>）
  // following 模式拉关注的人的笔记；其它模式拉 trending
  const noteSort = scope === 'following' ? 'following' : 'trending'
  let notesStrip = ''
  try {
    const nr = await fetch('/api/notes?sort=' + noteSort + '&limit=8', {
      headers: state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {},
    }).then(x => x.json())
    if (Array.isArray(nr?.items) && nr.items.length > 0) {
      notesStrip = `
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="font-size:13px;font-weight:600;color:#1f2937">📝 ${t('笔记')}</div>
          <button class="btn btn-link" style="background:none;border:none;font-size:11px;color:#4f46e5;padding:0;cursor:pointer" onclick="navigate('#shares')">${t('全部 →')}</button>
        </div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;margin-bottom:14px;scroll-snap-type:x mandatory">
          ${nr.items.map(n => `
            <div style="flex:0 0 140px;scroll-snap-align:start;cursor:pointer" onclick="navigate('#note/${n.id}')">
              ${n.first_photo
                ? `<img src="/api/notes/photo/${n.first_photo}" style="width:140px;height:140px;border-radius:8px;object-fit:cover">`
                : `<div style="width:140px;height:140px;border-radius:8px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:36px">📝</div>`}
              <div style="font-size:11px;color:#374151;margin-top:4px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.3">${escHtml(n.title || n.body_excerpt)}</div>
              <div style="font-size:10px;color:#9ca3af;margin-top:2px">@${escHtml(n.owner_handle || 'anon')} · ❤️ ${n.stats.likes || 0}</div>
            </div>`).join('')}
        </div>`
    }
  } catch {}

  // 事件流 sub（全网 / 关注）
  const data = await GET(`/feed?scope=${scope}`)
  const events = data.events || []
  if (events.length === 0 && !notesStrip) {
    view.innerHTML = `${scopeTabs}<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">${scope === 'following' ? t('你关注的人还没有动态 — 去关注一些活跃用户') : t('暂无动态')}</div></div>`
    return
  }
  if (events.length === 0) {
    view.innerHTML = `${scopeTabs}${notesStrip}<div style="text-align:center;color:#9ca3af;font-size:12px;padding:14px">${t('暂无其他动态')}</div>`
    return
  }
  const html = events.map(e => {
    let extra = {}
    try { extra = e.extra ? JSON.parse(e.extra) : {} } catch (_) {}
    const ts = fmtTime(e.ts)
    const actor = `<button onclick="toggleFollow('${e.actor_id}', this)" class="feed-actor" style="background:none;border:none;color:#4f46e5;font-weight:600;cursor:pointer;padding:0">${escHtml(e.actor_name || '—')}</button>`
    let body = ''
    if (e.kind === 'purchase') {
      body = `${actor} ${t('购买了')} <a href="#order-product/${e.product_id}" style="color:#111">${escHtml(e.product_title)}</a> · ${e.price} WAZ`
    } else if (e.kind === 'commission') {
      const amount = Number(extra.amount || 0).toFixed(2)
      body = `${actor} ${t('因推广')} <a href="#order-product/${e.product_id}" style="color:#111">${escHtml(e.product_title)}</a> ${t('获得 L')}${extra.level} ${t('佣金')} <strong style="color:#059669">+${amount} WAZ</strong>`
    } else if (e.kind === 'join_binary') {
      // pre-public 去左右码:活动流不再广播左/右区,只显示加入了某人的积分树
      body = `${actor} ${t('加入了')} ${escHtml(extra.placement_name || '—')} ${t('的积分树')}`
    }
    const icon = e.kind === 'purchase' ? '🛒' : e.kind === 'commission' ? '💰' : '⚛'
    return `<div class="card" style="margin-bottom:8px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start">
      <div style="font-size:20px">${icon}</div>
      <div style="flex:1;font-size:13px;line-height:1.5">
        ${body}
        <div style="font-size:11px;color:#9ca3af;margin-top:2px">${ts}</div>
      </div>
    </div>`
  }).join('')
  view.innerHTML = scopeTabs + notesStrip + html
}

// 排行榜 sub：4 mini 板块（商品 / 卖家 / 创作者 / 买家），每个 Top 5 + 查看完整 →
async function renderFeedRanks() {
  const body = document.getElementById('feed-rank-body')
  if (!body) return
  const [products, sellers, creators, buyers] = await Promise.all([
    GET('/leaderboard?kind=products&limit=5').catch(() => ({ items: [] })),
    GET('/leaderboard?kind=sellers&limit=5').catch(() => ({ items: [] })),
    GET('/leaderboard?kind=creators&limit=5').catch(() => ({ items: [] })),
    GET('/leaderboard?kind=buyers&limit=5').catch(() => ({ items: [] })),
  ])
  const rankLine = (rank, label, sub, hash) => `
    <div onclick="location.hash='${hash}'" style="display:flex;gap:8px;align-items:center;padding:6px 0;cursor:pointer;border-bottom:1px solid #f3f4f6">
      <div style="font-size:11px;font-weight:700;color:${rank <= 3 ? '#dc2626' : '#9ca3af'};width:18px;text-align:center;flex-shrink:0">${rank}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(label)}</div>
        <div style="font-size:10px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub}</div>
      </div>
    </div>`
  const miniCard = (icon, title, kind, items, lineMaker) => `
    <div class="card" style="padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:13px;font-weight:700">${icon} ${title}</div>
        <a href="#leaderboard?kind=${kind}" style="font-size:11px;color:#6366f1;text-decoration:none">${t('完整榜单')} →</a>
      </div>
      ${items.length === 0 ? `<div style="text-align:center;color:#9ca3af;font-size:12px;padding:12px 0">${t('暂无数据')}</div>` : items.map((it, i) => lineMaker(it, i + 1)).join('')}
    </div>`

  body.innerHTML = ''
    + miniCard('🔥', t('热门商品'), 'products', products.items || [], (it, r) =>
        rankLine(r, it.title, `${Number(it.completion_count||0)} ${t('单')} · ${Number(it.recommend_count||0)} ${t('人推荐')} · ${it.price} WAZ`, `#order-product/${it.id}`))
    + miniCard('🏪', t('卖家榜'), 'sellers', sellers.items || [], (it, r) =>
        rankLine(r, '@' + (it.handle || it.name || ''), `${it.rating_count > 0 ? '⭐ ' + Number(it.avg_rating).toFixed(1) + ' (' + it.rating_count + ')' : t('暂无评价')} · ${Number(it.orders_count||0)} ${t('单')}`, `#shop/${it.id}`))
    + miniCard('📣', t('创作者榜'), 'creators', creators.items || [], (it, r) =>
        rankLine(r, '@' + (it.handle || it.name || ''), `${Number(it.products_shared||0)} ${t('个商品')} · ${Number(it.total_likes||0)} ${t('赞')}`, `#u/${it.id}`))
    + miniCard('🛍', t('买家榜'), 'buyers', buyers.items || [], (it, r) =>
        rankLine(r, '@' + (it.handle || it.name || ''), `${Number(it.orders_count||0)} ${t('单')}`, `#u/${it.id}`))
}

window.setFeedScope = (k) => {
  state.feedScope = k
  renderFeedView()
}

// 2026-05-24 P1-4：新品发现时段 chip + #987：测评免单 chip（并列，可叠加筛选）
function renderNewDaysChips(active, trialOnly) {
  const opts = [
    { k: '',  label: t('全部') },
    { k: 1,   label: t('今日') },
    { k: 3,   label: t('3 天内') },
    { k: 7,   label: t('7 天内') },
  ]
  return `
    <div style="display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
      ${opts.map(o => `
        <button onclick="setNewDays('${o.k}')"
          style="flex:0 0 auto;white-space:nowrap;border:1px solid ${active===o.k?'#0891b2':'#e5e7eb'};background:${active===o.k?'#ecfeff':'#fff'};color:${active===o.k?'#0891b2':'#374151'};padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-weight:${active===o.k?'600':'400'}">
          ${o.label}
        </button>
      `).join('')}
      <button onclick="setNewTrialOnly(${!trialOnly})"
        style="flex:0 0 auto;white-space:nowrap;border:1px solid ${trialOnly?'#9333ea':'#e5e7eb'};background:${trialOnly?'#faf5ff':'#fff'};color:${trialOnly?'#7e22ce':'#374151'};padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-weight:${trialOnly?'600':'400'}">
        🎁 ${t('测评免单')}
      </button>
    </div>`
}
window.setNewDays = (val) => {
  state._newDays = val === '' ? '' : Number(val)
  renderNewArrivals(document.getElementById('app'))
}
window.setNewTrialOnly = (val) => {
  state._newTrialOnly = !!val
  renderNewArrivals(document.getElementById('app'))
}

async function renderNewArrivals(app) {
  app.innerHTML = shell(loading$(), 'discover')
  const sort = state._newSort || 'newest'
  const ptype = state._newType || 'retail'
  // 2026-05-24 P1-4：时段 chip — '' = 全部 / 1 / 3 / 7
  const days = state._newDays != null ? state._newDays : ''
  const trialOnly = !!state._newTrialOnly
  // 2026-05-24 #975：独立 scope state（_newQ），不再共用 _discoverQ
  const dq = state._newQ || ''
  const qsBase = `has_sales=false&sort=${sort}&product_type=${ptype}${days ? '&since_days=' + days : ''}${trialOnly ? '&has_trial=true' : ''}${dq ? '&fuzzy=true&q=' + encodeURIComponent(dq) : ''}`
  const { items: products, cursor } = await GET_WITH_CURSOR(`/products?${qsBase}`)
  state._discoverCursor = cursor
  const grid = products.length === 0
    ? emptyState('📦', t('暂无新品'))
    : `<div class="product-grid" id="new-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${escHtml(p.title)}</div>
              <div class="product-price">${p.price} <span style="font-size:11px;font-weight:400">WAZ</span></div>
              <div class="product-seller">${repBadge(p.rep_level)}@${escHtml(p.seller_name)}</div>
              ${p.trial_quota_remaining > 0
                ? `<div style="font-size:11px;color:#9333ea;margin-top:4px;font-weight:600">🎁 ${t('测评免单 剩')} ${p.trial_quota_remaining} ${t('名额')}</div>`
                : `<div style="font-size:11px;color:#f59e0b;margin-top:4px">🆕 ${t('等待第一位买家')}</div>`}
            </div>
          </div>`).join('')}
       </div>` + (cursor ? `<div id="new-more" style="text-align:center;margin-top:16px"><button class="btn btn-outline" style="width:auto;padding:8px 24px" onclick="loadMoreDiscover('${qsBase}','new-grid','new-more')">${t('加载更多')}</button></div>` : '')
  app.innerHTML = shell(`
    ${renderSmartBuyHeader('new')}
    ${discoverGoodsTabs('new')}
    ${pageHotFeedToggle('#discover/new', '#discover/new/feed', { hotIcon: '🆕', hotLabel: t('新品') })}
    <div style="font-size:12px;color:var(--gray-500);margin-bottom:14px;line-height:1.5">${t('卖家最新上架、尚无成交 — 成为第一位发现者和传播者')}</div>
    ${renderNewDaysChips(days, trialOnly)}
    ${renderSortChips(sort, 'new')}
    ${renderTypeChips(ptype, 'new')}
    <div id="product-list">${grid}</div>
  `, 'discover')
}

// 2026-05-24 新品发现 · 动态：最近上架时间线（@user 上架了 [商品] X 分钟前）
async function renderNewArrivalsFeed(app) {
  app.innerHTML = shell(loading$(), 'discover')
  const { items } = await GET_WITH_CURSOR('/products?sort=newest&has_sales=false&product_type=retail&limit=30')
  const products = items || []
  const body = products.length === 0
    ? feedEmpty('🆕', t('暂无新品动态'), t('看看 推荐好物'), '#discover')
    : products.map(p => {
        const ts = fmtTime(p.created_at)
        const img = window.productThumbSrc(p.images)
        return `<div class="card" style="margin-bottom:8px;padding:12px;display:flex;gap:10px;align-items:flex-start;cursor:pointer" onclick="navigate('#order-product/${p.id}')">
          ${img ? `<img src="${escAttr(img)}" onerror="this.outerHTML='📦'" style="width:56px;height:56px;border-radius:6px;object-fit:cover;flex-shrink:0">` : `<div style="width:56px;height:56px;border-radius:6px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0">${getCategoryIcon(p.category)}</div>`}
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;line-height:1.5">
              ${feedActor(p.seller_id, p.seller_name, p.seller_handle)} ${t('上架了')} <strong>${escHtml(p.title)}</strong>
            </div>
            <div style="font-size:11px;color:#9ca3af;margin-top:4px">${p.price} WAZ · ${ts}</div>
          </div>
        </div>`
      }).join('')
  app.innerHTML = shell(`
    ${renderSmartBuyHeader('new')}
    ${discoverGoodsTabs('new')}
    ${pageHotFeedToggle('#discover/new', '#discover/new/feed', { hotIcon: '🆕', hotLabel: t('新品') })}
    <h2 style="font-size:16px;font-weight:700;margin:14px 0 10px">📡 ${t('新品动态')}</h2>
    <div style="font-size:11px;color:#6b7280;margin-bottom:14px">${t('卖家最新上架按时间倒序 · 点击进入商品')}</div>
    ${body}
  `, 'discover')
}

window.toggleSearchClear = () => {
  const inp = document.getElementById('search-inp')
  const wrap = document.getElementById('search-wrap')
  if (!inp || !wrap) return
  wrap.classList.toggle('has-value', !!inp.value)
}
window.clearSearchInput = () => {
  const inp = document.getElementById('search-inp')
  if (!inp) return
  inp.value = ''
  inp.focus()
  window.toggleSearchClear()
}

function renderSearchResults(products, banner, q) {
  const grid = products.length === 0
    ? `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-text">${t('没有找到"')}${q.slice(0, 30)}"</div></div>`
    : `<div class="product-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${escHtml(p.title)}</div>
              <div class="product-price">${p.price} WAZ</div>
              <div class="product-seller">${repBadge(p.rep_level)}@${escHtml(p.seller_name)}</div>
            </div>
          </div>`).join('')}
       </div>`
  document.getElementById('product-list').innerHTML = banner + grid
}

window.doSearch = async () => {
  const q = document.getElementById('search-inp').value.trim()
  if (!q) return
  document.getElementById('product-list').innerHTML = loading$()

  // 精准搜索：所有输入统一走 /search-by-link，由后端按分享精准链路（external_id / external_title / product_title）判定。
  const resp = await POST('/search-by-link', { text: q })
  const products = resp.products || []
  const m   = resp.matched_by
  const ext = resp.extracted || {}
  const plat = ext.platform ? `${ext.platform}` : t('外部平台')
  let banner = ''
  if (m === 'external_id')               banner = `<div class="alert alert-success" style="margin-bottom:12px">✓ ${t('通过')} ${plat} ${t('商品 ID 精确匹配到')} ${products.length} ${t('件')}</div>`
  else if (m === 'external_title_exact') banner = `<div class="alert alert-success" style="margin-bottom:12px">✓ ${t('通过外链标题完全匹配到')} ${products.length} ${t('件')}</div>`
  else if (m === 'product_title_exact')  banner = `<div class="alert alert-success" style="margin-bottom:12px">✓ ${t('通过商品标题完全匹配到')} ${products.length} ${t('件')}</div>`
  else if (resp.unsupported_format)      banner = `<div class="alert alert-warn" style="margin-bottom:12px">⚠️ ${resp.hint}</div>`
  else                                    banner = `<div class="alert" style="margin-bottom:12px">${t('精准搜索未命中（需一字不差）。可改用「模糊」按钮做部分匹配。')}</div>`
  renderSearchResults(products, banner, q)
}

window.doFuzzySearch = async () => {
  const q = document.getElementById('search-inp').value.trim()
  if (!q) return
  document.getElementById('product-list').innerHTML = loading$()
  let data = {}
  try {
    const r = await fetch('/api/search-fuzzy?q=' + encodeURIComponent(q))
    data = await r.json()
  } catch (e) {
    data = { products: [] }
  }
  const products = Array.isArray(data.products) ? data.products : []
  const banner = products.length
    ? `<div class="alert" style="margin-bottom:12px">🔍 ${t('模糊匹配到')} ${products.length} ${t('件')}（${t('命中≥')}${Math.round((data.score_threshold || 0.5) * 100)}%）</div>`
    : `<div class="alert" style="margin-bottom:12px">${t('模糊搜索也没找到。试试更短的关键词。')}</div>`
  renderSearchResults(products, banner, q)
}
