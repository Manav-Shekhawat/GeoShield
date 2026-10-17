# GeoShield

Geospatial incident reporting and dispatch system built with Node.js, Express, MongoDB Atlas, Socket.IO, and Leaflet.

GeoShield provides two interfaces over a shared MongoDB backend:
1. **Citizen Reporting Client (`/index.html`)**: A mobile-first progressive web app that captures geotagged incident reports and queues submissions in IndexedDB when network connectivity is unavailable.
2. **Operations Dashboard (`/admin.html`)**: A live map interface backed by MongoDB `2dsphere` indexes, aggregation pipelines, and Change Streams for filtering active incidents and dispatching nearby responder units.

---

## System Architecture

```text
Citizen Client (Leaflet + Service Worker + IndexedDB)
       │
       │  POST /api/incidents (idempotent via clientReportId)
       ▼
Express REST API (Node.js / Mongoose)
       │
       ├──► MongoDB Atlas (incidents, responders)
       │         │
       │         └──► Change Stream (watch insert / update)
       │                     │
       ◄─────────────────────┘
       │
       │  Socket.IO events (new-incident, incident-updated)
       ▼
Admin Dashboard (Leaflet + Live Filters + Responder Dispatch)
```

### Key Design Decisions

* **Idempotent Offline Synchronization (`clientReportId`)**
  When a user submits a report, the browser generates a UUID (`clientReportId`) prior to the network call. If the connection drops after the server commits the write—or if the payload is queued in IndexedDB and replayed later—re-submitting the same `clientReportId` hits a sparse unique index (`{ clientReportId: 1 }`). The API catches the duplicate key condition and returns `200 OK` (`X-Idempotent-Replay: true`) with the existing document rather than inserting a duplicate record.
* **Proximity Deduplication vs. Retry Idempotency**
  Retry safety is separated from spam prevention. If the same `reporterDeviceId` submits *distinct* reports within a 500-meter radius inside a 10-minute window, the server queries `$nearSphere` against the `2dsphere` index and rejects the submission with `409 Conflict`.
* **Atomic Responder Reservation**
  To prevent concurrent requests from double-booking the same unit, `PATCH /api/incidents/:id/assign` executes an atomic conditional update:
  ```javascript
  Responder.findOneAndUpdate(
    { _id: responderId, status: 'AVAILABLE' },
    { $set: { status: 'DISPATCHED' }, $addToSet: { assignedIncidents: incident._id } },
    { new: true }
  );
  ```
  If another operator claims the responder first, the query returns `null` and the endpoint responds with `409 Conflict`.
* **Cross-Browser Offline Queue Flushing**
  Chromium browsers trigger background synchronization via the Service Worker `SyncManager` (`sync-incidents`). Because Safari and Firefox do not support the Web Background Sync API, the client also flushes pending IndexedDB entries on `window.addEventListener('online')` and on initial page load.
* **Resilient Change Streams**
  The MongoDB Change Stream watcher (`Incident.watch()`) attaches an explicit error listener with backoff reconnection so transient Atlas primary step-downs or idle connection drops do not crash the Node.js process.

---

## Data Model & Index Strategy

### `incidents` Collection

| Field | Type | Validation / Notes |
| :--- | :--- | :--- |
| `location` | GeoJSON `Point` | Required. `{ type: 'Point', coordinates: [lng, lat] }` with bounds check (`-180..180`, `-90..90`). |
| `category` | `String` | Enum: `flood`, `fire`, `medical`, `structural_collapse`, `road_accident`, `other`. |
| `severity` | `Number` | Integer `1` (low) to `5` (critical). |
| `description` | `String` | Optional, trimmed, max 500 characters. |
| `status` | `String` | Enum: `NEW`, `VERIFIED`, `ASSIGNED`, `RESOLVED` (default: `NEW`). |
| `clientReportId` | `String` | Client-generated UUID for idempotent retries. Indexed (`unique: true, sparse: true`). |
| `reporterDeviceId` | `String` | Browser device identifier used for 500m / 10min proximity rate limiting. |
| `assignedResponder` | `ObjectId` | Reference to `Responder` document. |
| `meta` | `Mixed` | Optional category-specific fields (e.g., water depth, trapped count). |

### `responders` Collection

| Field | Type | Validation / Notes |
| :--- | :--- | :--- |
| `name` | `String` | Required unit identifier (e.g., `NDRF Team Alpha`). |
| `team` | `String` | Enum: `NDRF`, `FIRE`, `MEDICAL`, `POLICE`. |
| `currentLocation` | GeoJSON `Point` | Optional `{ type: 'Point', coordinates: [lng, lat] }`. |
| `status` | `String` | Enum: `AVAILABLE`, `DISPATCHED`, `ON_SCENE`, `OFF_DUTY`. |
| `assignedIncidents` | `[ObjectId]` | Array of active `Incident` references. |

### Index Execution Profile (`npm run explain`)

Running `node server/scripts/explain-indexes.js` profiles the three core query patterns using `.explain("executionStats")` against the 20-incident / 12-responder Bangalore dataset to verify index usage and confirm zero `COLLSCAN` stages:

