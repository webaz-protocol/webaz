/**
 * USDC 合约担保 PR-B6a — voucher 签发 + 状态轮询(后端就绪层;前端 stepper/连钱包在 B6b)。
 *
 * 对应合约 contracts/WebazEscrow.sol(#518)的 `deposit(...)` EIP-712 授权。铁律:
 *   - 签名字段名/顺序/类型逐字对 DEPOSIT_TYPEHASH(否则 ECDSA.recover ≠ authorizationSigner → 链上 revert)。
 *   - 私钥只经 walletSigner.escrowVoucherAccount() seam(独立角色);绝不打印/落盘 key。
 *   - 金额换算:money.ts Units 刻度【就是】USDC 6dp(MONEY_SCALE=1e6),toUnits(total) 即链上 6dp 单位,
 *     零浮点乘法直转 BigInt(核验项:10 USDC→10_000_000、0.01→10_000、50 边界)。
 *   - 域逻辑(intents 写/读)在 usdc-escrow-store.ts;本文件只做 auth/守卫/签名/参数透传,零 db.prepare。
 *
 * 派生约定(B6a 定义,写死并测试钉住):
 *   orderIdBytes32 = keccak256(utf8Bytes(order.id));链上 orderKey = keccak256(abi.encodePacked(bytes32 orderId))
 *   = keccak256(orderIdBytes32 的字节)。viem keccak256 对 hex 输入按字节处理 → keccak256(orderIdBytes32 as Hex) 一致。
 *   intents.order_key 存 lowercase(B4 watcher lowercase 查询,跨 PR 不变量)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import type { Account } from 'viem'
import { encodeFunctionData, keccak256, toBytes, type Hex } from 'viem'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'
import { toUnits } from '../../money.js'
import { canonicalEvmAddress, listActivePayoutAddresses, upsertUsdcEscrowVoucherIntent, getUsdcEscrowStatus } from '../../usdc-escrow-store.js'
import { usdcEscrowRailEnabled, usdcEscrowPerTxCapUnits } from '../../usdc-escrow-create.js'

// ─── 纯派生(导出供测试快照钉;B8 链上验证前的唯一真相锚)─────────────────────
/** orderIdBytes32 = keccak256(utf8 bytes of order.id)。 */
export function deriveOrderIdBytes32(orderId: string): Hex {
  return keccak256(toBytes(orderId))
}
/** 链上 orderKey = keccak256(abi.encodePacked(bytes32 orderId)) = keccak256(orderIdBytes32 的字节)。lowercase 落库。 */
export function deriveOrderKey(orderIdBytes32: Hex): string {
  return keccak256(orderIdBytes32).toLowerCase()
}

