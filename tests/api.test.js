/**
 * tests/api.test.js
 * Automated integration test suite for the GeoShield API.
 * Uses Node.js native test runner (node:test) + supertest.
 *
 * Run with: npm test
 */
process.env.NODE_ENV = 'test';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const mongoose = require('mongoose');

const connectDB = require('../server/config/db');
const { app, stopChangeStream } = require('../server/index');
const Incident = require('../server/models/Incident');
const Responder = require('../server/models/Responder');

const request = supertest(app);

// Bangalore center coordinates for tests
const TEST_LNG = 77.5946;
const TEST_LAT = 12.9716;

let testResponderId;
let testIncidentId;

before(async () => {
  if (mongoose.connection.readyState !== 1) {
    await connectDB();
  }

  // Sync indexes to ensure sparse unique index updates are applied
  await Incident.syncIndexes();
  await Responder.syncIndexes();

  // Pre-clean any leftover test records
  await Incident.deleteMany({ clientReportId: /^test-suite-/ });
  await Incident.deleteMany({ reporterDeviceId: /^test-suite-/ });
  await Responder.deleteMany({ name: /^Test Unit/ });

  // Create dedicated test responder for assignment tests
  const responder = await Responder.create({
    name: 'Test Unit Alpha',
    team: 'NDRF',
    currentLocation: {
      type: 'Point',
      coordinates: [TEST_LNG, TEST_LAT],
    },
    status: 'AVAILABLE',
    contactNumber: '9999900000',
  });
  testResponderId = responder._id.toString();
});

after(async () => {
  try {
    // Clean up test documents only — seed data is untouched
    await Incident.deleteMany({ clientReportId: /^test-suite-/ });
    await Incident.deleteMany({ reporterDeviceId: /^test-suite-/ });
    await Responder.deleteMany({ name: /^Test Unit/ });

    if (typeof stopChangeStream === 'function') {
      await stopChangeStream();
    }
  } catch (err) {
    console.error('Test cleanup error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
});

// ─── 1. Health check ──────────────────────────────────────────────────────────
describe('1. GET /api/health', () => {
  it('returns 200 with status ok and db connected', async () => {
    const res = await request.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.db, 'connected');
    assert.ok(res.body.timestamp);
  });
});

// ─── 2. POST /api/incidents & Idempotency ──────────────────────────────────────
describe('2. POST /api/incidents — Valid Creation & Idempotency', () => {
  const clientReportId = 'test-suite-report-001';

  it('creates a valid incident and returns 201', async () => {
    const payload = {
      lng: TEST_LNG,
      lat: TEST_LAT,
      category: 'flood',
      severity: 4,
      description: 'Test flood incident near city center',
      deviceId: 'test-suite-device-001',
      clientReportId,
    };

    const res = await request.post('/api/incidents').send(payload);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.category, 'flood');
    assert.equal(res.body.data.severity, 4);
    assert.equal(res.body.data.clientReportId, clientReportId);
    testIncidentId = res.body.data._id;
  });

  it('returns 200 with idempotentReplay: true when exact same clientReportId is resent', async () => {
    const replayPayload = {
      lng: TEST_LNG + 0.05,
      lat: TEST_LAT + 0.05,
      category: 'fire',
      severity: 5,
      description: 'Modified payload attempting duplicate creation',
      deviceId: 'test-suite-device-002',
      clientReportId, // exact same key
    };

    const res = await request.post('/api/incidents').send(replayPayload);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.idempotentReplay, true);
    assert.equal(res.header['x-idempotent-replay'], 'true');
    // Confirms original document is preserved
    assert.equal(res.body.data.category, 'flood');
    assert.equal(res.body.data.clientReportId, clientReportId);
  });

  it('allows multiple incidents omitting clientReportId from different devices without E11000 collision', async () => {
    const res1 = await request.post('/api/incidents').send({
      lng: TEST_LNG + 0.08,
      lat: TEST_LAT + 0.08,
      category: 'medical',
      severity: 2,
      description: 'Incident without clientReportId 1',
      deviceId: 'test-suite-unkeyed-device-1',
    });
    assert.equal(res1.status, 201);
    assert.equal(res1.body.success, true);
    assert.equal(res1.body.data.clientReportId, undefined);

    const res2 = await request.post('/api/incidents').send({
      lng: TEST_LNG + 0.12,
      lat: TEST_LAT + 0.12,
      category: 'road_accident',
      severity: 3,
      description: 'Incident without clientReportId 2',
      deviceId: 'test-suite-unkeyed-device-2',
    });
    assert.equal(res2.status, 201);
    assert.equal(res2.body.success, true);
    assert.equal(res2.body.data.clientReportId, undefined);
  });
});

