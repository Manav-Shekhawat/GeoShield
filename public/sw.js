/**
 * sw.js — GeoShield Service Worker
 * ─────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *  1. Cache the app shell (HTML, CSS, JS) on install → works offline
 *  2. Serve cached map tiles as fallback when network is unavailable
 *  3. On 'sync' event → flush the IndexedDB offline queue to the server
 *
 * Caching strategy:
 *  - App shell (HTML/CSS/JS/manifest): Cache-first
 *  - Map tiles (OpenStreetMap): Network-first, cache as fallback
 *  - API calls (/api/*): Never cached — handled by offlineQueue.js
 */

const CACHE_NAME = 'geoshield-v1';
const DB_NAME = 'geoshield-db';
const STORE_NAME = 'offline-reports';

// App shell — these files make the citizen app work offline
const APP_SHELL = [
  '/index.html',
  '/css/style.css',
  '/js/offlineQueue.js',
  '/js/citizen.js',
  '/js/register-sw.js',
  '/manifest.json',
];

// ─── Install: cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing GeoShield service worker…');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(APP_SHELL);
    })
  );
  // Activate immediately without waiting for old SW to finish
  self.skipWaiting();
});

// ─── Activate: clean up old caches ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// ─── Fetch: serve from cache or network ───────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept API calls — let offlineQueue.js handle failures
  if (url.pathname.startsWith('/api/')) return;

  // Map tiles — network first, fall back to cache
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  // App shell — cache first, fall back to network
  event.respondWith(cacheFirstWithNetwork(request));
});

async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Cache successful GET responses for future offline use
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // If both cache miss and network fail, return a fallback for HTML requests
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('/index.html');
    }
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Tile unavailable offline', { status: 503 });
  }
}

// ─── Background Sync: flush the offline queue ─────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-incidents') {
    console.log('[SW] Background sync triggered: flushing incident queue…');
    event.waitUntil(syncOfflineQueue());
  }
});

/**
 * Opens IndexedDB, reads all queued reports, POSTs each one to the server.
 * On success, removes the report from the queue.
 * On failure, leaves it in the queue for the next sync attempt.
 */
async function syncOfflineQueue() {
  const db = await openIDB();
  const reports = await getAllFromStore(db);

  if (reports.length === 0) {
    console.log('[SW] Queue empty — nothing to sync');
    return;
  }

  console.log(`[SW] Syncing ${reports.length} queued report(s)…`);
  let synced = 0;

  for (const report of reports) {
    try {
      const { queueId, queuedAt, ...payload } = report;

      const response = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok || response.status === 409) {
        // 409 = duplicate (server already has it) — still safe to dequeue
        await deleteFromStore(db, queueId);
        synced++;
        console.log(`[SW] Synced report queueId=${queueId} (status ${response.status})`);
      } else {
        console.warn(`[SW] Server rejected report queueId=${queueId}: HTTP ${response.status}`);
      }
    } catch (err) {
      // Network still down for this attempt — leave in queue
      console.warn(`[SW] Could not sync queueId=${report.queueId}:`, err.message);
    }
  }

  // Notify the open citizen page about the sync result
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => {
    client.postMessage({ type: 'SYNC_COMPLETE', synced, total: reports.length });
  });

  console.log(`[SW] Sync done: ${synced}/${reports.length} reports uploaded`);
}

// ─── Minimal IndexedDB helpers (can't import offlineQueue.js in SW) ────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true, keyPath: 'queueId' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function getAllFromStore(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function deleteFromStore(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
