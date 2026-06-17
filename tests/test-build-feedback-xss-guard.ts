// Codex #93 P2 — build-feedback 弹窗的 hash 注入/XSS 防回归(静态扫描 app.js)。
//   病根:location.hash → escHtml(page) 被拼进 inline onclick 的 JS 字符串字面量。
//   escHtml 只做 HTML escape;HTML attribute 会把 &#39; 解码回 ' → 攻击者用带引号的 #hash 即可 breakout。
//   修复:page 存进 modal 的 data-page(HTML attribute 上下文,escHtml 适用),提交时从 dataset.page 读,
//        绝不拼进内联 JS 字符串。本测试守住这条边界,防有人改回旧写法。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(__dir, '..', 'src', 'pwa', 'public', 'app.js'), 'utf-8')

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ── 旧的危险写法绝不能复活:submitBuildFeedback('${...page...}') 把值拼进内联 JS 字符串 ──
expect('无 submitBuildFeedback(\'...\') 内联调用(旧 XSS 写法)', !/submitBuildFeedback\('/.test(app), app.match(/submitBuildFeedback\([^)]*\)/g)?.slice(0, 3))
expect('无 escHtml(page) 拼进任何内联 onclick 的 JS 字符串', !/onclick="[^"]*\('\$\{escHtml\(page\)/.test(app))

// ── 正确写法在位:page 进 modal dataset + 提交从 dataset 读 ──
expect('modal 用 data-page="${escHtml(page)}" 承载页面上下文', /data-page="\$\{escHtml\(page\)\}"/.test(app))
expect('提交按钮调 submitBuildFeedbackFromModal(this)', /onclick="submitBuildFeedbackFromModal\(this\)"/.test(app))
expect('handler 从 closest(.js-modal).dataset.page 读 page', /closest\('\.js-modal'\)\?\.dataset\.page/.test(app))

// ── 展示位仍用 escHtml(page)(HTML 文本/属性上下文,合法)——Codex item 4 ──
expect('展示位保留 escHtml(page)', /<code[^>]*>\$\{escHtml\(page\)\}<\/code>/.test(app))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
