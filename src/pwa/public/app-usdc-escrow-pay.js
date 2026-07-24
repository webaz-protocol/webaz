// USDC 合约担保 PR-B6b-2 —— 买家存入 stepper(连接 → 链检查 → 取授权 → 读余额/额度 → approve → deposit → 等确认)。
//
// 两条铁律(整份文件的形状都由它们决定):
//   D1 calldata 一律【后端】viem 编码:本文件只把后端给的 {to,data} 原样交给 app-usdc-wallet.js,
//      零手搓 ABI、零地址猜测。后端没给 calls(usdc_token 未配)→ fail-visible「链上配置未完成」,绝不兜底。
//   D2 【绝不前端假成功】:存入 tx 广播后本文件【不写任何订单状态】—— 只轮询 GET /usdc-escrow/status,
//      等链上事件 watcher 把 Deposited 镜像进来。UI 诚实显示"等待链上确认(约 1–2 分钟)"。
//
// 另:D3 换账号/换链 → 作废本地 voucher 回到第 1 步(digest 绑死 buyer 地址,不重签必然 revert);
//     D4 合约里 orderId 一次性 —— 发出 tx 后把 txHash 记 localStorage,重进本页直接进等待态、按钮禁用,
//        避免重复 deposit 白烧 gas。
;(function () {
  const DEP_KEY = (id) => 'webaz_usdc_deposit_' + id
  const EXPIRY_MARGIN_SEC = 20        // 授权过期前的余量:剩余不足这个数就当作已过期,先重取再发 tx
  const RECEIPT_TRIES = 45, RECEIPT_GAP_MS = 4000       // approve 回执等待上限 ≈ 3 分钟
  const POLL_FAST_TICKS = 12, POLL_MID_TICKS = 30, POLL_MAX_TICKS = 90   // 5s×12 → 10s×18 → 20s×60 ≈ 25 分钟

  let cur = null      // 当前订单的 stepper 状态(订单详情页同时只有一个)
  let offs = []       // provider 监听注销器
  let seq = 0         // hydrate 代次:订单轮询重渲染会再次 hydrate,旧的在途 status 读绝不许覆盖新的一代

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const nowSec = () => Math.floor(Date.now() / 1000)
  const ls = (fn, fb) => { try { return fn() } catch { return fb } }   // localStorage 可能被隐私模式禁用 → 降级不报错

  // ── 状态轮询(D2 的唯一真相通道)。页面不可见暂停;退避 5s→10s→20s;有上限,到点诚实停下。 ──
  //   onData(data) 返回 true 即停止。复用给释放面(app-usdc-escrow-release.js)。
  window.usdcEscrowPollStatus = (orderId, onData) => {
    let stopped = false, ticks = 0
    const gap = () => (ticks < POLL_FAST_TICKS ? 5000 : (ticks < POLL_MID_TICKS ? 10000 : 20000))
    const loop = async () => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.hidden) { setTimeout(loop, 3000); return }   // 后台/锁屏:不打接口
      if (++ticks > POLL_MAX_TICKS) { onData(null, 'timeout'); return }
      const r = await window.apiRead('/orders/' + encodeURIComponent(orderId) + '/usdc-escrow/status')
      if (stopped) return
      if (r && r.ok && r.data && onData(r.data, null) === true) return
      if (!stopped) setTimeout(loop, gap())
    }
    setTimeout(loop, 1200)
    return () => { stopped = true }
  }

  // ── 渲染helpers ──
  const row = (label, value, mono) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px"><span style="color:#6b7280;flex-shrink:0">${label}</span><span style="color:#111827;text-align:right;word-break:break-all${mono ? ';font-family:monospace;font-size:11px' : ''}">${value}</span></div>`
  const box = (bg, bd, color, html) => `<div style="background:${bg};border:1px solid ${bd};color:${color};border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6;margin-top:8px">${html}</div>`
  const chainName = (id) => (Number(id) === 8453 ? 'Base' : (Number(id) === 84532 ? 'Base Sepolia' : String(id || '')))
  const fmtSec = (unix) => { const ms = Number(unix) * 1000; return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '—' }

  /** 同屏交叉核对面板 —— 每一步都渲染:钱包弹窗里的调用内容必须和这里逐字一致才可签名。 */
  const crossCheck = () => {
    const v = cur.voucher, st = cur.status || {}
    const amountUnits = v ? v.deposit_call.amount : st.amount
    const seller = v ? v.deposit_call.seller : st.seller
    const contract = v ? v.contract : st.contract
    const feeBps = v ? v.deposit_call.fee_bps : st.fee_bps
    const autoAt = v ? v.deposit_call.auto_release_at : st.auto_release_at
    return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-top:8px">
      <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px">${t('请在钱包弹窗里核对下面这组信息,完全一致才签名:')}</div>
      ${row(t('存入金额'), (amountUnits != null ? window.webazUnits6ToText(amountUnits) : '—') + ' USDC')}
      ${row(t('网络'), escHtml(chainName(cur.chainId)))}
      ${row(t('担保合约'), escHtml(String(contract || '—')), true)}
      ${row(t('卖家收款地址'), escHtml(String(seller || '—')), true)}
      ${row(t('平台费率'), feeBps != null ? (Number(feeBps) / 100) + '%' : '—')}
      ${row(t('自动放款时间'), autoAt ? escHtml(fmtSec(autoAt)) : '—')}
      ${cur.addr ? row(t('你的付款地址'), escHtml(v ? String(v.deposit_call.buyer) : window.webazShortAddr(cur.addr)), true) : ''}
    </div>`
  }

  const header = () => `<div style="font-size:14px;font-weight:700;color:#1e3a8a;margin-bottom:4px">🔗 ${t('链上合约担保 · 存入 USDC')}</div>
    <div style="font-size:12px;color:#374151;line-height:1.7">${t('本金由 Base 链上的 WebAZ 担保合约托管;合约只能把钱付给买家、卖家或平台费三个去向,平台无法转给任意地址(平台费从担保金额中按费率扣除)。')}</div>`

  const gasNote = () => `<div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:6px 9px;margin-top:8px;line-height:1.6">⛽ ${t('存入需要你用自己的钱包完成两笔链上交易(授权 + 存入),并需少量 ETH 支付 Base 网络 gas 费 —— 平台不代付。')}</div>`

  const btn = (label, disabled) => `<button class="btn btn-sm" style="width:100%;margin-top:10px;font-size:13px${disabled ? ';opacity:.55' : ''}" ${disabled ? 'disabled' : 'onclick="usdcPayAdvance()"'}>${label}</button>`

  const deadlineNote = () => {
    // 授权有效期【与付款窗取较早者】:B6a 已在后端把 auth_expires_at 钳到 pay_deadline,前端再取一次 min,
    // 即便后端某天放宽也不会显示出一个比付款窗更晚的假承诺。
    const authAt = cur.voucher ? Number(cur.voucher.deposit_call.auth_expires_at) : NaN
    const payMs = Date.parse(cur.order.pay_deadline || '')
    const payAt = Number.isFinite(payMs) ? Math.floor(payMs / 1000) : NaN
    const at = Math.min(Number.isFinite(authAt) ? authAt : Infinity, Number.isFinite(payAt) ? payAt : Infinity)
    if (!Number.isFinite(at)) return ''
    const left = at - nowSec()
    return `<div style="font-size:11px;color:#6b7280;margin-top:6px">${t('本次存入授权有效至')} ${escHtml(fmtSec(at))}${left > 0 ? ' · ' + t('剩余(计时)') + ' ' + Math.floor(left / 60) + ' ' + t('分钟(计时)') : ' · ' + t('已过期,将自动重新获取')}</div>`
  }

  const msgBox = () => {
    if (!cur.msg) return ''
    const k = cur.kind
    return k === 'error' ? box('#fef2f2', '#fecaca', '#991b1b', cur.msg)
      : k === 'warn' ? box('#fffbeb', '#fde68a', '#92400e', cur.msg)
        : box('#eff6ff', '#bfdbfe', '#1e40af', cur.msg)
  }

  const render = () => {
    if (!cur || !cur.el || !cur.el.isConnected) return
    const s = cur.step
    let body = ''
    if (s === 'nowallet') {
      body = box('#fffbeb', '#fde68a', '#92400e', `<b>${t('未检测到链上钱包')}</b><br>${t('本轨需要浏览器里的链上钱包(如 MetaMask)。请安装后刷新本页,或改用支持链上钱包的浏览器。在此之前请不要向任何地址手动转账。')}`)
    } else if (s === 'unconfigured') {
      body = box('#fef2f2', '#fecaca', '#991b1b', `<b>${t('链上配置未完成')}</b><br>${t('平台尚未配置本网络的 USDC 代币地址,无法生成存入调用。请联系平台处理 —— 在此之前请不要手动向任何地址转账。')}`)
    } else if (s === 'closed') {
      body = box('#f9fafb', '#e5e7eb', '#374151', t('本订单的付款窗口已关闭,不能再存入。如果你已经把 USDC 发进合约,资金仍在链上合约里,请在订单页联系我们。'))
    } else if (s === 'insufficient') {
      body = crossCheck() + box('#fef2f2', '#fecaca', '#991b1b', `<b>${t('钱包 USDC 余额不足,未发出任何交易')}</b><br>${cur.msg}`) + btn(t('余额已补足,重新检查'), false)
    } else if (s === 'waiting') {
      const link = window.webazWalletExplorerTx(cur.chainId, cur.txHash)
      body = crossCheck()
        + box('#eff6ff', '#bfdbfe', '#1e40af', `<b>${t('等待链上确认')}</b><br>${t('存入交易已广播。订单状态由链上事件驱动,通常约 1–2 分钟后自动更新;这段时间可以离开本页。')}`)
        + (cur.txHash ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;word-break:break-all">${t('交易哈希')}: ${escHtml(cur.txHash)}${link ? ` · <a href="${escHtml(link)}" target="_blank" rel="noopener noreferrer">${t('在区块浏览器查看')}</a>` : ''}</div>` : '')
        + box('#fffbeb', '#fde68a', '#92400e', t('同一订单在合约里只能存入一次。请不要重复提交 —— 重复的存入交易会在链上失败并白白消耗 gas。'))
        + btn(t('等待链上确认中…'), true) + msgBox()
    } else if (s === 'deposited') {
      body = crossCheck() + box('#f0fdf4', '#bbf7d0', '#166534', `<b>${t('链上已确认存入')}</b><br>${t('担保合约已收到你的 USDC。订单状态已按链上事件更新。')}`)
    } else {
      // intro / chain / error:同一张"下一步"面板,按钮文案随步骤变
      const label = s === 'chain' ? t('切换网络后继续') : (cur.voucher ? t('继续存入') : t('连接钱包并获取存入授权'))
      body = header() + crossCheck() + gasNote() + deadlineNote() + msgBox() + btn(label, !!cur.busy)
    }
    cur.el.innerHTML = `<div class="card" style="border:1px solid #c7d2fe;background:linear-gradient(135deg,#eef2ff,#ffffff)">${s === 'intro' || s === 'chain' || s === 'error' ? '' : header()}${body}</div>`
  }

  const say = (msg, kind) => { cur.msg = msg; cur.kind = kind || 'info' }
  // provider 错误 → 诚实文案。4001 = 用户在钱包里拒签:不重试、不进下一步、不隐瞒。
  const sayProvider = (r, what) => {
    if (Number(r.code) === 4001) return say(t('你在钱包里取消了操作。没有发出任何交易,也没有任何扣款。'), 'warn')
    if (r.code === 'NO_WALLET') { cur.step = 'nowallet'; return }
    say(`${what} · <code>${escHtml(String(r.code))}</code> ${escHtml(r.message || '')}`, 'error')
  }

  // ── voucher 获取(POST,后端签 EIP-712 并落 intent)──
  const fetchVoucher = async () => {
    const w = await window.apiWriteIdempotent('POST', '/orders/' + encodeURIComponent(cur.orderId) + '/usdc-escrow/voucher', { buyer_address: cur.addr })
    if (!w || !w.ok || !w.data) {
      // 写超时 = 结果未知:后端可能已签发。绝不盲重发 —— 重取一次授权是幂等的(旧 digest 自然作废),
      // 但要如实告诉用户"未知,请重试",不假装失败也不假装成功。
      const d = (w && w.data) || {}
      say(escHtml(String(d.error || t('暂时无法获取存入授权,请稍后重试。未发出任何交易。'))), 'error')
      cur.step = 'error'; return null
    }
    const v = w.data
    if (!v.usdc_token || !v.calls || !v.calls.approve || !v.calls.deposit || !v.reads) { cur.step = 'unconfigured'; return null }
    if (window.webazWalletNormAddr(v.deposit_call.buyer) !== cur.addr) {
      say(t('存入授权绑定的钱包地址与当前连接的账户不一致,已作废。请重新获取授权。'), 'error'); cur.step = 'error'; return null
    }
    cur.voucher = v; cur.chainId = Number(v.chain_id) || cur.chainId
    return v
  }

  const voucherExpired = () => !cur.voucher || (Number(cur.voucher.deposit_call.auth_expires_at) - EXPIRY_MARGIN_SEC) <= nowSec()

  const waitReceipt = async (hash) => {
    for (let i = 0; i < RECEIPT_TRIES; i++) {
      const r = await window.webazWalletReceipt(hash)
      if (r.ok && r.mined) return r
      await sleep(RECEIPT_GAP_MS)
    }
    return { ok: false, code: 'RECEIPT_TIMEOUT', message: hash }
  }

  // ── 主推进器 ──
  window.usdcPayAdvance = async () => {
    if (!cur || cur.busy || cur.step === 'waiting' || cur.step === 'deposited') return
    cur.busy = true; cur.msg = ''; render()
    try { await runSteps() } catch (e) { say(escHtml(String((e && e.message) || e || '')), 'error'); cur.step = 'error' } finally { cur.busy = false; render() }
  }

  const runSteps = async () => {
    // ① 钱包在不在
    if (!window.webazWalletAvailable()) { cur.step = 'nowallet'; return }
    // ② 连接(用户拒签 → 停,不重试)
    const c = await window.webazWalletConnect()
    if (!c.ok) { cur.step = 'intro'; return sayProvider(c, t('连接钱包失败')) }
    if (cur.addr && cur.addr !== c.address) { cur.voucher = null }   // 账户变了 → 旧 voucher 立刻作废(digest 绑 buyer)
    cur.addr = c.address
    // ③ 链检查 / 切换(切换被拒 → 停在链检查步)
    const ck = await window.webazWalletChainOk(cur.chainId)
    if (!ck.ok) { cur.step = 'chain'; return sayProvider(ck, t('读取钱包网络失败')) }
    if (!ck.matches) {
      const sw = await window.webazWalletSwitchChain(cur.chainId)
      if (!sw.ok) { cur.step = 'chain'; return sayProvider(sw, t('切换网络失败')) }
      const ck2 = await window.webazWalletChainOk(cur.chainId)
      if (!ck2.ok || !ck2.matches) { cur.step = 'chain'; return say(t('钱包仍不在正确的网络上,无法继续。请在钱包里切换后重试。'), 'error') }
    }
    // ④ 取存入授权(已有且未过期则复用)
    if (voucherExpired() && !(await fetchVoucher())) return
    const v = cur.voucher
    const amount = BigInt(v.deposit_call.amount)
    // ⑤ 只读:余额 / 已授权额度
    const balR = await window.webazWalletCall(v.reads.balance)
    if (!balR.ok) { cur.step = 'error'; return sayProvider(balR, t('读取 USDC 余额失败')) }
    const bal = window.webazHexToBigInt(balR.result)
    const allowR = await window.webazWalletCall(v.reads.allowance)
    if (!allowR.ok) { cur.step = 'error'; return sayProvider(allowR, t('读取 USDC 授权额度失败')) }
    const allow = window.webazHexToBigInt(allowR.result)
    if (bal === null || allow === null) { cur.step = 'error'; return say(t('钱包返回了无法解析的链上读取结果,未发出任何交易。请稍后重试。'), 'error') }
    // ⑥ 余额不足 → 诚实停下,显示差额,绝不发任何交易
    if (bal < amount) {
      cur.step = 'insufficient'
      say(t('当前余额 {have} USDC,本单需要 {need} USDC,还差 {short} USDC。')
        .replace('{have}', window.webazUnits6ToText(bal)).replace('{need}', window.webazUnits6ToText(amount)).replace('{short}', window.webazUnits6ToText(amount - bal)), 'error')
      return
    }
    // ⑦ 额度足够就【跳过 approve】(不多发一笔 tx);不够则按【精确额度】授权(后端编码,绝非 infinite)
    if (allow < amount) {
      const ap = await window.webazWalletSend({ to: v.calls.approve.to, data: v.calls.approve.data, from: cur.addr })
      if (!ap.ok) { cur.step = 'error'; return sayProvider(ap, t('提交授权交易失败')) }
      const rc = await waitReceipt(ap.hash)
      if (!rc.ok || !rc.succeeded) { cur.step = 'error'; return say(t('授权交易未能在链上成功,未发出存入交易。请在钱包里确认后重试。'), 'error') }
    }
    // ⑧ 存入前最后一道过期闸:过期 → 自动重取一次;再过期才报错(绝不拿过期凭证去烧 gas)
    if (voucherExpired()) {
      if (cur.reissued) { cur.step = 'error'; return say(t('存入授权已过期,重新获取后仍然过期。请刷新页面重试。'), 'error') }
      cur.reissued = true
      if (!(await fetchVoucher())) return
      if (voucherExpired()) { cur.step = 'error'; return say(t('存入授权已过期,重新获取后仍然过期。请刷新页面重试。'), 'error') }
      say(t('存入授权已过期,已自动重新获取。'), 'warn')
    }
    // ⑨ 发存入 tx —— 之后【不写任何订单状态】,只等 watcher(D2)
    const dep = await window.webazWalletSend({ to: cur.voucher.calls.deposit.to, data: cur.voucher.calls.deposit.data, from: cur.addr })
    if (!dep.ok) { cur.step = 'error'; return sayProvider(dep, t('提交存入交易失败')) }
    cur.txHash = dep.hash
    ls(() => localStorage.setItem(DEP_KEY(cur.orderId), dep.hash))   // D4 一次性守卫
    cur.step = 'waiting'; cur.msg = ''
    startWaiting()
  }

  const startWaiting = () => {
    if (cur.stop) cur.stop()
    cur.stop = window.usdcEscrowPollStatus(cur.orderId, (data, why) => {
      if (!cur || !cur.el || !cur.el.isConnected) return true
      if (why === 'timeout') { say(t('链上确认时间超出预期。资金安全不受影响(以链上为准),你可以稍后刷新本页查看,或用上面的交易哈希在区块浏览器核对。'), 'warn'); render(); return true }
      if (data && data.deposited_seen) {
        ls(() => localStorage.removeItem(DEP_KEY(cur.orderId)))
        cur.step = 'deposited'; cur.status = data; render()
        if (window._orderPollNow) window._orderPollNow()   // 只读重拉订单详情(前端永不自己写状态)
        return true
      }
      return false
    })
  }

  const teardown = () => {
    if (cur && cur.stop) { cur.stop(); cur.stop = null }
    offs.forEach((f) => { try { f() } catch { /* provider 不支持注销 */ } }); offs = []
  }
  window.usdcEscrowTeardown = teardown

  // D3:换账号 / 换链 → voucher 立即作废并回到第 1 步(EIP-712 digest 绑死 buyer 地址与 chainId)。
  const bindWalletEvents = () => {
    const reset = (msg) => {
      if (!cur) return
      cur.voucher = null; cur.addr = null; cur.reissued = false
      if (cur.step !== 'waiting' && cur.step !== 'deposited') { cur.step = 'intro'; say(msg, 'warn') }
      render()
    }
    offs.push(window.webazWalletOn('accountsChanged', () => reset(t('检测到钱包账户变更,原存入授权已作废,需要重新获取。'))))
    offs.push(window.webazWalletOn('chainChanged', () => reset(t('检测到钱包网络变更,原存入授权已作废,需要重新获取。'))))
  }

  /** 订单详情容器(app.js 内联渲染,零新增行);非本轨 / 非买家 → 空串。 */
  window.usdcEscrowOrderCard = (order, isBuyer) => {
    if (!order || order.payment_rail !== 'usdc_escrow' || !isBuyer) return ''
    return `<div id="usdc-escrow-card" data-order-id="${escHtml(String(order.id))}"></div>`
  }

  /** 订单详情 hydrate:读一次 status,按链上态分派到"存入 stepper"或"释放/争议面"。 */
  window.usdcEscrowHydrate = async (order, isBuyer) => {
    const el = typeof document !== 'undefined' ? document.getElementById('usdc-escrow-card') : null
    if (!el || !order || order.payment_rail !== 'usdc_escrow' || !isBuyer) return
    teardown(); cur = null
    const mine = ++seq
    const r = await window.apiRead('/orders/' + encodeURIComponent(order.id) + '/usdc-escrow/status')
    if (!el.isConnected || mine !== seq) return
    const st = (r && r.ok && r.data) ? r.data : null
    if (!st) {
      el.innerHTML = `<div class="card">${box('#fffbeb', '#fde68a', '#92400e', `<b>${t('暂时无法读取链上担保状态')}</b><br>${t('这不影响链上资金:合约状态以链上为准。请稍后重试。')}`)}</div>`
      return
    }
    // fail-closed:只要链上/凭证任一面显示本单已入金,就【绝不】再渲染存入 stepper —— 渲染它就是在诱导重复存入。
    //   释放面模块缺失(理论不可能,index.html 顺序锁死)时给只读说明,而不是退回 stepper。
    if (st.deposited_seen || st.released_seen || st.intent_status === 'funded' || st.intent_status === 'released') {
      if (window.usdcEscrowReleaseRender) return void window.usdcEscrowReleaseRender(order, el, st)
      el.innerHTML = `<div class="card">${box('#eff6ff', '#bfdbfe', '#1e40af', t('本单的 USDC 已在链上担保合约中。请勿重复存入 —— 同一订单在合约里只能存入一次。'))}</div>`
      return
    }
    cur = {
      order, orderId: order.id, el, status: st, chainId: Number(st.chain_id) || 0,
      step: 'intro', msg: '', kind: '', voucher: null, addr: null, txHash: '', reissued: false, busy: false, stop: null,
    }
    const pending = ls(() => localStorage.getItem(DEP_KEY(order.id)), '')
    if (pending) { cur.txHash = pending; cur.step = 'waiting' }               // D4 重进即等待态,按钮禁用
    else if (String(order.status) !== 'created') cur.step = 'closed'          // 付款窗已关且未存入
    bindWalletEvents(); render()
    if (cur.step === 'waiting') startWaiting()
  }

  /** 测试/调试用只读快照(不暴露任何写能力)。 */
  window._usdcPayState = () => (cur ? { step: cur.step, addr: cur.addr, txHash: cur.txHash, hasVoucher: !!cur.voucher, reissued: cur.reissued, msg: cur.msg, kind: cur.kind } : null)
})()
