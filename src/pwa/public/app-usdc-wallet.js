// USDC 合约担保 PR-B6b-2 —— EIP-1193 基础层(本仓库【唯一】接触 window.ethereum 的文件)。
//   PWA 是无打包的裸 <script src>:没有 viem/ethers,也【绝不】在这里手搓 ABI 编码或 keccak —— 所有 calldata
//   由后端 viem encodeFunctionData 产出({to,data}),本层只负责把它原样交给用户自己的钱包签名/发送。
//   零外联:本文件不发起任何 HTTP 请求(无 fetch/XHR/import()/eval)。下面 CHAIN_PARAMS 里的 URL 字符串是
//   wallet_addEthereumChain 的【参数】—— 由钱包自己去连,页面永不请求它们。
//   全部 provider 调用 try/catch 归一成 { ok:false, code, message },绝不把裸 provider error 抛给 UI。
;(function () {
  // Base / Base Sepolia 的 wallet_addEthereumChain 参数(硬编码;chainId 必须是 hex 字符串)。
  const CHAIN_PARAMS = {
    8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
    84532: { chainId: '0x14a34', chainName: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] },
  }
  window.webazWalletChainParams = (chainId) => CHAIN_PARAMS[Number(chainId)] || null
  window.webazWalletExplorerTx = (chainId, hash) => {
    const p = CHAIN_PARAMS[Number(chainId)]
    return (p && p.blockExplorerUrls && p.blockExplorerUrls[0] && /^0x[0-9a-fA-F]{64}$/.test(String(hash || ''))) ? p.blockExplorerUrls[0] + '/tx/' + hash : ''
  }

  const provider = () => (window.ethereum && typeof window.ethereum.request === 'function') ? window.ethereum : null
  window.webazWalletAvailable = () => !!provider()

  // provider error → { ok:false, code, message }。code 优先取 EIP-1193 数字码(4001 拒签 / 4902 链未添加),
  //   缺失时给符号码。message 只取 provider 的短消息,不外泄堆栈。
  const err = (e, fallbackCode) => {
    const raw = (e && (e.code !== undefined ? e.code : (e.data && e.data.originalError && e.data.originalError.code)))
    const code = (raw === undefined || raw === null) ? (fallbackCode || 'WALLET_ERROR') : raw
    let message = ''
    try { message = String((e && (e.message || e.reason)) || '') } catch { message = '' }
    return { ok: false, code, message: message.slice(0, 300) }
  }
  const NO_WALLET = () => ({ ok: false, code: 'NO_WALLET', message: 'no EIP-1193 provider' })

  // 0x + 40 hex → 小写归一。⚠️ 故意【不】做 EIP-55 checksum:裸 PWA 里没有 keccak256,手搓校验和是无谓的
  //   密码学自造轮子。checksum 形态由后端 canonicalEvmAddress(viem getAddress)产出并回显,UI 只展示后端那份。
  const normAddr = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a || '')) ? String(a).toLowerCase() : null)
  window.webazWalletNormAddr = normAddr

  /** eth_requestAccounts。用户拒签(4001)如实返回,调用方不得静默重试。 */
  window.webazWalletConnect = async () => {
    const p = provider(); if (!p) return NO_WALLET()
    try {
      const accs = await p.request({ method: 'eth_requestAccounts' })
      const a = normAddr(accs && accs[0])
      return a ? { ok: true, address: a } : { ok: false, code: 'NO_ACCOUNT', message: 'wallet returned no account' }
    } catch (e) { return err(e, 'CONNECT_FAILED') }
  }

  /** 当前已授权账户(不弹窗;未连接 → address:null)。换账号检测用。 */
  window.webazWalletAccount = async () => {
    const p = provider(); if (!p) return NO_WALLET()
    try { const accs = await p.request({ method: 'eth_accounts' }); return { ok: true, address: normAddr(accs && accs[0]) } } catch (e) { return err(e, 'ACCOUNTS_FAILED') }
  }

  /** eth_chainId(hex)→ 十进制比对。绝不 parseInt 十六进制大数,统一 BigInt→Number。 */
  window.webazWalletChainOk = async (expectedChainId) => {
    const p = provider(); if (!p) return NO_WALLET()
    try {
      const hex = await p.request({ method: 'eth_chainId' })
      const n = window.webazHexToBigInt(hex)
      if (n === null) return { ok: false, code: 'BAD_CHAIN_ID', message: String(hex) }
      const chainId = Number(n)
      return { ok: true, chainId, matches: chainId === Number(expectedChainId) }
    } catch (e) { return err(e, 'CHAIN_ID_FAILED') }
  }

  /** wallet_switchEthereumChain;4902(链未添加)→ wallet_addEthereumChain 补参数后再报结果。 */
  window.webazWalletSwitchChain = async (chainId) => {
    const p = provider(); if (!p) return NO_WALLET()
    const params = CHAIN_PARAMS[Number(chainId)]
    if (!params) return { ok: false, code: 'UNKNOWN_CHAIN', message: String(chainId) }
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] })
      return { ok: true, added: false }
    } catch (e) {
      const code = (e && e.code !== undefined) ? e.code : ((e && e.data && e.data.originalError && e.data.originalError.code) !== undefined ? e.data.originalError.code : null)
      if (Number(code) !== 4902) return err(e, 'SWITCH_FAILED')
      try { await p.request({ method: 'wallet_addEthereumChain', params: [params] }); return { ok: true, added: true } } catch (e2) { return err(e2, 'ADD_CHAIN_FAILED') }
    }
  }

  /** eth_call 只读(返回 hex 结果串)。金额解析一律走 webazHexToBigInt。 */
  window.webazWalletCall = async (call) => {
    const p = provider(); if (!p) return NO_WALLET()
    if (!call || !call.to || !call.data) return { ok: false, code: 'BAD_CALL', message: 'missing to/data' }
    try { return { ok: true, result: await p.request({ method: 'eth_call', params: [{ to: call.to, data: call.data }, 'latest'] }) } } catch (e) { return err(e, 'CALL_FAILED') }
  }

  /** eth_sendTransaction —— to/data 原样来自后端编码,本层【不拼装、不改写】任何字节。 */
  window.webazWalletSend = async (tx) => {
    const p = provider(); if (!p) return NO_WALLET()
    if (!tx || !tx.to || !tx.data || !tx.from) return { ok: false, code: 'BAD_CALL', message: 'missing to/data/from' }
    try {
      const hash = await p.request({ method: 'eth_sendTransaction', params: [{ to: tx.to, data: tx.data, from: tx.from }] })
      return /^0x[0-9a-fA-F]{64}$/.test(String(hash || '')) ? { ok: true, hash: String(hash) } : { ok: false, code: 'BAD_TX_HASH', message: String(hash) }
    } catch (e) { return err(e, 'SEND_FAILED') }
  }

  /** eth_getTransactionReceipt(未上链 → receipt:null)。status 为 '0x1' 才算成功。 */
  window.webazWalletReceipt = async (hash) => {
    const p = provider(); if (!p) return NO_WALLET()
    try {
      const r = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] })
      if (!r) return { ok: true, receipt: null, mined: false, succeeded: false }
      return { ok: true, receipt: r, mined: true, succeeded: String(r.status) === '0x1' }
    } catch (e) { return err(e, 'RECEIPT_FAILED') }
  }

  /** accountsChanged / chainChanged 监听注册。返回可调用的注销函数(provider 无 on/removeListener → no-op)。 */
  window.webazWalletOn = (event, cb) => {
    const p = provider()
    if (!p || typeof p.on !== 'function') return () => {}
    try { p.on(event, cb) } catch { return () => {} }
    return () => { try { if (typeof p.removeListener === 'function') p.removeListener(event, cb) } catch { /* provider 不支持注销 */ } }
  }

  /** 32 字节 hex(allowance/balanceOf 的返回)→ BigInt。绝不 parseInt/Number(2^53 后静默失真)。失败 → null。 */
  window.webazHexToBigInt = (hex) => {
    const s = String(hex === undefined || hex === null ? '' : hex).trim()
    if (!/^0x[0-9a-fA-F]*$/.test(s) || s.length < 3) return null
    try { return BigInt(s) } catch { return null }
  }

  /** 6dp 整数单位 BigInt → 人读 USDC 串(纯整数运算,零浮点)。 */
  window.webazUnits6ToText = (units) => {
    let v; try { v = BigInt(units) } catch { return '' }
    const neg = v < 0n; if (neg) v = -v
    const whole = v / 1000000n, frac = String(v % 1000000n).padStart(6, '0').replace(/0+$/, '')
    return (neg ? '-' : '') + String(whole) + (frac ? '.' + frac : '')
  }

  /** 地址中段省略显示(0x1234…abcd);非法输入原样回显(绝不静默吞掉配置错误)。 */
  window.webazShortAddr = (a) => {
    const s = String(a || '')
    return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.slice(0, 6) + '…' + s.slice(-4) : s
  }
})()
