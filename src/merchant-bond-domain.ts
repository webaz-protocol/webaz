/**
 * Merchant Base-Bond (v1 collateral-only) — domain skeleton (PR1, testnet/dev scaffold).
 *
 * 设计真相源:docs/modules/MERCHANT-BASE-BOND-DESIGN.INTERNAL.md(v1 candidate-locked)。
 * 本模块是【纯域逻辑骨架】:状态机 + 资格派生 + 类型。**不写 DB、不接任何 live 路径、不碰资金。**
 *
 * v1 已锁(见设计稿 §12):
 *  - 链上非托管锁仓合约持有 collateral;买家货款永不进合约;平台费【不上链】(链下账务)。
 *  - slash 仅治理触发 + 链上硬约束(v1 无自动/小额 slash)。
 *  - 合约 v1 不可升级;链 = Base + 白名单 USDC(单链);入门门 = 单一 base_bond_min_units(不分档)。
 *  - wallet rotation = seller 签名 + WebAZ 授权;治理仅紧急。
 *  - 计价用 base_bond_min_units(USDC 整数单位),不引预言机。
 *
 * ⚠️ MERCHANT_BOND_V1_ENABLED 默认 false:整套 v1 在 testnet/dev scaffold 阶段【关闭】,
 *   mainnet + 真实 USDC 需先过 法务 + 外部合约审计 + Holden 批准(设计稿 §9)。
 */

/** 全局开关:v1 默认关闭(PR1 scaffold)。真实启用前永远 false。 */
export const MERCHANT_BOND_V1_ENABLED = false

/** v1 链:Base + 白名单 USDC(单链;仅 chain profile 占位,无多链抽象)。 */
export const MERCHANT_BOND_CHAIN_PROFILE = {
  key: 'base',
  // 真实 chainId / USDC 地址 / 确认数 N 在 mainnet 接入时由治理/配置定稿(政策参数);此处仅占位。
  chainId: null as number | null,
  usdcAddress: null as string | null,
  minConfirmations: null as number | null,
} as const

/** Seller 生命周期状态(枚举;`paused` 不是 seller 状态,pause 是正交 flags)。 */
export const BOND_STATUS = {
  NONE: 'none',
  PENDING_CONFIRMATIONS: 'pending_confirmations',
  ACTIVE: 'active',
  COOLING: 'cooling',
  WITHDRAWABLE: 'withdrawable',
  WITHDRAWN: 'withdrawn',
  SLASHED_BELOW_MIN: 'slashed_below_min',
} as const
export type BondStatus = typeof BOND_STATUS[keyof typeof BOND_STATUS]

/** 合法状态转移(域层薄校验;真相仍以链上合约 event 为准)。 */
const VALID_TRANSITIONS: Record<BondStatus, BondStatus[]> = {
  [BOND_STATUS.NONE]: [BOND_STATUS.PENDING_CONFIRMATIONS],
  [BOND_STATUS.PENDING_CONFIRMATIONS]: [BOND_STATUS.ACTIVE, BOND_STATUS.NONE],
  [BOND_STATUS.ACTIVE]: [BOND_STATUS.COOLING, BOND_STATUS.SLASHED_BELOW_MIN],
  [BOND_STATUS.COOLING]: [BOND_STATUS.WITHDRAWABLE, BOND_STATUS.ACTIVE],
  [BOND_STATUS.WITHDRAWABLE]: [BOND_STATUS.WITHDRAWN, BOND_STATUS.ACTIVE],
  [BOND_STATUS.WITHDRAWN]: [],
  [BOND_STATUS.SLASHED_BELOW_MIN]: [BOND_STATUS.ACTIVE],
}

export function canTransitionBond(from: BondStatus, to: BondStatus): boolean {
  return (VALID_TRANSITIONS[from] || []).includes(to)
}

/** 独立 pause flags(正交于 seller 状态)。 */
export interface BondPauseFlags {
  depositsPaused: boolean
  slashPaused: boolean
  withdrawPaused: boolean
  globalPaused: boolean
}

/** DB 镜像视图(只读;权威来源是链上,见设计稿 §4.1)。 */
export interface MerchantBondView {
  sellerId: string
  walletBound: boolean             // registeredBondWallet 已绑定本 seller
  status: BondStatus
  collateralUnits: bigint          // USDC 整数单位
  confirmed: boolean               // ≥N confirmations
}

/**
 * 资格派生(单一真相函数:readiness 与 create gate 必须都调它,定义逐字一致)。
 * fail-closed:开关关 / 未绑钱包 / 未确认 / 状态非 active / 担保不足 → false。
 * v1 入门门 = 单一 base_bond_min_units(不分档)。
 */
export function deriveSellerHasProductionBaseBondLocked(
  view: MerchantBondView | null,
  baseBondMinUnits: bigint,
): boolean {
  if (!MERCHANT_BOND_V1_ENABLED) return false       // v1 scaffold 默认关 → 永远不翻真实资格
  if (!view) return false
  return view.walletBound
    && view.confirmed
    && view.status === BOND_STATUS.ACTIVE
    && view.collateralUnits >= baseBondMinUnits
}
