#!/usr/bin/env tsx
/**
 * PR9E-1 — Public Contribution Pages contract (static source check over src/pwa/public/app.js).
 *   用法:npm run test:public-contribution-pages
 *
 * The PWA is one large IIFE (no module exports, no DOM test harness in this repo), so — like
 * test-public-contributor-entry-contract — we lock the page wiring as a SOURCE contract. The BEHAVIORAL
 * guarantees (public/open visibility, restricted/internal 404 no-leak, suggest success, typed
 * RATE_LIMITED/DUPLICATE errors) are owned by the API tests #329/#330/#331; here we verify the client:
 *   1. lists tasks from the PUBLIC endpoint (so only audience=public + status=open ever render);
 *   2. NEVER calls the member /api/build-tasks read surface (no restricted/internal can leak in);
 *   3. detail shows the canonical_contribution_target + a copy-ready agent prompt;
 *   4. the prompt names the boundary / forbidden / prohibited / verification / canonical-repo PR rule, and
 *      that a sandbox / local draft is NOT participation;
 *   5. suggest posts to the public proposals endpoint and surfaces proposal.id on success;
 *   6. RATE_LIMITED / DUPLICATE_PROPOSAL are mapped to human-legible messages;
 *   7. NO economic value is rendered — the pages bind no reward/payout/amount/score/price field and print
 *      no currency/percent numeric literal (parse-don't-prose: comments MAY name forbidden words to forbid
 *      them; we scan data-field bindings + numeric literals, never prose);
 *   8/9. build + #329/#330/#331 are verified by the CI battery, not here.
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

// Slice just the PR9E-1 block (marker → renderRule) so assertions are scoped to the contribute pages.
const startIdx = app.indexOf('PR9E-1 Public Contribution Pages')
const endIdx = app.indexOf('function renderRule(num, text)')
const BLOCK = startIdx >= 0 && endIdx > startIdx ? app.slice(startIdx, endIdx) : ''

// A version with line/block comments stripped — used for the economic-field scan so prose that NAMES a
// forbidden word in order to forbid it is not a false positive (repo convention: parse-don't-prose).
const CODE = BLOCK.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

function main(): void {
  ok('PR9E-1 block found in app.js', BLOCK.length > 1000, `start=${startIdx} end=${endIdx}`)

  // ── wiring: routes + public allowlist ──────────────────────────────────────────────────────────────
  ok('route() dispatches #contribute', /case 'contribute':/.test(app))
  ok('#contribute/tasks/suggest → renderContributeSuggest', /params\[0\] === 'tasks' && params\[1\] === 'suggest'\) return renderContributeSuggest/.test(app))
  ok('#contribute/tasks/:id → renderContributeTaskDetail', /params\[0\] === 'tasks' && params\[1\]\)\s*return renderContributeTaskDetail\(app, params\[1\]\)/.test(app))
  ok('#contribute/tasks (list default) → renderContributeTasks', /case 'contribute':[\s\S]{0,400}return renderContributeTasks\(app\)/.test(app))
  ok("'contribute' is in the no-login allowlist", /page !== 'contribute'/.test(app))

  // ── logged-in entries INTO the public task board (kept semantically distinct from 我的共建) ──────────
  // #me Advanced grid: a 公开共建任务 / Contribution tasks card → #contribute/tasks
  ok('#me Advanced has a 公开共建任务 entry → #contribute/tasks',
    /card\('📋', t\('公开共建任务'\), t\('浏览可认领任务、提交建议、参与共建'\), '#contribute\/tasks'\)/.test(app))
  // #my-contributions: a 查看公开共建任务 / View contribution tasks entry → #contribute/tasks
  { const mycStart = app.indexOf('async function renderMyContributions')
    const myc = mycStart > 0 ? app.slice(mycStart, app.indexOf('const TICKET_TYPE_META', mycStart)) : ''
    ok('#my-contributions has a 查看公开共建任务 entry → #contribute/tasks',
      /onclick="location\.hash='#contribute\/tasks'"/.test(myc) && /查看公开共建任务/.test(myc))
    ok('that entry is kept distinct from 我的共建 (board ≠ my record)', /独立于我的贡献记录/.test(myc)) }
  // i18n parity for the new entry strings (zh key → Latin EN on the same line)
  for (const k of ['公开共建任务', '查看公开共建任务', '浏览可认领任务、提交建议、参与共建']) {
    const line = i18n.split('\n').find(l => l.includes(`'${k}':`))
    ok(`i18n EN present: ${k}`, !!line && /[A-Za-z]{3,}/.test(line.slice(line.indexOf(`'${k}':`) + k.length + 3)))
  }
  ok('three page render fns defined', /async function renderContributeTasks\(app\)/.test(app) && /async function renderContributeTaskDetail\(app, id\)/.test(app) && /async function renderContributeSuggest\(app\)/.test(app))
  ok('public contribution pages expose a no-login language switch', /function contributeLangSwitchHTML\(T\)/.test(BLOCK) && /contributeSetLang/.test(BLOCK) && /中文/.test(BLOCK) && /EN/.test(BLOCK))
  ok('list/detail/suggest render through the contribution page shell', (BLOCK.match(/contributePageShell\(T,/g) || []).length >= 5)

  // ── 1 & 2: list uses ONLY the public endpoint; never the member read surface (no restricted/internal leak)
  ok('list fetches /api/public/build-tasks', /fetch\('\/api\/public\/build-tasks'/.test(BLOCK))
  ok('list maps over j.tasks (renders public/open tasks)', /const tasks = j\.tasks \|\| \[\]/.test(BLOCK) && /tasks\.map\(task =>/.test(BLOCK))
  ok('list renders title + area', /_cEsc\(task\.title\)/.test(BLOCK) && /_cEsc\(task\.area\)/.test(BLOCK))
  ok('list supports area / risk_level / auto_claimable filters', /'area', 'risk_level', 'auto_claimable'/.test(BLOCK))
  // PR9J: the FULL MCP discovery-filter set is exposed to humans (capability / duration / context / budget)
  ok('list forwards agent_capabilities / max_duration_minutes / estimated_context_size / estimated_agent_budget', /'agent_capabilities', 'max_duration_minutes', 'estimated_context_size', 'estimated_agent_budget'/.test(BLOCK))
  ok('filter UI has the new inputs (agent_capabilities / duration / context_size)', /id="ct-f-agentcaps"/.test(BLOCK) && /id="ct-f-maxdur"/.test(BLOCK) && /id="ct-f-ctx"/.test(BLOCK))
  ok('filter UI has the estimated_agent_budget (agent effort) select', /id="ct-f-budget"/.test(BLOCK) && /agent effort|工作量/.test(BLOCK))
  ok('budget select is framed as effort, not money (no cost/payment/reward)', /not a cost|不是费用/.test(BLOCK))
  ok('agent_capabilities filter is the "tasks you can do" subset filter', /tasks you can do|你能做的任务/.test(BLOCK))
  ok('contributeApplyFilters sets the new query params', /p\.set\('agent_capabilities'/.test(app) && /p\.set\('max_duration_minutes'/.test(app) && /p\.set\('estimated_context_size'/.test(app) && /p\.set\('estimated_agent_budget'/.test(app))
  // No member read endpoint anywhere in the block: /api/build-tasks NOT followed by /public and used for GET-list/detail.
  const memberReadHit = /fetch\([`'"]\/api\/build-tasks(['"`/?]|\$)/.test(BLOCK)
  ok('NEVER calls the member /api/build-tasks read surface (restricted/internal cannot leak)', !memberReadHit)
  ok('detail fetches /api/public/build-tasks/:id', /fetch\('\/api\/public\/build-tasks\/' \+ encodeURIComponent\(id\)/.test(BLOCK))
  ok('detail 404/non-public path shows back-to-board, not task internals', /Task not found or not public|任务不存在或非公开/.test(BLOCK))

  // ── 3: detail renders canonical target + a copy-ready prompt ────────────────────────────────────────
  ok('detail reads canonical_contribution_target from the response', /j\.canonical_contribution_target/.test(BLOCK))
  ok('detail renders the canonical repo / url / base branch', /expected_pr_base_repo|canonical_repository_full_name/.test(BLOCK) && /canonical_github_url/.test(BLOCK) && /base_branch/.test(BLOCK))
  ok('detail builds + shows a copy-ready prompt textarea', /CONTRIBUTE_PROMPT_STATE\.text = buildContributeAgentPrompt/.test(BLOCK) && /id="ct-prompt"/.test(BLOCK) && /contributeCopyPrompt\(\)/.test(BLOCK))

  // ── 4: prompt content — boundary / forbidden / prohibited / verification / canonical repo / not-participation
  const promptStart = BLOCK.indexOf('function buildContributeAgentPrompt')
  const promptEnd = BLOCK.indexOf("window.contributeApplyFilters")
  const PROMPT = promptStart >= 0 && promptEnd > promptStart ? BLOCK.slice(promptStart, promptEnd) : ''
  ok('prompt fn isolated', PROMPT.length > 200)
  ok('prompt names allowed/forbidden paths', /Allowed paths/.test(PROMPT) && /Forbidden paths/.test(PROMPT))
  ok('prompt names prohibited actions', /Prohibited actions/.test(PROMPT))
  ok('prompt names verification commands', /Verification commands/.test(PROMPT) && /m\.verification_commands/.test(PROMPT))
  ok('prompt requires a PR to the canonical repo (base repo)', /BASE repository is the canonical WebAZ repo/.test(PROMPT) && /cct\.expected_pr_base_repo/.test(PROMPT))
  ok('prompt: STOP if target repo differs from canonical', /STOP and ask the human to confirm/.test(PROMPT) && /non-canonical repository/.test(PROMPT))
  ok('prompt: sandbox / local draft is NOT participation', /sandbox run or a local-only draft is NOT participation/i.test(PROMPT))
  ok('prompt: only a merged PR (canonical) enters the record', /Only a merged PR.*enters the contribution record/i.test(PROMPT))
  ok('prompt: DCO sign-off + agent is only an executor', /git commit -s/.test(PROMPT) && /agent is only an executor/i.test(PROMPT))

  // ── 5: suggest posts to public proposals + shows proposal id ────────────────────────────────────────
  ok('suggest posts to /public/task-proposals', /apiWithStatus\('POST', '\/public\/task-proposals'/.test(BLOCK))
  ok('suggest form has all 6 fields', ['cs-title', 'cs-summary', 'cs-area', 'cs-outcome', 'cs-source', 'cs-login'].every(id => BLOCK.includes(id)))
  ok('suggest success renders proposal id', /r\.proposal\.id/.test(BLOCK) && /Proposal id|建议编号/.test(BLOCK))
  ok('suggest success states: not a contribution fact / reward / participation', /not a contribution fact|不是贡献事实/.test(BLOCK))

  // ── 6: typed errors RATE_LIMITED / DUPLICATE_PROPOSAL legible ───────────────────────────────────────
  ok('handles RATE_LIMITED → human message', /RATE_LIMITED/.test(BLOCK) && /Too many submissions|提交太频繁/.test(BLOCK))
  ok('handles DUPLICATE_PROPOSAL → human message + existing_id', /DUPLICATE_PROPOSAL/.test(BLOCK) && /already in the inbox|已在收件箱中/.test(BLOCK) && /existing_id/.test(BLOCK))

  // ── value boundary present on every page ────────────────────────────────────────────────────────────
  ok('list + suggest show a value boundary', (BLOCK.match(/_cBoundaryHTML\(/g) || []).length >= 2)
  ok('detail shows the value_boundary from the payload', /_cBoundaryHTML\(task\.value_boundary \|\| j\.value_boundary/.test(BLOCK))
  ok('boundary states uncommitted / RFC-017 I-12', /uncommitted/.test(BLOCK) && /RFC-017 I-12/.test(BLOCK))

  // ── 7: NO economic-PROMISE field rendered — no reward/payout/amount/score/price/currency/payment, and
  //   no currency-amount literal. NB: estimated_agent_budget is a resource/EFFORT estimate filter (not a
  //   payment), so it is deliberately NOT in this list; and inline CSS legitimately uses % / px so a bare
  //   percent/multiplier scan can't apply here.
  const ECON_FIELD = /\.(reward|payout|amount|score|price|currency|payment)\b/
  ok('no economic-promise data-field binding in page code', !ECON_FIELD.test(CODE), (CODE.match(ECON_FIELD) || []).join(','))
  ok('no currency-amount literal', !/[$￥€]\s*\d|\b\d+(\.\d+)?\s*(USD|USDT|CNY|RMB|WAZ|元|dollars?)\b/.test(CODE))

  // ── claim is login-gated; no auto GitHub op from the browser ────────────────────────────────────────
  ok('claim button gated on login (state.apiKey)', /window\.contributeClaim = async/.test(BLOCK) && /if \(!state\.apiKey\)/.test(BLOCK) && /navigate\('#login'\)/.test(BLOCK))
  ok('claim only POSTs the guarded member claim endpoint (no GitHub op)', /apiWithStatus\('POST', '\/build-tasks\/' \+ id \+ '\/claim'/.test(BLOCK))
  ok('no GitHub write / merge / PR submission from the browser', !/api\.github\.com|\/merge|createPullRequest|git push/i.test(CODE))

  if (fail === 0) {
    console.log(`\n✅ public contribution pages (PR9E-1): list/detail/suggest over the public APIs · public-scope only (no restricted/internal leak) · canonical target + copy-ready agent prompt (boundary/forbidden/prohibited/verification/canonical-repo PR/sandbox≠participation) · suggest shows proposal id + typed RATE_LIMITED/DUPLICATE · value boundary on every page · no economic field/numeric · claim login-gated, no browser GitHub op\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ public contribution pages contract FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
