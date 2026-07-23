/**
 * WAZ 退役(2026-07-23):模拟托管轨渠道开关(protocol_param `payment_rail_waz_escrow_enabled`,默认 '0'=关)
 * 的单一真值。菜单层(direct-pay-payment-options)/报价层(buyer-quote)/建单层(orders-create、
 * cart-checkout、group-buys、secondhand、RFQ award、拍卖结算)全部同闸;MCP local 无 getProtocolParam
 * 注入,直读 protocol_params 同语义。fail-closed:param 缺省/畸形/非 1 一律视为关。
 * 只闸【新建单/新本金入 escrow】;存量单的退款/争议/结算路径绝不经过此闸。
 */
export function wazEscrowChannelOn(getProtocolParam: <T>(key: string, fallback: T) => T): boolean {
  return Number(getProtocolParam('payment_rail_waz_escrow_enabled', 0)) === 1
}

/** 渠道关时任何"我的 WAZ 余额"展示投影一律零化(/api/me、/api/profile、/api/users/:id owner
 *  private_stats、MCP webaz_profile 等读侧共用;/api/wallet 有自己的完整 sunset DTO)。 */
export function projectWalletForSunset(
  getProtocolParam: <T>(key: string, fallback: T) => T,
  wallet: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (wazEscrowChannelOn(getProtocolParam)) return wallet ?? null
  return { waz_sunset: true, balance: 0, staked: 0, escrowed: 0, earned: 0, fee_staked: 0 }
}

/** orders-create escrow 路径 409 响应体(测试与前端 orderErrorLookup 依赖 error_code 稳定)。 */
export const WAZ_RAIL_DISABLED = { error: 'WAZ 模拟托管轨已下架,请选择卖家支持的直付方式下单', error_code: 'RAIL_DISABLED' } as const

/**
 * 拍卖渠道关的资金归还终局(Codex #514 R1 BLOCKER-4;从 server.ts settleAuctionInner 抽出):
 * 有 winner 且渠道关 → 绝不建 escrow 单/抽买家本金,收终局 —— 标 'cancelled' + 退中标者与其他 active
 * bid 押金 + 退卖家担保金 + 商品回架。事务内重读 status='open'(CAS)保幂等;二次调用 already_cancelled。
 * 只在【本应成交建单】的分支调用;无人出价/未达保留价的既有退款分支不经此处、不受渠道影响。
 */
export function settleAuctionRailDisabledRefund(
  db: import('better-sqlite3').Database,
  generateId: (prefix: string) => string,
  aucId: string,
  auc: Record<string, unknown>,
  winner: Record<string, unknown>,
): { ok: boolean; result: string } {
  const sellerStake = Number(auc.seller_stake_locked) || 0
  db.transaction(() => {
    const cur = db.prepare('SELECT status FROM auctions WHERE id = ?').get(aucId) as { status: string } | undefined
    if (!cur || cur.status !== 'open') throw new Error('concurrent_settle_skip')
    db.prepare("UPDATE auctions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(aucId)
    if (sellerStake > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(sellerStake, sellerStake, auc.seller_id)
    const bids = db.prepare("SELECT id, buyer_id, stake_locked FROM auction_bids WHERE auction_id = ? AND status = 'active'").all(aucId) as Array<{ id: string; buyer_id: string; stake_locked: number }>
    for (const b of bids) {
      db.prepare("UPDATE auction_bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(b.id)
      if (b.stake_locked > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(b.stake_locked, b.stake_locked, b.buyer_id)
    }
    if (auc.product_id) db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'auction_pending'").run(auc.product_id)
  })()
  try {
    db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                VALUES (?,?,'auction_cancelled',?,?,datetime('now'))`)
      .run(generateId('ntf'), String(winner.buyer_id), '拍卖已取消:WAZ 托管轨已下架', `拍卖 ${String(auc.title).slice(0, 30)} · 押金已全额退还`)
  } catch { /* 通知失败不阻断资金终局 */ }
  return { ok: false, result: 'rail_disabled_refund' }
}
