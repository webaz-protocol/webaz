#!/usr/bin/env tsx
/**
 * 角色 UI 状态一致性(全角色走查批次 1)—— 静态防回潮锚。
 *  ① 切角色/改密假登出:renderProfile 入口自愈(state.user 为空先权威重取再画 shell)。
 *  ② 仲裁台重复卡:外部仲裁员已批准区已渲染时,canArbitrate 兜底卡不再重复。
 *  ③ 审核员身份矛盾:已是 verifier 不再显示"申请审核员资格"邀请卡。
 * Usage: npm run test:role-ui-consistency
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const ACC = readFileSync('src/pwa/public/app-account.js', 'utf8')
const PROF = readFileSync('src/pwa/public/app-profile.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')

// ① renderProfile 自愈:直调路径(switchRole/addRole/set-password 置空 user)不再画出"未登录" shell
ok('1a. renderProfile self-heals a nulled state.user BEFORE drawing the shell',
  /async function renderProfile\(app\) \{\n\s*if \(state\.apiKey && !state\.user\) \{ const me = await GET\('\/me'\); if \(!me\.error\) state\.user = me \} app\.innerHTML = shell\(/.test(ACC))
ok('1b. switchRole still busts the cache (self-heal depends on null → refetch)',
  /async function switchRole\(role, btn\) \{[\s\S]{0,400}?state\.user = null\n\s*renderProfile\(/.test(APP))
ok('1c. addRole same pattern', /async function addRole\(role, btn\) \{[\s\S]{0,400}?state\.user = null\n\s*renderProfile\(/.test(APP))

// ② 仲裁台不重复:buyer my-home 的兜底卡受 !isExternalArb 门
ok('2. arbTaishCard fallback suppressed when the external-arb approved section already shows',
  /state\.canArbitrate && !isExternalArb && window\.arbTaishCard/.test(PROF))
ok('2b. trusted-role my-home fallback unchanged (role !== arbitrator gate)',
  /state\.canArbitrate && role !== 'arbitrator' && window\.arbTaishCard/.test(PROF))

// ③ 已是审核员不再被邀请申请
ok('3. verifier apply banner gated on NOT already holding the verifier role',
  /vState === 'none' && state\.user\?\.role !== 'verifier' && !\(state\.user\?\.roles \|\| \[\]\)\.includes\('verifier'\)/.test(APP))

// ④ 批次2·横幅降噪:恢复方式红条可关闭(7 天冷却)但 #me 域恒显;PWA 安装浮条在场时内容区让位
const CSS = readFileSync('src/pwa/public/style.css', 'utf8')
ok('4a. recovery banner dismissible with 7d cooldown, always shown under #me',
  /!location\.hash\.startsWith\('#me'\) && Date\.now\(\) < \+\(localStorage\.getItem\('webaz_recovery_dismiss_until'\)/.test(APP)
  && /webaz_recovery_dismiss_until', String\(Date\.now\(\) \+ 7 \* 86400e3\)/.test(APP))
// 阈值而非存在性:浮条 bottom 70px + 自高 ~64px + 余量 = 至少 150px;.main 默认 80px,曾误设 96px(只多让 16px,仍遮控件)
const clearance = Number((CSS.match(/body:has\(#install-banner\) \.main \{ padding-bottom: (\d+)px \}/) || [])[1] || 0)
ok('4b. install banner clearance ≥ 150px (banner bottom + height + margin; mere presence is NOT enough)', clearance >= 150, `clearance=${clearance}`)
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
ok('4c. i18n parity for the dismiss title', I18N.includes("'暂时隐藏(7 天)':"))

// ⑤ 批次3:仲裁员 chip 指向真实申请流程(不再是灰死"联系管理员";资格=白名单,不切角色)+ 争议时间线昵称优先
ok('5a. arbitrator chip navigates to #apply-arbitrator (no dead contact-admin chip)',
  /r === 'verifier' \|\| r === 'arbitrator'/.test(ACC) && /'#apply-verifier' : '#apply-arbitrator'/.test(ACC))
ok('5b. dispute timeline actor prefers display name over auto handle',
  /actor\.name \? escHtml\(actor\.name\) : \(actor\.handle \? '@' \+ escHtml\(actor\.handle\)/.test(APP))

if (fail > 0) { console.error(`\n❌ role-ui-consistency FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ role UI consistency (audit batch 1): profile self-heal (no fake-logout) + single arbitration card + no self-apply invite\n  ✅ pass ${pass}`)
