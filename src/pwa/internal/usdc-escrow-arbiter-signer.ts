/**
 * USDC 链上合约担保(B 线)PR-B7a — arbiter 交易签发器(链上 arbiterResolve / arbiter-side flagDispute)。
 *
 * 对应合约 contracts/WebazEscrow.sol(#518):
 *   - arbiterResolve(bytes32 orderId, uint256 buyerRefund):仅 msg.sender==arbiter、仅 Disputed 态;
 *     是【平台唯一能把托管 USDC 移出合约】的入口。buyerRefund∈[0,amount];sellerBound=amount-buyerRefund、
 *     fee=sellerBound*feeBps/10000、sellerPay=sellerBound-fee;buyerRefund+sellerPay+fee==amount 恒等。
 *   - flagDispute(bytes32 orderId):arbiter 侧无时间窗(买家丢钱包/不配合时冻结);仅 Funded 态 → Disputed。
 *
 * 铁律(真钱纪律,审计重点):
 *   - arbiter 私钥【只】经 walletSigner.arbiterAccount() seam 注入的 walletClient;本模块绝不打印/落盘/返回 key。
 *   - orderId → bytes32 复用 routes/usdc-escrow.ts 的 deriveOrderIdBytes32(绝不各写一份);orderKey 复用 deriveOrderKey。
 *   - 金额一律 BigInt;发链上 tx 【前】先 readContract 读 escrow 记录做前置态校验(state / amount 边界)——
 *     不符即返回 error,绝不构造/广播必 revert 的 tx(fail-visible,不烧 gas)。
 *   - waitForTransactionReceipt 后必查 receipt.status==='success';reverted / 抛错一律归一 error,绝不假成功。
 *   - 缺 USDC_ESCROW_CONTRACT → 直接 { ok:false, error:'not configured' },不构造 client。
 *   - 本模块只发链上 tx + 返回结果;DB 状态收敛由 watcher 消费 Resolved/Disputed 事件驱动(usdc-escrow-settle.ts);
 *     admin 审计(actor/purpose/txHash)由调用路由(routes/usdc-escrow-arbiter.ts)记 —— 本模块不碰 DB、不碰审计。
 */
import { encodeFunctionData, type Hex } from 'viem'
import { deriveOrderIdBytes32, deriveOrderKey } from '../routes/usdc-escrow.js'

// ─── EscrowState 枚举(逐字对合约 enum EscrowState)──────────────────
export const ESCROW_STATE = { None: 0, Funded: 1, Disputed: 2, Released: 3, Resolved: 4, Refunded: 5 } as const

// ─── ABI 项(逐字对合约签名;错一位 = 真钱进黑洞 / 必 revert)────────────
// 写:arbiterResolve(bytes32,uint256) / flagDispute(bytes32)
const ARBITER_WRITE_ABI = [
  { type: 'function', name: 'arbiterResolve', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'orderId', type: 'bytes32' }, { name: 'buyerRefund', type: 'uint256' },
  ] },
  { type: 'function', name: 'flagDispute', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'orderId', type: 'bytes32' },
  ] },
] as const
// 读:public mapping getter escrows(bytes32) → EscrowRec 字段(逐字对 struct;enum 编码为 uint8)
const ESCROW_READ_ABI = [
  { type: 'function', name: 'escrows', stateMutability: 'view', inputs: [{ name: 'orderKey', type: 'bytes32' }], outputs: [
    { name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'amount', type: 'uint128' },
    { name: 'feeBps', type: 'uint16' }, { name: 'autoReleaseAt', type: 'uint64' }, { name: 'state', type: 'uint8' },
  ] },
] as const

/** viem readContract seam(只需 readContract + waitForTransactionReceipt);测试注入 fake,零网络。 */
export interface ArbiterPublicClient {
  readContract(args: { address: `0x${string}`; abi: unknown; functionName: string; args: unknown[] }): Promise<unknown>
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: 'success' | 'reverted' }>
}
/** viem walletClient seam(账户 = walletSigner.arbiterAccount());测试注入 fake,零网络。 */
export interface ArbiterWalletClient {
  writeContract(args: { address: `0x${string}`; abi: unknown; functionName: string; args: unknown[] }): Promise<`0x${string}`>
}

export interface ArbiterSignerDeps {
  arbiterWalletClient: ArbiterWalletClient
  publicClient: ArbiterPublicClient
  contractAddress: string | undefined   // process.env.USDC_ESCROW_CONTRACT;缺失 → not configured
}

export interface OnChainResult { ok: boolean; txHash?: string; error?: string }

