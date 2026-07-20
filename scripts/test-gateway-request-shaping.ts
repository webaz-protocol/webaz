#!/usr/bin/env tsx
/**
 * RFC-028 S2b-2a: pure request-shaping tests — IPv6→/64 cardinality normalization, annotation-derived
 * cost-class classification, and GatewayLimitInput assembly (incl. the per-class global dimension).
 *
 * Usage: npm run test:gateway-request-shaping
 */
const { normalizeIpDimension, classifyMcpCostClass, buildMcpLimitInput } =
  await import('../src/runtime/gateway-request-shaping.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

try {
  // 1. IPv4 kept whole
  ok('1a plain IPv4 kept', normalizeIpDimension('203.0.113.7') === '203.0.113.7')
  ok('1b invalid IPv4 octet → empty (skip dim)', normalizeIpDimension('999.1.1.1') === '')

  // 2. IPv6 collapses to /64 — different suffixes in the SAME /64 share ONE key
  const a = normalizeIpDimension('2001:db8:abcd:1234::1')
  const b = normalizeIpDimension('2001:db8:abcd:1234:ffff:ffff:ffff:ffff')
  ok('2a same /64, different host bits → identical key', a === b && a === '2001:db8:abcd:1234::/64')
  const c = normalizeIpDimension('2001:db8:abcd:9999::1')
  ok('2b different /64 → different key', c !== a && c === '2001:db8:abcd:9999::/64')

  // 3. IPv6 compression + canonicalization
  ok('3a loopback ::1 collapses to zero /64', normalizeIpDimension('::1') === '0:0:0:0::/64')
  ok('3b fe80::1 /64', normalizeIpDimension('fe80::1') === 'fe80:0:0:0::/64')
  ok('3c leading zeros canonicalized', normalizeIpDimension('2001:0db8:0000:0001::5') === '2001:db8:0:1::/64')
  ok('3d uppercase normalized to lowercase', normalizeIpDimension('2001:DB8:ABCD:1234::1') === '2001:db8:abcd:1234::/64')

  // 4. IPv4-mapped / embedded IPv6 → keyed by the embedded IPv4
  ok('4a ::ffff:1.2.3.4 → IPv4', normalizeIpDimension('::ffff:192.168.0.1') === '192.168.0.1')
  ok('4b malformed embedded IPv4 → empty', normalizeIpDimension('::ffff:1.2.3.999') === '')

  // 5. garbage / edge → empty (fail-safe: never key on junk)
  ok('5a empty → empty', normalizeIpDimension('') === '')
  ok('5b non-ip string → empty', normalizeIpDimension('not-an-ip') === '')
  ok('5c two "::" is invalid → empty', normalizeIpDimension('2001::db8::1') === '')
  ok('5d over-length → empty', normalizeIpDimension('a'.repeat(60)) === '')
  ok('5e too-few groups without :: → empty', normalizeIpDimension('2001:db8:1:2:3') === '')

  // 6. cost-class classification from method + annotation
  ok('6a initialize → public_low', classifyMcpCostClass('initialize', undefined) === 'public_low')
  ok('6b tools/list → public_low', classifyMcpCostClass('tools/list', undefined) === 'public_low')
  ok('6c unmapped tool call → high (fail-safe strict)', classifyMcpCostClass('tools/call', undefined) === 'high')
  ok('6d read tool → private_read', classifyMcpCostClass('tools/call', { readOnlyHint: true, destructiveHint: false }) === 'private_read')
  ok('6e additive write → high', classifyMcpCostClass('tools/call', { readOnlyHint: false, destructiveHint: false }) === 'high')
  ok('6f destructive/fund → economic', classifyMcpCostClass('tools/call', { readOnlyHint: false, destructiveHint: true }) === 'economic')

  // 7. buildMcpLimitInput — dims assembled, global always set to the class, ip normalized, absent dims omitted
  {
    const inp = buildMcpLimitInput({ method: 'tools/call', toolName: 'webaz_search', annotation: { readOnlyHint: true, destructiveHint: false }, ip: '2001:db8:1:2::9', clientId: 'agc_1', subject: 'usr_9' })
    ok('7a class derived (read → private_read)', inp.cost_class === 'private_read')
    ok('7b global dim set to class', inp.dims.global === 'private_read')
    ok('7c ip normalized to /64', inp.dims.ip === '2001:db8:1:2::/64')
    ok('7d client + subject carried', inp.dims.client === 'agc_1' && inp.dims.subject === 'usr_9')
  }
  {
    const anon = buildMcpLimitInput({ method: 'tools/list', ip: '198.51.100.4' })
    ok('7e anonymous: no client/subject dims, ip present, class public_low', anon.cost_class === 'public_low'
      && anon.dims.ip === '198.51.100.4' && anon.dims.client === undefined && anon.dims.subject === undefined && anon.dims.global === 'public_low')
  }
  {
    const junkIp = buildMcpLimitInput({ method: 'initialize', ip: 'garbage' })
    ok('7f unparseable ip → ip dim omitted (only global remains)', junkIp.dims.ip === undefined && junkIp.dims.global === 'public_low')
  }

  if (fail > 0) { console.error(`\n❌ gateway-request-shaping FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ gateway-request-shaping (S2b-2a): IPv6→/64 cardinality bound · annotation-derived cost class · input assembly with per-class global dim\n  ✅ pass ${pass}`)
} catch (e) {
  console.error('❌ test error:', (e as Error).message); process.exit(1)
}
