/**
 * USDC 链上合约担保(B 线)PR-B5 — Released 事件消费 + 结算域(状态收敛 + 纯记账镜像)。
 *
 * 对应合约 contracts/WebazEscrow.sol(#518)的 `Released(orderKey, auto_, sellerPaid, feePaid)`。
 * 铁律(仿 usdc-escrow-timeouts.ts 的克制哲学):
 *   - 链上 Released = 资金【已终局】:卖家净额与平台费都已在合约层到账(pull-payment,accruedFees),
 *     DB 侧【绝不】做任何资金搬运 —— 零 wallets 写。本域只做两件确定该做的事:
 *       ① 状态收敛 delivered → confirmed → completed(全走 engine.transition,留审计链);
 *       ② 纯记账镜像:写 usdc_escrow_fee_ledger 一行(平台费只读镜像)+ intents.status='released'。
 *   - 绝不假 success:无【非孤儿】Released 镜像行时,settleUsdcEscrowAtCompletion 直接 throw
 *     (保住 B3 铁律:任何其它路径试图假完成本轨订单必炸整体回滚);守恒核对不过(sellerPaid+feePaid
 *     ≠ 存入 amount)同样 throw,绝不静默吞。transition 失败 → throw / alert,绝不静默推进。
 *   - 所有入口幂等:事件重扫、sweep 重驱、崩溃恢复(confirm 后没走完 completed)全收口到同一处 ——
 *     INSERT OR IGNORE(fee_ledger 一单一行)+ 条件 UPDATE(仅 funded→released)+ 状态机的天然幂等。
 *   - 金额全程 BigInt 比较(6dp units 的 1 unit 就是钱);payload_json 里 bigint 已序列化为字符串。
 *   - 超时执法权威在链上(合约 autoReleaseAt);DB 侧对本轨【不判责】—— 停摆单只做 admin 可见性提醒。
 */
import type Database from 'better-sqlite3'

export interface UsdcSettleDeps {
  transition: (
    db: Database.Database,
    orderId: string,
    to: 'confirmed' | 'completed',
    actorId: string,
    evidence: string[],
    note: string,
  ) => { success: boolean; error?: string }
  settleOrder: (orderId: string) => void
  generateId: (p: string) => string
}

export interface ReleasedEventRow { order_key: string; tx_hash: string; payload_json: string }

interface IntentRow { order_id: string; order_key: string; amount_units: number; status: string }
interface OrderRow { id: string; status: string; buyer_id: string }

/**
 * 全体 admin 告警(从 watcher 私有 alertAdmins 抽出,watcher 改 import 复用,消除重复实现)。
 * 写全体 admin 的 notifications + console.error 兜底;通知失败绝不阻断结算主流程。
 */
export function alertUsdcAdmins(db: Database.Database, generateId: (p: string) => string, title: string, body: string): void {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: string }>
    for (const a of admins) {
      db.prepare('INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,NULL)')
        .run(generateId('ntf'), a.id, title, body)
    }
  } catch { /* 通知失败不阻断主流程 */ }
  console.error('[usdc-escrow settle]', title, body)
}

/**
 * settleOrder 的 usdc_escrow 分支(在 settleOrder 自己的 db.transaction 内被调用)。
 * 铁律守卫【在最前】:查该单是否存在【非孤儿】的已镜像 Released 事件 —— 无则 throw(绝不假完成),
 * 有则守恒核对 sellerPaid+feePaid===amount(不等 throw),过后纯记账:INSERT OR IGNORE fee_ledger
 * (镜像已收讫的平台费,非应收)+ 条件 UPDATE intents funded→released。零 wallets 写、全幂等。
 */
