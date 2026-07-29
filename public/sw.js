const SHELL = "wardrobe-local-v1";
const ASSETS = ["./", "./app.css", "./local-app.js?v=1", "./local-ai-worker.js?v=1", "./manifest.webmanifest", "./icon.svg"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname === "/sw.js") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => { if (response.ok || response.type === "opaque") caches.open(SHELL).then((cache) => cache.put(event.request, response.clone())); return response; })));
});
