#!/usr/bin/env tsx
/**
 * PR 4b-R — exported authenticated-read primitive (getJson) origin enforcement. NO network.
 *   用法:npm run test:github-authenticated-read
 *
 * getJson attaches Authorization, so as an EXPORTED function it MUST refuse any URL that is not
 * exactly https://api.github.com BEFORE calling fetch (Codex P1 — else a caller-supplied off-origin
 * URL leaks the token). A capturing fake fetchImpl proves no off-origin call / no Authorization leak.
 */
import { getJson, pathFromOrigin } from '../src/layer2-business/L2-9-contribution/github-credential/github-fetch-adapter.js'

const TOKEN = 'ghp_FAKE_TEST_TOKEN_xxx'
let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function capturingFetch(): { fn: typeof globalThis.fetch; calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = []
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return { status: 200, ok: true, redirected: false, type: 'default', headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => '{}' } as any
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

async function main(): Promise<void> {
  // 1) off-origin URL → refused, fetchImpl NEVER called, no Authorization leak
  { const { fn, calls } = capturingFetch()
    const r = await getJson(fn, 'https://evil.example/x', TOKEN, 1000)
    ok('off-origin → typed fail invalid_request', r.kind === 'fail' && (r as any).outcome === 'invalid_request', JSON.stringify(r))
    ok('off-origin → fetchImpl NOT called', calls.length === 0)
    ok('off-origin → no token / url leak in result', !JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes('evil.example')) }

  // 2) http (not https) same host → refused
  { const { fn, calls } = capturingFetch()
    const r = await getJson(fn, 'http://api.github.com/x', TOKEN, 1000)
    ok('http scheme → typed fail invalid_request', r.kind === 'fail' && (r as any).outcome === 'invalid_request')
    ok('http scheme → fetchImpl NOT called', calls.length === 0) }

  // 2b) malformed URL → refused, not called
  { const { fn, calls } = capturingFetch()
    const r = await getJson(fn, 'not a url', TOKEN, 1000)
    ok('malformed url → typed fail', r.kind === 'fail' && (r as any).outcome === 'invalid_request')
    ok('malformed url → fetchImpl NOT called', calls.length === 0) }

  // 3) a pathFromOrigin-built api.github.com URL works (fetchImpl called, Authorization sent)
  { const { fn, calls } = capturingFetch()
    const url = pathFromOrigin('repos', 'owner', 'repo')
    const r = await getJson(fn, url, TOKEN, 1000)
    ok('api.github.com URL → fetchImpl called once', calls.length === 1 && r.kind === 'ok', JSON.stringify(r))
    ok('api.github.com URL → Authorization Bearer <token> sent', calls[0]?.init?.headers?.Authorization === `Bearer ${TOKEN}`)
    ok('api.github.com URL → GET + manual redirect', calls[0]?.init?.method === 'GET' && calls[0]?.init?.redirect === 'manual') }

  // 4) token undefined (public read) → fetchImpl called, NO Authorization header
  { const { fn, calls } = capturingFetch()
    const url = pathFromOrigin('gists', 'abc123')
    const r = await getJson(fn, url, undefined, 1000)
    ok('public read (no token) → fetchImpl called', calls.length === 1 && r.kind === 'ok')
    ok('public read → NO Authorization header', calls[0]?.init?.headers?.Authorization === undefined) }

  console.log('\ntest:github-authenticated-read')
  console.log('──────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ getJson refuses off-origin/non-https BEFORE fetch; Authorization only to api.github.com and only with a token\n')
}

main().catch(e => { console.error(e); process.exit(1) })
