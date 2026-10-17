/**
 * offlineQueue.js
 * ─────────────────────────────────────────────────────────────────────────
 * Manages an IndexedDB store called "geoshield-queue" for offline reports.
 * When a report submission fails (no network), the report is saved here.
 * When connectivity restores, the Service Worker fires a 'sync' event,
 * reads all queued reports, and POSTs them to /api/incidents.
 *
 * The DB is also read directly by the SW via this same module pattern.
 */

const DB_NAME = 'geoshield-db';
const DB_VERSION = 1;
const STORE_NAME = 'offline-reports';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // autoIncrement key — each queued report gets a unique integer id
        db.createObjectStore(STORE_NAME, { autoIncrement: true, keyPath: 'queueId' });
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror  = (e) => reject(e.target.error);
  });
}

/**
 * Save a report payload to the offline queue.
 * @param {Object} reportData - The incident payload to queue
 * @returns {Promise<number>} - The assigned queue ID
 */
async function enqueueReport(reportData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add({ ...reportData, queuedAt: new Date().toISOString() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Retrieve all queued reports.
 * @returns {Promise<Array>}
 */
async function getAllQueued() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Remove a successfully synced report from the queue.
 * @param {number} queueId
 */
async function dequeueReport(queueId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(queueId);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Count how many reports are currently queued.
 * @returns {Promise<number>}
 */
async function queueCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
