// approved-delivery-card-v1: preserve the existing courier card cache contract.
const CACHE = "despachefull-v3.7.0-bandwidth-stage1";
const STATIC = ["/", "/courier-dark.css", "/login-desktop.css", "/login-bike-scene.png", "/login-garage-desktop.webp", "/login-city-desk-scene-v2.png", "/login-omen-27-real.webp", "/login-mobile-hero.webp", "/password-recovery.js", "/password-recovery.css", "/manifest.webmanifest", "/brand-logo.png", "/brand-wordmark.png", "/brand-wordmark-light.png", "/app-icon-192.png", "/app-icon-512.png", "/favicon-64.png", "/waze-icon.png", "/google-maps-icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.allSettled(STATIC.map(url => cache.add(url)))));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("despachefull-") && key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Authentication, payments, dispatches and Socket.IO always use the network.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;
  const asset = /\.(?:css|js|png|jpe?g|webp|svg|ico|woff2?|webmanifest)$/i.test(url.pathname);
  if (!asset) {
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req);
    if (cached) {
      // Images/icons are cache-first until the cache version changes. CSS/JS refresh in the background.
      if (/\.(?:css|js)$/i.test(url.pathname)) event.waitUntil(fetch(req).then(response => {
        if (response.ok) return cache.put(req, response.clone());
      }).catch(() => {}));
      return cached;
    }
    return fetch(req).then(response => {
      if (response.ok) event.waitUntil(cache.put(req, response.clone()));
      return response;
    });
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) if ("focus" in client) return client.focus();
    if (clients.openWindow) return clients.openWindow("/");
  }));
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || "DespacheFull", {
    body: data.message || "Novo alerta operacional.", icon: "/app-icon-192.png", badge: "/app-icon-192.png",
    tag: data.id ? `despachefull-${data.id}` : "despachefull-alert", renotify: true, data: { url: "/" }
  }));
});
