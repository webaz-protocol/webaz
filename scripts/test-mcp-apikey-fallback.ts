#!/usr/bin/env tsx
/**
 * F6 — MCP keyed handlers resolve api_key as: explicit args.api_key > env WEBAZ_API_KEY > '' (→ the
 * existing typed API_KEY_REQUIRED guards). Explicit ALWAYS wins; env never overrides explicit; keyless
 * actions are unaffected; the key is never echoed in any error/description string.
 *   用法:npm run test:mcp-apikey-fallback
 *
 * resolveMcpApiKey is the single resolution point — unit-tested here (envKey param avoids the module-load
 * const so all 3 precedence cases run in one process); a static sweep proves every keyed site routes
 * through it and the public branches don't. Behavioral coverage (keyless work / keyed→API_KEY_REQUIRED with
 * env cleared) lives in test:mcp-contribute.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// clear env BEFORE importing the server (module-load consts read it); we pass envKey explicitly anyway.
delete process.env.WEBAZ_API_KEY
delete process.env.WEBAZ_MODE

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src', 'layer1-agent', 'L1-1-mcp-server', 'server.ts'), 'utf8')

async function main(): Promise<void> {
  const { resolveMcpApiKey } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

  // ── precedence: explicit > env > '' ───────────────────────────────────────────────────────────────
  ok('explicit api_key wins over env', resolveMcpApiKey({ api_key: 'EXPLICIT' }, 'ENVKEY') === 'EXPLICIT')
  ok('env fallback when no explicit key', resolveMcpApiKey({}, 'ENVKEY') === 'ENVKEY')
  ok('empty explicit ("") falls back to env', resolveMcpApiKey({ api_key: '' }, 'ENVKEY') === 'ENVKEY')
  ok('whitespace-only explicit falls back to env', resolveMcpApiKey({ api_key: '   ' }, 'ENVKEY') === 'ENVKEY')
  ok('missing both → "" (→ API_KEY_REQUIRED downstream)', resolveMcpApiKey({}, '') === '')
  ok('explicit wins even when env empty', resolveMcpApiKey({ api_key: 'EXPLICIT' }, '') === 'EXPLICIT')
  ok('explicit is trimmed', resolveMcpApiKey({ api_key: '  k123  ' }, '') === 'k123')
  ok('non-string explicit ignored → env', resolveMcpApiKey({ api_key: 123 as unknown as string }, 'ENVKEY') === 'ENVKEY')
  ok('default envKey = module WEBAZ_API_KEY (cleared here) → "" with no explicit', resolveMcpApiKey({}) === '')

  // ── static: every keyed site routes through the helper; no raw reads left ──────────────────────────
  const rawAsString = (src.match(/\bargs\.api_key as string\b/g) || []).length
  const rawString = (src.match(/String\(args\.api_key \|\| ''\)/g) || []).length
  ok('no raw `args.api_key as string` left (all → resolveMcpApiKey)', rawAsString === 0, `found ${rawAsString}`)
  ok("no raw `String(args.api_key || '')` left", rawString === 0, `found ${rawString}`)
  // outside the helper (comment + definition), there must be ZERO remaining args.api_key references —
  // i.e. every handler read now routes through resolveMcpApiKey.
  const hStart = src.indexOf('// F6 (dogfood R2)')
  const hEnd = src.indexOf('}', src.indexOf('export function resolveMcpApiKey')) + 1
  const remainder = (src.slice(0, hStart) + src.slice(hEnd)).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')  // strip line-comments (doc mentions are fine)
  ok('no args.api_key CODE references remain outside the helper (all → resolveMcpApiKey)', hStart > 0 && hEnd > hStart && !/args\??\.api_key\b/.test(remainder))
  ok('helper is exported (testable + single resolution point)', /export function resolveMcpApiKey\(args: Record<string, unknown>, envKey: string = WEBAZ_API_KEY\)/.test(src))

  // ── explicit per-tool guard (reviewer-flagged): the network-branch skill handlers must resolve via
  //    resolveMcpApiKey, so a WEBAZ_API_KEY-only MCP config works for webaz_skill / webaz_skill_market
  //    publish/subscribe/my_skills/my_subs (not only when args.api_key is passed). Subsumed by the global
  //    check above, but pinned by name so a future special-case for these tools can't silently regress.
  for (const fn of ['handleSkill', 'handleSkillMarket']) {
    const b = src.slice(src.indexOf(`async function ${fn}(`))
    const nextFn = b.indexOf('\nasync function ', 1)
    const body = b.slice(0, nextFn > 0 ? nextFn : 3500)
    ok(`${fn}: resolves api_key via resolveMcpApiKey (env WEBAZ_API_KEY fallback)`, /const apiKey = resolveMcpApiKey\(args\)/.test(body))
    ok(`${fn}: never reads args.api_key directly (no String(args.api_key) / as-string)`, !/String\(args\.api_key/.test(body) && !/args\.api_key as string/.test(body))
  }

  // ── keyless boundary unchanged: env presence must not gate public reads ────────────────────────────
  // within handleContribute, list_open / detail / suggest return BEFORE the `if (!apiKey)` guard.
  const hc = src.slice(src.indexOf('export async function handleContribute'))
  const hcBody = hc.slice(0, hc.indexOf('\nexport ', 1) > 0 ? hc.indexOf('\nexport ', 1) : 4000)
  const guardIdx = hcBody.indexOf("error_code: 'API_KEY_REQUIRED'")
  ok('handleContribute keeps the API_KEY_REQUIRED guard for keyed actions', guardIdx > 0)
  ok('keyless suggest/list return before the key guard (env never gates public reads)',
    guardIdx > 0 && hcBody.indexOf("action=suggest") > 0 && hcBody.indexOf("action=suggest") < guardIdx)

  // ── schema contract (Codex #355 P2): api_key is env-fallbackable, so it must NOT be in any required[] ─
  // (schema-validating clients would otherwise force api_key before the handler's env fallback applies).
  const requiredArrays = src.match(/required: \[[^\]]*\]/g) || []
  const reqWithKey = requiredArrays.filter(r => /'api_key'/.test(r))
  ok('no inputSchema required[] contains api_key (all keyed handlers env-fallback)', reqWithKey.length === 0, reqWithKey.join(' | '))
  // every api_key property documents the env option (self-consistent contract; covers Codex's anchor:
  // any tool whose api_key mentions WEBAZ_API_KEY must not require it — subsumed by the check above)
  const apiKeyProps = (src.match(/^\s*api_key:\s*\{/gm) || []).length
  const apiKeyEnvNoted = (src.match(/^\s*api_key:.*WEBAZ_API_KEY/gm) || []).length
  ok('every api_key property description mentions the WEBAZ_API_KEY env option', apiKeyProps > 0 && apiKeyProps === apiKeyEnvNoted, `props=${apiKeyProps} noted=${apiKeyEnvNoted}`)

  // ── no key leakage: API_KEY_REQUIRED / api_key error strings never interpolate the resolved key ────
  ok('API_KEY_REQUIRED message does not interpolate a key value', !/API_KEY_REQUIRED[\s\S]{0,200}\$\{(apiKey|resolveMcpApiKey)/.test(src))
  ok("no error/return string interpolates ${apiKey}", !/error:[^\n]*\$\{apiKey\}/.test(src) && !/\$\{resolveMcpApiKey\(args\)\}/.test(src))

  if (fail === 0) {
    console.log(`\n✅ MCP api_key fallback (F6): explicit > env WEBAZ_API_KEY > '' (explicit always wins; trim; non-string/empty → env) · single exported resolveMcpApiKey, no raw args.api_key reads left · keyless actions precede the key guard (env doesn't change public reads) · key never interpolated into errors\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ MCP api_key fallback FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
