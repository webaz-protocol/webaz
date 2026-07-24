/**
 * USDC 链上合约担保(B 线)PR-B4 — 链上事件 watcher(镜像 + Deposited 驱动 created→paid)。
 *
 * 对应合约 contracts/WebazEscrow.sol(#518)。设计决策:
 *   - 镜像 = 链上真相:任何 watcher 见到的事件先落 usdc_escrow_chain_events(append-only),
 *     订单状态推进只是镜像之上的【衍生】,绝不本末倒置(镜像失败/幂等重复都不该挡应用)。
 *   - 绝不假 success:未过 CONFIRMATIONS 深度的事件本 tick 不可见;transition 失败必须
 *     alertAdmins,绝不吞掉——真钱在链上、订单卡在 created,人不知道 = 事故。
 *   - 重组只标记不反转:CONFIRMATIONS=12 深度的 Base 重组本身已是事故级小概率事件;若还要
 *     自动做反向资金转移(退单/回补库存/撤销 paid),错一次的代价远高于停下来等人工——所以
 *     重组一律走 usdc_escrow_event_orphans 标记 + alertAdmins,orders 表状态一律不碰,留给
 *     人工核对链上真实状态后手动处置(与 usdc-escrow-timeouts.ts 的"清扫只做该轨确定该做的
 *     一件事"同一克制哲学)。重组后原镜像行被标孤儿,而重打包出的替换 log(同 tx+logIndex、
 *     新 block_hash)会经正常 mirrorEvent 路径落成【新一行】—— chain_events 三键
 *     UNIQUE(tx_hash,log_index,block_hash) 不再挡它(B4 审计:二键会永久拒收替换行)。
 *   - vanish 疑似必须经 getBlock 佐证,防 RPC 抖动误孤儿:存量镜像行在 refetch 里"消失"有两种
 *     成因——真重组(该高度换了区块),或 flaky/滞后 RPC 节点返回了不完整的 getLogs(常见得多)。
 *     孤儿标记 append-only 且不可逆(下游结算读排除孤儿),据一次可能残缺的 getLogs 就永久孤儿一条
 *     有效行是纯误报。所以 vanish 分支必先 client.getBlock(该高度) 佐证:getBlock 抛错=无法定论,
 *     跳过等下 tick 重查;canonical hash 仍等于 row.block_hash=区块还在链上、只是 getLogs 抖动,跳过;
 *     仅当 canonical hash 与 row.block_hash 不同才是真重组,才标孤儿 + 告警。block_hash_mismatch
 *     分支不需佐证:同一次自洽 getLogs 里 (tx,logIndex) 命中却 blockHash 变了,本身就是重组实证。
 *   - 金额/费率全程 BigInt 比较,绝不 Number() —— 6dp units 的 1 unit 误差就是钱。
 *
 * 范围边界(刻意不做,留后续 PR):
 *   - Released:B5 已接线 —— 镜像后调 applyUsdcEscrowRelease 收敛状态 + 纯记账镜像(零 wallets 写)。
 *   - Resolved:B7 才接(链上仲裁裁决消费);现阶段镜像 + alertAdmins(arbiter key 系统外使用=事故级)。
 *   - Disputed 只镜像 + alertAdmins,链上仲裁裁决消费是 PR-B7。
 */
import type Database from 'better-sqlite3'
import { createPublicClient, http, parseAbiItem } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { alertUsdcAdmins, applyUsdcEscrowRelease } from '../../usdc-escrow-settle.js'
import type { UsdcSettleDeps } from '../../usdc-escrow-settle.js'

// ─── 可调参数(导出,便于测试引用/覆盖)─────────────────────────
export const CONFIRMATIONS = 12n
export const REORG_BUFFER = 64n
export const MAX_RANGE = 1900n            // Base Sepolia RPC 单次 getLogs 限 2000 块(见 server.ts 同款 clamp 先例)
export const MAX_RANGES_PER_TICK = 10
export const TICK_MS = 60_000

