/**
 * Merchant Base-Bond — chain watcher skeleton (PR1, testnet/dev scaffold).
 *
 * 设计:docs/modules/MERCHANT-BASE-BOND-DESIGN.INTERNAL.md §4.1/§4.2。
 * 职责(未来 testnet 才接真实 RPC):监听合约 deposit/slash/withdraw event → ≥N confirmations 后
 *   更新 DB 镜像(merchant_bond_*)。reorg 后冻结派生资格 + 告警。
 *
 * ⚠️ PR1 阶段:**纯骨架、默认关、不连任何 RPC、不写资金、不接 live 路径。** 启用前需:
 *   chain profile 定稿 + 法务 + 外部合约审计 + Holden 批准(设计稿 §9)。
 */
import { MERCHANT_BOND_V1_ENABLED, MERCHANT_BOND_CHAIN_PROFILE } from './merchant-bond-domain.js'

export interface BondWatcherDeps {
  /** 真实接入时注入:链 RPC provider、合约地址、DB 写入器。PR1 全部留空。 */
  rpcUrl?: string | null
  contractAddress?: string | null
}

export interface BondWatcherHandle {
  enabled: boolean
  stop: () => void
}

/**
 * 启动 watcher。**PR1:若未启用(默认)或 chain profile 未定稿 → 直接返回 no-op,绝不连 RPC。**
 * 真实事件处理(deposit recognition / confirmations / reorg freeze)留待后续 testnet PR。
 */
export function startMerchantBondWatcher(_deps: BondWatcherDeps = {}): BondWatcherHandle {
  const profileReady = MERCHANT_BOND_CHAIN_PROFILE.chainId != null
    && MERCHANT_BOND_CHAIN_PROFILE.usdcAddress != null
    && MERCHANT_BOND_CHAIN_PROFILE.minConfirmations != null
  if (!MERCHANT_BOND_V1_ENABLED || !profileReady) {
    // disabled scaffold:no RPC、no timer、no DB write。
    return { enabled: false, stop: () => {} }
  }
  // 真实监听实现 = 后续 testnet PR(deposit/slash/withdraw event → ≥N confirmations → DB 镜像;reorg 冻结+告警)。
  throw new Error('MerchantBondWatcher: real chain listening not implemented in PR1 scaffold')
}
