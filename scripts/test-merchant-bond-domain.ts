#!/usr/bin/env tsx
/**
 * Merchant Base-Bond v1 domain skeleton — unit test (PR1).
 * 验证:默认关闭、fail-closed 资格派生、状态机转移、watcher no-op、chain profile 占位。
 * 不碰 DB/链/资金。
 */
import {
  MERCHANT_BOND_V1_ENABLED, MERCHANT_BOND_CHAIN_PROFILE, BOND_STATUS,
  canTransitionBond, deriveSellerHasProductionBaseBondLocked, type MerchantBondView,
} from '../src/merchant-bond-domain.js'
import { startMerchantBondWatcher } from '../src/merchant-bond-watcher.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// ── 1. 默认关闭(PR1 scaffold,真实启用前永远 false)──
ok('MERCHANT_BOND_V1_ENABLED defaults false', MERCHANT_BOND_V1_ENABLED === false)
ok('chain profile = base placeholder (chainId/usdc/minConf 未定稿)', MERCHANT_BOND_CHAIN_PROFILE.key === 'base'
  && MERCHANT_BOND_CHAIN_PROFILE.chainId === null
  && MERCHANT_BOND_CHAIN_PROFILE.usdcAddress === null
  && MERCHANT_BOND_CHAIN_PROFILE.minConfirmations === null)

// ── 2. 资格派生 fail-closed:即便给"完美" view,开关关 → 仍 false ──
const fullView: MerchantBondView = {
  sellerId: 'usr_x', walletBound: true, status: BOND_STATUS.ACTIVE,
  collateralUnits: 1_000_000_000n, confirmed: true,
}
ok('derive: flag off → false even for valid view', deriveSellerHasProductionBaseBondLocked(fullView, 1n) === false)
ok('derive: null view → false', deriveSellerHasProductionBaseBondLocked(null, 1n) === false)

// ── 3. 状态机:合法/非法转移 ──
ok('transition none→pending ok', canTransitionBond(BOND_STATUS.NONE, BOND_STATUS.PENDING_CONFIRMATIONS))
ok('transition pending→active ok', canTransitionBond(BOND_STATUS.PENDING_CONFIRMATIONS, BOND_STATUS.ACTIVE))
ok('transition active→cooling ok', canTransitionBond(BOND_STATUS.ACTIVE, BOND_STATUS.COOLING))
ok('transition cooling→withdrawable ok', canTransitionBond(BOND_STATUS.COOLING, BOND_STATUS.WITHDRAWABLE))
ok('transition withdrawable→withdrawn ok', canTransitionBond(BOND_STATUS.WITHDRAWABLE, BOND_STATUS.WITHDRAWN))
ok('transition withdrawn→* terminal (no out)', !canTransitionBond(BOND_STATUS.WITHDRAWN, BOND_STATUS.ACTIVE))
ok('transition none→active ILLEGAL', !canTransitionBond(BOND_STATUS.NONE, BOND_STATUS.ACTIVE))
ok('transition active→withdrawn ILLEGAL (must cool)', !canTransitionBond(BOND_STATUS.ACTIVE, BOND_STATUS.WITHDRAWN))
ok('no "paused" in seller status enum', !(Object.values(BOND_STATUS) as string[]).includes('paused'))

// ── 4. watcher:默认关 → no-op(不连 RPC、不抛)──
const h = startMerchantBondWatcher()
ok('watcher disabled no-op when flag off / profile not ready', h.enabled === false && typeof h.stop === 'function')

console.log(fails.join('\n'))
console.log(`\n${fail === 0 ? '✅' : '❌'} merchant-bond v1 domain skeleton (PR1): collateral-only, default-disabled, fail-closed`)
console.log(`  ${fail === 0 ? '✅' : '❌'} pass ${pass}${fail ? ` · fail ${fail}` : ''}`)
if (fail > 0) process.exit(1)
