/* 간단한 오프라인 캐시 서비스 워커 */
const CACHE = 'handdrawing-v5';
const ASSETS = [
  '.',
  'index.html',
  'styles.css',
  'config.js',
  'js/store.js',
  'js/engine.js',
  'js/pdf.js',
  'js/recognize.js',
  'js/bridge.js',
  'js/app.js',
  'manifest.webmanifest',
  'icon.svg',
  'apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }))
  );
});
