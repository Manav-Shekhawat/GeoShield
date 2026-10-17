/**
 * admin.js — GeoShield Admin Command Center
 * ─────────────────────────────────────────────────────────────────────────
 * Features:
 *  - Leaflet map with color-coded incident markers (by severity)
 *  - Responder markers (blue icons with team labels)
 *  - Real-time updates via Socket.io (fed by MongoDB Change Streams)
 *  - Sidebar stats: active count, critical count, responders, resolved
 *  - Incident list with status filter
 *  - Cluster analysis: $geoNear aggregation within 5 km of clicked point
 *  - Assign nearest responder to an incident
 */

// ── Constants ──────────────────────────────────────────────────────────────
const BANGALORE_CENTER = [12.9716, 77.5946];

const SEVERITY_COLOR = {
  5: '#dc3545', // Critical — red
  4: '#fd7e14', // High — orange
  3: '#ffc107', // Moderate — yellow
  2: '#20c997', // Low — teal
  1: '#6c757d', // Minor — grey
};

const CATEGORY_EMOJI = {
  flood: '🌊', fire: '🔥', medical: '🚑',
  structural_collapse: '🏚️', road_accident: '🚗', other: '⚠️',
};

const TEAM_COLOR = { NDRF: '#0d6efd', FIRE: '#fd7e14', MEDICAL: '#20c997', POLICE: '#6f42c1' };

// ── State ──────────────────────────────────────────────────────────────────
let map;
const incidentMarkers = new Map(); // incidentId → L.Marker
const responderMarkers = new Map();
let selectedIncidentId = null;
let activeFilter = '';

// ── Map init ───────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { zoomControl: false }).setView(BANGALORE_CENTER, 12);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Click anywhere on the map → run cluster analysis at that point
  map.on('click', (e) => {
    fetchClusterAt(e.latlng.lng, e.latlng.lat);
  });
}

// ── Incident markers ───────────────────────────────────────────────────────
function makeIncidentIcon(severity) {
  const color = SEVERITY_COLOR[severity] || '#aaa';
  const isPulsing = severity >= 5;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${14 + severity * 2}px;
      height:${14 + severity * 2}px;
      border-radius:50%;
      background:${color};
      border:2px solid rgba(255,255,255,0.7);
      box-shadow:0 0 ${severity * 3}px ${color}80;
      position:relative;
    " ${isPulsing ? 'class="pulse-marker"' : ''}></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function addIncidentMarker(incident) {
  const [lng, lat] = incident.location.coordinates;
  const emoji = CATEGORY_EMOJI[incident.category] || '⚠️';

  const marker = L.marker([lat, lng], {
    icon: makeIncidentIcon(incident.severity),
    zIndexOffset: incident.severity * 100,
  }).addTo(map);

  marker.bindPopup(buildPopup(incident), { maxWidth: 280 });

  marker.on('click', () => {
    selectedIncidentId = incident._id;
    highlightListItem(incident._id);
  });

  incidentMarkers.set(String(incident._id), marker);
}

