/**
 * RFC-003 — MCP NETWORK-mode tool gating (pure, testable; no I/O).
 *
 * In `network` / `network_readonly` mode the dispatcher hard-fails any tool that is
 * NOT allowed through, so an un-migrated tool can't silently fall back to the local
 * sandbox (a write would become a phantom op). This module holds the allow-sets +
 * the predicate so the gate decision is unit-testable without booting the stdio
 * server. (Extracted from server.ts; behavior unchanged except adding webaz_pair.)
 */

export type WebazMode = 'network' | 'network_readonly' | 'sandbox'

/**
 * 解析运行模式(纯函数,单一真相源 —— server.ts 的 MODE + CLI 的 --mode/--doctor 都用它,杜绝漂移)。
 * 显式 WEBAZ_MODE(network|network_readonly|sandbox)优先;否则有 api_key → network,无 key → network_readonly。
 * sandbox 只能显式设置(无 key 【不】回落 sandbox)。key 的真伪判定与 server.ts 一致(WEBAZ_API_KEY ?? '' 的真值性)。
 */
export function resolveMode(env: { WEBAZ_MODE?: string; WEBAZ_API_KEY?: string }): WebazMode {
  const m = (env.WEBAZ_MODE ?? '').toLowerCase()
  if (m === 'network' || m === 'sandbox' || m === 'network_readonly') return m
  return (env.WEBAZ_API_KEY ?? '') ? 'network' : 'network_readonly'
}

// Tools that talk to the live webaz.xyz network (Bearer api_key where needed).
// Un-listed tools run sandbox (local). `_mode` annotation = network for these.
export const NETWORK_TOOLS = new Set<string>([
  // RFC-020 onboarding/auth: pairing is the no-key credential bootstrap — it MUST be
  // reachable in the default network_readonly install (you pair to GET a credential).
  'webaz_pair',
  'webaz_price_history',
  'webaz_leaderboard',
  'webaz_verify_price',
  'webaz_place_order',
  'webaz_list_product',
  'webaz_update_order',
  'webaz_search',
  'webaz_get_status',
  'webaz_feedback',
  'webaz_contribute',
  // RFC-021 fulfillment-agent grant-wired order tools (read minimal + submit action-request).
  //   Grant-only (no api_key path); grants live on webaz.xyz so they must be network-reachable.
  'webaz_get_agent_order',
  'webaz_order_action_request',
  // RFC-023 connection identity (grant-wired, read_public). Grants live on webaz.xyz → MUST be here,
  //   or the RFC-003 migration gate returns not_on_network_yet before the handler ever runs.
  'webaz_connection_status',
  // RFC-025 PR-1 buyer-side minimal order read (grant-wired, buyer_orders_read_minimal). Same rule.
  'webaz_buyer_orders',
  // RFC-025 PR-2 buyer discovery (grant-wired, buyer_discover). Same rule.
  'webaz_discover',
  // RFC-025 PR-3 buyer quote (grant-wired, price_quote). Same rule.
  'webaz_quote_order',
  // RFC-025 PR-4 order draft (grant-wired, draft_order). Same rule.
  'webaz_order_draft',
  // RFC-025 PR-5a order submit request (grant-wired, order_submit_request). Same rule.
  'webaz_submit_order_request',
  // RFC-025 PR-6 after-sales case draft (grant-wired, buyer_case_prepare). Same rule.
  'webaz_prepare_case',
  // RFC-026 PR-2 approval-request status read (grant-wired, approval_requests_read). Same rule.
  'webaz_approval_requests',
  // RFC-026 PR-3 wallet minimal read (grant-wired, wallet_read_minimal; READ-ONLY forever). Same rule.
  'webaz_wallet_view',
  // RFC-026 PR-4 order-context chat (grant-wired, order_chat_read/send). Same rule.
  'webaz_order_chat',
  // RFC-026 PR-5 address masked read + change request (grant-wired). Same rule.
  'webaz_address',
  // Batch 1(只读 + 低危自身写):走 webaz.xyz Bearer api_key。
  'webaz_notifications',
  'webaz_nearby',
  'webaz_profile',
  'webaz_shareables',
  'webaz_mykey',
  // Batch 2(低危写,无钱无 escrow):走 webaz.xyz Bearer api_key。
  'webaz_follows',
  'webaz_like',
  'webaz_blocklist',
  'webaz_default_address',
  'webaz_chat',
  'webaz_rfq',
  'webaz_referral',
  // Batch 3(商务):
  'webaz_secondhand',
  'webaz_skill',
  'webaz_skill_market',
  'webaz_auction',
  // Batch 4(资金/质押,守恒由服务端 RFC-014 保证;wallet 只读,写=Passkey 仅 PWA):
  'webaz_wallet',
  'webaz_trial',
  'webaz_charity',
  'webaz_bid',
  'webaz_auto_bid',
  // Batch 5(铁律/敏感):
  'webaz_dispute',
  'webaz_claim_verify',
  'webaz_rotate_key',
  'webaz_revoke_key',
  // #1122:share_link 现有服务端端点 /api/share-link,可走网络。
  'webaz_share_link',
])

// Not in NETWORK_TOOLS but still allowed to run in NETWORK mode as self-aware /
// onboarding tools (non-data ops): info = local introspection; register = redirect
// the human to webaz.xyz. Everything else un-migrated hard-fails.
export const NETWORK_SELF_AWARE = new Set<string>(['webaz_info', 'webaz_register'])

/**
 * In NETWORK / network_readonly mode, may this tool proceed (vs migration-pending
 * hard-fail)? True for migrated network tools and the self-aware onboarding tools.
 */
export function toolAllowedInNetworkMode(tool: string): boolean {
  return NETWORK_TOOLS.has(tool) || NETWORK_SELF_AWARE.has(tool)
}
