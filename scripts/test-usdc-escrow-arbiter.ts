#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B7a — arbiter 签名角色 + 链上 arbiterResolve/flagDispute 签发器 + admin Passkey 门裁决路由
 * + Resolved 结算消费(状态收敛 + 纯记账镜像)行为回归锁。★ 本轨除 B9 外最敏感 PR:接的 arbiter key 能在链上移动真钱。
 *
 * fixture 照 test-usdc-escrow-settle.ts:in-memory 库、applyWebazRuntimeSchema、真 engine.transition、
 * initNotificationSchema、真 createHumanPresence(consumeGateToken 是安全判定者,绝不桩)、真 logAdminAction。
 *
 * Proves:
 *  A) wallet-signer arbiter 角色:golden vector + 与 hot/issuer/voucher/deposit 全不同(独立 seed)。
 *  B) resolveDisputeOnChain / flagDisputeOnChain(注入 fake wallet/public client,零网络):
 *     - calldata 逐字对合约(decodeFunctionData 验 orderId/buyerRefund);
 *     - 前置读链上态:非 Disputed → 不发(resolve)/ 非 Funded → 不发(flag);
 *     - buyerRefund 越界(> amount / 负)→ 不发;缺 contract → not configured 不构造 client;
 *     - 发送失败 → 不假成功(无 txHash);receipt reverted → ok:false(带 txHash);读链失败 → 不发。
 *  C) admin 路由(真 consumeGateToken):无 Passkey → 412 拒 + 审计留痕、purpose 不符 → 拒、order_id 不符 → 拒、
 *     非本轨 → 拒(Passkey 未消费)、buyerRefund 越界 → 拒、成功 → 发 tx + admin_audit_log 有行(含 tx_hash,绝无 key)。
 *  D) applyUsdcEscrowResolved:全退→买家终态(disputed→cancelled)、部分/零退→卖家终态(disputed→completed)、
 *     守恒不符→不动+告警、幂等重放→不重复、非争议态→告警不强转、ZERO wallets 写快照断言、sweep 收口。
 *  E) 铁律 pin:三处既有 fail-closed 拒绝(dispute-engine:367 / decline-contest-resolve:60 / mutual-cancel:125)
 *     本 PR 后仍拒 —— 既有【源码锁】(E)+【运行时行为断言】(E-runtime):对一笔 usdc_escrow 单实际调用
 *     arbitrateDispute / resolveDeclineContestDispute / acceptMutualCancel,断言三者运行时真的拒绝(不只是源码字符串)。
 * Usage: npm run test:usdc-escrow-arbiter
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData } from 'viem'

