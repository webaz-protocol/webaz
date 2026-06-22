#!/usr/bin/env tsx
/**
 * PR #18 — build-task quota UI wiring contract (static source check over src/pwa/public/app.js).
 *   用法:npm run test:quota-admin-ui
 *
 * The PWA is one IIFE with no DOM harness, so — like test-proposal-admin-ui — we lock the UI WIRING as a
 * source contract; the request/approve/consume BEHAVIOR is owned by the route + engine tests
 * (test-build-task-quota / -routes). Here we verify: both routes are dispatched; the RATE_LIMITED
 * affordance is shown on a capped create; the requester page + ROOT-only review page exist and call the
 * real endpoints; the review page is root-gated; and the action handlers are defined.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(HERE, '..', 'src', 'pwa', 'public', 'app.js'), 'utf8')
const i18n = readFileSync(join(HERE, '..', 'src', 'pwa', 'public', 'i18n.js'), 'utf8')

const startIdx = app.indexOf('PR #18 build-task quota-increase requests')
const endIdx = app.indexOf('async function renderAdminKPI(app)')
const BLOCK = startIdx >= 0 && endIdx > startIdx ? app.slice(startIdx, endIdx) : ''

function main(): void {
  ok('PR #18 quota UI block found', BLOCK.length > 1000, `start=${startIdx} end=${endIdx}`)

  // router wiring
  ok('route() dispatches #me/quota-requests → renderMyQuotaRequests', /params\[0\] === 'quota-requests'\)\s*return renderMyQuotaRequests\(app\)/.test(app))
  ok('route() dispatches #admin/quota-requests → renderAdminBuildTaskQuota', /params\[0\] === 'quota-requests'\)\s*return renderAdminBuildTaskQuota\(app\)/.test(app))
  ok('admin hub links to #admin/quota-requests (root-gated)', /admin_type[^\n]*'#admin\/quota-requests'/.test(app))

  // RATE_LIMITED affordance is wired into the capped create path
  ok('createTaskDraft handles RATE_LIMITED → showRateLimitAffordance', /error_code === 'RATE_LIMITED'\)\s*\{?\s*showRateLimitAffordance/.test(app))
  ok('showRateLimitAffordance defined + offers request button', /window\.showRateLimitAffordance =/.test(BLOCK) && /#me\/quota-requests/.test(BLOCK) && /(申请增加额度|Request extra quota)/.test(BLOCK))
  ok('affordance shows current limit + used', /Current limit|当前上限/.test(BLOCK) && /Used|已用/.test(BLOCK))
  ok('affordance states root approval required', /root-admin approval|根管理员批准/.test(BLOCK))

  // requester page
  ok('renderMyQuotaRequests defined + requires login', /async function renderMyQuotaRequests\(app\)/.test(BLOCK) && /if \(!state\.user\) \{ renderLogin\(\)/.test(BLOCK))
  ok('requester page GETs /me/quota-requests', /GET\('\/me\/quota-requests'\)/.test(BLOCK))
  ok('submitQuotaRequest POSTs /me/quota-requests with required fields', /POST\('\/me\/quota-requests'/.test(BLOCK) && /requested_extra_count/.test(BLOCK) && /reason/.test(BLOCK))
  ok('requester page shows pending/approved/rejected + remaining + rejection reason', /待审核|Pending/.test(BLOCK) && /剩余|Remaining/.test(BLOCK) && /拒绝原因|Rejection reason/.test(BLOCK))

  // ROOT-only review page
  ok('renderAdminBuildTaskQuota defined', /async function renderAdminBuildTaskQuota\(app/.test(BLOCK))
  ok('review page root-gated (admin_type root) else 仅限根管理员/Root admin only', /admin_type \|\| 'root'\) === 'root'/.test(BLOCK) && /(仅限根管理员|Root admin only)/.test(BLOCK))
  ok('review page lists via /admin/quota-requests', /GET\('\/admin\/quota-requests'/.test(BLOCK))
  ok('review detail loads requester 24h usage', /loadQuotaUsage/.test(BLOCK) && /\/admin\/quota-requests\/'/.test(BLOCK) && /requester_usage_24h/.test(BLOCK))
  ok('approve handler POSTs approve with extra_count/duration/note', /\/approve'/.test(BLOCK) && /extra_count/.test(BLOCK) && /duration_hours/.test(BLOCK) && /approval_note/.test(BLOCK))
  ok('reject handler POSTs reject with rejection_note', /\/reject'/.test(BLOCK) && /rejection_note/.test(BLOCK))
  ok('approve/reject surface SELF_DECISION to the user', /SELF_DECISION/.test(BLOCK))

  // bilingual: dashboard-card strings (t()) have _EN entries; in-page strings use local _qT(zh,en)
  ok('_EN has the quota review card label', /'建任务额度审核':/.test(i18n))
  ok('in-page strings use local bilingual _qT(zh, en)', /const _qT = \(zh, en\) =>/.test(app))

  console.log('\ntest:quota-admin-ui')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ quota UI wiring: both routes dispatched · RATE_LIMITED affordance (limit/used/root-approval) · requester page (submit + statuses + remaining + rejection reason) · ROOT-only review (list/usage/approve/reject + SELF_DECISION) · bilingual\n')
}

main()
