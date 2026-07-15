#!/usr/bin/env tsx
/**
 * Email verification delivery contract:
 * - dev keeps local console/dev_code behavior and never calls Resend
 * - production fails closed when RESEND_API_KEY is missing
 * - production sends verification codes through Resend with the configured sender
 * - secrets are never copied into the email body or error payload
 * - recover-key checks delivery readiness before account lookup, preserving the no-enumeration boundary
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  buildVerificationEmail,
  deliverVerificationCode,
  emailDeliveryNotConfigured,
  isVerificationEmailReady,
} from '../src/pwa/email-delivery.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++
  else { fail++; fails.push(`x ${name}${detail ? `\n    ${detail}` : ''}`) }
}

type FetchCall = { url: string; init: { method: string; headers: Record<string, string>; body: string }; body: Record<string, unknown> }

function logger() {
  const logs: string[] = []
  const warns: string[] = []
  return {
    logs,
    warns,
    log: (s: string) => logs.push(s),
    warn: (s: string) => warns.push(s),
  }
}

async function main(): Promise<void> {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(ROOT, 'src', 'pwa', 'server.ts'), 'utf8')
  const profile = readFileSync(join(ROOT, 'src', 'pwa', 'routes', 'profile-credentials.ts'), 'utf8')
  const recover = readFileSync(join(ROOT, 'src', 'pwa', 'routes', 'recover-key.ts'), 'utf8')

  // readiness truth table
  ok('dev is ready without RESEND_API_KEY', isVerificationEmailReady({ NODE_ENV: 'development' }) === true)
  ok('unset NODE_ENV is treated as local/dev for tests', isVerificationEmailReady({}) === true)
  ok('production requires RESEND_API_KEY', isVerificationEmailReady({ NODE_ENV: 'production' }) === false)
  ok('production with RESEND_API_KEY is ready', isVerificationEmailReady({ NODE_ENV: 'production', RESEND_API_KEY: 're_x' }) === true)
  ok('Railway deploy env requires RESEND_API_KEY even when NODE_ENV is unset', isVerificationEmailReady({ RAILWAY_ENVIRONMENT: 'production' }) === false)
  ok('Railway deploy env with RESEND_API_KEY is ready', isVerificationEmailReady({ RAILWAY_SERVICE_ID: 'svc', RESEND_API_KEY: 're_x' }) === true)

  // dev delivery: no fetch, code appears only in local log
  {
    const l = logger()
    let fetchCalled = false
    const res = await deliverVerificationCode({
      target: 'dev@example.com',
      code: '123456',
      purpose: 'bind_email',
      ttlMin: 10,
      env: { NODE_ENV: 'development' },
      logger: l,
      fetchImpl: async () => { fetchCalled = true; throw new Error('unexpected') },
    })
    ok('dev delivery succeeds through console provider', res.ok && res.provider === 'dev_console')
    ok('dev delivery never calls fetch/Resend', fetchCalled === false)
    ok('dev log includes the code for local testing', l.logs.join('\n').includes('123456'))
  }

  // production missing key: fail closed, no fetch, no code leak in response
  {
    const l = logger()
    let fetchCalled = false
    const res = await deliverVerificationCode({
      target: 'prod@example.com',
      code: '234567',
      purpose: 'bind_email',
      ttlMin: 10,
      env: { NODE_ENV: 'production' },
      logger: l,
      fetchImpl: async () => { fetchCalled = true; throw new Error('unexpected') },
    })
    ok('prod missing key returns EMAIL_DELIVERY_NOT_CONFIGURED', !res.ok && res.error_code === 'EMAIL_DELIVERY_NOT_CONFIGURED')
    ok('prod missing key uses 503', !res.ok && res.status === 503)
    ok('prod missing key does not call fetch', fetchCalled === false)
    ok('prod missing key response does not contain verification code', !JSON.stringify(res).includes('234567'))
    ok('emailDeliveryNotConfigured helper matches route-facing failure', emailDeliveryNotConfigured().error_code === 'EMAIL_DELIVERY_NOT_CONFIGURED')
    ok('prod missing key does not log the verification code', !l.logs.concat(l.warns).join('\n').includes('234567'))
  }

  // Railway without NODE_ENV still counts as protected/prod: never console-log OTPs there.
  {
    const l = logger()
    let fetchCalled = false
    const res = await deliverVerificationCode({
      target: 'prod@example.com',
      code: '999999',
      purpose: 'bind_email',
      ttlMin: 10,
      env: { RAILWAY_ENVIRONMENT: 'production' },
      logger: l,
      fetchImpl: async () => { fetchCalled = true; throw new Error('unexpected') },
    })
    ok('Railway env missing key returns EMAIL_DELIVERY_NOT_CONFIGURED', !res.ok && res.error_code === 'EMAIL_DELIVERY_NOT_CONFIGURED')
    ok('Railway env missing key does not call fetch', fetchCalled === false)
    ok('Railway env missing key does not log the verification code', !l.logs.concat(l.warns).join('\n').includes('999999'))
  }

  // production happy path: Resend request shape
  {
    const calls: FetchCall[] = []
    const l = logger()
    const res = await deliverVerificationCode({
      target: 'person@example.com',
      code: '345678',
      purpose: 'recover_key',
      ttlMin: 10,
      env: {
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_SECRET_SHOULD_ONLY_BE_IN_AUTH_HEADER',
        EMAIL_FROM: 'WebAZ <noreply@webaz.xyz>',
        EMAIL_REPLY_TO: 'contact@webaz.xyz',
        WEBAZ_PUBLIC_URL: 'https://webaz.xyz',
      },
      logger: l,
      fetchImpl: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> })
        return { ok: true, status: 200, text: async () => '{"id":"email_1"}' }
      },
    })
    ok('prod resend delivery succeeds', res.ok && res.provider === 'resend')
    ok('prod sends exactly one Resend request', calls.length === 1)
    ok('Resend endpoint is correct', calls[0]?.url === 'https://api.resend.com/emails')
    ok('Resend request method is POST', calls[0]?.init.method === 'POST')
    ok('Resend auth header carries the API key', calls[0]?.init.headers.Authorization === 'Bearer re_SECRET_SHOULD_ONLY_BE_IN_AUTH_HEADER')
    ok('Resend request uses JSON', calls[0]?.init.headers['Content-Type'] === 'application/json')
    ok('Resend body from address is configured noreply', calls[0]?.body.from === 'WebAZ <noreply@webaz.xyz>')
    ok('Resend body routes to target email', JSON.stringify(calls[0]?.body.to) === '["person@example.com"]')
    ok('Resend body carries reply_to when configured', calls[0]?.body.reply_to === 'contact@webaz.xyz')
    ok('Resend body contains the verification code', calls[0]?.init.body.includes('345678'))
    ok('Resend body contains public URL', calls[0]?.init.body.includes('https://webaz.xyz'))
    ok('Resend body does not contain the API key', !calls[0]?.init.body.includes('re_SECRET_SHOULD_ONLY_BE_IN_AUTH_HEADER'))
    ok('prod success does not log the verification code', !l.logs.concat(l.warns).join('\n').includes('345678'))
  }

  // provider failure: generic failure, no provider body/code/secret leak
  {
    const l = logger()
    const res = await deliverVerificationCode({
      target: 'person@example.com',
      code: '456789',
      purpose: 'recover_key',
      ttlMin: 10,
      env: { NODE_ENV: 'production', RESEND_API_KEY: 're_SECRET' },
      logger: l,
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'provider body with 456789 re_SECRET' }),
    })
    ok('Resend non-2xx maps to EMAIL_DELIVERY_FAILED', !res.ok && res.error_code === 'EMAIL_DELIVERY_FAILED')
    ok('Resend non-2xx uses 502', !res.ok && res.status === 502)
    ok('provider failure response does not leak provider body/code/secret', !JSON.stringify(res).includes('456789') && !JSON.stringify(res).includes('re_SECRET'))
    ok('provider failure warning does not log code/secret/target', !l.warns.join('\n').includes('456789') && !l.warns.join('\n').includes('re_SECRET') && !l.warns.join('\n').includes('person@example.com'))
  }

  // template sanity
  {
    const email = buildVerificationEmail({ code: '567890', purpose: 'bind_email', ttlMin: 10, baseUrl: 'https://webaz.xyz' })
    ok('email subject identifies WebAZ verification code', /WebAZ/.test(email.subject) && /Verification code/i.test(email.subject))
    ok('email text includes bilingual expiry', email.text.includes('10 分钟') && /expires in 10 minutes/i.test(email.text))
    ok('email html escapes attacker-controlled base URL', buildVerificationEmail({ code: '111111', purpose: '<x>', ttlMin: 10, baseUrl: 'https://webaz.xyz/?a=<script>' }).html.includes('&lt;script&gt;'))
    // referral code (registration): present + clearly distinguished from the verification code
    {
      const reg = buildVerificationEmail({ code: '246810', purpose: 'register', ttlMin: 10, baseUrl: 'https://webaz.xyz', referralCode: 'NFTH2E' })
      ok('register email contains BOTH the verification code and the referral code', reg.text.includes('246810') && reg.text.includes('NFTH2E') && reg.html.includes('246810') && reg.html.includes('NFTH2E'))
      ok('register email labels the referral code distinctly (推荐码 / Referral code)', reg.text.includes('推荐码') && /Referral code/i.test(reg.text) && reg.html.includes('Referral code'))
      ok('register email explicitly says referral ≠ verification code', /NOT the (email )?verification code/i.test(reg.text) && /不是.*验证码/.test(reg.text))
      ok('referral code html-escaped', buildVerificationEmail({ code: '1', purpose: 'register', ttlMin: 10, referralCode: '<b>x' }).html.includes('&lt;b&gt;x'))
    }
    // referral code must NOT leak into non-register emails, nor when unset
    {
      const wd = buildVerificationEmail({ code: '999999', purpose: 'withdraw_confirm', ttlMin: 10, referralCode: 'NFTH2E' })
      ok('non-register purpose: referral code NOT injected even if passed', !wd.text.includes('NFTH2E') && !wd.html.includes('NFTH2E'))
      const noRef = buildVerificationEmail({ code: '888888', purpose: 'register', ttlMin: 10 })
      ok('register with no referral configured → no referral block', !/推荐码|Referral code/.test(noRef.text) && !/Referral code/.test(noRef.html))
    }
  }

  // server/route wiring guards
  ok('server imports email delivery helper', /from '\.\/email-delivery\.js'/.test(server))
  ok('issueCode is async and returns IssueCodeResult', /async function issueCode\([\s\S]*Promise<IssueCodeResult>/.test(server))
  ok('issueCode checks email delivery readiness before inserting a code', /if \(channel === 'email' && !isVerificationEmailReady\(\)\) return emailDeliveryNotConfigured\(\)[\s\S]{0,240}INSERT INTO verification_codes/.test(server))
  ok('issueCode invalidates stored code if delivery fails after insert', /UPDATE verification_codes SET used_at = datetime\('now'\) WHERE id = \?/.test(server))
  ok('issueCode returns the delivery provider with successful codes', /return \{ ok: true, code, expires_at: expiresAt, provider: delivered\.provider \}/.test(server))
  ok('profile bind-email awaits issueCode and maps delivery failure to typed JSON', /const issued = await issueCode/.test(profile) && /error_code: issued\.error_code/.test(profile))
  ok('profile bind-email dev_code is gated by delivery provider, not NODE_ENV/IS_DEV', /issued\.provider === 'dev_console' \? \{ dev_code: issued\.code \}/.test(profile) && !/\bIS_DEV\b/.test(profile))

  const recoverStart = recover.slice(recover.indexOf("app.post('/api/recover-key/start'"), recover.indexOf("app.post('/api/recover-key/confirm'"))
  ok('recover-key has delivery readiness dependency', /canDeliverCodes/.test(recover) && /emailDeliveryNotConfigured/.test(recover))
  ok('recover-key checks delivery readiness before account lookup', recoverStart.indexOf('if (!canDeliverCodes())') > 0 && recoverStart.indexOf('if (!canDeliverCodes())') < recoverStart.indexOf('SELECT id, name, email FROM users'))
  ok('recover-key awaits issueCode for found users', /const issued = await issueCode\(user\.id, 'email', target, 'recover_key'\)/.test(recoverStart))
  ok('recover-key runtime delivery failure preserves no-enumeration response', /return void res\.json\(genericResponse\)/.test(recoverStart) && !/res\.status\(issued\.status\)/.test(recoverStart))

  if (fail === 0) {
    console.log(`\n✅ email delivery: dev console path; production Resend path; missing config fail-closed; no code/key leakage in prod errors/logs; recover-key readiness before lookup\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ email delivery FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
