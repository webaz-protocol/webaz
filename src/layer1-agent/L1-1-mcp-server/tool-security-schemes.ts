/**
 * OpenAI Apps SDK per-tool `securitySchemes` for the shared TOOLS registry (server.ts).
 *
 * Pure data — no handler/schema/auth/business change. OpenAI reads a per-tool `securitySchemes` array to
 * decide which tools show a tool-level OAuth connect UI vs. run anonymously. Two scheme types are used:
 *   - { type: 'oauth2', scopes: [...] } — the tool is genuinely reachable through the /mcp OAuth grant
 *     path (an oat_ token retry succeeds or returns a scope-specific 403). Declared ONLY for the tools
 *     whose grant path is real; the scopes are the exact safe grant scopes the tool's actions need
 *     (see agent-grants.ts requireAgentGrantScope mounts + mcp-remote.ts scopeForAuthOnlyCall).
 *   - { type: 'noauth' } — everything else. This is the fail-SAFE default: a public read is honestly
 *     anonymous, and an api_key-only tool is NOT advertised as OAuth-recoverable (retrying with an oat_
 *     could not succeed, so advertising oauth2 would be a FALSE recovery promise — forbidden).
 *
 * A NEW/unmapped tool defaults to noauth — never to a false oauth2 claim.
 */
export type McpSecurityScheme = { type: 'noauth' } | { type: 'oauth2'; scopes: readonly string[] }

// The ONLY grant-reachable tools + their exact safe scopes. list_product is a mixed tool: its grant
// actions (mine → seller_products_read, create/draft → seller_product_draft) are reachable via OAuth;
// its api_key-only actions still fail closed. Declaring the UNION of the two catalog scopes is accurate
// for the reachable actions (acceptance-pack §3).
const OAUTH_TOOL_SCOPES: Record<string, readonly string[]> = {
  webaz_list_product: ['seller_products_read', 'seller_product_draft'],
  webaz_get_agent_order: ['seller_orders_read_minimal'],
  webaz_order_action_request: ['order_action_request'],
}

/** The securitySchemes for a tool: oauth2 (with scopes) iff grant-reachable, else the noauth default. */
export function securitySchemesFor(toolName: string): McpSecurityScheme[] {
  const scopes = OAUTH_TOOL_SCOPES[toolName]
  return scopes ? [{ type: 'oauth2', scopes }] : [{ type: 'noauth' }]
}

interface NamedTool { readonly name: string }

/** Merge per-tool securitySchemes onto the tool descriptors (by name). Returns new objects. */
export function withSecuritySchemes<T extends NamedTool>(tools: readonly T[]): (T & { securitySchemes: McpSecurityScheme[] })[] {
  return tools.map(tool => ({ ...tool, securitySchemes: securitySchemesFor(tool.name) }))
}
