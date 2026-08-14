// Service worker for Web Push. Its only job is to turn an incoming push into a
// visible notification, and to focus/open the app when the notification is tapped.
// It does NOT cache anything -- this app is online-only (it talks to Arbox and the
// Worker live), so an offline cache would only risk serving stale code.

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Arbox booker";
  const body = data.body || "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon.png",
      badge: "/icon.png",
      // Tag by class so repeated notifications about the same class replace rather
      // than stack; fall back to a constant so untagged ones still show.
      tag: data.tag || "arbox",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      // If the app is already open, focus it rather than opening a duplicate tab.
      if ("focus" in c) { await c.focus(); return; }
    }
    if (clients.openWindow) await clients.openWindow(url);
  })());
});
