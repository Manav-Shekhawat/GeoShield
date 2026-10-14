const mongoose = require('mongoose');

// ── GeoJSON coordinate validator ──────────────────────────────────────────
const geoCoordValidator = {
  validator(coords) {
    if (!Array.isArray(coords) || coords.length !== 2) return false;
    const [lng, lat] = coords;
    return (
      Number.isFinite(lng) && lng >= -180 && lng <= 180 &&
      Number.isFinite(lat) && lat >= -90  && lat <= 90
    );
  },
  message: 'coordinates must be [longitude (-180–180), latitude (-90–90)] — both finite numbers.',
};

const IncidentSchema = new mongoose.Schema(
  {
    // GeoJSON Point — the core geospatial field
    // IMPORTANT: GeoJSON uses [longitude, latitude] order, NOT [lat, lng]!
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
        validate: geoCoordValidator,
      },
    },

    category: {
      type: String,
      enum: ['flood', 'fire', 'medical', 'structural_collapse', 'road_accident', 'other'],
      required: true,
    },

    severity: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },

    description: {
      type: String,
      maxlength: 500,
      default: '',
    },

    status: {
      type: String,
      enum: ['NEW', 'VERIFIED', 'ASSIGNED', 'RESOLVED'],
      default: 'NEW',
    },

    // ── Idempotency key ───────────────────────────────────────────────────
    // Client-generated UUID sent with every submission attempt.
    // Sparse unique index: if the same clientReportId arrives twice,
    // the second insert hits E11000 or duplicate check and is treated as an idempotent replay.
    clientReportId: {
      type: String,
      trim: true,
    },

    // Hashed device fingerprint for proximity deduplication
    // (separate concern from idempotency — catches same device, different UUIDs)
    reporterDeviceId: {
      type: String,
      required: true,
    },

    // Reference to the responder assigned to this incident
    assignedResponder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Responder',
      default: null,
    },

    resolutionNotes: {
      type: String,
      default: '',
    },

    // Polymorphic extra data — different categories can store different metadata
    // e.g. flood: { waterDepthMeters: 1.5 }, medical: { injuryType: 'fracture' }
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true, // auto createdAt + updatedAt
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────

// 1. The core 2dsphere index — enables $geoNear, $near, $geoWithin queries
IncidentSchema.index({ location: '2dsphere' });

// 2. Compound index for the admin dashboard's most common query pattern
IncidentSchema.index({ status: 1, severity: -1, createdAt: -1 });

// 3. Deduplication lookup index (proximity + time check)
IncidentSchema.index({ reporterDeviceId: 1, createdAt: -1 });

// 4. Sparse unique idempotency index — allows multiple null values (seed docs without id)
//    but enforces uniqueness for any non-null clientReportId
IncidentSchema.index(
  { clientReportId: 1 },
  { unique: true, sparse: true, name: 'clientReportId_unique_sparse' }
);

module.exports = mongoose.model('Incident', IncidentSchema);
