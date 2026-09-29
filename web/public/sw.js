/* EduReach service worker.
 *
 * Three caching strategies, chosen per resource by what failure looks like:
 *
 *   App shell      cache-first    A student must be able to open the app with
 *                                 no signal at all.
 *   API reads      network-first  Fresh when possible, stale when not, never
 *                                 a blank screen.
 *   Media          cache-first    Immutable and expensive; once downloaded it
 *                                 is never fetched again.
 */

const VERSION = 'v1';
const SHELL = `edureach-shell-${VERSION}`;
const API = `edureach-api-${VERSION}`;
const MEDIA = `edureach-media-${VERSION}`;

const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith('edureach-') && !n.endsWith(VERSION))
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName, ignoreSearch = false) {
  const cache = await caches.open(cacheName);
  // Media URLs carry an auth token in the query string. Matching on the path
  // alone means a student who signs in again still has their lectures, instead
  // of silently re-downloading every one of them on a metered plan.
  const hit = await cache.match(request, { ignoreSearch });
  if (hit) return hit;

  const response = await fetch(request);
  // Range responses (206) must not be cached: a partial body would be served
  // later as if it were the whole file.
  if (response.ok && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) {
      // Tells the UI to show the "offline, showing saved copy" banner.
      const headers = new Headers(hit.headers);
      headers.set('X-From-Cache', '1');
      return new Response(hit.body, { status: hit.status, headers });
    }
    return new Response(
      JSON.stringify({ error: 'offline', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Writes are queued by the app in IndexedDB, not here, so the worker only
  // ever deals with reads.
  if (url.pathname.startsWith('/media/')) {
    // Ranged media requests go straight to the network: resumable downloads
    // manage their own byte ranges.
    if (request.headers.has('range')) return;
    event.respondWith(cacheFirst(request, MEDIA, true));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // The connectivity probe must never be answered from cache, or the app
    // would believe it is online while it is not.
    if (url.pathname === '/api/sync/ping') return;
    event.respondWith(networkFirst(request, API));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(cacheFirst(request, SHELL));
});

// Lets the app ask the worker to pre-cache a lecture during an off-peak window.
self.addEventListener('message', (event) => {
  const { type, urls } = event.data || {};
  if (type === 'PRECACHE_MEDIA' && Array.isArray(urls)) {
    event.waitUntil(
      caches.open(MEDIA).then((cache) =>
        Promise.allSettled(urls.map((u) => cache.add(u)))
      )
    );
  }
  if (type === 'CLEAR_MEDIA') {
    event.waitUntil(caches.delete(MEDIA));
  }
  // Sent on sign-out. Cached API responses are keyed by URL only, not by who
  // asked for them, so on a shared phone the next student would otherwise be
  // served the previous one's courses and certificates.
  if (type === 'CLEAR_PRIVATE') {
    event.waitUntil(Promise.all([caches.delete(API), caches.delete(MEDIA)]));
  }
});

// Fires when the browser regains connectivity, even if the app is not open.
self.addEventListener('sync', (event) => {
  if (event.tag === 'edureach-outbox') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'FLUSH_OUTBOX' }));
      })
    );
  }
});
