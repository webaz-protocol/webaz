#!/usr/bin/env tsx
/**
 * recovery onboarding UI — 源码契约测试(静态,读 app.js / i18n.js 文本断言结构)。
 *   用法:npm run test:recovery-onboarding-ui
 *
 * 覆盖 P0/P1:注册表单邮箱验证步骤 + doRegister 强制 email+code + 成功弹窗"凭证保存检查清单"
 * (复制/下载备份 + 弱化"稍后"二次确认) + 下载 .txt + 首页无恢复方式横幅 + 卖家后台安全提醒 +
 * 登录页找回文案明确"找回并重置密码" + 诚实文案(邮箱可找回/重置,API Key 仍为主) + i18n parity。
 * 纯静态:不跑 DOM。行为路径由 test-register-email-verify.ts(后端)覆盖。
 */
import { readFileSync } from 'node:fs'
const app = readFileSync('src/pwa/public/app.js', 'utf8')
const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── 注册表单:邮箱验证优先 ────────────────────────────────────
ok('register form has recovery-email input', /id="inp-reg-email"/.test(app))
ok('register form has send-code button → doRegSendCode', /id="btn-reg-sendcode"[\s\S]{0,80}onclick="doRegSendCode\(\)"/.test(app))
ok('register form has 6-digit code input (hidden until sent)', /id="reg-code-row"[\s\S]{0,120}id="inp-reg-code"/.test(app))
ok('doRegSendCode POSTs to /register/send-code', /doRegSendCode = async[\s\S]{0,400}POST\('\/register\/send-code'/.test(app))

// ── doRegister 强制 email+code,先验证后注册 ──────────────────
const dr = app.slice(app.indexOf('window.doRegister = async'), app.indexOf('window.doRegister = async') + 1200)
ok('doRegister reads email + code', /inp-reg-email[\s\S]{0,120}inp-reg-code/.test(dr))
ok('doRegister requires email before submit', /请填写找回邮箱/.test(dr))
ok('doRegister requires code-sent gate', /_regCodeSent[\s\S]{0,80}请先点/.test(dr))
ok('doRegister body carries email + code', /const body = \{ name, role, region, email, code \}/.test(dr))

// ── 成功弹窗:凭证保存检查清单 ───────────────────────────────
const modal = app.slice(app.indexOf('function showRegisterSuccessModal'), app.indexOf('function showRegisterSuccessModal') + 6000)
ok('success modal: copy key button marks saved', /_regMarkSaved\(\);copyText/.test(modal))
ok('success modal: download backup button', /_downloadCredBackup\(\)/.test(modal))
ok('success modal: checklist heading', /保存凭证检查清单/.test(modal))
ok('success modal: set-password action', /_closeRegModal\('password'\)/.test(modal))
ok('success modal: weakened skip needs 2nd confirm when not saved', /action === false && !window\._regSaved[\s\S]{0,120}confirm\(/.test(modal))
ok('download builds a .txt Blob with key + recovery email', /new Blob\(\[lines\.join[\s\S]{0,200}webaz-backup-/.test(modal) && /API Key \(登录凭证/.test(modal))
ok('download includes recovery email + recover URL', /找回邮箱[\s\S]{0,400}#recover/.test(modal))

// ── 诚实文案(P2):邮箱可找回/重置,API Key 仍为主,Passkey 不替代 ──
ok('honest copy: email recovers/resets, API Key still primary, Passkey not a replacement',
  /邮箱已验证：可用于找回账号或重置登录密码。API Key 仍是主要身份凭证/.test(app))

// ── 首页无恢复方式横幅 ───────────────────────────────────────
// Passkey 不算恢复方式(它是真人在场门,无登录/找回路径)→ hasRecovery 只看密码+邮箱
ok('recoveryBannerHTML recovery = password OR verified email (Passkey excluded)',
  /function recoveryBannerHTML[\s\S]{0,400}const hasRecovery = u\.has_password \|\| u\.email_verified\b[\s\S]{0,40}if \(hasRecovery\) return ''/.test(app))
ok('recoveryBannerHTML does NOT count has_passkey as recovery',
  !/const hasRecovery = u\.has_password \|\| u\.email_verified \|\| u\.has_passkey/.test(app))
ok('recovery banner injected at top of shell main', /<main class="main">\$\{recoveryBannerHTML\(\)\}\$\{content\}<\/main>/.test(app))

// ── 卖家后台安全提醒(P1) ───────────────────────────────────
ok('sellerRecoveryReminderHTML lists password/email gaps',
  /function sellerRecoveryReminderHTML[\s\S]{0,400}未设置登录密码[\s\S]{0,80}未绑定找回邮箱/.test(app))
ok('seller reminder skip matches global red banner condition (password+email, no passkey)',
  /sellerRecoveryReminderHTML[\s\S]{0,400}const globalRedShowing = !u\.has_password && !u\.email_verified[\s\S]{0,60}if \(globalRedShowing\) return ''/.test(app))
ok('seller reminder injected into seller dashboard', /\$\{sellerRecoveryReminderHTML\(\)\}/.test(app))

// ── 登录页找回文案(P1#5) ───────────────────────────────────
ok('login recover link states reset-password', /忘记 API Key \/ 密码？邮箱找回并重置 →/.test(app))

// ── i18n parity(关键新串) ──────────────────────────────────
for (const k of [
  '忘记 API Key / 密码？邮箱找回并重置 →', '保存凭证检查清单', '下载备份 .txt',
  '已验证找回邮箱', '账户还没有恢复方式', '立即设置密码 / 绑定邮箱',
  '未设置登录密码', '未绑定找回邮箱', '输入 6 位邮箱验证码',
]) {
  ok(`i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
}

if (fail === 0) {
  console.log(`\n✅ recovery onboarding UI: 注册邮箱验证优先 + 凭证检查清单(复制/下载/设密码/绑邮箱/Passkey)+ 弱化稍后二次确认 + .txt 备份 + 首页无恢复横幅 + 卖家安全提醒 + 找回页重置密码文案 + 诚实文案 + i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ recovery onboarding UI FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
