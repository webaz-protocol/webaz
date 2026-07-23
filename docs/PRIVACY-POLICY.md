# WebAZ Privacy Policy / 隐私政策

> **Status: published privacy policy (v1).** This document describes current WebAZ operational
> practices. It is not legal advice and does not claim external legal review.
> Expands TERMS-OF-SERVICE §7 into a standalone policy, grounded in
> the system's *actual* data practices (code + `protocol_params`). Any claim here must match
> behavior — update this file when data handling changes. Contact: **contact@webaz.xyz**.
>
> Effective date: 2026-07-23. Operator and publisher: **XU FENGNA (individual)**.
> Jurisdiction-specific rights: see LEGAL-DISCLOSURES.md.

---

## 1. What we collect / 我们收集什么

**Account & identity** — handle, display name; **optional** email and/or phone (only if you add them, used for verification, notifications, and account recovery); region (coarse, for regulatory routing). You may use WebAZ with a minimal profile.

**Shipping / fulfillment** — addresses you save or attach to an order (recipient, address text/components, phone). Needed only to fulfill physical orders; visible to the counterparty of *that* order, not publicly.

**Authentication** — Passkey / WebAuthn credentials are stored as **public keys only**; biometric data never leaves your device and is never sent to or stored by WebAZ.

**Operational / security metadata** — connection IP and browser user-agent may be processed for active
sessions, security diagnostics, and rate limits. Registration, click-deduplication, and similar audit records
use **IP / user-agent hashes** where the raw values are not needed. Order and protocol audit trails and dispute
records are retained for fraud prevention, abuse limits, and dispute resolution.

**KYC / KYB and screening records** — processed only when a regulated or risk-gated capability requires them,
such as seller Direct Pay onboarding or a threshold withdrawal. They are not required for ordinary catalog browsing.

**AI-assisted features** — if you explicitly invoke an AI-assisted feature, the text or image needed for that
request may be sent to the configured AI provider. Do not include unnecessary personal or confidential data.

## 2. Why we process it / 处理目的

Provide and secure the service; fulfill orders; prevent fraud/abuse (rate limits, sybil resistance); resolve disputes (audit trail + arbitration); and meet legal obligations (AML/KYC where triggered). Where a jurisdiction requires a legal basis (e.g., GDPR), processing rests on contract performance, legitimate interest (security/anti-fraud), and legal obligation.

## 3. How it's protected / 如何保护

- **No PII in the public record.** The public dispute archive (`dispute_cases`) is **PII-redacted**; the live case is visible only to the parties + the assigned arbitrator.
- Audit identifiers are hashed/anonymized where raw values are not needed. Limited raw session/security
  metadata may be retained as described above. PII is never intentionally placed in URLs or query strings.
- Fund-moving and identity/PII-changing actions are gated (Passkey human-presence + scoped agent permissions).

## 4. Sharing & third parties / 共享与第三方

- **We do not sell your data, and we do not share PII with third parties for marketing.**
- Service processors used to operate WebAZ:
  - **Cloudflare** — CDN / DNS / email routing (e.g., `contact@webaz.xyz`).
  - **Cloudflare Turnstile** — bot / abuse check at sensitive entry points.
  - **Railway** — application + database hosting.
  - **Anthropic, OpenAI, or a user-selected AI provider** — only when an AI-assisted feature is invoked;
    the selected provider processes the submitted prompt/content under its own terms.
  Each processes data only to provide its function.
- **Connected clients** — if you connect WebAZ to ChatGPT or another agent client, that client receives the
  tool inputs and results needed to perform your request under the client's own privacy terms.
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
*Maintained alongside the code: when data collection, processors, retention, or redaction behavior changes, update this file in the same PR.*
