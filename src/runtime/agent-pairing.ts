/**
 * RFC-020 PR-C1 — pairing primitives (pure, no DB/network).
 *
 * PKCE (RFC 7636, S256) + short one-time code / id generation + TTL. Shared by the
 * PWA pairing routes and the MCP `webaz_pair` tool so both compute the challenge the
 * same way. PR-C1 is pairing + credential delivery ONLY — no scope enforcement
 * (that is PR-C2), no money/order/wallet code.
 */
import { createHash, randomBytes } from 'node:crypto'

/** base64url (no padding). */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE code_verifier — high-entropy URL-safe string (RFC 7636 §4.1). */
export function generateCodeVerifier(): string {
  return b64url(randomBytes(48)) // ~64 chars
}

/** PKCE S256 challenge = base64url(sha256(verifier)). */
export function pkceChallengeS256(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest())
}

/** Constant-shape PKCE check: the verifier must hash to the stored challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== 'string' || typeof challenge !== 'string' || !verifier || !challenge) return false
  const computed = pkceChallengeS256(verifier)
  // length-guarded compare (challenges are fixed-length base64url of a sha256)
  if (computed.length !== challenge.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ challenge.charCodeAt(i)
  return diff === 0
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32 (no I/L/O/U)
/** Short, human-approvable one-time pairing code. */
export function generateUserCode(len = 10): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

/** Pairing session TTL — short by design (RFC-020 §3.6). */
export const PAIRING_TTL_DEFAULT_SEC = 600       // 10 min to approve + retrieve
export const PAIRING_TTL_MAX_SEC = 1800          // 30 min cap
export function clampPairingTtlSeconds(requested: unknown): number {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return PAIRING_TTL_DEFAULT_SEC
  return Math.min(Math.floor(n), PAIRING_TTL_MAX_SEC)
}

export type PairingStatus = 'pending' | 'approved' | 'consumed' | 'expired' | 'revoked'

export interface PairingRow {
  status?: string
  expires_at?: string
  consumed_at?: string | null
}

/** A pairing can be approved only while pending + unexpired. */
export function pairingApprovable(p: PairingRow, nowIso: string): boolean {
  return !!p && p.status === 'pending' && !!p.expires_at && p.expires_at > nowIso
}

/** A pairing can be retrieved only while approved, unexpired, and not yet consumed. */
export function pairingRetrievable(p: PairingRow, nowIso: string): boolean {
  return !!p && p.status === 'approved' && !p.consumed_at && !!p.expires_at && p.expires_at > nowIso
}
