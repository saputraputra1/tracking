const CACHE = 'vault-swa-v2';
const ASSETS = ['/','/admin.html','/lupa-password.html','/daftar.html','/favicon.svg','/manifest.json','/tracker.js','/app.js','/firebase-config.js'];
const TRACKER_SERVER = self.location.origin;

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(clients.claim());
});

// Intercept fetch — redirect non-asset requests to tracker
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (url.origin === TRACKER_SERVER && ASSETS.includes(url.pathname)) {
        return e.respondWith(caches.match(e.request));
    }
});

// Background sync — flush pending data
self.addEventListener('sync', (e) => {
    if (e.tag === 'sync-tracker') {
        e.waitUntil(flushPending());
    }
});

async function flushPending() {
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    for (const req of keys) {
        if (req.url.includes('/track/')) {
            const res = await cache.match(req);
            if (res) {
                try {
                    await fetch(req.url, { method: 'POST', body: await res.text(), headers: { 'Content-Type': 'application/json' } });
                    await cache.delete(req);
                } catch(e) {}
            }
        }
    }
}

// Periodic background sync (Chromium)
self.addEventListener('periodicsync', (e) => {
    if (e.tag === 'periodic-tracker') {
        e.waitUntil(flushPending());
    }
});