// ─── B6b-2 D1:calldata 一律【后端】用 viem 编码,前端只签名发送 ──────────────────
// PWA 是无打包的裸 <script src>,没有 viem/ethers。deposit 带动态 `bytes authorization` 参数,
// 手搓 ABI 编码错一位 = 真钱进黑洞 —— 所以 encodeFunctionData 是唯一真相源,前端【只】把 {to,data}
// 原样交给钱包。
//
// 安全模型(三层,缺一不可):
//   ① 钱包自身会解码并展示 to/data 的调用内容 —— 用户在钱包弹窗里看到的是真实调用;
//   ② UI 必须【同屏】显示同一份金额 / 卖家收款地址 / 合约地址 / 平台费率,供用户与钱包弹窗交叉核对
//      (app-usdc-escrow-pay.js 的 stepper 每一步都渲染这组数字);
//   ③ 链上 perTxCap + voucher 绑死全部经济参数(orderId/seller/amount/feeBps/autoReleaseAt)
//      + orderId 一次性 → 即便这里的编码被篡改,损失上限被合约兜住,且参数不匹配签名会直接 revert。
// approve 一律【精确额度】(= 本单 amount),绝不 infinite approve。
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const
const ESCROW_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'orderId', type: 'bytes32' }, { name: 'seller', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'feeBps', type: 'uint256' }, { name: 'autoReleaseAt', type: 'uint64' }, { name: 'authExpiresAt', type: 'uint256' },
    { name: 'authorization', type: 'bytes' },
  ] },
  { type: 'function', name: 'buyerRelease', stateMutability: 'nonpayable', inputs: [{ name: 'orderId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'flagDispute', stateMutability: 'nonpayable', inputs: [{ name: 'orderId', type: 'bytes32' }], outputs: [] },
] as const

/** {to,data} 调用描述(前端原样交给钱包 eth_sendTransaction / eth_call,不做任何拼装)。 */
export interface EvmCall { to: string; data: Hex }

/**
 * env 地址归一(EIP-55)。配置缺失 → null(前端 fail-visible「链上配置未完成」,绝不猜地址);
 * 配置存在但非法 → 大声 log + null(同样 fail-visible;绝不把坏地址编进 calldata)。
 */
function envAddress(raw: string | undefined, label: string): string | null {
  if (!raw) return null
  const a = canonicalEvmAddress(raw)
  if (!a) console.error(`[usdc-escrow] ${label} is set but is not a valid EVM address — refusing to emit calldata`)
  return a
}

/** 买家存入所需的两笔写调用(approve 精确额度 + deposit 全参数)+ 两笔只读(allowance/balanceOf)。 */
export function buildDepositCalls(a: {
  usdcToken: string; contract: string; buyer: string; seller: string
  orderIdBytes32: Hex; amount: bigint; feeBps: number; autoReleaseAt: number; authExpiresAt: number; authorization: Hex
}): { calls: { approve: EvmCall; deposit: EvmCall }; reads: { allowance: EvmCall; balance: EvmCall } } {
  return {
    calls: {
      // 精确额度:value === amount(本单金额),绝不 type(uint256).max —— 存入后 allowance 自然归零。
      approve: { to: a.usdcToken, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [a.contract as `0x${string}`, a.amount] }) },
      deposit: { to: a.contract, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'deposit', args: [a.orderIdBytes32, a.seller as `0x${string}`, a.amount, BigInt(a.feeBps), BigInt(a.autoReleaseAt), BigInt(a.authExpiresAt), a.authorization] }) },
    },
    reads: {
      allowance: { to: a.usdcToken, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'allowance', args: [a.buyer as `0x${string}`, a.contract as `0x${string}`] }) },
      balance: { to: a.usdcToken, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [a.buyer as `0x${string}`] }) },
    },
  }
}

/** buyerRelease(bytes32) / flagDispute(bytes32) —— 两者的链上授权都是 msg.sender==buyer,后端只编码不代发。 */
export function buildEscrowOrderCall(contract: string, orderIdBytes32: Hex, fn: 'buyerRelease' | 'flagDispute'): EvmCall {
  return { to: contract, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: fn, args: [orderIdBytes32] }) }
}

/** EIP-712 typed data(字段名/顺序/类型逐字对 contracts/WebazEscrow.sol DEPOSIT_TYPEHASH)。导出供测试用 verifyTypedData 验签。 */
export function buildDepositTypedData(args: {
  contract: string; chainId: number; orderIdBytes32: Hex; buyer: string; seller: string
  amount: bigint; feeBps: number; autoReleaseAt: number; authExpiresAt: number
}) {
  return {
    domain: { name: 'WebazEscrow', version: '1', chainId: args.chainId, verifyingContract: args.contract as `0x${string}` },
    types: {
      Deposit: [
        { name: 'orderId', type: 'bytes32' },
        { name: 'buyer', type: 'address' },
        { name: 'seller', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'feeBps', type: 'uint256' },
        { name: 'autoReleaseAt', type: 'uint256' },   // 合约 typed-data 里为 uint256(结构体存 uint64,structHash 用 uint256(autoReleaseAt))
        { name: 'authExpiresAt', type: 'uint256' },
      ],
    },
    primaryType: 'Deposit' as const,
    message: {
      orderId: args.orderIdBytes32,
      buyer: args.buyer as `0x${string}`,
      seller: args.seller as `0x${string}`,
      amount: args.amount,
      feeBps: BigInt(args.feeBps),
      autoReleaseAt: BigInt(args.autoReleaseAt),
      authExpiresAt: BigInt(args.authExpiresAt),
    },
  }
}

