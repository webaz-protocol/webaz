#!/usr/bin/env tsx
/** RFC-028 S1a schema contract: inert trust registry + hash-only replay claims. */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { initAgentGatewaySchema } from '../src/runtime/webaz-schema-helpers.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`✗ ${name}`) }
}
const throws = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
initAgentGatewaySchema(db)
const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name))
ok('1. verified-client registry exists', tables.has('agent_gateway_clients'))
ok('2. proof-profile registry exists', tables.has('agent_gateway_proof_profiles'))
ok('3. replay-claim store exists', tables.has('agent_gateway_replay_claims'))
ok('4. referenced OAuth parent schema is initialized first', tables.has('oauth_clients'))
ok('5. schema init is idempotent', (() => { try { initAgentGatewaySchema(db); return true } catch { return false } })())

const clientCols = new Set((db.prepare('PRAGMA table_info(agent_gateway_clients)').all() as Array<{ name: string }>).map(c => c.name))
ok('6. foreign-key enforcement is active', db.pragma('foreign_keys', { simple: true }) === 1)
ok('7. trust lifecycle is separate from oauth_clients.verified', clientCols.has('registry_status') && clientCols.has('policy_version'))
db.prepare("INSERT INTO oauth_clients (client_id,name,redirect_uris,verified) VALUES ('oauth_1','Client 1','[]',1)").run()
ok('8. OAuth presentation verification does not create gateway trust', (db.prepare('SELECT COUNT(*) n FROM agent_gateway_clients').get() as { n: number }).n === 0)
ok('9. registry has no credential or secret column', ![...clientCols].some(c => /token|secret|private_key|assertion|nonce/i.test(c)))
ok('10. invalid registry status is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_clients (gateway_client_id,display_name,registry_status,policy_version) VALUES ('agc_bad','bad','active','v1')").run()))
ok('11. unknown OAuth-client binding is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_clients (gateway_client_id,oauth_client_id,display_name,policy_version) VALUES ('agc_orphan','oauth_missing','Orphan','v1')").run()))

db.prepare("INSERT INTO agent_gateway_clients (gateway_client_id,oauth_client_id,display_name,registry_status,policy_version) VALUES ('agc_1','oauth_1','Client 1','unverified','v1')").run()
ok('12. OAuth verified=1 still binds as unverified gateway client', (db.prepare("SELECT registry_status s FROM agent_gateway_clients WHERE gateway_client_id='agc_1'").get() as { s: string }).s === 'unverified')
ok('13. duplicate OAuth-client binding is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_clients (gateway_client_id,oauth_client_id,display_name,policy_version) VALUES ('agc_2','oauth_1','Client 2','v1')").run()))

ok('14. unsupported proof method is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_proof_profiles (profile_id,gateway_client_id,proof_method,proof_config_id) VALUES ('agp_bad','agc_1','user_agent_header','dpop_rfc9449_v1')").run()))
ok('15. orphan proof profile is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_proof_profiles (profile_id,gateway_client_id,proof_method,proof_config_id) VALUES ('agp_orphan','agc_missing','dpop','dpop_rfc9449_v1')").run()))
ok('16. non-canonical key thumbprint is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_proof_profiles (profile_id,gateway_client_id,proof_method,proof_config_id,key_thumbprint) VALUES ('agp_bad_hash','agc_1','dpop','dpop_rfc9449_v1','ABC')").run()))
ok('17. arbitrary JSON/private material cannot occupy proof config id', throws(() => db.prepare("INSERT INTO agent_gateway_proof_profiles (profile_id,gateway_client_id,proof_method,proof_config_id) VALUES ('agp_secret','agc_1','dpop','{\"private_key\":\"x\"}')").run()))
db.prepare("INSERT INTO agent_gateway_proof_profiles (profile_id,gateway_client_id,proof_method,profile_status,proof_config_id,key_thumbprint) VALUES ('agp_1','agc_1','openai_mtls','pending','openai_connectors_mtls_v1',?)").run('b'.repeat(64))
ok('18. schema alone grants no active proof', (db.prepare("SELECT COUNT(*) n FROM agent_gateway_proof_profiles WHERE profile_status='active'").get() as { n: number }).n === 0)

const hashA = 'a'.repeat(64)
const scopeA = '1'.repeat(64)
const scopeB = '2'.repeat(64)
db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_scope_hash,replay_key_hash,gateway_client_id,expires_at) VALUES ('dpop',?,?,'agc_1','2099-01-01T00:00:00.000Z')").run(scopeA, hashA)
ok('19. same proof-kind/scope/key cannot be claimed twice', throws(() => db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_scope_hash,replay_key_hash,expires_at) VALUES ('dpop',?,?,'2099-01-01T00:00:00.000Z')").run(scopeA, hashA)))
ok('20. equal proof key in a different client/issuer scope does not collide', !throws(() => db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_scope_hash,replay_key_hash,expires_at) VALUES ('dpop',?,?,'2099-01-01T00:00:00.000Z')").run(scopeB, hashA)))
ok('21. proof-kind namespaces do not collide', !throws(() => db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_scope_hash,replay_key_hash,expires_at) VALUES ('private_key_jwt',?,?,'2099-01-01T00:00:00.000Z')").run(scopeA, hashA)))
ok('22. missing replay scope is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_key_hash,expires_at) VALUES ('dpop',?,'2099-01-01T00:00:00.000Z')").run(hashA)))
ok('23. raw/non-hash replay key is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_scope_hash,replay_key_hash,expires_at) VALUES ('dpop',?,'raw-jti','2099-01-01T00:00:00.000Z')").run(scopeA)))
ok('24. orphan replay-client reference is rejected', throws(() => db.prepare("INSERT INTO agent_gateway_replay_claims (proof_kind,replay_scope_hash,replay_key_hash,gateway_client_id,expires_at) VALUES ('server_nonce',?,?,'agc_missing','2099-01-01T00:00:00.000Z')").run(scopeA, 'c'.repeat(64))))

const replayCols = new Set((db.prepare('PRAGMA table_info(agent_gateway_replay_claims)').all() as Array<{ name: string }>).map(c => c.name))
ok('25. replay table requires scope+key hashes, never raw jti/nonce/assertion', replayCols.has('replay_scope_hash') && replayCols.has('replay_key_hash') && ![...replayCols].some(c => /(^|_)jti$|nonce|assertion/i.test(c)))
const fixtureCountsBeforeReinit = ['agent_gateway_clients', 'agent_gateway_proof_profiles', 'agent_gateway_replay_claims']
  .map(table => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n)
initAgentGatewaySchema(db)
const fixtureCountsAfterReinit = ['agent_gateway_clients', 'agent_gateway_proof_profiles', 'agent_gateway_replay_claims']
  .map(table => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n)
ok('26. repeated schema init creates no rows or business state', fixtureCountsBeforeReinit.every((n, i) => n === fixtureCountsAfterReinit[i]))

const server = readFileSync('src/pwa/server.ts', 'utf8')
ok('27. PWA fresh boot initializes gateway schema before listen',
  server.includes('initAgentGatewaySchema(db)')
    && server.indexOf('initAgentGatewaySchema(db)') < server.indexOf('app.listen('))
ok('28. S1a mounts no gateway middleware or commerce route', !server.includes('mountAgentGateway('))

const pg = readFileSync('db/schema.pg.sql', 'utf8')
ok('29. generated PG creates OAuth parent before gateway FK tables',
  pg.indexOf('CREATE TABLE IF NOT EXISTS oauth_clients') < pg.indexOf('CREATE TABLE IF NOT EXISTS agent_gateway_clients')
    && pg.indexOf('CREATE TABLE IF NOT EXISTS agent_gateway_clients') < pg.indexOf('CREATE TABLE IF NOT EXISTS agent_gateway_proof_profiles')
    && pg.indexOf('CREATE TABLE IF NOT EXISTS agent_gateway_clients') < pg.indexOf('CREATE TABLE IF NOT EXISTS agent_gateway_replay_claims'))
db.close()

if (fail) {
  console.error(`❌ agent gateway S1a schema: ${pass} pass / ${fail} fail\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`✅ agent gateway S1a schema: ${pass} pass`)
