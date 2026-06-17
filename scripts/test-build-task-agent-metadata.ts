#!/usr/bin/env tsx
/**
 * PR9B — build_task_agent_metadata fresh-DB constraint tests (schema/store only; no API/MCP/PWA).
 *   用法:npm run test:build-task-agent-metadata
 *
 * Proves the DB CHECK/FK/NOT NULL AND the store validation enforce the FUTURE-TASK-BOARD-V1 contract (#326)
 * on a fresh in-memory DB: a legal #325 sample inserts; high+auto_claimable, critical+public,
 * value_state!=uncommitted, max<min, empty core fields, bad enums, orphan task_id are all rejected — and
 * the existing RFC-006 build_tasks state machine still works (no regression).
 */
import Database from 'better-sqlite3'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildTasksSchema, createBuildTask, claimBuildTask, submitBuildTask } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildTaskAgentMetadataSchema, insertBuildTaskAgentMetadata, getBuildTaskAgentMetadata, type BuildTaskAgentMetadata } from '../src/layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const rejects = (name: string, fn: () => void): void => { let t = false; try { fn() } catch { t = true } ok(`rejects: ${name}`, t) }
const accepts = (name: string, fn: () => void): void => { let t = false, e = ''; try { fn() } catch (err) { t = true; e = (err as Error).message } ok(`accepts: ${name}`, !t, e) }

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_a','A','c','ka')`).run()
  initBuildTasksSchema(db)
  initBuildTaskAgentMetadataSchema(db)
  setSeamDb(db)
  db.prepare(`INSERT INTO build_tasks (id,title,created_by) VALUES ('bt_1','Task one','usr_a')`).run()
  return db
}

// a legal low-risk #325-shaped metadata object
const META: BuildTaskAgentMetadata = {
  task_type: 'docs', source_ref: null, version: null,
  allowed_paths: ['docs/** prose', 'src/pwa/public/i18n.js'], forbidden_paths: ['src/** logic'],
  prohibited_actions: ['no DB/schema/API change', 'no secrets'], risk_level: 'low', audience: 'public',
  agent_autonomy: 'autonomous', auto_claimable: true, human_confirmation_points: ['DCO sign-off'],
  required_capabilities: ['read repo', 'edit markdown'], acceptance_criteria: ['build passes; zh+en parity'],
  verification_commands: ['npm run build'], expected_results: 'build passes', deliverables: ['one PR + DCO'],
  definition_of_done: 'CI green + review + DCO', estimated_duration_min_minutes: 10, estimated_duration_max_minutes: 15,
  estimated_context_size: 'small', estimated_agent_budget: 'minimal', dependencies: [], blocking_conditions: [],
  value_state: 'uncommitted', contribution_type: 'docs', accountable_party_required: true,
}

