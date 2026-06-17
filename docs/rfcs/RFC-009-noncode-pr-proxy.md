# RFC-009: Non-code PR-proxy — let non-technical contributors ship without GitHub / 非代码贡献者零 GitHub 代开 PR

**Status**: draft (design locked; implementation gated on repo-public) — 2026-06-06
**Author**: @seasonkoh
**Track**: normal — new contribution surface crossing the protocol↔GitHub boundary. Touches DCO (legal), a GitHub bot (security), attribution. Does NOT change merge authority.
**Related**: RFC-004 (feedback) · RFC-006 (contribution layer) · CONTRIBUTING (DCO/PR flow) · open-protocol moat (repo-public is a strategic choice)

---

## Context — the use→build funnel's last wall / 漏斗最后一堵墙

The buyer→contributor funnel had three breakpoints. Two are shipped:
- **Bridge** (accepted proposal → claimable task + invite the proposer) — done (#113).
- **Code handoff** (claim returns repo + AGENTS.md + PR flow → the contributor's *coding agent* does git) — done (#114).

The last one is for **non-technical contributors**: someone who can write a doc / translation / FAQ answer but will never fork/clone/PR. They submit **content**; the protocol opens the GitHub PR **for** them, attributed to them. Captures the largest pool of "have an idea, can write, won't touch GitHub" people — the deepest realization of "use→build distance to zero."

---

## Scope (locked): inbox-new-content only / 仅收件箱新内容

The PR-proxy handles **new content added to a staging inbox**, not edits to existing files:
- A submission becomes a **new file** under `docs/community-contributions/<id>.md` (or a typed subdir). One file per submission → **no merge conflicts, no need to know the repo's file structure**, and a **human maintainer integrates** it into the real location later.
- Edits to existing files + structured translations are **out of scope** (a non-technical contributor can't reliably target a file+diff; high conflict/quality risk). They remain the coding-agent path (#114).

This keeps the mechanism tractable and keeps a human in the integration loop.

---

## Architecture / 架构

```
contributor submits CONTENT (Passkey-gated = building) via webaz_contribute/feedback
  → stored as a build_task/feedback row: { content, declared provenance, DCO consent }
  → a MAINTAINER reviews + clicks "open PR"            ← human gate (no PR without greenlight)
  → protocol fires a GitHub `repository_dispatch`       ← no repo token on the app server
  → a GitHub Action writes docs/community-contributions/<id>.md on a new branch
       and opens a PR: attributed to <handle>, provenance tag, DCO note, link back
  → humans review + merge (branch protection)           ← bot never merges
```

### Resolutions to the hard problems
1. **Bot can only OPEN, never merge.** Branch protection enforces human merge; the bot's blast radius is "create branch + open PR," consistent with the no-auto-merge invariant.
2. **Token off the app server.** The repo credential lives in **GitHub Actions** (`repository_dispatch` → Action's native `GITHUB_TOKEN`/App), never in the Railway app. A compromised app server cannot push to the repo. (Same isolation principle as RFC-005's ai-review.yml.)
3. **No spam.** Content sits in a queue; a **maintainer triggers** the PR. No submission auto-opens a PR. Passkey-gated submission + rate limits add friction.
4. **DCO (legal).** The Passkey-anchored contributor **certifies DCO at submission time** (recorded consent); the bot's PR carries `Signed-off-by: <handle> via WebAZ` + a link to the on-protocol certification. The Passkey real-person anchor makes the certification meaningful.
5. **Attribution + provenance.** PR attributes the contributor and carries the **self-declared provenance** (🤖🤖🤖 in the title if `ai_authored`) — attribution, not detection (RFC-006).
6. **Inbox model.** New file per submission → no conflicts, no file-structure knowledge needed; maintainer integrates.

---

## Invariants (locked) / 不变量
1. **Bot never merges** — humans + branch protection only. The proxy opens PRs; acceptance stays human (CHARTER §4 / RFC-005 lineage).
2. **No repo credential on the app server** — PR creation runs in GitHub Actions; the protocol only fires a dispatch.
3. **No PR without a human greenlight** — a maintainer triggers each proxy PR (anti-spam; keeps the public repo clean).
4. **Passkey-anchored + DCO-certified** — only real, accountable humans use the proxy; their DCO consent is recorded and linked.
5. **Inbox-only** — new files into a staging dir; never auto-edit existing files; a human integrates.

---

## Implementation — gated on repo-public / 实现门控

**Design is locked; implementation is deferred until the repo is public** (the contributor can't even see a PR on a private repo → the proxy is internal-only pre-launch) **or the first real non-technical contributor appears.** Consistent with "design first, implement on a real signal." When triggered:
- add the GitHub Action (`repository_dispatch` → write inbox file → open PR with attribution/provenance/DCO);
- add the content payload + DCO-consent fields to the submission flow + a maintainer "open PR" action;
- the `docs/community-contributions/` inbox dir + a short README on how maintainers integrate.

Until then, breakpoints 2 (#113) and 1b (#114) already make the funnel structurally continuous for proposal-makers and coding-agent contributors.

## Cross-path checklist when un-gating (red-team 2026-06-07) / 解除门控时的必做清单

Surfaced by the scenario "agent + Passkey human + accepted proposal + **no GitHub account** — now what?". The propose path is already clean (Passkey only, zero GitHub; co-build reputation is WebAZ-native and decoupled from any GitHub identity — even backfilled on a later Passkey bind, #138). The gaps below are all in the *implement* path and only bite once the repo is public:

1. **Route non-technical claimers to the proxy, not the git handoff.** Today `handleContribute` claim always returns the coding-agent handoff ("point a coding agent at the repo / git PR flow") — a dead-end指引 for a non-technical / no-GitHub claimer. When un-gating: a claim (and the proposal-accepted invite) must branch — *content* contribution → this proxy; *code-edit* contribution → coding-agent handoff (#114). Don't hand git instructions to someone who can't use them.
2. **Completion-state framing, not failure.** A Passkey human whose proposal was accepted has *already* contributed and been credited. With no coding agent / no GitHub, the UI must read "your contribution = the accepted proposal (credited)", never imply "you still owe an implementation".
3. **Attribution binding is maintainer-verified, not cryptographic.** WebAZ claim (Passkey) ↔ GitHub PR (the `pr_ref` string typed at submit) has no crypto link — a maintainer `resolve` is the human gate confirming "this claimer actually authored this PR." Keep that human-in-loop; never auto-award reputation from a bare `pr_ref`.
4. **No-GitHub still can't edit existing files** (scope locked above): the proxy only adds new inbox files. Editing existing code with no GitHub account stays intentionally unsolved (needs a coding agent → needs a GitHub identity). State this honestly; don't imply full parity.

## Open questions / 待议
- GitHub **App vs fine-grained PAT** for the Action's repo access (lean: GitHub App, revocable + least-privilege).
- Whether the inbox dir is flat or typed (`/docs/`, `/translations/`, `/data/`) — decide at implementation.
- Exact DCO-consent UX wording (legal review at implementation, with `contact@webaz.xyz`).