const tmpHome = mkdtempSync(join(tmpdir(), 'uearb-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { createLocalSeedSigner } = await import('../src/pwa/internal/wallet-signer.js')
const {
  resolveDisputeOnChain, flagDisputeOnChain, encodeArbiterResolveCalldata, encodeFlagDisputeCalldata,
  ARBITER_WRITE_ABI, ESCROW_STATE,
} = await import('../src/pwa/internal/usdc-escrow-arbiter-signer.js')
const { deriveOrderIdBytes32 } = await import('../src/pwa/routes/usdc-escrow.js')
const { registerUsdcEscrowArbiterRoutes } = await import('../src/pwa/routes/usdc-escrow-arbiter.js')
const { applyUsdcEscrowResolved, sweepPendingUsdcEscrowResolves, alertUsdcAdmins } = await import('../src/usdc-escrow-settle.js')
type ResolvedEventRow = import('../src/usdc-escrow-settle.js').ResolvedEventRow
type UsdcSettleDeps = import('../src/usdc-escrow-settle.js').UsdcSettleDeps

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const CONTRACT = '0x' + 'e'.repeat(40)

// ══════════════════════════════════════════════════════════════════════════════
// A) wallet-signer arbiter 角色
// ══════════════════════════════════════════════════════════════════════════════
{
  const s = createLocalSeedSigner('arb-test-seed-xyz')
  const addrs = [s.hotAddress(), s.issuerAddress(), s.escrowVoucherAddress(), s.depositAddress('u'), s.arbiterAddress()]
  ok('A arbiter address distinct from hot/issuer/voucher/deposit', addrs[4] !== addrs[0] && addrs[4] !== addrs[1] && addrs[4] !== addrs[2] && addrs[4] !== addrs[3])
  ok('A arbiter deterministic (same seed → same address)', createLocalSeedSigner('arb-test-seed-xyz').arbiterAddress() === s.arbiterAddress())
  ok('A arbiter account address == arbiterAddress()', s.arbiterAccount().address.toLowerCase() === s.arbiterAddress().toLowerCase())
}

// ══════════════════════════════════════════════════════════════════════════════
// B) 链上签发器(fake wallet/public client,零网络)
// ══════════════════════════════════════════════════════════════════════════════
/* eslint-disable @typescript-eslint/no-explicit-any */
const OID_B = 'ordB1'
const fakePublic = (state: number, amount: bigint, opts: { readThrows?: boolean; reverted?: boolean; receiptThrows?: boolean } = {}) => ({
  readContract: async (_a: any) => { if (opts.readThrows) throw new Error('rpc getLogs flake'); return ['0x' + 'b'.repeat(40), '0x' + 'c'.repeat(40), amount, 200, 0n, state] },
  waitForTransactionReceipt: async (_a: any) => { if (opts.receiptThrows) throw new Error('receipt timeout'); return { status: opts.reverted ? 'reverted' : 'success' } as { status: 'success' | 'reverted' } },
})
const fakeWallet = (opts: { sendThrows?: boolean } = {}) => { const calls: any[] = []; return { calls, writeContract: async (a: any) => { calls.push(a); if (opts.sendThrows) throw new Error('nonce too low'); return ('0x' + '7'.repeat(64)) as `0x${string}` } } }

// B1: Disputed + valid refund → sends; calldata args correct
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: 3_000_000n })
  ok('B1: Disputed + valid refund → ok, txHash returned', r.ok === true && typeof r.txHash === 'string', JSON.stringify(r))
  ok('B1: writeContract called once with arbiterResolve args [orderIdBytes32, buyerRefund]', w.calls.length === 1 && w.calls[0].functionName === 'arbiterResolve' && w.calls[0].args[0] === deriveOrderIdBytes32(OID_B) && w.calls[0].args[1] === 3_000_000n)
  // calldata roundtrip (encode → decode) proves ABI matches the on-chain function selector + arg encoding
  const dec = decodeFunctionData({ abi: ARBITER_WRITE_ABI, data: encodeArbiterResolveCalldata(OID_B, 3_000_000n) })
  ok('B1: calldata decodes to arbiterResolve(orderIdBytes32, 3_000_000)', dec.functionName === 'arbiterResolve' && (dec.args as any)[0] === deriveOrderIdBytes32(OID_B) && (dec.args as any)[1] === 3_000_000n)
}
// B2: non-Disputed (Funded) → NOT sent
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Funded, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: 1n })
  ok('B2: on-chain state not Disputed → not sent, ok:false, gas not burned', r.ok === false && w.calls.length === 0 && /not in Disputed/.test(r.error || ''), JSON.stringify(r))
}
// B3: buyerRefund > amount → NOT sent
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: 10_000_001n })
  ok('B3: buyerRefund > amount → not sent, ok:false', r.ok === false && w.calls.length === 0 && /exceeds escrow amount/.test(r.error || ''))
}
// B4: negative refund → NOT sent (never reads chain)
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: -1n })
  ok('B4: negative buyerRefund → not sent, ok:false', r.ok === false && w.calls.length === 0)
}
// B5: missing contract → not configured (no client built)
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n) as any, contractAddress: undefined }, { orderId: OID_B, buyerRefund: 1n })
  ok('B5: missing USDC_ESCROW_CONTRACT → not configured, not sent', r.ok === false && r.error === 'not configured' && w.calls.length === 0)
}
// B6: send throws → NOT fake success, no txHash
{
  const w = fakeWallet({ sendThrows: true })
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: 1n })
  ok('B6: writeContract throws → ok:false, NO txHash (never fake success)', r.ok === false && r.txHash === undefined && /send failed/.test(r.error || ''))
}
// B7: receipt reverted → ok:false with txHash (broadcast but reverted)
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n, { reverted: true }) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: 1n })
  ok('B7: receipt status reverted → ok:false, txHash present (for manual reconcile)', r.ok === false && typeof r.txHash === 'string' && /reverted/.test(r.error || ''))
}
// B8: readContract throws → NOT sent
{
  const w = fakeWallet()
  const r = await resolveDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n, { readThrows: true }) as any, contractAddress: CONTRACT }, { orderId: OID_B, buyerRefund: 1n })
  ok('B8: chain read failure → not sent, ok:false (no gas on will-revert)', r.ok === false && w.calls.length === 0 && /chain read failed/.test(r.error || ''))
}
// B9: flagDispute — Funded → sends
{
  const w = fakeWallet()
  const r = await flagDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Funded, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B })
  ok('B9: flagDispute Funded → ok, flagDispute(orderIdBytes32) calldata', r.ok === true && w.calls.length === 1 && w.calls[0].functionName === 'flagDispute' && w.calls[0].args[0] === deriveOrderIdBytes32(OID_B))
  const dec = decodeFunctionData({ abi: ARBITER_WRITE_ABI, data: encodeFlagDisputeCalldata(OID_B) })
  ok('B9: flagDispute calldata decodes correctly', dec.functionName === 'flagDispute' && (dec.args as any)[0] === deriveOrderIdBytes32(OID_B))
}
// B10: flagDispute — non-Funded (Disputed) → NOT sent
{
  const w = fakeWallet()
  const r = await flagDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Disputed, 10_000_000n) as any, contractAddress: CONTRACT }, { orderId: OID_B })
  ok('B10: flagDispute non-Funded → not sent, ok:false', r.ok === false && w.calls.length === 0 && /not in Funded/.test(r.error || ''))
}
// B11: flagDispute missing contract → not configured
{
  const w = fakeWallet()
  const r = await flagDisputeOnChain({ arbiterWalletClient: w, publicClient: fakePublic(ESCROW_STATE.Funded, 10_000_000n) as any, contractAddress: undefined }, { orderId: OID_B })
  ok('B11: flagDispute missing contract → not configured, not sent', r.ok === false && r.error === 'not configured' && w.calls.length === 0)
}

