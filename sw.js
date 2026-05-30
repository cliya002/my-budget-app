/* Pocket Budget App service worker */
const CACHE = "pocket-budget-v155";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg",
];

// Versioned core JS files — caught by the dedicated handler below

// CDN libraries — cache on first fetch so they work offline next launch
const CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only handle GET; let everything else pass through (e.g. GitHub API POSTs)
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Skip non-cacheable schemes
  if (!url.protocol.startsWith("http")) return;

  // GitHub Gist API and AI APIs — never cache, just pass through
  // (offline failure is expected and handled in app code)
  if (url.hostname === "api.github.com"
      || url.hostname === "api.openai.com"
      || url.hostname === "api.anthropic.com") {
    return; // let browser handle (will error when offline)
  }

  // Always fetch versioned core assets fresh from network — this lets cache-busting
  // ?v=N actually work without waiting for SW activation.
  if (url.pathname.endsWith("/app.js") || url.pathname.endsWith("/styles.css") || url.pathname.endsWith("/i18n.js")) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // CDN libraries — stale-while-revalidate so they work offline after first fetch
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(event.request, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  if (event.request.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ||
      fetch(event.request)
        .then((res) => {
          // Cache successful responses for next offline load
          if (res && res.status === 200 && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached)
    )
  );
});
