/**
 * @webaz/agent-template — minimal starter for third-party WebAZ agents.
 *
 * Spec: docs/AGENT-GOVERNANCE.md
 *
 * What this does:
 * - Wraps fetch with auth header
 * - Auto-backoff on 429 (rate-limited)
 * - Refuses to call when AGENT_BLOCKED (strike or revocation active)
 * - Helper to submit your agent declaration
 *
 * Usage:
 *   const agent = new WebazAgent({ apiKey: 'YOUR_KEY' })
 *   await agent.declare({ operator_name: 'Acme', purpose: '...', declared_scope: {...} })
 *   const products = await agent.call('GET', '/api/products?q=coffee')
 */

export interface AgentDeclaration {
  operator_name: string
  operator_contact: string
  purpose: string
  declared_scope: { roles: string[]; actions: string[]; regions: string[] }
  attestations?: Record<string, boolean>
  repo_url?: string
  homepage?: string
}

export interface AgentConfig {
  apiKey: string
  baseUrl?: string
  maxRetries?: number
}

export class AgentBlockedError extends Error {
  constructor(public reason: string) { super(`Agent blocked: ${reason}`) }
}
export class HumanPresenceRequiredError extends Error {
  constructor(public detail: string) { super(`Human presence required: ${detail}`) }
}

export class WebazAgent {
  private apiKey: string
  private baseUrl: string
  private maxRetries: number
  private blocked = false
  private blockReason = ''

  constructor(cfg: AgentConfig) {
    this.apiKey = cfg.apiKey
    this.baseUrl = cfg.baseUrl ?? 'http://localhost:3000'
    this.maxRetries = cfg.maxRetries ?? 5
  }

  /** Submit / update the agent declaration. Required for trust > new. */
  async declare(d: AgentDeclaration): Promise<{ ok: boolean }> {
    return this.call('POST', '/api/me/agents/declarations', d) as Promise<{ ok: boolean }>
  }

  /** Look up your own reputation + declaration state */
  async status(): Promise<unknown> {
    return this.call('GET', '/api/me/agents')
  }

  /**
   * Wrapper around fetch. Handles:
   * - 403 AGENT_BLOCKED → throw AgentBlockedError, agent disabled for session
   * - 412 HUMAN_PRESENCE_REQUIRED → throw HumanPresenceRequiredError (agent cannot bypass)
   * - 429 AGENT_RATE_LIMITED → exponential backoff retry
   * - other errors → return as-is
   */
  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.blocked) throw new AgentBlockedError(this.blockReason)

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })

      // 429 → backoff retry
      if (res.status === 429) {
        const json = await res.json().catch(() => ({} as Record<string, unknown>))
        const wait = Number((json as { window_seconds_left?: number }).window_seconds_left || 1) * 1000
        const delay = Math.min(wait, 1000 * 2 ** attempt)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      // 403 AGENT_BLOCKED → agent disabled
      if (res.status === 403) {
        const json = await res.json().catch(() => ({} as Record<string, unknown>))
        if ((json as { error_code?: string }).error_code === 'AGENT_BLOCKED') {
          this.blocked = true
          this.blockReason = (json as { error?: string }).error || 'agent blocked'
          throw new AgentBlockedError(this.blockReason)
        }
        return json
      }

      // 412 HUMAN_PRESENCE_REQUIRED → can't bypass
      if (res.status === 412) {
        const json = await res.json().catch(() => ({} as Record<string, unknown>))
        if ((json as { error_code?: string }).error_code === 'HUMAN_PRESENCE_REQUIRED') {
          throw new HumanPresenceRequiredError((json as { error?: string }).error || 'human required')
        }
      }

      return res.json().catch(() => ({}))
    }
    throw new Error(`Exceeded ${this.maxRetries} retries on ${method} ${path}`)
  }
}

// Demo (run with: tsx src/index.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`@webaz/agent-template demo
Usage:
  const agent = new WebazAgent({ apiKey: 'YOUR_KEY' })
  await agent.declare({ operator_name: 'Acme', purpose: '...', declared_scope: { roles:['buyer'], actions:['search'], regions:['*'] } })
  const products = await agent.call('GET', '/api/products?q=coffee')
`)
}
