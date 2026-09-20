// Hermes PWA Service Worker
// Strategy: network-first for API, cache-first for static assets, offline fallback for navigation.

const CACHE_NAME = "hermes-v3";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // API requests — network only (don't cache SSE streams)
  if (url.pathname.startsWith("/api/")) {
    return; // Let the browser handle normally
  }

  // Navigation requests — network first, fall back to cached shell
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache the latest shell
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || new Response("Offline", { status: 503 })))
    );
    return;
  }

  // Static assets — cache first, fall back to network
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && (res.type === "basic" || res.type === "default")) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => new Response("Offline", { status: 503 }));
    })
  );
});
