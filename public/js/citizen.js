/**
 * citizen.js — GeoShield Citizen Reporting App
 * ─────────────────────────────────────────────────────────────────────────
 * Features:
 *  - Leaflet map centered on user's GPS location (falls back to Bangalore)
 *  - Click-to-pin incident location
 *  - Report form with category, severity, description
 *  - Offline-first: failed submissions saved to IndexedDB
 *  - Background Sync (Chromium) + online-event fallback (Safari/Firefox)
 *  - Online/offline status indicator + queue count badge
 */

// ── Constants ──────────────────────────────────────────────────────────────
const BANGALORE_CENTER = [12.9716, 77.5946]; // [lat, lng] for Leaflet
const SEVERITY_LABELS = { 1: 'Minor', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Critical' };

const CATEGORY_EMOJI = {
  flood: '🌊', fire: '🔥', medical: '🚑',
  structural_collapse: '🏚️', road_accident: '🚗', other: '⚠️',
};

// ── State ──────────────────────────────────────────────────────────────────
let map, pinMarker;
let selectedLng = null, selectedLat = null;

// Stable device ID persisted in localStorage
const DEVICE_ID = (() => {
  let id = localStorage.getItem('gs_device_id');
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('gs_device_id', id);
  }
  return id;
})();

// ── UUID helper — used to generate a stable clientReportId per submission ──
function generateReportId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'rpt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// ── Map initialisation ─────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { zoomControl: false }).setView(BANGALORE_CENTER, 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
      () => { /* user denied — stay on Bangalore center */ }
    );
  }

  map.on('click', onMapClick);
}

// ── Map click handler ──────────────────────────────────────────────────────
function onMapClick(e) {
  selectedLat = e.latlng.lat;
  selectedLng = e.latlng.lng;

  if (pinMarker) map.removeLayer(pinMarker);

  pinMarker = L.marker([selectedLat, selectedLng], {
    draggable: true,
    icon: redIcon(),
  }).addTo(map);

  pinMarker.on('dragend', (evt) => {
    const pos = evt.target.getLatLng();
    selectedLat = pos.lat;
    selectedLng = pos.lng;
    updateCoordsDisplay();
  });

  document.getElementById('pin-hint').style.display = 'none';
  document.getElementById('report-form').style.display = 'block';
  updateCoordsDisplay();
}

function updateCoordsDisplay() {
  document.getElementById('coords-display').value =
    `${selectedLat.toFixed(5)}°N, ${selectedLng.toFixed(5)}°E`;
}

function cancelPin() {
  if (pinMarker) { map.removeLayer(pinMarker); pinMarker = null; }
  selectedLat = selectedLng = null;
  document.getElementById('pin-hint').style.display = 'block';
  document.getElementById('report-form').style.display = 'none';
  document.getElementById('description').value = '';
  document.getElementById('severity').value = 3;
  updateSeverityLabel(3);
}

// ── Severity slider ────────────────────────────────────────────────────────
document.getElementById('severity').addEventListener('input', (e) => {
  updateSeverityLabel(parseInt(e.target.value, 10));
});

function updateSeverityLabel(val) {
  document.getElementById('severity-value').textContent = val;
  document.getElementById('severity-text').textContent = SEVERITY_LABELS[val];
}

