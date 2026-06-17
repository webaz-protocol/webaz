// RFC-011 §① 实体字典 product/dispute 扩展 —— 公开字段齐全 + 【无 PII/内部泄漏】守卫。
import { buildEntityDictionary } from '../src/pwa/entity-dictionary.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const d = buildEntityDictionary()
const e = d.entities as Record<string, any>

expect('含 order/product/dispute 三实体', ['order','product','dispute'].every(k => k in e))

// ── product ──
const pFields = new Set(e.product.public_fields.map((f: any) => f.field))
expect('product 含核心商务字段', ['id','seller_id','title','price','stock','category','commission_rate','stake_amount'].every(f => pFields.has(f)))
expect('product 含可验证字段(content_hash/signature)', pFields.has('content_hash') && pFields.has('content_signature'))
expect('product 不泄漏内部审核字段 claim_loss_count', !pFields.has('claim_loss_count'))
expect('product 每字段有 type+meaning', e.product.public_fields.every((f: any) => f.field && f.type && f.meaning))
expect('product full_record 指向公开端点', /\/api\/products\/:id/.test(e.product.full_record))

// ── dispute (= dispute_cases 脱敏公开版) ──
const dFields = new Set(e.dispute.public_fields.map((f: any) => f.field))
expect('dispute 含裁决公开字段', ['id','order_id','product_id','seller_id','winner','resolution','category_tag'].every(f => dFields.has(f)))
expect('dispute 金额是 amount_bucket(分桶非精确)', dFields.has('amount_bucket') && !dFields.has('amount'))
// PII 泄漏守卫:buyer_id / dispute_id 绝不在公开字段
expect('dispute 不泄漏 buyer_id(仅内部)', !dFields.has('buyer_id'))
expect('dispute 不泄漏 dispute_id(内部追溯)', !dFields.has('dispute_id'))
expect('dispute 明示 live case party+arbitrator-gated', /arbitrator-gated/i.test(e.dispute.live_case + JSON.stringify(e.dispute.pii_excluded)))
expect('dispute full_record 指向公开脱敏端点', /\/api\/disputes\/cases/.test(e.dispute.full_record))

// ── 全局:任何实体公开字段都不得出现高危 PII 关键字 ──
const PII_FORBIDDEN = ['shipping_address','recipient_code','phone','email','api_key','escrow_amount','buyer_id']
const allPublic = Object.values(e).flatMap((ent: any) => (ent.public_fields || []).map((f: any) => f.field))
expect('全实体公开字段无高危 PII', allPublic.every(f => !PII_FORBIDDEN.includes(f)), allPublic.filter((f: any) => PII_FORBIDDEN.includes(f)))

// ── goal index 引用 ──
expect('字典指向 goal index', /webaz-goals\.json/.test(d.goal_index))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
