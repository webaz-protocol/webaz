# MISSING_RESOURCES

> Resources needed for the ChatGPT-card audit, classified by who can supply them and whether they block progress.
> Captured 2026-07-20 during the Phase-1 baseline. No secrets/credentials are requested to be pasted here — human-operated items stay human-operated.

## A. Public — I can fetch/produce myself (no blocker)

| Resource | Where | Status |
|---|---|---|
| Full MCP Apps normative spec body `apps.mdx` (`2026-01-26` + `draft`) | GitHub `modelcontextprotocol/ext-apps/specification/…` | Fetchable next phase (resolves several `[confirm-live]` string questions: capability key, method field schemas). |
| `@modelcontextprotocol/ext-apps` typedoc (App Bridge, interfaces) | `apps.extensions.modelcontextprotocol.io/api/` | Reachable; partially read. Deep-read as needed. |
| Official example widgets (React/Vue/vanilla, basic-host) | GitHub `modelcontextprotocol/ext-apps/examples` | Fetchable — reference implementations to compare WebAZ's hand-rolled bridge against. |
| Remaining Apps SDK pages (Monetize, Optimize Metadata, Troubleshooting, Conversion specs) | `developers.openai.com/apps-sdk/*` | Fetchable if the audit needs them. |
| `modelcontextprotocol.io/llms-full.txt` / `developers.openai.com/apps-sdk/llms-full.txt` | official | Fetchable — bulk verbatim cross-check. |

## B. Private — project owner must provide

| Resource | Why needed | Sensitivity |
|---|---|---|
| ChatGPT Developer-mode access (the account that will host the WebAZ connector) | To render real cards and observe actual behavior | Human-operated; **do not** paste credentials — operate it yourself. |
| Production/staging `/mcp` base URL to point ChatGPT at | Connector target for live testing | URL only; fine to share. Avoid embedding tokens. |
| A WebAZ test account usable for the card flows | To exercise search → quote → approval → timeline cards end-to-end | Human-operated; credentials never recorded here. |
| Confirmation of which env to test against (prod `webaz.xyz` vs a staging deploy) | Prod has 40+ real accounts — blast radius. Prefer staging/dev for anything mutating. | Decision, not a secret. |

## C. Human-operated tests (cannot be automated from here)

| Test | Operator action |
|---|---|
| Render each of the 3 cards in real ChatGPT (web **and** mobile) | Human drives ChatGPT Developer mode, screenshots each card state. |
| Confirm whether ChatGPT still requires `text/html+skybridge` or accepts `text/html;profile=mcp-app` | Observe which resource variant ChatGPT actually loads. |
| Capture the real enforced CSP / iframe `sandbox` attributes | Read them off the rendered iframe in the browser (I can assist via Claude-in-Chrome once a session is authorized). |
| Verify card buttons (select · prepare-order · view-status) actually fire and round-trip | Human clicks; Passkey/real-money steps stay human per iron rule. |
| MCP Inspector session against the live endpoint | `npx @modelcontextprotocol/inspector@latest` → interactive browser (network + human). |

## D. Missing but NOT blocking the audit

- Live CSP/sandbox exact strings — the audit can proceed on documented *semantics*; the exact strings only matter at the verification/fix-acceptance stage.
- The `[confirm-live]` notification field schemas — code-level audit of `ui-widgets.ts` bridge can proceed against the documented method names first.
- Conversion Apps (checkout/reservation) specs — not on WebAZ's current card path.

## E. Missing AND blocking (would block remediation or acceptance)

- **Live ChatGPT render + a test account (Section B/C).** Without at least one real render, we cannot *confirm* a fix actually fixes the card — only that code matches the written spec. This is the single hard dependency for **acceptance** (not for the read-only audit itself).
- **Environment decision (prod vs staging) for any mutating test.** Blocks any end-to-end flow that would touch real orders/money; those must run on a safe environment with a throwaway account, never against the 40+ prod accounts.

---

### Bottom line

The **read-only audit and gap analysis can proceed now** with Section-A public resources — nothing in Section D/E blocks producing the findings list. What is blocked is **final acceptance of any remediation**, which requires a human-operated live ChatGPT render (Section B/C). We should line up the Section-B items before, or in parallel with, building fixes — not before starting the audit.
