/*
 * Minimal service worker: present so browsers can offer to install JusttPrint. It has no fetch
 * handler, so it never touches page loads (an earlier caching worker hung Docker tabs), and it
 * clears caches left by older workers.
 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
    self.clients.claim()
  ]));
});
