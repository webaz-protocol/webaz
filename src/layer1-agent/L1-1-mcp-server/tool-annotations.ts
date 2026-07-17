/**
 * Standard MCP tool annotations for the shared TOOLS registry (server.ts).
 *
 * Pure data — this changes NO inputSchema, handler, tool name, or auth/business behavior. It only adds
 * the standard MCP hints (readOnlyHint / destructiveHint / openWorldHint) so conformant clients get
 * accurate confirmation metadata. Merged onto the authoritative descriptors by annotateTools() at the
 * single ListTools handler, so stdio and Remote MCP return the SAME annotated surface (zero drift).
 *
 * Classification is by REAL handler control flow (not tool name), per the official MCP ToolAnnotations
 * meanings:
 *   - readOnlyHint=true   ONLY if the handler performs NO state write at all (pure read, or it merely
 *     returns human instructions and does not touch the DB / execute anything).
 *   - destructiveHint=true if ANY action DELETES or OVERWRITES existing state, or moves/settles funds
 *     (pay/settle/confirm) — even if the effect is business-reversible. ADDITIVE-only writes (new rows:
 *     a new order/listing/message/feedback/campaign, a queued request) are NOT destructive. Multi-action
 *     tools are rated by their most dangerous action.
 *   - openWorldHint=true  if the tool interacts with the OPEN marketplace, OTHER users, ORDERS, or
 *     PUBLIC objects. false for tools confined to the caller's OWN account/private record or purely
 *     static/local output.
 *
 * This is annotations-only: it does NOT add securitySchemes, _meta, or any auth/scope behavior, and it
 * does not widen any capability. This map's key set MUST equal the live TOOLS name set — the test
 * asserts no missing/extra, and annotateTools() throws for an unmapped tool.
 */
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly openWorldHint: boolean
}

