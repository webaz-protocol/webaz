/**
 * Direct Pay (Rail 1) — base-bond 入场判定(组合器)。
 *
 * 卖家是否满足"保证金到位"这道门 = 已交【生产级 base-bond】(production receipt)  OR  有【有效缓交】(active deferral)。
 * 缓交(#115)批准的卖家免"先交保证金"即可入场,但**其余合规门一个不少**:KYB/制裁/AML/Passkey/收款说明/控制面
 *   仍由控制面 evaluate + create 路径分别 AND(本组合器只回答"保证金门是否满足",不替代任何其它门)。
 *
 * 纯读:复用 sellerHasProductionBaseBondLocked(production receipt 非 NULL)+ getActiveDeferral(fail-closed)。
 *   不动资金/状态机。now 由调用方传入(确定性)。默认仍 fail-closed —— 无 bond 且无有效缓交 → false。
 */
import type Database from 'better-sqlite3'
import { sellerHasProductionBaseBondLocked } from './direct-receive-deposits.js'
import { getActiveDeferral } from './direct-receive-deferral.js'

export function sellerBaseBondEntrySatisfied(db: Database.Database, sellerId: string, nowIso: string): boolean {
  return sellerHasProductionBaseBondLocked(db, sellerId) || getActiveDeferral(db, sellerId, nowIso) != null
}
