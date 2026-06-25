// WebAZ — Seller read-only analytics / store-reviews display (classic split, slice K / app-seller.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// Top-level functions are global; pages run on route/click (after app.js loads),
// so cross-file globals (GET/state/shell/escHtml/t/fmtTime/submitSellerReviewReply/
// ...) resolve at call time. No import/export.
//
// READ-ONLY only: renderSellerAnalytics (GET /sellers/me/analytics) + its review
// hydration hydrateSellerReviews (GET /sellers/me/ratings). The reply WRITE handler
// submitSellerReviewReply (POST /orders/:id/rating/reply) stays in app.js and is
// reached cross-file via the onclick these read-only views render.
//
// INTENTIONALLY LEFT in app.js (money/order/status/product-mutation — never moved):
// renderSeller (the full seller workbench), renderSellerTrials (trial-campaign
// create/delete + /charity/fund/donate), renderSellerFlashSales (flash-sale config),
// sellerDeclineContestPanel (order decline/status), and all order/shipping/refund/
// dispute/wallet/withdraw/settlement/escrow handlers. No UI/behavior change.

// Wave C-5: 卖家销售分析
async function renderSellerAnalytics(app) {
  if (!state.user || state.user.role !== 'seller') { app.innerHTML = shell(`<div class="empty">${t('仅卖家可访问')}</div>`, 'me'); return }
  app.innerHTML = shell(loading$(), 'me')
  const win = state._analyticsWindow || 30
  const r = await GET(`/sellers/me/analytics?window=${win}`)
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'me'); return }
  const fmt = (v) => Number(v || 0).toFixed(0)
  const fmt2 = (v) => Number(v || 0).toFixed(2)
  const pct = (v) => (Number(v || 0) * 100).toFixed(1) + '%'
  // S1 增量箭头 — prev_window 对比
  const delta = (cur, prev) => {
    if (!prev || prev === 0) return cur > 0 ? `<span style="color:#16a34a;font-size:10px">${t('新')}</span>` : ''
    const d = (cur - prev) / prev
    const arrow = d > 0.01 ? '↑' : d < -0.01 ? '↓' : '·'
    const color = d > 0.01 ? '#16a34a' : d < -0.01 ? '#dc2626' : '#9ca3af'
    return `<span style="color:${color};font-size:10px;font-weight:600;margin-left:4px" title="${t('对比上一')}${win}${t('天')}">${arrow} ${Math.abs(d * 100).toFixed(0)}%</span>`
  }

  // 简易柱状图（按 day_trend.gmv 缩放）
  const trend = r.daily_trend || []
  const maxGmv = Math.max(1, ...trend.map(d => Number(d.gmv)))
  const trendBars = trend.length === 0
    ? `<div style="font-size:11px;color:#9ca3af;text-align:center;padding:14px">${t('暂无数据')}</div>`
    : `<div style="display:flex;gap:3px;align-items:flex-end;height:80px">
        ${trend.map(d => {
          const h = Math.max(3, (Number(d.gmv) / maxGmv) * 70)
          return `<div title="${d.date}: ${Number(d.gmv).toFixed(0)} WAZ · ${d.orders} ${t('单')}" style="flex:1;background:linear-gradient(180deg,#6366f1,#a5b4fc);height:${h}px;border-radius:2px 2px 0 0;cursor:help"></div>`
        }).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:#9ca3af;margin-top:4px">
        <span>${trend[0]?.date || ''}</span>
        <span>${trend[trend.length - 1]?.date || ''}</span>
      </div>`

  const topRows = (r.top_products || []).length === 0
    ? `<div style="font-size:11px;color:#9ca3af;text-align:center;padding:14px">${t('暂无完成订单')}</div>`
    : (r.top_products || []).map((p, i) => `
        <div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <div style="font-size:13px;font-weight:700;color:${i === 0 ? '#f59e0b' : i < 3 ? '#6366f1' : '#9ca3af'};width:22px;text-align:center">${i + 1}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.title)}</div>
            <div style="font-size:10px;color:#9ca3af">${p.price} WAZ</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px;font-weight:600;color:#16a34a">${p.sales} ${t('单')}</div>
            <div style="font-size:10px;color:#9ca3af">${fmt2(p.revenue)} WAZ</div>
          </div>
        </div>`).join('')

  const winSelector = [7, 30, 90, 180].map(w => `
    <button class="btn btn-sm" style="font-size:11px;padding:4px 10px;${win === w ? 'background:#4f46e5;color:#fff' : 'background:#fff;color:#374151;border:1px solid #d1d5db'}" onclick="switchAnalyticsWindow(${w})">${w}${t('天')}</button>
  `).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">📊 ${t('销售分析')}</h1>
    <div style="display:flex;gap:6px;margin-bottom:12px">${winSelector}</div>

    <div class="card" style="background:linear-gradient(135deg,#eef2ff,#fff);padding:14px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">💰 ${t('核心指标')}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
        <div>
          <div style="font-size:18px;font-weight:700;color:#4f46e5">${fmt2(r.orders.gmv)}${delta(Number(r.orders.gmv), Number(r.prev_window?.gmv))}</div>
          <div style="font-size:10px;color:#6b7280">GMV (WAZ)</div>
        </div>
        <div>
          <div style="font-size:18px;font-weight:700;color:#16a34a">${fmt(r.orders.completed_orders)}${delta(Number(r.orders.completed_orders), Number(r.prev_window?.completed_orders))}</div>
          <div style="font-size:10px;color:#6b7280">${t('完成订单')}</div>
        </div>
        <div>
          <div style="font-size:18px;font-weight:700;color:#f59e0b">${fmt2(r.orders.aov)}</div>
          <div style="font-size:10px;color:#6b7280">${t('客单价')} (WAZ)</div>
        </div>
      </div>
    </div>

    <!-- S1 新增：履约 & 质量 -->
    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">⚙️ ${t('履约 & 质量')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;text-align:center;font-size:12px">
        <div title="${t('paid → shipped 平均耗时')}">
          <div style="font-size:18px;font-weight:700;color:${Number(r.fulfillment?.avg_handling_hours||0)<=24?'#16a34a':Number(r.fulfillment?.avg_handling_hours||0)<=72?'#d97706':'#dc2626'}">${r.fulfillment?.sample_n > 0 ? Number(r.fulfillment.avg_handling_hours).toFixed(1) + 'h' : '—'}</div>
          <div style="font-size:10px;color:#9ca3af">${t('平均备货时长')}${r.fulfillment?.sample_n > 0 ? ` (n=${r.fulfillment.sample_n})` : ''}</div>
        </div>
        <div title="${t('refunded / completed')}">
          <div style="font-size:18px;font-weight:700;color:${Number(r.quality?.return_rate||0)<=0.05?'#16a34a':Number(r.quality?.return_rate||0)<=0.15?'#d97706':'#dc2626'}">${r.quality?.completed > 0 ? pct(r.quality.return_rate) : '—'}</div>
          <div style="font-size:10px;color:#9ca3af">${t('退货率')}${r.quality?.completed > 0 ? ` (${r.quality.refunds}/${r.quality.completed})` : ''}</div>
        </div>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <div style="font-size:13px;font-weight:600">📈 ${t('每日 GMV 趋势')}</div>
        <div style="font-size:10px;color:#9ca3af">${t('最近')} ${Math.min(win, 30)} ${t('天（按日）')}</div>
      </div>
      ${trendBars}
      ${win > 30 ? `<div style="font-size:10px;color:#9ca3af;margin-top:6px;text-align:center">${t('日粒度仅展示最近 30 天；汇总指标按完整窗口计算')}</div>` : ''}
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">🔄 ${t('客户结构')}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;font-size:12px">
        <div><div style="font-weight:700;color:#374151">${r.buyers.unique}</div><div style="font-size:10px;color:#9ca3af">${t('独立客户')}</div></div>
        <div><div style="font-weight:700;color:#16a34a">${r.buyers.repeat}</div><div style="font-size:10px;color:#9ca3af">${t('复购客户')}</div></div>
        <div><div style="font-weight:700;color:#4f46e5">${pct(r.buyers.repeat_rate)}</div><div style="font-size:10px;color:#9ca3af">${t('复购率')}</div></div>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">🎯 ${t('意向转化')}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;font-size:12px">
        <div><div style="font-weight:700;color:#dc2626">${r.funnel.wishlist_adds}</div><div style="font-size:10px;color:#9ca3af">❤ ${t('心愿单加入')}</div></div>
        <div><div style="font-weight:700;color:#f59e0b">${r.funnel.orders}</div><div style="font-size:10px;color:#9ca3af">📦 ${t('总下单')}</div></div>
        <div><div style="font-weight:700;color:#16a34a">${r.funnel.completed}</div><div style="font-size:10px;color:#9ca3af">✓ ${t('完成')}</div></div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#9ca3af;text-align:center">${t('心愿单 → 下单转化率')}: ${r.funnel.wishlist_adds > 0 ? pct(r.funnel.orders / r.funnel.wishlist_adds) : '—'}</div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">🏆 ${t('热销 Top 10')}</div>
      ${topRows}
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="text-align:center">
        <div style="font-size:18px;font-weight:700;color:#f59e0b">${Number(r.ratings.avg_stars || 0).toFixed(1)} ⭐</div>
        <div style="font-size:10px;color:#9ca3af">${t('评价')} (${r.ratings.cnt})</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:18px;font-weight:700;color:#dc2626">${r.refunds}</div>
        <div style="font-size:10px;color:#9ca3af">${t('退款')}</div>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">⭐ ${t('店铺评价')} <span style="font-size:11px;color:#9ca3af;font-weight:400">${t('（买家评价 · 每条可回应一次）')}</span></div>
      <div id="seller-reviews-area" style="font-size:12px;color:#6b7280">${loading$()}</div>
    </div>
  `, 'me')
  hydrateSellerReviews()
}

// 店铺评价汇总 + 逐条回应(P2)。复用既有 POST /orders/:order_id/rating/reply(卖家一回一限);
// 读 /sellers/me/ratings(authed,含 order_id)。不改评价 / 资金逻辑。
async function hydrateSellerReviews() {
  const area = document.getElementById('seller-reviews-area')
  if (!area) return
  const r = await GET('/sellers/me/ratings?limit=50').catch(() => null)
  const items = Array.isArray(r?.items) ? r.items : []
  if (items.length === 0) { area.innerHTML = `<div style="color:#9ca3af;text-align:center;padding:12px">${t('暂无评价')}</div>`; return }
  const unreplied = Number(r?.agg?.unreplied || 0)
  const starStr = (n) => '★'.repeat(Math.max(0, Math.min(5, Number(n) || 0))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Number(n) || 0)))
  area.innerHTML = `
    ${unreplied > 0 ? `<div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px;margin-bottom:8px">📝 ${unreplied} ${t('条评价待回应')}</div>` : ''}
    ${items.map(it => it.masked ? `
      <div style="border:1px solid #f3f4f6;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafafa">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px">
          <span style="font-size:12px;color:#6b7280">🔒 ${t('评价双盲遮蔽中')}</span>
          <span style="font-size:10px;color:#9ca3af">${fmtTime(it.created_at)}</span>
        </div>
        <div style="font-size:11px;color:#9ca3af;margin-bottom:4px">📦 ${escHtml(it.product_title || '')}</div>
        <div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px">${t('买家已评价，但需你先评价买家，或盲评期结束后才能查看与回应（防互相影响打分）。')}</div>
      </div>` : `
      <div style="border:1px solid #f3f4f6;border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px">
          <span style="color:#f59e0b;font-size:13px">${starStr(it.stars)}</span>
          <span style="font-size:10px;color:#9ca3af">${fmtTime(it.created_at)}</span>
        </div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px">@${escHtml(it.buyer_handle || it.buyer_name || '')} · 📦 ${escHtml(it.product_title || '')}</div>
        ${it.comment ? `<div style="font-size:12px;color:#374151;margin-bottom:6px">${escHtml(it.comment)}</div>` : `<div style="font-size:12px;color:#9ca3af;margin-bottom:6px">${t('买家未留言')}</div>`}
        ${it.reply ? `<div style="background:#f0f9ff;border-radius:6px;padding:6px 8px;font-size:12px;color:#0369a1"><strong>${t('你的回应')}：</strong>${escHtml(it.reply)}</div>${it.buyer_followup ? `<div style="background:#fafafa;border-radius:6px;padding:6px 8px;font-size:12px;color:#374151;margin-top:4px"><strong>${t('买家追问')}：</strong>${escHtml(it.buyer_followup)}</div>` : ''}` : `
          <div style="display:flex;gap:6px;align-items:flex-end">
            <textarea id="rev-reply-${it.order_id}" rows="1" maxlength="500" placeholder="${t('回应这条评价（最多 500 字 · 仅一次）')}" style="flex:1;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;resize:none"></textarea>
            <button class="btn btn-primary btn-sm" style="padding:6px 12px;font-size:11px" onclick="submitSellerReviewReply('${it.order_id}')">${t('回应')}</button>
          </div>
          <div id="rev-reply-err-${it.order_id}" style="font-size:11px;color:#dc2626;margin-top:4px"></div>`}
      </div>`).join('')}
  `
}
