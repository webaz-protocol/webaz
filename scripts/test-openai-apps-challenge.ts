import express from 'express'
import type { Server as HttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readOpenAiAppsChallengeToken, registerOpenAiAppsChallengeRoute } from '../src/pwa/routes/openai-apps-challenge.js'

let pass = 0
let fail = 0
const problems: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) { pass++; return }
  fail++; problems.push(name)
}

ok('missing configuration is dormant', readOpenAiAppsChallengeToken({}) === null)
ok('empty configuration is dormant', readOpenAiAppsChallengeToken({ OPENAI_APPS_CHALLENGE_TOKEN: '' }) === null)
ok('surrounding whitespace is rejected, never trimmed', readOpenAiAppsChallengeToken({ OPENAI_APPS_CHALLENGE_TOKEN: ' token ' }) === null)
ok('control characters are rejected', readOpenAiAppsChallengeToken({ OPENAI_APPS_CHALLENGE_TOKEN: 'token\n' }) === null)
ok('Unicode line and paragraph separators are rejected', ['token\u0085x', 'token\u2028x', 'token\u2029x'].every(token => readOpenAiAppsChallengeToken({ OPENAI_APPS_CHALLENGE_TOKEN: token }) === null))
ok('opaque token is returned byte-for-byte', readOpenAiAppsChallengeToken({ OPENAI_APPS_CHALLENGE_TOKEN: 'oa_challenge.ABC-123_xyz' }) === 'oa_challenge.ABC-123_xyz')
const publicUtilsSource = readFileSync(resolve(import.meta.dirname, '../src/pwa/routes/public-utils.ts'), 'utf8')
ok('production public-utils registrar wires the challenge route',
  /registerOpenAiAppsChallengeRoute\(app\)/.test(publicUtilsSource))

async function realHttpContract(): Promise<void> {
  const app = express()
  registerOpenAiAppsChallengeRoute(app)
  const http = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(0, () => resolve(server))
    server.once('error', reject)
  })
  try {
    const address = http.address()
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN
    const dormant = await fetch(`${base}/.well-known/openai-apps-challenge`)
    ok('production route is registered and dormant as plain no-store 404',
      dormant.status === 404
        && (dormant.headers.get('content-type') || '').startsWith('text/plain')
        && dormant.headers.get('cache-control') === 'no-store'
        && await dormant.text() === 'not configured')

    process.env.OPENAI_APPS_CHALLENGE_TOKEN = 'portal-token-987'
    const active = await fetch(`${base}/.well-known/openai-apps-challenge`)
    ok('production route returns the exact token bytes with plain no-store 200',
      active.status === 200
        && (active.headers.get('content-type') || '').startsWith('text/plain')
        && active.headers.get('cache-control') === 'no-store'
        && await active.text() === 'portal-token-987')
  } finally {
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN
    http.close()
  }
}

try {
  await realHttpContract()
} catch (error) {
  const e = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }
  const code = e.code ?? e.cause?.code
  if (code === 'EPERM' && process.env.CI !== 'true') {
    console.log('openai-apps-challenge: real HTTP assertions skipped only because local sandbox forbids listen; CI must run them')
  } else {
    throw error
  }
}

if (fail) {
  console.error(`openai-apps-challenge FAILED (${pass} pass, ${fail} fail)\n${problems.map(p => `- ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`openai-apps-challenge passed (${pass} assertions)`)
