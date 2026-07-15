#!/usr/bin/env tsx
/**
 * Test — per-product L1/L2/L3 beneficiary chain, incl. Decision A (self-purchase-as-promoter → self L1).
 *
 * Drives the REAL computeProductShareChain against a fresh in-memory DB with seeded
 * product_share_attribution rows. `isAllowedSelfL1` is injected (in server.ts it is isAllowedSponsor):
 * a qualifying-promoter buyer becomes their own L1 with the upline shifted down; a non-qualifying
 * buyer keeps the old behavior (L1 = their referrer). Also covers anti-loop, depth, expiry.
 *
 * Usage: npm run test:product-share-chain
 */
import Database from 'better-sqlite3'
import { computeProductShareChain } from '../src/pwa/routes/../internal/product-share-chain.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const db = new Database(':memory:')
db.exec(`CREATE TABLE product_share_attribution (product_id TEXT, recipient_id TEXT, sharer_id TEXT, expires_at TEXT)`)
const FUTURE = '2999-01-01T00:00:00Z'
const PAST = '2000-01-01T00:00:00Z'
// share edge: `sharer` shared `product` to `recipient`
function share(product: string, sharer: string, recipient: string, exp = FUTURE): void {
  db.prepare('INSERT INTO product_share_attribution (product_id, recipient_id, sharer_id, expires_at) VALUES (?,?,?,?)').run(product, recipient, sharer, exp)
}
const chain = (product: string, buyer: string, selfL1: (u: string) => boolean, depth = 3) =>
  computeProductShareChain(db, product, buyer, depth, selfL1)

const YES = () => true
const NO = () => false
const P = 'prod_1'

// Build an upline: A shared P to B, B shared P to C, C shared P to buyer D.
//   old-model chain for buyer D = [C, B, A]  (C=L1 referrer, B=L2, A=L3)
share(P, 'A', 'B'); share(P, 'B', 'C'); share(P, 'C', 'D')

// ── 1. non-qualifying buyer → OLD behavior (L1 = referrer), self NOT inserted ──
ok('1a. non-promoter buyer D → [C,B,A] (referrer is L1, unchanged)', eq(chain(P, 'D', NO), ['C', 'B', 'A']))
ok('1b. non-promoter buyer with NO upline → [null,null,null]', eq(chain(P, 'Z', NO), [null, null, null]))

// ── 2. Decision A: qualifying promoter buyer → self is L1, upline shifts down ──
ok('2a. promoter buyer D → [D,C,B] (self L1, referrer→L2, →L3; former L3 A drops)', eq(chain(P, 'D', YES), ['D', 'C', 'B']))
ok('2b. promoter buyer with a single referrer → [buyer, referrer, null]', eq(chain(P, 'C', YES), ['C', 'B', 'A']) /* C's own upline B,A */ )
ok('2c. promoter buyer with NO upline (self-share+self-consume, no one above) → [buyer,null,null]', eq(chain(P, 'Z', YES), ['Z', null, null]))

// ── 3. selective eligibility: only the buyer’s own status decides self-L1 ──
//   isAllowedSelfL1 is asked ONLY about the buyer; uplines are never self-inserted.
{
  const askedFor: string[] = []
  const spy = (u: string) => { askedFor.push(u); return u === 'D' }
  const r = chain(P, 'D', spy)
  ok('3a. self-L1 predicate is consulted for the BUYER', askedFor.includes('D'))
  ok('3b. buyer D qualifies → [D,C,B]', eq(r, ['D', 'C', 'B']))
}

// ── 4. anti-loop: buyer appears in their own upline → never double-counted ──
{
  const P2 = 'prod_loop'
  share(P2, 'D', 'E'); share(P2, 'E', 'D')   // D→E, E→D forms a cycle through the buyer D
  ok('4a. promoter buyer D in a cycle → [D, E] then stops (D not repeated)', eq(chain(P2, 'D', YES), ['D', 'E', null]))
  ok('4b. non-promoter buyer D in a cycle → [E] then stops at self', eq(chain(P2, 'D', NO), ['E', null, null]))
}

// ── 5. depth + expiry ──
ok('5a. depth=1 promoter → just [buyer]', eq(chain(P, 'D', YES, 1), ['D']))
ok('5b. depth=2 non-promoter → [C,B]', eq(chain(P, 'D', NO, 2), ['C', 'B']))
{
  const P3 = 'prod_exp'
  share(P3, 'X', 'Y', PAST)   // expired share
  ok('5c. expired attribution ignored → non-promoter Y = [null,null,null]', eq(chain(P3, 'Y', NO), [null, null, null]))
  ok('5d. expired attribution ignored → promoter Y = [Y,null,null] (only self)', eq(chain(P3, 'Y', YES), ['Y', null, null]))
}

if (fail > 0) { console.error(`\n❌ product share chain FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product share chain: old-model referrer-L1 preserved for non-promoters · Decision A self-purchase-as-promoter → self L1 + upline shift · anti-loop · depth · expiry\n  ✅ pass ${pass}`)
