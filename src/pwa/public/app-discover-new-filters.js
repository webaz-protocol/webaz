// New-arrivals filter controls. Loaded after app-discover.js; classic-script globals resolve at call time.
function renderNewDaysChips(active, trialOnly) {
  const opts = [
    { k: '', label: t('全部') }, { k: 1, label: t('今日') },
    { k: 3, label: t('3 天内') }, { k: 7, label: t('7 天内') },
  ]
  return `<div style="display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
    ${opts.map(o => `<button onclick="setNewDays('${o.k}')" style="flex:0 0 auto;white-space:nowrap;border:1px solid ${active===o.k?'#0e7490':'#e5e7eb'};background:${active===o.k?'#ecfeff':'#fff'};color:${active===o.k?'#0e7490':'#374151'};padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-weight:${active===o.k?'600':'400'}">${o.label}</button>`).join('')}
    <button onclick="setNewTrialOnly(${!trialOnly})" style="flex:0 0 auto;white-space:nowrap;border:1px solid ${trialOnly?'#9333ea':'#e5e7eb'};background:${trialOnly?'#faf5ff':'#fff'};color:${trialOnly?'#7e22ce':'#374151'};padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-weight:${trialOnly?'600':'400'}">🎁 ${t('测评免单')}</button>
  </div>`
}

function renderNewFilterPanel(days, trialOnly, sort, ptype) {
  const daysLabel = ({ 1: t('今日'), 3: t('3 天内'), 7: t('7 天内') })[days] || t('全部')
  const sortLabel = ({
    trending: t('热门卖家'), recommended: t('推荐卖家'), seller_win_rate: t('胜诉率'),
    newest: t('最新'), rating: t('卖家信誉'), price_asc: t('价格 ↑'), random: t('随机探索'),
  })[sort] || sort
  const typeLabel = ({ retail: t('零售'), wholesale: t('批发'), service: t('服务'), digital: t('数字') })[ptype] || ptype
  return `<details id="new-arrivals-filters" class="discover-filter-panel discover-filter-panel--new" ${state._newFiltersOpen ? 'open' : ''} ontoggle="state._newFiltersOpen=this.open">
    <summary><span class="discover-filter-title">${t('筛选')}</span>
      <span class="discover-filter-values"><span>${daysLabel}</span><span>${sortLabel}</span>${trialOnly ? `<span>${t('测评免单')}</span>` : ''}<span>${typeLabel}</span></span>
    </summary>
    <div class="discover-filter-body">
      <div class="discover-filter-group"><div class="discover-filter-label">${t('上架时间')}</div>${renderNewDaysChips(days, trialOnly)}</div>
      <div class="discover-filter-group"><div class="discover-filter-label">${t('排序')}</div>${renderSortChips(sort, 'new')}</div>
      <div class="discover-filter-group"><div class="discover-filter-label">${t('商品类型')}</div>${renderTypeChips(ptype, 'new')}</div>
    </div>
  </details>`
}

window.setNewDays = (val) => {
  state._newDays = val === '' ? '' : Number(val)
  renderNewArrivals(document.getElementById('app'))
}
window.setNewTrialOnly = (val) => {
  state._newTrialOnly = !!val
  renderNewArrivals(document.getElementById('app'))
}
