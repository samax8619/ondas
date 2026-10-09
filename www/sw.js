// Service worker mínimo: guarda la interfaz para que abra sin conexión.
// Importante: esto NO da acceso a la señal celular; solo hace instalable/offline la parte visual.

const CACHE = 'senal-celular-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'chart.js', 'sources.js', 'permissions.js',
  'arfcn.js', 'quality.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Red primero (para recibir cambios al desarrollar), caché como respaldo sin conexión.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('index.html'))),
  );
});
