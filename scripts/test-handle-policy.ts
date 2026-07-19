import Database from 'better-sqlite3'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { deriveHandleBase, getHandlePolicyIssue, isReservedHandle } from '../src/handle-policy.js'
import { registerProfileIdentityRoutes } from '../src/pwa/routes/profile-identity.js'

let passed = 0
let failed = 0
const ok = (name: string, condition: boolean, details?: unknown): void => {
  if (condition) { passed++; console.log(`✓ ${name}`) }
  else { failed++; console.error(`✗ ${name}`, details === undefined ? '' : JSON.stringify(details)) }
}

const reserved = [
  'webaz', 'web.az', 'web_az', 'webazshop',
  'usr_demo', 'sys.protocol', 'admin_store', 'root',
  'key_secret', 'oat_token', 'gtk_grant', 'grt_123', 'agt_catalog',
  'agent', 'agent_smith', 'mcp', 'oauth.client', 'passkey', 'seller', 'arbitrator',
]
for (const handle of reserved) ok(`reserved: ${handle}`, isReservedHandle(handle))

for (const handle of ['agentic', 'supporter', 'sellerhouse', 'apiary', 'webstore', 'shop_web']) {
  ok(`ordinary handle remains available: ${handle}`, getHandlePolicyIssue(handle) === null)
}
ok('colon is explicitly reserved as a recommendation-anchor delimiter', getHandlePolicyIssue('tina:ha95') === 'HANDLE_DELIMITER_RESERVED')
ok('automatic registration rewrites a WebAZ punctuation lookalike', deriveHandleBase('Web.AZ') === 'u_web.az')
ok('automatic registration rewrites an agent control-plane name', deriveHandleBase('agent_smith') === 'u_agent_smith')

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT, role TEXT, roles TEXT, handle TEXT UNIQUE,
    handle_change_log TEXT, handle_last_created_at TEXT, updated_at TEXT
  );
  INSERT INTO users (id, name, role, roles, handle, handle_change_log)
    VALUES ('usr_tina', 'Tina', 'buyer', '["buyer"]', 'tina', '[]');
`)
setSeamDb(db)

const app = express()
app.use(express.json())
registerProfileIdentityRoutes(app, {
  db,
  generateId: (prefix: string) => `${prefix}_test`,
  auth: (_req: Request, _res: Response) => db.prepare('SELECT * FROM users WHERE id = ?').get('usr_tina') as Record<string, unknown>,
  safeRoles: (user: Record<string, unknown> | undefined | null) => {
    try { return JSON.parse(String(user?.roles || '[]')) as string[] } catch { return [] }
  },
})

const server = app.listen(0)
const port = (server.address() as AddressInfo).port
async function changeHandle(handle: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/profile/change-handle`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

try {
  const colon = await changeHandle('tina:ha95')
  ok('profile route returns a precise colon policy error', colon.body.error_code === 'HANDLE_DELIMITER_RESERVED', colon)

  const lookalike = await changeHandle('web.az')
  ok('profile route rejects WebAZ punctuation lookalike', lookalike.body.error_code === 'HANDLE_RESERVED', lookalike)

  const agent = await changeHandle('agent_smith')
  ok('profile route rejects agent-identity segment', agent.body.error_code === 'HANDLE_RESERVED', agent)

  const ordinary = await changeHandle('agentic')
  ok('profile route preserves an ordinary non-identity word', ordinary.body.success === true && ordinary.body.handle === 'agentic', ordinary)
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
}

console.log(`\n${passed} passed · ${failed} failed`)
if (failed) process.exit(1)
