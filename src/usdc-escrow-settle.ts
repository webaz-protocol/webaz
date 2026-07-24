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
    to: 'confirmed' | 'completed' | 'cancelled',   // 'cancelled' = B7a Resolved 全退买家有利终态(disputed→cancelled)
    actorId: string,
    evidence: string[],
    note: string,
  ) => { success: boolean; error?: string }
  settleOrder: (orderId: string) => void
  generateId: (p: string) => string
  notifyTransition?: (db: Database.Database, orderId: string, from: string, to: string) => void   // B6a:delivered→confirmed / confirmed→completed 消费(可选;通知失败绝不回滚钱路)
}

export interface ReleasedEventRow { order_key: string; tx_hash: string; payload_json: string }
export interface ResolvedEventRow { order_key: string; tx_hash: string; payload_json: string }

interface IntentRow { order_id: string; order_key: string; amount_units: number; status: string }
interface OrderRow { id: string; status: string; buyer_id: string }

/**
 * 全体 admin 告警(从 watcher 私有 alertAdmins 抽出,watcher 改 import 复用,消除重复实现)。
 * 写全体 admin 的 notifications + console.error 兜底;通知失败绝不阻断结算主流程。
 *
 * dedupeOrderId(可选):sweep 可达的失败告警会被 60s 一次的重驱路径无界重放(见
 * sweepPendingUsdcEscrowReleases + applyUsdcEscrowRelease 的 delivered/confirmed/completed catch)——
 * 传入 order id 后,notifications 用 order_id=dedupeOrderId 落行,且跳过任何已有
 * (user_id, order_id=dedupeOrderId, title) 通知的 admin(与 sweepStalledUsdcEscrowOrders 同款去重),
 * 把每 tick 一条的无界写收敛为一单一题一行。console.error 仍每次都发(廉价、可 grep)。
 * 不传(默认)= 老行为:order_id=NULL、不去重(watcher 有界路径的告警走这条)。
 */
