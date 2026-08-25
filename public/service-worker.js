const CACHE = "despachefull-v2.7.0-operational-time";
const STATIC = ["/", "/manifest.webmanifest", "/brand-logo.png", "/brand-wordmark.png", "/brand-wordmark-light.png", "/app-icon-192.png", "/app-icon-512.png", "/favicon-64.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;

  event.respondWith(
    fetch(req)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return response;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match("/")))
  );
});


self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});


self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "DespacheFull";
  const options = {
    body: data.message || "Novo alerta operacional.",
    icon: "/app-icon-192.png",
    badge: "/app-icon-192.png",
    tag: data.id ? `despachefull-${data.id}` : "despachefull-alert",
    renotify: true,
    data: { url: "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
