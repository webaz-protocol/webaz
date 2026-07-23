/**
 * MCP Token PR-3 — 工具面(surface bundle)与动态暴露。
 *
 * 背景(Phase 0 审计):tools/list 对所有客户端全量下发 54 工具 ≈101KB 定义(≈25-35k token),
 * 普通买家会话同时看到卖家/仲裁/治理/贡献工具 —— 定义 token、选择难度、误调概率全部为此买单。
 *
 * 语义边界(铁则):surface 只影响 tools/list 的【可见性】,绝不影响授权 —— tools/call 对任何
 * 已知工具照常分发,权限仍由 call 时的 bearer/scope/api_key/Passkey 门决定(与 PR-1..2 一致)。
 * 因此 surface 不是安全机制,只是 token/DX 优化;缓存了旧全量清单的客户端(如 ChatGPT connector)
 * 按名调用一切照旧。
 *
 * 选面规则(mcp-remote 边缘,stdio 永远全量):
 *   1. /mcp?surface=shopping_v1|buyer|seller|full 显式选面(用户在 connector URL 里配置,全客户端兼容);
 *   2. 无显式参数:human api_key bearer → full(账号全权面);
 *   3. 其余(匿名 / gtk_ / oat_ 委托凭证)→ buyer(默认买家核心面 —— 破坏性变更,
 *      迁移指引见 REMOTE-MCP.md;旧行为 = ?surface=full)。
 */

export type ToolSurface = 'shopping_v1' | 'buyer' | 'seller' | 'full'

// 公开购物插件 v1:最小买家闭环。此集合是对外审核契约,新增/删除成员必须走插件新版本审核。
// search 同时承担列表/详情/商品卡;discover 返回候选并引导 search 渲染标准卡。
export const SHOPPING_V1_SURFACE_TOOLS: ReadonlySet<string> = new Set([
  'webaz_search', 'webaz_discover', 'webaz_quote_order',
  'webaz_order_draft', 'webaz_submit_order_request',
  'webaz_buyer_orders', 'webaz_connection_status',
])

// 买家核心面:发现→报价→草稿→提交→审批→订单→售后 全链 + 账户身份读(21)
export const BUYER_SURFACE_TOOLS: ReadonlySet<string> = new Set([
  'webaz_info', 'webaz_register', 'webaz_connection_status',
  'webaz_search', 'webaz_discover', 'webaz_price_history',
  'webaz_verify_price', 'webaz_place_order', 'webaz_get_status',
  'webaz_quote_order', 'webaz_order_draft', 'webaz_submit_order_request',
  'webaz_buyer_orders', 'webaz_buyer_action_request', 'webaz_approval_requests',
  'webaz_prepare_case', 'webaz_order_chat', 'webaz_wallet_view',
  'webaz_address', 'webaz_default_address', 'webaz_notifications',
])

// 卖家面:上架/履约/账户运营 + 通用商务读(23)
export const SELLER_SURFACE_TOOLS: ReadonlySet<string> = new Set([
  'webaz_info', 'webaz_register', 'webaz_connection_status',
  'webaz_search', 'webaz_get_status', 'webaz_price_history',
  'webaz_list_product', 'webaz_upload_product_image', 'webaz_p2p_product',
  'webaz_get_agent_order', 'webaz_order_action_request', 'webaz_update_order',
  'webaz_order_chat', 'webaz_notifications',
  'webaz_wallet', 'webaz_wallet_view',
  'webaz_mykey', 'webaz_profile', 'webaz_rotate_key', 'webaz_revoke_key',
  'webaz_trial', 'webaz_shareables', 'webaz_share_link',
])

const VALID_SURFACES = new Set<string>(['shopping_v1', 'buyer', 'seller', 'full'])

/** 边缘选面:显式参数 > api_key bearer(full)> 默认 buyer。非法参数按默认处理(不 400,防连接器坏配置死链)。 */
export function resolveSurface(explicit: unknown, bearerKind: 'api_key' | 'grant' | 'none'): ToolSurface {
  if (typeof explicit === 'string' && VALID_SURFACES.has(explicit)) return explicit as ToolSurface
  return bearerKind === 'api_key' ? 'full' : 'buyer'
}

export function filterToolsBySurface<T extends { name: string }>(tools: T[], surface: ToolSurface): T[] {
  if (surface === 'full') return tools
  const set = surface === 'shopping_v1'
    ? SHOPPING_V1_SURFACE_TOOLS
    : surface === 'buyer' ? BUYER_SURFACE_TOOLS : SELLER_SURFACE_TOOLS
  return tools.filter(t => set.has(t.name))
}
