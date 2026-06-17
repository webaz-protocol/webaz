// task #1128 — faucet (WAZ mint path) gate is fail-safe DEFAULT-CLOSED.
//   Locks the truth table for isFaucetAllowed; the critical case is an UNSET NODE_ENV on a
//   deploy platform (Railway) → must stay CLOSED (a misconfigured prod must never open minting).
import { isFaucetAllowed } from '../src/pwa/routes/wallet-read.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n) } }
const f = (nodeEnv: string | undefined, onDeployPlatform: boolean, explicitEnableFlag: boolean) =>
  isFaucetAllowed({ nodeEnv, onDeployPlatform, explicitEnableFlag })

// ── production: ALWAYS closed (even with the enable flag) ──
expect('prod + platform + no flag → CLOSED', f('production', true, false) === false)
expect('prod + flag mis-set → still CLOSED (production hard-blocks)', f('production', true, true) === false)
expect('prod off-platform → CLOSED', f('production', false, false) === false)

// ── the key fail-safe: UNSET NODE_ENV on a deploy platform → CLOSED ──
expect('unset NODE_ENV + Railway + no flag → CLOSED (fail-safe)', f(undefined, true, false) === false)
expect('unset NODE_ENV + Railway + flag=1 → OPEN (explicit opt-in)', f(undefined, true, true) === true)

// ── staging on platform: opt-in via flag ──
expect('staging + platform + flag=1 → OPEN', f('staging', true, true) === true)
expect('staging + platform + no flag → CLOSED', f('staging', true, false) === false)

// ── local dev (off-platform) ──
expect('local unset → OPEN', f(undefined, false, false) === true)
expect('local development → OPEN', f('development', false, false) === true)
expect('local test → OPEN', f('test', false, false) === true)
expect('local explicit preview (non-dev) → CLOSED', f('preview', false, false) === false)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
