export interface EmailDeliveryEnv {
  NODE_ENV?: string
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  EMAIL_REPLY_TO?: string
  WEBAZ_PUBLIC_URL?: string
  PUBLIC_BASE_URL?: string
  RAILWAY_ENVIRONMENT?: string
  RAILWAY_PROJECT_ID?: string
  RAILWAY_SERVICE_ID?: string
}

export interface EmailDeliveryFailure {
  ok: false
  status: number
  error_code: 'EMAIL_DELIVERY_NOT_CONFIGURED' | 'EMAIL_DELIVERY_FAILED'
  error: string
}

export interface EmailDeliverySuccess {
  ok: true
  provider: 'dev_console' | 'resend'
}

export type EmailDeliveryResult = EmailDeliverySuccess | EmailDeliveryFailure
export type IssueCodeResult = ({ ok: true; code: string; expires_at: string; provider: EmailDeliverySuccess['provider'] } | EmailDeliveryFailure)

type FetchLike = (url: string, init: {
  method: 'POST'
  headers: Record<string, string>
  body: string
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

type LoggerLike = Pick<Console, 'log' | 'warn'>

const DEFAULT_FROM = 'WebAZ <noreply@webaz.xyz>'
const DEFAULT_BASE_URL = 'https://webaz.xyz'

export function emailDeliveryNotConfigured(): EmailDeliveryFailure {
  return {
    ok: false,
    status: 503,
    error_code: 'EMAIL_DELIVERY_NOT_CONFIGURED',
    error: '邮箱发送服务未配置，请稍后再试',
  }
}

export function emailDeliveryFailed(): EmailDeliveryFailure {
  return {
    ok: false,
    status: 502,
    error_code: 'EMAIL_DELIVERY_FAILED',
    error: '验证码邮件发送失败，请稍后再试',
  }
}

function isProtectedEmailEnv(env: EmailDeliveryEnv): boolean {
  return env.NODE_ENV === 'production'
    || !!env.RAILWAY_ENVIRONMENT
    || !!env.RAILWAY_PROJECT_ID
    || !!env.RAILWAY_SERVICE_ID
}

export function isVerificationEmailReady(env: EmailDeliveryEnv = process.env): boolean {
  if (!isProtectedEmailEnv(env)) return true
  return !!env.RESEND_API_KEY?.trim()
}

function purposeText(purpose: string): { zh: string; en: string } {
  if (purpose === 'register') return { zh: '注册账户（验证邮箱）', en: 'register your account (verify email)' }
  if (purpose === 'bind_email') return { zh: '绑定邮箱', en: 'bind your email address' }
  if (purpose === 'recover_key') return { zh: '找回密钥', en: 'recover your account key' }
  if (purpose.startsWith('withdraw_confirm')) return { zh: '确认提现', en: 'confirm a withdrawal' }
  return { zh: '验证身份', en: 'verify your identity' }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] || c))
}

export function buildVerificationEmail(input: {
  code: string
  purpose: string
  ttlMin: number
  baseUrl?: string
}): { subject: string; text: string; html: string } {
  const purpose = purposeText(input.purpose)
  const baseUrl = input.baseUrl?.trim() || DEFAULT_BASE_URL
  const subject = 'WebAZ 验证码 / Verification code'
  const text = [
    `WebAZ 验证码: ${input.code}`,
    '',
    `用途: ${purpose.zh}`,
    `有效期: ${input.ttlMin} 分钟`,
    '',
    `Your WebAZ verification code is ${input.code}.`,
    `Use it to ${purpose.en}. It expires in ${input.ttlMin} minutes.`,
    '',
    'If you did not request this code, you can ignore this email.',
    baseUrl,
  ].join('\n')
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111827">',
    '<h2 style="margin:0 0 12px">WebAZ verification code</h2>',
    `<p style="margin:0 0 8px">用途: ${escapeHtml(purpose.zh)} / ${escapeHtml(purpose.en)}</p>`,
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${escapeHtml(input.code)}</p>`,
    `<p style="margin:0 0 8px">有效期 ${input.ttlMin} 分钟 / Expires in ${input.ttlMin} minutes.</p>`,
    '<p style="margin:16px 0 0;color:#6b7280">If you did not request this code, you can ignore this email.</p>',
    `<p style="margin:16px 0 0"><a href="${escapeHtml(baseUrl)}">${escapeHtml(baseUrl)}</a></p>`,
    '</div>',
  ].join('')
  return { subject, text, html }
}

export async function deliverVerificationCode(input: {
  target: string
  code: string
  purpose: string
  ttlMin: number
  env?: EmailDeliveryEnv
  fetchImpl?: FetchLike
  logger?: LoggerLike
}): Promise<EmailDeliveryResult> {
  const env = input.env || process.env
  const logger = input.logger || console
  if (!isProtectedEmailEnv(env)) {
    logger.log(`[verify] ${input.purpose} -> ${input.target}  code=${input.code}  (expires ${input.ttlMin}min)`)
    return { ok: true, provider: 'dev_console' }
  }

  const apiKey = env.RESEND_API_KEY?.trim()
  if (!apiKey) return emailDeliveryNotConfigured()

  const fetchImpl = input.fetchImpl || globalThis.fetch
  if (!fetchImpl) return emailDeliveryNotConfigured()

  const baseUrl = env.WEBAZ_PUBLIC_URL?.trim() || env.PUBLIC_BASE_URL?.trim() || DEFAULT_BASE_URL
  const email = buildVerificationEmail({
    code: input.code,
    purpose: input.purpose,
    ttlMin: input.ttlMin,
    baseUrl,
  })
  const body: Record<string, unknown> = {
    from: env.EMAIL_FROM?.trim() || DEFAULT_FROM,
    to: [input.target],
    subject: email.subject,
    text: email.text,
    html: email.html,
  }
  const replyTo = env.EMAIL_REPLY_TO?.trim()
  if (replyTo) body.reply_to = replyTo

  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      logger.warn(`[verify] resend delivery failed: status=${response.status} purpose=${input.purpose}`)
      return emailDeliveryFailed()
    }
    return { ok: true, provider: 'resend' }
  } catch {
    logger.warn(`[verify] resend delivery failed: network purpose=${input.purpose}`)
    return emailDeliveryFailed()
  }
}
