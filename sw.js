// アプリ本体をキャッシュしてオフラインでも起動できるようにする(音声データは IndexedDB 側)
const CACHE = 'oto-v28'; // js/app.js の APP_VERSION と合わせる
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/player.js', 'js/db.js', 'js/tags.js', 'js/fx.js', 'js/sync.js', 'js/config.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // ブラウザのキャッシュを通さず、公開中の最新ファイルを取り込む
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同じサイトのファイルは「ネット優先・失敗したらキャッシュ」。更新がすぐ反映され、圏外でも開ける
// GitHub Pages はファイルをブラウザに10分ほど覚えさせるので、毎回サーバーに新しいか確かめる(no-cache)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const req = e.request.mode === 'navigate'
    ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
