/**
 * Direct Pay (Rail 1) — base-bond (merchant performance security deposit / 履约担保物) LIFECYCLE — PR-4b-min。
 * 设计稿 §6 / §10.3。本模块只做【域逻辑层 + 状态机】,**绝不动真实资金**。
 *
 * ════════════ 硬边界(PR-4b-min,Holden 批准 + WAZ 更正)════════════
 *  - 这是 base bond = 卖家【履约担保物 / security deposit】,法律/会计上独立于买家货款;
 *    【绝不】是买家支付、订单本金、escrow、平台对订单资金的托管。不碰 orders/payment/settlement/escrow/refund。
 *  - **WAZ NOT enabled:** 不锁卖家 WAZ 余额、不把 WAZ 罚没进 penalty balance、**openDeposit 拒绝 currency='waz'**(只允许 usdc|fiat,
 *    生产收款仍 GATED)—— 不把 schema 默认 currency='waz' 固化成合法路径。本 PR【没有任何真实资产移动】——
 *    lockBond 只是状态迁移;slashBond 只记 provenance(复用 recordBaseBondSlash)。
 *  - **生产放行仍 fail-closed:** manual rail 仅 test/non-production,且【永不】设 production_receipt_confirmed_at;
 *    operator_attested(运营核实生产轨)过 Lock A,但 Lock B(rail-clearance registry,治理默认关)仍挡 → 写不了 production receipt;
 *    usdc/fiat 自动收款 GATED throw。故当前【无任何 rail 能写 production receipt】→ direct-receive 仍不能 go-live
 *    (需治理翻开 operator_attested 的 registry 放行,或落地 legal-cleared USDC/fiat 自动收款)。不声称 go-live。
 *  - penalty 只进不出:slash 只记 provenance(total_base_bond_slash + txn),无 outflow 代码路径(append-only,设计稿 §10.1)。
 *  - 整数 base-units(RFC-014):比较/罚没用 toUnits;落库用 toDecimal。分数/负/越界 → fail-closed。
 *  - refund-on-exit 不在本 PR:仅提供【纯判断占位】refundOnExitBlockedReason(open-dispute/cooling-window 阻止),
 *    真实退款状态流 + RFC-018 clearing lock 集成 = 4b-2。
 *
 *  STOP:若实现需要真实 WAZ 余额 lock / USDC/fiat 收款 / 退款出款 / 订单创建·支付·结算·escrow 路由 / schema·boot 迁移 —— 立即停止汇报。
 */
import type Database from 'better-sqlite3'
import { toUnits, toDecimal, type Units } from './money.js'
import { getDepositRail, assertProductionDepositRail, type DepositRailId } from './deposit-rails.js'
import { assertBondRailCleared } from './direct-pay-bond-rail-clearance.js'
import { recordBaseBondSlash } from './direct-pay-ledger.js'

export type DepositTier = 'T0' | 'T1' | 'T2'
export type DepositStatus = 'pending' | 'confirmed' | 'locked' | 'insufficient' | 'expired' | 'refunding' | 'refunded' | 'slashed'

export interface BaseBondConfig {
  /** 各档【固定 token 数】(整数 base-units)。T0 即可;T1/T2 + reputation 折扣 = PR-5。
   *  ⚠️ 固定 token 数,NO per-deposit FX —— "≈ S$500" 只是档位参考标签,不是汇率换算(设计稿 Rev h)。治理可调。 */
  tierRequiredUnits: Partial<Record<DepositTier, Units>>
  /** pending 存款过期天数。 */
  pendingTtlDays: number
}
/** LOCKED 保守默认(治理可调)。T0 = 固定 token 数(标签 ≈ S$500,非 FX)。 */
export const DEFAULT_BASE_BOND_CONFIG: BaseBondConfig = {
  tierRequiredUnits: { T0: toUnits(500) },
  pendingTtlDays: 7,
}

export type DepositOpResult =
  | { ok: true; status: DepositStatus; already?: boolean }
  | { ok: false; reason: string }

interface DepositRow {
  id: string; user_id: string; tier: string; required_amount: number; amount: number
  currency: string; deposit_rail: string; status: string; production_receipt_confirmed_at: string | null; created_at: string
}

