# Cross-Border Tax & Import Responsibility — Internal Compliance Posture

**Status:** internal working note, NOT legal advice. Any go-live decision on VAT/sales-tax registration, deemed-supplier posture, or enabling cross-border sale into a specific jurisdiction MUST be confirmed with a qualified tax adviser against the then-current legal texts. Research basis: primary-source review (EU EUR-Lex / taxation-customs.ec.europa.eu, UK gov.uk, US White House EOs / CBP / state statutes) conducted 2026-07.

## The load-bearing finding

**"WebAZ is non-custodial (does not handle payment), therefore it has no platform tax obligation" is FALSE.** Both major regimes use an *any-activity* test in which payment handling is only one of several disjunctive triggers:

- **EU — Article 14a "deemed supplier" + Article 5b escape.** The escape from platform VAT liability is a **three-limb conjunctive test**: a platform avoids "facilitating" only if it *simultaneously* (a) does not set the terms/conditions of supply, (b) is not involved in authorising the charge to the customer, **and** (c) is not involved in ordering or delivery. WebAZ sets terms (trade_terms, state machine, dispute rules) and is involved in ordering/delivery (order creation, state machine, delivery tracking) → it fails limbs (a) and (c) regardless of never touching money. For imports ≤ €150 sold by **non-EU-established sellers** into the EU, WebAZ would likely be a **deemed supplier** liable to collect/remit VAT.
- **UK — OMP liability.** Parallel three-limb definition (sets T&Cs / involved in authorising payment / involved in ordering or delivery). Thresholds: imports ≤ £135 via an OMP, or goods already in the UK sold by an overseas seller (any value). UK is **consulting in 2026 on extending OMP liability**.
- **US — marketplace facilitator laws (post-Wayfair, 45 states + DC).** Two structural models: **"any-activity"** states (incl. **California, Washington, Massachusetts**) where *listing / transmitting the offer-acceptance / order-taking each independently trigger* facilitator status — CA Reg. 1684.5 says payment processing is *not required*; and **"payment-required"** states (**FL, IL, NC, DC, NY, PA**) where collecting payment is a mandatory element. WebAZ transmits offer/acceptance + takes orders + lists → it IS a marketplace facilitator in the any-activity states, money-handling notwithstanding.
- **Record-keeping survives even when NOT a deemed supplier.** EU Art. 242a + Art. 54c: any facilitating interface must keep records (seller identity, goods, value, place/time, order numbers) for **10 years**, producible electronically to any member state. UK analogue: **6 years**.

## What this means for WebAZ's design

1. **Posture = seller-of-record / seller-declared by default, NOT "exempt".** WebAZ declares and discloses; the seller asserts tax responsibility; WebAZ does not compute, collect, or remit tax.
2. **Record-keeping is already satisfied** by `orders.trade_terms_snapshot` (S0), which freezes seller identity, goods description, value, place/time, and order id at purchase. This is upside regardless of deemed-supplier status.
3. **Cross-border into high-enforcement jurisdictions is counsel-gated.** The enforcement lever already exists: the S1 governance param **`trade.platform_region_blocklist`** (destination `PRODUCT_RESTRICTED` gate). Before enabling cross-border sale AT SCALE into the EU (deemed-supplier for ≤€150 non-EU-seller imports), the UK (OMP ≤£135), or any-activity US states, obtain counsel and make an explicit deemed-supplier decision; use the blocklist to hold regions until cleared. **Not seeded now** — pre-launch exposure is ~zero (SG-centered, invite-only, near-zero GMV) and a blanket block would over-restrict legitimate same-jurisdiction sales.
4. **De minimis is gone as a cushion.** US $800 commercial de minimis was eliminated for all countries (EO 14324, effective 2025-08-29; permanent repeal scheduled 2027-07-01). EU's €150 customs-duty exemption replaced by a temporary €3/item flat fee from 2026-07-01, and the €150 VAT/IOSS threshold is scheduled to be scrapped ~2028 (import VAT shifting onto sellers/marketplaces for all values). The runway for a "we don't collect" posture is shrinking — design records and seller-data capture now (done: S0 customs fields + this snapshot).

## What S3 ships (and deliberately does not)

**Ships (declaration + disclosure only; zero money-path, zero tax computation):**
- `import_duty_terms` (DDP/DDU) per product ?? store — seller declares who bears border duty/tax.
- `tax_lines` **kind='included' only** — seller declares "price already includes X tax" (e.g. SG GST 9%). Display/evidence only.
- Buyer **pre-purchase disclosure** of both (the honest-DDU / honest-DDP copy), on the buy sheet.
- Snapshot fill (S0 already reads these columns into `declarations.{import_duty_terms,tax_lines}`).

**Deliberately deferred (no fake switches):**
- `tax_lines` **kind='added'** (tax added into the order total) — money path; separate PR gated on a real use case. Rejected with an explicit error today.
- Automatic tax-rate engines / tax-service integration — premature.
- Platform **collection/remittance**, IOSS/OSS/deemed-supplier registration — Rail 3 (custody) + legal sign-off.

## Open items for counsel (when cross-border GMV becomes real)
- EU deemed-supplier registration decision (IOSS intermediary) before enabling non-EU-seller → EU-consumer flows ≤ €150.
- UK OMP posture (and the 2026 extension consultation outcome).
- US any-activity state facilitator registrations vs. geo-limiting sales to payment-required states.
- 2028 EU IOSS-threshold removal and its "marketplace becomes importer" shift.