// ─── 依赖注入接口 ────────────────────────────────────────────
export interface WatcherLog {
  eventName: string                    // 'Deposited' | 'Released' | 'Disputed' | 'Resolved'
  args: Record<string, unknown>        // bigint/address 原样(测试注入 fixture 时用真 bigint)
  transactionHash: string
  logIndex: number
  blockNumber: bigint
  blockHash: string
}

export interface WatcherChainClient {
  getBlockNumber(): Promise<bigint>
  getLogs(args: { address: `0x${string}`; events: unknown[]; fromBlock: bigint; toBlock: bigint }): Promise<WatcherLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: string }>
}

export interface WatcherDeps {
  db: Database.Database
  transition: (db: Database.Database, orderId: string, to: 'paid' | 'confirmed' | 'completed', actorId: string, evidence: string[], note: string) => { success: boolean; error?: string }
  settleOrder: (orderId: string) => void   // B5:Released 收口调 server.ts settleOrder(usdc 分支=记账镜像)
  generateId: (p: string) => string
  contractAddress: string
  notifyTransition?: (db: Database.Database, orderId: string, from: string, to: string) => void   // B6a:created→paid 消费(可选;缺省不发通知)
  client?: WatcherChainClient          // 测试注入;缺省用 viem createPublicClient(env BASE_RPC_URL + NETWORK)
  confirmations?: bigint
  reorgBuffer?: bigint                 // 测试可覆盖;生产用模块常量
  log?: (msg: string) => void          // 缺省 console.log
}

interface ChainEventRow {
  id: string; order_key: string; event_name: string; tx_hash: string
  log_index: number; block_number: number; block_hash: string
}
interface IntentRow {
  order_id: string; order_key: string; contract_addr: string; buyer_id: string; seller_id: string
  seller_addr: string; amount_units: number; fee_bps: number; status: string
}

// 四个事件的 ABI 项,逐字对齐 contracts/WebazEscrow.sol(注意 Released 的 bool 参数名 auto_)
const DEPOSITED_EVENT = parseAbiItem('event Deposited(bytes32 indexed orderKey, address indexed buyer, address indexed seller, uint256 amount, uint256 feeBps, uint64 autoReleaseAt)')
const RELEASED_EVENT = parseAbiItem('event Released(bytes32 indexed orderKey, bool auto_, uint256 sellerPaid, uint256 feePaid)')
const DISPUTED_EVENT = parseAbiItem('event Disputed(bytes32 indexed orderKey, address indexed by)')
const RESOLVED_EVENT = parseAbiItem('event Resolved(bytes32 indexed orderKey, uint256 buyerRefund, uint256 sellerPaid, uint256 feePaid)')
const WATCHER_EVENTS = [DEPOSITED_EVENT, RELEASED_EVENT, DISPUTED_EVENT, RESOLVED_EVENT]

/** 真实 viem client 包装(生产缺省路径;测试永远走 deps.client 注入,零网络)。 */
function buildDefaultClient(): WatcherChainClient {
  const NETWORK = (process.env.NETWORK || 'testnet').toLowerCase()
  const chain = NETWORK === 'mainnet' ? base : baseSepolia
  const rpcRaw = process.env.BASE_RPC_URL ?? (NETWORK === 'mainnet' ? 'mainnet.base.org' : 'sepolia.base.org')
  const rpcUrl = rpcRaw.startsWith('http') ? rpcRaw : `https://${rpcRaw}`
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  return {
    async getBlockNumber(): Promise<bigint> {
      return publicClient.getBlockNumber()
    },
    async getLogs({ address, events, fromBlock, toBlock }): Promise<WatcherLog[]> {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const logs = await publicClient.getLogs({ address, events: events as any, fromBlock, toBlock }) as any[]
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return logs.map(l => ({
        eventName: String(l.eventName),
        args: l.args as Record<string, unknown>,
        transactionHash: String(l.transactionHash).toLowerCase(),
        logIndex: Number(l.logIndex),
        blockNumber: BigInt(l.blockNumber),
        blockHash: String(l.blockHash).toLowerCase(),
      }))
    },
    async getBlock({ blockNumber }): Promise<{ hash: string }> {
      const block = await publicClient.getBlock({ blockNumber })
      return { hash: String(block.hash).toLowerCase() }
    },
  }
}