export function alertUsdcAdmins(db: Database.Database, generateId: (p: string) => string, title: string, body: string, dedupeOrderId?: string): void {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: string }>
    for (const a of admins) {
      if (dedupeOrderId) {
        const exists = db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND order_id = ? AND title = ?').get(a.id, dedupeOrderId, title)
        if (exists) continue
        db.prepare('INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)')
          .run(generateId('ntf'), a.id, title, body, dedupeOrderId)
      } else {
        db.prepare('INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,NULL)')
          .run(generateId('ntf'), a.id, title, body)
      }
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
  // 下列前置告警走【未去重】的 alertAdmins wrapper:无 intent / issued 未存入 / intent 无订单
  // 都不落入 sweepPendingUsdcEscrowReleases 的选择集(它 JOIN intents+orders 且要求 delivered/confirmed),
  // 由 watcher rescan 窗口天然有界,不需按单去重。
  const intent = db.prepare("SELECT order_id, order_key, amount_units, status FROM usdc_escrow_intents WHERE order_key = ?").get(orderKey) as IntentRow | undefined
  if (!intent) {
    alertAdmins('🚨 USDC 担保:未知释放', `order_key ${orderKey} 链上释放(tx ${ev.tx_hash})但无对应 intent —— 人工核。`)
    return
  }
  if (intent.status === 'issued') {
    alertAdmins('🚨 USDC 担保:未存入却释放', `order_key ${orderKey}(order ${intent.order_id})intent 仍 issued(未确认存入)却收到释放,tx ${ev.tx_hash} —— 人工核。`)
    return
  }
  if (intent.status === 'void') {
    // B6a:作废凭证(订单已取消/清扫)却收到链上释放 —— 告警 + 不动订单(现只查 'issued',补 void 分支)。
    alertAdmins('🚨 USDC 担保:作废凭证却收到释放', `order_key ${orderKey}(order ${intent.order_id})intent 已 void(订单已取消)却收到链上释放,tx ${ev.tx_hash} —— 人工核链上真相。`)
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
      let settled = false
      try {
        db.transaction(() => {
          const actor = auto ? 'sys_protocol' : order.buyer_id
          let r1 = deps.transition(db, order.id, 'confirmed', actor, [], `链上担保已释放(tx ${ev.tx_hash}, auto=${auto})`)
          // Fix B:链上 buyerRelease 签名【即】买家授权,DB actor 只是归因。若账号角色在存入后变更
          // (buyer→seller),以 buyer 作 actor 的 delivered→confirmed 会被 allowedRoles 永久拒绝而卡死收敛。
          // 首次(buyer actor,即 !auto)失败即以 sys_protocol 代收敛重试【一次】(仅这一步;事务内同步)。
          if (!r1.success && !auto) {
            r1 = deps.transition(db, order.id, 'confirmed', 'sys_protocol', [], `链上担保已释放(tx ${ev.tx_hash}, auto=${auto})(买家链上签名释放;账号角色已变更,system 代收敛)`)
          }
          if (!r1.success) throw new Error(`delivered→confirmed 失败:${r1.error}`)
          deps.settleOrder(order.id)   // 其 usdc 分支做铁律守卫 + 记账(嵌套事务 = savepoint,合法)
          const r2 = deps.transition(db, order.id, 'completed', 'sys_protocol', [], '链上结算完成')
          if (!r2.success) throw new Error(`confirmed→completed 失败:${r2.error}`)
        })()
        settled = true
      } catch (e) {
        // Fix A:sweep 可达失败 → 直接调 5-arg 去重 helper(标题稳定、按 order 去重),避免 60s 重驱无界轰炸。
        alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:释放结算失败', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};状态未变,人工核。`, order.id)
      }
      // B6a:钱路事务提交后发通知(try/catch;通知失败绝不回滚钱路)。delivered→confirmed 与 confirmed→completed 两条。
      if (settled) { try { deps.notifyTransition?.(db, order.id, 'delivered', 'confirmed'); deps.notifyTransition?.(db, order.id, 'confirmed', 'completed') } catch (e) { console.warn('[usdc-escrow settle] release notify failed:', (e as Error).message) } }
      break
    }
    case 'confirmed': {
      // 崩溃恢复:上次 confirm 后没走完 completed —— 补 settleOrder + →completed。
      let settled = false
      try {
        db.transaction(() => {
          deps.settleOrder(order.id)
          const r2 = deps.transition(db, order.id, 'completed', 'sys_protocol', [], '链上结算完成(崩溃恢复补收口)')
          if (!r2.success) throw new Error(`confirmed→completed 失败:${r2.error}`)
        })()
        settled = true
      } catch (e) {
        // Fix A:sweep 可达失败 → 去重 helper(同上)。
        alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:释放结算失败(恢复)', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};人工核。`, order.id)
      }
      // B6a:恢复分支只补 confirmed→completed 一条(delivered→confirmed 上次已发)。
      if (settled) { try { deps.notifyTransition?.(db, order.id, 'confirmed', 'completed') } catch (e) { console.warn('[usdc-escrow settle] recovery notify failed:', (e as Error).message) } }
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
        // Fix A:watcher rescan 可反复驱动本 backfill catch → 去重 helper(标题稳定、按 order 去重)。
        alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:completed 补记账失败', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};人工核。`, order.id)
      }
      break
    }
    // 以下告警走【未去重】的 alertAdmins wrapper:它们由 watcher rescan 窗口 / sweep 选取条件天然有界
    // (sweep 只选 delivered/confirmed 且有非孤儿 Released 镜像的单,下列状态不入其选择集),无需按单去重。
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
 * PR-B7a — Resolved 事件消费(链上仲裁裁决驱动 DB 收敛)。B5 的 Released 对应物。
 *
 * 铁律(与 applyUsdcEscrowRelease 同哲学):
 *   - 资金【已在链上终局】(arbiterResolve 已把 buyerRefund/sellerPay/fee 分发,fee 进合约 accruedFees)——
 *     DB 侧【零 wallets 写】,只做两件确定该做的事:① 按订单当前状态收敛终态(全走 engine.transition,留审计链);
 *     ② 纯记账镜像:fee_ledger 一行(auto_release=0 区分 arbiter 裁决)+ intents funded→resolved。
 *   - 守恒核对:buyerRefund+sellerPaid+feePaid === 存入 amount(BigInt);不符 → 去重告警、不动状态。
 *   - 终态映射【只用既有合法 transition】(不新增订单状态):
 *       全退(buyerRefund==amount)→ disputed→cancelled(买家有利);否则(部分/零退)→ disputed→completed(卖家侧)。
 *   - 订单非 disputed(如仅链上 flag、DB 未开争议)→ 绝不强转非法态,告警人工收口(钱已在链上分配)。
 *   - 全幂等:重扫/重驱/崩溃恢复收口到同一处(INSERT OR IGNORE fee 行 + 条件 UPDATE funded→resolved + 状态机天然幂等)。
 */
