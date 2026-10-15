const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const Responder = require('../models/Responder');
const { incidentLimiter, readLimiter } = require('../middleware/rateLimiter');

// ── ObjectId validation helper ────────────────────────────────────────────
function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ─── POST /api/incidents ─────────────────────────────────────────────────────
// Submit a new distress signal.
// Idempotency: if clientReportId already exists → return 200 + existing doc.
// Spam dedup:  same deviceId within 500 m / 10 min → return 409.
router.post('/', incidentLimiter, async (req, res) => {
  try {
    const { lng, lat, category, severity, description, deviceId, meta, clientReportId } = req.body;

    // ── Input validation ───────────────────────────────────────────────────
    if (lng === undefined || lat === undefined || !category || severity === undefined || !deviceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: lng, lat, category, severity, deviceId',
      });
    }

    const parsedLng = parseFloat(lng);
    const parsedLat = parseFloat(lat);

    if (
      !Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180 ||
      !Number.isFinite(parsedLat) || parsedLat < -90  || parsedLat > 90
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coordinates. lng must be -180–180, lat must be -90–90.',
      });
    }

    const parsedSeverity = parseInt(severity, 10);
    if (isNaN(parsedSeverity) || parsedSeverity < 1 || parsedSeverity > 5) {
      return res.status(400).json({
        success: false,
        error: 'severity must be an integer between 1 and 5.',
      });
    }

    const coordinates = [parsedLng, parsedLat];

    // ── Idempotency check ──────────────────────────────────────────────────
    // If clientReportId was provided and the document already exists,
    // return the existing document rather than creating a duplicate.
    if (clientReportId) {
      const existing = await Incident.findOne({ clientReportId });
      if (existing) {
        res.set('X-Idempotent-Replay', 'true');
        return res.status(200).json({
          success: true,
          idempotentReplay: true,
          data: existing,
        });
      }
    }

    // ── Proximity deduplication ────────────────────────────────────────────
    // Reject if same device reported within 500 m in the last 10 minutes.
    // This is a separate safeguard from idempotency — catches cases where
    // the user tries to file a brand-new report (different clientReportId)
    // for the same spot they already reported recently.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const proximityDuplicate = await Incident.findOne({
      reporterDeviceId: deviceId,
      createdAt: { $gte: tenMinutesAgo },
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates },
          $maxDistance: 500,
        },
      },
    });

    if (proximityDuplicate) {
      return res.status(409).json({
        success: false,
        error: 'Duplicate report detected. A similar incident was already reported nearby within the last 10 minutes.',
        existingId: proximityDuplicate._id,
      });
    }

    // ── Create incident ────────────────────────────────────────────────────
    const incidentData = {
      location: { type: 'Point', coordinates },
      category,
      severity: parsedSeverity,
      description: description || '',
      reporterDeviceId: deviceId,
      meta: meta || {},
    };

    // Only set clientReportId if provided — sparse index ignores nulls
    if (clientReportId) incidentData.clientReportId = clientReportId;

    let incident;
    try {
      incident = await Incident.create(incidentData);
    } catch (createErr) {
      // E11000 = duplicate key — clientReportId race condition (two concurrent requests)
      if (createErr.code === 11000 && (createErr.keyPattern?.clientReportId || createErr.message?.includes('clientReportId'))) {
        const existing = await Incident.findOne({ clientReportId });
        res.set('X-Idempotent-Replay', 'true');
        return res.status(200).json({
          success: true,
          idempotentReplay: true,
          data: existing,
        });
      }
      throw createErr;
    }

    return res.status(201).json({ success: true, data: incident });
  } catch (err) {
    console.error('POST /api/incidents error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/incidents/nearby ───────────────────────────────────────────────
router.get('/nearby', readLimiter, async (req, res) => {
  try {
    const { lng, lat, radius = 2000, status } = req.query;

    if (lng === undefined || lat === undefined || lng === '' || lat === '') {
      return res.status(400).json({ success: false, error: 'lng and lat are required' });
    }

    const parsedLng = parseFloat(lng);
    const parsedLat = parseFloat(lat);
    if (!Number.isFinite(parsedLng) || !Number.isFinite(parsedLat)) {
      return res.status(400).json({ success: false, error: 'Valid lng and lat numbers are required' });
    }

    const pipeline = [
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [parsedLng, parsedLat] },
          distanceField: 'distanceFromPoint',
          maxDistance: parseInt(radius, 10) || 2000,
          spherical: true,
        },
      },
    ];

    if (status) pipeline.push({ $match: { status } });
    pipeline.push({ $match: { status: { $ne: 'RESOLVED' } } });
    pipeline.push({ $sort: { severity: -1, distanceFromPoint: 1 } });

    const incidents = await Incident.aggregate(pipeline);

    res.json({
      success: true,
      count: incidents.length,
      radiusMetres: parseInt(radius, 10) || 2000,
      data: incidents,
    });
  } catch (err) {
    console.error('GET /api/incidents/nearby error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/incidents/cluster ─────────────────────────────────────────────
router.get('/cluster', readLimiter, async (req, res) => {
  try {
    const { lng, lat, radius = 5000 } = req.query;

    if (lng === undefined || lat === undefined || lng === '' || lat === '') {
      return res.status(400).json({ success: false, error: 'lng and lat are required' });
    }

    const parsedLng = parseFloat(lng);
    const parsedLat = parseFloat(lat);
    if (!Number.isFinite(parsedLng) || !Number.isFinite(parsedLat)) {
      return res.status(400).json({ success: false, error: 'Valid lng and lat numbers are required' });
    }

    const pipeline = [
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [parsedLng, parsedLat] },
          distanceField: 'distance',
          maxDistance: parseInt(radius, 10) || 5000,
          spherical: true,
          query: { status: { $ne: 'RESOLVED' } },
        },
      },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          avgSeverity: { $avg: '$severity' },
          maxSeverity: { $max: '$severity' },
          nearestDistanceM: { $min: '$distance' },
          latestReport: { $max: '$createdAt' },
          incidentIds: { $push: '$_id' },
        },
      },
      { $sort: { count: -1, avgSeverity: -1 } },
    ];

    const clusters = await Incident.aggregate(pipeline);

    res.json({
      success: true,
      radiusMetres: parseInt(radius, 10) || 5000,
      totalCategories: clusters.length,
      totalIncidents: clusters.reduce((sum, c) => sum + c.count, 0),
      data: clusters,
    });
  } catch (err) {
    console.error('GET /api/incidents/cluster error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/incidents ──────────────────────────────────────────────────────
router.get('/', readLimiter, async (req, res) => {
  try {
    const { status, category, severity, limit = 100 } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (category) filter.category = category;
    if (severity) filter.severity = parseInt(severity, 10);

    const incidents = await Incident.find(filter)
      .sort({ severity: -1, createdAt: -1 })
      .limit(parseInt(limit, 10))
      .populate('assignedResponder', 'name team status');

    res.json({ success: true, count: incidents.length, data: incidents });
  } catch (err) {
    console.error('GET /api/incidents error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/incidents/:id ──────────────────────────────────────────────────
router.get('/:id', readLimiter, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid incident ID format.' });
    }
    const incident = await Incident.findById(req.params.id).populate(
      'assignedResponder',
      'name team status contactNumber'
    );
    if (!incident) return res.status(404).json({ success: false, error: 'Incident not found' });
    res.json({ success: true, data: incident });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PATCH /api/incidents/:id/status ────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid incident ID format.' });
    }

    const { status, resolutionNotes } = req.body;
    const validStatuses = ['NEW', 'VERIFIED', 'ASSIGNED', 'RESOLVED'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const update = { status };
    if (resolutionNotes) update.resolutionNotes = resolutionNotes;

    const incident = await Incident.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );

    if (!incident) return res.status(404).json({ success: false, error: 'Incident not found' });
    res.json({ success: true, data: incident });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PATCH /api/incidents/:id/assign ────────────────────────────────────────
// Atomic conditional update: only assigns if responder is currently AVAILABLE.
// Two concurrent requests for the same responder → one succeeds (200), the second gets 409.
router.patch('/:id/assign', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid incident ID format.' });
    }

    const { responderId } = req.body;

    if (!responderId || !isValidId(responderId)) {
      return res.status(400).json({ success: false, error: 'Valid responderId is required.' });
    }

    // Verify the incident exists first
    const incident = await Incident.findById(req.params.id);
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Incident not found' });
    }

    // Atomic: only update responder if they are currently AVAILABLE.
    const responder = await Responder.findOneAndUpdate(
      { _id: responderId, status: 'AVAILABLE' },
      {
        $set: { status: 'DISPATCHED' },
        $addToSet: { assignedIncidents: incident._id },
      },
      { new: true }
    );

    if (!responder) {
      const exists = await Responder.exists({ _id: responderId });
      if (!exists) {
        return res.status(404).json({ success: false, error: 'Responder not found' });
      }
      return res.status(409).json({
        success: false,
        error: 'Responder is no longer available. They may have been assigned by another request.',
      });
    }

    // Update incident status and reference
    const updatedIncident = await Incident.findByIdAndUpdate(
      req.params.id,
      { assignedResponder: responderId, status: 'ASSIGNED' },
      { new: true }
    ).populate('assignedResponder', 'name team status');

    res.json({ success: true, data: updatedIncident });
  } catch (err) {
    console.error('PATCH /api/incidents/:id/assign error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
