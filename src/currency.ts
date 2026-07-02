/**
 * 协议展示币种(单一真相源)。
 *
 * 协议内部模拟单位对外一律显示为 **WAZ**(pre-launch 测试币;1 WAZ ≈ 1 USDC 是模拟基准,非真实汇率,无真实结算)。
 * 历史遗留:products.currency 曾 DEFAULT 'DCP'(旧内部代号),存量行仍可能是 'DCP'。agent-facing 输出【绝不】暴露 'DCP' ——
 *   读时经 displayCurrency() 归一化为 WAZ。底层 schema DEFAULT 的翻转 + 存量 backfill 是【独立 gated PR】(需 ALTER/回填决策),
 *   本模块只保证【展示层】一致,不动数据。
 */
export const PROTOCOL_CURRENCY = 'WAZ'

/** 归一化展示币种:空 / 'DCP'(遗留内部代号)→ 'WAZ';其余原样(大写)。用于所有 agent-facing 币种字段。 */
export function displayCurrency(code: unknown): string {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : ''
  if (!c || c === 'DCP') return PROTOCOL_CURRENCY
  return c
}
