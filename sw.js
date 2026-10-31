// Keeps the app, schedule and map data available offline.
const CACHE = 'wa-v7';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/icon-32.png', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/apple-touch-icon.png',
  'assets/hero-640.webp', 'assets/hero-1280.webp', 'assets/hero-1920.webp', 'assets/og.jpg',
  'data/schedule.json', 'data/rooms.json', 'data/sessions-full.json', 'data/partner-events.json',
  'data/freefood.json', 'data/recruiters.json', 'data/companies.json', 'data/booths.json', 'data/guide-meta.json'];
const NET_WAIT_MS = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same origin GET: try the network first so updates show up right away.
// If it is slow or offline, answer from the cache.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('config.local.js')) return;
  const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
  e.respondWith(caches.open(CACHE).then(async c => {
    const fresh = fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r.ok) c.put(key, r.clone());
      return r;
    });
    const hit = await c.match(key, { ignoreSearch: true });
    if (!hit) return fresh;
    const slow = new Promise(res => setTimeout(() => res(hit), NET_WAIT_MS));
    return Promise.race([fresh.catch(() => hit), slow]);
  }));
});

self.addEventListener('push', e => {
  let payload = { title: 'Where Are You', body: 'Someone updated their check-in' };
  try {
    if (e.data) payload = { ...payload, ...e.data.json() };
  } catch {}
  e.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: 'assets/icon-192.png',
    badge: 'assets/icon-192.png',
    data: { url: './#friends' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './#friends';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) {
        c.navigate(url);
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
