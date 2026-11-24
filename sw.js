/* Magic City Nights service worker: basic offline support.
   - Pages (navigations, incl. ?plan= share links), spots.json and events.json: network-first, cache fallback.
   - Push: shows same-night event alerts and opens /?view=events when tapped.
   - Manifests (manifest.json, manifest.webmanifest): network-first, cache fallback.
   - Same-origin static assets (icons, images): cache-first.
   - Google Fonts: stale-while-revalidate.
   - Everything else cross-origin (Kit, GoatCounter, ticket APIs, etc.) is left alone. */
const VERSION = "mcn-v3"; // bump to clear old caches when this file changes
const CACHE = VERSION + "-core";
const FONT_CACHE = VERSION + "-fonts";

const CORE = [
  "/",
  "/index.html",
  "/spots.json",
  "/events.json",
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
  if (url.pathname === "/events.json" || url.pathname === "/spots.json" || url.pathname === "/manifest.json" || url.pathname === "/manifest.webmanifest") {
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

// ---------- Same-night event alerts (Web Push) ----------
// Payload (JSON, sent by workers/push): { title, body, eventTitle, venue, time, url, tag }
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json() || {}; }
    catch (err) { data = { body: event.data.text() }; }
  }
  const eventLine = data.eventTitle
    ? `${data.eventTitle} is tonight${data.venue ? " at " + data.venue : ""}${data.time ? " \u00b7 " + data.time : ""}`
    : "";
  const title = data.title || "Tonight in Birmingham";
  const body = data.body || eventLine || "Something good is happening in Birmingham tonight.";
  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || "mcn-tonight",
    renotify: true,
    lang: "en-US",
    timestamp: Date.now(),
    data: { url: data.url || "/?view=events" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target;
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || "/?view=events", self.location.origin);
    target = u.origin === self.location.origin ? u.href : new URL("/?view=events", self.location.origin).href;
  } catch (err) {
    target = new URL("/?view=events", self.location.origin).href;
  }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const mine = wins.find((c) => { try { return new URL(c.url).origin === self.location.origin; } catch (e) { return false; } });
    if (mine) {
      try {
        const nav = mine.navigate ? await mine.navigate(target) : null;
        return (nav || mine).focus();
      } catch (err) {
        try { return await mine.focus(); } catch (e) { /* fall through */ }
      }
    }
    return self.clients.openWindow(target);
  })());
});
