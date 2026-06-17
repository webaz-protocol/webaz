#!/usr/bin/env tsx
/**
 * GitHub Immutable Contribution Credential v2 — static + verifier + self-consistency tests (no new deps).
 *   用法:npm run test:github-credential
 *
 * Covers verifier outcomes (10 fixtures) · zod ⇄ JSON Schema dual-layer (structure + cross-field)
 * · **self-consistency** check (re-computed digests; NOT tamper-proof) DISTINCT from schema · canonical
 * digest determinism · core/observation split · merged-only lifecycle (reverted/superseded/void →
 * unsupported_lifecycle) · malformed-input typed refusal (no throw) · no-PII · drift guards.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { verifyGithubContribution, type GithubPrApiResponse } from '../src/layer2-business/L2-9-contribution/github-credential/verifier.js'
import { verifyCredentialSelfConsistency } from '../src/layer2-business/L2-9-contribution/github-credential/self-consistency.js'
import { GithubCredentialSchema, toJSONSchema } from '../src/layer2-business/L2-9-contribution/github-credential/github-credential.schema.js'
import { canonicalSerialize as specCanon, digestCore, digestObject, credentialIdFromDigest } from '../src/layer2-business/L2-9-contribution/github-credential/canonical.js'
import { canonicalSerialize as srcCanon } from '../src/layer0-foundation/L0-2-state-machine/order-chain.js'

const here = dirname(fileURLToPath(import.meta.url))
const MODULE_DIR = join(here, '..', 'src', 'layer2-business', 'L2-9-contribution', 'github-credential')
const FIX_DIR = join(MODULE_DIR, 'fixtures')
const REPO = 'R_webaz'

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}
function load(f: string): GithubPrApiResponse { return JSON.parse(readFileSync(join(FIX_DIR, f), 'utf8')) }
function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) }
function mint(f: string, opts: Parameters<typeof verifyGithubContribution>[1] = { expectedRepositoryId: REPO }) {
  return verifyGithubContribution(load(f), opts)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type JS = Record<string, any>
function jsValidate(schema: JS, value: unknown, path = '$'): string[] {
  const e: string[] = []
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) e.push(...jsValidate(s, value, path))
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s: JS) => jsValidate(s, value, path).length === 0)) e.push(`${path}: anyOf`)
  if (schema.if) {
    const condOk = jsValidate(schema.if, value, path).length === 0
    if (condOk && schema.then) e.push(...jsValidate(schema.then, value, path))
    if (!condOk && schema.else) e.push(...jsValidate(schema.else, value, path))
  }
  if ('const' in schema && value !== schema.const) e.push(`${path}: const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) e.push(`${path}: enum`)
  if (typeof schema.type === 'string') {
    const t = schema.type
    const okT = t === 'string' ? typeof value === 'string'
      : t === 'boolean' ? typeof value === 'boolean'
      : t === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : t === 'number' ? typeof value === 'number'
      : t === 'null' ? value === null
      : t === 'array' ? Array.isArray(value)
      : t === 'object' ? (value !== null && typeof value === 'object' && !Array.isArray(value)) : true
    if (!okT) { e.push(`${path}: type ${t}`); return e }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) e.push(`${path}: minLength`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) e.push(`${path}: pattern`)
  }
  if (typeof value === 'number') {
    if (typeof schema.exclusiveMinimum === 'number' && !(value > schema.exclusiveMinimum)) e.push(`${path}: exclusiveMinimum`)
    if (typeof schema.minimum === 'number' && !(value >= schema.minimum)) e.push(`${path}: minimum`)
    if (typeof schema.maximum === 'number' && !(value <= schema.maximum)) e.push(`${path}: maximum`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) e.push(`${path}: minItems`)
    if (schema.items) value.forEach((v, i) => e.push(...jsValidate(schema.items, v, `${path}[${i}]`)))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (Array.isArray(schema.required)) for (const r of schema.required) if (!(r in obj)) e.push(`${path}.${r}: required`)
    if (schema.properties) for (const k of Object.keys(schema.properties)) if (k in obj) e.push(...jsValidate(schema.properties[k], obj[k], `${path}.${k}`))
    if (schema.additionalProperties === false && schema.properties) {
      const allow = new Set(Object.keys(schema.properties))
      for (const k of Object.keys(obj)) if (!allow.has(k)) e.push(`${path}.${k}: additionalProperties`)
    }
  }
  return e
}
const JSON_SCHEMA = toJSONSchema() as JS
const zodOk = (o: unknown) => GithubCredentialSchema.safeParse(o).success
const jsOk = (o: unknown) => jsValidate(JSON_SCHEMA, o).length === 0
const selfConsistOk = (o: any) => verifyCredentialSelfConsistency(o).ok

// ── 0) canonical reuse no-drift ─────────────────────────────────────────────
ok('canonicalSerialize byte-identical to src order-chain', srcCanon({ b: 1, a: [3, { z: 1, y: 2 }], c: null }) === specCanon({ b: 1, a: [3, { z: 1, y: 2 }], c: null }))

// ── 1) verifier outcomes ────────────────────────────────────────────────────
const r01 = mint('01-merged-ci-green.json'); ok('01 merged → ok', r01.ok)
ok('02 fork merged → ok', mint('02-fork-pr-merged.json').ok)
{ const r = mint('03-closed-unmerged.json'); ok('03 closed/unmerged → not_merged', !r.ok && r.outcome === 'not_merged') }
const r04 = mint('04-rename-same-ids.json'); ok('04 rename → ok', r04.ok)
const r05 = mint('05-forcepush-head-changed.json'); ok('05 force-push → ok', r05.ok)
ok('06 multi-author/agent → ok', mint('06-multi-author-agent.json').ok)
const r07 = mint('07-revert-pr-merged.json'); ok('07 revert PR (itself merged) → ok as merged', r07.ok)
{ const r = mint('08-insufficient-missing-merge-sha.json'); ok('08 missing merge sha → insufficient_evidence', !r.ok && r.outcome === 'insufficient_evidence') }
const r09 = mint('09-forged-body-taskid.json'); ok('09 forged body → ok', r09.ok)
const r10 = mint('10-idempotent-repeat.json'); ok('10 repeat → ok', r10.ok)

// ── 2) lifecycle: merged ONLY (merged-only profile) ────────────────────────────────────────────
for (const lc of ['reverted', 'superseded', 'void', 'bogus']) {
  const r = mint('07-revert-pr-merged.json', { expectedRepositoryId: REPO, lifecycle_event: lc })
  ok(`lifecycle '${lc}' → unsupported_lifecycle`, !r.ok && r.outcome === 'unsupported_lifecycle')
}
if (r01.ok) ok('merged forces supersedes null', r01.credential.core.supersedes_credential_id === null)
{ const r = mint('01-merged-ci-green.json', { expectedRepositoryId: REPO, lifecycle_event: 'merged', supersedes_credential_id: 'ghc_bogus' }); ok('merged ignores caller supersedes (forced null)', r.ok && r.credential.core.supersedes_credential_id === null) }

// ── 3) every minted credential valid under BOTH schema layers + self-consistency ────
for (const f of readdirSync(FIX_DIR).filter(x => x.endsWith('.json')).sort()) {
  const r = mint(f)
  if (r.ok) {
    ok(`zod valid: ${f}`, zodOk(r.credential))
    ok(`json-schema valid: ${f}`, jsOk(r.credential), jsValidate(JSON_SCHEMA, r.credential).slice(0, 2).join('; '))
    ok(`self-consistency valid: ${f}`, selfConsistOk(r.credential))
  }
}

// ── 4) immutable core vs mutable observation ────────────────────────────────
if (r01.ok && r09.ok) {
  ok('forged self-report excluded from core (same core_digest + id)', r01.credential.core_digest === r09.credential.core_digest && r01.credential.credential_id === r09.credential.credential_id)
  ok('observation differs → different observation_digest', r01.credential.observation_digest !== r09.credential.observation_digest)
  ok('same core / different valid observation → each self-consistency-ok', selfConsistOk(r01.credential) && selfConsistOk(r09.credential))
}

// ── 5) SELF-CONSISTENCY (distinct from schema; NOT tamper-proof) ─────────────
if (r01.ok) {
  // tamper core but keep stale digest → schema PASSES, self-consistency REJECTS (the boundary)
  { const c = clone(r01.credential); c.core.merge_commit_sha = 'tampered000000000000000000000000000000000'
    ok('schema cannot detect tampered core (passes zod)', zodOk(c))
    ok('self-consistency rejects tampered core (stale core_digest)', !selfConsistOk(c)) }
  { const c = clone(r01.credential); c.observation.claimed_task_id = 'INJECTED'
    ok('self-consistency rejects tampered observation (stale observation_digest)', !selfConsistOk(c)) }
  { const c = clone(r01.credential); c.credential_id = 'ghc_0000000000000000000000000000000000000000'
    ok('self-consistency rejects replaced credential_id', !selfConsistOk(c)) }
  ok('self-consistency passes a valid credential', selfConsistOk(r01.credential))
  { const c = clone(r01.credential); const rk: any = {}; for (const k of Object.keys(c.core).reverse()) rk[k] = (c.core as any)[k]; c.core = rk
    ok('self-consistency unaffected by core key order', selfConsistOk(c)) }
  // HONEST LIMITATION (Codex #294 P1): self-consistency is NOT anti-tamper. An attacker who
  // controls the payload can edit core AND recompute digest+id — and it then PASSES. This proves
  // it only detects accidental corruption; real authenticity needs an external root of trust (PR 3B).
  { const c = clone(r01.credential)
    c.core.merge_commit_sha = 'attacker0000000000000000000000000000000000'
    c.core_digest = digestCore(c.core as any)
    c.credential_id = credentialIdFromDigest(c.core_digest)
    ok('self-consistency is NOT tamper-proof (recomputed forgery passes — by design, needs PR 3B)', selfConsistOk(c)) }
}

// ── 6) authenticity + digest determinism ────────────────────────────────────
{ const r = mint('01-merged-ci-green.json', { expectedRepositoryId: 'R_other' }); ok('rule2 wrong repository rejected', !r.ok && r.outcome === 'wrong_repository') }
if (r01.ok) {
  ok('rule7 accountable_party_ref null at mint', r01.credential.accountable_party_ref === null)
  ok('rule8 dco_state distinct', r01.credential.observation.dco_state === 'present')
  ok('rule9 distinct evidence streams', typeof r01.credential.observation.checks_summary === 'object' && 'merged_by_actor_id' in r01.credential.observation)
  ok('v2: evidence_coverage required, defaults unobserved (pure verifier observed nothing)', Object.values(r01.credential.observation.evidence_coverage).every(v => v === 'unobserved'))
  // v2 (Codex #295 P1): a strict schema rejects unknown fields BOTH ways, so the additive field is a
  // formal version bump. A credential missing evidence_coverage is NOT a valid v2 credential.
  { const noCov: any = clone(r01.credential); delete noCov.observation.evidence_coverage
    noCov.observation_digest = digestObject(noCov.observation)
    ok('v2: a credential missing evidence_coverage is rejected (formal version bump)', !zodOk(noCov) && !jsOk(noCov)) }
}
if (r01.ok && r04.ok && r05.ok && r10.ok) {
  ok('rule12 idempotent → same core_digest + id', r01.credential.core_digest === r10.credential.core_digest && r01.credential.credential_id === r10.credential.credential_id)
  ok('rule5 rename → same core_digest', r01.credential.core_digest === r04.credential.core_digest)
  ok('rule6 force-push head_sha → different core_digest', r01.credential.core_digest !== r05.credential.core_digest)
}
{
  const a = { credential_type: 'github_contribution_credential', credential_version: '1', repository_id: REPO, pr_node_id: 'P', pr_number: 1, base_ref: 'main', head_sha: 'h', merge_commit_sha: 'm', merged_at: 't', github_actor_id: 'u', lifecycle_event: 'merged', supersedes_credential_id: null }
  const ro: Record<string, unknown> = {}; for (const k of Object.keys(a).reverse()) ro[k] = (a as any)[k]
  ok('digestCore key-order independent', digestCore(a) === digestCore(ro))
  ok('digestCore sensitive to core change', digestCore(a) !== digestCore({ ...a, merge_commit_sha: 'X' }))
  // domain isolation (Codex #294 P2): a future v2 of the SAME GitHub fact gets a DIFFERENT digest
  ok('domain isolation: credential_version change → different digest', digestCore(a) !== digestCore({ ...a, credential_version: '2' }))
  ok('domain isolation: credential_type change → different digest', digestCore(a) !== digestCore({ ...a, credential_type: 'other' }))
}
if (r01.ok) ok('credential_version lives in core (digest domain), not top-level; v2', !('credential_version' in r01.credential) && r01.credential.core.credential_version === '2')

// ── 7) malformed input → typed refusal, NEVER throws (P2) ───────────────────
function noThrowInsufficient(name: string, mutate: (r: any) => void): void {
  const bad = clone(load('01-merged-ci-green.json')); mutate(bad)
  let threw = false; let res: any
  try { res = verifyGithubContribution(bad, { expectedRepositoryId: REPO }) } catch { threw = true }
  ok(`malformed ${name}: no throw + insufficient_evidence`, !threw && res && res.ok === false && res.outcome === 'insufficient_evidence', threw ? 'THREW' : JSON.stringify(res?.outcome))
}
noThrowInsufficient('missing repository', r => delete r.repository)
noThrowInsufficient('missing repository.owner', r => delete r.repository.owner)
noThrowInsufficient('missing pull_request', r => delete r.pull_request)
noThrowInsufficient('missing pull_request.user', r => delete r.pull_request.user)
noThrowInsufficient('missing pull_request.base', r => delete r.pull_request.base)
noThrowInsufficient('missing pull_request.head', r => delete r.pull_request.head)
noThrowInsufficient('missing observed_at', r => delete r.observed_at)
// previously threw a TypeError deep in the mapping code (Codex #294 P2):
noThrowInsufficient('commit_authors not array ({})', r => { r.commit_authors = {} })
noThrowInsufficient('commit_authors [null]', r => { r.commit_authors = [null] })
noThrowInsufficient('reviews not array ({})', r => { r.reviews = {} })
noThrowInsufficient('reviews [null]', r => { r.reviews = [null] })
noThrowInsufficient('check_conclusions not array ({})', r => { r.check_conclusions = {} })
noThrowInsufficient('check_conclusions [123] wrong item type', r => { r.check_conclusions = [123] })
noThrowInsufficient('pull_request.user.id missing', r => { delete r.pull_request.user.id })
{ let threw = false; let res: any; try { res = verifyGithubContribution(null as any, { expectedRepositoryId: REPO }) } catch { threw = true }
  ok('null response: no throw + refusal', !threw && res && res.ok === false) }

// ── 8) dual-layer cross-field rejection + no-PII + drift ────────────────────
function bothReject(name: string, mutate: (c: any) => void): void {
  if (!r01.ok) return
  const c = clone(r01.credential); mutate(c)
  ok(`zod rejects: ${name}`, !zodOk(c))
  ok(`json-schema rejects: ${name}`, !jsOk(c))
}
bothReject('merged + null merge_commit_sha', c => { c.core.merge_commit_sha = null })
bothReject('merged + null merged_at', c => { c.core.merged_at = null })
bothReject('verification_state unverified', c => { c.observation.verification_state = 'unverified' })
bothReject('merged + non-null supersedes', c => { c.core.supersedes_credential_id = 'ghc_parent' })
bothReject('accountable_party_ref non-null', c => { c.accountable_party_ref = 'usr_x' })
bothReject('event_source not github_api', c => { c.event_source = 'self_report' })
bothReject('bad core_digest format', c => { c.core_digest = 'not-a-sha' })
bothReject('lifecycle not merged', c => { c.core.lifecycle_event = 'reverted' })
// strict objects: unknown fields rejected at BOTH layers, every level (Codex #294 R4 P1) —
// prevents the immutable core from carrying un-digested claims + keeps zod ⇄ JSON Schema consistent.
bothReject('unknown top-level field', c => { c.UNKNOWN = 1 })
bothReject('unknown core field (un-digested claim)', c => { c.core.UNKNOWN_CLAIM = 1 })
bothReject('unknown observation field', c => { c.observation.UNKNOWN = 1 })
bothReject('unknown nested field (checks_summary)', c => { c.observation.checks_summary.UNKNOWN = 1 })
bothReject('unknown nested field (commit_authors item)', c => { if (c.observation.commit_authors[0]) c.observation.commit_authors[0].UNKNOWN = 1; else c.observation.commit_authors.push({ author_id: null, login: null, name: null, is_coauthor: false, UNKNOWN: 1 }) })

// "cannot verify → never guess": missing self-report ⇒ unknown/null, NOT human/code (Codex R4 P1)
{ const r = mint('04-rename-same-ids.json')   // fixture has no self_reported
  ok('missing provenance → unknown (not human)', r.ok && r.credential.observation.agent_provenance === 'unknown')
  ok('missing contribution_type → null (not code)', r.ok && r.credential.observation.contribution_type === null) }
{ const r = mint('06-multi-author-agent.json')   // self_reported ai_authored
  ok('valid self-reported provenance still recorded', r.ok && r.credential.observation.agent_provenance === 'ai_authored') }
{ const bad = clone(load('01-merged-ci-green.json')); delete (bad as any).repository.visibility
  const r = verifyGithubContribution(bad, { expectedRepositoryId: REPO })
  ok('missing visibility → unknown (not public)', r.ok && r.credential.observation.repository_visibility_at_observation === 'unknown') }

if (r01.ok) {
  const blob = JSON.stringify(r01.credential)
  ok('no email-like PII', !/@/.test(blob))
  ok('no token/secret/cookie/password keys', !/("?(token|secret|cookie|password|access_token)"?\s*:)/i.test(blob))
}
{
  const committed = JSON.parse(readFileSync(join(MODULE_DIR, 'github-credential.schema.json'), 'utf8'))
  ok('committed JSON Schema in sync with zod', JSON.stringify(JSON_SCHEMA) === JSON.stringify(committed), 'regenerate github-credential.schema.json')
  ok('JSON Schema carries 1 allOf if/then (merged)', Array.isArray(JSON_SCHEMA.allOf) && JSON_SCHEMA.allOf.length === 1 && JSON_SCHEMA.allOf[0].if && JSON_SCHEMA.allOf[0].then)
  ok('lifecycle enum is merged-only', JSON.stringify(JSON_SCHEMA.properties.core.properties.lifecycle_event.enum) === JSON.stringify(['merged']))
}

console.log('\ntest:github-credential')
console.log('──────────────────────')
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
console.log('✅ all GitHub Contribution Credential cases pass (verifier + self-consistency + zod ⇄ JSON Schema)\n')
