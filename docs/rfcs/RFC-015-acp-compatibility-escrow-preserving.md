# RFC-015: ACP compatibility — let ACP agents discover + check out + pay, settlement into WebAZ escrow / ACP 兼容(借入口不丢 escrow)

**Status**: draft (**design; spec-feasible per 2026-06 ACP overview; payment leg gated on real-money phase + PSP**) — 2026-06-07
**Author**: @seasonkoh + agent
**Track**: normal-but-sensitive — new external checkout surface + a real-money/PSP integration. Touches payment, escrow, iron-rule, PII. Does NOT change merge authority; must preserve escrow + conservation + iron-rule.
**Related**: RFC-011 §④⑤ (商品 feed + checkout) · `routes/checkout-helpers.ts` (webaz 自有 checkout + AP2 Intent Mandate) · `routes/ap2-mandate.ts` (AP2 授权层,已接) · RFC-012 (x402/USDC real settlement) · RFC-014 (money precision — prerequisite for any real settlement) · L0-2 state machine + L3-1 dispute · agenticcommerce.dev (ACP spec, 2026-06 snapshot)

---

## Why / 动机(用户决策 2026-06-07)
"提高兼容性 + 降低门槛 —— ACP 的人来了也要能正常支付。前提是安全、兼容。"

An ACP-native agent (e.g. ChatGPT) that finds a WebAZ product should be able to **complete a purchase in the flow it already speaks**, instead of bouncing off a dialect. The user explicitly wants this even pre-emptively — *if* it can be done without losing WebAZ's core protections.

## Feasibility (verified, 2026-06 ACP overview) / 可行性
- ACP is **payment-processor agnostic** ("use ACP with any compatible PSP"; Stripe is merely the first). **Settlement is pluggable** — the merchant keeps control of fulfilment + which processor charges.
- ACP supports **both REST and MCP** implementations → WebAZ (already an MCP server) is close to the surface.
- **Delegated / shared payment token**: payment credentials are *not* exposed to the agent.

**Conclusion:** ACP compatibility **without losing escrow is architecturally feasible** — adopt the ACP *checkout shape*, route the *settlement* into WebAZ escrow. The exact settlement-routing must be re-verified against the detailed ACP payment spec at implementation (the overview confirms agnostic; the mechanics are the gate).

---

## Design — borrow the entry, keep the core / 借入口,守内核

```
ACP agent (ChatGPT/…) discovers a WebAZ product (ACP/UCP feed)
  → ACP checkout session: create / update / complete / cancel  (ACP-shaped endpoints, REST + MCP)
      · create/update: items, address, tax-preview (reuse checkout-helpers tax + verify_price price-lock + AP2 Intent Mandate)
      · complete: the payment credential (shared token / x402) is captured —
          → funds land in WebAZ ESCROW (not paid out to seller)               ← core preserved
          → an order enters the WebAZ state machine (paid → accepted → … )    ← iron-rule, deadlines, dispute all apply
  → fulfilment + dispute + release run on WebAZ's engine, unchanged
```

The ACP surface is a **front door**; the money still sits in WebAZ escrow and the WebAZ state machine/dispute/iron-rule govern it. The buyer gets a familiar low-friction checkout AND WebAZ's escrow protection.

### Two settlement backends behind the same ACP front (align with RFC-012/x402)
- **Card / fiat**: a real PSP (Stripe-compatible, via the ACP shared token) charges the card → proceeds into escrow. Needs a PSP merchant account. (lowest barrier for mainstream ACP users)
- **Crypto / x402**: the x402/USDC path (RFC-012) funds escrow directly. (no PSP)

Both are "fund the escrow", then identical downstream.

## Safety invariants (locked) / 安全不变量
1. **WebAZ never stores card credentials** — shared-token / delegated-payment only (ACP's own model).
2. **Funds land in escrow, never direct-to-seller** — the ACP `complete` maps to "escrow funded", not "seller paid". Release follows the state machine.
3. **Iron-rule preserved** — value-moving confirmations still require the WebAZ human gate where applicable; ACP's delegated-payment authorization is the buyer-authorization input, not a bypass.
4. **Conservation + RFC-014** — real settlement requires the exact-units money representation (RFC-014) first; float ledger must be fixed before real money flows in via ACP.
5. **PII** — ACP buyer/address data enters only the party-gated order record (元规则 #3), not public surfaces.

## Phases / 分期

- **P0 — feed + discovery (safe, low-cost, can do pre-launch):** expose WebAZ products in ACP/UCP feed format so ACP agents can *find* them (RFC-011 §⑤ adjacent). No payment, no money, no PSP. Pure "be discoverable".
- **P1 — ACP checkout session shape (no real charge):** create/update/complete/cancel endpoints (REST + MCP) that build a cart + map `complete` to **escrow funding via the existing WAZ/x402 path** (no fiat PSP). Lets ACP agents transact on the crypto/WAZ rail end-to-end.
- **P2 — fiat PSP leg (real-money, gated):** onboard a Stripe-compatible PSP, accept ACP shared token → charge → proceeds into escrow. **Gated on: RFC-014 done · a real PSP account · W8/real-money phase · re-verify ACP payment spec.** This is the "card user pays normally" piece; it is a real-money surface that cannot be safely built/tested pre-launch with 0 users + no PSP.

## Non-goals / 非目标
- Not replacing WebAZ checkout/escrow with Stripe — ACP is a front door, settlement stays WebAZ-escrowed.
- Not paying sellers directly via ACP/PSP (would bypass escrow + dispute).
- Not storing card data.
- Not building the fiat leg before RFC-014 (money precision) + a real PSP account exist.

## Open questions / 待议
- Does the detailed ACP payment spec allow `complete` to defer settlement into a merchant-controlled escrow (vs immediate PSP capture)? (overview says PSP-agnostic + pluggable; verify mechanics at P2.)
- ACP via WebAZ's existing MCP server vs a separate REST surface — ACP supports both; pick at P1 (MCP reuse is cheaper given we're already an MCP server).
- Relationship to AP2 (already adopted, authorization layer): AP2 Intent/Cart/Payment mandates can ride alongside ACP checkout as the authorization proof — confirm the two compose rather than duplicate.

## TL;DR
ACP is PSP-agnostic + MCP-capable → **being ACP-compatible while keeping escrow is feasible**. Adopt the ACP checkout *shape*, route settlement into WebAZ escrow (card-via-PSP OR x402), preserve iron-rule/state-machine/dispute/conservation. **Discovery (P0) + crypto-rail checkout (P1) are safe to build when wanted; the fiat-card leg (P2) is a real-money integration gated on RFC-014 + a PSP account + the real-money phase.** Don't build the real-money leg pre-launch untested.
