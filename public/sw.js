// Service worker: cho phép cài app lên Android/iOS và mở được giao diện khi mạng chập chờn.
// Không bao giờ cache /api (dữ liệu sản lượng luôn lấy mới từ máy chủ).
// Tăng VERSION mỗi khi đổi danh sách SHELL.
const VERSION = 'v2';
const CACHE = `tk-shell-${VERSION}`;
const SHELL = ['/', '/index.html', '/app.js', '/views.js', '/style.css', '/vendor/html5-qrcode.min.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tk-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Mạng trước (luôn có bản mới nhất sau mỗi lần deploy), mất mạng thì dùng bản đã lưu.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
