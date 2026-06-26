#!/usr/bin/env tsx
/**
 * RFC-020 PR-D2 — connected-agents UI wiring (static source contract).
 *   用法:npm run test:connected-agents-ui
 *
 * Classic-script UI in app-agents.js, routed from app.js, linked from app-account.js.
 * Verifies the wiring the app.js-split discipline requires (load order, route, nav,
 * endpoints, i18n parity) without a browser. Read + revoke only; no money path.
 */
import { readFileSync } from 'node:fs'
const agents = readFileSync('src/pwa/public/app-agents.js', 'utf8')
const appjs = readFileSync('src/pwa/public/app.js', 'utf8')
const account = readFileSync('src/pwa/public/app-account.js', 'utf8')
const indexHtml = readFileSync('src/pwa/public/index.html', 'utf8')
const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// 1) app-agents.js defines the view + revoke handler, reads the right endpoints
ok('renderConnectedAgents defined', /async function renderConnectedAgents\(app\)/.test(agents))
ok('revokeAgentGrant defined', /async function revokeAgentGrant\(grantId\)/.test(agents))
ok('reads GET /agent-grants', /GET\('\/agent-grants'\)/.test(agents))
ok('revoke POSTs /agent-grants/:id/revoke', /POST\(`\/agent-grants\/\$\{grantId\}\/revoke`/.test(agents))
ok('shows recent-use (last_used_at + use_count)', /last_used_at/.test(agents) && /use_count/.test(agents))
ok('shows status/expiry (active + expires_at)', /\.active/.test(agents) && /expires_at/.test(agents))
ok('revoke confirms before acting', /confirm\(/.test(agents))
// boundary: read + revoke only, no money/issue surface
ok('no grant issuance / money path in the UI', !/place_order|wallet|\/agent-grants'\s*,\s*\{[^}]*method:\s*'POST'/.test(agents) && !/gtk_/.test(agents))

// 2) app.js routes #agents → renderConnectedAgents (classic split rule)
ok('app.js route() has case agents → renderConnectedAgents', /case 'agents':\s*return renderConnectedAgents\(app\)/.test(appjs))

// 3) app-account.js links to it (discoverable nav)
ok('app-account.js settings links to #agents', /navigate\('#agents'\)/.test(account))

// 4) index.html loads app-agents.js BEFORE app.js
const iAgents = indexHtml.indexOf('app-agents.js')
const iApp = indexHtml.indexOf('/app.js"')
ok('index.html loads app-agents.js', iAgents > 0)
ok('app-agents.js loaded before app.js', iAgents > 0 && iApp > 0 && iAgents < iApp)

// 5) i18n parity — every new zh string used has an EN entry
for (const k of ['🔌 已连接的 Agent', '尚无已连接的 Agent', '有效期至', '最近使用', '次调用', '从未使用', '撤销访问', '仅安全只读权限', '已撤销该 Agent 的访问']) {
  ok(`i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
}

if (fail === 0) {
  console.log(`\n✅ connected-agents UI (PR-D2): app-agents.js view + revoke; routed from app.js; linked from settings; load order + i18n parity; read+revoke only\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ connected-agents UI FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
