// Service Worker — 网络优先，离线降级缓存；API 请求不缓存
const CACHE = 'webaz-v483'

self.addEventListener('install', e => {
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ))
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  // L-4: 仅 GET + 同源 + 严格 /api/ 路径前缀才参与判断；避免 /static/api-docs.html 这类被误绕
  if (e.request.method !== 'GET') return
  let url
  try { url = new URL(e.request.url) } catch { return }
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone()
      caches.open(CACHE).then(c => c.put(e.request, clone))
      return res
    }).catch(() => caches.match(e.request))
  )
})

// Wave E-5: PWA Push 事件处理
self.addEventListener('push', e => {
  let data = { title: 'WebAZ', body: '你有新通知', url: '/' }
  try { if (e.data) data = { ...data, ...e.data.json() } } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
      tag: data.tag || 'webaz-default',
    })
  )
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      // 复用已打开的窗口
      for (const c of clients) {
        if ('focus' in c) {
          c.focus()
          if ('navigate' in c) c.navigate(url).catch(() => {})
          return
        }
      }
      // 否则开新窗口
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})
