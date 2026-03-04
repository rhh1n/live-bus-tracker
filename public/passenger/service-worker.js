const STATIC_CACHE = "live-bus-tracker-passenger-v10";
const STATIC_ASSETS = [
  "/passenger",
  "/passenger/index.html",
  "/passenger/styles.css",
  "/passenger/app.js",
  "/passenger/manifest.webmanifest"
];

const CACHEABLE_DESTINATIONS = new Set(["style", "script", "font", "image", "manifest"]);

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isLiveApiPath(pathname) {
  return pathname.startsWith("/api/") || pathname.startsWith("/socket.io/");
}

async function putInStaticCache(request, response) {
  if (!response || !response.ok || response.type !== "basic") {
    return response;
  }
  const cache = await caches.open(STATIC_CACHE);
  await cache.put(request, response.clone());
  return response;
}

async function networkFirstNavigation(request) {
  try {
    const network = await fetch(request);
    await putInStaticCache(request, network);
    return network;
  } catch (_err) {
    const cache = await caches.open(STATIC_CACHE);
    return (await cache.match("/passenger/index.html")) || (await cache.match("/passenger"));
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => putInStaticCache(request, res))
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }

  const network = await networkPromise;
  if (network) {
    return network;
  }
  return new Response("Offline", { status: 503, statusText: "Offline" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (!isSameOrigin(url) || isLiveApiPath(url.pathname)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (CACHEABLE_DESTINATIONS.has(request.destination) || url.pathname.startsWith("/passenger/")) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
