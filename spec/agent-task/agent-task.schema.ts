/**
 * Agent-ready Task Specification v1 — machine-readable contract (canonical).
 *
 * This is a **task-exchange contract**, NOT a database migration. It is a *superset*
 * spec layered on top of RFC-006's existing `build_tasks` state machine — it adds the
 * execution-boundary / acceptance / estimate / attribution fields an Agent needs to
 * complete a task safely with minimal clarification, while **preserving** the existing
 * state machine and invariants (claim TTL, atomic claim, WIP limits, provenance,
 * human acceptance, event log).
 *
 * Canonical = zod (repo already depends on zod ^4; no new dependency). The committed
 * `agent-task.schema.json` is a **generated artifact** kept in sync by
 * `scripts/test-agent-task-spec.ts` (regenerate + deep-equal), mirroring the repo's
 * gen-pg-schema + pg-schema-verify pattern.
 *
 * Boundaries (this PR): docs + schema + fixtures + static test only. No DB table /
 * migration, no API / MCP handler / UI change, no wallet/fund/order/permission change.
 *
 * Related: RFC-006 (build_tasks coordination) · RFC-017 (contribution protocol — facts,
 * identity, claim, uncommitted value) · build-tasks-engine.ts (existing state machine).
 */
import { z } from 'zod'

// ── enumerations ──────────────────────────────────────────────────────────────
// status MUST equal the RFC-006 build_tasks state machine (preserved, not redrawn).
// The static test asserts this equals build-tasks-engine.ts TASK_STATUS.
export const TASK_STATUS = ['open', 'claimed', 'in_review', 'done', 'abandoned'] as const
export const TASK_PROVENANCE = ['human', 'ai_assisted', 'ai_authored'] as const   // self-declared (RFC-006)

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export const AGENT_AUTONOMY = ['autonomous', 'supervised', 'human_in_the_loop', 'human_only'] as const
export const TASK_TYPES = ['docs', 'i18n', 'tests', 'sdk_example', 'ui', 'code', 'api', 'schema', 'infra', 'governance', 'audit', 'other'] as const
export const REWARD_ELIGIBILITY = ['eligible', 'pending', 'excluded'] as const
export const CONTRIBUTION_TYPES = ['code', 'tests', 'audit', 'maintenance', 'governance', 'usage', 'transaction', 'referral'] as const   // RFC-017 §5
export const CONTEXT_SIZE = ['small', 'medium', 'large'] as const
// budget is a RELATIVE tier only — never product-specific token counts (per spec).
export const AGENT_BUDGET_TIERS = ['minimal', 'small', 'moderate', 'large', 'xlarge'] as const

export const VALUE_STATE = 'uncommitted' as const   // RFC-017 I-12
export const AUDIENCE = ['public', 'restricted', 'internal'] as const   // who a task may be exposed to

// StrList allows empty (informational lists); NonEmptyStrList for core fields that
// must not be vacuous (an Agent cannot safely act on an empty boundary/acceptance list).
const StrList = z.array(z.string().min(1))
const NonEmptyStrList = z.array(z.string().min(1)).min(1)

// ── the task-exchange object (structural; JSON-Schema-representable) ─────────────
export const AgentTaskObject = z.object({
  spec_version: z.literal('1'),   // version of THIS contract format

  // ── identity ──
  task_id: z.string().min(1),
  title: z.string().min(3).max(200),
  summary: z.string().min(1).max(1000),
  task_type: z.enum(TASK_TYPES),
  area: z.string().min(1).max(64),
  source_ref: z.string().optional(),   // issue / PR / discussion / inbox ref
  rfc_ref: z.string().optional(),      // e.g. "RFC-006"

  // ── execution boundary ──
  allowed_paths: NonEmptyStrList,      // globs the Agent MAY touch (must not be empty)
  forbidden_paths: StrList,            // globs the Agent MUST NOT touch (empty allowed; public tasks SHOULD list high-risk zones explicitly)
  prohibited_actions: NonEmptyStrList, // e.g. "run migration", "deploy", "rotate key" (must not be empty)
  risk_level: z.enum(RISK_LEVELS),
  audience: z.enum(AUDIENCE),          // public | restricted | internal (critical ⇒ NOT public, refined below)
  agent_autonomy: z.enum(AGENT_AUTONOMY),
  human_confirmation_points: StrList,  // moments requiring a real human (I-16 / RFC-017); empty allowed for low risk
  required_capabilities: NonEmptyStrList, // e.g. "typescript", "i18n:zh", "playwright" (must not be empty)
  auto_claimable: z.boolean(),         // high/critical MUST be false (refined below)

  // ── acceptance / definition of done ──
  acceptance_criteria: z.array(z.string().min(1)).min(1),   // structured list
  verification_commands: NonEmptyStrList, // commands that prove completion (must not be empty)
  expected_results: NonEmptyStrList,   // what those commands must show (must not be empty)
  deliverables: z.array(z.string().min(1)).min(1),
  definition_of_done: z.string().min(1),

  // ── work estimate ──
  estimated_duration: z.object({
    min_minutes: z.number().int().positive(),
    max_minutes: z.number().int().positive(),
  }),
  estimated_context_size: z.enum(CONTEXT_SIZE),
  estimated_agent_budget: z.enum(AGENT_BUDGET_TIERS),   // relative tier ONLY
  dependencies: StrList,               // other task_ids / artifacts
  blocking_conditions: StrList,        // conditions that block start

  // ── contribution & attribution (RFC-017) ──
  provenance_requirement: z.array(z.enum(TASK_PROVENANCE)).min(1),   // allowed provenance(s)
  accountable_party_required: z.boolean(),                          // human/org answers (RFC-017 I-7)
  reward_eligibility: z.enum(REWARD_ELIGIBILITY),
  value_state: z.literal(VALUE_STATE),                              // uncommitted (RFC-017 I-12)
  contribution_type: z.enum(CONTRIBUTION_TYPES),

  // ── lifecycle (preserves RFC-006 build_tasks) ──
  status: z.enum(TASK_STATUS),
  claimed_by: z.string().nullable().optional(),
  claim_expires_at: z.string().nullable().optional(),   // claim TTL anchor (preserved)
  submission_ref: z.string().nullable().optional(),     // PR ref on submit
  resolution: z.string().nullable().optional(),         // admin acceptance note
  version: z.number().int().positive(),                 // bump invalidates stale claims

  // ── reserved: Agent Assurance Surface (referenced, NOT built this PR) ──
  assurance: z.object({
    required: z.boolean(),
    evidence_refs: z.array(z.string()).optional(),   // CI / audit / reviewed-commit refs (future)
    notes: z.string().optional(),
  }).optional(),

  // ── optional signals ──
  needs_clarification: z.boolean().optional(),   // raised when description is insufficient — NOT a new status
  scope_partition: z.string().optional(),        // multi-agent: this agent's declared sub-scope
})

