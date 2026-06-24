#!/usr/bin/env tsx
/**
 * Operator entry: append a GOVERNANCE-MARKING CORRECTION to an already-approved admin operator claim.
 * Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md · engine: admin-operator-claim-workflow.ts.
 *
 * Fixes a mis-marked self/related (root/founder bootstrap) approval that was recorded as
 * independent_governance / none. APPEND-ONLY: it does NOT update/backdate the original approved event or
 * change its effective interval — it appends a correction the resolver overlays at read time. Honest
 * marking only (root_approval|founder_bootstrap_override + self_or_related). Reward/payout/UI untouched;
 * this writes NO contribution_facts and runs NO ingestion.
 *
 *   Dry-run (DEFAULT — writes nothing):
 *     node --import tsx scripts/correct-operator-claim-marking.ts --approved-event-id=aoce_... --root-admin-id=usr_... --reason="..."
 *   Commit:
 *     node --import tsx scripts/correct-operator-claim-marking.ts --commit --approved-event-id=aoce_... --root-admin-id=usr_... --reason="founder/root bootstrap self-attribution; honest disclosure"
 *
 * Flags:
 *   --commit                 actually write (default: dry-run)
 *   --approved-event-id=<id> the approved claim event to correct (required)
 *   --root-admin-id=<id>     the root admin applying the correction (required; engine enforces root)
 *   --reason="..."           correction_reason (required)
 *   --approval-kind=...      root_approval | founder_bootstrap_override (default founder_bootstrap_override)
 *   --db=<path>              SQLite path (default $WEBAZ_DB_PATH or ~/.webaz/webaz.db)
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseCommitSwitch } from '../src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.js'
import { correctClaimMarking } from '../src/layer2-business/L2-9-contribution/admin-operator-claim-workflow.js'

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  const eq = hit.indexOf('=')
  return eq < 0 ? '' : hit.slice(eq + 1)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function main(): void {
  let commit = false
  try { commit = parseCommitSwitch(flag('commit')) }
  catch (e) { console.error(`❌ ${(e as Error).message}. For a dry-run, OMIT --commit.`); process.exit(2) }

  const approvedEventId = flag('approved-event-id')
  const correctorId = flag('root-admin-id')
  const reason = flag('reason')
  const approvalKind = flag('approval-kind') || 'founder_bootstrap_override'
  const dbPath = flag('db') || process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')
  const conflictDisclosure = 'self_or_related'

  if (!approvedEventId) { console.error('❌ --approved-event-id is required'); process.exit(2) }
  if (!correctorId) { console.error('❌ --root-admin-id is required'); process.exit(2) }
  if (!reason || !reason.trim()) { console.error('❌ --reason is required'); process.exit(2) }
  if (!existsSync(dbPath)) { console.error(`❌ SQLite DB not found at ${dbPath} (set --db= or $WEBAZ_DB_PATH)`); process.exit(2) }

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  const ev = db.prepare("SELECT event_id, admin_account_id, contributor_account_id, approved_by, approval_kind, conflict_disclosure FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'approved'").get(approvedEventId) as any
  if (!ev) { console.error(`❌ no approved claim event with id=${approvedEventId}`); process.exit(2) }

  const selfRelated = !!ev.approved_by && (ev.approved_by === ev.admin_account_id || ev.approved_by === ev.contributor_account_id)
  console.log(`\noperator-claim marking correction — ${commit ? 'COMMIT (writing)' : 'DRY-RUN (no writes)'}`)
  console.log('─'.repeat(60))
  console.log(`  db                 ${dbPath}`)
  console.log(`  approved_event_id  ${ev.event_id}`)
  console.log(`  admin_seat         ${ev.admin_account_id}`)
  console.log(`  contributor        ${ev.contributor_account_id}`)
  console.log(`  approved_by        ${ev.approved_by}  (self/related: ${selfRelated})`)
  console.log(`  current marking    approval_kind=${ev.approval_kind} · conflict_disclosure=${ev.conflict_disclosure}`)
  console.log(`  → corrected to     approval_kind=${approvalKind} · conflict_disclosure=${conflictDisclosure}`)
  console.log(`  reason             ${reason.trim()}`)
  console.log(`  corrected_by       ${correctorId}`)

  if (!commit) {
    console.log(`\n  ↳ re-run with --commit to append this correction. The original approved event is NOT modified.\n`)
    return
  }
  const r = correctClaimMarking(db, { approvedEventId, correctorId, approvalKind, conflictDisclosure, correctionReason: reason })
  if (!(r as any).ok) { console.error(`\n❌ ${(r as any).code}: ${(r as any).message}`); process.exit(1) }
  console.log(`\n✅ correction appended: ${(r as any).correctionEventId}`)
  console.log(`   the claim now reads as an honest self/related disclosure (ingestion gate clears).\n`)
}

main()
