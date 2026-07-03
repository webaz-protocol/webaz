#!/usr/bin/env tsx
/**
 * PR-F 仲裁员管理 admin UI + 仲裁员入口(纯 UI 接线守卫;后端权限才是安全边界)。
 *  - grant:handle/user_id → /admin/users/lookup → requestPasskeyGate('arbitrator_grant',{user_id}) → POST。
 *  - suspend/reinstate/revoke:requestPasskeyGate('arbitrator_<action>') → POST /admin/arbitrators/:id/:action。
 *  - roster:GET /admin/arbitrators。路由 #admin/arbitrators + root-only 卡片。
 *  - whitelist-only 仲裁员个人页入口卡 arbTaishCard 跟随 state.canArbitrate。
 * Usage: npm run test:arbitrator-admin-ui
 */
import { readFileSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const UI = readFileSync('src/pwa/public/app-arbitrator-admin.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const PROFILE = readFileSync('src/pwa/public/app-profile.js', 'utf8')
const ENTRY = readFileSync('src/pwa/public/app-arbitrator-entry.js', 'utf8')
const WEBAUTHN = readFileSync('src/pwa/routes/webauthn.ts', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

ok('1. registered (index + pwa-syntax + ratchet)', HTML.includes('/app-arbitrator-admin.js') && /node --check src\/pwa\/public\/app-arbitrator-admin\.js/.test(PKG) && /'src\/pwa\/public\/app-arbitrator-admin\.js'\s*:/.test(RATCHET))
ok('2. page guard: isAdmin() FIRST, then root-only (无 admin_type 的普通用户不再被默认当 root)', /renderAdminArbitrators = async/.test(UI) && /typeof isAdmin === 'function' && !isAdmin\(\)/.test(UI) && /admin_type \|\| 'root'\) !== 'root'/.test(UI) && UI.indexOf('!isAdmin()') < UI.indexOf("!== 'root'"))
ok('3. grant: lookup → Passkey(arbitrator_grant, target user_id) → POST', /\/admin\/users\/lookup\?q=/.test(UI) && /requestPasskeyGate\('arbitrator_grant', \{ user_id: userId \}\)/.test(UI) && /POST\('\/admin\/arbitrators\/grant'/.test(UI))
ok('4. mutate: Passkey(arbitrator_<action>) → POST /admin/arbitrators/:id/:action', /requestPasskeyGate\('arbitrator_' \+ action, \{ user_id: userId \}\)/.test(UI) && /POST\('\/admin\/arbitrators\/' \+ userId \+ '\/' \+ action/.test(UI))
ok('5. revoke confirmed as terminal', /action === 'revoke'[\s\S]{0,80}confirmModal/.test(UI))
ok('6. roster read GET /admin/arbitrators', /GET\('\/admin\/arbitrators'\)/.test(UI) && /arbAdminHydrate/.test(UI))
ok('7. app.js routes #admin/arbitrators → renderAdminArbitrators', /params\[0\] === 'arbitrators'\) return renderAdminArbitrators\(app\)/.test(APP))
ok('8. app.js admin panel has a root-only arbitrator card → #admin/arbitrators', /adminLinkCard\('⚖', t\('仲裁员管理'\)[\s\S]{0,120}'#admin\/arbitrators'\)/.test(APP))
ok('9. whitelist-only entry card follows state.canArbitrate (not role)', /window\.arbTaishCard = \(\)/.test(UI) && /#disputes/.test(UI) && /state\.canArbitrate && role !== 'arbitrator' && window\.arbTaishCard/.test(PROFILE))
ok('10. arbEntryHydrate re-renders当 can_arbitrate 首次变 true → 首屏也出现入口(不 await 阻塞 boot)', /const before = state\.canArbitrate/.test(ENTRY) && /state\.canArbitrate && !before/.test(ENTRY) && /route\(\)/.test(ENTRY))
ok('11. webauthn allow-set 含 4 个 arbitrator_* purpose(可执行验证见 test:webauthn-arbitrator-purposes)', ['arbitrator_grant', 'arbitrator_suspend', 'arbitrator_reinstate', 'arbitrator_revoke'].every(p => WEBAUTHN.includes(`'${p}'`)))

if (fail > 0) { console.error(`\n❌ arbitrator-admin-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ arbitrator-admin-ui: grant/suspend/reinstate/revoke via Passkey + roster + root-only + whitelist-only entry follows can_arbitrate\n  ✅ pass ${pass}`)
