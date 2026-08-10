/* 一二布布工作台 PWA Service Worker */
const VERSION = 'life-pwa-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：网络优先，失败回退缓存
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', net.clone());
        return net;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match(req)) || Response.error();
      }
    })());
    return;
  }

  // 其余静态资源：缓存优先，缺则网络并补缓存
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const net = await fetch(req);
      const cache = await caches.open(VERSION);
      cache.put(req, net.clone());
      return net;
    } catch {
      return Response.error();
    }
  })());
});

// 收到跳过等待指令立即激活新版本
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
