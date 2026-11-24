/* Magic City Nights service worker: basic offline support.
   - Pages (navigations, incl. ?plan= share links) and spots.json: network-first, cache fallback.
   - Manifests (manifest.json, manifest.webmanifest): network-first, cache fallback.
   - Same-origin static assets (icons, images): cache-first.
   - Google Fonts: stale-while-revalidate.
   - Everything else cross-origin (Kit, GoatCounter, ticket APIs, etc.) is left alone. */
const VERSION = "mcn-v2"; // bump to clear old caches when this file changes
const CACHE = VERSION + "-core";
const FONT_CACHE = VERSION + "-fonts";

const CORE = [
  "/",
  "/index.html",
  "/spots.json",
  "/manifest.json",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/favicon-64.png",
  "/images/logo-main.webp",
  "/images/logo-simple.webp",
  "/images/og-image.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Cache each file on its own so one missing file can't break install.
      Promise.all(CORE.map((url) =>
        cache.add(new Request(url, { cache: "reload" })).catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(fallbackUrl || request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(fallbackUrl || request, { ignoreSearch: true })
      || (fallbackUrl ? await cache.match("/") : null);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && (response.ok || response.type === "opaque")) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
      event.respondWith(staleWhileRevalidate(request));
    }
    return; // let all other third-party requests go straight to the network
  }

  // Page loads, including share links like /?plan=...: always try fresh HTML first,
  // fall back to the cached app shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/index.html"));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(networkFirst(request, "/index.html"));
    return;
  }

  // Spot data and the manifest change over time: fresh when online, cached copy when offline.
  if (url.pathname === "/spots.json" || url.pathname === "/manifest.json" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirst(request, url.pathname));
    return;
  }

  // Never cache the service worker itself.
  if (url.pathname === "/sw.js") return;

  // Static assets: cache-first.
  if (/\.(?:png|jpe?g|webp|gif|svg|ico|css|js|woff2?)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});