/** 读链上 escrow 记录(state / amount)。返回 null = 读失败(调用方 fail-visible,绝不当作可发)。 */
async function readEscrow(deps: ArbiterSignerDeps, orderKey: string): Promise<{ amount: bigint; state: number } | { error: string }> {
  try {
    const rec = await deps.publicClient.readContract({
      address: deps.contractAddress as `0x${string}`, abi: ESCROW_READ_ABI, functionName: 'escrows', args: [orderKey as Hex],
    })
    // viem 对多返回值 getter 返回数组元组 [buyer,seller,amount,feeBps,autoReleaseAt,state];防御性兼容对象形态。
    const r = rec as Record<string, unknown> & unknown[]
    const amount = BigInt((Array.isArray(rec) ? rec[2] : r.amount) as bigint | number | string)
    const state = Number((Array.isArray(rec) ? rec[5] : r.state) as bigint | number | string)
    return { amount, state }
  } catch (e) {
    return { error: 'chain read failed: ' + (e as Error).message }
  }
}

/** 发送 tx + 等回执 + 校验 success;抛错/revert 归一 error,绝不假成功。 */
async function sendAndConfirm(
  deps: ArbiterSignerDeps, functionName: 'arbiterResolve' | 'flagDispute', args: unknown[],
): Promise<OnChainResult> {
  let txHash: `0x${string}`
  try {
    txHash = await deps.arbiterWalletClient.writeContract({
      address: deps.contractAddress as `0x${string}`, abi: ARBITER_WRITE_ABI, functionName, args,
    })
  } catch (e) {
    return { ok: false, error: 'send failed: ' + (e as Error).message }   // 未上链 → 无 txHash
  }
  try {
    const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') return { ok: false, error: 'tx reverted on-chain', txHash }
  } catch (e) {
    return { ok: false, error: 'receipt wait failed: ' + (e as Error).message, txHash }   // 已广播但回执不确定 → 带 txHash 供人工核
  }
  return { ok: true, txHash }
}

/**
 * arbiterResolve:裁决一笔 Disputed 托管。前置读链上态断言 state==Disputed 且 buyerRefund∈[0,amount],
 * 不符不发(不烧 gas)。calldata 用 deriveOrderIdBytes32(orderId) 编码(orderId 参数,非 orderKey)。
 */
export async function resolveDisputeOnChain(deps: ArbiterSignerDeps, args: { orderId: string; buyerRefund: bigint }): Promise<OnChainResult> {
  if (!deps.contractAddress) return { ok: false, error: 'not configured' }
  const orderIdBytes32 = deriveOrderIdBytes32(args.orderId)   // 合约 arbiterResolve/flagDispute 的 bytes32 orderId 参数
  const orderKey = deriveOrderKey(orderIdBytes32)             // 合约 escrows mapping 的键 = keccak256(orderId bytes32)
  if (args.buyerRefund < 0n) return { ok: false, error: 'buyerRefund is negative' }
  const chain = await readEscrow(deps, orderKey)
  if ('error' in chain) return { ok: false, error: chain.error }
  if (chain.state !== ESCROW_STATE.Disputed) return { ok: false, error: `escrow not in Disputed state (on-chain state=${chain.state})` }
  if (args.buyerRefund > chain.amount) return { ok: false, error: `buyerRefund ${args.buyerRefund} exceeds escrow amount ${chain.amount}` }
  return sendAndConfirm(deps, 'arbiterResolve', [orderIdBytes32, args.buyerRefund])
}

/**
 * flagDispute(arbiter 侧冻结):买家丢钱包/不配合时 arbiter 直接把 Funded → Disputed。前置读链上态断言
 * state==Funded,不符不发(合约对非 Funded 会 BadState revert)。
 */
export async function flagDisputeOnChain(deps: ArbiterSignerDeps, args: { orderId: string }): Promise<OnChainResult> {
  if (!deps.contractAddress) return { ok: false, error: 'not configured' }
  const orderIdBytes32 = deriveOrderIdBytes32(args.orderId)
  const orderKey = deriveOrderKey(orderIdBytes32)
  const chain = await readEscrow(deps, orderKey)
  if ('error' in chain) return { ok: false, error: chain.error }
  if (chain.state !== ESCROW_STATE.Funded) return { ok: false, error: `escrow not in Funded state (on-chain state=${chain.state})` }
  return sendAndConfirm(deps, 'flagDispute', [orderIdBytes32])
}

/** 导出供测试用 encodeFunctionData 反解 calldata(decodeFunctionData 验 orderId/buyerRefund)。 */
export function encodeArbiterResolveCalldata(orderId: string, buyerRefund: bigint): Hex {
  return encodeFunctionData({ abi: ARBITER_WRITE_ABI, functionName: 'arbiterResolve', args: [deriveOrderIdBytes32(orderId), buyerRefund] })
}
export function encodeFlagDisputeCalldata(orderId: string): Hex {
  return encodeFunctionData({ abi: ARBITER_WRITE_ABI, functionName: 'flagDispute', args: [deriveOrderIdBytes32(orderId)] })
}
export { ARBITER_WRITE_ABI }
