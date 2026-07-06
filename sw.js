/* Digital Omamori — Service Worker = SELF-UNINSTALL.
 * Rationale: an SW cache (cache-first / fixed cache name) can serve a stale build and make QA see an old screen.
 * -> We do not use the SW for caching. This file only clears all old caches and unregisters itself, so the page always fetches the latest from the server.
 * Adding the PWA to the home screen needs only manifest.json + meta tags, not an SW.
 * (Trade-off: no SW offline cold-start. Emergency decision cards already compute locally in core.js after the page loads, without hitting the API;
 *  if cold-start offline is needed later, it can be added with a properly versioned SW instead of repeating the stale-cache pitfall.) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
  );
});