const isNonNegUnits = (x: unknown): x is Units => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const getRow = (db: Database.Database, id: string): DepositRow | undefined =>
  db.prepare('SELECT id, user_id, tier, required_amount, amount, currency, deposit_rail, status, production_receipt_confirmed_at, created_at FROM direct_receive_deposits WHERE id = ?').get(id) as DepositRow | undefined

/** 某档要求的【固定 token 数】(整数 base-units)。未配置的档 → 抛(T1/T2 在 PR-5 才支持)。 */
export function requiredBondUnits(tier: DepositTier, config: BaseBondConfig = DEFAULT_BASE_BOND_CONFIG): Units {
  const u = config.tierRequiredUnits[tier]
  if (!isNonNegUnits(u) || u <= 0) throw new Error(`requiredBondUnits: tier '${tier}' 未配置或非正整数 units(4b-min 仅支持已配置档,通常 T0)`)
  return u
}

/** 开新存款:创建 pending 行。required = 该档固定 token 数。amount=0(待 confirm)。 */
export function openDeposit(db: Database.Database, args: {
  depositId: string; userId: string; tier: DepositTier; currency: string; depositRail: string; config?: BaseBondConfig
  /** 卖家申报的付款凭据(转账单号等,B1;运营核实时对照)。存 external_ref;confirm 时可被 rail 返回值覆盖。 */
  externalRef?: string
}): DepositOpResult {
  const { depositId, userId, tier, currency, depositRail, config } = args
  if (!depositId || !userId) return { ok: false, reason: 'missing depositId/userId' }
  // WAZ NOT enabled:base bond 只接受【外部资产币种】usdc | fiat(生产收款仍 GATED);'waz' 一律 fail-closed,
  //   杜绝把 schema 默认 currency='waz' 固化成合法路径(防 4c/4f 误接成"WAZ 担保物可用")。
  if (!['usdc', 'fiat'].includes(currency)) return { ok: false, reason: `currency '${currency}' not allowed for base bond (only usdc|fiat; WAZ not enabled)` }
  if (!['manual', 'operator_attested', 'usdc_onchain', 'fiat_psp'].includes(depositRail)) return { ok: false, reason: `invalid deposit_rail '${depositRail}'` }
  if (getRow(db, depositId)) return { ok: false, reason: 'deposit already exists' }
  let required: Units
  try { required = requiredBondUnits(tier, config) } catch (e) { return { ok: false, reason: (e as Error).message } }
  db.prepare(`INSERT INTO direct_receive_deposits (id, user_id, tier, required_amount, amount, currency, deposit_rail, status, external_ref, created_at, updated_at)
    VALUES (?,?,?,?,0,?,?, 'pending', ?, datetime('now'), datetime('now'))`)
    .run(depositId, userId, tier, toDecimal(required), currency, depositRail, args.externalRef ?? null)
  return { ok: true, status: 'pending' }
}

/**
 * 确认到账(经 deposit-rail 网关)。
 *  - manual rail:仅 test/non-production —— 置 amount + status=confirmed,**绝不**设 production_receipt_confirmed_at。
 *  - usdc_onchain / fiat_psp:getDepositRail().confirmReceipt() 直接【抛】(GATED,fail-closed),本函数不吞。
 * production_receipt_confirmed_at 只由【未来的 legal-cleared 生产 rail】设置(当前不存在)→ 本 PR 后恒 NULL。
 */
