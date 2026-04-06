// Herald Service Worker v1.0
// Enables full PWA install -- removes globe badge from home screen icon

const CACHE_NAME = 'herald-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './herald_icon_192.png',
  './herald_icon_512.png',
  './herald_icon_180.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});