// destructive rationale noted inline (delete/overwrite/fund). Additive-only writes are marked W (not D).
export const TOOL_ANNOTATIONS: Record<string, McpToolAnnotations> = {
  webaz_info:                { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: first-party protocol manifest / self-description (acceptance-pack §2: static first-party read)
  webaz_pair:                { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): creates pairing/scope requests for a human account; pending-file cleanup is not a data delete (acceptance-pack §2)
  webaz_register:            { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): INSERTs a new account/wallet; joins the shared economic graph
  webaz_search:              { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: open marketplace + external anchors
  webaz_verify_price:        { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): creates an expiring price/stock session; marketplace price
  webaz_list_product:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: delete/delist/update overwrite the public catalog
  webaz_upload_product_image:{ readOnlyHint: false, destructiveHint: true,  openWorldHint: false }, // D: overwrites own warehouse-draft image list; never publishes
  webaz_place_order:         { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: moves funds into escrow/direct_p2p
  webaz_update_order:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: overwrites order state; confirm settles funds
  webaz_get_status:          { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: order status (counterparty objects)
  webaz_wallet:              { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: caller's own balance/earnings; cannot move money
  webaz_notifications:       { readOnlyHint: false, destructiveHint: true,  openWorldHint: false }, // D: mark_read overwrites read state (no in-tool undo); own inbox
  webaz_dispute:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: arbitrate is an irreversible fund disposition
  webaz_claim_verify:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: create/apply lock stake (fund); vote is consequential
  webaz_skill:               { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: unsubscribe deletes a subscription
  webaz_mykey:               { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: credential hint / recovery guidance only; the rate-limit counter is anti-abuse infra, not a data write (acceptance-pack §2)
  webaz_profile:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: switch_role overwrites the active role; views OTHER users
  webaz_revoke_key:          { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: returns Passkey/PWA instructions only — no DB write, no execution
  webaz_rotate_key:          { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: returns Passkey/PWA instructions only — no DB write, no execution
  webaz_referral:            { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: queries the caller's L1/L2/L3 downline — OTHER users' objects
  webaz_share_link:          { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read+compute: no write, but READS an active marketplace product (public object) to render the link
  webaz_blocklist:           { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: unblock DELETEs; manages relations with OTHER users
  webaz_follows:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: unfollow DELETEs the relationship (OTHER users)
  webaz_nearby:              { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: clear_location removes / set_location overwrites geo; discovers others
  webaz_default_address:     { readOnlyHint: false, destructiveHint: true,  openWorldHint: false }, // D: set OVERWRITES the caller's address; own private record
  webaz_shareables:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: delete removes a public binding
  webaz_rfq:                 { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: award→order; cancel overwrites + forfeits 30% deposit
  webaz_bid:                 { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: patch/cancel overwrite the bid; stake movement
  webaz_chat:                { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: mark_read/block overwrite state; messaging with OTHER users
  webaz_price_history:       { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: public price history
  webaz_charity:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: donate/repay move funds; cancel/confirm overwrite
  webaz_p2p_product:         { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: patch overwrites the public listing
  webaz_like:                { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: toggle DELETEs an existing like; public objects
  webaz_leaderboard:         { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: public rankings
  webaz_auction:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: cancel overwrites/removes; bid is binding
  webaz_auto_bid:            { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: set/disable OVERWRITE config; enabling changes automated bidding in the open auction market (acceptance-pack §2)
  webaz_skill_market:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: update/delist overwrite; purchase spends funds
  webaz_secondhand:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: update overwrites listing; buy moves funds (escrow)
  webaz_trial:               { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: cancel_campaign overwrites/removes a campaign
  webaz_feedback:            { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): submit INSERTs a new feedback row (no delete/overwrite); shared backlog
  webaz_contribute:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: claim overwrites task ownership on the public board
  webaz_get_agent_order:     { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: grant-scoped order read (counterparty objects)
  webaz_connection_status:   { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: this connection's own OAuth-bound identity (first-party, no marketplace/other users)
  webaz_order_action_request:{ readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): submit-only INSERT into the human approval queue; agent cannot execute
  webaz_buyer_orders:        { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: grant-scoped minimal buyer order read (RFC-025 PR-1; counterparty objects, no PII)
  webaz_discover:            { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): marketplace read + INSERTs a disclosed demand-signal row (RFC-025 PR-2); no delete/overwrite/fund
  webaz_quote_order:         { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): INSERTs an order_quotes snapshot row (RFC-025 PR-3); no order/fund/stock change
  webaz_order_draft:         { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: cancel overwrites draft status (terminal); create consumes a quote one-shot; no order/fund/stock change
  webaz_submit_order_request:{ readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): submit-only INSERT into the human approval queue (RFC-025 PR-5a); agent cannot execute
  webaz_prepare_case:        { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read: after-sales case-draft assembly (RFC-025 PR-6); no domain writes, no buyer PII (grant-path auth audit log exempt — see readOnly rule note)
  webaz_approval_requests:   { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: own approval-request status/deep links (RFC-026 PR-2); own-account only, no domain writes (grant-path audit exempt)
  webaz_wallet_view:         { readOnlyHint: true,  destructiveHint: false, openWorldHint: false }, // read: own wallet balances/refund landings (RFC-026 PR-3); OAuth wallet surface is read-only forever (grant-path audit exempt)
  webaz_order_chat:          { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): context-bound order chat (RFC-026 PR-4); send = production anti-scam path, no funds/state change
  webaz_address:             { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, // W (additive): masked read + Passkey-gated change REQUEST (RFC-026 PR-5); full address never readable by agents
  webaz_buyer_action_request:{ readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W (additive): submit-only after-sales request into the human approval queue (RFC-026 PR-6); agent cannot execute
}

interface NamedTool { readonly name: string }

/**
 * Merge the standard annotations onto the authoritative tool descriptors, by name. Fail-closed: throws
 * if any tool lacks a mapping, so an unannotated tool can never reach tools/list. Returns new objects;
 * the input descriptors are not mutated.
 */
export function annotateTools<T extends NamedTool>(tools: readonly T[]): (T & { annotations: McpToolAnnotations })[] {
  return tools.map(tool => {
    const annotations = TOOL_ANNOTATIONS[tool.name]
    if (!annotations) throw new Error(`[tool-annotations] no annotations mapped for tool "${tool.name}"`)
    return { ...tool, annotations }
  })
}
