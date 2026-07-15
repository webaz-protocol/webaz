/**
 * RFC-024 verified-connector allowlist. A DCR client is shown as "verified" on the consent screen only
 * when EVERY one of its registered redirect_uris points at a host we recognise as an official connector
 * vendor. The redirect host is a TRUSTWORTHY signal — only the party that controls that host can receive
 * the authorization code — unlike the self-declared client_name, which anyone can spoof. If a client
 * mixes an allowlisted host with ANY other host, it is NOT verified: the non-allowlisted host could be
 * attacker-controlled and receive the code.
 *
 * Matching is exact-host OR a dot-suffix subdomain of a base (`auth.claude.ai` matches base `claude.ai`),
 * never a loose substring — so `claude.ai.evil.com` does NOT match `claude.ai`.
 *
 * This is display-only. It does not widen any capability, scope, or redirect_uri policy; an unverified
 * client is exactly as (un)privileged as a verified one. Extend the list as official connectors appear.
 */
export interface VerifiedConnector {
  readonly label: string
  readonly hosts: readonly string[]
}

export const VERIFIED_CONNECTORS: readonly VerifiedConnector[] = [
  { label: 'Claude (Anthropic)', hosts: ['claude.ai', 'claude.com', 'anthropic.com'] },
  { label: 'ChatGPT (OpenAI)', hosts: ['chatgpt.com', 'openai.com'] },
  { label: 'Cursor', hosts: ['cursor.com', 'cursor.sh'] },
  { label: 'VS Code', hosts: ['vscode.dev'] },
]

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith('.' + base)
}

/**
 * The vendor label whose hosts cover ALL redirect_uris, or null. Requires ≥1 uri; every uri must parse
 * and its host must belong to the SAME single vendor. Any parse failure or non-allowlisted host → null.
 */
export function verifiedConnectorLabel(redirectUris: readonly string[]): string | null {
  if (!redirectUris.length) return null
  const hosts: string[] = []
  for (const uri of redirectUris) {
    let host: string
    try { host = new URL(uri).hostname.toLowerCase() } catch { return null }
    if (!host) return null
    hosts.push(host)
  }
  for (const connector of VERIFIED_CONNECTORS) {
    if (hosts.every(h => connector.hosts.some(base => hostMatches(h, base)))) {
      return connector.label   // vendor host sets are disjoint → at most one matches all
    }
  }
  return null
}
