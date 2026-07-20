/**
 * RFC-028 S1c3: one-use, process-local handoff from a verified Remote MCP
 * request to the existing /api/agent/* resource routes.
 *
 * A DPoP proof is bound to POST https://webaz.xyz/mcp and cannot be replayed
 * against the MCP server's internal resource request. Instead, the verified,
 * module-branded Gateway context travels in AsyncLocalStorage until apiCall()
 * mints an opaque one-use ticket. The ticket is sent only over 127.0.0.1 and
 * is bound to the bearer, method, exact path/query and serialized body.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  requireAgentGatewayContext,
  type AgentGatewayContext,
} from './agent-gateway-proof.js'

const HANDOFF_HEADER = 'x-webaz-agent-gateway-handoff'
const HANDOFF_RE = /^agh_[A-Za-z0-9_-]{43}$/
const HANDOFF_TTL_MS = 15_000
const MAX_PENDING_HANDOFFS = 1_024

interface GatewayCallContext {
  context: AgentGatewayContext
  loopback_base_url: string
  active: boolean
}

interface PendingHandoff {
  context: AgentGatewayContext
  bearer_hash: string
  method: string
  path: string
  body_hash: string
  expires_at_ms: number
}

const gatewayCallContext = new AsyncLocalStorage<GatewayCallContext>()
const pendingHandoffs = new Map<string, PendingHandoff>()

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && !!url.port && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

function isGatewayResourcePath(path: string): boolean {
  return path.startsWith('/api/agent/') || path === '/api/agent-grants/connection'
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

function pruneExpired(nowMs: number): void {
  for (const [key, value] of pendingHandoffs) {
    if (value.expires_at_ms <= nowMs) pendingHandoffs.delete(key)
  }
}

export function agentGatewayHandoffHeaderName(): string {
  return HANDOFF_HEADER
}

export async function runWithAgentGatewayContext<T>(
  context: AgentGatewayContext | undefined,
  loopbackBaseUrl: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!context) return await fn()
  requireAgentGatewayContext(context)
  if (!loopbackBaseUrl || !validLoopbackBaseUrl(loopbackBaseUrl)) {
    throw new Error('trusted Agent Gateway loopback is unavailable')
  }
  const lease: GatewayCallContext = { context, loopback_base_url: loopbackBaseUrl, active: true }
  return gatewayCallContext.run(lease, async () => {
    try { return await fn() }
    finally { lease.active = false }
  })
}

export function issueAgentGatewayHandoff(input: {
  bearer: string
  method: string
  path: string
  serialized_body: string
  now_ms?: number
}): { ticket: string; loopback_base_url: string } | null {
  const active = gatewayCallContext.getStore()
  if (!active?.active || !isGatewayResourcePath(input.path)) return null
  requireAgentGatewayContext(active.context)
  const method = input.method.toUpperCase()
  if (!/^[A-Z]+$/.test(method) || !input.bearer) return null
  const nowMs = input.now_ms ?? Date.now()
  pruneExpired(nowMs)
  if (pendingHandoffs.size >= MAX_PENDING_HANDOFFS) {
    throw new Error('trusted Agent Gateway handoff capacity is exhausted')
  }

  const ticket = `agh_${randomBytes(32).toString('base64url')}`
  pendingHandoffs.set(sha256(ticket), {
    context: active.context,
    bearer_hash: sha256(input.bearer),
    method,
    path: input.path,
    body_hash: sha256(input.serialized_body),
    expires_at_ms: nowMs + HANDOFF_TTL_MS,
  })
  return { ticket, loopback_base_url: active.loopback_base_url }
}

export function consumeAgentGatewayHandoff(input: {
  ticket: string | undefined
  bearer: string
  method: string
  path: string
  serialized_body: string
  is_loopback: boolean
  now_ms?: number
}): AgentGatewayContext | null {
  if (!input.is_loopback || !input.ticket || !HANDOFF_RE.test(input.ticket)) return null
  const key = sha256(input.ticket)
  const pending = pendingHandoffs.get(key)
  pendingHandoffs.delete(key) // burn on first presentation, including mismatches
  if (!pending) return null
  const nowMs = input.now_ms ?? Date.now()
  if (pending.expires_at_ms <= nowMs) return null
  if (pending.method !== input.method.toUpperCase() || pending.path !== input.path) return null
  if (!safeEqualHex(pending.bearer_hash, sha256(input.bearer))) return null
  if (!safeEqualHex(pending.body_hash, sha256(input.serialized_body))) return null
  return requireAgentGatewayContext(pending.context)
}
