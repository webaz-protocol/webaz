/**
 * RFC-026 PR-3 — 钱包【最小只读】投影(safe scope wallet_read_minimal)。
 *
 * 铁律:钱包的 OAuth 面【永远只读】(RFC-026 §L5:提现/收款账户/白名单/大额转账永不入
 * OAUTH_SCOPE_CAPABILITIES)。本投影只回答两个买家问题:①还有多少可用 ②多少压在托管 ——
 * 外加按订单的退款着陆核对入口(refund 的权威明细在订单全量视图 refund_status)。
 *
 * 绝不返回:提现地址、收款账户、链上身份、api_key、银行信息、任何可用于转移资金的凭证。
 * 诚实披露:escrow 轨当前为模拟 WAZ 测试流程(ESCROW-WAZ-SIM),响应如实标注。
 */
import type Database from 'better-sqlite3'

export function walletAgentView(db: Database.Database, humanId: string): Record<string, unknown> {
  const w = db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id = ?').get(humanId) as { balance: number; escrowed: number } | undefined
  // 最近退款着陆:escrow 轨退货 refunded = 资金已从托管释放回买家(按订单核对;金额为订单币面值)
  const refunds = (db.prepare(`SELECT rr.order_id, rr.refund_amount, rr.resolved_at FROM return_requests rr
      WHERE rr.buyer_id = ? AND rr.status = 'refunded' ORDER BY rr.resolved_at DESC LIMIT 5`)
    .all(humanId) as Array<Record<string, unknown>>).map(r => ({
      order_id: String(r.order_id), amount: r.refund_amount == null ? null : Number(r.refund_amount),
      status: 'completed', completed_at: r.resolved_at == null ? null : String(r.resolved_at),
    }))
  return {
    available_balance: w ? Number(w.balance) : 0,
    in_escrow: w ? Number(w.escrowed) : 0,
    currency: 'WAZ',
    recent_refunds: refunds,
    read_only: true,
    notes: [
      'Wallet over OAuth is READ-ONLY forever — no withdrawals, no receive accounts, no transfers via agents.',
      'The escrow rail currently runs on simulated WAZ (test flow); Direct Pay funds never touch WebAZ.',
      'Per-order refund detail lives in the buyer order full view (refund_status).',
    ],
  }
}
