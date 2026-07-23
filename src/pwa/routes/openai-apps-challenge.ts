import type { Application, Request, Response } from 'express'

const MAX_CHALLENGE_LENGTH = 2048

/**
 * OpenAI supplies this opaque value during domain verification. Keep it outside
 * source control and reject malformed environment values rather than silently
 * trimming them into a different challenge.
 */
export function readOpenAiAppsChallengeToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env.OPENAI_APPS_CHALLENGE_TOKEN
  if (!token || token !== token.trim() || token.length > MAX_CHALLENGE_LENGTH) return null
  // Portal challenges are opaque visible-ASCII tokens. Reject all whitespace,
  // controls, Unicode separators, and invisible format characters fail-closed.
  if (!/^[\x21-\x7e]+$/.test(token)) return null
  return token
}

export function registerOpenAiAppsChallengeRoute(app: Application): void {
  app.get('/.well-known/openai-apps-challenge', (_req: Request, res: Response) => {
    const token = readOpenAiAppsChallengeToken()
    res.setHeader('Cache-Control', 'no-store')
    if (!token) return void res.status(404).type('text/plain').send('not configured')
    res.status(200).type('text/plain').send(token)
  })
}
