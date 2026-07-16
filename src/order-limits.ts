/**
 * RFC-025 PR-3 — 单笔订单数量上限(共享常量,单一真相源)。
 * 此前硬编码在 orders-create.ts;quote(buyer-quote.ts)必须用同一个值做资格判断,
 * 拷贝数字 = drift 风险,故提取。改此值即同时改 quote 资格与下单硬门。
 */
export const MAX_PER_ORDER = 10
