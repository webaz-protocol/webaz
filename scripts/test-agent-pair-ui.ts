#!/usr/bin/env tsx
/**
 * RFC-020 — #pair agent 配对授权页 前端接线 + 安全属性(静态断言;端到端逻辑见 test:agent-pairing)。
 *   覆盖验收要点:路由存在 / code 读取 / 未登录提示 / Passkey 批准 / 拒绝 / 过期·无效 code 错误 /
 *   成功跳转 / 反钓鱼口令核对 / 不显示 raw 凭证 / 后端 approve 走 Passkey gate + reject 端点存在 / i18n。
 * Usage: npm run test:agent-pair-ui
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const UI = readFileSync('src/pwa/public/app-agent-pair.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const GRANTS = readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')
const WEBAUTHN = readFileSync('src/pwa/routes/webauthn.ts', 'utf8')
const HP = readFileSync('src/pwa/human-presence.ts', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')

// ── 路由 + 装载 ──
ok('1. router: #pair → renderAgentPair', /case 'pair':\s*return window\.renderAgentPair\(app\)/.test(APP))
ok('2. module loaded in index.html', HTML.includes('app-agent-pair.js'))
ok('3. module in check:pwa-syntax', PKG.includes('app-agent-pair.js'))
ok('4. defines window.renderAgentPair', /window\.renderAgentPair\s*=/.test(UI))

// ── 页面行为要点(源码断言)──
ok('5. reads code from URL hash query', /_urlQuery.*\.code/.test(UI))
ok('6. not-logged-in guard (prompt login, code preserved by router intended-hash)', /if \(!state\.user\)/.test(UI))
ok('7. reads pairing detail via GET /agent-grants/pair/:code', /GET\('\/agent-grants\/pair\/'/.test(UI))
ok('8. approve goes through Passkey ceremony (agent_pair_approve)', /requestPasskeyGate\('agent_pair_approve'/.test(UI))
ok('9. approve POSTs with webauthn_token', /\/approve[\s\S]{0,80}webauthn_token/.test(UI))
ok('10. reject path calls the reject endpoint', /\/reject'/.test(UI) && /dpairReject/.test(UI))
ok('11. invalid + expired/used code have explicit errors (not silent Discover)', /pairing_not_found/.test(UI) && /pairing_not_pending_or_expired/.test(UI))
ok('12. success shows scopes + link to #agents (my agents)', /navigate\('#agents'\)/.test(UI))

// ── 安全属性 ──
ok('13. anti-phishing: user_code shown for verification + confirm required', /pair-confirm/.test(UI) && /pair-approve-btn/.test(UI))
ok('14. approve button disabled until the code-match confirm is checked', /id="pair-approve-btn" disabled/.test(UI) && /onchange=[^>]*pair-approve-btn'\)\.disabled/.test(UI))
ok('15. agent label/reason framed as unverified', UI.includes('未验证') || /unverified/.test(UI))
ok('16. capabilities framed as safe-only (never money/vote/arbitrate/keys)', /资金.*投票.*仲裁|安全只读|SAFE/.test(UI))
ok('17. no raw credential rendered on the page (no bearer/token_hash/api_key display)', !/token_hash|\.api_key|gtk_/.test(UI))

// ── 后端安全边界 ──
ok('18. backend approve is Passkey-gated (requireHumanPresence agent_pair_approve)', /requireHumanPresence\([\s\S]{0,120}'agent_pair_approve'/.test(GRANTS))
ok('19. backend reject endpoint exists (terminal rejected, no Passkey)', /pair\/:user_code\/reject/.test(GRANTS) && /status='rejected'/.test(GRANTS))
ok('20. agent_pair_approve in HumanPresencePurpose whitelist', /agent_pair_approve/.test(HP))
ok('21. agent_pair_approve in webauthn auth/start allowed purposes', /'agent_pair_approve'/.test(WEBAUTHN))
// review fixes:
ok('22. Passkey token BOUND to the code: approve validate checks user_code === req.params.user_code', /user_code === req\.params\.user_code/.test(GRANTS))
ok('23. frontend requests the gate with { user_code } (purpose_data binding)', /requestPasskeyGate\('agent_pair_approve',\s*\{\s*user_code/.test(UI))
ok('24. direct grant-issuance bypass disabled → USE_PAIRING_FLOW (no Passkey-less minting)', /app\.post\('\/api\/agent-grants',[\s\S]{0,400}USE_PAIRING_FLOW/.test(GRANTS))
ok('25. approve CAS-claims the pairing (changes!==1 guard) BEFORE minting the grant (no orphan on race)',
  /claimed\.changes !== 1/.test(GRANTS) && GRANTS.indexOf('claimed.changes !== 1') < GRANTS.indexOf('INSERT INTO agent_delegation_grants (grant_id'))

// ── duration choice (human picks the grant lifetime at approve) ──
ok('27. #pair renders the shared duration selector from consent (allowed/suggested)', /grantDurationSelect\(c\.allowed_durations, c\.suggested_duration, 'pair-duration'\)/.test(UI))
ok('28. #pair approve sends the chosen duration (shared reader)', /grantDurationValue\('pair-duration'\)/.test(UI) && /\/approve'[\s\S]{0,160}duration/.test(UI))
ok('29. backend pair/approve issues the grant with the human-chosen duration (validated), not a hardcoded 1h', /durationAllowedForScopes\(v\.safe, \(req\.body \|\| \{\}\)\.duration\)/.test(GRANTS) && /durationToSeconds\(chosenDuration\)/.test(GRANTS))
ok('30. pair/start stores + exposes suggested_duration/allowed_durations', /grant_duration/.test(GRANTS) && /allowed_durations: allowedDurationsForScopes/.test(GRANTS))

// ── i18n parity ──
{
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![A-Za-z])t\('([^']+)'\)/g)) keys.add(m[1])
  const noEn = [...keys].filter(k => !I18N.includes(`'${k.replace(/\\/g, '\\\\')}':`))
  ok('26. i18n parity (all t() keys have EN)', keys.size >= 25 && noEn.length === 0)
}

if (fail > 0) { console.error(`\n❌ agent-pair-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ #pair agent pairing authorization page: route + wiring + code read + not-logged-in + Passkey approve + reject + invalid/expired errors + success→#agents + anti-phishing code-confirm + no raw credential + backend Passkey gate/reject + i18n\n  ✅ pass ${pass}`)
