/**
 * PWA 静态资源缓存策略(单一真源)。
 *
 * 代码文件(所有 .js:app.js + 89 个 app-*.js 拆包 + sw.js/i18n.js)与壳文件(index.html / manifest.json)
 * 文件名【无内容 hash】,URL 跨部署不变 → 必须 no-cache 强制重验,否则 CF/浏览器按默认(~4h)缓存,
 * 部署后老客户端继续跑旧 app-*.js 直到硬刷新(审批页崩溃即此类)。图标/字体等非代码资产走 CF 默认。
 *
 * 历史 bug:此前只对 5 个硬编码文件名 no-cache,漏掉了全部 app-*.js 拆包。此 helper 覆盖【所有 .js】。
 */
export function shouldNoCacheStaticAsset(base: string): boolean {
  return base.endsWith('.js') || base === 'index.html' || base === 'manifest.json'
}