export function settleUsdcEscrowAtCompletion(db: Database.Database, order: { id: string }, generateId: (p: string) => string): void {
  const orderId = order.id
  // 铁律守卫在最前:非孤儿 Released 镜像行(取最深确认的 canonical,重组替换行按 block_number 兜底)
  const ev = db.prepare(`
    SELECT ce.order_key, ce.tx_hash, ce.payload_json FROM usdc_escrow_chain_events ce
    LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id
    JOIN usdc_escrow_intents i ON i.order_key = ce.order_key
    WHERE o.event_id IS NULL AND ce.event_name = 'Released' AND i.order_id = ?
    ORDER BY ce.block_number DESC LIMIT 1
  `).get(orderId) as { order_key: string; tx_hash: string; payload_json: string } | undefined
  if (!ev) {
    throw new Error(`USDC_ESCROW_NO_RELEASE_EVENT: order ${orderId} 无非孤儿 Released 镜像行 —— 拒绝假完成(B3 铁律,整体回滚)`)
  }

  const intent = db.prepare("SELECT order_id, order_key, amount_units, status FROM usdc_escrow_intents WHERE order_id = ?").get(orderId) as IntentRow | undefined
  if (!intent) {
    throw new Error(`USDC_ESCROW_INTENT_MISSING: order ${orderId} 有 Released 镜像却无 intent(不可能;拒绝继续)`)
  }

  const payload = JSON.parse(ev.payload_json) as { auto_?: boolean; sellerPaid: string; feePaid: string }
  const sellerPaid = BigInt(payload.sellerPaid)
  const feePaid = BigInt(payload.feePaid)
  if (sellerPaid + feePaid !== BigInt(intent.amount_units)) {
    throw new Error(
      `USDC_ESCROW_CONSERVATION_MISMATCH: order ${orderId} sellerPaid(${sellerPaid})+feePaid(${feePaid}) ` +
      `!= amount(${intent.amount_units}),差额 ${sellerPaid + feePaid - BigInt(intent.amount_units)}`,
    )
  }

  // feePaid ≤ per-tx cap(50e6 units)→ Number 安全;auto_release 从 payload.auto_
  db.prepare(`INSERT OR IGNORE INTO usdc_escrow_fee_ledger (order_id, order_key, amount_units, auto_release, tx_hash) VALUES (?,?,?,?,?)`)
    .run(orderId, ev.order_key.toLowerCase(), Number(feePaid), payload.auto_ ? 1 : 0, ev.tx_hash)
  db.prepare("UPDATE usdc_escrow_intents SET status = 'released' WHERE order_id = ? AND status = 'funded'").run(orderId)
}

/**
 * 统一驱动器(watcher 事件路径与 sweep 重驱路径共用)。按 order_key 查 intents / 订单,按状态分派。
 * 事务外 catch → alertAdmins(绝不吞);所有分支幂等。
 */
