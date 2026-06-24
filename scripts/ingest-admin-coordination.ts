#!/usr/bin/env tsx
/**
 * Operator entry for the admin-coordination → RFC-017 contribution-evidence pipeline.
 * Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md · engine: admin-coordination-ingestion-engine.ts.
 *
 *   Dry-run (DEFAULT — writes NOTHING):
 *     node --import tsx scripts/ingest-admin-coordination.ts
 *     node --import tsx scripts/ingest-admin-coordination.ts --limit=20 --since-time=2026-06-23T00:00:00Z
 *   Commit (writes facts — MUST be cursor-bounded with --since-time or --since-id):
 *     node --import tsx scripts/ingest-admin-coordination.ts --commit --since-time=2026-06-24T00:00:00Z --limit=20
 *
 * What it does: selects ALLOWLISTED admin_audit_log rows (optionally after a cursor), runs each through
 * the single-row ingestion engine, and prints an ingest/skip report. This is evidence ingestion ONLY —
 * no reward / payout / amount, no aggregation, no UI. It is NOT a historical backfill: scope it with a
 * cursor + a hard --limit and run it manually. unknown action / unknown-or-revoked claim / malformed
 * context rows fail closed and are listed with a skip reason.
 *
 * Flags:
 *   --commit            actually write (default: dry-run, read-only)
 *   --limit=N           cap candidate rows (default 50, max 500)
 *   --since-time=ISO    only rows created strictly after this timestamp
 *   --since-id=<id>     only rows after this audit row (resume cursor)
 *   --visibility=...    evidence-link visibility (private|governance_only|public, default governance_only)
 *   --db=<path>         SQLite path (default $WEBAZ_DB_PATH or ~/.webaz/webaz.db)
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ingestAdminCoordinationSince, parseCommitSwitch, type Visibility } from '../src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.js'

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  const eq = hit.indexOf('=')
  return eq < 0 ? '' : hit.slice(eq + 1)
}

function main(): void {
  // --commit is a boolean switch at a PRODUCTION write entry: accept ONLY bare `--commit` or
  // `--commit=true`. Reject `--commit=false|0|no|...` LOUDLY so an explicit dry-run intent can never be
  // misread as a write. Omit --commit entirely for a dry-run.
  let commit = false
  try { commit = parseCommitSwitch(flag('commit')) }
  catch (e) { console.error(`❌ ${(e as Error).message}. For a dry-run, OMIT --commit.`); process.exit(2) }
  const limitRaw = flag('limit')
  const limit = limitRaw ? Number(limitRaw) : undefined
  const sinceTime = flag('since-time') || undefined
  const sinceId = flag('since-id') || undefined
  const visibility = (flag('visibility') as Visibility | undefined) || undefined
  const dbPath = flag('db') || process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')

  if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit as number) < 1)) {
    console.error(`❌ --limit must be a positive integer (got ${JSON.stringify(limitRaw)})`); process.exit(2)
  }
  if (visibility && !['private', 'governance_only', 'public'].includes(visibility)) {
    console.error(`❌ --visibility must be private|governance_only|public (got ${visibility})`); process.exit(2)
  }
  if (!existsSync(dbPath)) { console.error(`❌ SQLite DB not found at ${dbPath} (set --db= or $WEBAZ_DB_PATH)`); process.exit(2) }

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  const hasAudit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit_log'").get()
  if (!hasAudit) { console.error('❌ admin_audit_log table not found — is this a WebAZ DB?'); process.exit(2) }

  let report
  try {
    report = ingestAdminCoordinationSince(db, { commit, limit, sinceTime, sinceId, visibility })
  } catch (e) {
    // invalid_cursor (typo'd --since-id) and any engine error → fail closed, non-zero exit, NO write.
    console.error(`❌ ${(e as Error).message}`)
    process.exit(2)
  }

  const mode = report.committed ? 'COMMIT (writing facts)' : 'DRY-RUN (no writes)'
  console.log(`\nadmin-coordination ingestion — ${mode}`)
  console.log('─'.repeat(60))
  console.log(`  db            ${dbPath}`)
  console.log(`  limit         ${report.limit}${sinceTime ? ` · since-time ${sinceTime}` : ''}${sinceId ? ` · since-id ${sinceId}` : ''}`)
  console.log(`  scanned       ${report.scanned}`)
  console.log(`  ingested      ${report.ingested}`)
  console.log(`  would-ingest  ${report.wouldIngest}   (dry-run candidates that would become facts)`)
  console.log(`  already       ${report.alreadyPresent}   (idempotent — fact already exists)`)
  console.log(`  skipped       ${report.skipped}   (fail-closed: unknown action / no-or-revoked claim / bad context)`)
  if (report.rows.length) {
    console.log('\n  per-row:')
    for (const r of report.rows) {
      const who = r.contributorAccountId ? ` → ${r.contributorAccountId} (${r.via})` : ''
      const why = r.reason ? `  [${r.reason}]` : ''
      console.log(`    ${r.outcome.padEnd(14)} ${r.action.padEnd(28)} ${r.auditId}${who}${why}`)
    }
  }
  if (!report.committed && (report.wouldIngest > 0)) {
    console.log(`\n  ↳ re-run with --commit AND a cursor (--since-time=<ISO> or --since-id=<id>) to write the ${report.wouldIngest} candidate fact(s). Reward is DEFERRED — facts carry no amount.`)
  }
  console.log('')
}

main()
