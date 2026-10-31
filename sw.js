// Keeps the app, schedule and map data available offline.
const CACHE = 'wa-v1';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'data/schedule.json', 'data/rooms.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same origin GET: answer from cache right away, refresh the cache in the background.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => {
      if (r.ok) c.put(key, r.clone());
      return r;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
