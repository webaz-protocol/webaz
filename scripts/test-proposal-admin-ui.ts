#!/usr/bin/env tsx
/**
 * PR9I — Task Proposal Inbox admin-review UI contract (static source check over src/pwa/public/app.js).
 *   用法:npm run test:proposal-admin-ui
 *
 * The PWA is one IIFE with no DOM test harness, so — like test-public-contribution-pages — we lock the UI
 * wiring as a SOURCE contract. The admin list/review BEHAVIOR (permission gating, status transitions,
 * terminal lock, converted_ref) is owned by the #331 API test (test-task-proposals). Here we verify the
 * maintainer-only page: gates on isAdmin, calls the real admin endpoints, shows the four statuses, locks
 * terminal proposals, carries the "suggestion ≠ contribution/reward; convert ≠ auto-create build_task"
 * boundary, and renders no economic field (parse-don't-prose: comments may NAME forbidden words).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(HERE, '..', 'src', 'pwa', 'public', 'app.js'), 'utf8')

const startIdx = app.indexOf('PR9I — Task Proposal Inbox admin review')
const endIdx = app.indexOf('async function renderAdminKPI(app)')
const BLOCK = startIdx >= 0 && endIdx > startIdx ? app.slice(startIdx, endIdx) : ''
const CODE = BLOCK.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

function main(): void {
  ok('PR9I block found in app.js', BLOCK.length > 1000, `start=${startIdx} end=${endIdx}`)

  // wiring
  ok('route() dispatches #admin/task-proposals → renderAdminTaskProposals', /params\[0\] === 'task-proposals'\)\s*return renderAdminTaskProposals\(app\)/.test(app))
  ok('admin hub links to #admin/task-proposals', /adminLinkCard\([^\n]*'#admin\/task-proposals'\)/.test(app))
  ok('renderAdminTaskProposals defined', /async function renderAdminTaskProposals\(app\)/.test(app))

  // maintainer-only gate
  ok('gated on isAdmin (else 仅限管理员)', /if \(!isAdmin\(\)\)/.test(BLOCK) && /仅限管理员/.test(BLOCK))

  // calls the real #331 admin endpoints (no new backend)
  ok('GET /admin/task-proposals (with optional status filter)', /GET\('\/admin\/task-proposals'/.test(BLOCK) && /\?status=/.test(BLOCK))
  ok('POST /admin/task-proposals/:id/review', /POST\('\/admin\/task-proposals\/' \+ encodeURIComponent\(id\) \+ '\/review'/.test(BLOCK))

  // all four statuses surfaced + filter chips
  for (const s of ['new', 'needs_info', 'rejected', 'converted']) ok(`status surfaced: ${s}`, BLOCK.includes(`${s}:`) || new RegExp(`'${s}'`).test(BLOCK))
  ok('status filter chips → setProposalStatusFilter', /setProposalStatusFilter\(/.test(BLOCK))

  // review actions: the three target transitions, convert-only converted_ref
  ok('review buttons: needs_info / rejected / converted', /reviewProposal\('\$\{escHtml\(p\.id\)\},?'?,?\s*'needs_info'\)|reviewProposal\([^)]*'needs_info'\)/.test(BLOCK) && /'rejected'\)/.test(BLOCK) && /'converted'\)/.test(BLOCK))
  ok('converted_ref only sent on convert', /if \(status === 'converted' && ref\) body\.converted_ref = ref/.test(BLOCK))

  // terminal proposals are locked (no review actions for rejected/converted)
  ok('terminal (rejected/converted) → locked, no review buttons', /const terminal = p\.status === 'rejected' \|\| p\.status === 'converted'/.test(BLOCK) && /Terminal — locked|终态/.test(BLOCK) && /terminal\s*\n?\s*\?/.test(BLOCK))

  // boundary: suggestion ≠ contribution/reward/participation; convert ≠ auto-create a build_task
  ok('boundary: proposal is a suggestion, not contribution/reward/participation', /not a contribution fact|不是贡献事实/i.test(BLOCK) && /reward|奖励/i.test(BLOCK))
  ok('boundary: convert does NOT auto-create a build_task', /does NOT auto-create a build_task|不会自动创建 build_task/i.test(BLOCK))
  ok('renders the value_boundary notice from the response', /value_boundary\?\.notice_en|value_boundary\?\.notice_zh/.test(BLOCK))

  // no economic value rendered (data-field bindings + currency literals; prose/disclaimer may name them)
  const ECON_FIELD = /\.(reward|payout|amount|score|price)\b/
  ok('no economic data-field binding', !ECON_FIELD.test(CODE), (CODE.match(ECON_FIELD) || []).join(','))
  ok('no currency-amount literal', !/[$￥€]\s*\d|\b\d+(\.\d+)?\s*(USD|USDT|CNY|RMB|WAZ|元)\b/.test(CODE))

  // XSS-safe: proposal fields are escaped
  ok('proposal fields escaped via escHtml', /escHtml\(p\.title\)/.test(BLOCK) && /escHtml\(p\.summary\)/.test(BLOCK))

  if (fail === 0) {
    console.log(`\n✅ proposal admin-review UI (PR9I): maintainer-gated · GET list + POST review over the #331 admin endpoints · four statuses + filter · needs_info/rejected/convert with convert-only converted_ref · terminal locked · suggestion ≠ contribution/reward & convert ≠ auto-create build_task boundary + value_boundary notice · no economic field · escaped\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ proposal admin-review UI contract FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
