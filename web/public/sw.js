/* 数科云办公的最小 PWA 安装服务 Worker。 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Chrome 的可安装性判定要求 service worker 接管 fetch；这里保持网络直通，
// 不缓存 HTML/API，避免部署新版本时出现旧页面或旧数据。
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