function buildPopup(incident) {
  const [lng, lat] = incident.location.coordinates;
  const time = new Date(incident.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const statusColor = { NEW: '#0d6efd', VERIFIED: '#20c997', ASSIGNED: '#fd7e14', RESOLVED: '#6c757d' };

  return `
    <div style="font-family:system-ui;font-size:13px;min-width:200px;">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">
        ${CATEGORY_EMOJI[incident.category] || '⚠️'} ${incident.category.replace(/_/g,' ')}
      </div>
      <div style="margin-bottom:6px;color:#555;">${incident.description || 'No description provided'}</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
        <span style="background:${SEVERITY_COLOR[incident.severity]};color:#fff;
                     border-radius:4px;padding:1px 7px;font-size:11px;font-weight:700;">
          SEV ${incident.severity}
        </span>
        <span style="background:${statusColor[incident.status] || '#999'};color:#fff;
                     border-radius:4px;padding:1px 7px;font-size:11px;">
          ${incident.status}
        </span>
        <span style="color:#888;font-size:11px;">${time}</span>
      </div>
      ${incident.status !== 'RESOLVED' ? `
        <div style="display:flex;gap:6px;">
          <button onclick="openAssignModal('${incident._id}', ${lng}, ${lat})"
                  style="flex:1;background:#0d6efd;color:#fff;border:none;
                         border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;">
            👮 Assign Responder
          </button>
          <button onclick="updateStatus('${incident._id}', 'VERIFIED')"
                  style="background:transparent;border:1px solid #20c997;color:#20c997;
                         border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;">
            ✓ Verify
          </button>
          <button onclick="updateStatus('${incident._id}', 'RESOLVED')"
                  style="background:transparent;border:1px solid #6c757d;color:#6c757d;
                         border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;">
            ✓ Resolve
          </button>
        </div>
      ` : '<div style="color:#6c757d;font-size:11px;">✅ This incident is resolved</div>'}
    </div>
  `;
}

// ── Responder markers ──────────────────────────────────────────────────────
function makeResponderIcon(team, status) {
  const color = TEAM_COLOR[team] || '#888';
  const opacity = status === 'OFF_DUTY' ? 0.3 : 1;
  return L.divIcon({
    className: '',
    html: `<div style="
      background:${color};
      color:#fff;
      font-size:9px;
      font-weight:700;
      padding:2px 5px;
      border-radius:4px;
      white-space:nowrap;
      opacity:${opacity};
      box-shadow:0 2px 6px rgba(0,0,0,0.4);
    ">${team}</div>`,
    iconAnchor: [20, 10],
  });
}

function addResponderMarker(responder) {
  const [lng, lat] = responder.currentLocation.coordinates;
  const marker = L.marker([lat, lng], {
    icon: makeResponderIcon(responder.team, responder.status),
    zIndexOffset: -100,
  }).addTo(map);

  marker.bindTooltip(`${responder.name} — ${responder.status}`, { permanent: false });
  responderMarkers.set(String(responder._id), marker);
}

// ── Data fetching ──────────────────────────────────────────────────────────
async function loadAllIncidents(statusFilter = '') {
  const url = statusFilter
    ? `/api/incidents?status=${statusFilter}&limit=200`
    : '/api/incidents?limit=200';

  const res = await fetch(url);
  const { data } = await res.json();

  // Clear existing markers
  incidentMarkers.forEach((m) => map.removeLayer(m));
  incidentMarkers.clear();

  data.forEach(addIncidentMarker);
  renderIncidentList(data);
  updateStats(data);
}

async function loadResponders() {
  const res = await fetch('/api/responders');
  const { data } = await res.json();
  data.forEach(addResponderMarker);
  document.getElementById('stat-responders').textContent =
    data.filter((r) => r.status === 'AVAILABLE').length;
}

async function fetchClusterAt(lng, lat) {
  const res = await fetch(`/api/incidents/cluster?lng=${lng}&lat=${lat}&radius=5000`);
  const result = await res.json();

  const list = document.getElementById('cluster-list');
  if (!result.data || result.data.length === 0) {
    list.innerHTML = `<div style="color:#555;font-size:0.8rem;">No active incidents within 5 km of clicked point</div>`;
    return;
  }

  list.innerHTML = result.data.map((c) => `
    <div class="incident-list-item" style="display:flex;justify-content:space-between;align-items:center;">
      <span>${CATEGORY_EMOJI[c._id] || '⚠️'} ${c._id}</span>
      <span style="display:flex;gap:6px;align-items:center;">
        <span style="color:#fff;font-weight:700;">${c.count}</span>
        <span style="color:#888;font-size:0.72rem;">avg sev ${c.avgSeverity?.toFixed(1)}</span>
      </span>
    </div>
  `).join('');
}

// ── Status update ──────────────────────────────────────────────────────────
async function updateStatus(incidentId, status) {
  try {
    const res = await fetch(`/api/incidents/${incidentId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      showToast(`✅ Status updated to ${status}`, 'success');
      map.closePopup();
    }
  } catch (err) {
    showToast('❌ Failed to update status', 'error');
  }
}

// ── Assign responder modal ─────────────────────────────────────────────────
let assigningIncidentId = null;

async function openAssignModal(incidentId, lng, lat) {
  assigningIncidentId = incidentId;
  const res = await fetch(`/api/responders/nearest?lng=${lng}&lat=${lat}&limit=5`);
  const { data } = await res.json();

  const list = document.getElementById('nearest-responders-list');

  if (!data || data.length === 0) {
    list.innerHTML = '<div style="color:#888;font-size:0.85rem;">No available responders nearby.</div>';
  } else {
    list.innerHTML = data.map((r) => `
      <div class="incident-list-item" style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:0.85rem;color:#fff;">${r.name}</div>
          <div class="incident-meta">${r.team} · ${(r.distanceFromIncident / 1000).toFixed(1)} km away</div>
        </div>
        <button onclick="assignResponder('${r._id}')"
                style="background:#0d6efd;color:#fff;border:none;border-radius:6px;
                       padding:4px 10px;cursor:pointer;font-size:0.78rem;">
          Assign
        </button>
      </div>
    `).join('');
  }

  document.getElementById('assign-modal').style.display = 'flex';
  map.closePopup();
}

async function assignResponder(responderId) {
  try {
    const res = await fetch(`/api/incidents/${assigningIncidentId}/assign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responderId }),
    });
    if (res.ok) {
      showToast('✅ Responder assigned and dispatched!', 'success');
      closeAssignModal();
    }
  } catch (err) {
    showToast('❌ Assignment failed', 'error');
  }
}

