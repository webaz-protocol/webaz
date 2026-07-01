#!/usr/bin/env tsx
/**
 * Leaderboard cards navigate by public handle, not usr_id (privacy + #78 nav-regression fix).
 *
 * #78 dropped the canonical usr_id from the buyers/sellers/agents/... board projections but the card
 * render still navigated `#u/${it.id}` / `#shop/${it.id}` → undefined links; creators KEPT id only
 * because #u/ handle-routing was thought missing. It isn't — GET /api/users/:user_id resolves a handle
 * (users-public.ts resolveUserId), and #shop/:identifier already did. So every leaderboard card now
 * navs via the public handle, and id is dropped from the creators projection too (paired contract:
 * test-leaderboard-anon-projection asserts the allowlist side).
 *
 * Usage: npm run test:leaderboard-nav-handle
 */
import { readFileSync } from 'node:fs'

const DISC = readFileSync('src/pwa/public/app-discover.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. discover mini-leaderboard cards nav by handle (guarded so a handle-less row is non-clickable, never id)
ok('1a. discover sellers card navs #shop/${it.handle}', DISC.includes("it.handle ? `#shop/${it.handle}` : ''"))
ok('1b. discover creators card navs #u/${it.handle}', DISC.includes("it.handle ? `#u/${it.handle}` : ''"))
ok('1c. discover buyers card navs #u/${it.handle}', /buyers[\s\S]{0,220}it\.handle \? `#u\/\$\{it\.handle\}`/.test(DISC))
ok('1d. NO discover leaderboard card navs by it.id anymore', !/#(u|shop)\/\$\{it\.id\}/.test(DISC))

// 2. rankLine is non-clickable when the hash is falsy (no onclick, no cursor:pointer)
ok('2a. rankLine gates onclick on hash', DISC.includes("${hash ? `onclick=\"location.hash='${hash}'\"` : ''}"))
ok('2b. rankLine gates cursor on hash', DISC.includes("${hash ? 'cursor:pointer;' : ''}"))

// 3. full leaderboard page creators card navs #u/${c.handle} (guarded), never #u/${c.id}
ok('3a. full-board creators card navs #u/${c.handle} guarded', APP.includes("c.handle ? `onclick=\"location.hash='#u/${c.handle}'\"` : ''"))
ok('3b. NO full-board card navs #u/${c.id}', !APP.includes("location.hash='#u/${c.id}'"))

if (fail > 0) { console.error(`\n❌ leaderboard nav-by-handle FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ leaderboard nav-by-handle: discover + full-board cards nav via public handle (guarded), no usr_id in any nav\n  ✅ pass ${pass}`)
