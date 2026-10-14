// The offline shell. The build stamps the cache name below (see stampServiceWorker in vite.config.ts), so
// every deploy has its own cache and the activate step drops the previous one.
const CACHE = 'hub-shell-__BUILD_ID__';
const PREFIX = 'hub-shell-';
const SHELL = '/';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const res = await fetch(SHELL, { cache: 'reload' });
    // A 502 from the proxy during a hub restart must not become the offline shell: fail the install instead.
    if (!res.ok) throw new Error(`HTTP ${res.status} for the shell`);
    const cache = await caches.open(CACHE);
    const page = await res.clone().text();
    await cache.put(SHELL, res);
    // The page's own files, best effort: this cache replaces the previous one on activate, so the shell must not
    // wait for the next visit to find its scripts. A failed one is cached later, when the page asks for it.
    const assets = new Set([...page.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]));
    await Promise.all([...assets].map((a) => cache.add(a).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate' && url.pathname === SHELL) {
    e.respondWith(fetch(e.request).then((r) => {
      // Only a good page replaces the cached shell.
      if (r.ok) { const copy = r.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(SHELL, copy))); }
      return r;
    }).catch(() => caches.match(SHELL)));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy))); }
      return r;
    })));
  }
});
