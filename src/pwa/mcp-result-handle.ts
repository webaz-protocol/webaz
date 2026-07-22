/**
 * MCP result_handle issuance (single source for webaz_search + webaz_discover).
 *
 * A result_handle is a zero-payload 10-min token that stores ONLY a set of product ids for later
 * `webaz_search({ result_handle, selected_ids })` detail-fetch (which re-reads each id live through the
 * active-visibility predicate — the handle never carries product data). Extracted so the search LIST
 * route and the DISCOVER route issue handles identically (Codex altitude: one contract, no drift).
 *
 * Non-fatal: returns null on empty input or on a cache-write failure — the caller's result still
 * returns (the handle is an affordance, not a hard dependency), with an observable warn on failure.
 */
import { randomBytes } from 'node:crypto'
import { dbRun } from '../layer0-foundation/L0-1-database/db.js'

export async function issueResultHandle(ids: string[], tool = 'webaz_search', context: Record<string, unknown> = {}): Promise<string | null> {
  if (!ids.length) return null
  const handle = 'res_' + randomBytes(16).toString('hex')
  try {
    await dbRun("INSERT INTO mcp_result_cache (handle_id, subject, tool, item_ids, context, expires_at) VALUES (?,?,?,?,?, datetime('now','+10 minutes'))",
      [handle, null, tool, JSON.stringify(ids), JSON.stringify(context)])
    return handle
  } catch (e) {
    console.warn('[result-handle] issue failed:', (e as Error).message)
    return null
  }
}
