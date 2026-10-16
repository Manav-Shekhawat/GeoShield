/**
 * Seed script — idempotent upsert of Bangalore demo data.
 * Run with: npm run seed
 *
 * Uses bulkWrite with upsert:true so running this script multiple times
 * never creates duplicate documents and never destroys unrelated data.
 *
 * Incidents use deterministic clientReportId keys (seed-blr-inc-01 … seed-blr-inc-20)
 * so the sparse unique index is satisfied on every run.
 *
 * Coordinates are [longitude, latitude] — GeoJSON order.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const Responder = require('../models/Responder');

// Bangalore city center: 77.5946° E, 12.9716° N

const INCIDENTS = [
  // MG Road area
  { id: 'seed-blr-inc-01', lng: 77.6072, lat: 12.9762, category: 'flood',               severity: 5, description: 'Severe waterlogging near MG Road underpass. Vehicles stranded.',                     deviceId: 'seed-dev-001' },
  { id: 'seed-blr-inc-02', lng: 77.6100, lat: 12.9750, category: 'medical',             severity: 4, description: 'Person collapsed near Brigade Road. Requires immediate ambulance.',                   deviceId: 'seed-dev-002' },
  // Koramangala
  { id: 'seed-blr-inc-03', lng: 77.6245, lat: 12.9352, category: 'flood',               severity: 4, description: 'Koramangala 6th Block, knee-deep water flooding homes.',                             deviceId: 'seed-dev-003' },
  { id: 'seed-blr-inc-04', lng: 77.6270, lat: 12.9340, category: 'structural_collapse', severity: 5, description: 'Old building wall collapsed on 80 Feet Road. People may be trapped.',                deviceId: 'seed-dev-004' },
  { id: 'seed-blr-inc-05', lng: 77.6220, lat: 12.9380, category: 'road_accident',       severity: 3, description: 'Multi-vehicle pile-up on Koramangala Inner Ring Road.',                              deviceId: 'seed-dev-005' },
  // Indiranagar
  { id: 'seed-blr-inc-06', lng: 77.6411, lat: 12.9784, category: 'fire',               severity: 5, description: 'Commercial building fire on 100 Feet Road, Indiranagar. Smoke visible.',             deviceId: 'seed-dev-006' },
  { id: 'seed-blr-inc-07', lng: 77.6380, lat: 12.9790, category: 'medical',             severity: 3, description: 'Electric shock victim near Indiranagar metro station.',                              deviceId: 'seed-dev-007' },
  // Whitefield
  { id: 'seed-blr-inc-08', lng: 77.7480, lat: 12.9698, category: 'flood',               severity: 3, description: 'Whitefield ITPL road waterlogged. IT employees stranded.',                          deviceId: 'seed-dev-008' },
  { id: 'seed-blr-inc-09', lng: 77.7500, lat: 12.9710, category: 'road_accident',       severity: 4, description: 'Truck overturned near Whitefield main road blocking both lanes.',                    deviceId: 'seed-dev-009' },
  // Banashankari
  { id: 'seed-blr-inc-10', lng: 77.5640, lat: 12.9257, category: 'flood',               severity: 4, description: 'Banashankari stage 2, residential area flooded, elderly need evacuation.',          deviceId: 'seed-dev-010' },
  { id: 'seed-blr-inc-11', lng: 77.5620, lat: 12.9240, category: 'medical',             severity: 5, description: 'Pregnant woman needs emergency transport, road inaccessible.',                      deviceId: 'seed-dev-011' },
  // Marathahalli
  { id: 'seed-blr-inc-12', lng: 77.7022, lat: 12.9591, category: 'structural_collapse', severity: 4, description: 'Under-construction building partially collapsed near Marathahalli bridge.',           deviceId: 'seed-dev-012' },
  { id: 'seed-blr-inc-13', lng: 77.7000, lat: 12.9600, category: 'fire',               severity: 3, description: 'Electrical fire in apartment complex near Outer Ring Road.',                         deviceId: 'seed-dev-013' },
  // Electronic City
  { id: 'seed-blr-inc-14', lng: 77.6741, lat: 12.8452, category: 'flood',               severity: 2, description: 'Minor waterlogging near Hosur Road flyover.',                                       deviceId: 'seed-dev-014' },
  { id: 'seed-blr-inc-15', lng: 77.6780, lat: 12.8470, category: 'road_accident',       severity: 2, description: 'Two-wheeler skid due to wet road. Minor injuries.',                                 deviceId: 'seed-dev-015' },
  // Rajajinagar
  { id: 'seed-blr-inc-16', lng: 77.5560, lat: 12.9986, category: 'fire',               severity: 4, description: 'Market fire near Rajajinagar 1st Block. Multiple shops affected.',                   deviceId: 'seed-dev-016' },
  { id: 'seed-blr-inc-17', lng: 77.5540, lat: 12.9970, category: 'other',               severity: 2, description: 'Fallen tree blocking main road near Dr Rajkumar Road.',                             deviceId: 'seed-dev-017' },
  // Malleshwaram
  { id: 'seed-blr-inc-18', lng: 77.5726, lat: 13.0037, category: 'medical',             severity: 4, description: 'Elderly person found unconscious near Malleshwaram circle.',                        deviceId: 'seed-dev-018' },
  { id: 'seed-blr-inc-19', lng: 77.5700, lat: 13.0020, category: 'flood',               severity: 3, description: 'Stormwater drain overflowing near 8th Cross, Malleshwaram.',                       deviceId: 'seed-dev-019' },
  // Jayanagar
  { id: 'seed-blr-inc-20', lng: 77.5830, lat: 12.9258, category: 'structural_collapse', severity: 3, description: 'Compound wall collapsed due to rain near Jayanagar 4th Block.',                    deviceId: 'seed-dev-020' },
];

const RESPONDERS = [
  { name: 'NDRF Team Alpha',           team: 'NDRF',    lng: 77.5946, lat: 12.9716, status: 'AVAILABLE',  contact: '9900001111' },
  { name: 'NDRF Team Bravo',           team: 'NDRF',    lng: 77.6411, lat: 12.9784, status: 'AVAILABLE',  contact: '9900002222' },
  { name: 'NDRF Team Charlie',         team: 'NDRF',    lng: 77.7022, lat: 12.9591, status: 'DISPATCHED', contact: '9900003333' },
  { name: 'Fire Station Koramangala',  team: 'FIRE',    lng: 77.6245, lat: 12.9352, status: 'AVAILABLE',  contact: '9900004444' },
  { name: 'Fire Station Indiranagar',  team: 'FIRE',    lng: 77.6380, lat: 12.9790, status: 'ON_SCENE',   contact: '9900005555' },
  { name: 'Fire Station Rajajinagar',  team: 'FIRE',    lng: 77.5560, lat: 12.9986, status: 'AVAILABLE',  contact: '9900006666' },
  { name: 'Ambulance Unit 1 - South',  team: 'MEDICAL', lng: 77.5830, lat: 12.9258, status: 'AVAILABLE',  contact: '9900007777' },
  { name: 'Ambulance Unit 2 - East',   team: 'MEDICAL', lng: 77.7000, lat: 12.9600, status: 'AVAILABLE',  contact: '9900008888' },
  { name: 'Ambulance Unit 3 - North',  team: 'MEDICAL', lng: 77.5726, lat: 13.0037, status: 'DISPATCHED', contact: '9900009999' },
  { name: 'Traffic Police - MG Road',  team: 'POLICE',  lng: 77.6072, lat: 12.9762, status: 'ON_SCENE',   contact: '9900010000' },
  { name: 'Police Control - Central',  team: 'POLICE',  lng: 77.5946, lat: 12.9716, status: 'AVAILABLE',  contact: '9900011111' },
  { name: 'Police Unit - Whitefield',  team: 'POLICE',  lng: 77.7480, lat: 12.9698, status: 'AVAILABLE',  contact: '9900012222' },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB Atlas');
    // ── Purge legacy un-keyed duplicates & sync indexes ────────────────────
    const deletedLegacyIncidents = await Incident.deleteMany({ clientReportId: null });
    if (deletedLegacyIncidents.deletedCount > 0) {
      console.log(`🧹 Purged ${deletedLegacyIncidents.deletedCount} legacy un-keyed incident(s)`);
    }

    const seedResponderNames = RESPONDERS.map((r) => r.name);
    const deletedExtraResponders = await Responder.deleteMany({ name: { $nin: seedResponderNames } });
    if (deletedExtraResponders.deletedCount > 0) {
      console.log(`🧹 Purged ${deletedExtraResponders.deletedCount} duplicate/legacy responder(s)`);
    }

    await Incident.syncIndexes();
    await Responder.syncIndexes();
    console.log('🔄 Synced MongoDB collection indexes');

    // ── Incidents: idempotent upsert by clientReportId ─────────────────────
    const now = Date.now();
    const incidentOps = INCIDENTS.map(({ id, lng, lat, deviceId, ...i }, idx) => ({
      updateOne: {
        filter: { clientReportId: id },
        update: {
          $setOnInsert: {
            clientReportId: id,
            location: { type: 'Point', coordinates: [lng, lat] },
            reporterDeviceId: deviceId,
            createdAt: new Date(now - idx * 18 * 60 * 1000),
            status: ['NEW', 'NEW', 'VERIFIED', 'NEW', 'ASSIGNED'][idx % 5],
            ...i,
          },
        },
        upsert: true,
      },
    }));

    const incResult = await Incident.bulkWrite(incidentOps, { ordered: false });
    console.log(`📍 Incidents — upserted: ${incResult.upsertedCount}, matched (already existed): ${incResult.matchedCount}`);

    // ── Responders: idempotent upsert by name ──────────────────────────────
    const responderOps = RESPONDERS.map(({ lng, lat, contact, ...r }) => ({
      updateOne: {
        filter: { name: r.name },
        update: {
          $setOnInsert: {
            currentLocation: { type: 'Point', coordinates: [lng, lat] },
            contactNumber: contact,
            ...r,
          },
        },
        upsert: true,
      },
    }));

    const respResult = await Responder.bulkWrite(responderOps, { ordered: false });
    console.log(`👮 Responders — upserted: ${respResult.upsertedCount}, matched (already existed): ${respResult.matchedCount}`);

    console.log('\n🎉 Seed complete (idempotent — safe to run again)!');
    console.log('   Start server: npm run dev');
    console.log('   Admin map:    http://localhost:3000/admin.html\n');
  } catch (err) {
    console.error('❌ Seed error:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

seed();
