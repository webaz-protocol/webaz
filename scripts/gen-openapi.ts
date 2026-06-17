// 自动生成 OpenAPI 3.0 / endpoint inventory（端点目录）
// 扫 server.ts + 所有 routes/*.ts 模块，提取 app.{get,post,patch,delete,put} 调用 → 输出 JSON / Markdown
//
// 用法：tsx scripts/gen-openapi.ts --openapi   > src/pwa/public/openapi.json
//      tsx scripts/gen-openapi.ts --markdown  > docs/api-endpoints.md
//      tsx scripts/gen-openapi.ts             （统计）
//
// 注意：输出必须确定性（CI drift guard 依赖此），故扫描文件 + path 键全部排序。

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.join(__dirname, '..')
const PWA_DIR = path.join(REPO_ROOT, 'src', 'pwa')
const ROUTES_DIR = path.join(PWA_DIR, 'routes')

// 扫描文件集合：server.ts + routes/*.ts（确定性排序，server.ts 先）
const SCAN_FILES: string[] = [
  path.join(PWA_DIR, 'server.ts'),
  ...fs.readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.ts'))
    .sort()
    .map(f => path.join(ROUTES_DIR, f)),
]

// 匹配 app.{method}('/path', ... —— 允许前导缩进（route 模块的 handler 在 register 函数体内缩进）
const ENDPOINT_RE = /^\s*app\.(get|post|patch|delete|put)\(\s*['"]([^'"]+)['"]/

interface Endpoint {
  method: string
  path: string
  file: string   // 相对仓库根，如 src/pwa/routes/promoter.ts
  line: number
  needs_auth: boolean
  is_admin: boolean
  comment: string  // 前 10 行内最近的注释（如果有）
}

const endpoints: Endpoint[] = []
const seen = new Set<string>()  // 去重 key = `${METHOD} ${path}`

for (const file of SCAN_FILES) {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/')
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENDPOINT_RE)
    if (!m) continue
    const method = m[1].toUpperCase()
    const apiPath = m[2]
    // 只收真实 API 面：/api/* 与 /.well-known/*；跳过 express 通配兜底（含 *）
    if (apiPath.includes('*')) continue
    if (!apiPath.startsWith('/api') && !apiPath.startsWith('/.well-known')) continue
    const dedupKey = `${method} ${apiPath}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    // 找前 10 行内最近的注释作为描述（允许缩进）
    let comment = ''
    for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
      const c = lines[j].match(/^\s*\/\/\s*(.+)$/) || lines[j].match(/^\s*\/?\*+\s*(.+?)\s*\*\/?$/)
      if (c) { comment = c[1].trim(); break }
      // 撞到非注释、非空代码行就停（避免抓到上一个 handler 的注释）
      const t = lines[j].trim()
      if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) break
    }
    // 后 8 行内探测 auth / admin 守卫
    let needsAuth = false
    let isAdmin = false
    for (let j = i; j < Math.min(lines.length, i + 8); j++) {
      if (/\bauth\(req\b/.test(lines[j]) || /\brequireAuth\(/.test(lines[j])) needsAuth = true
      if (/\brequire[A-Za-z]*Admin\(req\b/.test(lines[j]) || /hasAdminPermission|requireAdminPermission|isRootAdmin/.test(lines[j])) { isAdmin = true; needsAuth = true }
    }
    endpoints.push({ method, path: apiPath, file: rel, line: i + 1, needs_auth: needsAuth, is_admin: isAdmin, comment })
  }
}

// 确定性排序：按 path，再按 method
endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))

const wantMarkdown = process.argv.includes('--markdown')
const wantOpenAPI = process.argv.includes('--openapi')

if (wantMarkdown) {
  // 输出 Markdown 端点目录
  console.log('# WebAZ API Endpoint Inventory\n')
  console.log(`Auto-generated from \`src/pwa/server.ts\` + \`src/pwa/routes/*.ts\` (${endpoints.length} endpoints).\n`)
  console.log('Regenerate: `npm run gen:api-docs` · drift-guarded in CI (`npm run check:api-docs-fresh`).\n')
  console.log('| Method | Path | Auth | Admin | Description | Source |')
  console.log('|---|---|---|---|---|---|')
  for (const e of endpoints) {
    const auth = e.needs_auth ? '🔐' : ''
    const admin = e.is_admin ? '👑' : ''
    const desc = e.comment.slice(0, 80).replace(/\|/g, '\\|')
    console.log(`| ${e.method} | \`${e.path}\` | ${auth} | ${admin} | ${desc} | ${e.file}:${e.line} |`)
  }
} else if (wantOpenAPI) {
  // 输出 OpenAPI 3.0 stub（agent SDK 可 import）
  // 读手动维护的 schema 覆盖（top 核心 endpoint）
  type SchemaOverride = { endpoints: Record<string, Record<string, unknown>> }
  let schemaOverrides: SchemaOverride = { endpoints: {} }
  try {
    const overridesPath = path.join(__dirname, 'openapi-schemas.json')
    if (fs.existsSync(overridesPath)) {
      schemaOverrides = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'))
    }
  } catch (e) {
    console.error('Warning: failed to load openapi-schemas.json:', (e as Error).message)
  }

  // 确定性：按 path 字母序构建 paths 对象
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of endpoints) {
    if (!paths[e.path]) paths[e.path] = {}
    const tags: string[] = []
    if (e.is_admin) tags.push('admin')
    if (e.path.includes('/anchor')) tags.push('anchor')
    if (e.path.includes('/wallet')) tags.push('wallet')
    if (e.path.includes('/order')) tags.push('order')
    if (e.path.includes('/dispute')) tags.push('dispute')
    if (e.path.includes('/charity')) tags.push('charity')
    const method = e.method.toLowerCase()
    const baseSpec: Record<string, unknown> = {
      summary: e.comment || `${e.method} ${e.path}`,
      tags,
      security: e.needs_auth ? [{ bearerAuth: [] }] : [],
    }
    // 合并手动 schema 覆盖（覆盖优先）
    const overrideKey = `${e.method} ${e.path}`
    const override = schemaOverrides.endpoints[overrideKey]
    if (override) {
      Object.assign(baseSpec, override)
    }
    paths[e.path][method] = baseSpec
  }
  const enrichedCount = Object.keys(schemaOverrides.endpoints).length
  const openapi = {
    openapi: '3.0.0',
    info: {
      title: 'WebAZ Protocol API',
      version: '0.4.14',
      description: `Auto-generated endpoint inventory (${endpoints.length} endpoints, ${enrichedCount} with full schema). See docs/ for design context.`,
    },
    servers: [{ url: 'http://localhost:3000' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'api_key' },
        webauthnToken: { type: 'apiKey', in: 'header', name: 'X-WebAuthn-Token' },
      },
    },
    paths,
  }
  console.log(JSON.stringify(openapi, null, 2))
} else {
  // 默认：统计
  const byMethod: Record<string, number> = {}
  let authCount = 0, adminCount = 0
  for (const e of endpoints) {
    byMethod[e.method] = (byMethod[e.method] || 0) + 1
    if (e.needs_auth) authCount++
    if (e.is_admin) adminCount++
  }
  console.log(`Total endpoints: ${endpoints.length}  (scanned ${SCAN_FILES.length} files)`)
  console.log(`By method:`, byMethod)
  console.log(`Need auth: ${authCount}`)
  console.log(`Admin-only: ${adminCount}`)
  console.log(`\nUsage:`)
  console.log(`  tsx scripts/gen-openapi.ts --markdown  → docs/api-endpoints.md`)
  console.log(`  tsx scripts/gen-openapi.ts --openapi   → src/pwa/public/openapi.json`)
}