export function confirmDepositReceipt(db: Database.Database, args: {
  depositId: string; expectedAmountUnits: Units; externalRef?: string
}): DepositOpResult {
  const { depositId, expectedAmountUnits, externalRef } = args
  const row = getRow(db, depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  // 生产 rail(operator_attested / usdc_onchain / fiat_psp)只能走 confirmProductionReceipt(ROOT + Passkey + Lock B)。
  //   confirmDepositReceipt 是【非生产 / manual 专用】路径 —— 任何生产 rail 在此即抛(fail-closed),杜绝被
  //   confirmDepositReceipt + lockBond 锁成 active privilege、绕过生产确认门(operator_attested 的 record-only
  //   confirmReceipt 不会自己抛,故必须在此显式拦)。
  if (getDepositRail(row.deposit_rail as DepositRailId).isProduction) {
    throw new Error(`deposit-rail '${row.deposit_rail}' is a production rail — must use confirmProductionReceipt (ROOT + Passkey); confirmDepositReceipt is manual/non-production only`)
  }
  if (row.status === 'confirmed' || row.status === 'locked') return { ok: true, status: row.status as DepositStatus, already: true } // 幂等
  if (row.status !== 'pending' && row.status !== 'insufficient') return { ok: false, reason: `cannot confirm from status '${row.status}'` }
  if (!isNonNegUnits(expectedAmountUnits) || expectedAmountUnits <= 0) return { ok: false, reason: 'expectedAmount must be a positive integer base-units' }

  // 网关:manual → confirmed(test);usdc/fiat → 抛(GATED)。本函数不 try/catch 网关,让 GATED 抛穿透(fail-closed)。
  const conf = getDepositRail(row.deposit_rail as 'manual' | 'usdc_onchain' | 'fiat_psp')
    .confirmReceipt({ depositId, expectedAmount: expectedAmountUnits, currency: row.currency, externalRef })
  if (!conf.confirmed) return { ok: false, reason: conf.reason || 'receipt not confirmed' }

  // manual = 非生产 → 绝不写 production_receipt_confirmed_at(保持 NULL)。
  db.prepare(`UPDATE direct_receive_deposits SET amount = ?, status = 'confirmed', confirmed_at = datetime('now'),
    external_ref = COALESCE(?, external_ref), updated_at = datetime('now') WHERE id = ?`)
    .run(toDecimal(expectedAmountUnits), conf.externalRef ?? externalRef ?? null, depositId)
  return { ok: true, status: 'confirmed' }
}

/** 锁定:confirmed 且 amount ≥ required → locked + 激活 privilege(单事务)。WAZ NOT enabled → 不动任何余额。 */
export function lockBond(db: Database.Database, args: { depositId: string }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (row.status === 'locked') return { ok: true, status: 'locked', already: true } // 幂等
  if (row.status !== 'confirmed') return { ok: false, reason: `cannot lock from status '${row.status}' (must be confirmed)` }
  if (toUnits(row.amount) < toUnits(row.required_amount)) return { ok: false, reason: 'insufficient: amount < required' }
  db.transaction(() => {
    db.prepare("UPDATE direct_receive_deposits SET status = 'locked', locked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(args.depositId)
    // ⚠️ privilege=active 在 4b-min 是【非生产】(manual/test;本 PR 的 lock 不带 production_receipt_confirmed_at)。
    //   active 本身【不是】production go-live 的充分条件 —— 生产门是 isProductionBaseBondLocked()(production receipt 非 NULL),
    //   由 4c 强制;active 仅表示"已走完非生产 lock 流程"。
    db.prepare(`INSERT INTO direct_receive_privileges (user_id, status, tier, granted_at, updated_at)
      VALUES (?, 'active', ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET status='active', tier=excluded.tier, suspended_reason=NULL, granted_at=COALESCE(direct_receive_privileges.granted_at, excluded.granted_at), updated_at=datetime('now')`)
      .run(row.user_id, row.tier)
  })()
  return { ok: true, status: 'locked' }
}

/** 标记不足:confirmed 但 amount < required → insufficient(待 top-up)。 */
export function markInsufficient(db: Database.Database, args: { depositId: string }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (row.status === 'insufficient') return { ok: true, status: 'insufficient', already: true }
  if (row.status !== 'confirmed') return { ok: false, reason: `cannot mark insufficient from status '${row.status}'` }
  if (toUnits(row.amount) >= toUnits(row.required_amount)) return { ok: false, reason: 'amount already meets required' }
  db.prepare("UPDATE direct_receive_deposits SET status = 'insufficient', updated_at = datetime('now') WHERE id = ?").run(args.depositId)
  return { ok: true, status: 'insufficient' }
}

/** 补足:amount += add(整数 units)。若达/超 required 且当前 insufficient/confirmed → 置 confirmed(可再 lock)。 */
export function topUp(db: Database.Database, args: { depositId: string; addUnits: Units }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (!isNonNegUnits(args.addUnits) || args.addUnits <= 0) return { ok: false, reason: 'addUnits must be a positive integer base-units' }
  if (!['confirmed', 'insufficient'].includes(row.status)) return { ok: false, reason: `cannot top-up from status '${row.status}'` }
  const newAmount = toUnits(row.amount) + args.addUnits
  db.prepare("UPDATE direct_receive_deposits SET amount = ?, status = 'confirmed', updated_at = datetime('now') WHERE id = ?")
    .run(toDecimal(newAmount), args.depositId)
  return { ok: true, status: 'confirmed' }
}

/** 过期:pending 且超过 TTL → expired。 */
export function expireDeposit(db: Database.Database, args: { depositId: string; nowIso: string; config?: BaseBondConfig }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (row.status !== 'pending') return { ok: false, reason: `only pending can expire (got '${row.status}')` }
  const ttlDays = args.config?.pendingTtlDays ?? DEFAULT_BASE_BOND_CONFIG.pendingTtlDays
  const created = Date.parse(row.created_at), now = Date.parse(args.nowIso)
  if (!Number.isFinite(created) || !Number.isFinite(now)) return { ok: false, reason: 'unparseable timestamps' }
  if (now - created < ttlDays * 86_400_000) return { ok: false, reason: 'not yet past TTL' }
  db.prepare("UPDATE direct_receive_deposits SET status = 'expired', updated_at = datetime('now') WHERE id = ?").run(args.depositId)
  return { ok: true, status: 'expired' }
}

/**
 * 罚没(卖家违约):locked → slashed,仅记 provenance(recordBaseBondSlash:total_base_bond_slash + txn),
 *  **不动任何 balance / 无 outflow**(WAZ NOT enabled),并吊销 privilege(suspended)。单事务,幂等。
 */
export function slashBond(db: Database.Database, args: { depositId: string; txnId: string; reason?: string }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (row.status === 'slashed') return { ok: true, status: 'slashed', already: true } // 幂等:不重复记 provenance
  if (row.status !== 'locked') return { ok: false, reason: `can only slash a locked bond (got '${row.status}')` }
  db.transaction(() => {
    recordBaseBondSlash(db, { userId: row.user_id, amountUnits: toUnits(row.amount), txnId: args.txnId, reason: args.reason }) // provenance only
    db.prepare("UPDATE direct_receive_deposits SET status = 'slashed', updated_at = datetime('now') WHERE id = ?").run(args.depositId)
    db.prepare(`INSERT INTO direct_receive_privileges (user_id, status, tier, suspended_reason, updated_at)
      VALUES (?, 'suspended', ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET status='suspended', suspended_reason=excluded.suspended_reason, updated_at=datetime('now')`)
      .run(row.user_id, row.tier, args.reason ?? 'base_bond_slashed')
  })()
  return { ok: true, status: 'slashed' }
}

// ───── PR-4b-3: 生产 receipt 写入(唯一 writer)─────────────────────────────────────────────────
/** base-bond/合规 policy 版本 —— 【服务端生成】(非客户端入参),legal clearance 落地时随 policy 更新。 */
export const DIRECT_PAY_BASE_BOND_POLICY_VERSION = 'pre-legal-unset'
/** 生产 receipt 允许的法域【严格白名单】。默认空 = 任何 jurisdiction 都拒(额外 fail-closed,待法务配置)。 */
export const DIRECT_PAY_BOND_JURISDICTIONS: string[] = []

/**
 * 生产保证金 receipt【唯一】writer(PR-4b-3 scaffold)。这是【整个协议中】唯一允许写 production_receipt_confirmed_at
 *   的函数(#100 guard 机器强制:写赋值必在本函数内 且 本函数必调 assertProductionDepositRail)。
 *
 * 当前【fail-closed】:Lock A 对 manual(非生产)/usdc/fiat(GATED,implemented=false)抛;operator_attested 过 Lock A,
 *   但 Lock B(assertBondRailCleared,registry 治理默认关)对所有 rail 抛 → 没有任何 rail 能写 production receipt
 *   → 调用即抛 → 永不写 production receipt → Direct Pay 仍 non-launchable。assert 之后的写路径在 legal-cleared rail
 *   落地前【不可达】(本 PR 不接真实 USDC/fiat/PSP/on-chain)。不碰 buyer wallet/escrow/order/settlement/refund。
 *
 * 硬约束(即便未来 rail 放行也必须守):
 *  - 拒绝把【非生产 locked】(manual/test lock,无 production receipt)升级成生产 —— 旧/测试行不得冒充生产到位。
 *  - jurisdiction 必须 ∈ DIRECT_PAY_BOND_JURISDICTIONS(严格白名单);policy_version 由服务端常量盖章,非入参。
 *  - assert 在任何写之前;原子 confirm+lock(amount + status=locked + production receipt + provenance 快照 + privilege)。
 */
export function confirmProductionReceipt(db: Database.Database, args: {
  depositId: string; railId: string; expectedAmountUnits: Units; receiptRef: string; jurisdiction: string
}): DepositOpResult {
  const { depositId, railId, expectedAmountUnits, receiptRef, jurisdiction } = args
  // ⚠️ 生产/法务硬闸 —— assert【真正第一】:在任何 row 读取 / 幂等 / 拒绝 / 写之前。当前所有 rail 都被拒 → 抛 → 恒 fail-closed。
  //   置于最前的语义意义:即便某 deposit 之前在【已 cleared 的 rail】下确认过,若该 rail 后被【撤回】(legalCleared→false),
  //   重新确认也不再被当"幂等已确认"放过 —— 必须重新通过闸。#100 guard 要求本 helper body 必含此调用。
  assertProductionDepositRail(getDepositRail(railId as DepositRailId))
  // Lock B(Phase 4 scaffold):rail-clearance registry 放行闸 —— legal_cleared + production_ready + 非占位 policy_version +
  //   jurisdiction ∈ allowlist。与 Lock A【独立】,缺一即拒;当前 registry 全 fail-closed → 恒抛。置于任何 row 读/写之前。
  assertBondRailCleared(railId, jurisdiction)
  // ───── 以下在 legal-cleared 生产 rail 落地前【全部不可达】(两把闸已抛)─────
  const row = getRow(db, depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (railId !== row.deposit_rail) return { ok: false, reason: 'rail_id does not match the deposit rail' }
  // 幂等:已生产确认 → already(此时 rail 仍 cleared,assert 已过)
  if (row.status === 'locked' && row.production_receipt_confirmed_at != null) return { ok: true, status: 'locked', already: true }
  // 拒绝把【非生产 locked】(manual/test lock,无 production receipt)升级成生产
  if (row.status === 'locked') return { ok: false, reason: 'deposit is locked WITHOUT a production receipt (manual/test) — cannot be upgraded to production' }
  if (!receiptRef) return { ok: false, reason: 'missing production receipt ref' }
  if (!DIRECT_PAY_BOND_JURISDICTIONS.includes(jurisdiction)) return { ok: false, reason: `jurisdiction '${jurisdiction}' not in allowlist` }
  if (!['pending', 'confirmed', 'insufficient'].includes(row.status)) return { ok: false, reason: `cannot production-confirm from status '${row.status}'` }
  if (!isNonNegUnits(expectedAmountUnits) || expectedAmountUnits <= 0) return { ok: false, reason: 'expectedAmount must be a positive integer base-units' }
  if (expectedAmountUnits < toUnits(row.required_amount)) return { ok: false, reason: 'insufficient: amount < required' }
  db.transaction(() => {
    db.prepare(`UPDATE direct_receive_deposits SET amount = ?, status = 'locked', confirmed_at = COALESCE(confirmed_at, datetime('now')),
      locked_at = datetime('now'), production_receipt_confirmed_at = datetime('now'),
      production_receipt_ref = ?, production_rail_id = ?, production_jurisdiction = ?, production_policy_version = ?,
      external_ref = COALESCE(?, external_ref), updated_at = datetime('now') WHERE id = ?`)
      .run(toDecimal(expectedAmountUnits), receiptRef, railId, jurisdiction, DIRECT_PAY_BASE_BOND_POLICY_VERSION, receiptRef, depositId)
    db.prepare(`INSERT INTO direct_receive_privileges (user_id, status, tier, granted_at, updated_at)
      VALUES (?, 'active', ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET status='active', tier=excluded.tier, suspended_reason=NULL, granted_at=COALESCE(direct_receive_privileges.granted_at, excluded.granted_at), updated_at=datetime('now')`)
      .run(row.user_id, row.tier)
  })()
  return { ok: true, status: 'locked' }
}

/**
 * 生产门读取:某存款是否【生产级】锁定 = status='locked' 且 production_receipt_confirmed_at 非 NULL。
 * 4b-min 永远 false(manual rail 不设该列;无生产 rail)。供后续 4c 生产 go-live 事实装配【单一真相】,杜绝 manual 冒充。
 */
export function isProductionBaseBondLocked(db: Database.Database, args: { depositId: string }): boolean {
  const row = getRow(db, args.depositId)
  return !!row && row.status === 'locked' && row.production_receipt_confirmed_at != null
}

/**
 * 卖家级生产门(PR-4c go-live 充分必要的担保侧条件):该卖家是否有任一【生产级】锁定 base bond
 *   (status='locked' 且 production_receipt_confirmed_at 非 NULL)。**非仅看 direct_receive_privileges.status='active'**。
 * 4b-min 无生产 base-bond rail(WAZ 未启用 / USDC·fiat 生产收款 GATED)→ 恒 false → 直付建单 fail-closed / non-launchable。
 * 一个生产级 receipt 只会发给已 KYC + 制裁筛查的商户,故该门也承接了 KYC/sanctions(独立 4a 事实门待其系统就绪再接)。
 */
export function sellerHasProductionBaseBondLocked(db: Database.Database, sellerId: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM direct_receive_deposits WHERE user_id = ? AND status = 'locked' AND production_receipt_confirmed_at IS NOT NULL LIMIT 1",
  ).get(sellerId)
}

/** admin 驳回申报(B1):pending|insufficient|confirmed(未 lock)→ expired + 驳回说明。locked/生产确认后不可驳。幂等。 */
export function rejectDeposit(db: Database.Database, args: { depositId: string; note?: string }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row) return { ok: false, reason: 'deposit not found' }
  if (row.status === 'expired') return { ok: true, status: 'expired', already: true }
  if (!['pending', 'insufficient', 'confirmed'].includes(row.status)) return { ok: false, reason: `cannot reject from status '${row.status}'` }
  db.prepare(`UPDATE direct_receive_deposits SET status = 'expired', reject_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(args.note ? String(args.note).slice(0, 300) : null, args.depositId)
  return { ok: true, status: 'expired' }
}

/** 卖家自行撤回自己的 pending 申报(B1)。owner-scoped CAS;非 pending 不动。 */
export function cancelPendingDeposit(db: Database.Database, args: { depositId: string; userId: string }): DepositOpResult {
  const row = getRow(db, args.depositId)
  if (!row || row.user_id !== args.userId) return { ok: false, reason: 'deposit not found' }
  if (row.status !== 'pending') return { ok: false, reason: `cannot cancel from status '${row.status}'` }
  const r = db.prepare("UPDATE direct_receive_deposits SET status = 'expired', reject_note = '卖家自行撤回', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(args.depositId, args.userId)
  return r.changes === 1 ? { ok: true, status: 'expired' } : { ok: false, reason: 'cancel race: already processed' }
}

/** 卖家最新一笔保证金存款(任意状态;B1 状态卡/去重用)。 */
export function getSellerLatestDeposit(db: Database.Database, sellerId: string): (DepositRow & { external_ref: string | null; reject_note: string | null; confirmed_at: string | null; locked_at: string | null }) | null {
  return (db.prepare(`SELECT id, user_id, tier, required_amount, amount, currency, deposit_rail, status, production_receipt_confirmed_at,
                             external_ref, reject_note, confirmed_at, locked_at, created_at
                      FROM direct_receive_deposits WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(sellerId) as never) ?? null
}

/**
 * refund-on-exit 阻止原因(纯判断占位 —— 真实退款状态流 + RFC-018 clearing lock 集成 = 4b-2)。
 * 返回阻止原因码;null = 在这些条件下【不被阻止】(但本 PR 不执行任何退款)。无副作用,不读库,不出款。
 */
export function refundOnExitBlockedReason(facts: { status?: string; hasOpenDispute?: boolean; withinCoolingWindow?: boolean }):
  'NOT_LOCKED' | 'OPEN_DISPUTE' | 'COOLING_WINDOW' | null {
  if (facts.status !== 'locked') return 'NOT_LOCKED'
  if (facts.hasOpenDispute === true) return 'OPEN_DISPUTE'
  if (facts.withinCoolingWindow === true) return 'COOLING_WINDOW'
  return null
}