// ─── 3. POST /api/incidents — Validation Errors ───────────────────────────────
describe('3. POST /api/incidents — Validation Constraints', () => {
  it('rejects out-of-range coordinates (lng: 200) with 400', async () => {
    const res = await request.post('/api/incidents').send({
      lng: 200, // Invalid: exceeds 180
      lat: TEST_LAT,
      category: 'medical',
      severity: 3,
      deviceId: 'test-suite-device-bad-coords',
      clientReportId: 'test-suite-bad-coords',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /coordinates/i);
  });

  it('rejects invalid severity (severity: 9) with 400', async () => {
    const res = await request.post('/api/incidents').send({
      lng: TEST_LNG,
      lat: TEST_LAT,
      category: 'medical',
      severity: 9, // Invalid: exceeds 5
      deviceId: 'test-suite-device-bad-sev',
      clientReportId: 'test-suite-bad-sev',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /severity/i);
  });
});

// ─── 4. GET /api/incidents/nearby ─────────────────────────────────────────────
describe('4. GET /api/incidents/nearby', () => {
  it('returns nearby incidents with calculated distances within radius', async () => {
    const res = await request
      .get('/api/incidents/nearby')
      .query({ lng: TEST_LNG, lat: TEST_LAT, radius: 5000 });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.count >= 1, 'Expected at least one nearby incident');

    // Verify distance field is added and distance is within radius
    const first = res.body.data[0];
    assert.ok(first.distanceFromPoint !== undefined, 'distanceFromPoint must be present');
    assert.ok(first.distanceFromPoint <= 5000, 'distance must be within radius');
  });
});

// ─── 5. GET /api/incidents/cluster ───────────────────────────────────────────
describe('5. GET /api/incidents/cluster', () => {
  it('returns category aggregation groups within 10km radius', async () => {
    const res = await request
      .get('/api/incidents/cluster')
      .query({ lng: TEST_LNG, lat: TEST_LAT, radius: 10000 });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.totalCategories >= 1);
    assert.ok(res.body.totalIncidents >= 1);

    const cluster = res.body.data[0];
    assert.ok(cluster._id, 'Cluster must have category _id');
    assert.ok(typeof cluster.count === 'number');
    assert.ok(typeof cluster.avgSeverity === 'number');
  });
});

// ─── 6. PATCH /api/incidents/:id/assign ──────────────────────────────────────
describe('6. PATCH /api/incidents/:id/assign — Atomic Assignment', () => {
  it('atomically assigns an AVAILABLE responder and returns 200', async () => {
    assert.ok(testIncidentId, 'testIncidentId must exist from previous test');

    const res = await request
      .patch(`/api/incidents/${testIncidentId}/assign`)
      .send({ responderId: testResponderId });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'ASSIGNED');
    assert.equal(res.body.data.assignedResponder._id, testResponderId);

    // Verify responder status is now DISPATCHED in database
    const responderDoc = await Responder.findById(testResponderId);
    assert.equal(responderDoc.status, 'DISPATCHED');
  });

  it('rejects a second assignment to that same responder with 409 Conflict', async () => {
    // Create a second test incident
    const secondInc = await Incident.create({
      location: { type: 'Point', coordinates: [TEST_LNG + 0.002, TEST_LAT + 0.002] },
      category: 'medical',
      severity: 3,
      reporterDeviceId: 'test-suite-device-003',
      clientReportId: 'test-suite-second-incident',
    });

    const res = await request
      .patch(`/api/incidents/${secondInc._id}/assign`)
      .send({ responderId: testResponderId }); // Already DISPATCHED

    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /no longer available/i);
  });
});
