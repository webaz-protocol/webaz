/**
 * Standard MCP tool annotations for the shared TOOLS registry (server.ts:562).
 *
 * Pure data — this changes NO inputSchema, handler, tool name, or auth/business behavior. It only adds
 * the standard MCP hints (readOnlyHint / destructiveHint / openWorldHint) so conformant clients (incl.
 * OpenAI's Apps SDK, which requires these three) get accurate confirmation metadata. Merged onto the
 * authoritative descriptors by annotateTools() at the single ListTools handler, so stdio and Remote MCP
 * return the SAME annotated surface (zero drift).
 *
 * Conservative classification (per real handler control flow, not tool name/description):
 *   - readOnlyHint=false  if ANY action writes state.
 *   - destructiveHint=true if ANY action can delete, revoke, transact/settle, pay, confirm, publish,
 *     send, or otherwise produce an irreversible/consequential effect. Multi-action tools are rated by
 *     their MOST dangerous action — never optimistically by a default read action.
 *   - openWorldHint=true  if ANY action touches shared marketplace / other parties / external objects.
 *     false ONLY for tools whose entire domain is the caller's own private, single-owner record.
 *
 * This map's key set MUST equal the live TOOLS name set — the test asserts no missing and no extra
 * tools, and annotateTools() throws if a tool has no mapping, so an unannotated tool can never ship.
 */
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly openWorldHint: boolean
}

// R = pure read · W = has a write action · D = has a delete/revoke/settle/pay/confirm/publish/send/
// irreversible action. Destructive rationale noted inline.
export const TOOL_ANNOTATIONS: Record<string, McpToolAnnotations> = {
  webaz_info:                { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
  webaz_pair:                { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: request/start SEND pairing+permission-expansion requests; complete unlinks pending state
  webaz_register:            { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: irreversibly creates account + funded wallet (no undo in this tool)
  webaz_search:              { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
  webaz_verify_price:        { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W: soft, reversible stock reservation via session token
  webaz_list_product:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: delete = permanent removal (+ delist/trash/publish)
  webaz_place_order:         { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: places binding order, moves funds (escrow/direct_p2p)
  webaz_update_order:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: confirm = irreversible fund settlement; dispute freezes funds
  webaz_get_status:          { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
  webaz_wallet:              { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // read-only balance/earnings; reflects on-chain + marketplace state
  webaz_notifications:       { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: mark_read sets read=1 with no in-tool undo (irreversible)
  webaz_dispute:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: arbitrate = irreversible fund disposition (Iron-Rule)
  webaz_claim_verify:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: vote is consequential/final; create/apply lock stake
  webaz_skill:               { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: publish makes a skill public
  webaz_mykey:               { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W: each lookup writes rate-limit state; queries the account named by a SUPPLIED handle+code (not provably the caller's own)
  webaz_profile:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: add_role permanently appends a role (this tool exposes no remove-role)
  webaz_revoke_key:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: irreversibly kills api_key, no replacement
  webaz_rotate_key:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: invalidates the old key (irreversible for it)
  webaz_referral:            { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
  webaz_share_link:          { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W: generates a referral link (no destructive effect)
  webaz_blocklist:           { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: unblock issues HTTP DELETE + DELETE FROM user_blocklist
  webaz_follows:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: unfollow deletes the relationship (DELETE FROM follows)
  webaz_nearby:              { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: clear_location removes stored geo fields
  webaz_default_address:     { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, // W: set own default address; closed, single-owner record
  webaz_shareables:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: delete removes a binding
  webaz_rfq:                 { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: award creates an order; cancel forfeits 30% deposit
  webaz_bid:                 { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: binding bid, moves/locks stake
  webaz_chat:                { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: send delivers a message to another party
  webaz_price_history:       { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
  webaz_charity:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: donate/repay move funds; confirm/cancel are consequential
  webaz_p2p_product:         { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: create publishes a public listing
  webaz_like:                { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: toggle deletes an existing like; a new like sends the owner a notification
  webaz_leaderboard:         { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
  webaz_auction:             { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: create publishes an auction; bid is binding
  webaz_auto_bid:            { readOnlyHint: false, destructiveHint: false, openWorldHint: true },  // W: get/set/disable auto-bid config (reversible)
  webaz_skill_market:        { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: purchase/read spend WAZ; publish makes public
  webaz_secondhand:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: buy creates order + escrow (funds); publish makes public
  webaz_trial:               { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: create_campaign publishes a public campaign
  webaz_feedback:            { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: submit sends/publishes feedback about a product
  webaz_contribute:          { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: suggest/claim/submit publish to the coordination board
  webaz_get_agent_order:     { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },  // grant-scoped minimal order read
  webaz_order_action_request:{ readOnlyHint: false, destructiveHint: true,  openWorldHint: true },  // D: SENDS an accept/ship request into another party's human approval queue (agent can't execute; the send itself is consequential)
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
