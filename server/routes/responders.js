const express = require('express');
const router = express.Router();
const Responder = require('../models/Responder');
const { readLimiter } = require('../middleware/rateLimiter');

// ─── GET /api/responders ─────────────────────────────────────────────────────
router.get('/', readLimiter, async (req, res) => {
  try {
    const { status, team } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (team) filter.team = team;

    const responders = await Responder.find(filter).populate(
      'assignedIncidents',
      'category severity status'
    );
    res.json({ success: true, count: responders.length, data: responders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/responders/nearest ─────────────────────────────────────────────
// Find the nearest AVAILABLE responders to given coordinates.
// Uses $geoNear on the responders collection.
router.get('/nearest', readLimiter, async (req, res) => {
  try {
    const { lng, lat, limit = 5, team } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({ success: false, error: 'lng and lat are required' });
    }

    const matchStage = { status: 'AVAILABLE' };
    if (team) matchStage.team = team;

    const pipeline = [
      {
        $geoNear: {
          near: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          distanceField: 'distanceFromIncident',
          spherical: true,
          query: matchStage,
        },
      },
      { $limit: parseInt(limit) },
    ];

    const responders = await Responder.aggregate(pipeline);
    res.json({ success: true, count: responders.length, data: responders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/responders ─────────────────────────────────────────────────────
// Create a new responder (admin action / seeding)
router.post('/', async (req, res) => {
  try {
    const responder = await Responder.create(req.body);
    res.status(201).json({ success: true, data: responder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PATCH /api/responders/:id/location ──────────────────────────────────────
// Update a responder's live GPS position
router.patch('/:id/location', async (req, res) => {
  try {
    const { lng, lat } = req.body;
    if (!lng || !lat) {
      return res.status(400).json({ success: false, error: 'lng and lat are required' });
    }

    const responder = await Responder.findByIdAndUpdate(
      req.params.id,
      {
        currentLocation: {
          type: 'Point',
          coordinates: [parseFloat(lng), parseFloat(lat)],
        },
      },
      { new: true }
    );

    if (!responder) return res.status(404).json({ success: false, error: 'Responder not found' });
    res.json({ success: true, data: responder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PATCH /api/responders/:id/status ────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['AVAILABLE', 'DISPATCHED', 'ON_SCENE', 'OFF_DUTY'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const responder = await Responder.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!responder) return res.status(404).json({ success: false, error: 'Responder not found' });
    res.json({ success: true, data: responder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
