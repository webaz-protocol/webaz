#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B6b-2 —— 买家链上钱包面(EIP-1193 层 / 存入 stepper / 释放·争议)回归锁。
 *
 * 形状:后端用【真】路由 + 【真】固定种子签名者产出【真】calldata,前端用 node:vm + 极简 fake DOM
 *   【真】执行 public/app-usdc-*.js,并注入可编程的 fake window.ethereum。零网络(只有 127.0.0.1 上的
 *   本进程 express)、零 jsdom、零 provider mock 掺进被测判定者(钱包基础层/stepper/释放面都是真实实现)。
 *
 * Proves:
 *   D1 后端编码:approve/deposit/allowance/balanceOf/buyerRelease/flagDispute 的 calldata 全由 viem 在后端
 *      产出;approve 是【精确额度】(== 本单 amount,不是 max uint);usdc_token 未配 → 后端不给 calls。
 *   D2 绝不前端假成功:存入 tx 广播后前端只打 /usdc-escrow/status,零订单写请求。
 *   D3 accountsChanged → voucher 作废回到第 1 步。
 *   D4 localStorage txHash → 重进直接等待态、按钮禁用、不重复发 tx。
 *   + 无钱包 / 4001 拒签 / 4902 加链 / 余额不足 / voucher 过期自动重取一次 / 自动放款 exclusive 边界 /
 *     争议文案不承诺 B7 未接线的裁决能力 / 三文件零外联 / 接线四处(index.html + ratchet + pwa-syntax + ci)。
 *
 * Usage: npm run test:usdc-escrow-wallet-ui
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { decodeFunctionData, getAddress, parseAbi } from 'viem'

