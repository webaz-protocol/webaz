/**
 * Per-product 3-tier referral beneficiary chain (L1 / L2 / L3). PURE READ — no writes, no tx.
 *
 * Walk direction (unchanged): "who shared this product to the buyer" → that sharer is L1; who shared
 * it to L1 → L2; etc. Decoupled from the PV/sponsor tree (users.sponsor_path). A broken link at any
 * level → that slot is null (its commission flows to the protocol reserve at settlement).
 *
 * Decision A (task 2026-07-15, Holden): **self-purchase-as-promoter**. If the buyer is themselves a
 * qualifying promoter (`isAllowedSelfL1(buyerId)` — the same eligibility that lets anyone earn L1:
 * l1_share_override=1, or a verified buyer with ≥1 completed order), then for their OWN purchase the
 * buyer IS their own L1 (70%), and the existing upline chain shifts down one level (former L1 → L2,
 * former L2 → L3, former L3 drops off). This is the "自己既是分享者又是消费者" case. When the buyer
 * is NOT a qualifying promoter, behavior is exactly as before (L1 = the buyer's referrer).
 *
 * Note (redistribution): when the buyer qualifies, the L1 that previously went to the buyer's
 * referrer now goes to the buyer; the referrer moves to L2. Under a region max_levels clamp of 1
 * (current conservative global cap), only L1 pays out, so a qualifying buyer earns the L1 self-reward and the referrer's
 * (now L2) share goes to the reserve until the clamp is lifted.
 *
 * Anti-loop: the buyer is seeded into `seen`, so they can appear at most once (as the self-L1), never
 * again deeper in the walk. Eligibility (isAllowedSelfL1) is injected to keep this module pure and
 * free of a circular import back into server.ts.
 */
import type Database from 'better-sqlite3'

export function computeProductShareChain(
  db: Database.Database,
  productId: string,
  buyerId: string,
  depth: number,
  isAllowedSelfL1: (userId: string) => boolean,
): (string | null)[] {
  const chain: (string | null)[] = []
  const seen = new Set<string>([buyerId])   // 防环:买家只可能作为"自购 L1"出现一次

  // Decision A: qualifying promoter buying → self is L1; upline shifts down.
  if (isAllowedSelfL1(buyerId)) chain.push(buyerId)

  let recipient = buyerId
  while (chain.length < depth) {
    const row = db.prepare(`
      SELECT sharer_id FROM product_share_attribution
      WHERE product_id = ? AND recipient_id = ? AND expires_at > datetime('now')
    `).get(productId, recipient) as { sharer_id: string } | undefined
    if (!row || !row.sharer_id || seen.has(row.sharer_id)) break
    chain.push(row.sharer_id)
    seen.add(row.sharer_id)
    recipient = row.sharer_id
  }

  while (chain.length < depth) chain.push(null)   // pad broken/short chains to `depth`
  return chain
}