export function applyUsdcEscrowResolved(
  db: Database.Database,
  deps: UsdcSettleDeps,
  ev: ResolvedEventRow,
  alertAdmins: (title: string, body: string) => void,
): void {
  const orderKey = ev.order_key.toLowerCase()
  const intent = db.prepare("SELECT order_id, order_key, amount_units, status FROM usdc_escrow_intents WHERE order_key = ?").get(orderKey) as IntentRow | undefined
  if (!intent) {
    alertAdmins('🚨 USDC 担保:未知裁决', `order_key ${orderKey} 链上裁决(tx ${ev.tx_hash})但无对应 intent —— 人工核。`)
    return
  }
  if (intent.status === 'issued') {
    alertAdmins('🚨 USDC 担保:未存入却裁决', `order_key ${orderKey}(order ${intent.order_id})intent 仍 issued(未确认存入)却收到链上裁决,tx ${ev.tx_hash} —— 人工核。`)
    return
  }
  if (intent.status === 'void') {
    alertAdmins('🚨 USDC 担保:作废凭证却裁决', `order_key ${orderKey}(order ${intent.order_id})intent 已 void(订单已取消)却收到链上裁决,tx ${ev.tx_hash} —— 人工核链上真相。`)
    return
  }

  const order = db.prepare('SELECT id, status, buyer_id FROM orders WHERE id = ?').get(intent.order_id) as OrderRow | undefined
  if (!order) {
    alertAdmins('🚨 USDC 担保:intent 无对应订单', `intent order_id ${intent.order_id}(order_key ${orderKey})查不到订单,tx ${ev.tx_hash}。`)
    return
  }

  // P2b:payload 解析 + BigInt 转换进 try/catch(与守恒/记账同哲学:畸形不抛穿 watcher processLog)。
  //   若 payload 字段名意外不符 / 非数值,BigInt(undefined|'abc') 会抛;不捕则穿透 watcher processLog 整条崩。
  //   捕获 → 去重告警、不动状态/记账(与守恒不符分支同处置)。
  let buyerRefund: bigint, sellerPaid: bigint, feePaid: bigint, amount: bigint
  try {
    const payload = JSON.parse(ev.payload_json) as { buyerRefund: string; sellerPaid: string; feePaid: string }
    buyerRefund = BigInt(payload.buyerRefund)
    sellerPaid = BigInt(payload.sellerPaid)
    feePaid = BigInt(payload.feePaid)
    amount = BigInt(intent.amount_units)
  } catch (e) {
    alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:裁决 payload 畸形',
      `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— payload 解析失败:${(e as Error).message};不动状态,人工核。`, order.id)
    return
  }
  if (buyerRefund + sellerPaid + feePaid !== amount) {
    // 守恒不符 = 链上裁决 payload 与存入金额对不上(理论不该;合约恒等)→ 去重告警、绝不动状态/记账。
    alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:裁决守恒不符',
      `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— buyerRefund(${buyerRefund})+sellerPaid(${sellerPaid})+feePaid(${feePaid}) != amount(${amount});不动状态,人工核。`, order.id)
    return
  }
  const fullRefund = buyerRefund === amount

  // 纯记账镜像(零 wallets 写;资金已在链上动过)。fee 行 auto_release=0 = arbiter 裁决(区分 B5 自动/买家释放)。
  const mirror = (): void => {
    db.prepare(`INSERT OR IGNORE INTO usdc_escrow_fee_ledger (order_id, order_key, amount_units, auto_release, tx_hash) VALUES (?,?,?,?,?)`)
      .run(order.id, orderKey, Number(feePaid), 0, ev.tx_hash.toLowerCase())
    db.prepare("UPDATE usdc_escrow_intents SET status = 'resolved' WHERE order_id = ? AND status = 'funded'").run(order.id)
  }

  switch (order.status) {
    case 'disputed': {
      const to: 'cancelled' | 'completed' = fullRefund ? 'cancelled' : 'completed'
      let done = false
      try {
        db.transaction(() => {
          const r = deps.transition(db, order.id, to, 'sys_protocol', [], `链上仲裁裁决已执行(tx ${ev.tx_hash}, buyerRefund=${buyerRefund}, full=${fullRefund})`)
          if (!r.success) throw new Error(`disputed→${to} 失败:${r.error}`)
          mirror()
        })()
        done = true
      } catch (e) {
        alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:裁决结算失败', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};状态未变,人工核。`, order.id)
      }
      if (done) { try { deps.notifyTransition?.(db, order.id, 'disputed', to) } catch (e) { console.warn('[usdc-escrow settle] resolved notify failed:', (e as Error).message) } }
      break
    }
    case 'completed':
    case 'cancelled': {
      // 幂等补记(订单已终态:重驱/重扫/崩溃恢复)—— 只补记账,不改状态、不告警。
      try {
        const feeRow = db.prepare('SELECT order_id FROM usdc_escrow_fee_ledger WHERE order_id = ?').get(order.id)
        if (!feeRow || intent.status === 'funded') db.transaction(() => { mirror() })()
      } catch (e) {
        alertUsdcAdmins(db, deps.generateId, '🚨 USDC 担保:裁决补记账失败', `order ${order.id}(order_key ${orderKey})tx ${ev.tx_hash} —— ${(e as Error).message};人工核。`, order.id)
      }
      break
    }
    default:
      // 到达这里 =【本不该发生】:resolve 路由(usdc-escrow-arbiter.ts)已硬门 order.status==='disputed' 才放行链上
      //   arbiterResolve,故被认可的 Resolved 必落上面 disputed 分支正常收敛。走进 default = 链上已 Resolved 但 DB 非
      //   disputed —— 只可能是 arbiter key 被路由外使用,或 flagDispute 后 DB 侧争议尚未开(不合作/丢钱包买家的端到端
      //   DB 收敛属状态机设计,归 B7b:system/arbiter 代开 DB 争议 + 证据豁免)。资金已在链上分配,绝不强转非法态,
      //   告警人工核。告警走 watcher rescan 窗口天然有界的 alertAdmins wrapper(sweep 只选 disputed,不入其选择集)。
      alertAdmins('🚨 USDC 担保:非争议态收到链上裁决',
        `order ${order.id}(order_key ${orderKey})状态 ${order.status},tx ${ev.tx_hash} —— 链上已 Resolved(buyerRefund=${buyerRefund}),` +
        '但 DB 订单非 disputed;资金已在链上分配,请人工核对后收口(不自动转移非法态)。')
  }
}

