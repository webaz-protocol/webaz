// 审计加固 — SSRF 守门函数单测
import { isPrivateOrInternalHost } from '../src/pwa/security/ssrf.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }
const block = (url: string) => expect(`拒绝 ${url}`, isPrivateOrInternalHost(url) === true)
const allow = (url: string) => expect(`放行 ${url}`, isPrivateOrInternalHost(url) === false)

// IPv4 私网 / 保留段
block('http://127.0.0.1/')
block('http://127.1.2.3/')
block('http://10.0.0.1/')
block('http://10.255.255.255/')
block('http://192.168.1.1/')
block('http://172.16.0.1/')
block('http://172.31.255.255/')
block('https://169.254.169.254/latest/meta-data/')  // AWS / GCP metadata
block('http://0.0.0.0/')

// localhost 别名
block('http://localhost/')
block('http://foo.localhost/')
block('http://device.local/')

// IPv6 黑名单
block('http://[::1]/')
block('http://[fc00::1]/')
block('http://[fd00::1]/')
block('http://[fe80::1]/')

// 解析失败 → 拒绝
block('not-a-url')
block('http://')
// 'http:///foo' 实际被 WHATWG URL 解析为 host=foo（合法单标签 hostname）— 不在私网，放行
// 公网 DNS 不会解析单标签 → NXDOMAIN，仍然安全；如需 defense-in-depth 可在调用方加单标签拒绝

// 公网 IP / 域名应放行
allow('https://example.com/')
allow('https://item.taobao.com/item.htm?id=123')
allow('https://www.google.com/')
allow('http://8.8.8.8/')
allow('https://172.32.0.1/')  // 不在 172.16-31 范围
allow('https://192.169.1.1/') // 不在 192.168
allow('https://11.0.0.1/')    // 不在 10/8

// scheme 不限 — 这层不管协议，只看 hostname
allow('ftp://example.com/')

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
