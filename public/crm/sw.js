/* Minimal service worker: makes the CRM installable and shows an offline screen.
   Network-first for the app shell; API/RPC calls are never cached. */
const CACHE = 'crm-shell-v1';
const SHELL = ['/crm/index.html', '/gas-shim.js', '/crm/manifest.webmanifest', '/crm/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then((res) => { if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('/crm/index.html') : Response.error()))));
});
