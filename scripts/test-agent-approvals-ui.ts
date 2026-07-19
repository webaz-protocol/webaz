#!/usr/bin/env tsx
/**
 * RFC-020 — #agent-approvals 扩权审批页 前端接线 + 安全属性(静态断言;端到端逻辑见 test:agent-permission-requests).
 *   覆盖:路由存在 / 装载 / 未登录提示 / 列出待批请求 / Passkey 批准(绑 request_id)/ 拒绝 / 空态 /
 *   风险徽章 / 时长展示 / bundle 摘要优先 / 设置页入口+待办 badge / 不显示 raw 凭证 / 后端 Passkey 边界 / i18n.
 * Usage: npm run test:agent-approvals-ui
 */
import { readFileSync } from 'fs'
import vm from 'node:vm'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// P0-A A2:审批页拆成 渲染壳(app-agent-approvals.js)+ 状态机/交互(app-agent-approvals-state.js);
//   ratchet 上限使新代码禁回塞主文件。断言按功能查两文件的并集(UI),读/写超时助手在 app-api-async.js。
const UI_MAIN = readFileSync('src/pwa/public/app-agent-approvals.js', 'utf8')
const UI_STATE = readFileSync('src/pwa/public/app-agent-approvals-state.js', 'utf8')
const UI_SUBMIT = readFileSync('src/pwa/public/app-agent-approvals-submit.js', 'utf8')
const UI = UI_MAIN + '\n' + UI_STATE
const APIASYNC = readFileSync('src/pwa/public/app-api-async.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const ACCOUNT = readFileSync('src/pwa/public/app-account.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const CEIL = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')
const GRANTS = readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')
const WEBAUTHN = readFileSync('src/pwa/routes/webauthn.ts', 'utf8')
const HP = readFileSync('src/pwa/human-presence.ts', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')

// ── 路由 + 装载 ──
ok('1. router: #agent-approvals → renderAgentApprovals', /case 'agent-approvals':\s*return window\.renderAgentApprovals\(app\)/.test(APP))
ok('2. module loaded in index.html', HTML.includes('app-agent-approvals.js'))
ok('3. module in check:pwa-syntax', PKG.includes('app-agent-approvals.js'))
ok('4. module registered in complexity ceiling', /app-agent-approvals\.js'?:\s*\d+/.test(CEIL))
ok('5. defines window.renderAgentApprovals', /window\.renderAgentApprovals\s*=/.test(UI))

// ── 页面行为要点 ──
ok('6. not-logged-in guard (prompt login)', /if \(!state\.user\)/.test(UI))
ok('7. lists pending requests via apiRead (timeout-guarded) /agent-grants/permission-requests', /apiRead\('\/agent-grants\/permission-requests'\)/.test(UI))
ok('8. approve goes through Passkey ceremony (agent_permission_approve)', /requestPasskeyGate\('agent_permission_approve'/.test(UI))
ok('9. approve POSTs /permission-requests/:id/approve with webauthn_token', /permission-requests\/'[\s\S]{0,60}\/approve'[\s\S]{0,80}webauthn_token/.test(UI))
ok('10. reject path calls the reject endpoint', /\/reject'/.test(UI) && /aaReject/.test(UI))
ok('11. empty state when no pending requests', UI.includes('暂无待处理的授权请求'))
ok('12. renders a risk badge (low/medium/high)', /低风险/.test(UI) && /中风险/.test(UI) && /高风险/.test(UI))
ok('13. shows grant duration (via the shared selector)', /grantDurationSelect\(/.test(UI))
ok('14. prefers the human bundle summary, falls back to scope chips', /human_summary/.test(UI) && /requested_scopes/.test(UI))

// ── 入口 + 通知 badge(设置页)──
ok('15. settings nav links to #agent-approvals', /navigate\('#agent-approvals'\)/.test(ACCOUNT))
ok('16. settings shows a pending-count badge element', /id="aa-pending-badge"/.test(ACCOUNT))
ok('17. badge hydrated from account render (net-zero piggyback)', /hydrateAgentApprovalsBadge\(\)/.test(ACCOUNT) && /window\.hydrateAgentApprovalsBadge\s*=/.test(UI))

// ── 安全属性 ──
ok('18. agent label framed as unverified', UI.includes('未验证'))
ok('19. framed as safe-only (never money/vote/arbitrate/keys)', /资金.*投票.*仲裁|安全只读|SAFE/.test(UI))
ok('20. no raw credential rendered (no bearer/token_hash/api_key display)', !/token_hash|\.api_key|gtk_/.test(UI))

// ── 后端安全边界(扩权=提权,必须真人 Passkey,绑 request)──
ok('21. backend approve is Passkey-gated (requireHumanPresence agent_permission_approve)', /requireHumanPresence\([\s\S]{0,140}'agent_permission_approve'/.test(GRANTS))
ok('22. Passkey token BOUND to the request: approve validate checks request_id === req.params.id', /request_id === req\.params\.id/.test(GRANTS))
ok('23. frontend requests the gate with { request_id } (purpose_data binding)', /requestPasskeyGate\('agent_permission_approve',\s*\{\s*request_id/.test(UI))
ok('24. agent_permission_approve in HumanPresencePurpose whitelist', /agent_permission_approve/.test(HP))
ok('25. agent_permission_approve in webauthn auth/start allowed purposes', /'agent_permission_approve'/.test(WEBAUTHN))

// ── duration choice (human can change the grant lifetime at approve) ──
ok('26a. each card renders the shared duration selector (per-request id)', /grantDurationSelect\(r\.allowed_durations, r\.duration, 'aa-dur-' \+ escHtml\(String\(r\.id\)\)\)/.test(UI))
ok('26b. approve sends the chosen duration (shared reader)', /grantDurationValue\('aa-dur-' \+ id\)/.test(UI) && /\/approve'[\s\S]{0,160}duration/.test(UI))
ok('26c. backend approve honors a human duration override, strict-validated (400 on invalid, no silent fallback)', /durationAllowedForScopes\(reqScopes, bodyDur\)/.test(GRANTS) && /INVALID_GRANT_DURATION/.test(GRANTS) && /effDuration: GrantDuration = \(bodyDur !== undefined/.test(GRANTS))

// ── P0-A A2/A3/A4 — 状态机 + 读写分离超时 + reconcile + fail-visible(browser-smoke 等价静态断言）──
ok('A2-1. app-api-async.js exposes apiRead with AbortSignal.timeout (reads never hang)', /window\.apiRead = async function/.test(APIASYNC) && /apiRead[\s\S]{0,400}AbortSignal\.timeout/.test(APIASYNC))
ok('A2-2. app-api-async.js exposes apiWriteIdempotent that flags unknownOutcome on timeout (no blind retry)', /window\.apiWriteIdempotent = async function/.test(APIASYNC) && /unknownOutcome: true/.test(APIASYNC) && /apiWriteIdempotent[\s\S]{0,400}AbortSignal\.timeout/.test(APIASYNC))
ok('A2-0. split files wired: state + api-async in index.html + pwa-syntax + LOC_CEILINGS', /app-agent-approvals-state\.js/.test(HTML) && /app-api-async\.js/.test(HTML) && /app-agent-approvals-state\.js/.test(PKG) && /app-api-async\.js/.test(PKG) && /app-agent-approvals-state\.js/.test(CEIL) && /app-api-async\.js/.test(CEIL))
ok('A2-3. hydrate resets to loading$() so every branch replaces the spinner', /box\.innerHTML = loading\$\(\)/.test(UI))
ok('A2-4. read errors map to explicit states (timeout / network / 401)', /加载超时/.test(UI) && /网络异常/.test(UI) && /登录已失效/.test(UI))
ok('A2-5. every error card offers an actionable next step (retry / back / re-login)', /aaErrorCard/.test(UI) && /aaHydrate\(\)/.test(UI) && /navigate\('me'\)/.test(UI))
ok('A2-6. deep-link terminal state via the A1 single-detail endpoint (executed/rejected/expired)', /permission-requests\/' \+ encodeURIComponent\(id\)/.test(UI) && /aaRenderDeepTerminal/.test(UI))
ok('A2-7. approve is an idempotent write; timeout → reconcile via re-read, NOT blind retry', /apiWriteIdempotent\('POST'[\s\S]{0,160}\/approve/.test(UI) && /w\.unknownOutcome[\s\S]{0,260}apiRead\('\/agent-grants\/permission-requests\//.test(UI))
ok('A2-8. reconcile: executed → success, else safe to re-approve (never duplicate)', /String\(chk\.data\.status\) === 'executed'/.test(UI) && /不会重复下单/.test(UI))
ok('A2-9. incomplete economic data DISABLES approve — fail-closed (missing summary/currency/rail, not only the server marker)', /aaEconomicIncomplete = function/.test(UI) && /!s \|\| typeof s !== 'object' \|\| s\.payable_units == null \|\| !s\.currency \|\| !s\.payment_rail/.test(UI) && /econIncomplete \? ' disabled/.test(UI))
ok('A2-10. auxiliary logic (aaMarkSimilarSubmits) wrapped in try/catch — never blocks main render', /try \{ if \(window\.aaMarkSimilarSubmits\)/.test(UI))
ok('A2-11. badge read also timeout-guarded (apiRead, no hang)', /apiRead\('\/agent-grants\/permission-requests'\)[\s\S]{0,120}aa-pending-badge|aa-pending-badge[\s\S]{0,200}apiRead\('\/agent-grants\/permission-requests'\)/.test(UI))

// ── B6 (P0): order_submit approval card must actually RENDER (behavioral vm run) — a static regex could not catch
//    the real production crash "row is not defined" (aaOrderSubmitWhat called an undefined row() helper since PR-5a). ──
const runSubmitCard = (r: unknown): { html?: string; threw?: string } => {
  const ctx: Record<string, unknown> = { window: {} as Record<string, unknown>, t: (s: string) => s, escHtml: (s: string) => String(s), console }
  ctx.globalThis = ctx
  try {
    vm.createContext(ctx); vm.runInContext(UI_SUBMIT, ctx)
    const fn = (ctx.window as Record<string, unknown>).aaOrderSubmitWhat as ((r: unknown) => string) | undefined
    if (typeof fn !== 'function') return { threw: 'aaOrderSubmitWhat not defined' }
    return { html: fn(r) }
  } catch (e) { return { threw: (e as Error).message } }
}
const escrowSummary = { submit_summary: { product_id: 'prd_a', product_title: 'AAA', quantity: 1, unit_price_units: 4_070_000, item_units: 4_070_000, shipping_units: 0, payable_units: 4_070_000, total_units: 4_070_000, currency: 'USDC', payment_rail: 'escrow', seller_handle: '@s', seller_id_hint: 'usr_***', dest_region: 'SG', draft_id: 'odr_1', draft_expires_at: '2026-07-20T16:50:00Z', draft_status: 'draft' }, kind: 'order_submit' }
const directNoAcct = { submit_summary: { ...escrowSummary.submit_summary, payment_rail: 'direct_p2p', direct_receive_account_id: null }, kind: 'order_submit' }
const rEscrow = runSubmitCard(escrowSummary)
ok('B6-1. order_submit card RENDERS without throwing (row helper defined — regression for "row is not defined")', !rEscrow.threw && !!rEscrow.html)
ok('B6-2. rendered card shows the hash-bound term rows (单价/运费/支付轨道/卖家/收货/草稿)', !!rEscrow.html && ['单价', '运费', '支付轨道', '卖家', '收货', '草稿'].every(k => rEscrow.html!.includes(k)))
const rDirect = runSubmitCard(directNoAcct)
ok('B6-3. direct_p2p with no receiving account renders (no crash) + shows the missing-account warning', !rDirect.threw && !!rDirect.html && rDirect.html.includes('卖家未配置直付收款账户'))
ok('B6-4. fail-closed gate: aaEconomicIncomplete blocks direct_p2p order_submit lacking direct_receive_account_id', /s\.payment_rail === 'direct_p2p' && !s\.direct_receive_account_id/.test(UI_STATE))
ok('B6-5. new UI strings are bilingual (t + _EN entry present)', I18N.includes('卖家未配置直付收款账户,无法确认收款目的地 —— 已禁止批准') && I18N.includes('关键条款不完整(金额/币种/支付轨道/收款账户)'))

// ── i18n parity ──
{
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![A-Za-z])t\('([^']+)'\)/g)) keys.add(m[1])
  const noEn = [...keys].filter(k => !I18N.includes(`'${k.replace(/\\/g, '\\\\')}':`))
  ok('26. i18n parity (all literal t() keys have EN)', keys.size >= 12 && noEn.length === 0)
}

if (fail > 0) { console.error(`\n❌ agent-approvals-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ #agent-approvals 扩权审批页: route + wiring + not-logged-in + list pending + Passkey approve (bound to request_id) + reject + empty state + risk badge + duration + bundle summary + settings entry & pending badge + no raw credential + backend Passkey/bound gate + i18n\n  ✅ pass ${pass}`)
