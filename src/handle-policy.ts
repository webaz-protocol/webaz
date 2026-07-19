/**
 * Public-handle policy shared by the human PWA and MCP registration paths.
 *
 * Handles are used in @mentions and recommendation anchors (`@name:code`).
 * They must not impersonate WebAZ, system identifiers, credential prefixes,
 * or agent/control-plane identities.
 */

export type HandlePolicyIssue = 'HANDLE_DELIMITER_RESERVED' | 'HANDLE_RESERVED'

const LEGACY_RESERVED_PREFIXES = [
  'usr', 'sys', 'admin', 'anonymous', 'null',
]

const CREDENTIAL_PREFIXES = ['key', 'oat', 'gtk', 'grt', 'agt']

const CONTROL_PLANE_WORDS = [
  'root', 'system', 'protocol', 'official', 'support', 'security', 'moderator', 'staff',
  'undefined', 'deleted',
  'agent', 'bot', 'ai', 'assistant', 'mcp', 'oauth', 'api', 'passkey', 'token',
  'grant', 'tool', 'skill', 'plugin',
  'buyer', 'seller', 'logistics', 'arbitrator', 'verifier',
]

function isExactOrSegmentPrefix(value: string, word: string): boolean {
  return value === word || value.startsWith(`${word}_`) || value.startsWith(`${word}.`)
}

/**
 * Returns the policy issue for a normalized candidate. `:` is reserved as the
 * recommendation-anchor delimiter, so it gets a precise error before generic
 * character validation obscures the reason.
 */
export function getHandlePolicyIssue(input: string): HandlePolicyIssue | null {
  const value = String(input || '').trim().toLowerCase()
  if (value.includes(':')) return 'HANDLE_DELIMITER_RESERVED'

  // WebAZ lookalikes such as web.az and web_az must not become public handles.
  const compact = value.replace(/[._]/g, '')
  if (compact.startsWith('webaz')) return 'HANDLE_RESERVED'

  if (LEGACY_RESERVED_PREFIXES.some(prefix => value.startsWith(prefix))) return 'HANDLE_RESERVED'
  if (CREDENTIAL_PREFIXES.some(prefix => isExactOrSegmentPrefix(value, prefix))) return 'HANDLE_RESERVED'
  if (CONTROL_PLANE_WORDS.some(word => isExactOrSegmentPrefix(value, word))) return 'HANDLE_RESERVED'
  return null
}

export function isReservedHandle(input: string): boolean {
  return getHandlePolicyIssue(input) === 'HANDLE_RESERVED'
}

/** Normalizes a display name into a safe base for automatic handle creation. */
export function deriveHandleBase(name: string): string {
  let base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  base = base.replace(/[^a-zA-Z0-9._]/g, '').toLowerCase()
  base = base.replace(/^[._]+|[._]+$/g, '')
  if (base.length < 3) base = 'user' + Math.random().toString(36).slice(2, 7)
  if (base.length > 18) base = base.slice(0, 18)
  return isReservedHandle(base) ? `u_${base}` : base
}

export function handlePolicyMessage(issue: HandlePolicyIssue): string {
  return issue === 'HANDLE_DELIMITER_RESERVED'
    ? '用户名不能包含 :（该符号用于推荐口令分隔）'
    : '该用户名或前缀被系统保留'
}
