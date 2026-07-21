/**
 * B-2 final closure — known-stale widget-template hash compat (explicit allowlist, NEVER a wildcard).
 *
 * Versioned widget URIs (`ui://widget/<name>.<hash10>.html`) are immutable content addresses. A host
 * (ChatGPT connector) may cache a tools/list for days; after a widget-content deploy its cached
 * versioned URI would 404 → "Failed to fetch template" (reproduced live 2026-07-21: connector cached
 * 2026-07-19 = 8cdd3db era, deploy was round1b). Policy decided with Holden:
 *   - outputTemplate stays the stable bare alias (served = current content, always);
 *   - current versioned URI stays immutable (served verbatim via UI_RESOLVE);
 *   - a KNOWN historical production hash resolves to CURRENT content, marked as a compat alias
 *     (retention: the last ~3 production versions per widget — see table below);
 *   - an UNKNOWN hash still fails loudly (未知资源 + server log). No wildcard fallback: silently
 *     serving current content for arbitrary hashes would mask typos, bad references and missed
 *     publishes, and would break the immutability semantics of content-addressed URIs.
 *
 * Retention table (10-hex sha256 prefixes, computed from the actual git states):
 *   8cdd3db  = phase3a-ci-green   (2026-07-19 connector-cache era — the live-reproduced stale set)
 *   a7528d5  = phase3b-round1-ui-green  (round1a)
 *   5e0dd5d  = phase3b-round1b-ui-green (round1b, == main at A1 time; A1 is byte-identical so these
 *              are ALSO the current hashes until A2 changes content — harmless overlap, UI_RESOLVE wins)
 * When A2 (or any later widget change) ships: append the then-current hashes here and prune entries
 * older than ~3 versions / 30 days. scripts/test-widget-template-compat.ts locks this table's shape.
 */

export const KNOWN_STALE_WIDGET_HASHES: Readonly<Record<string, readonly string[]>> = {
  'webaz-products':            ['c4bd5e13bb', '48c4e4cb06', '2992d4bf3f'],
  'webaz-products-mcp':        ['ea12ee851a', 'b4d9cb133c', '3b8c59d367'],
  'webaz-quote-approval':      ['6a2e96dfb1', '4e4d16d232', 'a1bb13f641'],
  'webaz-quote-approval-mcp':  ['9f5a3ea6f7', '2395886fc7', 'efba433258'],
  'webaz-order-timeline':      ['5ea1e0d365', '1e1d9f3a1b', '4c3103b1f4'],
  'webaz-order-timeline-mcp':  ['46aba2059d', 'ec18a7d9da', 'fdca310a4f'],
}

const VERSIONED_WIDGET_URI_RE = /^ui:\/\/widget\/([a-z0-9][a-z0-9-]*)\.([0-9a-f]{10})\.html$/

export interface StaleWidgetMatch { name: string; hash: string; bareUri: string }

/**
 * Explicit-allowlist match ONLY. Returns null for: non-widget URIs, bare aliases, malformed names,
 * and — critically — versioned URIs whose hash is NOT in the known table (caller must reject those
 * exactly like any unknown resource, with a log line so missed publishes stay visible).
 */
export function matchKnownStaleWidgetUri(uri: string): StaleWidgetMatch | null {
  const m = VERSIONED_WIDGET_URI_RE.exec(uri)
  if (!m) return null
  const [, name, hash] = m
  const known = KNOWN_STALE_WIDGET_HASHES[name]
  if (!known || !known.includes(hash)) return null
  return { name, hash, bareUri: `ui://widget/${name}.html` }
}

/** True iff the URI is widget-shaped-versioned but not in the allowlist (for reject-side logging). */
export function isUnknownVersionedWidgetUri(uri: string): boolean {
  return VERSIONED_WIDGET_URI_RE.test(uri) && matchKnownStaleWidgetUri(uri) === null
}
