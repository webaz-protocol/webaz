#!/usr/bin/env tsx
/**
 * Rewards consent text — share-commission opt-in framing (NOT 共建身份 / contribution eligibility) and the
 * current commission-level reality boundary. Static source check.
 *   用法:npm run test:rewards-consent-text
 *
 * The user-facing consent is the latest change_class='major' row in rewards_consent_texts (served +
 * recorded by routes/rewards-apply.ts). This locks: v1.1 (the current major) drops the Builder-Identity
 * framing, states "not contribution eligibility" + the pre-launch 1-level cap, while v1.0 stays FROZEN
 * (hash-bound, version-immutable) and v1.1.effective_at > v1.0 so "latest major" deterministically = v1.1.
 * Also: the #apply-rewards banner no longer presents "三级佣金" as a flat current descriptor.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(ROOT, 'src', 'pwa', 'server.ts'), 'utf8')
const app = readFileSync(join(ROOT, 'src', 'pwa', 'public', 'app.js'), 'utf8')

const slice = (from: string, to: string, src = server): string => {
  const i = src.indexOf(from); if (i < 0) return ''
  const j = src.indexOf(to, i); return j < 0 ? src.slice(i) : src.slice(i, j)
}

function main(): void {
  const v11 = slice('function seedConsentV11()', '})()')
  const v10 = slice('function seedConsentV1()', '})()')
  // the actual consent TEXT (single-quoted literals; no ASCII apostrophes inside) — scope framing checks
  // here so a changelog/comment that NAMES the old wording in negation doesn't trip the absence check.
  const v11text = ((v11.match(/const textZh = '([^']*)'/) || [])[1] || '') + '\n' + ((v11.match(/const textEn = '([^']*)'/) || [])[1] || '')

  // ── v1.1 is the new current-major consent ────────────────────────────────────────────────────────
  ok('v1.1 seed exists', v11.length > 200, `len=${v11.length}`)
  ok("v1.1 is change_class='major' (so the apply page + activate serve it as current)", /\.run\('1\.1', hash, effectiveAt,[\s\S]*?\)/.test(v11) && /VALUES \(\?, \?, 'major'/.test(v11))
  ok('v1.1 effective_at is forced strictly later than v1.0 (deterministic latest-major)', /Math\.max\(Date\.now\(\), \(v10\?\.effective_at \?\? 0\) \+ 1\)/.test(v11))

  // ── framing: share-commission opt-in, NOT 共建身份 / Builder Identity, NOT contribution eligibility ──
  ok('v1.1 TEXT drops 共建身份 / Builder Identity framing', !!v11text.trim() && !/共建身份|Builder Identity/.test(v11text))
  ok('v1.1 uses 分享分润开通 / share-commission opt-in', /分享分润开通/.test(v11text) && /share-commission opt-in/.test(v11text))
  ok('v1.1 states it is NOT contribution eligibility (zh + en)', /不是共建贡献资格/.test(v11text) && /not contribution eligibility/.test(v11text))
  ok('v1.1 says it does not affect contribution tasks / GitHub claims / normal orders', /不影响贡献任务、GitHub 贡献认领或普通下单/.test(v11text) && /contribution tasks, GitHub contribution claims, or normal orders/.test(v11text))

  // ── commission-level reality boundary (pre-launch cap 1; "three tiers" = max design, not a promise) ──
  ok('v1.1 states the pre-launch global cap is 1 level (zh + en)', /当前预发布期全局上限为 1 级/.test(v11text) && /during pre-launch the global cap is 1 level/.test(v11text))
  ok('v1.1 frames "三级 / three tiers" as protocol maximum design (not current promise)', /“三级”仅为协议最大设计/.test(v11text) && /“three tiers” is only the protocol maximum design/.test(v11text))

  // ── v1.0 stays FROZEN (version-immutable; we chose new-version, not in-place rewrite) ──────────────
  ok('v1.0 still present + frozen with its original Builder-Identity wording', /WebAZ 共建身份\(rewards opt-in\)v1\.0/.test(v10) && /WebAZ Builder Identity \(rewards opt-in\) v1\.0/.test(v10))
  ok('v1.0 unchanged hash recipe (text_zh + \\n---\\n + text_en)', /createHash\('sha256'\)\.update\(textZh \+ '\\n---\\n' \+ textEn\)/.test(v10))

  // ── #apply-rewards banner no longer presents 三级佣金 as a flat current descriptor ─────────────────
  ok('apply banner de-leveled (no bare "经济关系登记(三级佣金 + 积分配对)")', !app.includes('本流程涉及经济关系登记(三级佣金 + 积分配对)'))
  ok('apply banner uses share-commission economic-relationship framing', app.includes('本流程是分享分润的经济关系登记(佣金 / PV / escrow 结算规则;层级按地区配置)'))

  // ── deploy gate (Codex #354 P2): a new major consent arms auto-downgrade but there is no reconfirm
  //    path, so it is only safe at zero opted-in users — that gate must be DOCUMENTED, not assumed. ──
  const rfc = readFileSync(join(ROOT, 'docs', 'rfcs', 'RFC-002-rewards-opt-in.md'), 'utf8')
  ok('seed comment carries the zero-opted-in deploy gate', /DEPLOY GATE/.test(server) && /rewards_opted_in = 1/.test(slice('DEPLOY GATE', '})()')))
  ok('RFC-002 documents the major-consent deploy gate + reconfirm-not-wired status',
    /rewards_opted_in = 1/.test(rfc) && /ALREADY_OPTED_IN/.test(rfc) && /尚未接线|未接线|not.*wired/.test(rfc))

  if (fail === 0) {
    console.log(`\n✅ rewards consent text: v1.1 (current major) = share-commission opt-in, not 共建身份 / not contribution eligibility, pre-launch 1-level cap + "three tiers"=max-design; v1.0 frozen; effective_at deterministic; apply banner de-leveled\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ rewards consent text FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
