/* CassieAITracker service worker.

   Every path here is relative, because GitHub Pages serves this from
   /CassieAITracker/ rather than a root domain. An absolute "/index.html" would
   resolve to the wrong place and the install would fail quietly.

   Bump CACHE on every deploy — that is what evicts the old shell. */

const CACHE = "cassieaitracker-v1";

const SHELL = [
  "./",
  "./index.html",
  "./tokens.css",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic — one 404 would reject the whole install and leave no
      // cache at all, so each file is added independently.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only the app shell. API calls go to the Worker on another origin and must
  // never be cached or intercepted.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Stale-while-revalidate: serve instantly from cache, refresh in the
  // background so the next launch has the new version.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: whatever we already have

      return cached || network;
    }),
  );
});
