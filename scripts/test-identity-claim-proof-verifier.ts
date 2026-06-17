#!/usr/bin/env tsx
/**
 * PR-F3a — GitHub gist publication-proof verifier tests. NO network, NO real token (fake globalThis.fetch).
 *   用法:npm run test:identity-claim-proof-verifier
 *
 * Counter-examples first: owner mismatch · missing/forged marker · nonce mismatch · truncated (no raw_url)
 * · malformed · transport matrix (404/403/5xx/timeout/redirect) · strict-args (fetchImpl/now rejected) ·
 * fixed-origin GET/manual-redirect · token never leaked · no host escape · verifier writes no DB.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { verifyGithubGistProof, CLAIM_MARKER_PREFIX } from '../src/layer2-business/L2-9-contribution/identity-claim-proof-verifier.js'
import { sha256hex } from '../src/layer2-business/L2-9-contribution/github-credential/canonical.js'

const ORIGIN = 'https://api.github.com'
const GIST_ID = 'gist_abc123'
const ACTOR = '12345'           // stable github actor id (stringified numeric)
const CHALLENGE = 'icc_demo'
const TOKEN = 'ghp_FAKE_TEST_TOKEN_xxx_do_not_use'
const NONCE = 'WebazNonce_0123456789abcdef'
const HASH = sha256hex(NONCE)   // = expectedNonceHash for the happy path
const gistUrl = `${ORIGIN}/gists/${GIST_ID}`
const marker = `${CLAIM_MARKER_PREFIX}${CHALLENGE}:${NONCE}`

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
type Canned = { status?: number; headers?: Record<string, string>; json?: any; text?: string; throwName?: string; redirected?: boolean }
function mkResponse(c: Canned): any {
  const status = c.status ?? 200
  return {
    status, ok: status >= 200 && status < 300, redirected: c.redirected ?? false, type: 'default',
    headers: { get: (k: string) => (c.headers ?? {})[k.toLowerCase()] ?? null },
    json: async () => { if (c.text !== undefined) throw new Error('not json'); return c.json },
    text: async () => c.text ?? JSON.stringify(c.json ?? {}),
  }
}
function fakeFetch(routes: Record<string, Canned>, capture?: Array<{ url: string; init: any }>) {
  return (async (url: any, init: any) => {
    capture?.push({ url: String(url), init })
    const c = routes[String(url)]
    if (!c) return mkResponse({ status: 404, json: { message: 'Not Found' } })
    if (c.throwName) { const e = new Error('boom'); (e as any).name = c.throwName; throw e }
    return mkResponse(c)
  }) as unknown as typeof globalThis.fetch
}
async function withFetch<T>(routes: Record<string, Canned>, cap: Array<{ url: string; init: any }> | undefined, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch; globalThis.fetch = fakeFetch(routes, cap)
  try { return await fn() } finally { globalThis.fetch = orig }
}
const gistBody = (o: any = {}) => ({ id: GIST_ID, owner: { id: 12345, login: 'alice' }, public: true, truncated: false, EXTRA_GH_FIELD: 'ignored', files: { 'proof.txt': { filename: 'proof.txt', content: `hello\n${marker}\nbye`, truncated: false, raw_url: 'https://gist.githubusercontent.com/raw/x' } }, ...o })
const base = { gistId: GIST_ID, githubActorId: ACTOR, challengeId: CHALLENGE, expectedNonceHash: HASH, token: TOKEN }
const noLeak = (r: unknown) => !JSON.stringify(r).includes(TOKEN) && !/authorization/i.test(JSON.stringify(r))

async function main(): Promise<void> {
  // 1) happy path
  { const cap: Array<{ url: string; init: any }> = []
    const r = await withFetch({ [gistUrl]: { json: gistBody() } }, cap, () => verifyGithubGistProof(base))
    ok('happy: verified', r.ok && r.github_actor_id === ACTOR && r.challenge_id === CHALLENGE, JSON.stringify(r))
    ok('happy: no token leak', noLeak(r))
    // 9) fixed origin, GET, manual redirect, single call to /gists/<id>
    ok('fetch: only api.github.com/gists/<id>', cap.length === 1 && cap[0].url === gistUrl)
    ok('fetch: GET + redirect manual', cap[0].init.method === 'GET' && cap[0].init.redirect === 'manual')
    ok('fetch: Authorization Bearer sent to api.github.com only', cap[0].init.headers.Authorization === `Bearer ${TOKEN}`) }

  // public gist with NO token still works (token optional)
  { const r = await withFetch({ [gistUrl]: { json: gistBody() } }, undefined, () => verifyGithubGistProof({ ...base, token: undefined }))
    ok('public gist, no token → verified', r.ok === true) }

  // 2) owner.id mismatch
  { const r = await withFetch({ [gistUrl]: { json: gistBody({ owner: { id: 99999, login: 'mallory' } }) } }, undefined, () => verifyGithubGistProof(base))
    ok('owner.id mismatch → owner_mismatch', !r.ok && r.outcome === 'owner_mismatch', JSON.stringify(r)) }
  { const r = await withFetch({ [gistUrl]: { json: gistBody({ owner: null }) } }, undefined, () => verifyGithubGistProof(base))
    ok('anonymous gist (owner null) → owner_mismatch', !r.ok && r.outcome === 'owner_mismatch') }

  // 3) marker missing → proof_not_found
  { const r = await withFetch({ [gistUrl]: { json: gistBody({ files: { 'a.txt': { content: 'nothing here', truncated: false } } }) } }, undefined, () => verifyGithubGistProof(base))
    ok('marker missing → proof_not_found', !r.ok && r.outcome === 'proof_not_found', JSON.stringify(r)) }
  // marker for a DIFFERENT challenge id → not found for THIS challenge
  { const r = await withFetch({ [gistUrl]: { json: gistBody({ files: { 'a.txt': { content: `${CLAIM_MARKER_PREFIX}icc_other:${NONCE}`, truncated: false } } }) } }, undefined, () => verifyGithubGistProof(base))
    ok('marker for other challenge → proof_not_found', !r.ok && r.outcome === 'proof_not_found') }

  // 4) nonce hash mismatch (marker present, wrong nonce)
  { const r = await withFetch({ [gistUrl]: { json: gistBody({ files: { 'a.txt': { content: `${CLAIM_MARKER_PREFIX}${CHALLENGE}:WRONGNONCE123456`, truncated: false } } }) } }, undefined, () => verifyGithubGistProof(base))
    ok('wrong nonce → nonce_mismatch', !r.ok && r.outcome === 'nonce_mismatch', JSON.stringify(r)) }

  // 5) truncated file → proof_truncated; raw_url NEVER fetched
  { const cap: Array<{ url: string; init: any }> = []
    const r = await withFetch({ [gistUrl]: { json: gistBody({ files: { 'big.txt': { content: 'partial...', truncated: true, raw_url: 'https://gist.githubusercontent.com/raw/big' } } }) } }, cap, () => verifyGithubGistProof(base))
    ok('truncated file → proof_truncated', !r.ok && r.outcome === 'proof_truncated', JSON.stringify(r))
    ok('truncated → raw_url NOT fetched (only the gist endpoint)', cap.length === 1 && cap[0].url === gistUrl) }
  { const r = await withFetch({ [gistUrl]: { json: gistBody({ truncated: true, files: { 'a.txt': { content: 'x', truncated: false } } }) } }, undefined, () => verifyGithubGistProof(base))
    ok('top-level truncated (no marker) → proof_truncated', !r.ok && r.outcome === 'proof_truncated') }

  // 6) malformed response
  { const r = await withFetch({ [gistUrl]: { json: { not: 'a gist' } } }, undefined, () => verifyGithubGistProof(base))
    ok('malformed gist (no files) → malformed_response', !r.ok && r.outcome === 'malformed_response', JSON.stringify(r)) }
  { const r = await withFetch({ [gistUrl]: { text: '<html>nope</html>' } }, undefined, () => verifyGithubGistProof(base))
    ok('non-JSON gist → malformed_response', !r.ok && r.outcome === 'malformed_response') }

  // 7) transport matrix
  type T = [string, Canned, string]
  for (const [name, canned, expected] of [
    ['404', { status: 404, json: {} }, 'not_found'],
    ['403 rate limit', { status: 403, headers: { 'x-ratelimit-remaining': '0' }, json: {} }, 'rate_limited'],
    ['429', { status: 429, json: {} }, 'rate_limited'],
    ['500', { status: 500, json: {} }, 'upstream_unavailable'],
    ['network error', { throwName: 'TypeError' }, 'upstream_unavailable'],
    ['timeout/abort', { throwName: 'AbortError' }, 'timeout'],
    ['redirect (manual, not followed)', { status: 301, headers: { location: 'https://evil.example' } }, 'upstream_unavailable'],
  ] as T[]) {
    let threw = false; let r: any
    try { r = await withFetch({ [gistUrl]: canned }, undefined, () => verifyGithubGistProof(base)) } catch { threw = true }
    ok(`transport: ${name} → ${expected} (no throw)`, !threw && r && r.ok === false && r.outcome === expected, threw ? 'THREW' : JSON.stringify(r?.outcome))
    if (r) ok(`transport: ${name} → no token leak`, noLeak(r))
  }

  // 8) strict args — fetchImpl / now / unknown keys rejected; no network performed
  for (const [name, args] of [
    ['fetchImpl injected', { ...base, fetchImpl: () => { throw new Error('nope') } }],
    ['now injected', { ...base, now: new Date('2020-01-01') }],
    ['unknown key', { ...base, owner: { id: 1 } }],
    ['bad expectedNonceHash (not 64 hex)', { ...base, expectedNonceHash: 'short' }],
    ['missing gistId', { githubActorId: ACTOR, challengeId: CHALLENGE, expectedNonceHash: HASH }],
  ] as Array<[string, any]>) {
    const cap: Array<{ url: string; init: any }> = []
    const r = await withFetch({ [gistUrl]: { json: gistBody() } }, cap, () => verifyGithubGistProof(args))
    ok(`strict: ${name} → invalid_request`, !r.ok && r.outcome === 'invalid_request', JSON.stringify(r))
    ok(`strict: ${name} → no network`, cap.length === 0)
    ok(`strict: ${name} → no token leak`, noLeak(r))
  }

  // 11) host escape: a gistId with path-escape stays under api.github.com (404, not an off-origin fetch)
  { const cap: Array<{ url: string; init: any }> = []
    await withFetch({}, cap, () => verifyGithubGistProof({ ...base, gistId: '../../evil.example' }))
    ok('host-escape: all requests stay on api.github.com', cap.every(c => new URL(c.url).origin === ORIGIN)) }

  // 12) verifier writes NO database (source carries no SQL / db access)
  { const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'layer2-business', 'L2-9-contribution', 'identity-claim-proof-verifier.ts'), 'utf8')
    ok('verifier source has no DB access', !/(db\.prepare|dbRun\(|dbOne\(|dbAll\(|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|seamSqliteHandle)/i.test(src)) }

  console.log('\ntest:identity-claim-proof-verifier')
  console.log('──────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ gist proof verifier: re-fetch trust-root, strict owner.id, marker+nonce-hash, truncated→no raw_url, typed outcomes, no token leak, no DB\n')
}

// no-network sentinel: outside an explicit withFetch swap, any real fetch THROWS.
const realFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error('REAL NETWORK BLOCKED IN TEST') }) as any
main().catch(e => { console.error(e); process.exit(1) }).finally(() => { globalThis.fetch = realFetch })
