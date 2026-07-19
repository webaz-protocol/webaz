#!/usr/bin/env tsx
/**
 * P0-C — economic/currency consistency across the buyer chain (discover → search → quote → draft → approval).
 *
 * The GPT test showed currency drift: discover "19.9 WAZ", card "19.9 USDC", quote "19.90 USDC",
 * approval currency "WAZ". Decision: unify the agent-facing DISPLAY on the USDC alias (1 WAZ = 1 USDC =
 * 1e6 base-units, pure relabel; ledger + settlement stay simulated WAZ). This test locks the two leaks
 * (discover projection, approval submit_summary) + the canonical status unification (pending_approval→pending).
 * Usage: npm run test:economic-currency-consistency
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'econ-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initOrderDraftsSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { submitRowSummary } = await import('../src/pwa/order-submit-request.js')
const { projectSubmitConsumer } = await import('../src/agent-model-projection.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderDraftsSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN handle TEXT') } catch { /* full boot adds it; here manual */ }   // submitRowSummary SELECTs users.handle
db.prepare("INSERT INTO users (id,name,role,api_key,handle) VALUES ('seller1','S','seller','k_s','store')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock) VALUES ('prd1','seller1','抽纸','d',19.9,'WAZ',100)").run()
// draft holds the LEDGER currency 'WAZ' in the DB (correct); the projection must relabel the DISPLAY to USDC.
const cols = 'id,buyer_id,quote_id,product_id,seller_id,quantity,unit_price_units,item_units,shipping_units,donation_bps,donation_units,total_units,payable_units,currency,payment_rail,anonymous_recipient,dest_region,status,expires_at'
db.prepare(`INSERT INTO order_drafts (${cols}) VALUES ('odr_1','alice','q1','prd1','seller1',1,19900000,19900000,0,50,99500,19900000,19999500,'WAZ','escrow',0,'SG','draft',?)`).run(new Date(Date.now() + 86400000).toISOString())

try {
  // ── submit_summary relabels currency to USDC (leak #2) while preserving integer amounts ──
  const s = submitRowSummary(db, 'odr_1') as Record<string, unknown>
  ok('submit_summary.currency relabeled WAZ→USDC (display alias)', s.currency === 'USDC')
  ok('submit_summary keeps integer ledger amounts unchanged (1:1, no re-pricing)', s.payable_units === 19999500 && s.item_units === 19900000 && s.donation_units === 99500)
  ok('submit_summary preserves payment_rail (rail identity untouched)', s.payment_rail === 'escrow')

  // ── canonical status unified: submit consumer emits 'pending' (matches webaz_approval_requests read set) ──
  const sc = projectSubmitConsumer({ request_id: 'apr_1', draft_id: 'odr_1', approval_url: '/#agent-approvals/apr_1' }) as Record<string, unknown>
  ok('projectSubmitConsumer status = canonical "pending" (not the old "pending_approval")', sc.status === 'pending')
  ok('projectSubmitConsumer keeps passkey_required:true (approval semantics preserved)', sc.passkey_required === true)
  ok('projectSubmitConsumer schema_version present', typeof sc.schema_version === 'string' && (sc.schema_version as string).length > 0)

  // ── discover leak #1: the discover projection must emit the USDC alias, not the raw products.currency (WAZ) ──
  const GRANTS = readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')
  ok('discover projection emits USDC alias (not raw String(r.currency||WAZ))', /currency: 'USDC', category: r\.category/.test(GRANTS) && !/currency: String\(r\.currency \|\| 'WAZ'\)/.test(GRANTS))

  // ── human approval card: donation line no longer hard-codes ' WAZ ' (drift with the USDC 实付 line) ──
  const SUBMIT_CARD = readFileSync('src/pwa/public/app-agent-approvals-submit.js', 'utf8')
  ok('human approval card donation line uses s.currency (no hard-coded WAZ)', !/waz\(s\.donation_units\) \+ ' WAZ '/.test(SUBMIT_CARD))

  // ── schema const kept in sync with the runtime status ──
  const SCHEMAS = readFileSync('src/layer1-agent/L1-1-mcp-server/tool-output-schemas.ts', 'utf8')
  ok('order_approval schema status const = pending (matches projection)', /const: 'pending' }/.test(SCHEMAS) && !/const: 'pending_approval'/.test(SCHEMAS))

  // ── HONESTY (Codex R1): USDC is a display alias — a "not real USDC/fiat custody" note must be REACHABLE on
  //    every relabeled surface (discover / approval agent-read / approval human card / the budget-param contract). ──
  ok('discover response carries a pricing_note (USDC = display alias, not real settlement)', /pricing_note:[\s\S]{0,120}display alias[\s\S]{0,80}NOT real USDC/.test(GRANTS))
  const SERVER = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('webaz_discover max_price contract says USDC (not the old WAZ), flagged as simulated alias', /Budget ceiling in USDC[\s\S]{0,80}not real USDC settlement/.test(SERVER) && !/Budget ceiling in WAZ/.test(SERVER))
  const APRREAD = readFileSync('src/pwa/approval-requests-read.ts', 'utf8')
  ok('approval agent-read economic_effect is rail-aware + honest (escrow=SIMULATED, USDC display alias)', /SIMULATED test ledger[\s\S]{0,80}display alias/.test(APRREAD) && /direct_p2p[\s\S]{0,120}holds no principal/.test(APRREAD))
  ok('human approval card escrow line carries the simulated/not-real-USDC disclosure', /模拟测试轨,金额以 USDC 显示为别名,不代表真实 USDC 或法币托管\/结算/.test(SUBMIT_CARD))
} finally { try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch {} }

if (fail > 0) { console.error(`\n❌ economic-currency-consistency FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ economic currency consistency: submit_summary WAZ→USDC display relabel (amounts/rail untouched) + discover USDC alias (leak fixed) + human card donation uses s.currency + canonical status pending (projection+schema in sync)\n  ✅ pass ${pass}`)
