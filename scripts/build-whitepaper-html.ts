#!/usr/bin/env tsx
/**
 * Build public, anonymously-reachable HTML for the founding whitepaper from the canonical markdown.
 *   用法:npm run build:whitepaper  (build 会先跑它,产物随 src/pwa/public 一起 cp 到 dist)
 *
 * Single source of truth = docs/WHITEPAPER.md (en) + docs/WHITEPAPER.zh-CN.md (zh-CN). This script renders
 * each into src/pwa/public/whitepaper/{en,zh-CN}/index.html, which express.static serves publicly at
 * /whitepaper/en and /whitepaper/zh-CN (no auth, no GitHub login). The generated files are committed for
 * local-dev parity + reviewability; a CI freshness guard re-runs this and fails on drift, so the HTML can
 * never diverge from the docs. DO NOT hand-edit the generated HTML — edit the markdown and re-run.
 *
 * The whitepaper markdown uses only `#`/`##` headings + blank-line-separated paragraphs (no lists/links/
 * tables/code), so the renderer is a small, safe subset converter — deterministic (no timestamps) so the
 * committed output is stable.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Lang { code: 'en' | 'zh-CN'; src: string; backLabel: string; sourceLabel: string }
const LANGS: Lang[] = [
  { code: 'en',    src: 'docs/WHITEPAPER.md',       backLabel: '← Home',     sourceLabel: 'Generated from docs/WHITEPAPER.md — edit the source, not this file.' },
  { code: 'zh-CN', src: 'docs/WHITEPAPER.zh-CN.md', backLabel: '← 返回首页', sourceLabel: '由 docs/WHITEPAPER.zh-CN.md 生成 —— 改源文件,不要改本文件。' },
]

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Render the headings+paragraphs markdown subset to HTML. Returns { title, bodyHtml }. */
function render(md: string): { title: string; body: string } {
  const blocks = md.replace(/\r\n/g, '\n').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  let title = 'WebAZ Whitepaper'
  const html: string[] = []
  for (const block of blocks) {
    const h2 = block.match(/^##\s+(.*)$/s)
    const h1 = block.match(/^#\s+(.*)$/s)
    if (h1 && !block.startsWith('##')) {
      title = h1[1].trim()
      html.push(`<h1>${esc(title)}</h1>`)
    } else if (h2) {
      html.push(`<h2>${esc(h2[1].trim())}</h2>`)
    } else {
      // paragraph — join any wrapped lines within the block with a space
      const text = block.split('\n').map(l => l.trim()).join(' ')
      html.push(`<p>${esc(text)}</p>`)
    }
  }
  return { title, body: html.join('\n      ') }
}

const STYLE = `
    :root { color-scheme: light }
    * { box-sizing: border-box }
    body { margin: 0; background: #fff; color: #18181B;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Noto Sans SC', Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased; line-height: 1.7 }
    .wp { max-width: 720px; margin: 0 auto; padding: 24px 20px 80px }
    .wp-nav { display: flex; justify-content: space-between; align-items: center; gap: 12px;
      font-size: 14px; padding: 8px 0 24px; border-bottom: 1px solid #E4E4E7; margin-bottom: 32px }
    .wp-nav a { color: #3F3F46; text-decoration: none }
    .wp-nav a:hover { color: #18181B; text-decoration: underline }
    .wp-lang .cur { color: #A1A1AA }
    h1 { font-size: clamp(28px, 6vw, 40px); font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; margin: 8px 0 28px }
    h2 { font-size: clamp(19px, 3.6vw, 24px); font-weight: 600; line-height: 1.3; margin: 44px 0 12px; color: #27272A }
    p { font-size: 16px; color: #3F3F46; margin: 0 0 16px }
    .wp-foot { margin-top: 56px; padding-top: 20px; border-top: 1px solid #E4E4E7;
      font-size: 12px; color: #A1A1AA; line-height: 1.6 }
    @media (max-width: 640px) { .wp { padding: 20px 18px 64px } }`

function page(l: Lang, title: string, body: string): string {
  // language switch always shows both; the current one is inert
  const enLink = l.code === 'en' ? `<span class="cur">EN</span>` : `<a href="/whitepaper/en">EN</a>`
  const zhLink = l.code === 'zh-CN' ? `<span class="cur">中文</span>` : `<a href="/whitepaper/zh-CN">中文</a>`
  return `<!-- GENERATED from ${l.src} by scripts/build-whitepaper-html.ts — DO NOT EDIT BY HAND. Run: npm run build:whitepaper -->
<!DOCTYPE html>
<html lang="${l.code}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${STYLE}
  </style>
</head>
<body>
  <main class="wp">
    <nav class="wp-nav">
      <a href="/#welcome">${l.backLabel}</a>
      <span class="wp-lang">${enLink} / ${zhLink}</span>
    </nav>
      ${body}
    <footer class="wp-foot">${esc(l.sourceLabel)}</footer>
  </main>
</body>
</html>
`
}

let wrote = 0
for (const l of LANGS) {
  const md = readFileSync(join(ROOT, l.src), 'utf8')
  const { title, body } = render(md)
  const outDir = join(ROOT, 'src/pwa/public/whitepaper', l.code)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), page(l, title, body))
  console.log(`  ✅ ${l.src} → src/pwa/public/whitepaper/${l.code}/index.html`)
  wrote++
}
console.log(`whitepaper html generated: ${wrote} file(s)`)
