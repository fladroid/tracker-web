// sw.js — Service Worker za tracker-web (bez ES Modules, Safari kompatibilan)
const CACHE = 'tracker-web-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './config.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // sqlite-wasm CDN pozive ne keširati lokalno
  if (e.request.url.includes('cdn.jsdelivr.net')) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
