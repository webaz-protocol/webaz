#!/usr/bin/env tsx
/** Rewards consent wording/version guard. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(ROOT, 'src', 'pwa', 'server.ts'), 'utf8')
const launchMigrations = readFileSync(join(ROOT, 'src', 'pwa', 'public-launch-migrations.ts'), 'utf8')
const routes = readFileSync(join(ROOT, 'src', 'pwa', 'routes', 'rewards-apply.ts'), 'utf8')
const autoDowngrade = readFileSync(join(ROOT, 'src', 'pwa', 'routes', 'rewards-auto-downgrade.ts'), 'utf8')

const slice = (source: string, from: string, to: string): string => {
  const i = source.indexOf(from); if (i < 0) return ''
  const j = source.indexOf(to, i); return j < 0 ? source.slice(i) : source.slice(i, j)
}

const v10 = slice(server, 'function seedConsentV1()', '})()')
const v11 = slice(server, 'function seedConsentV11()', '})()')
const v12 = slice(launchMigrations, 'function seedPublicLaunchConsentV12(', '\n}')
const v12text = ((v12.match(/const textZh = '([^']*)'/) || [])[1] || '') + '\n' + ((v12.match(/const textEn = '([^']*)'/) || [])[1] || '')

ok('v1.0 and v1.1 immutable historical seeds remain', v10.length > 200 && v11.length > 200)
ok('v1.2 wording refresh seed exists', v12.length > 200)
ok("v1.2 is minor so launch wording does not trigger major reconfirm", /VALUES \(\?, \?, 'minor'/.test(v12))
ok('v1.2 effective_at follows v1.1', /\(v11\?\.effective_at \?\? 0\) \+ 1/.test(v12))
ok('v1.2 drops pre-launch wording', !!v12text && !/pre-launch|预发布/.test(v12text))
ok('v1.2 retains share-commission framing', /分享分润开通/.test(v12text) && /share-commission opt-in/.test(v12text))
ok('v1.2 retains contribution boundary', /不是共建贡献资格/.test(v12text) && /not contribution eligibility/.test(v12text))
ok('v1.2 states current global cap without launch-stage label', /当前全局上限为 1 级/.test(v12text) && /current global cap is 1 level/.test(v12text))
ok('status and apply read latest effective consent, including minor wording refresh', (routes.match(/FROM rewards_consent_texts ORDER BY effective_at DESC LIMIT 1/g) || []).length >= 2)
ok('major auto-downgrade remains separately gated', /major/.test(autoDowngrade) && /rewards_opted_in = 1/.test(autoDowngrade))
ok('minor v1.2 acceptance satisfies the older major consent gate', /last_effective_at/.test(autoDowngrade) && />= currentMajor\.effective_at/.test(autoDowngrade))

if (fail > 0) { console.error(`\n❌ rewards consent text FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ rewards consent v1.2 launch wording refresh; v1.0/v1.1 immutable; major downgrade boundary preserved\n  ✅ pass ${pass}`)
