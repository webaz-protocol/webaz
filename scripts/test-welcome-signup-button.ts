#!/usr/bin/env tsx
/**
 * welcome "立即注册 / Sign Up Now" button — must open the real account-registration sheet,
 * NOT scroll to the Genesis-Cohort email-subscribe section. (static source contract)
 *   用法:npm run test:welcome-signup-button
 *
 * 背景:该按钮原 onclick=scrollToJoinWithRole('') 会滚到 #w-join-section 并聚焦邮箱订阅框
 * (即"申请加入创世团/深度参与"),而不是账号注册。修复为 openAuthSheet('reg')。
 */
import { readFileSync } from 'node:fs'
const app = readFileSync('src/pwa/public/app.js', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// 找到 "立即注册 / Sign Up Now" 按钮那一行
const line = app.split('\n').find(l => l.includes("T('立即注册', 'Sign Up Now')") && l.includes('<button'))
ok('welcome "立即注册 / Sign Up Now" button exists', !!line, 'button line not found')
ok('button opens the registration sheet (openAuthSheet(\'reg\'))', !!line && /onclick="openAuthSheet\('reg'\)"/.test(line), line || '')
ok('button does NOT scroll to the Genesis-Cohort apply section', !!line && !/scrollToJoinWithRole/.test(line), line || '')
// openAuthSheet('reg') is the established registration entry (also used for invite links)
ok('openAuthSheet is a real global entry that switches to the reg tab', /window\.openAuthSheet = /.test(app) && /openAuthSheet\('reg'\)/.test(app))

if (fail === 0) {
  console.log(`\n✅ welcome signup button: "立即注册 / Sign Up Now" opens the real registration sheet (openAuthSheet('reg')), not the Genesis-Cohort email-subscribe section\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ welcome signup button FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
