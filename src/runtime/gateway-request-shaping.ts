/**
 * RFC-028 S2b-2a: PURE request shaping for the Agent Gateway limiter. Turns HTTP-boundary primitives into a
 * GatewayLimitInput (cost_class + dimension values) for evaluateGatewayLimits/Async. No I/O, no store, no
 * Express types — the impure extraction from `req` lives in the wiring layer (S2b-2b) and calls these.
 *
 * Two jobs:
 *  1. normalizeIpDimension — bound the `ip` dimension's CARDINALITY (the F1/S2b storage-DoS fix): an IPv6
 *     host owns 2^64 addresses, so collapse every address to its /64 network → one bucket per /64. IPv4 is
 *     not the cardinality problem and is kept whole.
 *  2. classifyMcpCostClass — derive the §8.2 cost class from the MCP method + the tool's standard annotation
 *     (readOnly/destructive), which is the CI-guaranteed single source of truth (TOOL_ANNOTATIONS). Deriving
 *     from annotations rather than a parallel name map means this cannot drift from the real tool surface.
 */
import type { GatewayCostClass, GatewayLimitInput } from './gateway-limits.js'

function isValidIpv4(v4: string): boolean {
  const parts = v4.split('.')
  if (parts.length !== 4) return false
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** Expand a pure-IPv6 literal to 8 canonical (no-leading-zero) hextets, or null if malformed. */
function expandIpv6(ip: string): string[] | null {
  const halves = ip.split('::')
  if (halves.length > 2) return null   // at most one '::'
  const toGroups = (s: string): string[] | null => {
    if (s === '') return []
    const g = s.split(':')
    for (const h of g) if (!/^[0-9a-f]{1,4}$/.test(h)) return null
    return g
  }
  const left = toGroups(halves[0]!)
  if (left === null) return null
  let groups: string[]
  if (halves.length === 1) {
    if (left.length !== 8) return null   // no '::' → must be a full 8-group address
    groups = left
  } else {
    const right = toGroups(halves[1]!)
    if (right === null) return null
    const zeros = 8 - left.length - right.length
    if (zeros < 1) return null           // '::' must compress at least one group
    groups = [...left, ...Array(zeros).fill('0'), ...right]
  }
  return groups.map(h => parseInt(h, 16).toString(16))   // canonicalize: strip leading zeros, lower-case
}

/**
 * Normalize a raw client IP into a stable, cardinality-bounded limiter value. IPv6 → its /64 network so a
 * whole host/subnet shares one bucket; embedded/mapped IPv4 (::ffff:1.2.3.4) and plain IPv4 → the IPv4
 * address. Anything unparseable → '' so the caller SKIPS the ip dimension (fail-safe: never key on garbage).
 */
export function normalizeIpDimension(rawIp: string): string {
  const ip = String(rawIp ?? '').trim().toLowerCase()
  if (!ip || ip.length > 45 || !/^[0-9a-f:.]+$/.test(ip)) return ''
  if (ip.includes('.')) {
    // plain IPv4, or IPv4-mapped/embedded IPv6 whose trailing token is the IPv4 address
    const embed = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip)
    const v4 = embed ? embed[1]! : ip
    return isValidIpv4(v4) ? v4 : ''
  }
  const hextets = expandIpv6(ip)
  if (!hextets) return ''
  return hextets.slice(0, 4).join(':') + '::/64'
}

/** The annotation fields the classifier reads. A subset of McpToolAnnotations (kept local so this module has
 *  no dependency on the layer1 MCP server); the wiring layer passes TOOL_ANNOTATIONS[toolName]. */
export interface McpCostAnnotation {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
}

/**
 * Map an MCP request to its §8.2 cost class from the method and the tool's annotation.
 *  - transport/metadata methods (initialize, tools/list, notifications/*, ping) → public_low (cheap, cacheable)
 *  - tools/call:
 *      · unmapped tool name (annotation undefined) → high  (fail-safe strict: an unknown tool gets no cheap budget)
 *      · destructive (deletes/overwrites state or moves funds) → economic (strict INITIATION cap; never shed post-commit)
 *      · additive write (readOnly=false, destructive=false: register/pair/verify_price) → high
 *      · read (readOnly=true) → private_read
 * `medium` is intentionally unused by this initial map; it is reserved for address/quote tools and refined
 * once shadow-mode traffic shows where finer budgets are warranted.
 */
export function classifyMcpCostClass(method: string, annotation: McpCostAnnotation | undefined): GatewayCostClass {
  if (method !== 'tools/call') return 'public_low'
  if (!annotation) return 'high'
  if (annotation.destructiveHint) return 'economic'
  if (!annotation.readOnlyHint) return 'high'
  return 'private_read'
}

export interface McpLimitInputParts {
  readonly method: string
  readonly toolName?: string
  readonly annotation?: McpCostAnnotation
  readonly ip: string
  /** stable client identifier when cheaply available (e.g. DPoP gateway client id); omit otherwise. */
  readonly clientId?: string
  /** stable account/subject identifier when cheaply available; omit for anonymous. */
  readonly subject?: string
}

/**
 * Assemble the GatewayLimitInput for an MCP request. Always sets the `global` dimension to the cost_class
 * name so every request of a class shares ONE whole-service bucket (counted only for classes whose policy
 * declares a global budget). ip is normalized; client/subject are included only when present. Absent
 * dimensions are simply omitted — planGatewayLimitChecks skips them.
 */
export function buildMcpLimitInput(parts: McpLimitInputParts): GatewayLimitInput {
  const cost_class = classifyMcpCostClass(parts.method, parts.annotation)
  const dims: Record<string, string> = { global: cost_class }
  const ip = normalizeIpDimension(parts.ip)
  if (ip) dims.ip = ip
  if (parts.clientId) dims.client = parts.clientId
  if (parts.subject) dims.subject = parts.subject
  return { cost_class, dims }
}
