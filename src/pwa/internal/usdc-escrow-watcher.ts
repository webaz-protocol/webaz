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
 *     一件事"同一克制哲学)。
 *   - 金额/费率全程 BigInt 比较,绝不 Number() —— 6dp units 的 1 unit 误差就是钱。
 *
 * 范围边界(刻意不做,留后续 PR):
 *   - Released/Resolved 只镜像 + log(),结算映射(担保释放→打款/退款记账)是 PR-B5。
 *   - Disputed 只镜像 + alertAdmins,链上仲裁裁决消费是 PR-B7。
 */
import type Database from 'better-sqlite3'
import { createPublicClient, http, parseAbiItem } from 'viem'
import { base, baseSepolia } from 'viem/chains'

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
}

export interface WatcherDeps {
  db: Database.Database
  transition: (db: Database.Database, orderId: string, to: 'paid', actorId: string, evidence: string[], note: string) => { success: boolean; error?: string }
  generateId: (p: string) => string
  contractAddress: string
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
  }
}

/** 仿 server.ts 热钱包告警先例(L7906-7916):写全体 admin 的 notifications + console.error 兜底。 */
function alertAdmins(deps: WatcherDeps, title: string, body: string): void {
  try {
    const admins = deps.db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: string }>
    for (const a of admins) {
      deps.db.prepare('INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,NULL)')
        .run(deps.generateId('ntf'), a.id, title, body)
    }
  } catch { /* 通知失败不阻断 watcher 主流程 */ }
  console.error('[usdc-escrow watcher]', title, body)
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
 * 在本次 refetch 的 logs 里按 (tx_hash, log_index) 查找 —— 找不到(事件从链上消失)或
 * block_hash 变了(同 tx/log 位置换了区块)都视为重组,标记孤儿 + 告警。绝不改动/反转
 * 任何订单状态(模块头设计决策)。
 */
function detectReorgs(deps: WatcherDeps, fromBlock: bigint, toBlock: bigint, logs: WatcherLog[]): void {
  const existing = deps.db.prepare(`
    SELECT ce.id, ce.order_key, ce.event_name, ce.tx_hash, ce.log_index, ce.block_number, ce.block_hash
    FROM usdc_escrow_chain_events ce
    LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id
    WHERE o.event_id IS NULL AND ce.block_number BETWEEN ? AND ?
  `).all(Number(fromBlock), Number(toBlock)) as ChainEventRow[]
  if (existing.length === 0) return

  const byKey = new Map<string, WatcherLog>()
  for (const l of logs) byKey.set(`${l.transactionHash.toLowerCase()}:${l.logIndex}`, l)

  for (const row of existing) {
    const match = byKey.get(`${row.tx_hash.toLowerCase()}:${row.log_index}`)
    if (match && match.blockHash.toLowerCase() === row.block_hash.toLowerCase()) continue // 正常,未重组

    const reason = match
      ? `reorg:block_hash_mismatch:${match.blockHash.toLowerCase()}`
      : 'reorg:log_vanished'
    try {
      deps.db.prepare('INSERT OR IGNORE INTO usdc_escrow_event_orphans (event_id, reason) VALUES (?, ?)').run(row.id, reason)
    } catch { /* 已标记过(理论不该发生,双保险) */ }
    alertAdmins(
      deps,
      '🚨 USDC 担保:检测到链上重组',
      `事件 ${row.id}(order_key ${row.order_key}, event ${row.event_name}, tx ${row.tx_hash}#${row.log_index})` +
      (match ? ` 所在区块已变为 ${match.blockHash}` : ' 已从链上消失') +
      ' —— 已标记孤儿(usdc_escrow_event_orphans),不做任何订单状态反转,请人工核对链上真实状态。',
    )
  }
}

/** Deposited 应用步:intents 核对 + created→paid(仅当参数与订单状态皆符合时)。单事务,失败绝不吞。 */
function applyDeposited(deps: WatcherDeps, orderKey: string, l: WatcherLog): void {
  deps.db.transaction(() => {
    const intent = deps.db.prepare('SELECT * FROM usdc_escrow_intents WHERE order_key = ?').get(orderKey) as IntentRow | undefined
    if (!intent) {
      alertAdmins(deps, '🚨 USDC 担保:未知存款', `order_key ${orderKey} 收到链上存款(tx ${l.transactionHash})但无对应 intent —— amount ${String(l.args.amount)}。`)
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

    const order = deps.db.prepare('SELECT id, status, buyer_id, payment_rail FROM orders WHERE id = ?').get(intent.order_id) as
      { id: string; status: string; buyer_id: string; payment_rail: string } | undefined
    if (!order) {
      alertAdmins(deps, '🚨 USDC 担保:intent 无对应订单', `intent order_id ${intent.order_id}(order_key ${orderKey})查不到订单,tx ${l.transactionHash}。`)
      return
    }

    if (order.status === 'created') {
      const r = deps.transition(deps.db, order.id, 'paid', order.buyer_id, [], `链上存入已确认(tx ${l.transactionHash}, block ${l.blockNumber})`)
      if (r.success) {
        deps.db.prepare("UPDATE usdc_escrow_intents SET status = 'funded' WHERE order_id = ? AND status = 'issued'").run(order.id)
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
    }
  })()
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
    case 'Resolved':
      log(`[usdc-escrow watcher] mirrored ${l.eventName} for order_key ${orderKey} (tx ${l.transactionHash}) — 结算映射是 PR-B5,本 PR 不转移任何订单/资金状态`)
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

    detectReorgs(deps, fromBlock, toBlock, logs)
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
