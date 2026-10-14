const mongoose = require('mongoose');

// ── GeoJSON coordinate validator — same constraints as Incident model ──────
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

const ResponderSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    team: {
      type: String,
      enum: ['NDRF', 'FIRE', 'MEDICAL', 'POLICE'],
      required: true,
    },

    // Live GPS location — updated as the responder moves.
    // NOT defaulted to empty coordinates — an omitted location will fail validation if provided partially.
    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
        validate: geoCoordValidator,
      },
    },

    status: {
      type: String,
      enum: ['AVAILABLE', 'DISPATCHED', 'ON_SCENE', 'OFF_DUTY'],
      default: 'AVAILABLE',
    },

    // Incidents currently assigned to this responder
    assignedIncidents: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Incident',
      },
    ],

    contactNumber: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// 2dsphere index for finding nearest available responders
ResponderSchema.index({ currentLocation: '2dsphere' });

// Filter by status + team quickly
ResponderSchema.index({ status: 1, team: 1 });

module.exports = mongoose.model('Responder', ResponderSchema);
