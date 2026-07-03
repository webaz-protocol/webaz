// Direct Pay (Rail 1) — 一键复制按钮(付款说明 / 付款参考号 / 金额)。UI ONLY;不碰任何钱路。
//   买家场外付款需把收款账号/参考号抄进银行 App —— 手抄是整条轨最易错的一步,复制按钮把出错率降到 0。
//   文本存 data-dpcopy(escHtml 转义双引号/单引号,属性安全);点按走 app.js 健壮 copyText(clipboard→execCommand 回退),
//   成功后短暂显示 ✓ 已复制再还原。escHtml/copyText/t 均为运行时(render/click 时)调用,此文件早于 app.js 加载无碍。
window.dpCopyBtn = (text, label) => `<button type="button" class="btn btn-sm dp-copy-btn" style="padding:2px 8px;font-size:11px;background:#eef2ff;color:#4338ca;border:none;border-radius:6px;cursor:pointer;white-space:nowrap;vertical-align:middle" data-dpcopy="${escHtml(String(text ?? ''))}" onclick="dpDoCopy(this)">📋 ${escHtml(label || t('复制'))}</button>`
window.dpDoCopy = async (el) => {
  if (!el || el.dataset.busy === '1') return
  const ok = await copyText(el.getAttribute('data-dpcopy') || '')
  if (!ok) return
  const orig = el.innerHTML; el.dataset.busy = '1'; el.innerHTML = '✓ ' + t('已复制')
  setTimeout(() => { el.innerHTML = orig; el.dataset.busy = '' }, 1500)
}
