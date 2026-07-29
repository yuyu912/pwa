const SHELL = "wardrobe-local-v14";
const ASSETS = ["./", "./app.css?v=10", "./local-app.js?v=13", "./weather-rules.js?v=1", "./analysis-rules.js?v=2", "./runtime-utils.js?v=3", "./region-search.js?v=1", "./ai-result-utils.js?v=2", "./image-analysis-utils.js?v=1", "./local-ai-worker.js?v=7", "./china-regions.min.json?v=1", "./manifest.webmanifest", "./icon.svg", "./wardrobe-home-hero-v2.png", "./today-outfit-v2.png", "./home-icons-v2.png", "./weather-states-v3.png"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin || requestUrl.pathname.endsWith("/sw.js")) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => { if (response.ok || response.type === "opaque") caches.open(SHELL).then((cache) => cache.put(event.request, response.clone())); return response; })));
});
