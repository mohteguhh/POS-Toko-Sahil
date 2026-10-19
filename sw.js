const CACHE_NAME = 'kasirkilat-cache-v44';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css?v=6.3',
  './app.js?v=6.3',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './lib/lucide.js',
  './lib/html5-qrcode.min.js',
  './lib/JsBarcode.all.min.js',
  './lib/xlsx.full.min.js',
  './lib/firebase-app-compat.js',
  './lib/firebase-database-compat.js'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Cache addAll warning:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event (Network First, Fallback to Cache)
self.addEventListener('fetch', (event) => {
  // Hanya tangani request HTTP/HTTPS lokal/GET (Abaikan file:// di Electron agar tidak blank putih)
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http://') && !event.request.url.startsWith('https://')) return;

  // Jangan cache request API eksternal Firebase atau Google
  const url = new URL(event.request.url);
  if (url.origin.includes('firebase') || url.origin.includes('googleapis') || url.origin.includes('gstatic')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
