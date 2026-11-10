/* Our budget service worker: shows push notifications and opens the app when tapped. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Our budget", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Our budget", {
      body: data.body || "",
      tag: data.tag || "our-budget",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) { c.postMessage({ type: "refresh" }); return c.focus(); }
      return self.clients.openWindow("/");
    }),
  );
});