function closeAssignModal() {
  document.getElementById('assign-modal').style.display = 'none';
  assigningIncidentId = null;
}

// ── Sidebar list ───────────────────────────────────────────────────────────
function renderIncidentList(incidents) {
  const list = document.getElementById('incident-list');
  if (incidents.length === 0) {
    list.innerHTML = '<div style="color:#555;font-size:0.8rem;">No incidents matching filter.</div>';
    return;
  }

  list.innerHTML = incidents
    .filter((i) => i.status !== 'RESOLVED')
    .slice(0, 50)
    .map((i) => `
      <div class="incident-list-item" id="list-item-${i._id}" onclick="flyToIncident('${i._id}')">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="severity-badge sev-${i.severity}"></span>
          <span style="color:#e0e0e0;">${CATEGORY_EMOJI[i.category] || '⚠️'} ${i.category.replace(/_/g,' ')}</span>
        </div>
        <div class="incident-meta">
          ${i.status} · ${new Date(i.createdAt).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit'})}
          ${i.description ? '· ' + i.description.slice(0, 40) + (i.description.length > 40 ? '…' : '') : ''}
        </div>
      </div>
    `).join('');
}

function flyToIncident(id) {
  const marker = incidentMarkers.get(id);
  if (marker) {
    map.flyTo(marker.getLatLng(), 16, { duration: 0.8 });
    setTimeout(() => marker.openPopup(), 850);
  }
}

function highlightListItem(id) {
  document.querySelectorAll('.incident-list-item').forEach((el) => {
    el.style.borderColor = 'rgba(255,255,255,0.06)';
  });
  const el = document.getElementById(`list-item-${id}`);
  if (el) {
    el.style.borderColor = '#0d6efd';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────
function updateStats(incidents) {
  const active = incidents.filter((i) => i.status !== 'RESOLVED').length;
  const critical = incidents.filter((i) => i.severity >= 4 && i.status !== 'RESOLVED').length;
  const resolved = incidents.filter((i) => i.status === 'RESOLVED').length;
  document.getElementById('stat-active').textContent   = active;
  document.getElementById('stat-critical').textContent = critical;
  document.getElementById('stat-resolved').textContent = resolved;
}

// ── Filter buttons ─────────────────────────────────────────────────────────
document.getElementById('filter-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  activeFilter = btn.dataset.status;
  loadAllIncidents(activeFilter);
});

// ── Socket.io — real-time Change Stream events ─────────────────────────────
function initSocket() {
  const socket = io();

  socket.on('connect', () => {
    document.getElementById('conn-status').textContent = 'Live';
    document.getElementById('conn-status').style.color = '#28a745';
  });

  socket.on('disconnect', () => {
    document.getElementById('conn-status').textContent = 'Disconnected';
    document.getElementById('conn-status').style.color = '#dc3545';
  });

  // New incident inserted — add to map immediately
  socket.on('new-incident', (incident) => {
    showToast(
      `🚨 New ${incident.category.replace(/_/g,' ')} report — Severity ${incident.severity}`,
      incident.severity >= 4 ? 'error' : 'info'
    );
    addIncidentMarker(incident);
    // Reload full list + stats to keep counts accurate
    loadAllIncidents(activeFilter);
  });

  // Existing incident updated (status change, assignment)
  socket.on('incident-updated', ({ id, fullDocument }) => {
    if (!fullDocument) return;

    // Update or replace the marker
    const existing = incidentMarkers.get(String(id));
    if (existing) {
      map.removeLayer(existing);
      incidentMarkers.delete(String(id));
    }

    if (fullDocument.status !== 'RESOLVED') {
      addIncidentMarker(fullDocument);
    }

    loadAllIncidents(activeFilter);
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────
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
loadAllIncidents();
loadResponders();
initSocket();
