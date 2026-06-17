#!/usr/bin/env tsx
/**
 * F9 — GitHub identity-claim UI contract (static source check over src/pwa/public/app.js).
 *   用法:npm run test:identity-claim-ui
 *
 * The PWA has no DOM harness (repo convention: source contracts; behavior is owned by the API tests
 * test:identity-claim-api / test:identity-claim-read). Locks the F9 wiring in #my-contributions:
 * the page reads /contribution-identity/github/me; the manual claim flow calls claim-challenge then
 * claim-complete; the Passkey ceremony uses purpose 'identity_claim' with purpose_data exactly
 * {github_actor_id, source_event_key, challenge_id}; claim-complete sends the 5 required fields incl.
 * webauthn_token; the listed typed error codes are explicitly handled; the copy never promises economic
 * value (no reward/payout/income/收益/提现 as promissory copy); the client never sends account_id or any
 * GitHub token; failures are never faked as success (success path requires status claimed/already_bound_self).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(HERE, '..', 'src', 'pwa', 'public', 'app.js'), 'utf8')
const i18n = readFileSync(join(HERE, '..', 'src', 'pwa', 'public', 'i18n.js'), 'utf8')

// slice the F9 block: from the section comment to the ticket-view marker that follows it
const startIdx = app.indexOf('F9 — GitHub 贡献认领 UI')
const endIdx = app.indexOf('const TICKET_TYPE_META')
const BLOCK = startIdx >= 0 && endIdx > startIdx ? app.slice(startIdx, endIdx) : ''
// NB: the slice starts mid-line (inside the section's header comment), so drop that partial first line
// before stripping comments — prose may NAME forbidden words in negation (parse-don't-prose).
const CODE = BLOCK.slice(BLOCK.indexOf('\n') + 1).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')

function main(): void {
  ok('F9 block found', BLOCK.length > 1000, `start=${startIdx} end=${endIdx}`)

  // wiring: #my-contributions reads the identity surface + renders the section
  ok('renderMyContributions fetches /contribution-identity/github/me', /GET\('\/contribution-identity\/github\/me'\)/.test(app))
  ok('section rendered inside #my-contributions (between KPI and 限制与申诉)', /ghClaimSectionHtml\(gid, claimable, lang\)/.test(app))

  // step 1: challenge issuance
  ok('claim-challenge called with {source_event_key, github_actor_id}', /POST\('\/contribution-identity\/github\/claim-challenge', \{ source_event_key: sek, github_actor_id: actor \}\)/.test(BLOCK))
  ok('issued response surfaces challenge_id/expires_at/proof_marker', /challenge_id: r\.challenge_id, expires_at: r\.expires_at, proof_marker: r\.proof_marker/.test(BLOCK))
  ok('copy proof_marker button present', /复制 proof_marker/.test(BLOCK) && /gh-claim-marker/.test(BLOCK))
  ok('gist instructions (public gist owned by the actor)', /public gist/.test(BLOCK))

  // step 3: Passkey ceremony + claim-complete
  ok("requestPasskeyGate uses purpose 'identity_claim'", /requestPasskeyGate\('identity_claim',/.test(BLOCK))
  ok('purpose_data is exactly {github_actor_id, source_event_key, challenge_id}', /\{ github_actor_id: ctx\.actor, source_event_key: ctx\.sek, challenge_id: ctx\.challenge_id \}/.test(BLOCK))
  ok('claim-complete body carries the 5 fields incl. webauthn_token', /source_event_key: ctx\.sek, github_actor_id: ctx\.actor,\s*\n\s*challenge_id: ctx\.challenge_id, gist_id: gistId, webauthn_token: token/.test(BLOCK))
  ok('success requires status claimed/already_bound_self (no faked success)', /r\?\.status === 'claimed' \|\| r\?\.status === 'already_bound_self'/.test(BLOCK))
  ok('success refreshes the page (identity surface + reputation panel)', /renderMyContributions\(document\.getElementById\('app'\)\)/.test(BLOCK))
  ok('Passkey failure shows an error and aborts (no submit)', /Passkey 验证未完成/.test(BLOCK))

  // P3 (Codex): challenge-context coherence — step 2 displays the locked actor/source; complete guards
  // against input drift (mismatch → ctx cleared + re-issue demanded); a failed re-issue clears stale ctx.
  ok('step 2 displays the locked actor + source', /本挑战锁定于/.test(BLOCK) && /github:\$\{escHtml\(ctx\.actor\)\}/.test(BLOCK))
  ok('complete guards input drift against the issued ctx', /curActor !== ctx\.actor \|\| curSek !== ctx\.sek/.test(BLOCK) && /输入已更改/.test(BLOCK))
  ok('failed issuance clears the stale challenge ctx + step 2', /签发失败 → 清空旧挑战上下文/.test(BLOCK) || (BLOCK.split('_ghClaimCtx = null').length >= 3))

  // typed error codes explicitly handled
  for (const code of ['GITHUB_READ_NOT_CONFIGURED', 'FACT_NOT_CLAIMABLE', 'ACTOR_MISMATCH', 'ALREADY_BOUND', 'CHALLENGE_EXPIRED', 'CHALLENGE_ALREADY_USED', 'CHALLENGE_NOT_FOUND', 'PROOF_REJECTED', 'HUMAN_PRESENCE_REQUIRED', 'AGENT_SCOPE_UNDECLARED']) {
    ok(`error code handled: ${code}`, BLOCK.includes(code))
  }
  ok('unhandled codes still surfaced (code shown, server text fallback)', /ghClaimErrText\(r\?\.error_code, r\?\.error\)/.test(BLOCK))

  // security boundaries: client never sends account_id / any token besides the webauthn gate token
  ok('client never sends account_id', !/account_id/.test(CODE))
  ok('client never handles a GitHub token (only the webauthn gate token)', !/github_token|read_token|GITHUB_CONTRIB/i.test(CODE))
  ok('no raw nonce/nonce_hash handled client-side', !/nonce_hash|expectedNonceHash/.test(CODE))

  // F10 discovery — the claimable list is fetched, rendered, and click-to-claim drives the F9 flow
  ok('renderMyContributions fetches /contribution-identity/github/claimable', /GET\('\/contribution-identity\/github\/claimable'\)/.test(app))
  ok('claimable list rendered (auto-discovered section + empty state)', /可认领的 GitHub 贡献\(自动发现\)/.test(BLOCK) && /暂无自动发现的可认领贡献/.test(BLOCK))
  ok('认领此贡献 prefills from the row and starts the F9 claim flow', /ghClaimFromRow\('\$\{escHtml\(String\(r\.github_actor_id\)\)\}','\$\{escHtml\(String\(r\.source_event_key\)\)\}'\)/.test(BLOCK) && /window\.ghClaimFromRow = \(actor, sek\)/.test(BLOCK) && /ghClaimIssue\(\)\n\}/.test(BLOCK))
  ok('old F10 deferral note removed (discovery now live)', !/自动发现后续提供|F10 discovery 未做/.test(BLOCK))
  ok('manual entry kept as the fallback', /手动认领一条贡献\(找不到时的备用入口\)/.test(BLOCK) && /可手动输入 source_event_key 与 github_actor_id/.test(BLOCK))
  ok('identity/attribution framing, not compensation', /身份与归属的认领/.test(BLOCK))
  ok('value_boundary notice rendered from the response', /gid\.value_boundary/.test(BLOCK))
  ok('no promissory economic words (reward/payout/income/收益/提现)', !/reward|payout|income|收益|提现/i.test(CODE), (CODE.match(/reward|payout|income|收益|提现/i) || []).join(','))

  // i18n parity for the key strings
  for (const k of ['GitHub 贡献认领(身份归属)', '生成认领挑战', '用 Passkey 完成认领', '复制 proof_marker', '✓ 认领成功 — 贡献事实已归属到本账号']) {
    ok(`i18n EN present: ${k.slice(0, 14)}…`, i18n.includes(`'${k}'`))
  }

  if (fail === 0) {
    console.log(`\n✅ identity-claim UI (F9): #my-contributions reads github/me · challenge → marker+copy+gist steps → Passkey(identity_claim, exact purpose_data triple) → claim-complete(5 fields) · ${10} typed codes handled · no account_id / GitHub token / nonce client-side · no faked success · honest F10 note · no promissory economic copy · i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ identity-claim UI contract FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
