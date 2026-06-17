# WebAZ Privacy Policy / 隐私政策

> **STATUS: DRAFT (v0) — pending legal counsel review (#1084).** Not yet the published policy.
> Tier-1 launch prep #937 A5. Expands TERMS-OF-SERVICE §7 into a standalone policy, grounded in
> the system's *actual* data practices (code + `protocol_params`). Any claim here must match
> behavior — update this file when data handling changes. Contact: **contact@webaz.xyz**.
>
> Effective date: _TBD on publication._ Jurisdiction-specific rights: see LEGAL-DISCLOSURES.md.

---

## 1. What we collect / 我们收集什么

**Account & identity** — handle, display name; **optional** email and/or phone (only if you add them, used for verification, notifications, and account recovery); region (coarse, for regulatory routing). You may use WebAZ with a minimal profile.

**Shipping / fulfillment** — addresses you save or attach to an order (recipient, address text/components, phone). Needed only to fulfill physical orders; visible to the counterparty of *that* order, not publicly.

**Authentication** — Passkey / WebAuthn credentials are stored as **public keys only**; biometric data never leaves your device and is never sent to or stored by WebAZ.

**Operational / security metadata** — anonymized **IP hash** and **user-agent hash** (not raw IP/UA), order and protocol audit trails, dispute records. Retained for fraud prevention, abuse limits, and dispute resolution.

**KYC** — collected **only** when a withdrawal meets the KYC threshold (anti-money-laundering); not required for normal use.

We do **not** collect more than the above to operate the protocol.

## 2. Why we process it / 处理目的

Provide and secure the service; fulfill orders; prevent fraud/abuse (rate limits, sybil resistance); resolve disputes (audit trail + arbitration); and meet legal obligations (AML/KYC where triggered). Where a jurisdiction requires a legal basis (e.g., GDPR), processing rests on contract performance, legitimate interest (security/anti-fraud), and legal obligation.

## 3. How it's protected / 如何保护

- **No PII in the public record.** The public dispute archive (`dispute_cases`) is **PII-redacted**; the live case is visible only to the parties + the assigned arbitrator.
- Operational identifiers are stored **hashed/anonymized** (IP, UA), not as raw values; PII is never placed in URLs/query strings.
- Fund-moving and identity/PII-changing actions are gated (Passkey human-presence + scoped agent permissions).

## 4. Sharing & third parties / 共享与第三方

- **We do not sell your data, and we do not share PII with third parties for marketing.**
- Service processors used to operate WebAZ:
  - **Cloudflare** — CDN / DNS / email routing (e.g., `contact@webaz.xyz`).
  - **Cloudflare Turnstile** — bot / abuse check at sensitive entry points.
  - **Railway** — application + database hosting.
  Each processes data only to provide its function.
- **Legal disclosure** — we may disclose data when required by valid legal process; we limit such disclosure to what is required.

## 5. Retention / 留存

Account data is kept while your account is active. Operational/security metadata is retained for the fraud-prevention/audit window documented in `protocol_params`. On account deletion (see §6), personal data is wiped except records we must retain for legal/audit obligations (which remain in redacted/aggregate form).

## 6. Your rights / 你的权利

- **Access / export** — export your orders and account data from the app.
- **Correction** — edit profile fields (name, handle, addresses, contact) yourself.
- **Deletion** — request account deletion in-app; this wipes personal data subject to legal-retention exceptions.
- **Withdraw consent** — the rewards/builder program is opt-in and can be turned off at any time.
- Users in GDPR / CCPA / similar regimes have the additional rights those laws grant; WebAZ honors them where applicable (see LEGAL-DISCLOSURES.md for per-jurisdiction handling, e.g. EU GDPR-grade PII handling).

## 7. Cookies / tracking / Cookie 与跟踪

Minimal: session/authentication state and the Turnstile bot-check only. **No third-party advertising or cross-site tracking cookies.**

## 8. International / jurisdiction / 跨境与司法管辖

WebAZ adapts to local law (see LEGAL-DISCLOSURES.md §jurisdiction): e.g. EU member states run with GDPR-grade PII handling; some regions tighten KYC/reporting. Where mandated, regional handling differs accordingly.

## 9. Children / 未成年人

WebAZ is not directed to children under the age required by your jurisdiction; we do not knowingly collect their personal data.

## 10. Changes & contact / 变更与联系

Material changes will be announced and (for the rewards program) re-consented per the consent-version mechanism. Questions or requests: **contact@webaz.xyz**.

---
*Draft maintained alongside the code: when data collection, processors, retention, or redaction behavior changes, update this file in the same PR. Pending counsel sign-off (#1084) before this replaces TERMS-OF-SERVICE §7 as the canonical privacy statement.*