/**
 * 重驱清扫(Resolved 的 sweepPendingUsdcEscrowReleases 姊妹):扫本轨、有非孤儿 Resolved 镜像、
 * 且订单【仍 disputed】的单,逐行 try/catch 调驱动器 —— 收口"Resolved 事件已滚出 watcher rescan 窗口
 * 之后订单才进 disputed"的时序缺口(与 B5 提前释放收口同理)。驱动后订单离开 disputed,下轮不再入选(有界)。
 */
export function sweepPendingUsdcEscrowResolves(
  db: Database.Database,
  deps: UsdcSettleDeps,
  alertAdmins: (title: string, body: string) => void,
): void {
  let rows: ResolvedEventRow[] = []
  try {
    rows = db.prepare(`
      SELECT DISTINCT ce.order_key, ce.tx_hash, ce.payload_json FROM usdc_escrow_chain_events ce
      LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id
      JOIN usdc_escrow_intents i ON i.order_key = ce.order_key
      JOIN orders ord ON ord.id = i.order_id
      WHERE o.event_id IS NULL AND ce.event_name = 'Resolved'
        AND ord.payment_rail = 'usdc_escrow' AND ord.status = 'disputed'
    `).all() as ResolvedEventRow[]
  } catch { return }
  for (const ev of rows) {
    try {
      applyUsdcEscrowResolved(db, deps, ev, alertAdmins)
    } catch (e) {
      console.error('[usdc-escrow settle resolve-sweep]', ev.order_key, (e as Error).message)
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