const tmpHome = mkdtempSync(join(tmpdir(), 'uewallet-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.NETWORK = 'testnet'                               // chainId 84532
process.env.USDC_ESCROW_CONTRACT = getAddress('0x' + '9'.repeat(40))
process.env.USDC_TOKEN_ADDRESS = getAddress('0x' + 'a'.repeat(40))
const CONTRACT = process.env.USDC_ESCROW_CONTRACT
const TOKEN = process.env.USDC_TOKEN_ADDRESS

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { createLocalSeedSigner } = await import('../src/pwa/internal/wallet-signer.js')
const { registerUsdcEscrowRoutes, deriveOrderIdBytes32, deriveOrderKey } = await import('../src/pwa/routes/usdc-escrow.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── fixture ──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
for (const col of ['payment_rail TEXT', 'source TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','b1','buyer','k_b1'),('s1','s1','seller','k_s1')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,status) VALUES ('p1','s1','品','d',10,99,'active')").run()
const SELLER_PAYOUT = getAddress('0x' + '3'.repeat(40))
db.prepare("INSERT INTO seller_payout_addresses (id, seller_id, address, chain, status) VALUES ('spa1','s1',?,'base','active')").run(SELLER_PAYOUT)
const BUYER_ADDR = getAddress('0x' + '1'.repeat(40))
const futureIso = (h: number): string => new Date(Date.now() + h * 3600_000).toISOString()
const mkOrder = (id: string, status = 'created'): void => {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, source, pay_deadline)
    VALUES (?, 'p1', 'b1', 's1', 1, 10, 10, 0, ?, 'usdc_escrow', 'shop', ?)`).run(id, status, futureIso(24))
}

const PARAMS: Record<string, string | number> = {
  payment_rail_usdc_escrow_enabled: 1, 'usdc_escrow.per_tx_cap': 50,
  'usdc_escrow.auto_release_days': 14, 'usdc_escrow.voucher_ttl_minutes': 60,
}
const getProtocolParam = <T,>(k: string, fb: T): T => (k in PARAMS ? PARAMS[k] as unknown as T : fb)
const signer = createLocalSeedSigner('test-master-seed-deterministic-vector-1234')

const app = express(); app.use(express.json())
const authStub = (req: Request, res: Response): Record<string, unknown> | null => {
  const uid = req.headers['x-test-uid'] as string | undefined
  const u = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined : undefined
  if (!u) { res.status(401).json({ error: 'login' }); return null }
  return u
}
registerUsdcEscrowRoutes(app, { db, auth: authStub, isTrustedRole: () => false, getProtocolParam, escrowVoucherAccount: () => signer.escrowVoucherAccount() })
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
/* eslint-disable @typescript-eslint/no-explicit-any */
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})

const ERC20 = parseAbi(['function approve(address spender, uint256 value) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address account) view returns (uint256)'])
const ESCROW = parseAbi([
  'function deposit(bytes32 orderId, address seller, uint256 amount, uint256 feeBps, uint64 autoReleaseAt, uint256 authExpiresAt, bytes authorization)',
  'function buyerRelease(bytes32 orderId)', 'function flagDispute(bytes32 orderId)',
])
const MAX_UINT256 = (1n << 256n) - 1n

// ══════════════════════════════════════════════════════════════════════════════
// PART 1 — 后端 D1:calldata 全部由 viem 在后端编码,approve 精确额度
// ══════════════════════════════════════════════════════════════════════════════
mkOrder('o_pay')
const vres = await call('POST', '/api/orders/o_pay/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
ok('1a. voucher 200 + carries calls{approve,deposit} and reads{allowance,balance}',
  vres.status === 200 && !!vres.json.calls?.approve?.data && !!vres.json.calls?.deposit?.data && !!vres.json.reads?.allowance?.data && !!vres.json.reads?.balance?.data, JSON.stringify(vres.json).slice(0, 300))
const V = vres.json
const AMOUNT = BigInt(V.deposit_call.amount)
ok('1b. deposit_call echoes the EIP-55 buyer address the digest is bound to (the PWA has no keccak → no client-side checksumming)',
  V.deposit_call.buyer === BUYER_ADDR, String(V.deposit_call.buyer))
ok('1c. approve targets the USDC token, deposit targets the escrow contract',
  V.calls.approve.to === TOKEN && V.calls.deposit.to === CONTRACT && V.reads.allowance.to === TOKEN && V.reads.balance.to === TOKEN,
  `${V.calls.approve.to} / ${V.calls.deposit.to}`)
{
  const d = decodeFunctionData({ abi: ERC20, data: V.calls.approve.data })
  ok('1d. approve() spender == escrow contract', d.functionName === 'approve' && (d.args as any[])[0] === CONTRACT)
  const value = (d.args as any[])[1] as bigint
  ok('1e. approve() value is the EXACT order amount — never an infinite/max approval', value === AMOUNT && value !== MAX_UINT256, `value=${value} amount=${AMOUNT}`)
}
{
  const d = decodeFunctionData({ abi: ESCROW, data: V.calls.deposit.data })
  const a = d.args as any[]
  ok('1f. deposit() calldata is byte-identical to the signed voucher params (orderId/seller/amount/feeBps/autoReleaseAt/authExpiresAt/authorization)',
    d.functionName === 'deposit' && a[0] === V.deposit_call.order_id_bytes32 && a[1] === V.deposit_call.seller
    && a[2] === AMOUNT && a[3] === BigInt(V.deposit_call.fee_bps) && a[4] === BigInt(V.deposit_call.auto_release_at)
    && a[5] === BigInt(V.deposit_call.auth_expires_at) && a[6] === V.deposit_call.authorization, JSON.stringify(a.map(String)))
}
{
  const dAllow = decodeFunctionData({ abi: ERC20, data: V.reads.allowance.data })
  const dBal = decodeFunctionData({ abi: ERC20, data: V.reads.balance.data })
  ok('1g. reads are allowance(buyer, escrow) + balanceOf(buyer)',
    dAllow.functionName === 'allowance' && (dAllow.args as any[])[0] === BUYER_ADDR && (dAllow.args as any[])[1] === CONTRACT
    && dBal.functionName === 'balanceOf' && (dBal.args as any[])[0] === BUYER_ADDR)
}
// usdc_token 未配 → 后端【不返回 calls】(前端 fail-visible,绝不猜地址)
mkOrder('o_notoken')
delete process.env.USDC_TOKEN_ADDRESS
const vNo = await call('POST', '/api/orders/o_notoken/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
ok('1h. USDC_TOKEN_ADDRESS unset → voucher still issued but carries NO calls/reads and usdc_token:null (fail-visible, never guessed)',
  vNo.status === 200 && vNo.json.usdc_token === null && vNo.json.calls === undefined && vNo.json.reads === undefined, JSON.stringify(vNo.json).slice(0, 200))
// 配了但非法 → 同样不给 calls(绝不把坏地址编进 calldata)
process.env.USDC_TOKEN_ADDRESS = 'not-an-address'
mkOrder('o_badtoken')
const vBad = await call('POST', '/api/orders/o_badtoken/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
ok('1i. malformed USDC_TOKEN_ADDRESS → no calls emitted (a bad address is never encoded into calldata)',
  vBad.status === 200 && vBad.json.usdc_token === null && vBad.json.calls === undefined)
process.env.USDC_TOKEN_ADDRESS = TOKEN

// ══════════════════════════════════════════════════════════════════════════════
// PART 2 — 后端 D1:GET /status 的 release / flag_dispute calldata 门
// ══════════════════════════════════════════════════════════════════════════════
const mirrorEvent = (orderId: string, name: string, idx: number): void => {
  const key = deriveOrderKey(deriveOrderIdBytes32(orderId))
  db.prepare("INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES (?,?,?,?,?,?,?,'{}')")
    .run(`ce_${orderId}_${name}`, key, name, '0x' + String(idx).padStart(64, '0'), idx, 100 + idx, '0x' + String(idx + 50).padStart(64, '0'))
}
// A4:真实语境里 watcher 在【参数匹配】的存款上把 intent issued→funded(见 usdc-escrow-watcher.ts);
//   /status 的 funded 门现同时看 intent_status。测试里手动补这一步以复现 happy path(失配单则故意不补)。
const markFunded = (orderId: string): void => { db.prepare("UPDATE usdc_escrow_intents SET status='funded' WHERE order_id=?").run(orderId) }
const stBefore = await call('GET', '/api/orders/o_pay/usdc-escrow/status', 'b1')
ok('2a. status before any on-chain event → no calls at all (nothing to sign)',
  stBefore.status === 200 && stBefore.json.deposited_seen === false && stBefore.json.calls === undefined, JSON.stringify(stBefore.json))
ok('2b. status echoes the cross-check economics the UI must display (amount/seller/contract/fee/auto_release_at/chain_id)',
  stBefore.json.amount === V.deposit_call.amount && stBefore.json.seller === SELLER_PAYOUT && stBefore.json.contract === CONTRACT
  && stBefore.json.fee_bps === V.deposit_call.fee_bps && stBefore.json.auto_release_at === V.deposit_call.auto_release_at && stBefore.json.chain_id === 84532,
  JSON.stringify(stBefore.json))
mirrorEvent('o_pay', 'Deposited', 1); markFunded('o_pay')
const stFunded = await call('GET', '/api/orders/o_pay/usdc-escrow/status', 'b1')
ok('2c. Funded → buyer gets release + flag_dispute calldata', stFunded.json.deposited_seen === true && !!stFunded.json.calls?.release?.data && !!stFunded.json.calls?.flag_dispute?.data, JSON.stringify(stFunded.json.calls))
// A4:参数失配的存款 —— 链上镜像已有 Deposited,但 watcher【拒绝】把 intent 提升到 funded(仍 issued)。
//   此时 /status 绝不下发任何可执行 calldata(否则会与"勿发货、平台核对中"告警自相矛盾)。
mkOrder('o_mismatch')
await call('POST', '/api/orders/o_mismatch/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
mirrorEvent('o_mismatch', 'Deposited', 20)   // 存款镜像进来了,但故意【不】markFunded(模拟参数失配)
const stMis = await call('GET', '/api/orders/o_mismatch/usdc-escrow/status', 'b1')
ok('2c-A4. Deposited mirrored but intent still issued (param mismatch) → deposited_seen true, intent_status issued, and NO calls emitted (no release button while the watcher says "do not ship")',
  stMis.json.deposited_seen === true && stMis.json.intent_status === 'issued' && stMis.json.calls === undefined, JSON.stringify(stMis.json))
{
  const r = decodeFunctionData({ abi: ESCROW, data: stFunded.json.calls.release.data })
  const f = decodeFunctionData({ abi: ESCROW, data: stFunded.json.calls.flag_dispute.data })
  const b32 = deriveOrderIdBytes32('o_pay')
  ok('2d. release=buyerRelease(orderId) / dispute=flagDispute(orderId), both bound to this order and to the intent-snapshot contract',
    r.functionName === 'buyerRelease' && (r.args as any[])[0] === b32 && f.functionName === 'flagDispute' && (f.args as any[])[0] === b32
    && stFunded.json.calls.release.to === CONTRACT && stFunded.json.calls.flag_dispute.to === CONTRACT)
}
const stSeller = await call('GET', '/api/orders/o_pay/usdc-escrow/status', 's1')
ok('2e. the SELLER never gets release/flag_dispute calldata (both are msg.sender==buyer on-chain — handing them over would be a guaranteed revert)',
  stSeller.status === 200 && stSeller.json.calls === undefined, JSON.stringify(stSeller.json.calls))
// exclusive 边界:auto_release_at 已到 → 买家不再拿到 flag_dispute(合约 AutoReleaseWindowPassed)
mkOrder('o_expired')
await call('POST', '/api/orders/o_expired/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
db.prepare("UPDATE usdc_escrow_intents SET auto_release_at = ? WHERE order_id = 'o_expired'").run(new Date(Date.now() - 1000).toISOString())
mirrorEvent('o_expired', 'Deposited', 2); markFunded('o_expired')
const stExp = await call('GET', '/api/orders/o_expired/usdc-escrow/status', 'b1')
ok('2f. at/after auto_release_at the buyer gets NO flag_dispute calldata (contract boundary is EXCLUSIVE) but release is still valid',
  !!stExp.json.calls?.release && stExp.json.calls?.flag_dispute === undefined, JSON.stringify(stExp.json.calls))
// Disputed 后两个买家调用都会 BadState revert → 一个都不给
mkOrder('o_disputed')
await call('POST', '/api/orders/o_disputed/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
mirrorEvent('o_disputed', 'Deposited', 3); mirrorEvent('o_disputed', 'Disputed', 4)
const stDis = await call('GET', '/api/orders/o_disputed/usdc-escrow/status', 'b1')
ok('2g. after Disputed → disputed_seen exposed and NO buyer calldata (only arbiterResolve can exit that state)',
  stDis.json.disputed_seen === true && stDis.json.calls === undefined, JSON.stringify(stDis.json))
mkOrder('o_released')
await call('POST', '/api/orders/o_released/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
mirrorEvent('o_released', 'Deposited', 5); mirrorEvent('o_released', 'Released', 6)
const stRel = await call('GET', '/api/orders/o_released/usdc-escrow/status', 'b1')
ok('2h. after Released → no calls (escrow is terminal)', stRel.json.released_seen === true && stRel.json.calls === undefined)
// A5:chain_id 取 intent 签发时快照,而非 live env —— testnet→mainnet flip 后在途单绝不被切错链。
mkOrder('o_chainflip')
const vFlip = await call('POST', '/api/orders/o_chainflip/usdc-escrow/voucher', 'b1', { buyer_address: BUYER_ADDR })
ok('2i. voucher is signed for the env-at-issuance chain (testnet → 84532)', vFlip.json.chain_id === 84532, String(vFlip.json.chain_id))
process.env.NETWORK = 'mainnet'                              // 模拟 env flip
const stFlip = await call('GET', '/api/orders/o_chainflip/usdc-escrow/status', 'b1')
ok('2j. A5: after an env flip to mainnet, an in-flight order STILL reports its snapshot chain (84532), not the live env (8453) — so the wallet is never asked to switch to a chain the deposit contract does not live on',
  stFlip.json.chain_id === 84532, String(stFlip.json.chain_id))
process.env.NETWORK = 'testnet'                              // 复原,后续 PART 3 用不到 env 但保持干净
server.close()

// ══════════════════════════════════════════════════════════════════════════════
// PART 3 — 前端:真执行 public/app-usdc-*.js + fake window.ethereum
// ══════════════════════════════════════════════════════════════════════════════
const src = (f: string): string => readFileSync(`src/pwa/public/${f}`, 'utf8')
const FILES = ['app-usdc-wallet.js', 'app-usdc-escrow-pay.js', 'app-usdc-escrow-release.js']

interface EthCfg {
  account: string; chainIdHex: string; rejectConnect?: boolean
  switchErr?: unknown; addErr?: unknown; callResults?: Record<string, string>; receipt?: unknown
}
interface Harness {
  ctx: any; win: any; el: any; eth: any; cfg: EthCfg
  methods: string[]; sends: any[]; apiLog: string[]
  fire: (ev: string, ...a: unknown[]) => void
  flush: (rounds?: number) => Promise<void>
  store: Record<string, string>
}
function harness(opts: {
  cfg: EthCfg; noWallet?: boolean; voucher?: unknown; status?: unknown
  statusSeq?: unknown[]; voucherSeq?: unknown[]; store?: Record<string, string>
}): Harness {
  const methods: string[] = [], sends: any[] = [], apiLog: string[] = []
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const timers: Array<() => void> = []
  const store: Record<string, string> = opts.store ? { ...opts.store } : {}
  const cfg = opts.cfg
  let statusIdx = 0, voucherIdx = 0
  const el: any = { id: 'usdc-escrow-card', isConnected: true, innerHTML: '' }
  const eth = {
    request: async ({ method, params }: { method: string; params?: any[] }): Promise<unknown> => {
      methods.push(method)
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        if (cfg.rejectConnect) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
        return [cfg.account]
      }
      if (method === 'eth_chainId') return cfg.chainIdHex
      if (method === 'wallet_switchEthereumChain') { if (cfg.switchErr) throw cfg.switchErr; cfg.chainIdHex = params![0].chainId; return null }
      if (method === 'wallet_addEthereumChain') { if (cfg.addErr) throw cfg.addErr; cfg.chainIdHex = params![0].chainId; return null }
      if (method === 'eth_call') {
        const hit = (cfg.callResults || {})[String(params![0].data)]
        if (hit === undefined) throw Object.assign(new Error('unexpected eth_call'), { code: 'TEST_UNEXPECTED_CALL' })
        return hit
      }
      if (method === 'eth_sendTransaction') { sends.push(params![0]); return '0x' + String(sends.length).padStart(64, '0') }
      if (method === 'eth_getTransactionReceipt') return cfg.receipt !== undefined ? cfg.receipt : { status: '0x1' }
      throw Object.assign(new Error('unknown method ' + method), { code: 'TEST_UNKNOWN' })
    },
    on: (ev: string, cb: (...a: unknown[]) => void) => { (listeners[ev] ||= []).push(cb) },
    removeListener: (ev: string, cb: (...a: unknown[]) => void) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== cb) },
  }
  const document = { hidden: false, getElementById: (id: string) => (id === 'usdc-escrow-card' ? el : null) }
  const win: any = { ethereum: opts.noWallet ? undefined : eth }
  win.apiRead = async (path: string) => {
    apiLog.push('GET ' + path)
    const body = opts.statusSeq ? opts.statusSeq[Math.min(statusIdx++, opts.statusSeq.length - 1)] : opts.status
    return body === undefined ? { ok: false, status: 0, data: null } : { ok: true, status: 200, data: body }
  }
  win.apiWriteIdempotent = async (method: string, path: string, body: unknown) => {
    apiLog.push(method + ' ' + path + ' ' + JSON.stringify(body))
    const v = opts.voucherSeq ? opts.voucherSeq[Math.min(voucherIdx++, opts.voucherSeq.length - 1)] : opts.voucher
    return v === undefined ? { ok: false, status: 500, data: { error: 'boom' } } : { ok: true, status: 200, data: v }
  }
  const ctx: any = {
    window: win, document, console,
    localStorage: { getItem: (k: string) => (k in store ? store[k] : null), setItem: (k: string, v: string) => { store[k] = String(v) }, removeItem: (k: string) => { delete store[k] } },
    t: (s: string) => s, escHtml: (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, JSON, Number, String, Math, Boolean, BigInt, isFinite, encodeURIComponent, Promise, Error, RegExp, Object, Array,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  for (const f of FILES) vm.runInContext(src(f), ctx)
  const flush = async (rounds = 1): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      const batch = timers.splice(0)
      for (const fn of batch) { try { fn() } catch { /* 定时器体自身的错误不该炸测试驱动 */ } }
      for (let k = 0; k < 6; k++) await new Promise(r => setImmediate(r))
    }
  }
  return { ctx, win, el, eth, cfg, methods, sends, apiLog, store, flush, fire: (ev, ...a) => (listeners[ev] || []).forEach(cb => cb(...a)) }
}

const ORDER = { id: 'o_pay', payment_rail: 'usdc_escrow', status: 'created', pay_deadline: futureIso(24) }
const STATUS_UNPAID = { ...stBefore.json }
// eth_call 返回表:键 = 后端产出的 read calldata,值 = 32 字节 hex
const hex32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0')
const reads = (bal: bigint, allow: bigint): Record<string, string> => ({ [V.reads.balance.data]: hex32(bal), [V.reads.allowance.data]: hex32(allow) })
const CHAIN_OK = '0x14a34'          // 84532
const CHAIN_WRONG = '0x1'           // Ethereum mainnet
const state = (h: Harness): any => h.win._usdcPayState()

// ── ① 无钱包 → 引导态,不抛 ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, noWallet: true, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  ok('①a no wallet → available() is false and hydrate does not throw', h.win.webazWalletAvailable() === false && !!state(h))
  await h.win.usdcPayAdvance()
  ok('①b no wallet → guidance state, zero transactions, no raw provider error surfaced',
    state(h).step === 'nowallet' && h.sends.length === 0 && h.el.innerHTML.includes('未检测到链上钱包'), h.el.innerHTML.slice(0, 200))
  ok('①c the guidance copy tells the user NOT to hand-transfer anywhere (no silent fallback path)', h.el.innerHTML.includes('不要向任何地址手动转账'))
}

// ── ② 用户拒签 4001 → 诚实文案,不重试、不进下一步 ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, rejectConnect: true }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  const s = state(h)
  ok('②a 4001 → stays on step 1 (intro), no voucher fetched, no transaction sent',
    s.step === 'intro' && s.hasVoucher === false && h.sends.length === 0 && !h.apiLog.some(l => l.startsWith('POST')), JSON.stringify(h.apiLog))
  ok('②b 4001 copy is honest: "cancelled in your wallet, nothing sent, nothing charged"',
    s.kind === 'warn' && s.msg.includes('你在钱包里取消了操作') && s.msg.includes('没有发出任何交易'), s.msg)
  ok('②c exactly ONE eth_requestAccounts — a rejection is never silently retried',
    h.methods.filter(m => m === 'eth_requestAccounts').length === 1, h.methods.join(','))
}

// ── ③ 链不对 → switch;4902 → addChain;addChain 再拒 → 停在链检查步 ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_WRONG, switchErr: Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }), addErr: Object.assign(new Error('User rejected'), { code: 4001 }) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  ok('③a wrong chain → switch attempted, 4902 → addEthereumChain attempted',
    h.methods.includes('wallet_switchEthereumChain') && h.methods.includes('wallet_addEthereumChain'), h.methods.join(','))
  ok('③b addChain rejected → stops at the chain step, no voucher, no transaction',
    state(h).step === 'chain' && h.sends.length === 0 && !h.apiLog.some(l => l.startsWith('POST')), JSON.stringify(state(h)))
  const params = (h.win.webazWalletChainParams(84532))
  ok('③c Base Sepolia addChain params are hardcoded in the wallet layer (chainId hex + rpc + explorer)',
    params.chainId === '0x14a34' && params.rpcUrls.length === 1 && /basescan/.test(params.blockExplorerUrls[0]), JSON.stringify(params))
  ok('③d Base mainnet params hardcoded too', h.win.webazWalletChainParams(8453).chainId === '0x2105')
  ok('③e unknown chain id → refused, never invented', h.win.webazWalletChainParams(1) === null)
}
// 链切换成功 → 继续推进(反证:③ 的停顿是 addChain 被拒造成的,不是链检查本身写死了失败)
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_WRONG, callResults: reads(AMOUNT, AMOUNT) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  ok('③f COUNTER-PROOF: switch succeeds → the stepper proceeds all the way to the broadcast deposit',
    state(h).step === 'waiting' && h.sends.length === 1, JSON.stringify(state(h)))
}

// ── ④ allowance ≥ amount → 跳过 approve;allowance < amount → 精确额度 approve ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  ok('④a allowance == amount → approve is SKIPPED (exactly one tx, and it is the deposit)',
    h.sends.length === 1 && h.sends[0].data === V.calls.deposit.data && h.sends[0].to === CONTRACT, `${h.sends.length} sends`)
}
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT - 1n) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  ok('④b allowance < amount → approve then deposit, in that order', h.sends.length === 2 && h.sends[0].to === TOKEN && h.sends[1].to === CONTRACT, `${h.sends.length} sends`)
  const dec = decodeFunctionData({ abi: ERC20, data: h.sends[0].data })
  const value = (dec.args as any[])[1] as bigint
  ok('④c the approve the WALLET is asked to sign carries the EXACT amount — not max uint', value === AMOUNT && value !== MAX_UINT256, `value=${value}`)
  ok('④d the deposit tx bytes are the backend-encoded ones, untouched by the client', h.sends[1].data === V.calls.deposit.data)
  ok('④e every tx is sent `from` the connected account (the address the voucher digest is bound to)',
    h.sends.every(s => s.from === BUYER_ADDR.toLowerCase()))
}

// ── ⑤ 余额不足 → 停下,不发任何 tx ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT - 1n, AMOUNT * 3n) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  const s = state(h)
  ok('⑤a insufficient balance → stops, ZERO transactions sent', s.step === 'insufficient' && h.sends.length === 0, JSON.stringify(s))
  ok('⑤b the shortfall is shown honestly (have / need / short)', s.msg.includes('还差') && s.msg.includes('0.000001'), s.msg)
  ok('⑤c the panel says plainly that nothing was sent', h.el.innerHTML.includes('未发出任何交易'))
}

// ── ⑥ deposit 已发出 → 等待态,且前端【零订单写】 ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT * 3n) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  const s = state(h)
  ok('⑥a after broadcast → "waiting for on-chain confirmation", tx hash retained', s.step === 'waiting' && /^0x[0-9a-f]{64}$/.test(s.txHash), JSON.stringify(s))
  ok('⑥b D2: the ONLY endpoints the module ever touches are /usdc-escrow/{voucher,status} — zero order-state writes',
    h.apiLog.length > 0 && h.apiLog.every(l => /^(GET \/orders\/[^/]+\/usdc-escrow\/status|POST \/orders\/[^/]+\/usdc-escrow\/voucher)/.test(l)), JSON.stringify(h.apiLog))
  ok('⑥c the waiting copy is honest about who advances the order (chain events, ~1–2 minutes) and never claims "paid"',
    h.el.innerHTML.includes('等待链上确认') && h.el.innerHTML.includes('订单状态由链上事件驱动') && !h.el.innerHTML.includes('已付款'), h.el.innerHTML.slice(0, 300))
  ok('⑥d D4: the tx hash is persisted so a re-entry cannot double-deposit', h.store['webaz_usdc_deposit_o_pay'] === s.txHash, JSON.stringify(h.store))
  ok('⑥e the waiting panel warns that an order can only be funded once (a duplicate deposit reverts and burns gas)', h.el.innerHTML.includes('只能存入一次'))
  // 轮询驱动:status 变为 deposited_seen → 前端进"已确认"态(仍然只是【读】)
  const h2 = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT * 3n) }, statusSeq: [STATUS_UNPAID, { ...stFunded.json }], voucher: V })
  await h2.win.usdcEscrowHydrate(ORDER, true)
  await h2.win.usdcPayAdvance()
  await h2.flush(2)
  ok('⑥f the watcher-mirrored status (deposited_seen) is what flips the UI to confirmed — nothing client-side does',
    state(h2).step === 'deposited' && h2.store['webaz_usdc_deposit_o_pay'] === undefined && h2.sends.length === 1, JSON.stringify(state(h2)))
}

// ── ⑦ 重进页面(localStorage 有 txHash)→ 直接等待态,按钮禁用,不重复发 tx ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT * 3n) }, status: STATUS_UNPAID, voucher: V, store: { webaz_usdc_deposit_o_pay: '0x' + 'e'.repeat(64) } })
  await h.win.usdcEscrowHydrate(ORDER, true)
  ok('⑦a re-entry with a pending tx hash → straight to the waiting state', state(h).step === 'waiting' && state(h).txHash === '0x' + 'e'.repeat(64), JSON.stringify(state(h)))
  ok('⑦b the primary button is rendered DISABLED (no onclick handler at all)',
    /<button[^>]*disabled[^>]*>/.test(h.el.innerHTML) && !/onclick="usdcPayAdvance\(\)"/.test(h.el.innerHTML), h.el.innerHTML.slice(-300))
  await h.win.usdcPayAdvance()
  ok('⑦c calling the advance driver anyway is a no-op — no wallet call, no duplicate deposit',
    h.sends.length === 0 && h.methods.length === 0, `${h.sends.length} sends / ${h.methods.join(',')}`)
}

// ── ⑧ accountsChanged → voucher 作废 + 回到连接步 ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT - 1n, 0n) }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()          // 余额不足停在 insufficient,但 voucher 已到手
  ok('⑧a precondition: a voucher is cached', state(h).hasVoucher === true)
  h.fire('accountsChanged', ['0x' + '7'.repeat(40)])
  const s = state(h)
  ok('⑧b accountsChanged → cached voucher voided and the stepper is back at step 1',
    s.hasVoucher === false && s.addr === null && s.step === 'intro', JSON.stringify(s))
  ok('⑧c the user is told why (the digest is bound to the buyer address → a new authorization is required)',
    s.msg.includes('钱包账户变更') && s.msg.includes('重新获取'), s.msg)
  h.fire('chainChanged', '0x1')
  ok('⑧d chainChanged does the same', state(h).msg.includes('钱包网络变更'))
}

// ── ⑨ voucher 过期 → 自动重取一次;再过期才报错 ──
const expiredVoucher = (base: any, deltaSec: number): any => ({ ...base, deposit_call: { ...base.deposit_call, auth_expires_at: Math.floor(Date.now() / 1000) + deltaSec } })
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT * 3n) }, status: STATUS_UNPAID, voucherSeq: [expiredVoucher(V, -5), V] })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  const s = state(h)
  ok('⑨a expired voucher → re-fetched exactly once, then the deposit goes out',
    s.reissued === true && s.step === 'waiting' && h.apiLog.filter(l => l.startsWith('POST')).length === 2 && h.sends.length === 1, JSON.stringify(h.apiLog))
}
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT * 3n) }, status: STATUS_UNPAID, voucherSeq: [expiredVoucher(V, -5), expiredVoucher(V, -5)] })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  const s = state(h)
  ok('⑨b still expired after the single retry → honest error, and NO transaction is sent with a dead voucher',
    s.step === 'error' && s.msg.includes('重新获取后仍然过期') && h.sends.length === 0 && h.apiLog.filter(l => l.startsWith('POST')).length === 2, JSON.stringify(s))
}

// ── ⑨' A2: approve 回执失败 / 超时 → 停下,绝不发 deposit(钱/gas 安全,此前该守卫零覆盖)──
{
  // allowance < amount(需 approve)+ approve tx 回执 status=0x0(链上 revert)→ 不发 deposit
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT - 1n), receipt: { status: '0x0' } }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  const s = state(h)
  ok("⑨'a A2: approve REVERTS on-chain (receipt 0x0) → error state, and the deposit is NEVER sent (exactly ONE tx, and it is the approve)",
    s.step === 'error' && h.sends.length === 1 && h.sends[0].to === TOKEN, JSON.stringify({ step: s.step, sends: h.sends.length, tos: h.sends.map(x => x.to) }))
  ok("⑨'b A2: the copy says plainly the approval did not succeed on-chain and no deposit went out",
    s.kind === 'error' && s.msg.includes('授权交易未能在链上成功'), s.msg)
}
{
  // approve tx 回执一直 null(未上链)→ waitReceipt 45 次轮询后 RECEIPT_TIMEOUT → 不发 deposit
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK, callResults: reads(AMOUNT * 3n, AMOUNT - 1n), receipt: null }, status: STATUS_UNPAID, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  const p = h.win.usdcPayAdvance()   // 不 await:waitReceipt 的 sleep 走 harness 的 fake timer,需 flush 驱动
  await h.flush(60)                   // 驱动 ≥45 次回执轮询直到 RECEIPT_TIMEOUT
  await p
  const s = state(h)
  ok("⑨'c A2: approve receipt never arrives (timeout) → error state, deposit NEVER sent (only the approve tx)",
    s.step === 'error' && h.sends.length === 1 && h.sends[0].to === TOKEN, JSON.stringify({ step: s.step, sends: h.sends.length, tos: h.sends.map(x => x.to) }))
}

// ── ⑩ 释放 / 争议面 ──
const relStatus = (over: Record<string, unknown> = {}): any => ({ ...stFunded.json, ...over })
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: relStatus() })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'delivered' }, true)
  const html = h.el.innerHTML
  ok('⑩a delivered + Funded → the on-chain release button is offered', html.includes('确认收货并放款(链上)') && html.includes('onclick="usdcEscrowRelease()"'), html.slice(0, 200))
  ok('⑩b the dispute button says what it DOES (freeze the auto-release), not "get a refund"', html.includes('冻结自动放款(链上争议)'))
  ok('⑩c B7 HONESTY LOCK: the dispute copy states the on-chain ruling capability is still being wired and produces NO ruling today',
    html.includes('仍在接线中') && html.includes('不会产生任何裁决结果'), html.slice(html.indexOf('冻结自动放款'), html.indexOf('冻结自动放款') + 400))
  ok('⑩d B7 HONESTY LOCK (negative): the release face never promises a refund / ruling / arbitration outcome',
    !/会退款|将退款|可以裁决|平台将裁定|保证退款/.test(html), html.slice(0, 400))
  ok('⑩e auto-release disclosure: ANYONE may trigger it after the deadline, and the buyer can no longer dispute from that moment',
    html.includes('任何人') && html.includes('不能再发起链上争议'))
  ok('⑩f the cross-check panel repeats amount / contract / seller / fee on the same screen as the wallet popup',
    html.includes('担保合约') && html.includes('卖家收款地址') && html.includes('平台费率') && html.includes(String(SELLER_PAYOUT)))
  ok("⑩f' A3: the deposit account is surfaced on the release face so the user knows which wallet to connect",
    html.includes('你的存款地址') && html.includes(String(BUYER_ADDR)))
  ok("⑩f'' A3: the release face carries the same gas disclosure as the deposit face (buyer pays Base gas, platform does not)",
    html.includes('Base 网络 gas') && html.includes('平台不代付'), html.slice(html.indexOf('⛽'), html.indexOf('⛽') + 200))
}
// ── ⑩' A3: release/dispute 存款账户校验(多账户钱包 gas 陷阱)──
{
  const OTHER = '0x' + '8'.repeat(40)   // 连接了一个【非存款】账户
  const h = harness({ cfg: { account: OTHER, chainIdHex: CHAIN_OK }, status: relStatus() })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'delivered' }, true)
  await h.win.usdcEscrowRelease()
  const rs = h.win._usdcReleaseState()
  ok("⑩'a A3: connected account != deposit account → release BLOCKED before any tx (no NotBuyer revert, no wasted gas)",
    h.sends.length === 0 && rs.pendingKind === null && rs.kind === 'error' && rs.msg.includes('与存款账户不一致'), JSON.stringify({ sends: h.sends.length, kind: rs.kind, msg: rs.msg }))
  await h.win.usdcEscrowDispute()
  ok("⑩'b A3: the same guard blocks flagDispute from the wrong account (still zero transactions)",
    h.sends.length === 0 && h.win._usdcReleaseState().msg.includes('与存款账户不一致'), String(h.sends.length))
}
{
  // 反证:账户一致 → 守卫放行,正常发一笔(证明 ⑩'a 的拦截来自账户比对,不是写死失败)
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, statusSeq: [relStatus(), relStatus({ released_seen: true, calls: undefined })] })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'delivered' }, true)
  await h.win.usdcEscrowRelease()
  ok("⑩'c A3 COUNTER-PROOF: connected == deposit account → release proceeds, exactly one backend-encoded tx",
    h.sends.length === 1 && h.sends[0].data === stFunded.json.calls.release.data, JSON.stringify(h.sends))
}
{
  // exclusive:auto_release_at == now → 到期分支,不渲染争议入口
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: relStatus({ auto_release_at: Math.floor(Date.now() / 1000), calls: { release: stFunded.json.calls.release } }) })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'delivered' }, true)
  ok('⑩g EXCLUSIVE: at t == auto_release_at the window is shown as PASSED and no dispute entry is rendered',
    h.el.innerHTML.includes('自动放款窗口已到期') && !h.el.innerHTML.includes('冻结自动放款(链上争议)'), h.el.innerHTML.slice(0, 300))
}
{
  // 安全余量:距到期 5 分钟(< 10 分钟余量)→ 前端比合约更严,提前收起争议入口
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: relStatus({ auto_release_at: Math.floor(Date.now() / 1000) + 300 }) })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'delivered' }, true)
  ok('⑩h SAFETY MARGIN: within 10 minutes of the deadline the dispute entry is withdrawn early (same-block races on Base)',
    !h.el.innerHTML.includes('冻结自动放款(链上争议)') && h.el.innerHTML.includes('自动放款'), h.el.innerHTML.slice(0, 200))
}
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, statusSeq: [relStatus(), relStatus({ released_seen: true, calls: undefined })] })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'delivered' }, true)
  await h.win.usdcEscrowRelease()
  ok('⑩i release → exactly one tx, carrying the backend-encoded buyerRelease calldata',
    h.sends.length === 1 && h.sends[0].data === stFunded.json.calls.release.data && h.sends[0].to === CONTRACT, JSON.stringify(h.sends))
  ok('⑩j D2 on the release path too: waiting-for-confirmation, and only /usdc-escrow/status is ever polled',
    h.win._usdcReleaseState().pendingKind === 'release' && h.el.innerHTML.includes('等待链上确认放款')
    && h.apiLog.every(l => /^GET \/orders\/[^/]+\/usdc-escrow\/status/.test(l)), JSON.stringify(h.apiLog))
  await h.flush(2)
  ok('⑩k the mirrored Released event is what closes the loop', h.el.innerHTML.includes('链上已放款'), h.el.innerHTML.slice(0, 200))
}
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: relStatus() })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'shipped' }, true)
  await h.win.usdcEscrowDispute()
  ok('⑩l dispute → exactly one tx with the backend-encoded flagDispute calldata',
    h.sends.length === 1 && h.sends[0].data === stFunded.json.calls.flag_dispute.data, JSON.stringify(h.sends))
  ok('⑩m not delivered yet → no release button, and the copy explains release happens on-chain, not via an in-app action',
    !h.el.innerHTML.includes('onclick="usdcEscrowRelease()"'), h.el.innerHTML.slice(0, 200))
}
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: { ...stDis.json } })
  await h.win.usdcEscrowHydrate({ ...ORDER, status: 'shipped' }, true)
  ok('⑩n already Disputed → frozen panel, no buttons, and still no promise of a ruling',
    h.el.innerHTML.includes('链上已冻结(争议中)') && h.el.innerHTML.includes('仍在接线中') && !h.el.innerHTML.includes('<button'), h.el.innerHTML.slice(0, 300))
}

// ── ⑪ 后端 usdc_token 为 null → 不显示存入按钮,fail-visible ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: STATUS_UNPAID, voucher: vNo.json })
  await h.win.usdcEscrowHydrate(ORDER, true)
  await h.win.usdcPayAdvance()
  ok('⑪a voucher without calls → fail-visible "on-chain configuration incomplete", zero transactions',
    state(h).step === 'unconfigured' && h.sends.length === 0 && h.el.innerHTML.includes('链上配置未完成'), JSON.stringify(state(h)))
  ok('⑪b no deposit button is offered and the user is told NOT to transfer manually',
    !h.el.innerHTML.includes('onclick="usdcPayAdvance()"') && h.el.innerHTML.includes('不要手动向任何地址转账'), h.el.innerHTML.slice(0, 300))
}
// 非本轨 / 非买家 → 容器与 hydrate 都 fail-closed
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: STATUS_UNPAID, voucher: V })
  ok('⑪c container is rail-gated + buyer-gated', h.win.usdcEscrowOrderCard({ ...ORDER, payment_rail: 'direct_p2p' }, true) === ''
    && h.win.usdcEscrowOrderCard(ORDER, false) === '' && h.win.usdcEscrowOrderCard(ORDER, true).includes('id="usdc-escrow-card"'))
  await h.win.usdcEscrowHydrate({ ...ORDER, payment_rail: 'escrow' }, true)
  ok('⑪d hydrate on a foreign rail touches nothing', h.apiLog.length === 0 && h.el.innerHTML === '')
}
// 已入金的单绝不再渲染存入 stepper —— 即使释放面模块缺席也 fail-closed(渲染 stepper = 诱导重复存入)
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: relStatus() })
  h.win.usdcEscrowReleaseRender = undefined
  await h.win.usdcEscrowHydrate(ORDER, true)
  ok('⑪f already funded + release module missing → read-only "already in the contract" note, NOT a deposit stepper',
    h.el.innerHTML.includes('已在链上担保合约中') && !h.el.innerHTML.includes('onclick="usdcPayAdvance()"') && state(h) === null, h.el.innerHTML.slice(0, 200))
  const h2 = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: { ...STATUS_UNPAID, intent_status: 'funded' } })
  h2.win.usdcEscrowReleaseRender = undefined
  await h2.win.usdcEscrowHydrate(ORDER, true)
  ok('⑪g intent_status=funded with the mirror lagging → same fail-closed note (belt and braces against a double deposit)',
    h2.el.innerHTML.includes('请勿重复存入') && !h2.el.innerHTML.includes('onclick="usdcPayAdvance()"'), h2.el.innerHTML.slice(0, 200))
}
// 状态读不到 → 诚实降级(绝不假装"未存入"而诱导重复存入)
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: undefined, voucher: V })
  await h.win.usdcEscrowHydrate(ORDER, true)
  ok('⑪e status read failure → honest degraded card, no stepper, no buttons',
    h.el.innerHTML.includes('暂时无法读取链上担保状态') && !h.el.innerHTML.includes('<button'), h.el.innerHTML.slice(0, 200))
}

// ── EIP-1193 层单元锁:BigInt 解析 / 地址归一 / 单位换算 ──
{
  const h = harness({ cfg: { account: BUYER_ADDR.toLowerCase(), chainIdHex: CHAIN_OK }, status: STATUS_UNPAID, voucher: V })
  const big = h.win.webazHexToBigInt(hex32(2n ** 64n + 7n))
  ok('⑫a hex → BigInt exactly (values past 2^53 must not be parsed through Number/parseInt)', big === 2n ** 64n + 7n, String(big))
  ok('⑫b malformed hex → null, never a silent 0 or NaN', h.win.webazHexToBigInt('0xzz') === null && h.win.webazHexToBigInt('') === null && h.win.webazHexToBigInt(undefined) === null)
  ok('⑫c 6dp units → text is pure integer arithmetic', h.win.webazUnits6ToText(10000000n) === '10' && h.win.webazUnits6ToText(1n) === '0.000001' && h.win.webazUnits6ToText(1234567n) === '1.234567')
  ok('⑫d address normalisation is validate-or-null (no invented checksums)',
    h.win.webazWalletNormAddr(BUYER_ADDR) === BUYER_ADDR.toLowerCase() && h.win.webazWalletNormAddr('0x1234') === null)
  ok('⑫e explorer links are only built for well-formed tx hashes', h.win.webazWalletExplorerTx(84532, '0x' + '1'.repeat(64)).includes('/tx/0x') && h.win.webazWalletExplorerTx(84532, 'junk') === '')
}

// ══════════════════════════════════════════════════════════════════════════════
// PART 4 — 源码锁 + 接线(缺一即假绿)
// ══════════════════════════════════════════════════════════════════════════════
const SRC = Object.fromEntries(FILES.map(f => [f, src(f)]))
// 负向断言一律扫【去注释视图】—— 这些文件的诚实注释里逐字写着我们禁止的那些词(“无 fetch/XHR/import()/eval”),
//   直接扫原文会把注释本身判成违规(与 test-direct-pay-ui.ts 的 DPCODE 同一惯例)。
const CODE = Object.fromEntries(FILES.map(f => [f, SRC[f].replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')]))
for (const f of FILES) {
  const s = CODE[f]
  ok(`⑬ [${f}] zero outbound requests: no fetch/XHR/dynamic import/script injection`,
    !/\bfetch\s*\(/.test(s) && !/XMLHttpRequest|EventSource|WebSocket|sendBeacon|navigator\.connection/.test(s) && !/\bimport\s*\(/.test(s) && !/createElement\(\s*['"]script/.test(s))
  ok(`⑬ [${f}] no eval / Function constructor`, !/\beval\s*\(/.test(s) && !/new\s+Function\s*\(/.test(s))
  ok(`⑬ [${f}] no hand-rolled ABI encoding or crypto in the PWA (calldata is backend-only)`,
    !/keccak|sha3|abi\.encode|\.padStart\(64/i.test(s))
}
// 唯一允许出现的外部 URL:wallet_addEthereumChain 的链参数(由钱包自己去连,页面永不请求)
{
  const allow = new Set(['https://mainnet.base.org', 'https://sepolia.base.org', 'https://basescan.org', 'https://sepolia.basescan.org'])
  const found = FILES.flatMap(f => [...SRC[f].matchAll(/https?:\/\/[^'"\s)]+/g)].map(m => ({ f, u: m[0] })))
  ok('⑬ the only URLs in the whole module are the four hardcoded Base chain params, and they live ONLY in the wallet layer',
    found.every(x => allow.has(x.u) && x.f === 'app-usdc-wallet.js'), JSON.stringify(found))
  ok('⑬ window.ethereum is touched in exactly ONE file (the EIP-1193 base layer)',
    /window\.ethereum/.test(SRC['app-usdc-wallet.js']) && !/window\.ethereum/.test(SRC['app-usdc-escrow-pay.js']) && !/window\.ethereum/.test(SRC['app-usdc-escrow-release.js']))
  ok('⑬ no module ever writes order state (no order action/confirm/paid endpoint anywhere)',
    FILES.every(f => !/\/action|confirm-in-person|mark_paid|status\s*=\s*'paid'/.test(CODE[f])))
}
// 接线四处
{
  const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
  const iW = HTML.indexOf('/app-usdc-wallet.js'), iP = HTML.indexOf('/app-usdc-escrow-pay.js'), iR = HTML.indexOf('/app-usdc-escrow-release.js'), iApp = HTML.indexOf('/app.js"')
  ok('⑭a index.html loads all three, wallet layer FIRST, pay before release, all before app.js', iW > 0 && iW < iP && iP < iR && iR < iApp, `${iW}/${iP}/${iR}/${iApp}`)
  const APP = readFileSync('src/pwa/public/app.js', 'utf8')
  ok('⑭b app.js renders the container and calls the hydrate (both fail-open on a missing module)',
    /window\.usdcEscrowOrderCard \? window\.usdcEscrowOrderCard\(order, isBuyer\)/.test(APP) && /if \(window\.usdcEscrowHydrate\) window\.usdcEscrowHydrate\(order, isBuyer\)/.test(APP))
  const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')
  ok('⑭c all three files are registered in the complexity ratchet', FILES.every(f => RATCHET.includes(`src/pwa/public/${f}`)))
  const PKG = readFileSync('package.json', 'utf8')
  ok('⑭d all three files are in check:pwa-syntax', FILES.every(f => PKG.includes(`node --check src/pwa/public/${f}`)))
  ok('⑭e this test is wired into package.json AND ci.yml', PKG.includes('"test:usdc-escrow-wallet-ui"') && readFileSync('.github/workflows/ci.yml', 'utf8').includes('npm run test:usdc-escrow-wallet-ui'))
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('⑭f the load-bearing honesty strings have EN parity',
    I18N.includes("'有问题,冻结自动放款(链上争议)':") && /still being wired up/.test(I18N) && /ANYONE on-chain/.test(I18N))
}

if (fail > 0) { console.error(`\n❌ usdc-escrow-wallet-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow wallet UI: backend-encoded calldata (exact-amount approve, buyer-only release/dispute, exclusive auto-release boundary) + a real-provider stepper that never fakes success, never double-deposits, and never promises the unwired on-chain ruling\n  ✅ pass ${pass}`)
