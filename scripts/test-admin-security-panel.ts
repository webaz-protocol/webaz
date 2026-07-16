#!/usr/bin/env tsx
/**
 * admin identity & access panel (#admin/security) — source contract (static).
 *   用法:npm run test:admin-security-panel
 *
 * 只读自查面板:回答"我正在以什么身份/级别/权限操作",Passkey 问责绑定 + GitHub 关联 +
 * 普通 admin vs root/破玻璃 + 经济操作审计须知。纯前端(/me + 只读 github/me),无后端、无经济动作。
 */
import { readFileSync } from 'node:fs'
// app.js + app-admin.js: renderAdminSecurity + the admin-dashboard quick links
// were split into a second classic script; this static-source contract spans
// both files so it survives the relocation.
const app = readFileSync('src/pwa/public/app.js', 'utf8')
  + '\n' + readFileSync('src/pwa/public/app-admin.js', 'utf8')
const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// routing + dashboard entry
ok('router dispatches #admin/security → renderAdminSecurity', /params\[0\] === 'security'\)\s*return renderAdminSecurity\(app\)/.test(app))
ok('admin dashboard links to #admin/security', /quickAction\('#admin\/security'/.test(app))
ok('admin dashboard also surfaces the audit-log viewer', /quickAction\('#admin\/audit'/.test(app))

const fn = app.slice(app.indexOf('async function renderAdminSecurity'), app.indexOf('async function renderAdminSecurity') + 6800)
ok('renderAdminSecurity exists', fn.length > 100)
ok('page is admin-gated client-side', /if \(!isAdmin\(\)\)/.test(fn))
ok('reads own identity from /me (state.user), not a privileged admin list', /const u = state\.user/.test(fn))
ok('reads GitHub binding read-only + graceful', /GET\('\/contribution-identity\/github\/me'\)\.catch\(\(\) => null\)/.test(fn))

// shows role / tier / scope / permissions
ok('shows root vs regional tier', /ROOT/.test(fn) && /REGIONAL/.test(fn))
ok('names break-glass / system operator for root', /破玻璃 \/ 系统操作员/.test(fn))
ok('shows admin scope', /escHtml\(scope\)/.test(fn))
ok('shows effective permissions', /有效权限/.test(fn) && /permChips/.test(fn))

// accountability bindings
ok('shows Passkey state + bind nudge when missing', /hasPasskey/.test(fn) && /去绑定/.test(fn))
ok('shows GitHub linkage + claim link when unlinked', /github:\$\{escHtml\(String\(b\.github_actor_id\)\)\}/.test(fn) && /去认领/.test(fn))
ok('honest copy: personal-submit vs org/admin governance, no faked independent review', /独立审阅不应由同一人用另一账号假冒/.test(fn))

// founder / bootstrap mode (root only): labeled + framed temporary + split roadmap
ok('founder/bootstrap banner shown for root', /isRoot \? `[\s\S]{0,400}Founder Admin · Bootstrap Operator/.test(fn))
ok('founder mode framed as TRANSITIONAL governance', /过渡治理模式/.test(fn))
ok('founder mode notes the future split into narrower roles', /maintainer \/ support operator \/ arbitrator \/ finance reviewer \/ security admin/.test(fn))

// safety notes — honest framing (must NOT overclaim full audit coverage; Codex P2)
ok('safety: economic/protocol actions need protocol perm', /经济 \/ 协议级操作需 protocol 权限/.test(fn))
ok('safety: audit framed as governance rule + coverage being completed (no overclaim)', /须记入审计日志[\s\S]{0,40}补齐中/.test(fn))
ok('safety: does NOT claim all economic actions are already audit-logged', !/且全部写入审计日志/.test(fn))
ok('safety: dangerous actions need reason + cannot bypass dispute/arbitration', /不可绕过争议 \/ 仲裁规则/.test(fn))

// read-only: the page itself performs no mutations
ok('page is read-only (no POST/PUT/PATCH/DELETE inside the panel)', !/\b(POST|PUT|PATCH|DELETE)\(/.test(fn))

// founder/bootstrap design doc exists + covers the split roadmap + invariants
// docs/ADMIN-FOUNDER-BOOTSTRAP.md is an internal ops doc, excluded from the public Genesis tree.
// Present on the private archive → its content checks run; absent on the public tree → skip them
// (the panel-code + i18n checks above/below always run).
{ let doc = ''; try { doc = readFileSync('docs/ADMIN-FOUNDER-BOOTSTRAP.md', 'utf8') } catch {}
  if (doc === '') {
  console.log('SKIP: docs/ADMIN-FOUNDER-BOOTSTRAP.md absent (excluded from public tree); 7 bootstrap-doc checks n/a')
  } else {
  ok('founder/bootstrap design doc exists', doc.length > 200)
  ok('doc covers write-risk tiers (safe / economic / destructive)', /Safe operational/i.test(doc) && /Economic \/ protocol/i.test(doc) && /Irreversible \/ destructive/i.test(doc))
  ok('doc states no-silent-bypass + no-secret-exposure + audit invariants', /No silent bypass/i.test(doc) && /private key/i.test(doc) && /audit/i.test(doc))
  ok('doc has the role-split roadmap', /support operator|finance reviewer|security admin|maintainer/i.test(doc))
  // honesty (Codex P2): doc must not overclaim full audit coverage
  ok('doc does NOT claim audit is already fully enforced', !/are all written to the audit log/i.test(doc) && /not claimed to be 100%/i.test(doc))
  // #368 closed the flagged manual triggers; the broader uniform sweep stays open (follow-up C)
  ok('doc records manual-trigger audit closed by #368 + names them', /closed by #368/i.test(doc) && /run-settlement/i.test(doc) && /trial\/run-eval/i.test(doc))
  ok('doc keeps the broader audit-uniformity sweep open (follow-up C)', /uniform sweep/i.test(doc) && /follow-up C/i.test(doc)) } }

// i18n parity
for (const k of ['我的管理身份与权限', '角色与级别', '有效权限', '问责绑定', '操作安全须知', '安全与审计']) {
  ok(`i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
}

if (fail === 0) {
  console.log(`\n✅ admin security panel: #admin/security 只读自查(账户/级别 root-regional-破玻璃/范围/有效权限/Passkey/GitHub)+ 审计与不可绕过须知 + 诚实 submit-vs-governance + 纯只读 + i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ admin security panel FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
