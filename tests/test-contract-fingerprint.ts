// RFC-011 §④ 契约指纹守卫 —— 防 CHANGELOG-rot 的失败模式。
// 若 ②能力矩阵 / ①实体字典 的契约内容变了但 CONTRACT_VERSION 没 bump + 基线没更 → 本测 FAIL,
// 逼"bump CONTRACT_VERSION + 写 CONTRACT_CHANGES 条目 + 重生成 docs/CONTRACT-LOCK.json"。静默改契约不可 merge。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { contractFingerprints, CONTRACT_CHANGES, buildChangeFeed } from '../src/pwa/contract-fingerprint.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const __dir = dirname(fileURLToPath(import.meta.url))
const lock = JSON.parse(readFileSync(join(__dir, '..', 'docs', 'CONTRACT-LOCK.json'), 'utf-8'))
const fp = contractFingerprints()

// ── 核心守卫:现指纹 == committed 基线 ──
expect('contract_version 与基线一致', fp.contract_version === lock.contract_version, { now: fp.contract_version, lock: lock.contract_version })
expect('② capability 指纹未漂移(否则 bump+更基线)', fp.capability === lock.capability, { now: fp.capability, lock: lock.capability })
expect('① entity 指纹未漂移(否则 bump+更基线)', fp.entity === lock.entity, { now: fp.entity, lock: lock.entity })
expect('combined 指纹未漂移', fp.combined === lock.combined)

// ── CONTRACT_CHANGES 自洽 ──
expect('有 genesis 条目', CONTRACT_CHANGES.some(c => c.kind === 'genesis' && c.contract_version === 1))
expect('所有变更 contract_version ≤ 当前', CONTRACT_CHANGES.every(c => c.contract_version <= fp.contract_version), CONTRACT_CHANGES.map(c => c.contract_version))
expect('变更按 contract_version 单调不减', CONTRACT_CHANGES.every((c, i) => i === 0 || c.contract_version >= CONTRACT_CHANGES[i - 1].contract_version))

// ── feed 自洽 ──
const feed = buildChangeFeed()
expect('feed 带 current_contract_version + fingerprints', feed.current_contract_version === fp.contract_version && feed.fingerprints.combined === fp.combined)
expect('feed 有 deprecation_policy + deprecations 数组', typeof feed.deprecation_policy === 'string' && Array.isArray(feed.deprecations))
expect('feed.changes 即注册表', feed.changes.length === CONTRACT_CHANGES.length)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) { console.log('\n⚠️ 若你确实改了契约面:bump src/version.ts CONTRACT_VERSION + 加 CONTRACT_CHANGES 条目 + 重生成 docs/CONTRACT-LOCK.json'); process.exit(1) }
