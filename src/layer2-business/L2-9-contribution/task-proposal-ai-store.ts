/**
 * Task Proposal AI-assist — ASSISTANT-ONLY recommendation/evidence (never a decision).
 *
 * The AI layer may classify category/risk/effort, flag missing info / duplicates, and suggest draft fields.
 * Its output is stored as a recommendation (evidence) with accountability metadata; a human admin must still
 * explicitly create / publish / reject the formal task. AI never auto-publishes, auto-rejects, assigns
 * reward/credit, or hides proposals.
 *
 * `recommendForProposal` is a SWAPPABLE seam. To avoid blocking this PR on external model setup it ships a
 * deterministic local heuristic (model='heuristic-v1', provider='local'); a real model can replace the body
 * later while keeping the same shape + the same store/UI/accountability contract.
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'

export function initTaskProposalAiSchema(db: Database.Database): void {
  // CREATE only (no ALTER) — additive, never blocks an existing fresh-DB boot.
  db.exec(`CREATE TABLE IF NOT EXISTS task_proposal_ai_suggestions (
    id            TEXT PRIMARY KEY,
    proposal_id   TEXT NOT NULL,
    reviewer_type TEXT NOT NULL DEFAULT 'ai',
    model         TEXT,
    provider      TEXT,
    input_hash    TEXT,
    input_summary TEXT,
    output_json   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tpai_proposal ON task_proposal_ai_suggestions(proposal_id, created_at DESC)`)
}

export interface ProposalLite { id: string; title: string; summary: string; suggested_area?: string | null; source_ref?: string | null; expected_outcome?: string | null }

/** Read the fields the recommender needs (keeps the route free of direct SQL). */
export function getProposalLite(db: Database.Database, id: string): ProposalLite | null {
  return (db.prepare('SELECT id, title, summary, suggested_area, source_ref, expected_outcome FROM task_proposals WHERE id = ?').get(id) as ProposalLite | undefined) ?? null
}

export interface ProposalRecommendation {
  category: string
  risk: 'low' | 'medium' | 'high'
  effort: 'small' | 'medium' | 'large'
  missing_info: string[]
  duplicate_likelihood: 'low' | 'medium' | 'high'
  suggested: { title: string; area: string | null; description: string; acceptance_criteria: string[]; verification_commands: string[] }
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  docs: ['doc', 'readme', '文档', 'guide'], i18n: ['i18n', 'translat', '翻译', 'locale'],
  tests: ['test', '测试', 'spec'], ui: ['ui', 'page', 'button', '界面', 'pwa', 'css'],
  api: ['api', 'endpoint', 'route'], schema: ['schema', 'migration', 'table', '字段'],
  infra: ['ci', 'deploy', 'infra', 'pipeline', 'docker'], governance: ['governance', 'charter', '治理', 'rfc'],
  audit: ['audit', 'security', '审计', '安全'], code: ['fix', 'bug', 'refactor', 'implement', '实现', '修复'],
}
const HIGH_RISK_KEYWORDS = ['wallet', 'withdraw', 'fund', 'money', 'settle', 'escrow', 'payment', 'reward', 'schema', 'migration', 'auth', 'admin', 'key', '资金', '钱包', '提现', '结算', '权限', '密钥']

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()

/**
 * Deterministic local heuristic recommendation (stub for a future model). Read-only; never decides.
 */
export function recommendForProposal(db: Database.Database, p: ProposalLite): { recommendation: ProposalRecommendation; model: string; provider: string } {
  const text = norm(`${p.title} ${p.summary} ${p.suggested_area ?? ''}`)
  // category
  let category = 'other'; let best = 0
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    const hits = kws.filter(k => text.includes(k)).length
    if (hits > best) { best = hits; category = cat }
  }
  // risk
  const risk: ProposalRecommendation['risk'] = HIGH_RISK_KEYWORDS.some(k => text.includes(k)) ? 'high' : (p.summary.length > 400 ? 'medium' : 'low')
  // effort by summary size
  const effort: ProposalRecommendation['effort'] = p.summary.length > 600 ? 'large' : p.summary.length > 200 ? 'medium' : 'small'
  // missing info flags
  const missing_info: string[] = []
  if (p.summary.trim().length < 40) missing_info.push('summary too short — needs concrete scope / acceptance')
  if (!p.source_ref) missing_info.push('no source_ref (file / RFC / issue reference)')
  if (!p.expected_outcome) missing_info.push('no expected_outcome (definition of done)')
  // duplicate likelihood: normalized-title overlap vs existing proposals + build_tasks
  const titleNorm = norm(p.title)
  const titleWords = new Set(titleNorm.split(' ').filter(w => w.length >= 3))
  let dupScore = 0
  if (titleWords.size > 0) {
    const others = (db.prepare(`SELECT title FROM task_proposals WHERE id != ? UNION ALL SELECT title FROM build_tasks`).all(p.id) as Array<{ title: string }>)
    for (const o of others) {
      const ow = new Set(norm(o.title).split(' ').filter(w => w.length >= 3))
      let inter = 0; for (const w of titleWords) if (ow.has(w)) inter++
      const jac = inter / (titleWords.size + ow.size - inter || 1)
      if (jac > dupScore) dupScore = jac
    }
  }
  const duplicate_likelihood: ProposalRecommendation['duplicate_likelihood'] = dupScore >= 0.6 ? 'high' : dupScore >= 0.3 ? 'medium' : 'low'

  const recommendation: ProposalRecommendation = {
    category, risk, effort, missing_info, duplicate_likelihood,
    suggested: {
      title: p.title,
      area: p.suggested_area ?? category,
      description: p.summary,
      acceptance_criteria: p.expected_outcome ? [String(p.expected_outcome).slice(0, 500)] : [],
      verification_commands: [],
    },
  }
  return { recommendation, model: 'heuristic-v1', provider: 'local' }
}

/** Persist an AI suggestion as evidence (accountability metadata). Returns the row id. */
export function insertAiSuggestion(db: Database.Database, args: {
  proposalId: string; reviewerType?: string; model?: string | null; provider?: string | null; inputSummary: string; outputJson: string
}): { id: string } {
  const id = generateId('tpai')
  const inputHash = createHash('sha256').update(args.inputSummary).digest('hex')
  db.prepare(`INSERT INTO task_proposal_ai_suggestions (id, proposal_id, reviewer_type, model, provider, input_hash, input_summary, output_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, args.proposalId, args.reviewerType ?? 'ai', args.model ?? null, args.provider ?? null,
    inputHash, args.inputSummary.slice(0, 1000), args.outputJson)
  return { id }
}

export function listAiSuggestions(db: Database.Database, proposalId: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id, proposal_id, reviewer_type, model, provider, input_summary, output_json, created_at
    FROM task_proposal_ai_suggestions WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 20`).all(proposalId) as Array<Record<string, unknown>>
}