| Query Pattern | Winning Stage | Index Used | Keys Examined | Docs Examined | Time (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Incident `$nearSphere` proximity search | `IXSCAN` | `location_2dsphere` | 20 | 20 | ~1 ms |
| Admin dashboard filtered feed | `IXSCAN` | `status_1_severity_-1_createdAt_-1` | 12 | 12 | ~0 ms |
| Nearest available responder lookup | `IXSCAN` | `currentLocation_2dsphere` | 12 | 9 | ~1 ms |

---

## REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Returns `200 OK` when Express and the MongoDB Atlas connection are ready (`503` otherwise). |
| `POST` | `/api/incidents` | Creates an incident (`201`), replays an existing `clientReportId` (`200`), or blocks 500m/10m duplicate reports (`409`). |
| `GET` | `/api/incidents` | Lists incidents with optional `status`, `category`, and `severity` filters. |
| `GET` | `/api/incidents/nearby` | Executes `$geoNear` within `radius` (meters) of `lng` and `lat`, excluding `RESOLVED` incidents. |
| `GET` | `/api/incidents/cluster` | Aggregates active incidents within `radius` by category (`count`, `avgSeverity`, `maxSeverity`, `nearestDistanceM`). |
| `GET` | `/api/incidents/:id` | Fetches a single incident with populated responder details. |
| `PATCH` | `/api/incidents/:id/status` | Transitions incident lifecycle status (`NEW` -> `VERIFIED` -> `ASSIGNED` -> `RESOLVED`). |
| `PATCH` | `/api/incidents/:id/assign` | Atomically assigns an `AVAILABLE` responder and transitions incident status to `ASSIGNED`. |
| `GET` | `/api/responders` | Lists responder units with optional `status` and `team` filters. |
| `GET` | `/api/responders/nearest` | Queries `$geoNear` for `AVAILABLE` responders sorted by distance in meters. |
| `POST` | `/api/responders` | Creates a responder unit. |
| `PATCH` | `/api/responders/:id/location` | Updates a responder's live `[lng, lat]` position. |
| `PATCH` | `/api/responders/:id/status` | Updates a responder's operational status. |

### Example Queries

```bash
# Find active incidents within 3km of central Bangalore (MG Road)
curl "http://localhost:3000/api/incidents/nearby?lng=77.6066&lat=12.9756&radius=3000"

# Aggregate incident counts and severity by category within 5km
curl "http://localhost:3000/api/incidents/cluster?lng=77.6066&lat=12.9756&radius=5000"

# Submit an incident report with an explicit clientReportId
curl -X POST http://localhost:3000/api/incidents \
  -H "Content-Type: application/json" \
  -d '{
    "clientReportId": "rep-2026-001",
    "reporterDeviceId": "dev-local-01",
    "category": "flood",
    "severity": 4,
    "description": "Waterlogging blocking underpass",
    "location": { "type": "Point", "coordinates": [77.6112, 12.9345] }
  }'
```

---

## Repository Structure

```text
GeoShield/
├── .github/workflows/ci.yml       # Syntax check and integration test pipeline
├── public/
│   ├── index.html                 # Citizen reporting interface
│   ├── admin.html                 # Operations dashboard
│   ├── manifest.json              # Web App Manifest
│   ├── sw.js                      # Service Worker (shell cache + background sync)
│   ├── css/style.css              # Shared layout and map styles
│   └── js/
│       ├── citizen.js             # Map interaction, geolocation, submission flow
│       ├── admin.js               # Live markers, Socket.IO handlers, dispatch modal
│       ├── offlineQueue.js        # IndexedDB store wrapper
│       └── register-sw.js         # Service Worker registration and sync listener
├── server/
│   ├── index.js                   # Express app, HTTP server, Socket.IO, Change Stream
│   ├── config/db.js               # Mongoose connection lifecycle
│   ├── middleware/rateLimiter.js  # IP rate limiting (bypassed in test environment)
│   ├── models/
│   │   ├── Incident.js            # Incident schema, validators, and indexes
│   │   └── Responder.js           # Responder schema, validators, and indexes
│   ├── routes/
│   │   ├── incidents.js           # Incident CRUD, $geoNear, aggregation, assignment
│   │   └── responders.js          # Responder CRUD and nearest-available lookup
│   ├── scripts/explain-indexes.js # Query execution plan profiler
│   └── seeds/seed.js              # Idempotent Bangalore dataset upsert script
├── tests/
│   └── api.test.js                # Integration test suite (node:test + supertest)
├── .env.example
└── package.json
```

---

## Local Setup & Testing

### Prerequisites
* Node.js 18+
* MongoDB Atlas cluster (M0 free tier or higher; replica set required for Change Streams)

### Setup

```bash
git clone [https://github.com/Manav-Shekhawat/GeoShield.git](https://github.com/Manav-Shekhawat/GeoShield.git)
cd GeoShield
npm install
cp .env.example .env
```

Add your MongoDB Atlas connection string to `.env`:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/geoshield?retryWrites=true&w=majority
PORT=3000
NODE_ENV=development
```

### Verification Commands

```bash
# 1. Seed the 20 Bangalore incidents and 12 responders (idempotent bulkWrite)
npm run seed

# 2. Inspect MongoDB index execution plans (confirms IXSCAN and 0 COLLSCANs)
npm run explain

# 3. Run the automated API integration test suite
npm test

# 4. Start the server
npm run dev
```

---

## Scope & Operational Limitations

* **Synthetic Data**: Seeded coordinates and responder units represent fictional scenarios across Bangalore neighborhoods for testing geospatial queries.
* **Offline Map Tiles**: The Service Worker caches the application shell (`index.html`, CSS, JS) and previously visited map tiles, but does not bulk-download OpenStreetMap raster tiles for offline regions in compliance with OSM tile usage policies.
* **Authentication**: Administrative endpoints are left open for local evaluation and coursework grading. Production deployment requires placing `/admin.html`, `/api/incidents/:id/*`, and Socket.IO namespaces behind session or JWT authentication middleware.