export interface UsdcEscrowRouteDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  getProtocolParam: <T>(k: string, fb: T) => T
  /** walletSigner.escrowVoucherAccount() seam(独立角色 = 合约 authorizationSigner)。 */
  escrowVoucherAccount: () => Account
  /** 滑窗限流 seam(server.ts rateLimitOk;缺省=放行,便于单测)。 */
  rateLimitOk?: (key: string, max?: number, windowMs?: number) => boolean
}

interface OrderRow {
  id: string; buyer_id: string; seller_id: string; status: string
  payment_rail: string; total_amount: number; source: string | null; pay_open: number; pay_deadline: string
}

export function registerUsdcEscrowRoutes(app: Application, deps: UsdcEscrowRouteDeps): void {
  const { db, auth, isTrustedRole, getProtocolParam: gp, escrowVoucherAccount } = deps
  const rateLimitOk = deps.rateLimitOk ?? ((): boolean => true)

  // POST /api/orders/:id/usdc-escrow/voucher —— 买家:签发一次性 EIP-712 存款授权。
  app.post('/api/orders/:id/usdc-escrow/voucher', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void res.status(403).json({ error: '运营角色账号不可参与订单流转', error_code: 'TRUSTED_ROLE_NO_TRADE' })
    const uid = String(user.id)
    // 滑窗限流(签名是每次签发一次 ECDSA + 一次 tx;防同一用户高频刷签)。10 次/分钟/用户,超限 429。
    if (!rateLimitOk(`usdc_voucher:${uid}`, 10, 60_000)) return void res.status(429).json({ error: '签发过于频繁,请稍后再试', error_code: 'USDC_ESCROW_VOUCHER_RATE_LIMITED' })

    // 订单读(含 pay_deadline 在 SQL 内 datetime() 归一比较,防裸文本 lex 失明;另取 pay_deadline 原值供 auth_expires 钳制)—— 异步 seam
    const order = await dbOne<OrderRow>(
      `SELECT id, buyer_id, seller_id, status, payment_rail, total_amount, source, pay_deadline,
              (datetime(pay_deadline) >= datetime('now')) AS pay_open
       FROM orders WHERE id = ?`, [req.params.id])
    // 守卫顺序(全部 fail-closed)：
    if (!order) return void res.status(404).json({ error: '订单不存在', error_code: 'ORDER_NOT_FOUND' })
    // ① 买家本人
    if (order.buyer_id !== uid) return void res.status(403).json({ error: '你不是本订单的买家', error_code: 'NOT_ORDER_BUYER' })
    // ② 本轨
    if (order.payment_rail !== 'usdc_escrow') return void res.status(409).json({ error: '该操作仅适用于 USDC 合约担保订单', error_code: 'USDC_ESCROW_VOUCHER_WRONG_RAIL' })
    // ③ created 且付款窗未过(链上未存入才可签发存款授权)
    if (order.status !== 'created' || Number(order.pay_open) !== 1) return void res.status(409).json({ error: '订单不在可签发存款授权的付款窗口(需未存入且未超时)', error_code: 'USDC_ESCROW_VOUCHER_NOT_OPEN' })
    // ④ 渠道开 + 合约已配
    if (!usdcEscrowRailEnabled(gp)) return void res.status(409).json({ error: 'USDC 合约担保轨未开放', error_code: 'RAIL_DISABLED' })
    const contract = process.env.USDC_ESCROW_CONTRACT
    if (!contract) return void res.status(409).json({ error: 'USDC 合约担保轨未配置(合约地址缺失)', error_code: 'USDC_ESCROW_NOT_CONFIGURED' })
    // ⑤ 买家链上地址合法(EIP-55 归一)
    const buyerAddr = canonicalEvmAddress(req.body?.buyer_address)
    if (!buyerAddr) return void res.status(400).json({ error: '无效的买家链上地址(0x + 40 位十六进制)', error_code: 'USDC_ESCROW_VOUCHER_BAD_ADDRESS' })
    // ⑥ 卖家仍有 active 收款地址(取第一个 active 为 seller_addr)
    const payouts = listActivePayoutAddresses(db, order.seller_id)
    if (payouts.length === 0) return void res.status(409).json({ error: '该卖家暂不支持 USDC 担保收款', error_code: 'USDC_ESCROW_SELLER_NOT_READY' })
    const sellerAddr = payouts[0].address
    // ⑦ 金额 ≤ per-tx cap（money units = USDC 6dp，无换算）
    const amountU = toUnits(Number(order.total_amount) || 0)
    if (amountU <= 0) return void res.status(409).json({ error: '订单金额无效', error_code: 'USDC_ESCROW_VOUCHER_BAD_AMOUNT' })   // 建单恒 total>0,防御性:金额非法用诚实码(非 NOT_OPEN 误导)
    if (amountU > usdcEscrowPerTxCapUnits(gp)) return void res.status(409).json({ error: '超出 USDC 担保单笔上限', error_code: 'USDC_ESCROW_CAP_EXCEEDED' })

    // ── 计算 voucher 经济参数 ──
    const orderIdBytes32 = deriveOrderIdBytes32(order.id)
    const orderKey = deriveOrderKey(orderIdBytes32)
    const amount = BigInt(amountU)                                   // 6dp 链上单位
    const feeBps = order.source === 'secondhand' ? 100 : 200         // 二手 1% / 其它 2%(bps);口径同 direct-pay-fee-ar.ts feeUnitsForOrder(0.01/0.02)
    const nowSec = Math.floor(Date.now() / 1000)
    // 路由级自立钳制 [3,90] 天:合约 deposit 对 autoReleaseAt 有上界(perTx 窗),越界的越权 param-store 值
    //   会让每笔存入链上 revert —— 不能只依赖 param-store bounds,路由层再钳一道(fail-closed)。
    const autoReleaseDays = Math.min(90, Math.max(3, Number(gp('usdc_escrow.auto_release_days', 14)) || 14))
    const autoReleaseAt = nowSec + autoReleaseDays * 86400           // uint64 范围
    const ttlMin = Math.max(1, Number(gp('usdc_escrow.voucher_ttl_minutes', 60)) || 60)
    // authExpiresAt 钳到付款窗:凭证有效期绝不超过 pay_deadline —— 否则订单取消后 voucher 仍可存入(最多长 TTL)。
    //   pay_deadline 解析失败(理论不该,建单必写)→ 回退 now+ttl(不放宽,与旧行为一致)。
    const payDeadlineMs = Date.parse(order.pay_deadline)
    const authExpiresAt = Number.isFinite(payDeadlineMs)
      ? Math.min(nowSec + ttlMin * 60, Math.floor(payDeadlineMs / 1000))
      : nowSec + ttlMin * 60
    const chainId = (process.env.NETWORK || 'testnet').toLowerCase() === 'mainnet' ? 8453 : 84532

    // ── 签名(walletSigner seam;字段逐字对 TYPEHASH)──
    const typedData = buildDepositTypedData({ contract, chainId, orderIdBytes32, buyer: buyerAddr, seller: sellerAddr, amount, feeBps, autoReleaseAt, authExpiresAt })
    let authorization: `0x${string}`
    try {
      const account = escrowVoucherAccount()
      if (!account.signTypedData) throw new Error('voucher signer lacks signTypedData')
      authorization = await account.signTypedData(typedData)
    } catch (e) {
      // 签名失败=签名者/seam 故障(500,ops 事故)—— 绝不复用 NOT_OPEN(409,那是订单状态门,会误导 triage)。
      return void res.status(500).json({ error: 'voucher 签名失败:' + (e as Error).message, error_code: 'USDC_ESCROW_VOUCHER_SIGN_FAILED' })
    }

    // ── 落库(单 sync tx;域逻辑在 store)──
    const w = upsertUsdcEscrowVoucherIntent(db, {
      orderId: order.id, orderKey, contractAddr: contract, buyerId: uid, sellerId: order.seller_id, sellerAddr,
      amountUnits: amountU, feeBps,
      autoReleaseAtIso: new Date(autoReleaseAt * 1000).toISOString(),
      voucherSig: authorization,
      authExpiresAtIso: new Date(authExpiresAt * 1000).toISOString(),
      buyerAddr, chainId,   // B6b-2 A3/A5:买家链上地址快照 + 签发时链 id 快照(release preflight / env-flip 保护读它)
    })
    if (!w.ok) return void res.status(409).json({ error: w.error, error_code: w.error_code })

    // B6b-2 D1:两个地址都归一到 EIP-55 后才编码 calldata;任一缺失/非法 → 不返回 calls/reads
    //   (前端 fail-visible「链上配置未完成」,绝不猜地址、绝不手搓编码)。
    const usdcToken = envAddress(process.env.USDC_TOKEN_ADDRESS, 'USDC_TOKEN_ADDRESS')
    const contractAddr = envAddress(contract, 'USDC_ESCROW_CONTRACT')
    const encoded = (usdcToken && contractAddr)
      ? buildDepositCalls({ usdcToken, contract: contractAddr, buyer: buyerAddr, seller: sellerAddr, orderIdBytes32, amount, feeBps, autoReleaseAt, authExpiresAt, authorization })
      : null

    res.json({
      success: true,
      deposit_call: {
        order_id_bytes32: orderIdBytes32,
        // B6b-2:digest 绑定的买家地址(EIP-55 canonical)。裸 PWA 里没有 keccak,做不出 checksum 形态 ——
        //   前端拿这一份回显给用户核对,并用它比对当前连接的账户(不一致即作废重签,D3)。
        buyer: buyerAddr,
        seller: sellerAddr,
        amount: amount.toString(),        // 6dp string(链上 deposit 参数)
        fee_bps: feeBps,
        auto_release_at: autoReleaseAt,   // unix 秒
        auth_expires_at: authExpiresAt,   // unix 秒
        authorization,                    // EIP-712 signature hex
      },
      contract,
      chain_id: chainId,
      usdc_token: usdcToken,
      ...(encoded ? { calls: encoded.calls, reads: encoded.reads } : {}),
      note: `请用你的链上钱包(地址 ${buyerAddr})对 WebAZ 担保合约 approve ${amount.toString()} 个 USDC(6dp)后调用 deposit;本金由链上合约托管;合约只把钱付给买家、卖家或平台费三个去向,平台无法转给任意地址。授权将于 ${authExpiresAt} 前有效。 / Approve ${amount.toString()} USDC (6dp) to the WebAZ escrow contract from ${buyerAddr}, then call deposit; funds are held on-chain by the contract, which can only pay the buyer, the seller or the platform fee — never an arbitrary address. This authorization expires at ${authExpiresAt}.`,
    })
  })

  // GET /api/orders/:id/usdc-escrow/status —— 买家或卖家:轮询存入/释放可见性(B6b stepper)。
  app.get('/api/orders/:id/usdc-escrow/status', async (req, res) => {
    // B6b-2 D2 铁律:本端点是链上真相给前端的【只读】通道。存入/放款 tx 广播后前端绝不写任何订单状态,
    //   只轮询这里等 watcher 把链上 Deposited/Released 镜像进来。
    const user = auth(req, res); if (!user) return
    const uid = String(user.id)
    const order = await dbOne<{ status: string; buyer_id: string; seller_id: string }>(
      'SELECT status, buyer_id, seller_id FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在', error_code: 'ORDER_NOT_FOUND' })
    if (uid !== order.buyer_id && uid !== order.seller_id) return void res.status(403).json({ error: '只有买卖双方可查询', error_code: 'NOT_ORDER_PARTY' })
    const s = getUsdcEscrowStatus(db, req.params.id)
    // B6b-2 A5:chain_id 取 intent【签发时快照】,与 contract 同源 —— testnet→mainnet env flip 后在途单
    //   绝不被切到新链却把 tx 发给旧链期合约地址(白烧 gas)。旧凭证无快照(null)→ 退回 live env(不放宽)。
    const chainId = s.chain_id ?? ((process.env.NETWORK || 'testnet').toLowerCase() === 'mainnet' ? 8453 : 84532)
    const autoReleaseMs = s.auto_release_at ? Date.parse(s.auto_release_at) : NaN
    const autoReleaseAt = Number.isFinite(autoReleaseMs) ? Math.floor(autoReleaseMs / 1000) : null
    // B6b-2 D1:链上可执行时才编 calldata,且【只给买家】—— buyerRelease/flagDispute 的链上授权都是
    //   msg.sender == escrow.buyer,给卖家一份必然 revert 的 calldata 是误导。合约态门:
    //     Funded = Deposited 已镜像、Released 未镜像、且 Disputed 未镜像(Disputed 后只能 arbiterResolve
    //     退出,两个买家调用都会 BadState revert);flagDispute 对买家还有 autoReleaseAt 的【exclusive】
    //     边界(t >= autoReleaseAt 买家即不可再 flag,合约 AutoReleaseWindowPassed)。
    //   合约地址用 intent 的【签发时快照】而非当前 env:这单的钱就在那个合约里,env 轮换不能改写历史。
    // B6b-2 A4:funded 门必须【同时】看链上镜像与 intent 状态 —— 参数失配的存款(陈旧 voucher 可达)会让
    //   watcher 告警"勿发货、平台核对中"却【不】把 intent 提升到 funded(仍 issued)。只看 deposited_seen 会
    //   发出释放按钮,与 watcher 告警自相矛盾;加 intent_status==='funded' 后失配单不再下发任何可执行 calldata。
    const funded = s.deposited_seen && !s.released_seen && !s.disputed_seen && s.intent_status === 'funded'
    const contractAddr = envAddress(s.contract_addr ?? undefined, 'usdc_escrow_intents.contract_addr')
    const calls: Record<string, EvmCall> = {}
    if (uid === order.buyer_id && funded && contractAddr) {
      const b32 = deriveOrderIdBytes32(req.params.id)
      calls.release = buildEscrowOrderCall(contractAddr, b32, 'buyerRelease')
      if (autoReleaseAt !== null && Math.floor(Date.now() / 1000) < autoReleaseAt) calls.flag_dispute = buildEscrowOrderCall(contractAddr, b32, 'flagDispute')
    }
    res.json({
      order_status: order.status, intent_status: s.intent_status,
      deposited_seen: s.deposited_seen, released_seen: s.released_seen, disputed_seen: s.disputed_seen,
      chain_id: chainId, contract: s.contract_addr, seller: s.seller_addr,
      amount: s.amount_units === null ? null : String(s.amount_units), fee_bps: s.fee_bps,
      auto_release_at: autoReleaseAt,
      // B6b-2 A3:存款账户地址【只给买家自己】(卖家不可见)—— release 面比对当前连接账户,避免换账号白烧 gas。
      ...(uid === order.buyer_id && s.buyer_addr ? { buyer_addr: s.buyer_addr } : {}),
      ...(Object.keys(calls).length > 0 ? { calls } : {}),
    })
  })
}
