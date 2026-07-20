#!/usr/bin/env tsx
/**
 * Agent/公开商品投影隐私收口 — formatProductForAgent 不出站【溯源原始列】(source_url / source_price_at)。
 *
 * 真 boot PWA server(temp HOME,固定端口)→ 直接向其 SQLite 插一个带 source_url/source_price/source_price_at
 * 的 active 商品 → GET /api/products/:id(公开,无鉴权 = 买家/agent/REST 拿到的)→ 断言:
 *   - source_url、source_price_at【不出现】(内部证据/溯源原始列;买家同款走 verified external_links,不读此列);
 *   - source_price【保留】(discover"省 X%"买家比价 = 概念①外部对标市场价,该公开);
 *   - title/price 正常返回(投影未误伤)。
 *
 * 用法:npm run test:agent-projection-source-privacy
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-projpriv-'))
const PORT = 3987
const base = `http://127.0.0.1:${PORT}`
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const srv = spawn('npx', ['tsx', 'src/pwa/server.ts'], {
  env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, WEBAZ_OAUTH: '1', PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'ignore'],
})

const waitHealth = async (): Promise<boolean> => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

try {
  if (!await waitHealth()) throw new Error('server 未在 60s 内就绪')
  await new Promise(r => setTimeout(r, 1000))   // schema/seam settle
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(tmpHome, '.webaz', 'webaz.db'))
  const uid = 'usr_projpriv_seller'
  db.prepare('INSERT OR IGNORE INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(uid, 'Seller', 'seller', 'key_' + uid)
  const pid = 'prd_projpriv_1'
  db.prepare(`INSERT OR REPLACE INTO products (id, seller_id, title, description, price, currency, status, stock, source_url, source_price, source_price_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    pid, uid, 'SPIKE Projection Test', 'desc', 5.49, 'USDC', 'active', 5,
    'https://secret-supplier.example/listing/12345', 6.90, '2026-07-20T00:00:00Z')
  db.close()

  const r = await fetch(`${base}/api/products/${pid}`)
  const j = await r.json() as Record<string, unknown>

  ok('0 商品可取(投影未整体崩)', r.status === 200 && j.id === pid && j.title === 'SPIKE Projection Test')
  ok('1 source_url 不出站(内部证据/溯源原始列)', !('source_url' in j))
  ok('2 source_price_at 不出站(内部采价时间)', !('source_price_at' in j))
  ok('3 source_price 保留(买家比价 概念①)', j.source_price === 6.90)
  ok('4 响应通篇不含货源 secret host', !JSON.stringify(j).includes('secret-supplier.example'))

  if (fail > 0) { console.error(`\n❌ agent-projection-source-privacy FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ agent-projection-source-privacy: 公开投影不出站 source_url/source_price_at(溯源原始列),保留 source_price(买家比价)\n  ✅ pass ${pass}`)
} catch (e) {
  console.error('❌ test error:', (e as Error).message); process.exitCode = 1
} finally {
  srv.kill('SIGKILL')
  rmSync(tmpHome, { recursive: true, force: true })
}
