// Direct Pay 卖家【直接收款销售统计 + 对账 + 逐单平台费明细】section。UI ONLY,只读。
//   数据:GET /api/sellers/me/direct-pay-report(requireSeller,仅本人)。直付=非托管,货款买家直付卖家,平台不经手 →
//   钱包/收入视图看不到直付销售,故此处按订单聚合销售额 + 逐单平台服务费,便于对账(可选日期区间 + 客户端 CSV 导出)。
//   销售额=下单计价币(买家应付金额);平台服务费=USDC。两者不同币种,分列不混加。
;(function () {
  const _n = (v) => (Number(v) || 0)
  const _amt = (v) => _n(v).toLocaleString(undefined, { maximumFractionDigits: 2 })                 // 销售额(计价币)
  const _fee = (v) => v == null ? '—' : (_n(v).toFixed(6).replace(/\.?0+$/, '') || '0') + ' USDC'   // 平台费(USDC)
  let _last = null

  window.dpSalesReportSection = () => {
    setTimeout(() => window.dpHydrateSalesReport(), 60)
    return `<div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">🧾 ${t('直接收款销售统计 + 对账(仅你可见)')}</div>
      <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('直付为非托管:货款由买家直接付给你,平台不经手。此处按你的订单聚合销售额与逐单平台服务费,便于对账。')}</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <input type="date" id="dpsr-from" style="font-size:12px;padding:4px 6px;border:1px solid #e5e7eb;border-radius:6px">
        <span style="color:#9ca3af">→</span>
        <input type="date" id="dpsr-to" style="font-size:12px;padding:4px 6px;border:1px solid #e5e7eb;border-radius:6px">
        <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px" onclick="dpHydrateSalesReport(document.getElementById('dpsr-from').value, document.getElementById('dpsr-to').value)">${t('查询')}</button>
        <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px" onclick="dpSalesReportExport()">📥 ${t('导出对账 CSV')}</button>
      </div>
      <div id="dpsr-body">${typeof loading$ === 'function' ? loading$() : ''}</div>
    </div>`
  }

  window.dpHydrateSalesReport = async (from, to) => {
    const box = document.getElementById('dpsr-body'); if (!box) return
    const q = []
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q.push('from=' + from)
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) q.push('to=' + to)
    const r = await GET('/sellers/me/direct-pay-report' + (q.length ? '?' + q.join('&') : '')).catch(() => null)
    if (!r || r.error) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${t('操作失败,请重试')}</div>`; return }
    _last = r
    const s = r.summary
    if (!s || s.order_count === 0) { box.innerHTML = `<div style="font-size:12px;color:#9ca3af;padding:8px 0">${t('该区间暂无直接收款订单')}</div>`; return }
    const tile = (label, val, sub) => `<div style="flex:1;min-width:96px;background:#faf5ff;border:1px solid #ede9fe;border-radius:8px;padding:8px 10px"><div style="font-size:11px;color:#7c3aed">${label}</div><div style="font-size:16px;font-weight:700;color:#5b21b6">${val}</div>${sub ? `<div style="font-size:10px;color:#9ca3af">${sub}</div>` : ''}</div>`
    const tiles = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      ${tile(t('总销售额'), _amt(s.sales_total), t('订单') + ' ' + s.order_count)}
      ${tile(t('已完成销售额'), _amt(s.completed_sales), t('已完成') + ' ' + s.completed_count)}
      ${tile(t('已计提平台费'), _fee(s.fee_accrued_total), s.fee_order_count + ' ' + t('单'))}
      ${tile(t('在途 / 已关闭'), s.in_flight_count + ' / ' + s.closed_count, t('单'))}
    </div>`
    const byMonth = (r.by_month && r.by_month.length > 1) ? `<div style="margin-bottom:10px"><div style="font-size:12px;color:#6b7280;margin-bottom:4px">${t('按月')}</div>${r.by_month.map(m => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;border-bottom:1px solid #f3f4f6"><span>${escHtml(m.month)}</span><span>${_amt(m.sales_total)} · ${m.order_count} ${t('单')}</span></div>`).join('')}</div>` : ''
    const th = (txt, right) => `<th style="text-align:${right ? 'right' : 'left'};padding:5px 4px;font-size:11px;color:#9ca3af;white-space:nowrap">${txt}</th>`
    const rowsHtml = r.orders.map(o => `<tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:5px 4px;font-size:11px"><a href="#order/${o.id}" style="color:#6366f1;text-decoration:none">${escHtml(String(o.id).slice(0, 10))}</a></td>
      <td style="padding:5px 4px;font-size:11px;color:#6b7280;white-space:nowrap">${typeof fmtTime === 'function' ? fmtTime(o.created_at) : escHtml(o.created_at)}</td>
      <td style="padding:5px 4px;font-size:11px">${typeof statusBadge === 'function' ? statusBadge(o.status, 'direct_p2p') : escHtml(o.status)}</td>
      <td style="padding:5px 4px;font-size:11px;text-align:right;font-weight:600">${_amt(o.total_amount)}</td>
      <td style="padding:5px 4px;font-size:11px;text-align:right;color:#7c3aed">${_fee(o.fee_amount)}</td>
    </tr>`).join('')
    const table = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #e5e7eb">${th(t('订单'))}${th(t('时间'))}${th(t('状态'))}${th(t('销售额'), true)}${th(t('平台费'), true)}</tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>${r.truncated ? `<div style="font-size:11px;color:#b45309;margin-top:6px">${t('仅显示最近 500 单,请用日期区间缩小范围')}</div>` : ''}`
    box.innerHTML = tiles + byMonth + table
  }

  // 客户端 CSV 导出(对账用:逐单销售额 + 平台费一张表,对银行流水)。
  window.dpSalesReportExport = () => {
    if (!_last || !_last.orders || !_last.orders.length) { (window.toast$ || window.alert)(t('暂无数据可导出')); return }
    const esc = (v) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x }
    const lines = [['order_id', 'created_at', 'status', 'sales_amount', 'platform_fee_usdc', 'fee_accrued_at', 'ship_to_region', 'product'].join(',')]
    for (const o of _last.orders) lines.push([o.id, o.created_at, o.status, o.total_amount, o.fee_amount == null ? '' : o.fee_amount, o.fee_accrued_at || '', o.ship_to_region || '', o.product_title || ''].map(esc).join(','))
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    a.download = 'webaz-directpay-reconcile-' + new Date().toISOString().slice(0, 10) + '.csv'
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
    if (window.toast$) window.toast$(t('导出完成'))
  }
})()
