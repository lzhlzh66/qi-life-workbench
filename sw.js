/* 一二布布工作台 PWA Service Worker */
const VERSION = 'life-pwa-v5';
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

  // 导航请求：网络优先；失败不回退可能过期的首页缓存（避免旧版卡死），改返回可刷新的提示页
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', net.clone());
        return net;
      } catch {
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>一二布布</title>' +
          '<style>body{font-family:sans-serif;background:#fff6ec;color:#b06a47;min-height:100vh;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px}' +
          'button{font-size:16px;padding:12px 26px;border:0;border-radius:10px;background:#b06a47;color:#fff;cursor:pointer}</style>' +
          '<div style="font-size:30px;letter-spacing:3px">一二布布</div>' +
          '<p>正在连接服务器，请稍候…</p>' +
          '<button onclick="location.reload()">点击刷新</button>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
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
