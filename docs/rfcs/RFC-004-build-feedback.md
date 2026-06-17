# RFC-004: webaz_feedback — collapsing the use↔build distance / 让"使用"与"建设"距离归零

**Status**: implemented — backend + MCP tool shipped 2026-06-05
**Author**: @seasonkoh
**Created**: 2026-06-05
**Track**: normal — new agent-facing protocol surface; strengthens #1 (visibility) / #10 (participants); reuses existing accountability (#6) + reputation
**Related issue**: task #1112 / #1113 / #1114
**Related**: [RFC-003](RFC-003-mcp-network-client.md) (dual-mode MCP client — feedback follows the same NETWORK/SANDBOX pattern)

---

## Summary / 摘要

In the agent era the distance between **using** a protocol and **building** it can be ~0: the user's agent is *already inside* the protocol (it has the MCP connected). So it can not only help the user **use** WebAZ — it can help them **contribute back** (report a problem / propose an improvement) in the same breath, without leaving the flow.

WebAZ's 37 tools cover *using* the protocol well, and governance participation exists (claim-verify, RFC flow), but there is **no lightweight in-band entry for "I hit a problem / I have an idea."** Today the user's agent has nowhere to put that except telling the human to go open a GitHub issue (out-of-flow, high friction).

This RFC adds one tool, **`webaz_feedback`**, that lets an agent submit a user's in-use feedback right where it happens — with the **scene evidence** the agent uniquely has (what tool was called, outcome, the user's real intent) — into a triaged, status-tracked pipeline that closes the loop and credits accepted feedback to co-build reputation.

---

## Motivation / 动机

- **Traditional feedback**: user → find a form → write → submit → silence. 99% never bother; "search is bad" arrives with no repro and dies.
- **Agent-native feedback**: the agent is on the spot. It attaches the full scene (`webaz_search(query="iphone")` → 0 results under strict-match; user's intent was fuzzy browse). A maintainer can reproduce and fix. This is the **killer difference** vs a feedback form.
- **Closed loop turns users into contributors**: when a user sees their feedback actually changed the protocol (status visible + reputation credited), they keep contributing — the "user → webazer" conversion path opens. This is exactly the "participant = webazer" thesis.

---

## Design / 设计

### Locked decisions (user, 2026-06-05) / 已锁决策
1. **New dedicated table** `build_feedback` — *not* reusing the customer-support `feedback_tickets` helpdesk (different semantics; keep triage queues separate).
2. **One tool** `webaz_feedback` with `type=ux_issue|bug|proposal` — not two tools. (Keeps the agent's mental model simple; tool count stays lean.)
3. **Passkey-gated (real human only)** — only a Passkey-bound webazer may submit. Rights ↔ responsibility parity, and it grounds later contribution rewards. (Checked via the same `hasPasskey` signal as write-accountability.)
4. **Scene evidence is redacted** before storage (no raw PII params).
5. Build the whole loop (submit → triage → resolve → reputation), quality over speed.

### 3-layer participation / 三层参与(从随口到正式)
| Layer | Entry | What |
|---|---|---|
| **1. `type=ux_issue`** | `webaz_feedback` | 最轻:使用中随口反馈,agent 自动带现场证据,不打断流程 |
| **2. `type=proposal`** | `webaz_feedback` | 有改进想法;去重后,够分量的 agent 可帮起草成 RFC |
| **3. RFC** | CONTRIBUTING / PR | 正式协议级提案(状态机/资金/治理);agent 大幅降低写 RFC 门槛 |

### Tool surface / 工具
`webaz_feedback`:
- `action=submit` (default): `type`, `area` (e.g. `search`/`order`/`dispute`…), `text`, `severity` (`low|annoying|blocking`, for issues), optional `subject`. Server auto-attaches **scene evidence**.
- `action=my`: list the caller's feedback + current status (the closed-loop query).
- `action=get`: one item by id.

### Scene evidence / 现场证据
- The MCP server keeps an **in-process ring buffer** of the last ~8 tool calls: `{tool, arg_keys (names only, no values), outcome, _mode, ts}`. **Values are never captured** (redaction by construction); only argument *key names* + outcome.
- On submit, the buffer is attached as `scene_json`, plus any `area`/`context` the agent provides.
- Server side additionally references recent `mcp_tool_calls` rows (tool/outcome only) for the user.

### Status machine + closed loop / 状态机 + 闭环
`received → triaged → in_progress → resolved | declined | duplicate`
- `webaz_feedback(action=my)` lets the user/agent see where it went.
- On `resolved` with credit, the submitter earns **co-build reputation** (`recordRepEvent('feedback_accepted')`). Accepted feedback = a contribution → the "user → webazer" path.

### Anti-noise (3 gates) / 反噪音三闸
1. **Passkey/real-human gate** — blocks batch agent spam (decision 3).
2. **Rate limit** — N submissions/user/day.
3. **Dedup + AI triage** — proposals are checked against open ones in the same area; AI triage hook pre-classifies so maintainers only see filtered items. (Mirrors "AI review is the first gate".)
> Goal: an open build-input surface, **not** a garbage collector. Reuse the existing human-gate + reputation + AI-triage muscles.

### Dual-mode / 双模(沿用 RFC-003)
- **NETWORK**: `POST /api/build-feedback` etc. on `webaz.xyz` — the only place maintainers actually receive it. (Path namespaced as `/api/build-feedback` to avoid colliding with the customer-support helpdesk at `/api/feedback`.)
- **SANDBOX**: returns guidance ("switch to NETWORK / set WEBAZ_API_KEY to send feedback to the project") — offline play has no recipient. `webaz_feedback` is in `NETWORK_TOOLS`.

---

## Meta-rule impact / 元规则影响
- **#1 visible**: ✅ feedback + status are first-class, queryable.
- **#4 honest**: ✅ scene evidence is factual; sandbox clearly can't deliver feedback.
- **#6 no-abuse**: ✅ Passkey gate + rate-limit + dedup; accountable submitter.
- **#10 participants**: ✅ opens the user→webazer conversion (accepted feedback = contribution).
- Iron-Rule: submission is a low-stakes write but **gated to real humans** by design — stricter than ordinary agent writes, intentionally (rights↔reward grounding).

## Risks / 风险
- Feedback flood / noise → 3 gates above; tune rate-limit + dedup with real traffic.
- Reputation gaming (spam "accepted" feedback) → only maintainer triage credits; credit is logged in `build_feedback_events` for audit.

## Test plan / 测试
- Backend: submit (Passkey-gated reject/accept), mine, get, admin triage → reputation credited; rate-limit; proposal dedup. curl e2e on local pwa.
- MCP: NETWORK submit/my/get against local pwa; SANDBOX returns guidance; ring-buffer scene attached + redaction (no values). build + schema:verify green.