export function applyUsdcEscrowRelease(
  db: Database.Database,
  deps: UsdcSettleDeps,
  ev: ReleasedEventRow,
  alertAdmins: (title: string, body: string) => void,
): void {
  const orderKey = ev.order_key.toLowerCase()
  const intent = db.prepare("SELECT order_id, order_key, amount_units, status FROM usdc_escrow_intents WHERE order_key = ?").get(orderKey) as IntentRow | undefined
  if (!intent) {
    alertAdmins('🚨 USDC 担保:未知释放', `order_key ${orderKey} 链上释放(tx ${ev.tx_hash})但无对应 intent —— 人工核。`)
    return
  }
  if (intent.status === 'issued') {
    alertAdmins('🚨 USDC 担保:未存入却释放', `order_key ${orderKey}(order ${intent.order_id})intent 仍 issued(未确认存入)却收到释放,tx ${ev.tx_hash} —— 人工核。`)
    return
  }

  const order = db.prepare('SELECT id, status, buyer_id FROM orders WHERE id = ?').get(intent.order_id) as OrderRow | undefined
  if (!order) {
    alertAdmins('🚨 USDC 担保:intent 无对应订单', `intent order_id ${intent.order_id}(order_key ${orderKey})查不到订单,tx ${ev.tx_hash}。`)
    return
  }

  const payload = JSON.parse(ev.payload_json) as { auto_?: boolean }
  const auto = !!payload.auto_

  switch (order.status) {
    case 'delivered': {
      // 正常收口:delivered → confirmed → settleOrder(记账镜像)→ completed,单事务原子。
      try {
        db.transaction(() => {
          const actor = auto ? 'sys_protocol' : order.buyer_id
          const r1 = deps.transition(db, order.id, 'confirmed', actor, [], `链上担保已释放(tx ${ev.tx_hash}, auto=${auto})`)
          if (!r1.success) throw new Error(`delivered→confirmed 失败:${r1.error}`)
          deps.settleOrder(order.id)   // 其 usdc 分支做铁律守卫 + 记账(嵌套事务 = savepoint,合法)
          const r2 = deps.transition(db, order.id, 'completed', 'sys_protocol', [], '链上结算完成')
          if (!r2.success) throw new Error(`confirmed→completed 失败:${r2.error}`)
        })()
      } catch (e) {
        alertAdmins('🚨 USDC 担保:释放结算失败', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};状态未变,人工核。`)
      }
      break
    }
    case 'confirmed': {
      // 崩溃恢复:上次 confirm 后没走完 completed —— 补 settleOrder + →completed。
      try {
        db.transaction(() => {
          deps.settleOrder(order.id)
          const r2 = deps.transition(db, order.id, 'completed', 'sys_protocol', [], '链上结算完成(崩溃恢复补收口)')
          if (!r2.success) throw new Error(`confirmed→completed 失败:${r2.error}`)
        })()
      } catch (e) {
        alertAdmins('🚨 USDC 担保:释放结算失败(恢复)', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};人工核。`)
      }
      break
    }
    case 'completed': {
      // 幂等补记:若 fee_ledger 无行或 intents 仍 funded → 单事务补记账;否则 no-op(不告警、不改状态)。
      try {
        const feeRow = db.prepare('SELECT order_id FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(order.id)
        if (!feeRow || intent.status === 'funded') {
          db.transaction(() => { settleUsdcEscrowAtCompletion(db, order, deps.generateId) })()
        }
      } catch (e) {
        alertAdmins('🚨 USDC 担保:completed 补记账失败', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};人工核。`)
      }
      break
    }
    case 'disputed':
      alertAdmins('🚨 USDC 担保:链上释放但订单争议中', `order ${order.id}(order_key ${orderKey})处于 disputed,tx ${ev.tx_hash} —— 链上仲裁消费是 B7,现阶段人工核(不动状态)。`)
      break
    case 'paid':
    case 'accepted':
    case 'shipped':
    case 'picked_up':
    case 'in_transit':
      alertAdmins(
        '🚨 USDC 担保:提前释放',
        `order ${order.id}(order_key ${orderKey})在 ${order.status} 收到链上释放,tx ${ev.tx_hash} —— 资金已到卖家但订单未达 delivered;` +
        '等 delivered 后由 sweepPendingUsdcEscrowReleases 收口(不动状态)。',
      )
      break
    default:
      alertAdmins(
        '🚨 USDC 担保:死单收到释放',
        `order ${order.id}(order_key ${orderKey})状态 ${order.status},tx ${ev.tx_hash} —— 资金已放给卖家而订单已死,人工处置(不动状态)。`,
      )
  }
}

/**
 * 重驱清扫(提前释放补收口 + 崩溃恢复 + watcher 窗口外的唯一收口)。
 * 扫本轨、有非孤儿 Released 镜像、且订单仍在 delivered/confirmed 的单,逐行 try/catch 调驱动器
 * (单单失败不阻断其它)。
 */
export function sweepPendingUsdcEscrowReleases(
  db: Database.Database,
  deps: UsdcSettleDeps,
  alertAdmins: (title: string, body: string) => void,
): void {
  let rows: ReleasedEventRow[] = []
  try {
    rows = db.prepare(`
      SELECT DISTINCT ce.order_key, ce.tx_hash, ce.payload_json FROM usdc_escrow_chain_events ce
      LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id
      JOIN usdc_escrow_intents i ON i.order_key = ce.order_key
      JOIN orders ord ON ord.id = i.order_id
      WHERE o.event_id IS NULL AND ce.event_name = 'Released'
        AND ord.payment_rail = 'usdc_escrow' AND ord.status IN ('delivered','confirmed')
    `).all() as ReleasedEventRow[]
  } catch { return }
  for (const ev of rows) {
    try {
      applyUsdcEscrowRelease(db, deps, ev, alertAdmins)
    } catch (e) {
      console.error('[usdc-escrow settle sweep]', ev.order_key, (e as Error).message)
    }
  }
}

/**
 * 停摆单 admin 可见性(B4 审计接缝的 B5 份额;买家面通知归 B6)。本轨【不判责】(超时执法在链上
 * autoRelease):对 paid 超 accept_deadline / accepted 超 ship_deadline 的单给全体 admin 发通知
 * (标题含 order id),发前查重(同 user_id+order_id+同标题已存在则跳过,绝不重复轰炸)。
 */
export function sweepStalledUsdcEscrowOrders(db: Database.Database, generateId: (p: string) => string): void {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: string }>
    if (admins.length === 0) return
    const stalled = db.prepare(`
      SELECT id, status FROM orders
      WHERE payment_rail = 'usdc_escrow'
        AND ( (status = 'paid'     AND datetime(accept_deadline) < datetime('now'))
           OR (status = 'accepted' AND datetime(ship_deadline)   < datetime('now')) )
    `).all() as Array<{ id: string; status: string }>
    for (const o of stalled) {
      const title = `⏰ USDC 担保:订单 ${o.id} 卖家停摆(${o.status})`
      const body =
        `订单 ${o.id} 处于 ${o.status} 已超时。本轨超时执法在链上(合约 autoRelease),DB 不判责;` +
        '需人工介入或提醒买家链上 flagDispute(前端 B6)。'
      for (const a of admins) {
        const exists = db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND order_id = ? AND title = ?').get(a.id, o.id, title)
        if (exists) continue
        db.prepare('INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)').run(generateId('ntf'), a.id, title, body, o.id)
      }
    }
  } catch (e) {
    console.error('[usdc-escrow stalled sweep]', (e as Error).message)
  }
}