// ── cross-field invariants (runtime; not all representable in JSON Schema) ───────
export const AgentTaskSchema = AgentTaskObject.superRefine((t, ctx) => {
  const elevated = t.risk_level === 'high' || t.risk_level === 'critical'
  if (elevated && t.auto_claimable !== false) {
    ctx.addIssue({ code: 'custom', path: ['auto_claimable'], message: 'high/critical risk tasks MUST NOT be auto-claimable' })
  }
  if (elevated && !(t.agent_autonomy === 'human_in_the_loop' || t.agent_autonomy === 'human_only')) {
    ctx.addIssue({ code: 'custom', path: ['agent_autonomy'], message: 'high/critical risk requires human_in_the_loop or human_only' })
  }
  if (elevated && t.human_confirmation_points.length < 1) {
    ctx.addIssue({ code: 'custom', path: ['human_confirmation_points'], message: 'high/critical risk requires ≥1 human confirmation point' })
  }
  if (t.risk_level === 'critical' && t.audience === 'public') {
    ctx.addIssue({ code: 'custom', path: ['audience'], message: 'critical risk tasks must NOT be audience=public' })
  }
  if (t.estimated_duration.max_minutes < t.estimated_duration.min_minutes) {
    ctx.addIssue({ code: 'custom', path: ['estimated_duration'], message: 'max_minutes must be ≥ min_minutes' })
  }
})

export type AgentTask = z.infer<typeof AgentTaskObject>

/**
 * Generated-artifact source of truth: structural JSON Schema (Draft 2020-12).
 *
 * The cross-field invariants enforced at runtime by superRefine are ALSO expressed
 * here as JSON-Schema `allOf` if/then blocks, so a pure JSON-Schema consumer (no zod)
 * enforces the same rules. Zod (superRefine) and JSON Schema (if/then) are kept in
 * lock-step — the static test rejects the same illegal object at BOTH layers.
 */
export function toJSONSchema(): Record<string, unknown> {
  const base = z.toJSONSchema(AgentTaskObject) as Record<string, unknown>
  const elevatedIf = { properties: { risk_level: { enum: ['high', 'critical'] } }, required: ['risk_level'] }
  base.allOf = [
    // high|critical ⇒ auto_claimable=false
    { if: elevatedIf, then: { properties: { auto_claimable: { const: false } }, required: ['auto_claimable'] } },
    // high|critical ⇒ autonomy ∈ {human_in_the_loop, human_only}
    { if: elevatedIf, then: { properties: { agent_autonomy: { enum: ['human_in_the_loop', 'human_only'] } }, required: ['agent_autonomy'] } },
    // high|critical ⇒ human_confirmation_points minItems=1
    { if: elevatedIf, then: { properties: { human_confirmation_points: { minItems: 1 } }, required: ['human_confirmation_points'] } },
    // critical ⇒ audience ∈ {restricted, internal} (not public)
    { if: { properties: { risk_level: { const: 'critical' } }, required: ['risk_level'] }, then: { properties: { audience: { enum: ['restricted', 'internal'] } }, required: ['audience'] } },
  ]
  return base
}