/** 全体 admin 告警:复用 usdc-escrow-settle 的 alertUsdcAdmins(B5 抽出,消除重复实现)。 */
function alertAdmins(deps: WatcherDeps, title: string, body: string): void {
  alertUsdcAdmins(deps.db, deps.generateId, title, body)
}

/** 镜像一条链上事件到 usdc_escrow_chain_events(append-only,INSERT OR IGNORE 天然幂等)。 */
function mirrorEvent(deps: WatcherDeps, orderKey: string, l: WatcherLog): void {
  try {
    deps.db.prepare(`
      INSERT OR IGNORE INTO usdc_escrow_chain_events
        (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      deps.generateId('uce'), orderKey, l.eventName,
      l.transactionHash.toLowerCase(), l.logIndex, Number(l.blockNumber), l.blockHash.toLowerCase(),
      JSON.stringify(l.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    )
  } catch (e) {
    console.error('[usdc-escrow watcher] mirror insert failed:', (e as Error).message)
  }
}

/**
 * 重组检测(对 [fromBlock, toBlock] 窗口内、尚未被标记孤儿的存量镜像行):
 * 在本次 refetch 的 logs 里按 (tx_hash, log_index) 查找 —— block_hash 变了(同 tx/log 位置
 * 换了区块)是自洽 getLogs 里的重组实证,直接标孤儿 + 告警;而"找不到"(事件从链上消失)只是
 * 疑似,须先 client.getBlock(该高度) 佐证 canonical hash 才可定论(见模块头:防 RPC 抖动误孤儿)。
 * 绝不改动/反转任何订单状态(模块头设计决策)。
 */
async function detectReorgs(deps: WatcherDeps, client: WatcherChainClient, fromBlock: bigint, toBlock: bigint, logs: WatcherLog[]): Promise<void> {
  const existing = deps.db.prepare(`
    SELECT ce.id, ce.order_key, ce.event_name, ce.tx_hash, ce.log_index, ce.block_number, ce.block_hash
    FROM usdc_escrow_chain_events ce
    LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id
    WHERE o.event_id IS NULL AND ce.block_number BETWEEN ? AND ?
  `).all(Number(fromBlock), Number(toBlock)) as ChainEventRow[]
  if (existing.length === 0) return

  const byKey = new Map<string, WatcherLog>()
  for (const l of logs) byKey.set(`${l.transactionHash.toLowerCase()}:${l.logIndex}`, l)

  const orphan = (row: ChainEventRow, reason: string, bodyTail: string): void => {
    try {
      deps.db.prepare('INSERT OR IGNORE INTO usdc_escrow_event_orphans (event_id, reason) VALUES (?, ?)').run(row.id, reason)
    } catch { /* 已标记过(理论不该发生,双保险) */ }
    alertAdmins(
      deps,
      '🚨 USDC 担保:检测到链上重组',
      `事件 ${row.id}(order_key ${row.order_key}, event ${row.event_name}, tx ${row.tx_hash}#${row.log_index})` +
      bodyTail +
      ' —— 已标记孤儿(usdc_escrow_event_orphans),不做任何订单状态反转,请人工核对链上真实状态。',
    )
  }

  for (const row of existing) {
    const match = byKey.get(`${row.tx_hash.toLowerCase()}:${row.log_index}`)
    if (match && match.blockHash.toLowerCase() === row.block_hash.toLowerCase()) continue // 正常,未重组

    if (match) {
      // block_hash 变了:同一次自洽 getLogs 内 (tx,logIndex) 命中却换了区块 —— 重组实证,直接孤儿。
      // 老行在此标孤儿;match 这条替换 log 随后由本 tick 的 processLog 循环(detectReorgs 之后)经
      // mirrorEvent 落成【新一行】—— 同 tx+logIndex、新 block_hash → chain_events 三键 UNIQUE 不阻拦
      // (B4:二键会永久拒收替换行,镜像只剩孤儿老行)。读侧对账排除孤儿、取 canonical 新行。
      orphan(row, `reorg:block_hash_mismatch:${match.blockHash.toLowerCase()}`, ` 所在区块已变为 ${match.blockHash}`)
      continue
    }

    // 事件消失:疑似重组,但也可能是 flaky/滞后 RPC 的残缺 getLogs —— 必须 getBlock 佐证后才定论。
    let canonicalHash: string
    try {
      const block = await client.getBlock({ blockNumber: BigInt(row.block_number) })
      canonicalHash = String(block.hash).toLowerCase()
    } catch {
      console.warn(`[usdc-escrow watcher] vanish suspicion for ${row.id} but getBlock failed — skipping, will re-check next tick`)
      continue // 无法定论:不孤儿、不告警,下 tick 重查
    }
    if (canonicalHash === row.block_hash.toLowerCase()) {
      // 区块仍在链上、hash 未变 —— 只是本次 getLogs 抖动漏返,绝非重组:跳过,不孤儿、不告警。
      console.warn(`[usdc-escrow watcher] log for ${row.id} absent from refetch but block ${row.block_number} still canonical (${canonicalHash}) — RPC flake, skipping (no orphan)`)
      continue
    }
    // canonical hash 与镜像行不同 —— 真重组:该高度换了区块,原事件确已不在链上。
    orphan(row, `reorg:log_vanished:${canonicalHash}`, ` 已从链上消失(该高度 ${row.block_number} 的 canonical 区块现为 ${canonicalHash},与镜像行 ${row.block_hash} 不符)`)
  }
}

/**
 * 死单存入(订单已 cancelled 收到链上存入)买家+卖家通知:直接 INSERT notifications(带 order_id),
 * 按 (user_id, order_id, type) 去重(watcher rescan 窗口内会重复驱动 applyDeposited)。双语 template_key
 * (app-notif-templates-usdc-escrow.js);honest 中文回退。通知失败绝不阻断,由外层 try/catch 包住。
 */
function notifyDeadDeposit(deps: WatcherDeps, o: { orderId: string; buyerId: string | null; sellerId: string | null }): void {
  const ins = (uid: string | null, title: string, body: string, key: string): void => {
    if (!uid) return
    const exists = deps.db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND order_id = ? AND type = ? LIMIT 1').get(uid, o.orderId, 'usdc_dead_deposit')
    if (exists) return
    deps.db.prepare('INSERT INTO notifications (id, user_id, order_id, type, title, body, template_key, params) VALUES (?,?,?,?,?,?,?,?)')
      .run(deps.generateId('ntf'), uid, o.orderId, 'usdc_dead_deposit', title, body, key, JSON.stringify({}))
  }
  ins(o.buyerId, '⚠️ 资金已入合约但订单已取消', '你的 USDC 已进入链上担保合约,但该订单已取消。平台将协助你处理链上退款,请勿担心。', 'usdc_dead_deposit_buyer')
  ins(o.sellerId, '⚠️ 已取消订单收到链上存入,请勿发货', '一笔已取消订单收到了买家的链上存入。请勿发货;平台正在处理链上退款。', 'usdc_dead_deposit_seller')
}

/** Deposited 应用步:intents 核对 + created→paid(仅当参数与订单状态皆符合时)。单事务,失败绝不吞。 */
function applyDeposited(deps: WatcherDeps, orderKey: string, l: WatcherLog): void {
  const out = { paidOrderId: '' as string, deadDeposit: null as null | { orderId: string; buyerId: string | null; sellerId: string | null } }
  deps.db.transaction(() => {
    const intent = deps.db.prepare('SELECT * FROM usdc_escrow_intents WHERE order_key = ?').get(orderKey) as IntentRow | undefined
    if (!intent) {
      alertAdmins(deps, '🚨 USDC 担保:未知存款', `order_key ${orderKey} 收到链上存款(tx ${l.transactionHash})但无对应 intent —— amount ${String(l.args.amount)}。`)
      return
    }
    // B6a:作废凭证却收到存入(订单已取消/清扫作废后买家仍存入)—— 告警 + 不动订单(在参数核对前)。
    if (intent.status === 'void') {
      alertAdmins(deps, '🚨 USDC 担保:作废凭证却收到存入', `order_key ${orderKey}(order ${intent.order_id})intent 已 void(订单已取消)却收到链上存款,tx ${l.transactionHash} —— 不动订单,人工核链上退款。`)
      const ord = deps.db.prepare('SELECT status, buyer_id, seller_id FROM orders WHERE id = ?').get(intent.order_id) as { status: string; buyer_id: string | null; seller_id: string | null } | undefined
      if (ord && ord.status === 'cancelled') out.deadDeposit = { orderId: intent.order_id, buyerId: ord.buyer_id, sellerId: ord.seller_id }
      return
    }

    const argSeller = typeof l.args.seller === 'string' ? (l.args.seller as string).toLowerCase() : ''
    const sellerMatches = argSeller !== '' && argSeller === intent.seller_addr.toLowerCase()
    const amountMatches = l.args.amount !== undefined && BigInt(intent.amount_units) === BigInt(l.args.amount as bigint | number | string)
    const feeMatches = l.args.feeBps !== undefined && BigInt(intent.fee_bps) === BigInt(l.args.feeBps as bigint | number | string)
    const contractMatches = intent.contract_addr.toLowerCase() === deps.contractAddress.toLowerCase()
    if (!sellerMatches || !amountMatches || !feeMatches || !contractMatches) {
      alertAdmins(
        deps,
        '🚨 USDC 担保:存款参数不符',
        `order_key ${orderKey}(order ${intent.order_id})tx ${l.transactionHash} —— ` +
        `seller_match=${sellerMatches} amount_match=${amountMatches} fee_match=${feeMatches} contract_match=${contractMatches}`,
      )
      return
    }

    const order = deps.db.prepare('SELECT id, status, buyer_id, seller_id, payment_rail FROM orders WHERE id = ?').get(intent.order_id) as
      { id: string; status: string; buyer_id: string; seller_id: string | null; payment_rail: string } | undefined
    if (!order) {
      alertAdmins(deps, '🚨 USDC 担保:intent 无对应订单', `intent order_id ${intent.order_id}(order_key ${orderKey})查不到订单,tx ${l.transactionHash}。`)
      return
    }

    if (order.status === 'created') {
      const r = deps.transition(deps.db, order.id, 'paid', order.buyer_id, [], `链上存入已确认(tx ${l.transactionHash}, block ${l.blockNumber})`)
      if (r.success) {
        deps.db.prepare("UPDATE usdc_escrow_intents SET status = 'funded' WHERE order_id = ? AND status = 'issued'").run(order.id)
        // B6a(B5 审计接缝):存入确认后死线【顺延】—— 本轨付款窗内死线锚在建单会导致晚存入被停摆误报 +
        //   SLA 不诚实。各偏移与 usdc-escrow-create.ts 建单 addHours(48/120/168/336/408) 一致(付款钟从存入确认起)。
        const nowMs = Date.now(); const iso = (h: number): string => new Date(nowMs + h * 3600_000).toISOString()
        deps.db.prepare('UPDATE orders SET accept_deadline=?, ship_deadline=?, pickup_deadline=?, delivery_deadline=?, confirm_deadline=? WHERE id=?')
          .run(iso(48), iso(120), iso(168), iso(336), iso(408), order.id)
        out.paidOrderId = order.id
      } else {
        alertAdmins(deps, '🚨 USDC 担保:created→paid transition 失败', `order ${order.id}(order_key ${orderKey})tx ${l.transactionHash} —— ${r.error}`)
      }
    } else if (order.status === 'paid') {
      // 幂等补齐:订单已推进过(重扫/竞态),intent 状态可能还没跟上 —— 静默补,不告警
      deps.db.prepare("UPDATE usdc_escrow_intents SET status = 'funded' WHERE order_id = ? AND status = 'issued'").run(order.id)
    } else {
      alertAdmins(
        deps,
        `🚨 USDC 担保:订单已 ${order.status} 后收到存款`,
        `order ${order.id}(order_key ${orderKey})在 ${order.status} 状态收到链上存款 tx ${l.transactionHash} —— ` +
        '真钱已在链上而订单非 created/paid,须人工/PR-B7 处置(绝不自动反转)。',
      )
      if (order.status === 'cancelled') out.deadDeposit = { orderId: order.id, buyerId: order.buyer_id, sellerId: order.seller_id }
    }
  })()
  // 通知在钱路事务【提交后】发,try/catch 包住 —— 通知失败绝不回滚已确认的 created→paid / 死单标记。
  if (out.paidOrderId) { try { deps.notifyTransition?.(deps.db, out.paidOrderId, 'created', 'paid') } catch (e) { console.warn('[usdc-escrow watcher] paid notify failed:', (e as Error).message) } }
  if (out.deadDeposit) { try { notifyDeadDeposit(deps, out.deadDeposit) } catch (e) { console.warn('[usdc-escrow watcher] dead-deposit notify failed:', (e as Error).message) } }
}

/** 单条 log 的处理入口:先镜像(链上真相必须落盘),再按事件类型分发应用逻辑。 */
function processLog(deps: WatcherDeps, l: WatcherLog): void {
  const log = deps.log ?? ((msg: string) => console.log(msg))
  const orderKey = String(l.args.orderKey ?? '').toLowerCase()
  mirrorEvent(deps, orderKey, l)   // 镜像失败/重复(changes===0)都不挡下面的应用步 —— 应用逻辑自身幂等

  switch (l.eventName) {
    case 'Deposited':
      applyDeposited(deps, orderKey, l)
      break
    case 'Disputed':
      alertAdmins(deps, '🚨 USDC 担保:链上争议', `order_key ${orderKey} 发起链上争议(tx ${l.transactionHash})—— 链上仲裁裁决消费是 PR-B7,现阶段需人工知悉。`)
      break
    case 'Released':
      // B5:镜像后收敛状态 + 纯记账镜像(零 wallets 写)。payload 逐字序列化(bigint→string,与镜像同款)。
      applyUsdcEscrowRelease(
        deps.db,
        { transition: deps.transition as UsdcSettleDeps['transition'], settleOrder: deps.settleOrder, generateId: deps.generateId, notifyTransition: deps.notifyTransition },
        { order_key: orderKey, tx_hash: l.transactionHash.toLowerCase(), payload_json: JSON.stringify(l.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) },
        (t, b) => alertAdmins(deps, t, b),
      )
      break
    case 'Resolved':
      alertAdmins(deps, '🚨 USDC 担保:链上仲裁裁决', `order_key ${orderKey} 出现链上 Resolved(tx ${l.transactionHash})但 B7 未接线 —— arbiter key 在系统外被使用,立即人工核。`)
      break
    default:
      log(`[usdc-escrow watcher] unknown event ${l.eventName} mirrored, ignored`)
  }
}

/**
 * 单次扫描 tick(测试直接调它,零网络注入 deps.client)。
 * 冷启动只初始化游标到 safeHead,不扫历史(合约部署前没有事件);此后每 tick 最多追赶
 * MAX_RANGES_PER_TICK 段,每段带 REORG_BUFFER 回看窗口做重组检测。RPC 异常立即返回、
 * 不推进游标 —— 已提交的 DB 处理天然幂等,下次 tick 会重新覆盖同一窗口。
 */
export async function runWatcherTick(deps: WatcherDeps): Promise<{ scanned: boolean }> {
  const client = deps.client ?? buildDefaultClient()
  const confirmations = deps.confirmations ?? CONFIRMATIONS
  const reorgBuffer = deps.reorgBuffer ?? REORG_BUFFER

  let latest: bigint
  try {
    latest = await client.getBlockNumber()
  } catch (e) {
    console.error('[usdc-escrow watcher] getBlockNumber failed:', (e as Error).message)
    return { scanned: false }
  }
  const safeHead = latest - confirmations
  if (safeHead < 0n) return { scanned: false }

  const stateRow = deps.db.prepare("SELECT last_scanned_block FROM usdc_escrow_watcher_state WHERE id = 'main'").get() as { last_scanned_block: number } | undefined
  if (!stateRow || !stateRow.last_scanned_block) {
    let initCursor = safeHead
    const startEnv = process.env.USDC_ESCROW_START_BLOCK
    if (startEnv) {
      try {
        const startBlock = BigInt(startEnv)
        if (startBlock >= 0n && startBlock < safeHead) initCursor = startBlock
      } catch { /* 非法 env 值忽略,用 safeHead */ }
    }
    deps.db.prepare("INSERT OR REPLACE INTO usdc_escrow_watcher_state (id, last_scanned_block, updated_at) VALUES ('main', ?, datetime('now'))").run(Number(initCursor))
    return { scanned: false }   // 冷启动:不扫历史
  }

  let cursor = BigInt(stateRow.last_scanned_block)
  let scanned = false
  for (let i = 0; i < MAX_RANGES_PER_TICK; i++) {
    if (cursor >= safeHead) break
    let fromBlock = cursor + 1n - reorgBuffer
    if (fromBlock < 0n) fromBlock = 0n
    const toBlock = safeHead < cursor + MAX_RANGE ? safeHead : cursor + MAX_RANGE

    let logs: WatcherLog[]
    try {
      logs = await client.getLogs({ address: deps.contractAddress as `0x${string}`, events: WATCHER_EVENTS, fromBlock, toBlock })
    } catch (e) {
      console.error('[usdc-escrow watcher] getLogs failed:', (e as Error).message)
      return { scanned }   // 不推进游标;本段已落盘的处理(若有)天然幂等,下次重扫
    }

    await detectReorgs(deps, client, fromBlock, toBlock, logs)
    for (const l of logs) processLog(deps, l)

    cursor = toBlock
    scanned = true
    deps.db.prepare("INSERT OR REPLACE INTO usdc_escrow_watcher_state (id, last_scanned_block, updated_at) VALUES ('main', ?, datetime('now'))").run(Number(cursor))
  }
  return { scanned }
}

/** 启动定时 watcher(server.ts 启动时挂载)。缺 contractAddress → 不启动(空转)。返回 stop 函数。 */
export function startUsdcEscrowWatcher(deps: WatcherDeps): () => void {
  if (!deps.contractAddress) {
    console.log('[usdc-escrow watcher] USDC_ESCROW_CONTRACT 未配置,watcher 空转(合约未部署/未接线)')
    return () => {}
  }
  let inFlight = false
  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      await runWatcherTick(deps)
    } catch (e) {
      // watcher 永不 crash 进程 —— 任何未预见异常都吞掉 + 记录,下个 tick 继续
      console.error('[usdc-escrow watcher] tick crashed (caught):', (e as Error).message)
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => { void tick() }, TICK_MS)
  void tick()
  return () => clearInterval(timer)
}
