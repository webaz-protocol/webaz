/**
 * PR9C-2 — Task Board PARTICIPATION guard (claim / submit / release). Does NOT change the RFC-006 state
 * machine; it wraps the existing claim/submit/release endpoints with a safety boundary so an external
 * participant can't operate on a task they shouldn't, and can't be steered to a non-canonical GitHub repo.
 *
 * Visibility: reuses the member-scope read (getBuildTaskWithAgentMetadata 'member'), which returns null for
 * restricted/internal or missing tasks → the endpoint 404s with NO existence disclosure (id-guessing leak
 * closed). It also runs releaseExpiredClaims (RFC-006 TTL) before the action.
 *
 * Agent-ready rule: a metadata-bearing task is an agent-ready public task; `claim` must respect the DERIVED
 * `claimability` (≠ 'auto_claimable' → typed NOT_AUTO_CLAIMABLE, route it to a human-in-the-loop path). This
 * is the SAME field shapeMetadata derives for display/filter (#5), so the server enforces exactly what the
 * UI/MCP advertise: a task is refused not only when auto_claimable=false, but also when its estimate is a
 * 0–0/null placeholder (claimability downgrades those to manual_review) — making manual_review a server fact,
 * not just a display hint. An OLD no-metadata task stays legacy-compatible (the existing RFC-006 coordination
 * flow keeps working) but is never surfaced as a public agent-ready task — the public read endpoint excludes
 * it, so the public agent discovery→participation path only ever reaches metadata `audience=public` tasks.
 *
 * No reward/score/economic field is ever added; value stays uncommitted.
 */
import type Database from 'better-sqlite3'
import { getBuildTaskWithAgentMetadata } from './build-task-read.js'
import { getCanonicalContributionTarget } from './canonical-contribution-target.js'

export type ParticipationAction = 'claim' | 'submit' | 'release'
export type GuardResult =
  | { ok: true; task: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string }

/** Gate a participation action on a task. restricted/internal/missing → 404 no-leak; auto_claimable=false → refuse claim. */
export function guardParticipation(db: Database.Database, id: string, action: ParticipationAction): GuardResult {
  const task = getBuildTaskWithAgentMetadata(db, id, 'member')   // member scope hides restricted/internal; releaseExpiredClaims runs inside
  if (!task) return { ok: false, status: 404, code: 'NOT_FOUND', message: '任务不存在' }   // also covers restricted/internal → no existence leak
  // Enforce on the DERIVED claimability (shapeMetadata, #5), NOT the raw auto_claimable — so a 0–0/null
  // placeholder estimate (→ claimability 'manual_review') is refused server-side even when its raw
  // auto_claimable flag is true, matching the list/detail/MCP/filter behavior. A metadata-bearing task always
  // carries claimability; a no-metadata legacy task (meta null) keeps the legacy RFC-006 flow (not gated here).
  const meta = task.agent_metadata as { auto_claimable?: boolean; claimability?: string } | null
  if (action === 'claim' && meta && meta.claimability !== 'auto_claimable') {
    return { ok: false, status: 409, code: 'NOT_AUTO_CLAIMABLE', message: '该任务不可自助认领(claimability=manual_review):需真人在环(human_in_the_loop / human_only),或其估算为占位(0–0/未知)、须人工复核后再认领。 / Not auto-claimable (claimability=manual_review): needs a human in the loop, or its estimate is a placeholder (0–0/unknown) and must be reviewed before claiming.' }
  }
  return { ok: true, task }
}

/**
 * Anti GitHub-target-confusion (FAIL-CLOSED). A submitted `pr_ref` is accepted ONLY if it is either:
 *   - a canonical PR shorthand: `#123` or `123` (a PR number on the canonical repo), or
 *   - a strictly-parsed URL whose hostname is EXACTLY `github.com` AND whose first two path segments equal
 *     `canonical_contribution_target.expected_pr_base_repo`.
 * Everything else — a lookalike host (`evilgithub.com`), a non-GitHub host (`gitlab.com`), an unparseable /
 * arbitrary string (`evil/repo#1`), or an empty ref — is REJECTED with a typed code. (Codex P1: substring
 * matching let lookalike hosts and non-URL text through.)
 */
export function validatePrRefAgainstCanonical(prRef: unknown): { ok: true } | { ok: false; code: string; message: string } {
  const ref = String(prRef ?? '').trim()
  const target = getCanonicalContributionTarget()
  const expected = target.expected_pr_base_repo.toLowerCase()
  if (ref === '') return { ok: false, code: 'PR_REF_REQUIRED', message: `submit 需要一个指向 canonical repo ${target.expected_pr_base_repo} 的 PR(github.com URL 或 #编号)` }
  if (/^#?\d+$/.test(ref)) return { ok: true }   // explicit canonical shorthand (#123 / 123)
  let u: URL
  try { u = new URL(ref) } catch { return { ok: false, code: 'INVALID_PR_REF', message: 'PR 必须是 canonical github.com PR URL 或 #编号;不接受任意文本' } }
  if (u.hostname.toLowerCase() !== 'github.com') {
    return { ok: false, code: 'WRONG_PR_BASE_REPO', message: `PR host 必须精确等于 github.com(检测到 ${u.hostname});不要把贡献提交到非 WebAZ 仓库` }
  }
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/)
  const repo = m ? `${m[1]}/${m[2]}`.replace(/\.git$/i, '').toLowerCase() : ''
  if (repo !== expected) {
    return { ok: false, code: 'WRONG_PR_BASE_REPO', message: `PR 必须提交到 canonical repo ${target.expected_pr_base_repo}(检测到 ${repo || '未知'});不要把贡献提交到非 WebAZ 仓库` }
  }
  return { ok: true }
}
