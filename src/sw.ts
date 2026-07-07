// Cache versioning strategy:
// When app updates, the build time changes, creating a new cache version.
// Old caches are automatically cleaned up on activation.

// Per-build cache version (full timestamp, not just the date) so every deploy
// produces a fresh cache and the activate handler purges the old one — this
// prevents serving a stale main.js when more than one deploy happens in a day.
const CACHE_VERSION = `v${__BUILD_TIME__.replace(/[^0-9]/g, '')}`;
const CACHE_NAME = `survey-tools-${CACHE_VERSION}`;
// Only precache stable, known URLs. Hashed build assets (main.js, CSS, vendor
// chunks) are cached on first fetch by the runtime handler below — listing
// their dev-time paths here (e.g. /src/styles.css) just fails silently in prod.
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// The ambient `self` from the "WebWorker" lib is typed as the generic
// WorkerGlobalScope, which lacks skipWaiting/clients/the 'install' & 'fetch'
// event maps. Rebind it to the Service-Worker-specific type instead of
// redeclaring the global (redeclaring collides with the ambient one).
const sw = self as unknown as ServiceWorkerGlobalScope;

// Install: cache static assets
sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // If addAll fails (e.g., offline), continue anyway
        // The cache will grow organically as assets are requested
      });
    }).then(() => {
      sw.skipWaiting(); // Activate immediately
    })
  );
});

// Activate: clean up old cache versions
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('survey-tools-') && name !== CACHE_NAME)
          .map((name) => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
          })
      );
    }).then(() => {
      sw.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'CACHE_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
});

// Fetch: serve from cache, fallback to network
sw.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip cross-origin requests
  if (url.origin !== sw.location.origin) {
    return;
  }

  // Never cache API responses — cloud data (saved locations, survey points)
  // must always come from the network, or the app would keep serving a stale
  // snapshot for the lifetime of the cache version.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Strategy: cache-first for assets, network-first for HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // Network-first for index.html
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) throw new Error('Network response failed');
          // Clone before caching so we don't consume the response body
          const toCache = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, toCache));
          return response;
        })
        .catch(() =>
          // Fallback to cache; a plain offline response if nothing is cached
          caches.match(request).then(
            (cached) => cached ?? new Response('Offline', { status: 503 })
          )
        )
    );
  } else {
    // Cache-first for static assets (CSS, JS, etc.)
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (!response || !response.ok) return response;
          // Clone before caching so we don't consume the response body
          const toCache = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, toCache));
          return response;
        });
      }).catch(() => {
        // Offline fallback
        return new Response('Offline', { status: 503 });
      })
    );
  }
});
