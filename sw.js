const CACHE = 'scriptorium-v2';
const SHELL = ['index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Never intercept Supabase API — always live network
  if (e.request.url.includes('supabase.co')) return;

  if (e.request.url.includes('unpkg.com')) {
    // Network-first for CDN scripts, fall back to cache
    e.respondWith(
      fetch(e.request)
        .then(r => { caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for app shell; offline fallback to index.html for navigations
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request)
          .then(r => { if (r.ok && e.request.method === 'GET') caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; })
          .catch(() => e.request.mode === 'navigate' ? caches.match('index.html') : undefined);
      })
    );
  }
});
