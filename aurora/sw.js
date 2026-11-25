// Aurora's service worker, used only when Aurora is opened as a web app (installed from Chrome or Edge, or just in a browser).
// It keeps the app's own files so Aurora opens even with a slow or no connection, and always asks the network first so an
// update shows up straight away. It never touches your server, the Guard, pictures from other sites or any video.
const CACHE = 'aurora-shell-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'splash.js', 'tour-config.js', 'vendor/hls.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return; // other sites, video ranges, anything but a plain read
  e.respondWith(fetch(req).then((res) => { if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
