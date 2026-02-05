const CACHE_NAME = 'draft-royale-v1';
const RUNTIME_CACHE = 'draft-royale-runtime';

// Files to cache immediately on install
const STATIC_CACHE_URLS = [
  '/',
  '/index.html',
  '/live.html',
  '/styles.css',
  '/live-styles.css',
  '/app.js',
  '/live.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching static assets');
        return cache.addAll(STATIC_CACHE_URLS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
              console.log('[Service Worker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Skip Socket.IO requests
  if (url.pathname.startsWith('/socket.io/')) {
    return;
  }

  // Skip API requests (we want fresh data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache API responses for offline fallback
          if (response.ok) {
            const clonedResponse = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, clonedResponse);
            });
          }
          return response;
        })
        .catch(() => {
          // Return cached API response if offline
          return caches.match(request);
        })
    );
    return;
  }

  // For everything else: Cache-first strategy
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          // Return cached version, but fetch update in background
          fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, networkResponse);
              });
            }
          }).catch(() => {});
          
          return cachedResponse;
        }

        // Not in cache, fetch from network
        return fetch(request)
          .then((networkResponse) => {
            // Cache good responses
            if (networkResponse.ok) {
              const clonedResponse = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, clonedResponse);
              });
            }
            return networkResponse;
          })
          .catch((error) => {
            console.log('[Service Worker] Fetch failed:', error);
            // Return offline page if available
            return caches.match('/offline.html');
          });
      })
  );
});

// Background sync for offline actions (future enhancement)
self.addEventListener('sync', (event) => {
  console.log('[Service Worker] Background sync:', event.tag);
  if (event.tag === 'sync-draft-actions') {
    event.waitUntil(syncDraftActions());
  }
});

async function syncDraftActions() {
  // Placeholder for syncing draft picks made while offline
  console.log('[Service Worker] Syncing draft actions...');
}

// Push notifications (future enhancement)
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push notification received');
  
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Draft Royale';
  const options = {
    body: data.body || 'New update available!',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    data: data.url || '/',
    actions: [
      { action: 'open', title: 'Open Game' },
      { action: 'close', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'open' || !event.action) {
    const urlToOpen = event.notification.data || '/';
    
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clientList) => {
          // Check if there's already a window open
          for (let client of clientList) {
            if (client.url === urlToOpen && 'focus' in client) {
              return client.focus();
            }
          }
          // Open new window
          if (clients.openWindow) {
            return clients.openWindow(urlToOpen);
          }
        })
    );
  }
});
