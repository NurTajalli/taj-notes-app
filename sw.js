// Network-first service worker: always serves fresh code when online,
// falls back to the cache only when offline.
const CACHE = "journal-v12";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sync.js",
  "./manifest.json",
  "./header.jpg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Let cross-origin requests (Firebase CDN, Google auth) go straight to network.
  if (url.origin !== self.location.origin) return;

  // Network-first: try network, cache the fresh copy, fall back to cache offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./")))
  );
});