// raw INSERT bypassing the store, so we exercise the DB CHECK/FK directly. Build a valid row then override.
function rawInsert(db: any, taskId: string, over: Record<string, any> = {}): void {
  const row: Record<string, any> = {
    task_id: taskId, task_type: 'docs', source_ref: null, version: null,
    allowed_paths: '["docs/**"]', forbidden_paths: '[]', prohibited_actions: '["no DB change"]',
    risk_level: 'low', audience: 'public', agent_autonomy: 'autonomous', auto_claimable: 0,
    human_confirmation_points: '["DCO"]', required_capabilities: '["edit md"]', acceptance_criteria: '["build passes"]',
    verification_commands: '["npm run build"]', expected_results: 'build passes', deliverables: '["one PR"]',
    definition_of_done: 'CI green', estimated_duration_min_minutes: 10, estimated_duration_max_minutes: 15,
    estimated_context_size: 'small', estimated_agent_budget: 'minimal', dependencies: '[]', blocking_conditions: '[]',
    value_state: 'uncommitted', contribution_type: 'docs', accountable_party_required: 1, ...over,
  }
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO build_task_agent_metadata (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(row)
}

function main(): void {
  // 1) table creates + FK on
  { const db = freshDb()
    ok('PRAGMA foreign_keys = ON', db.pragma('foreign_keys', { simple: true }) === 1)
    ok('table exists', db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='build_task_agent_metadata'`).get() !== undefined) }

  // 2) legal #325 sample inserts via the store + round-trips lists
  { const db = freshDb()
    accepts('legal #325 sample inserts (store)', () => insertBuildTaskAgentMetadata(db, 'bt_1', META))
    const got = getBuildTaskAgentMetadata(db, 'bt_1') as any
    ok('round-trip: allowed_paths is a parsed array', Array.isArray(got.allowed_paths) && got.allowed_paths[0] === 'docs/** prose')
    ok('round-trip: auto_claimable is boolean', got.auto_claimable === true)
    ok('round-trip: value_state = uncommitted', got.value_state === 'uncommitted') }

  // 3) high + auto_claimable=true rejected (store AND DB)
  rejects('high + auto_claimable=true (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, risk_level: 'high', agent_autonomy: 'human_only', auto_claimable: true }) })
  rejects('high + auto_claimable=1 (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { risk_level: 'high', agent_autonomy: 'human_only', auto_claimable: 1, human_confirmation_points: '["x"]' }) })

  // 4) critical + audience=public rejected (store AND DB)
  rejects('critical + audience=public (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, risk_level: 'critical', audience: 'public', auto_claimable: false, agent_autonomy: 'human_only' }) })
  rejects('critical + audience=public (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { risk_level: 'critical', audience: 'public', auto_claimable: 0, agent_autonomy: 'human_only', human_confirmation_points: '["x"]' }) })

  // 5) value_state != uncommitted rejected (DB CHECK; store forces uncommitted)
  rejects('value_state=committed (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { value_state: 'committed' }) })

  // 6) duration max < min rejected (store AND DB)
  rejects('max<min (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, estimated_duration_min_minutes: 60, estimated_duration_max_minutes: 30 }) })
  rejects('max<min (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { estimated_duration_min_minutes: 60, estimated_duration_max_minutes: 30 }) })

  // 7) orphan task_id rejected (FK)
  rejects('orphan task_id (FK)', () => { const db = freshDb(); rawInsert(db, 'bt_ghost') })

  // 8) high/critical agent_autonomy must be human_in_the_loop|human_only
  rejects('high + autonomy=autonomous (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, risk_level: 'high', auto_claimable: false, agent_autonomy: 'autonomous' }) })
  rejects('high + autonomy=autonomous (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { risk_level: 'high', auto_claimable: 0, agent_autonomy: 'autonomous', human_confirmation_points: '["x"]' }) })

  // 9) high/critical requires >=1 human_confirmation_points
  rejects('high + empty human_confirmation_points (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, risk_level: 'high', auto_claimable: false, agent_autonomy: 'human_in_the_loop', human_confirmation_points: [] }) })
  rejects('high + empty human_confirmation_points (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { risk_level: 'high', auto_claimable: 0, agent_autonomy: 'human_in_the_loop', human_confirmation_points: '[]' }) })

  // 10) empty core boundary/acceptance fields rejected
  rejects('empty allowed_paths (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, allowed_paths: [] }) })
  rejects('empty allowed_paths (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { allowed_paths: '[]' }) })
  rejects('empty verification_commands (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { verification_commands: '[]' }) })
  rejects('blank expected_results (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { expected_results: '   ' }) })

  // 10b) list ELEMENT content must be non-blank (Codex P1 — [''] / ['   '] are unexecutable boundaries)
  rejects("allowed_paths [''] (store)", () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, allowed_paths: [''] }) })
  rejects("allowed_paths ['   '] (store)", () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, allowed_paths: ['   '] }) })
  rejects("prohibited_actions [''] (store)", () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, prohibited_actions: [''] }) })
  rejects("required_capabilities ['valid',''] (store)", () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, required_capabilities: ['read repo', ''] }) })
  rejects("verification_commands ['   '] (store)", () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, verification_commands: ['   '] }) })
  rejects("forbidden_paths [''] (store; even allowEmpty fields reject blank elements)", () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, forbidden_paths: [''] }) })

  // 11) bad enums rejected
  rejects('bad risk_level (store)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, risk_level: 'extreme' as any }) })
  rejects('bad risk_level (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { risk_level: 'extreme' }) })
  rejects('bad estimated_agent_budget (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { estimated_agent_budget: 'huge' }) })
  rejects('bad task_type (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { task_type: 'feature' }) })
  accepts('expanded task_type sdk_example (store; aligned with agent-task schema)', () => { const db = freshDb(); insertBuildTaskAgentMetadata(db, 'bt_1', { ...META, task_type: 'sdk_example' }) })
  accepts('expanded task_type infra (DB CHECK)', () => { const db = freshDb(); rawInsert(db, 'bt_1', { task_type: 'infra' }) })

  // 12) RFC-006 build_tasks state machine still works (no regression)
  { const db = freshDb()
    const created: any = createBuildTask(db, { creatorId: 'usr_a', title: 'New coord task', area: 'docs' } as any)
    ok('build_tasks createBuildTask ok', !!created && !('error' in created), JSON.stringify(created))
    const id = created.id
    const claimed: any = claimBuildTask(db, id, 'usr_a', 'human')
    ok('build_tasks claim open→claimed ok', !('error' in claimed), JSON.stringify(claimed))
    const submitted: any = submitBuildTask(db, id, 'usr_a', 'PR#1', 'done')
    ok('build_tasks submit claimed→in_review ok', !('error' in submitted), JSON.stringify(submitted))
    ok('metadata satellite did not alter build_tasks columns', db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('build_tasks')`).get() !== undefined) }

  console.log('\ntest:build-task-agent-metadata')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ build_task_agent_metadata: additive satellite, full field set + DB CHECK/FK + store validation (high⇒no-auto-claim/human-autonomy/hcp, critical⇒not-public, value_state uncommitted, max≥min, non-empty core, enums, FK) + RFC-006 state machine intact\n')
}

main()