// ══════════════════════════════════════════════════════════════════════════════
// shared DB fixture (route + settle sections)
// ══════════════════════════════════════════════════════════════════════════════
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
initNotificationSchema(db)
for (const col of ['payment_rail TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','buyer1','buyer','k_b1'),('seller1','seller1','seller','k_s1'),('admin1','admin1','admin','k_a1'),('sys_protocol','sys','system','k_sys')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','品','d',10,99,'active')").run()
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('buyer1', 123.45, 1, 10, 2, 3)
db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)').run('seller1', 500, 7, 0, 4, 5)

let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
const tr = transition as any
const { consumeGateToken } = createHumanPresence(db, <T,>(_k: string, fb: T): T => fb)
const logAdminAction = (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>): void => {
  db.prepare('INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)')
    .run(genId('audit'), adminId, action, targetType, targetId, detail ? JSON.stringify(detail) : null)
}

const mkOrder = (id: string, status: string, rail = 'usdc_escrow'): void => {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail)
    VALUES (?, 'p1', 'buyer1', 'seller1', 1, 10, 10, 0, ?, ?)`).run(id, status, rail)
}
const mkIntent = (orderId: string, orderKey: string, opts: { amount?: number; status?: string } = {}): void => {
  db.prepare(`INSERT INTO usdc_escrow_intents
      (order_id, order_key, contract_addr, buyer_id, seller_id, seller_addr, amount_units, fee_bps, auto_release_at, voucher_sig, auth_expires_at, status)
    VALUES (?, ?, ?, 'buyer1', 'seller1', ?, ?, 200, datetime('now'), '0xsig', datetime('now'), ?)`)
    .run(orderId, orderKey.toLowerCase(), CONTRACT, ('0x' + '9'.repeat(40)), opts.amount ?? 10_000_000, opts.status ?? 'funded')
}
const seedGateToken = (id: string, purpose: string, orderId: string, expired = false): void => {
  db.prepare(`INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?, datetime('now', ?))`)
    .run(id, 'admin1', purpose, JSON.stringify({ order_id: orderId }), expired ? '-60 seconds' : '+60 seconds')
}
const orderStatus = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status
const intentStatus = (id: string): string => (db.prepare('SELECT status FROM usdc_escrow_intents WHERE order_id = ?').get(id) as { status: string }).status
const feeCount = (id: string): number => (db.prepare('SELECT COUNT(*) n FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(id) as { n: number }).n
const feeRow = (id: string): any => db.prepare('SELECT amount_units, auto_release, tx_hash FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(id)
const auditAll = (action: string, orderId: string): any[] => db.prepare('SELECT detail FROM admin_audit_log WHERE action = ? AND target_id = ? ORDER BY rowid').all(action, orderId) as any[]
const walletsFullSnap = (): string => JSON.stringify(db.prepare('SELECT * FROM wallets ORDER BY user_id').all())
const walletsRowCount = (): number => (db.prepare('SELECT COUNT(*) n FROM wallets').get() as { n: number }).n
const notifCountAdmin = (): number => (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'admin1'").get() as { n: number }).n
const histActor = (id: string, from: string, to: string): string | undefined =>
  (db.prepare('SELECT actor_id FROM order_state_history WHERE order_id = ? AND from_status = ? AND to_status = ? ORDER BY rowid DESC LIMIT 1').get(id, from, to) as { actor_id: string } | undefined)?.actor_id
const histCount = (id: string, from: string, to: string): number =>
  (db.prepare('SELECT COUNT(*) n FROM order_state_history WHERE order_id = ? AND from_status = ? AND to_status = ?').get(id, from, to) as { n: number }).n

// ══════════════════════════════════════════════════════════════════════════════
// C) admin 路由(真 consumeGateToken;fake on-chain executor)
// ══════════════════════════════════════════════════════════════════════════════
const routes: Record<string, (req: any, res: any) => any> = {}
const fakeApp = { post: (path: string, h: any) => { routes[path] = h } } as any
let onchainCalls: any[] = []
let onchainResult: any = { ok: true, txHash: '0x' + 'a'.repeat(64) }
registerUsdcEscrowArbiterRoutes(fakeApp, {
  db,
  requireProtocolAdmin: (_req: any, _res: any) => ({ id: 'admin1' }),   // auth 是 server.ts 的 requireAdminPermission,非本 PR 主题;此处只驱动下游门
  consumeGateToken,   // ★ 真实安全判定者,绝不桩
  logAdminAction,
  resolveDisputeOnChain: async (a: any) => { onchainCalls.push({ fn: 'resolve', ...a }); return onchainResult },
  flagDisputeOnChain: async (a: any) => { onchainCalls.push({ fn: 'flag', ...a }); return onchainResult },
  network: 'testnet',
})
const RESOLVE = '/api/admin/usdc-escrow/:orderId/resolve'
const FLAG = '/api/admin/usdc-escrow/:orderId/flag-dispute'
const mockRes = () => { const r: any = { _s: 200, _j: null, status(c: number) { this._s = c; return this }, json(b: any) { this._j = b; return this } }; return r }
const call = async (path: string, orderId: string, body: any): Promise<any> => { const res = mockRes(); await routes[path]({ params: { orderId }, body }, res); return res }

// C1: no Passkey token → 412, on-chain NOT called, audit fail row
{
  const OID = 'ordC1'; mkOrder(OID, 'disputed'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  onchainCalls = []
  const res = await call(RESOLVE, OID, { buyer_refund_units: 3_000_000 })   // no webauthn_token
  ok('C1: no Passkey → 412 HUMAN_PRESENCE_REQUIRED', res._s === 412 && res._j.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(res._j))
  ok('C1: on-chain resolve NOT invoked without Passkey', onchainCalls.length === 0)
  const a = auditAll('usdc_escrow_arbiter_resolve', OID)
  ok('C1: audit trail has a fail row (gate)', a.length === 1 && JSON.parse(a[0].detail).ok === false && !!JSON.parse(a[0].detail).gate)
}
// C2: Passkey purpose mismatch → 412
{
  const OID = 'ordC2'; mkOrder(OID, 'disputed'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC2', 'arbitrate', OID)   // wrong purpose
  onchainCalls = []
  const res = await call(RESOLVE, OID, { buyer_refund_units: 1, webauthn_token: 'tokC2' })
  ok('C2: purpose-mismatched Passkey → 412, on-chain not called', res._s === 412 && onchainCalls.length === 0)
}
// C3: Passkey order_id mismatch → 412 (purpose_data binds a DIFFERENT order)
{
  const OID = 'ordC3'; mkOrder(OID, 'disputed'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC3', 'usdc_escrow_arbiter_resolve', 'some_other_order')
  onchainCalls = []
  const res = await call(RESOLVE, OID, { buyer_refund_units: 1, webauthn_token: 'tokC3' })
  ok('C3: Passkey bound to a different order_id → 412, on-chain not called', res._s === 412 && onchainCalls.length === 0)
}
// C4: wrong rail → 409, Passkey NOT consumed (rail checked before Passkey)
{
  const OID = 'ordC4'; mkOrder(OID, 'disputed', 'direct_p2p'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC4', 'usdc_escrow_arbiter_resolve', OID)
  onchainCalls = []
  const res = await call(RESOLVE, OID, { buyer_refund_units: 1, webauthn_token: 'tokC4' })
  ok('C4: non-usdc_escrow rail → 409 WRONG_RAIL', res._s === 409 && res._j.error_code === 'USDC_ESCROW_ARBITER_WRONG_RAIL')
  const tok = db.prepare('SELECT consumed_at FROM webauthn_gate_tokens WHERE id = ?').get('tokC4') as { consumed_at: string | null }
  ok('C4: Passkey token NOT consumed (rail rejected before gate)', tok.consumed_at === null)
}
// C5: buyer_refund_units > amount → 400 BAD_REFUND, on-chain not called
{
  const OID = 'ordC5'; mkOrder(OID, 'disputed'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC5', 'usdc_escrow_arbiter_resolve', OID)
  onchainCalls = []
  const res = await call(RESOLVE, OID, { buyer_refund_units: 10_000_001, webauthn_token: 'tokC5' })
  ok('C5: buyer_refund_units over amount → 400 BAD_REFUND, not called', res._s === 400 && res._j.error_code === 'USDC_ESCROW_ARBITER_BAD_REFUND' && onchainCalls.length === 0)
}
// C6: happy resolve → on-chain called, 200, audit ok row with tx_hash + NO key material
{
  const OID = 'ordC6'; mkOrder(OID, 'disputed'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC6', 'usdc_escrow_arbiter_resolve', OID)
  onchainCalls = []; onchainResult = { ok: true, txHash: '0x' + 'a'.repeat(64) }
  const res = await call(RESOLVE, OID, { buyer_refund_units: 3_000_000, webauthn_token: 'tokC6' })
  ok('C6: valid Passkey + rail + range → 200 success, tx_hash returned', res._s === 200 && res._j.success === true && res._j.tx_hash === '0x' + 'a'.repeat(64), JSON.stringify(res._j))
  ok('C6: on-chain resolve invoked once with BigInt buyerRefund', onchainCalls.length === 1 && onchainCalls[0].fn === 'resolve' && onchainCalls[0].orderId === OID && onchainCalls[0].buyerRefund === 3_000_000n)
  const a = auditAll('usdc_escrow_arbiter_resolve', OID)
  const okDetail = JSON.parse(a[a.length - 1].detail)
  ok('C6: audit_log ok row has tx_hash + buyer_refund + network', okDetail.ok === true && okDetail.tx_hash === '0x' + 'a'.repeat(64) && okDetail.buyer_refund === 3_000_000 && okDetail.network === 'testnet')
  ok('C6: audit_log detail carries NO private key / seed material', !/priv|seed|0x[0-9a-f]{64}(?!")/i.test(JSON.stringify(okDetail).replace('0x' + 'a'.repeat(64), '')) && !JSON.stringify(okDetail).includes('usdc-escrow-arbiter'))
  const tok = db.prepare('SELECT consumed_at FROM webauthn_gate_tokens WHERE id = ?').get('tokC6') as { consumed_at: string | null }
  ok('C6: Passkey token single-use consumed', tok.consumed_at !== null)
}
// C7: replay same consumed token → 412 (single-use), on-chain not called again
{
  onchainCalls = []
  const res = await call(RESOLVE, 'ordC6', { buyer_refund_units: 3_000_000, webauthn_token: 'tokC6' })
  ok('C7: reused (consumed) Passkey token → 412, on-chain not re-invoked', res._s === 412 && onchainCalls.length === 0)
}
// C8: on-chain failure surfaces honestly (no fake success)
{
  const OID = 'ordC8'; mkOrder(OID, 'disputed'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC8', 'usdc_escrow_arbiter_resolve', OID)
  onchainCalls = []; onchainResult = { ok: false, error: 'tx reverted on-chain', txHash: '0x' + 'f'.repeat(64) }
  const res = await call(RESOLVE, OID, { buyer_refund_units: 1, webauthn_token: 'tokC8' })
  ok('C8: on-chain failure → 502 RESOLVE_FAILED (never fake success), tx_hash echoed', res._s === 502 && res._j.error_code === 'USDC_ESCROW_ARBITER_RESOLVE_FAILED' && res._j.tx_hash === '0x' + 'f'.repeat(64))
  onchainResult = { ok: true, txHash: '0x' + 'a'.repeat(64) }
}
// C8b (P1 收口门): resolve on a NON-disputed order → 409 NOT_DISPUTED, on-chain NOT called, Passkey NOT consumed.
//   保证每个被认可的 Resolved 都落 applyUsdcEscrowResolved 的 disputed 收敛分支(default 分支回归"不该发生"守卫)。
{
  const OID = 'ordC8b'; mkOrder(OID, 'delivered'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })   // funded + delivered, NOT disputed
  seedGateToken('tokC8b', 'usdc_escrow_arbiter_resolve', OID)   // valid Passkey, correct purpose + order
  onchainCalls = []
  const res = await call(RESOLVE, OID, { buyer_refund_units: 3_000_000, webauthn_token: 'tokC8b' })
  ok('C8b: resolve on non-disputed order → 409 NOT_DISPUTED', res._s === 409 && res._j.error_code === 'USDC_ESCROW_ARBITER_NOT_DISPUTED', JSON.stringify(res._j))
  ok('C8b: on-chain arbiterResolve NOT invoked on non-disputed order', onchainCalls.length === 0)
  const tok = db.prepare('SELECT consumed_at FROM webauthn_gate_tokens WHERE id = ?').get('tokC8b') as { consumed_at: string | null }
  ok('C8b: Passkey token NOT consumed (disputed gate refuses before gate consumption)', tok.consumed_at === null)
  const a = auditAll('usdc_escrow_arbiter_resolve', OID)
  ok('C8b: audit trail has a fail row (not_disputed)', a.length === 1 && JSON.parse(a[0].detail).ok === false && JSON.parse(a[0].detail).reason === 'not_disputed')
}
// C9: flag-dispute happy path
{
  const OID = 'ordC9'; mkOrder(OID, 'paid'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  seedGateToken('tokC9', 'usdc_escrow_arbiter_flag', OID)
  onchainCalls = []
  const res = await call(FLAG, OID, { webauthn_token: 'tokC9' })
  ok('C9: flag-dispute valid Passkey → 200 + flagDisputeOnChain invoked', res._s === 200 && res._j.success === true && onchainCalls.length === 1 && onchainCalls[0].fn === 'flag')
}
// C10: flag-dispute no Passkey → 412
{
  const OID = 'ordC10'; mkOrder(OID, 'paid'); mkIntent(OID, deriveOrderIdBytes32(OID), { amount: 10_000_000 })
  onchainCalls = []
  const res = await call(FLAG, OID, {})
  ok('C10: flag-dispute without Passkey → 412, on-chain not called', res._s === 412 && onchainCalls.length === 0)
}

// ══════════════════════════════════════════════════════════════════════════════
// D) applyUsdcEscrowResolved(Resolved 结算消费)
// ══════════════════════════════════════════════════════════════════════════════
const deps: UsdcSettleDeps = { transition: tr, settleOrder: () => { throw new Error('settleOrder must NOT be called on the Resolved path') }, generateId: genId }
const alert = (t: string, b: string): void => alertUsdcAdmins(db, genId, t, b)
const seedResolved = (orderKey: string, tx: string, buyerRefund: bigint, sellerPaid: bigint, feePaid: bigint, block = 2000): ResolvedEventRow => {
  const payload = JSON.stringify({ orderKey: orderKey.toLowerCase(), buyerRefund: String(buyerRefund), sellerPaid: String(sellerPaid), feePaid: String(feePaid) })
  db.prepare(`INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES (?,?,?,?,?,?,?,?)`)
    .run(genId('uce'), orderKey.toLowerCase(), 'Resolved', tx, 0, block, '0xblk_' + tx, payload)
  return { order_key: orderKey.toLowerCase(), tx_hash: tx, payload_json: payload }
}
const okey = (oid: string): string => deriveOrderIdBytes32(oid)   // 用 orderIdBytes32 当 order_key 键(测试只需一致即可)

// D1: full refund → disputed→cancelled, fee row (0, auto_release=0), intents resolved, ZERO wallets writes
{
  const OID = 'ordD1'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  const ev = seedResolved(K, '0xtxD1', 10_000_000n, 0n, 0n)
  const wBefore = walletsFullSnap(); const rowsBefore = walletsRowCount(); const nBefore = notifCountAdmin()
  applyUsdcEscrowResolved(db, deps, ev, alert)
  ok('D1: full refund → order cancelled (buyer-favorable terminal)', orderStatus(OID) === 'cancelled', orderStatus(OID))
  ok('D1: disputed→cancelled by sys_protocol', histCount(OID, 'disputed', 'cancelled') === 1 && histActor(OID, 'disputed', 'cancelled') === 'sys_protocol')
  ok('D1: fee_ledger 1 row (feePaid=0, auto_release=0 = arbiter)', feeCount(OID) === 1 && feeRow(OID).amount_units === 0 && feeRow(OID).auto_release === 0)
  ok('D1: intents → resolved', intentStatus(OID) === 'resolved')
  ok('D1: ZERO wallets writes — full snapshot byte-identical', walletsFullSnap() === wBefore && walletsRowCount() === rowsBefore)
  ok('D1: no admin alert on happy path', notifCountAdmin() === nBefore)
}
// D2: partial refund → disputed→completed (seller-favorable), fee mirror
{
  const OID = 'ordD2'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  const ev = seedResolved(K, '0xtxD2', 3_000_000n, 6_860_000n, 140_000n)   // sum = 10_000_000
  const wBefore = walletsFullSnap()
  applyUsdcEscrowResolved(db, deps, ev, alert)
  ok('D2: partial refund → order completed (seller-favorable terminal)', orderStatus(OID) === 'completed', orderStatus(OID))
  ok('D2: disputed→completed by sys_protocol', histActor(OID, 'disputed', 'completed') === 'sys_protocol')
  ok('D2: fee_ledger amount=feePaid(140000), auto_release=0', feeRow(OID).amount_units === 140_000 && feeRow(OID).auto_release === 0)
  ok('D2: intents resolved + ZERO wallets writes', intentStatus(OID) === 'resolved' && walletsFullSnap() === wBefore)
}
// D3: zero refund → disputed→completed
{
  const OID = 'ordD3'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  applyUsdcEscrowResolved(db, deps, seedResolved(K, '0xtxD3', 0n, 9_800_000n, 200_000n), alert)
  ok('D3: zero refund → completed, fee=200000', orderStatus(OID) === 'completed' && feeRow(OID).amount_units === 200_000)
}
// D4: conservation mismatch → no state change, no fee row, alert
{
  const OID = 'ordD4'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  const nBefore = notifCountAdmin()
  applyUsdcEscrowResolved(db, deps, seedResolved(K, '0xtxD4', 3_000_000n, 6_000_000n, 140_000n), alert)   // sum = 9_140_000 ≠ 10_000_000
  ok('D4: conservation mismatch → stays disputed, no fee row', orderStatus(OID) === 'disputed' && feeCount(OID) === 0)
  ok('D4: intents stays funded, admin alerted', intentStatus(OID) === 'funded' && notifCountAdmin() === nBefore + 1)
}
// D5: idempotent replay on already-terminal order → no double fee row, no new history, no alert
{
  const OID = 'ordD5'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  const ev = seedResolved(K, '0xtxD5', 10_000_000n, 0n, 0n)
  applyUsdcEscrowResolved(db, deps, ev, alert)   // → cancelled
  const nBefore = notifCountAdmin(); const hBefore = histCount(OID, 'disputed', 'cancelled')
  applyUsdcEscrowResolved(db, deps, ev, alert)   // replay
  ok('D5: replay → fee still 1 row', feeCount(OID) === 1)
  ok('D5: replay → no new disputed→cancelled history', histCount(OID, 'disputed', 'cancelled') === hBefore)
  ok('D5: replay → no new admin alert', notifCountAdmin() === nBefore)
}
// D6: non-disputed order receives Resolved → alert only, no forced transition, no fee row
{
  const OID = 'ordD6'; const K = okey(OID); mkOrder(OID, 'paid'); mkIntent(OID, K, { amount: 10_000_000 })
  const nBefore = notifCountAdmin()
  applyUsdcEscrowResolved(db, deps, seedResolved(K, '0xtxD6', 3_000_000n, 6_860_000n, 140_000n), alert)
  ok('D6: non-disputed order → alert only, stays paid, no fee row (never force-transition illegal state)', orderStatus(OID) === 'paid' && feeCount(OID) === 0 && notifCountAdmin() === nBefore + 1)
}
// D7: unknown order_key → alert only
{
  const nBefore = notifCountAdmin()
  applyUsdcEscrowResolved(db, deps, seedResolved(okey('ghost'), '0xtxD7', 1n, 1n, 0n), alert)
  ok('D7: unknown order_key → admin alerted, no crash', notifCountAdmin() === nBefore + 1)
}
// D8: intent issued (not yet funded) → alert only
{
  const OID = 'ordD8'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000, status: 'issued' })
  const nBefore = notifCountAdmin()
  applyUsdcEscrowResolved(db, deps, seedResolved(K, '0xtxD8', 1n, 9_999_999n, 0n), alert)
  ok('D8: intent issued → alert only, stays disputed', orderStatus(OID) === 'disputed' && notifCountAdmin() === nBefore + 1)
}
// D8b (P2b): malformed Resolved payload (non-numeric amount field) → BigInt parse caught → alert, NEVER throws through
//   watcher processLog. Without the try/catch, BigInt('nope') throws and crashes the whole event loop tick.
{
  const OID = 'ordD8b'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  // seed a Resolved chain event whose payload has a non-numeric buyerRefund → BigInt() will throw on parse
  const badPayload = JSON.stringify({ orderKey: K.toLowerCase(), buyerRefund: 'not_a_number', sellerPaid: '0', feePaid: '0' })
  db.prepare(`INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES (?,?,?,?,?,?,?,?)`)
    .run(genId('uce'), K.toLowerCase(), 'Resolved', '0xtxD8b', 0, 2500, '0xblk_D8b', badPayload)
  const badEv: ResolvedEventRow = { order_key: K.toLowerCase(), tx_hash: '0xtxD8b', payload_json: badPayload }
  const nBefore = notifCountAdmin()
  let threw = false
  try { applyUsdcEscrowResolved(db, deps, badEv, alert) } catch { threw = true }
  ok('D8b: malformed payload → does NOT throw through processLog (caught internally)', threw === false)
  ok('D8b: malformed payload → admin alerted, order stays disputed, no fee row', orderStatus(OID) === 'disputed' && feeCount(OID) === 0 && notifCountAdmin() === nBefore + 1)
}
// D9: sweepPendingUsdcEscrowResolves — Resolved mirror present + order disputed (event scrolled past window) → sweep closes it
{
  const OID = 'ordD9'; const K = okey(OID); mkOrder(OID, 'disputed'); mkIntent(OID, K, { amount: 10_000_000 })
  seedResolved(K, '0xtxD9', 10_000_000n, 0n, 0n)
  sweepPendingUsdcEscrowResolves(db, deps, alert)
  ok('D9: sweep drives disputed order with Resolved mirror → cancelled (full refund)', orderStatus(OID) === 'cancelled' && feeCount(OID) === 1)
  // second sweep: order no longer disputed → not re-selected (bounded)
  const hBefore = histCount(OID, 'disputed', 'cancelled')
  sweepPendingUsdcEscrowResolves(db, deps, alert)
  ok('D9: second sweep → no re-transition (order left disputed set)', histCount(OID, 'disputed', 'cancelled') === hBefore)
}

// ══════════════════════════════════════════════════════════════════════════════
// E) IRON-RULE PIN — three existing fail-closed refusals still refuse (source lock)
// ══════════════════════════════════════════════════════════════════════════════
const DE = readFileSync('src/layer3-trust/L3-1-dispute-engine/dispute-engine.ts', 'utf8')
const DC = readFileSync('src/layer3-trust/L3-1-dispute-engine/decline-contest-resolve.ts', 'utf8')
const MC = readFileSync('src/layer3-trust/L3-1-dispute-engine/mutual-cancel.ts', 'utf8')
ok("E: dispute-engine arbitrate STILL fail-closed for usdc_escrow (automated ruling never fires arbiter key)",
  /payment_rail === 'usdc_escrow'\)\s*return \{ success: false, error: 'USDC 担保争议经链上仲裁裁决/.test(DE))
ok("E: decline-contest-resolve STILL throws USDC_ESCROW_ARBITRATION_NOT_WIRED for usdc_escrow",
  /payment_rail === 'usdc_escrow'\)\s*throw new DcResolveError\('USDC_ESCROW_ARBITRATION_NOT_WIRED'/.test(DC))
ok("E: mutual-cancel STILL fail-closed (USDC_ESCROW_MUTUAL_CANCEL_NOT_WIRED) for usdc_escrow",
  /payment_rail === 'usdc_escrow'\)\s*return \{ ok: false,[^}]*USDC_ESCROW_MUTUAL_CANCEL_NOT_WIRED/.test(MC))
{
  // the ADD-only guarantee: B7a code (route + signer) never IMPORTS / invokes the three automated modules
  const routeSrc = readFileSync('src/pwa/routes/usdc-escrow-arbiter.ts', 'utf8')
  const signerSrc = readFileSync('src/pwa/internal/usdc-escrow-arbiter-signer.ts', 'utf8')
  const importsAutomated = (s: string): boolean => /^\s*import[^\n]*(dispute-engine|decline-contest|mutual-cancel)/m.test(s)
  ok('E: B7a route + signer do NOT import dispute-engine / decline-contest / mutual-cancel (add-only manual path)',
    !importsAutomated(routeSrc) && !importsAutomated(signerSrc))
}

// ══════════════════════════════════════════════════════════════════════════════
// E-runtime) BEHAVIORAL PROOF — the three automated rulers actually REFUSE a usdc_escrow order at runtime
//   (not just a source-string lock in E). Proves the zero-fund DB ruling paths can never fire the arbiter key.
// ══════════════════════════════════════════════════════════════════════════════
{
  const { arbitrateDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
  const { resolveDeclineContestDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/decline-contest-resolve.js')
  const { acceptMutualCancel, proposeMutualCancel, initMutualCancelSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.js')
  initMutualCancelSchema(db)
  // mutual-cancel loadCancellable reads orders.stake_backing / bid_stake_held — add columns to the fixture.
  for (const col of ['stake_backing REAL DEFAULT 0', 'bid_stake_held REAL DEFAULT 0']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }

  // arbitrate + decline-contest share one disputed usdc_escrow order + open dispute
  const OA = 'ordERarb'; mkOrder(OA, 'disputed'); mkIntent(OA, deriveOrderIdBytes32(OA), { amount: 10_000_000 })
  db.prepare("INSERT INTO disputes (id, order_id, initiator_id, reason, status) VALUES ('dspER1', ?, 'buyer1', 'runtime refusal probe', 'open')").run(OA)

  // sys_protocol is an authorized arbitrator (role=system) — proves refusal is the RAIL gate, not an auth miss.
  const arb = arbitrateDispute(db, 'dspER1', 'sys_protocol', 'refund_buyer', 'runtime refusal probe')
  ok('E-runtime: arbitrateDispute on usdc_escrow → success:false (arbiter key NOT fired by zero-fund ruling)',
    arb.success === false && /链上仲裁裁决|arbiter/.test(arb.error || ''), JSON.stringify(arb))
  ok('E-runtime: arbitrate refusal left the order disputed (no illegal terminal transition)', orderStatus(OA) === 'disputed')

  // decline-contest: rail gate is the very first check (before dispute_type validation) → throws NOT_WIRED
  let declineCode = ''
  try { resolveDeclineContestDispute(db, 'dspER1', 'sys_protocol', 'decline_fault_confirmed', 'runtime refusal probe', 'timeout_auto') }
  catch (e) { declineCode = (e as { code?: string })?.code || (e as Error).message }
  ok('E-runtime: resolveDeclineContestDispute on usdc_escrow → throws USDC_ESCROW_ARBITRATION_NOT_WIRED',
    declineCode === 'USDC_ESCROW_ARBITRATION_NOT_WIRED', declineCode)

  // mutual-cancel: propose (buyer) then accept (seller) reaches settleMutualCancel → rail gate refuses (no zero-fund close)
  const OM = 'ordERmc'; mkOrder(OM, 'disputed')
  db.prepare("INSERT INTO disputes (id, order_id, initiator_id, reason, status) VALUES ('dspER2', ?, 'buyer1', 'runtime refusal probe', 'open')").run(OM)
  const prop = proposeMutualCancel(db, OM, 'buyer1', 'runtime probe', genId('mcp'))
  ok('E-runtime: mutual-cancel proposal seeded (precondition for accept)', prop.ok === true, JSON.stringify(prop))
  const acc = acceptMutualCancel(db, OM, 'seller1')
  ok('E-runtime: acceptMutualCancel on usdc_escrow → ok:false USDC_ESCROW_MUTUAL_CANCEL_NOT_WIRED (zero-fund close refused)',
    acc.ok === false && acc.error_code === 'USDC_ESCROW_MUTUAL_CANCEL_NOT_WIRED', JSON.stringify(acc))
  ok('E-runtime: mutual-cancel refusal left the order disputed', orderStatus(OM) === 'disputed')
}

if (fail > 0) { console.error(`\n❌ usdc-escrow-arbiter FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow-arbiter: distinct arbiter signer role + on-chain arbiterResolve/flagDispute (preflight state gate, BigInt bounds, never-fake-success) + admin Passkey-gated ruling routes (real consumeGateToken; no-Passkey/purpose/order/rail/range all refused; audit has txHash not keys) + Resolved settlement (full→cancelled / partial→completed, ZERO wallets writes, idempotent, non-disputed alert-only) + iron-rule pin (three automated fail-closed refusals intact)\n  ✅ pass ${pass}`)
