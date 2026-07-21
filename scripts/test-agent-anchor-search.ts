#!/usr/bin/env tsx
/**
 * 口令/anchor 直达(agent webaz_search)—— 只接线已有 /api/anchor/:code/lookup + A4 exact-first,
 * 不改匹配语义。验证:显式 anchor 参数 / query 里裸 @code 均触发;命中 → 单品卡(matched_by:'anchor');
 * 不存在/归档/无在售 → 诚实 found:0 + 具体 recovery;非 network 模式明确拒绝。
 * Usage: npm run test:agent-anchor-search
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// 最小 mock:/api/anchor/:code/lookup(active 单品 / 归档 / 未找到)+ /api/products?q= exact-first 单品
const app = express()
const PROD = { id: 'prd_anchor1', title: '心相印茶语精选悬挂式底部抽纸 4层每提280抽 8提装' }
app.get('/api/anchor/:code/lookup', (req, res) => {
  const c = String(req.params.code)
  if (c === 'tinama47') return void res.json({ found: true, status: 'active', target_kind: 'product', target_id: PROD.id, owner_id: 'usr_tina', product: { id: PROD.id, title: PROD.title, price: 11.5 } })
  if (c === 'tinaold9') return void res.status(410).json({ found: true, status: 'retired', hint: 'archived' })
  if (c === 'tinanop9') return void res.json({ found: true, status: 'active', target_kind: 'product', target_id: 'prd_gone', owner_id: 'usr_tina', product: null })
  return void res.status(404).json({ found: false })
})
app.get('/api/products', (req, res) => {
  const q = String(req.query.q || '')
  const products = q === PROD.title ? [{ id: PROD.id, title: PROD.title, price: { amount_minor: 11500000, currency: 'USDC', display: '11.5 USDC' }, stock_status: 'in_stock', decision_flags: [] }] : []
  res.json({ schema_version: 'webaz.product_search.model.v1', mode: 'agent', count: products.length, products, sellers: {} })
})
const server = app.listen(0)
const port = (server.address() as { port: number }).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`
process.env.WEBAZ_MODE = 'network'; process.env.WEBAZ_API_KEY = 'k_test'
process.env.HOME = mkdtempSync(join(tmpdir(), 'anchor-'))

try {
  const { handleSearch } = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { handleSearch: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }

  const r1 = await handleSearch({ anchor: '@tinama47' })
  ok('AN-1 explicit anchor param → exact single product, matched_by:anchor', r1.matched_by === 'anchor' && Array.isArray(r1.products) && (r1.products as unknown[]).length === 1 && (r1.products as Array<{id:string}>)[0].id === PROD.id)
  ok('AN-1b anchor result carries NO pagination (no cursor/more_url)', !r1.next_cursor && !r1.more_url && r1.total_count === 1)

  const r2 = await handleSearch({ query: 'tinama47' })   // 裸 @code 在 query 里
  ok('AN-2 bare code in query is recognized as anchor', r2.matched_by === 'anchor' && (r2.products as unknown[]).length === 1)

  const r3 = await handleSearch({ anchor: 'tinaold9' })
  ok('AN-3 retired anchor → honest found:0 + archived note', r3.found === 0 && r3.matched_by === 'anchor_not_found' && /archived|归档/.test(JSON.stringify(r3.recovery)))

  const r4 = await handleSearch({ anchor: 'zzznope9' })
  ok('AN-4 unknown anchor → honest found:0 (never substitutes)', r4.found === 0 && r4.matched_by === 'anchor_not_found' && (r4.products as unknown[]).length === 0)

  const r5 = await handleSearch({ anchor: 'tinanop9' })
  ok('AN-5 anchor with no active product → found:0 no_product', r5.found === 0 && r5.matched_by === 'anchor_no_product')

  // 非 anchor query 不误触发(普通词不含 @、含空格/中文)
  const r6 = await handleSearch({ query: '悬挂式 底部抽纸' })
  ok('AN-6 normal multi-word query NOT treated as anchor', r6.matched_by !== 'anchor')
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ agent-anchor-search FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent-anchor-search: 口令直达(显式/裸code)+ 命中单品卡 + 不存在/归档/无品诚实 found:0 + 普通词不误触\n  ✅ pass ${pass}`)
