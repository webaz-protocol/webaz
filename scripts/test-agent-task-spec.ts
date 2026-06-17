#!/usr/bin/env tsx
/**
 * Agent-ready Task Specification v1 — static validation test (no new deps).
 *   用法:npm run test:agent-task-spec
 *
 * Verifies:
 *   1. every fixture validates under BOTH the canonical zod schema AND a minimal
 *      JSON-Schema evaluator (the two formats agree on valid cases);
 *   2. core list fields reject empty arrays (NonEmptyStrList), while informational
 *      lists (dependencies / blocking_conditions / human_confirmation_points /
 *      forbidden_paths) still allow empty;
 *   3. cross-field rules reject the SAME illegal object at BOTH layers —
 *        high|critical ⇒ auto_claimable=false / human-gated autonomy / ≥1 confirm point
 *        critical ⇒ audience ≠ public · value_state must be 'uncommitted';
 *   4. the committed JSON Schema artifact is in sync with the zod source (drift guard)
 *      and structurally carries the conditional allOf/if-then blocks;
 *   5. the spec status enum equals RFC-006 build-tasks-engine TASK_STATUS.
 *
 * The minimal JSON-Schema evaluator below is a lightweight self-validation script
 * (no ajv / no new dependency) covering exactly the Draft-2020-12 subset this schema
 * emits: type / properties / required / additionalProperties / enum / const /
 * minLength / maxLength / minItems / exclusiveMinimum / maximum / anyOf / allOf / if-then.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  AgentTaskSchema,
  AgentTaskObject,
  toJSONSchema,
  TASK_STATUS as SPEC_STATUS,
} from '../spec/agent-task/agent-task.schema.js'
import { TASK_STATUS as ENGINE_STATUS } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = join(here, '..', 'spec', 'agent-task')
const FIX_DIR = join(SPEC_DIR, 'fixtures')

let pass = 0
let fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++ } else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}
function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX_DIR, file), 'utf8'))
}
function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) }

// ── minimal JSON-Schema evaluator (subset; no deps) ─────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
type JS = Record<string, any>
function jsValidate(schema: JS, value: unknown, path = '$'): string[] {
  const errs: string[] = []
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) errs.push(...jsValidate(s, value, path))
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s: JS) => jsValidate(s, value, path).length === 0)) {
    errs.push(`${path}: anyOf no match`)
  }
  if (schema.if) {
    const condOk = jsValidate(schema.if, value, path).length === 0
    if (condOk && schema.then) errs.push(...jsValidate(schema.then, value, path))
    if (!condOk && schema.else) errs.push(...jsValidate(schema.else, value, path))
  }
  if ('const' in schema && value !== schema.const) errs.push(`${path}: const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) errs.push(`${path}: enum`)
  if (typeof schema.type === 'string') {
    const t = schema.type
    const okType =
      t === 'string' ? typeof value === 'string' :
      t === 'boolean' ? typeof value === 'boolean' :
      t === 'integer' ? typeof value === 'number' && Number.isInteger(value) :
      t === 'number' ? typeof value === 'number' :
      t === 'null' ? value === null :
      t === 'array' ? Array.isArray(value) :
      t === 'object' ? (value !== null && typeof value === 'object' && !Array.isArray(value)) : true
    if (!okType) { errs.push(`${path}: type ${t}`); return errs }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errs.push(`${path}: minLength`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errs.push(`${path}: maxLength`)
  }
  if (typeof value === 'number') {
    if (typeof schema.exclusiveMinimum === 'number' && !(value > schema.exclusiveMinimum)) errs.push(`${path}: exclusiveMinimum`)
    if (typeof schema.maximum === 'number' && !(value <= schema.maximum)) errs.push(`${path}: maximum`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${path}: minItems`)
    if (schema.items) value.forEach((v, i) => errs.push(...jsValidate(schema.items, v, `${path}[${i}]`)))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (Array.isArray(schema.required)) for (const r of schema.required) if (!(r in obj)) errs.push(`${path}.${r}: required`)
    if (schema.properties) for (const k of Object.keys(schema.properties)) if (k in obj) errs.push(...jsValidate(schema.properties[k], obj[k], `${path}.${k}`))
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties))
      for (const k of Object.keys(obj)) if (!allowed.has(k)) errs.push(`${path}.${k}: additionalProperties`)
    }
  }
  return errs
}

const JSON_SCHEMA = toJSONSchema() as JS
function zodOk(o: unknown): boolean { return AgentTaskSchema.safeParse(o).success }
function jsOk(o: unknown): boolean { return jsValidate(JSON_SCHEMA, o).length === 0 }

// ── 1) every fixture valid under BOTH layers ─────────────────────────────────
const fixtures = readdirSync(FIX_DIR).filter(f => f.endsWith('.json')).sort()
ok('at least 4 fixtures present', fixtures.length >= 4, `found ${fixtures.length}`)
for (const f of fixtures) {
  const obj = load(f)
  ok(`zod: fixture valid ${f}`, zodOk(obj), JSON.stringify(AgentTaskSchema.safeParse(obj).error?.issues?.slice(0, 2)))
  ok(`json-schema: fixture valid ${f}`, jsOk(obj), jsValidate(JSON_SCHEMA, obj).slice(0, 3).join('; '))
}

// high-risk fixture shape
const high = load('04-high-risk-no-autoclaim.json')
ok('high fixture risk high/critical', high.risk_level === 'high' || high.risk_level === 'critical')
ok('high fixture auto_claimable=false', high.auto_claimable === false)
ok('high fixture human-gated autonomy', high.agent_autonomy === 'human_only' || high.agent_autonomy === 'human_in_the_loop')
ok('high fixture audience not public', high.audience !== 'public')

// ── 2) NonEmptyStrList: core fields reject empty (zod) ───────────────────────
for (const field of ['allowed_paths', 'prohibited_actions', 'verification_commands', 'expected_results', 'required_capabilities']) {
  const t = clone(load('01-docs-15min-low.json')); (t as JS)[field] = []
  ok(`zod rejects empty ${field}`, !zodOk(t))
  ok(`json-schema rejects empty ${field}`, !jsOk(t))
}
// informational lists still allow empty
{
  const t = clone(load('01-docs-15min-low.json'))
  t.dependencies = []; t.blocking_conditions = []; t.human_confirmation_points = []; t.forbidden_paths = []
  ok('empty allowed: dependencies/blocking/human_confirmation/forbidden (low risk)', zodOk(t) && jsOk(t))
}

// ── 3) cross-field rules reject SAME illegal object at BOTH layers ────────────
function bothReject(name: string, mutate: (t: JS) => void): void {
  const t = clone(load('04-high-risk-no-autoclaim.json')); mutate(t)
  ok(`zod rejects: ${name}`, !zodOk(t))
  ok(`json-schema rejects: ${name}`, !jsOk(t))
}
bothReject('high + auto_claimable=true', t => { t.auto_claimable = true })
bothReject('high + agent_autonomy=autonomous', t => { t.agent_autonomy = 'autonomous' })
bothReject('high + empty human_confirmation_points', t => { t.human_confirmation_points = [] })
bothReject('critical + audience=public', t => { t.risk_level = 'critical'; t.audience = 'public' })
bothReject('value_state not uncommitted', t => { t.value_state = 'committed' })
bothReject('bad risk_level enum', t => { t.risk_level = 'extreme' })
bothReject('bad audience enum', t => { t.audience = 'everyone' })

// critical + restricted must PASS both (proves the rule targets only public)
{
  const t = clone(load('04-high-risk-no-autoclaim.json')); t.risk_level = 'critical'; t.audience = 'restricted'
  ok('critical + restricted valid (both layers)', zodOk(t) && jsOk(t))
}

// ── 4) JSON Schema artifact: drift guard + structural conditionals ────────────
{
  const committed = JSON.parse(readFileSync(join(SPEC_DIR, 'agent-task.schema.json'), 'utf8'))
  ok('committed JSON Schema in sync with zod source', JSON.stringify(JSON_SCHEMA) === JSON.stringify(committed),
    'regenerate spec/agent-task/agent-task.schema.json from the zod schema')
  ok('JSON Schema carries 4 allOf if/then blocks', Array.isArray(JSON_SCHEMA.allOf) && JSON_SCHEMA.allOf.length === 4)
  ok('every allOf block is an if/then conditional', (JSON_SCHEMA.allOf || []).every((b: JS) => b.if && b.then))
  ok('JSON Schema has audience property', !!JSON_SCHEMA.properties?.audience)
  ok('JSON Schema ≥40 properties', Object.keys(JSON_SCHEMA.properties || {}).length >= 40)
}

// ── 5) status enum == RFC-006 build_tasks state machine ───────────────────────
{
  const a = [...SPEC_STATUS].sort().join('|')
  const b = [...ENGINE_STATUS].sort().join('|')
  ok('spec TASK_STATUS == engine TASK_STATUS', a === b, `spec=[${a}] engine=[${b}]`)
}
ok('schema object defines ≥32 fields', Object.keys(AgentTaskObject.shape).length >= 32, `got ${Object.keys(AgentTaskObject.shape).length}`)

// ── report ────────────────────────────────────────────────────────────────────
console.log('\ntest:agent-task-spec')
console.log('────────────────────')
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
console.log('✅ all Agent-ready Task Spec cases pass (zod + JSON Schema dual-layer)\n')
