/**
 * OpenAI Apps SDK per-tool `securitySchemes` for the shared TOOLS registry (server.ts).
 *
 * Pure data — no handler/schema/auth/business change. OpenAI reads a per-tool `securitySchemes` array to
 * decide which tools show a tool-level OAuth connect UI vs. run anonymously. Two scheme types are used:
 *   - { type: 'oauth2', scopes: [...] } — the tool is genuinely reachable through the /mcp OAuth grant
 *     path (an oat_ token retry succeeds or returns a scope-specific challenge). Declared ONLY for the
 *     tools whose grant path is real. The scopes are the COARSE OAuth scopes the client actually
 *     requests at /oauth/authorize — the exact vocabulary the authorization server supports
 *     (OAUTH_SCOPES in oauth-discovery.ts: read / order:draft / list:draft), NOT the internal
 *     fine-grained grant capabilities. The consent screen maps each coarse scope to the fine SAFE
 *     capabilities the grant carries (OAUTH_SCOPE_CAPABILITIES in oauth-approve.ts); /mcp enforcement
 *     stays capability-based. Exposing a fine capability name here would make ChatGPT request a scope
 *     the authorize endpoint rejects with invalid_scope, breaking the grant-tool OAuth flow.
 *   - { type: 'noauth' } — everything else. This is the fail-SAFE default: a public read is honestly
 *     anonymous, and an api_key-only tool is NOT advertised as OAuth-recoverable (retrying with an oat_
 *     could not succeed, so advertising oauth2 would be a FALSE recovery promise — forbidden).
 *
 * A NEW/unmapped tool defaults to noauth — never to a false oauth2 claim.
 */
export type McpSecurityScheme = { type: 'noauth' } | { type: 'oauth2'; scopes: readonly string[] }

// The ONLY grant-reachable tools + the COARSE OAuth scopes their actions need (must be a subset of
// OAUTH_SCOPES = read / order:draft / list:draft — locked by test:mcp-security-schemes). list_product is
// a mixed tool: its `mine` action needs `read` (→ seller_products_read) and its create/draft actions need
// `list:draft` (→ seller_product_draft), so it declares BOTH; its api_key-only actions still fail closed.
// get_agent_order needs `read` (→ seller_orders_read_minimal); order_action_request needs `order:draft`
// (→ order_action_request). The coarse→fine mapping lives in oauth-approve.ts OAUTH_SCOPE_CAPABILITIES.
const OAUTH_TOOL_SCOPES: Record<string, readonly string[]> = {
  webaz_list_product: ['read', 'list:draft'],
  webaz_get_agent_order: ['read'],
  webaz_connection_status: ['read'],
  webaz_order_action_request: ['order:draft'],
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
