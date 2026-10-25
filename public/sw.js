/* Chatter Bots service worker — installable PWA shell cache.
   - Precaches ONLY the static shell (html, css, js, icons) in a versioned cache.
   - Cache-first for those shell assets.
   - Network-only for /api, /ws, /admin (never cached).
   - Never caches any request that carries an Authorization header or token.
   - Deletes old caches on activate. */
'use strict';

const CACHE = 'chatterbots-shell-v1';

// The static shell. Versioned asset URLs match exactly what the pages request so the
// cache-first lookup hits. Bump CACHE (and these ?v= values if the pages change) on release.
const SHELL = [
  '/meet',
  '/world',
  '/manifest.webmanifest',
  '/client/meet.html',
  '/client/meet.css?v=7',
  '/client/meet.js?v=7',
  '/client/world.css?v=7',
  '/client/world.js?v=11',
  '/client/boot-err.js?v=1',
  '/client/eldermere-logo.png?v=3',
  '/client/beacon-preview/beacon-base.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Best-effort: don't let one missing asset fail the whole install.
      Promise.allSettled(SHELL.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isDynamicPath(url) {
  const p = url.pathname;
  return p.startsWith('/api') || p.startsWith('/ws') || p.startsWith('/admin');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle same-origin GETs; everything else goes straight to the network.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never touch dynamic endpoints, and never cache an authenticated request.
  if (isDynamicPath(url) || req.headers.has('Authorization')) {
    event.respondWith(fetch(req));
    return;
  }

  // Cache-first for the static shell. On a cache miss, fetch and cache a copy (but only for
  // safe, non-authenticated, basic/same-origin responses).
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        try {
          const cacheable = res && res.ok && (res.type === 'basic' || res.type === 'default')
            && !res.headers.has('Authorization');
          if (cacheable) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
        } catch (_e) { /* ignore */ }
        return res;
      }).catch(() => caches.match('/meet'));
    })
  );
});
