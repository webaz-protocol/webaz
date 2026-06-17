// SSRF 防护：hostname 黑名单 + safeFetch redirect 守门 + undici Agent socket 层 IP 校验
// 三层防御：
//   ① isPrivateOrInternalHost — hostname 文本检查（快路径，挡显式 IP / localhost / .local）
//   ② safeFetch — redirect: 'manual' + 每跳重验，挡 302→私网 跳板
//   ③ ssrfAgent (undici) — DNS 解析后的 IP 校验，挡 DNS rebinding（attacker.com TTL=0 解析到 169.254）
import * as dns from 'dns'
import { Agent } from 'undici'

// IP 黑名单 — 解析后的 IP 直接判
export function isIpPrivate(ip: string): boolean {
  const h = ip.toLowerCase()
  // IPv4 私网 / 保留段
  const m4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m4) {
    const [a, b] = m4.slice(1).map(Number)
    if (a === 127) return true            // loopback
    if (a === 10) return true             // 10/8
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16-31/12
    if (a === 169 && b === 254) return true // link-local (AWS / GCP metadata)
    if (a === 0) return true              // 0.0.0.0/8
  }
  // IPv6 简单黑名单
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

// hostname 文本检查（不做 DNS 解析）
export function isPrivateOrInternalHost(url: string): boolean {
  try {
    const u = new URL(url)
    let h = u.hostname.toLowerCase()
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
    if (!h) return true
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
    return isIpPrivate(h)
  } catch { return true }
}

// 自定义 DNS lookup — 解析后立即校验 IP，私网就抛错
// 由 undici Agent 在 socket 建立前调用 → 拦截 DNS rebinding 的最深一层
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void
export function ssrfLookup(hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback): void {
  const opts: dns.LookupOptions = typeof options === 'function' ? {} : (options || {})
  const cb: LookupCallback = typeof options === 'function' ? options : (callback as LookupCallback)
  dns.lookup(hostname, opts, (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => {
    if (err) return cb(err)
    if (Array.isArray(address)) {
      // options.all === true → 多 IP 数组
      const safe = address.filter(a => !isIpPrivate(a.address))
      if (safe.length === 0) {
        const e = new Error('ssrf_resolved_to_private_ip') as NodeJS.ErrnoException
        e.code = 'ENOTFOUND'
        return cb(e)
      }
      return cb(null, safe, family)
    }
    if (isIpPrivate(String(address))) {
      const e = new Error('ssrf_resolved_to_private_ip') as NodeJS.ErrnoException
      e.code = 'ENOTFOUND'
      return cb(e)
    }
    cb(null, address, family)
  })
}

// 单例 Agent — 注入 ssrfLookup 拦截 DNS 解析层
export const ssrfAgent = new Agent({
  connect: {
    lookup: ssrfLookup as never,
  },
})

// SSRF-safe redirect-following fetch.
// 三层防御组合：safeFetch (hostname check + per-hop) + ssrfAgent (DNS rebinding 拦截)
// 抛出 ssrf_blocked / ssrf_bad_scheme / ssrf_bad_redirect / ssrf_too_many_redirects /
// ssrf_resolved_to_private_ip (DNS 层) 中之一时表示拦截
export async function safeFetch(initialUrl: string, init: RequestInit = {}, maxHops = 5): Promise<Response> {
  let url = initialUrl
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!/^https?:\/\//i.test(url)) throw new Error('ssrf_bad_scheme')
    if (isPrivateOrInternalHost(url)) throw new Error('ssrf_blocked')
    // dispatcher 选项是 undici 扩展，标准 RequestInit 不含
    const resp = await fetch(url, { ...init, redirect: 'manual', dispatcher: ssrfAgent } as RequestInit & { dispatcher: unknown })
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) return resp
      let next: string
      try { next = new URL(loc, url).href } catch { throw new Error('ssrf_bad_redirect') }
      url = next
      continue
    }
    return resp
  }
  throw new Error('ssrf_too_many_redirects')
}
