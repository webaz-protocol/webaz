// 审计修复 S — DNS rebinding 拦截（socket 层 IP 校验）
import { ssrfLookup, isIpPrivate, safeFetch } from '../src/pwa/security/ssrf.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ─── isIpPrivate 直接 IP 判定 ────────────────────────────────
expect('isIpPrivate 127.0.0.1 = true', isIpPrivate('127.0.0.1') === true)
expect('isIpPrivate 10.0.0.1 = true', isIpPrivate('10.0.0.1') === true)
expect('isIpPrivate 169.254.169.254 = true (AWS metadata)', isIpPrivate('169.254.169.254') === true)
expect('isIpPrivate 192.168.1.1 = true', isIpPrivate('192.168.1.1') === true)
expect('isIpPrivate 172.20.0.1 = true', isIpPrivate('172.20.0.1') === true)
expect('isIpPrivate 172.32.0.1 = false (172.32 不在 16-31)', isIpPrivate('172.32.0.1') === false)
expect('isIpPrivate 8.8.8.8 = false (公网)', isIpPrivate('8.8.8.8') === false)
expect('isIpPrivate ::1 = true (IPv6 loopback)', isIpPrivate('::1') === true)
expect('isIpPrivate fc00::1 = true (ULA)', isIpPrivate('fc00::1') === true)
expect('isIpPrivate fe80::1 = true (link-local)', isIpPrivate('fe80::1') === true)
expect('isIpPrivate 2606:4700::1 = false (公网 IPv6)', isIpPrivate('2606:4700::1') === false)

// ─── ssrfLookup — 直接传 hostname，会真的查 DNS ───────────────
// 测试用 localhost 必返回 127.0.0.1 → 应被拦截
await new Promise<void>((resolve) => {
  ssrfLookup('localhost', {}, (err) => {
    expect('ssrfLookup("localhost") → ssrf_resolved_to_private_ip', !!err && err.message === 'ssrf_resolved_to_private_ip')
    resolve()
  })
})

// 8.8.8.8 直接 hostname 实际是 IP → DNS 返回自己 → 公网 → 放行
await new Promise<void>((resolve) => {
  ssrfLookup('8.8.8.8', {}, (err, address) => {
    expect('ssrfLookup("8.8.8.8") 公网 IP → 放行', !err && address === '8.8.8.8')
    resolve()
  })
})

// ─── DNS rebinding 真实测试 — 用 nip.io（公网 hostname → 解析到内含 IP）─────
// 这是 DNS rebinding 攻击的真实形态：domain 公网可注册 + DNS 返回私网 IP
// nip.io 是公共服务，将 a-b-c-d.nip.io 解析到 a.b.c.d
// 测试需要网络；离线时降级到 localhost 验证（同代码路径）
const tryRebindHost = async (host: string, expectedIp: string, label: string) => {
  await new Promise<void>((resolve) => {
    ssrfLookup(host, {}, (err) => {
      // 网络可达 + DNS rebinding 模式成立 → 应该拦截
      if (err && err.message === 'ssrf_resolved_to_private_ip') {
        pass++; console.log('✓', label)
      } else if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) {
        // 离线环境：跳过此测试，标记为 N/A
        console.log('⚠', label, '(skipped — offline / DNS unavailable)')
      } else {
        fail++; console.log('✗', label, JSON.stringify({ err: err?.message, code: err?.code }))
      }
      resolve()
    })
  })
}
await tryRebindHost('127-0-0-1.nip.io', '127.0.0.1', 'DNS rebinding 公网域名→127.0.0.1 → 拦截')
await tryRebindHost('169-254-169-254.nip.io', '169.254.169.254', 'DNS rebinding 公网域名→AWS metadata → 拦截')
await tryRebindHost('10-0-0-1.nip.io', '10.0.0.1', 'DNS rebinding 公网域名→10/8 → 拦截')

// ─── safeFetch hostname 层 + socket 层组合防御 ─────────────────
// 1) hostname 显式私网 → 第①层 hostname check 挡掉（早于 DNS）
let e1 = ''
try { await safeFetch('http://127.0.0.1/') } catch (e) { e1 = (e as Error).message }
expect('safeFetch 显式私网 hostname → ssrf_blocked (第①层)', e1 === 'ssrf_blocked')

// 2) 显式公网 IP 但属于黑名单段 → 也挡（hostname=IP 的情况走 isIpPrivate）
let e2 = ''
try { await safeFetch('http://169.254.169.254/') } catch (e) { e2 = (e as Error).message }
expect('safeFetch 显式 metadata IP → ssrf_blocked', e2 === 'ssrf_blocked')

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