// ── Report submission ──────────────────────────────────────────────────────
async function submitReport() {
  if (!selectedLat || !selectedLng) {
    showToast('Please drop a pin on the map first.', 'error');
    return;
  }

  // Generate a stable clientReportId BEFORE attempting fetch.
  // If the request fails and goes into the offline queue, every retry
  // sends the exact same ID — the server's sparse unique index
  // ensures only one document is ever created and replayed safely.
  const clientReportId = generateReportId();

  const payload = {
    lat: selectedLat,
    lng: selectedLng,
    category: document.getElementById('category').value,
    severity: parseInt(document.getElementById('severity').value, 10),
    description: document.getElementById('description').value.trim(),
    deviceId: DEVICE_ID,
    clientReportId,
  };

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.status === 201) {
      showToast('✅ Report submitted! Help is on the way.', 'success');
      pinMarker.setIcon(greenIcon());
      pinMarker.bindPopup(
        `${CATEGORY_EMOJI[payload.category]} <strong>${payload.category}</strong><br>Severity: ${payload.severity}/5`
      ).openPopup();
      resetForm();
    } else if (res.status === 200 && data.idempotentReplay) {
      showToast('✅ Report already received by server.', 'success');
      cancelPin();
    } else if (res.status === 409) {
      showToast('⚠️ A similar report was already submitted nearby. No action needed.', 'warning');
      cancelPin();
    } else {
      throw new Error(data.error || 'Server error');
    }
  } catch (err) {
    // Network failure — queue the report (with its stable clientReportId)
    if (!navigator.onLine || err.message === 'Failed to fetch') {
      await enqueueReport(payload); // offlineQueue.js

      // Chromium: Background Sync — fires automatically when connection returns
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        try {
          const sw = await navigator.serviceWorker.ready;
          await sw.sync.register('sync-incidents');
          showToast('📡 No connection — report saved. Will auto-send when online.', 'warning');
        } catch {
          showToast('📡 Saved offline. Will send when you reconnect.', 'warning');
        }
      } else {
        // Safari / Firefox fallback: flush will run on next 'online' event or page load
        showToast('📡 Saved offline. Will send when you reconnect.', 'warning');
      }

      await updateQueueBadge();
      pinMarker.setIcon(queuedIcon());
      resetForm();
    } else {
      showToast(`❌ Error: ${err.message}`, 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '🚨 Submit Distress Signal';
  }
}

function resetForm() {
  document.getElementById('description').value = '';
  document.getElementById('severity').value = 3;
  updateSeverityLabel(3);
  document.getElementById('pin-hint').style.display = 'block';
  document.getElementById('report-form').style.display = 'none';
  selectedLat = selectedLng = null;
}

// ── Queue badge ────────────────────────────────────────────────────────────
async function updateQueueBadge() {
  const count = await queueCount();
  const badge = document.getElementById('queue-badge');
  if (count > 0) {
    badge.textContent = `${count} queued`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ── Cross-browser offline queue flush ─────────────────────────────────────
// Safari and Firefox do not support the Background Sync API.
// This fallback reads the IndexedDB queue directly on the 'online' event
// and on page load (if already online), covering all browsers.
async function flushOfflineQueue() {
  if (!navigator.onLine) return;

  const queued = await getAllQueued(); // offlineQueue.js
  if (!queued || queued.length === 0) return;

  console.log(`[Flush] Attempting to sync ${queued.length} queued report(s)…`);
  let synced = 0;

  for (const report of queued) {
    const { queueId, queuedAt, ...payload } = report;
    try {
      const res = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // 200 (idempotent replay), 201 (created), 409 (proximity dup) → all safe to dequeue
      if (res.status === 200 || res.status === 201 || res.status === 409) {
        await dequeueReport(queueId); // offlineQueue.js
        synced++;
      }
    } catch {
      // Still offline for this request — leave in queue
    }
  }

  if (synced > 0) {
    showToast(`✅ Back online! ${synced} queued report${synced > 1 ? 's' : ''} sent.`, 'success');
    await updateQueueBadge();
  }
}

// ── Online / offline detection ─────────────────────────────────────────────
function updateOnlineStatus() {
  const badge = document.getElementById('offline-badge');
  if (navigator.onLine) {
    badge.classList.remove('visible');
    // Cross-browser flush when coming back online
    flushOfflineQueue();
  } else {
    badge.classList.add('visible');
    showToast('📡 You are offline. Reports will be queued and sent when you reconnect.', 'warning');
  }
}

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ── Custom icons ───────────────────────────────────────────────────────────
function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:20px;height:20px;border-radius:50% 50% 50% 0;
                        background:${color};transform:rotate(-45deg);
                        border:2px solid rgba(255,255,255,0.8);
                        box-shadow:0 2px 8px rgba(0,0,0,0.4);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 20],
  });
}

const redIcon    = () => makeIcon('#dc3545');
const greenIcon  = () => makeIcon('#28a745');
const queuedIcon = () => makeIcon('#fd7e14');

// ── Toast helper ───────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── Init ───────────────────────────────────────────────────────────────────
initMap();
updateOnlineStatus(); // also triggers flushOfflineQueue() if already online
updateQueueBadge();
