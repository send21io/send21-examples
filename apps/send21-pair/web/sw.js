// send21 pair service worker: offline app shell, Web Push, notification taps.
// A notification tap can only open an http(s) page (the pay screen), never a
// wallet URI, so the wallet opens with one more tap on "Open wallet".
const CACHE = "pair-v3";
const SHELL = ["./", "index.html", "styles.css", "app.js", "icons.js", "theme.js", "config.js", "lib/core.js", "lib/server-api.js", "lib/static-api.js", "vendor/qrcode.js", "icons/logo.svg", "icons/icon-192.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  // Network first (fresh code and config), cache as the offline fallback.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r ?? caches.match("index.html"))),
  );
});

self.addEventListener("push", (e) => {
  let n = {};
  try { n = e.data?.json() ?? {}; } catch { n = { title: "send21 pair", body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(n.title ?? "send21 pair", {
    body: n.body ?? "", tag: n.tag, renotify: !!n.tag, data: { url: n.url ?? "./" },
    icon: "icons/icon-192.png", badge: "icons/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url ?? "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); return win.navigate(target).catch(() => self.clients.openWindow(target)); }
    return self.clients.openWindow(target);
  })());
});
