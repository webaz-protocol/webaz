// USDC 合约担保 PR-B6b-2 —— 买家侧「确认收货并放款 / 发起链上争议」面(链上 Funded 之后的唯一动作面)。
//
// 诚实边界(这份文案只描述【今天代码真的会做的事】):
//   · 放款 = 买家用自己的钱包调合约 buyerRelease(bytes32),合约把货款打给 voucher 绑定的卖家收款地址、
//     平台费计入合约 accruedFees。合约只能把钱付给买家/卖家/平台费三个去向,平台无法转给任意地址,也不能改收款方。
//   · 争议 = 调合约 flagDispute(bytes32),它【只做一件事】:把 escrow 冻结成 Disputed,停掉自动放款。
//     链上裁决(退款/放款/分账)由平台仲裁 key 的 arbiterResolve 执行 —— 该能力【仍在接线中(B7)】,
//     现在按下争议不会、也不能得到任何裁决结果。文案必须这样说,绝不暗示"可以裁决/会退款"。
//   · autoReleaseAt 对买家是 EXCLUSIVE(合约:t >= autoReleaseAt 即 AutoReleaseWindowPassed):到期时刻
//     起买家不能再 flagDispute,且【任何人】都可以触发自动放款给卖家。UI 按 exclusive 显示并留安全余量。
//
// D2 同样适用:发出 tx 后不写任何订单状态,只轮询 GET /usdc-escrow/status 等 watcher 镜像链上事件。
;(function () {
  const DISPUTE_MARGIN_SEC = 600   // 争议入口的安全余量:距自动放款不足 10 分钟即收起(同块竞态,合约边界是 exclusive)

  let cur = null, tick = null

  const nowSec = () => Math.floor(Date.now() / 1000)
  const row = (label, value, mono) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px"><span style="color:#6b7280;flex-shrink:0">${label}</span><span style="color:#111827;text-align:right;word-break:break-all${mono ? ';font-family:monospace;font-size:11px' : ''}">${value}</span></div>`
  const box = (bg, bd, color, html) => `<div style="background:${bg};border:1px solid ${bd};color:${color};border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6;margin-top:8px">${html}</div>`
  const chainName = (id) => (Number(id) === 8453 ? 'Base' : (Number(id) === 84532 ? 'Base Sepolia' : String(id || '')))
  const fmtSec = (unix) => { const ms = Number(unix) * 1000; return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '—' }

  /** 剩余时长人读串;<= 0 → 空串(到期由调用方走"已到期"分支,绝不显示负数倒计时)。 */
  const leftText = (sec) => {
    if (!(sec > 0)) return ''
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
    return d > 0 ? (d + t('天(计时)') + ' ' + h + t('小时(计时)')) : (h > 0 ? (h + t('小时(计时)') + ' ' + m + t('分钟(计时)')) : (Math.max(1, m) + t('分钟(计时)')))
  }

  const crossCheck = (st) => `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-top:8px">
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px">${t('请在钱包弹窗里核对下面这组信息,完全一致才签名:')}</div>
    ${row(t('合约托管金额'), (st.amount != null ? window.webazUnits6ToText(st.amount) : '—') + ' USDC')}
    ${row(t('网络'), escHtml(chainName(st.chain_id)))}
    ${row(t('担保合约'), escHtml(String(st.contract || '—')), true)}
    ${row(t('卖家收款地址'), escHtml(String(st.seller || '—')), true)}
    ${row(t('平台费率'), st.fee_bps != null ? (Number(st.fee_bps) / 100) + '%' : '—')}
    ${st.buyer_addr ? row(t('你的存款地址'), escHtml(String(st.buyer_addr)), true) : ''}
  </div>`

  // A3:release/dispute 都是买家用自己钱包发起的链上 tx,买家付 Base gas,平台不代付(与存入面同款披露)。
  const gasNote = () => `<div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:6px 9px;margin-top:8px;line-height:1.6">⛽ ${t('确认收货放款 / 发起链上争议都是你用自己的钱包发起的链上交易,需少量 ETH 支付 Base 网络 gas 费 —— 平台不代付,也不能替你操作。')}</div>`

  const say = (msg, kind) => { cur.msg = msg; cur.kind = kind || 'info' }
  const msgBox = () => (cur.msg ? (cur.kind === 'error' ? box('#fef2f2', '#fecaca', '#991b1b', cur.msg) : cur.kind === 'warn' ? box('#fffbeb', '#fde68a', '#92400e', cur.msg) : box('#eff6ff', '#bfdbfe', '#1e40af', cur.msg)) : '')

  const sayProvider = (r, what) => {
    if (Number(r.code) === 4001) return say(t('你在钱包里取消了操作。没有发出任何交易,链上状态没有任何变化。'), 'warn')
    if (r.code === 'NO_WALLET') return say(t('未检测到链上钱包。请在安装了链上钱包的浏览器中打开本页后重试。'), 'warn')
    say(`${what} · <code>${escHtml(String(r.code))}</code> ${escHtml(r.message || '')}`, 'error')
  }

  const render = () => {
    if (!cur || !cur.el || !cur.el.isConnected) return
    const st = cur.status, autoAt = Number(st.auto_release_at) || 0
    const left = autoAt ? autoAt - nowSec() : 0
    const expired = autoAt > 0 && left <= 0
    const canDispute = !!(st.calls && st.calls.flag_dispute) && autoAt > 0 && left > DISPUTE_MARGIN_SEC && !cur.busy && !cur.pendingKind
    const canRelease = !!(st.calls && st.calls.release) && String(cur.order.status) === 'delivered' && !cur.busy && !cur.pendingKind

    let body = ''
    if (st.released_seen) {
      body = box('#f0fdf4', '#bbf7d0', '#166534', `<b>${t('链上已放款')}</b><br>${t('担保合约已把货款释放给卖家的收款地址,平台费由合约内部计提。平台从未经手本金。')}`)
    } else if (st.disputed_seen) {
      body = crossCheck(st) + box('#fffbeb', '#fde68a', '#92400e', `<b>${t('链上已冻结(争议中)')}</b><br>${t('自动放款已停止,资金仍留在担保合约里。链上裁决(退款 / 放款 / 分账)由平台仲裁 key 执行,该能力仍在接线中,目前无法出具链上裁决 —— 请在订单页联系我们人工跟进。')}`)
    } else {
      body = crossCheck(st)
      // 自动放款披露 —— exclusive:到期【时刻起】买家即不能再发起链上争议,且任何人都可触发放款。
      body += box('#eff6ff', '#bfdbfe', '#1e40af', expired
        ? `<b>${t('自动放款窗口已到期')}</b><br>${t('从到期时刻起,链上【任何人】都可以触发把这笔货款自动放给卖家(包括卖家本人),你也不能再发起链上争议。')}`
        : `<b>${t('自动放款')}</b> · ${escHtml(fmtSec(autoAt))}${left > 0 ? ` · ${t('剩余约')} ${leftText(left)}` : ''}<br>${t('到期时刻起,链上【任何人】都可以触发把这笔货款自动放给卖家;同一时刻起你也不能再发起链上争议。请预留时间,不要卡在最后一刻。')}`)
      if ((canRelease || canDispute) && !cur.pendingKind) body += gasNote()
      if (cur.pendingKind) {
        const link = window.webazWalletExplorerTx(st.chain_id, cur.txHash)
        body += box('#eff6ff', '#bfdbfe', '#1e40af', `<b>${cur.pendingKind === 'release' ? t('等待链上确认放款') : t('等待链上确认冻结')}</b><br>${t('交易已广播。订单状态由链上事件驱动,通常约 1–2 分钟后自动更新;这段时间可以离开本页。')}`)
          + (cur.txHash ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;word-break:break-all">${t('交易哈希')}: ${escHtml(cur.txHash)}${link ? ` · <a href="${escHtml(link)}" target="_blank" rel="noopener noreferrer">${t('在区块浏览器查看')}</a>` : ''}</div>` : '')
      }
      if (canRelease) {
        body += `<button class="btn btn-success btn-sm" style="width:100%;margin-top:10px;font-size:13px" onclick="usdcEscrowRelease()">✓ ${t('确认收货并放款(链上)')}</button>`
      } else if (!cur.pendingKind && !st.released_seen) {
        body += `<div style="font-size:11px;color:#6b7280;margin-top:8px">${t('包裹送达后,可在此用你自己的链上钱包确认收货并放款。本轨的确认收货不经 app 内动作完成,只由链上合约释放。')}</div>`
      }
      if (canDispute) {
        body += `<button class="btn btn-outline btn-sm" style="width:100%;margin-top:8px;font-size:12px" onclick="usdcEscrowDispute()">${t('有问题,冻结自动放款(链上争议)')}</button>`
          + `<div style="font-size:11px;color:#92400e;margin-top:6px;line-height:1.6">${t('提示:发起链上争议只做一件事 —— 把合约冻结、停掉自动放款,资金原样留在合约里。链上裁决(退款 / 放款 / 分账)由平台仲裁 key 执行,该能力仍在接线中,现在按下不会产生任何裁决结果。冻结后请在订单页联系我们人工跟进。')}</div>`
      } else if (!expired && !cur.pendingKind && st.calls && !st.calls.flag_dispute) {
        body += `<div style="font-size:11px;color:#6b7280;margin-top:8px">${t('已过可发起链上争议的时间(合约以自动放款时刻为界,不含该时刻)。')}</div>`
      }
      body += msgBox()
    }
    cur.el.innerHTML = `<div class="card" style="border:1px solid #c7d2fe;background:linear-gradient(135deg,#eef2ff,#ffffff)">
      <div style="font-size:14px;font-weight:700;color:#1e3a8a;margin-bottom:4px">🔗 ${t('链上合约担保 · 资金在合约中')}</div>
      <div style="font-size:12px;color:#374151;line-height:1.7">${t('本金由 Base 链上的 WebAZ 担保合约托管;合约只能把钱付给买家、卖家或平台费三个去向,平台无法转给任意地址(平台费从担保金额中按费率扣除)。')}</div>
      ${body}</div>`
  }

  // ── 发一笔链上动作(release / flag_dispute):calldata 完全来自后端,前端零编码 ──
  const sendCall = async (kind, what) => {
    if (!cur || cur.busy || cur.pendingKind) return
    const call = cur.status.calls && cur.status.calls[kind === 'release' ? 'release' : 'flag_dispute']
    if (!call) return
    cur.busy = true; cur.msg = ''; render()
    try {
      if (!window.webazWalletAvailable()) return say(t('未检测到链上钱包。请在安装了链上钱包的浏览器中打开本页后重试。'), 'warn')
      const c = await window.webazWalletConnect()
      if (!c.ok) return sayProvider(c, what)
      // A3:换账号点释放/争议会在链上 NotBuyer revert 白烧 gas —— 发 tx 前先比对存款账户(小写归一)。
      //   buyer_addr 只对买家自己下发(/status 门控),缺失时(旧凭证/无快照)不阻断,退回链上守卫兜底。
      const depositor = cur.status.buyer_addr
      if (depositor && window.webazWalletNormAddr(c.address) !== window.webazWalletNormAddr(depositor)) {
        return say(t('当前连接的钱包账户与存款账户不一致,请切回存款账户后再操作。'), 'error')
      }
      const ck = await window.webazWalletChainOk(cur.status.chain_id)
      if (!ck.ok) return sayProvider(ck, t('读取钱包网络失败'))
      if (!ck.matches) {
        const sw = await window.webazWalletSwitchChain(cur.status.chain_id)
        if (!sw.ok) return sayProvider(sw, t('切换网络失败'))
        const ck2 = await window.webazWalletChainOk(cur.status.chain_id)
        if (!ck2.ok || !ck2.matches) return say(t('钱包仍不在正确的网络上,无法继续。请在钱包里切换后重试。'), 'error')
      }
      const sent = await window.webazWalletSend({ to: call.to, data: call.data, from: c.address })
      if (!sent.ok) return sayProvider(sent, what)
      cur.txHash = sent.hash; cur.pendingKind = kind      // D2:只等 watcher,不写任何订单状态
      startPoll()
    } finally { cur.busy = false; render() }
  }

  window.usdcEscrowRelease = () => sendCall('release', t('提交放款交易失败'))
  window.usdcEscrowDispute = () => sendCall('dispute', t('提交冻结交易失败'))

  const startPoll = () => {
    if (cur.stop) cur.stop()
    cur.stop = window.usdcEscrowPollStatus(cur.orderId, (data, why) => {
      if (!cur || !cur.el || !cur.el.isConnected) return true
      if (why === 'timeout') { say(t('链上确认时间超出预期。资金安全不受影响(以链上为准),你可以稍后刷新本页查看,或用上面的交易哈希在区块浏览器核对。'), 'warn'); render(); return true }
      if (!data) return false
      const done = (cur.pendingKind === 'release' && data.released_seen) || (cur.pendingKind === 'dispute' && data.disputed_seen)
      if (!done) return false
      cur.status = data; cur.pendingKind = null; render()
      if (window._orderPollNow) window._orderPollNow()   // 只读重拉订单详情(前端永不自己写状态)
      return true
    })
  }

  /** 由 app-usdc-escrow-pay.js 的 hydrate 在链上已存入时分派进来。 */
  window.usdcEscrowReleaseRender = (order, el, status) => {
    if (tick) { clearInterval(tick); tick = null }
    if (cur && cur.stop) cur.stop()
    cur = { order, orderId: order.id, el, status, msg: '', kind: '', busy: false, pendingKind: null, txHash: '', stop: null }
    render()
    // 倒计时:每分钟重绘一次(容器离屏即自停;不打接口)
    tick = setInterval(() => { if (!cur || !cur.el || !cur.el.isConnected) { clearInterval(tick); tick = null; return } if (!cur.busy) render() }, 60000)
  }

  /** 测试/调试用只读快照。 */
  window._usdcReleaseState = () => (cur ? { pendingKind: cur.pendingKind, txHash: cur.txHash, msg: cur.msg, kind: cur.kind, html: cur.el && cur.el.innerHTML } : null)
})()
