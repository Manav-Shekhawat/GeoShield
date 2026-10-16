require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Incident = require('./models/Incident');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve citizen + admin frontend

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/incidents', require('./routes/incidents'));
app.use('/api/responders', require('./routes/responders'));

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  if (isDbConnected) {
    return res.status(200).json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  }
  return res.status(503).json({ status: 'unavailable', db: 'disconnected', timestamp: new Date().toISOString() });
});

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🟢 Admin client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔴 Admin client disconnected: ${socket.id}`);
  });
});

// ─── MongoDB Change Streams ───────────────────────────────────────────────────
// Watches the incidents collection and pushes live updates to all admin clients.
// Requires a MongoDB replica set (Atlas free tier qualifies).
let activeChangeStream = null;
let changeStreamRetryTimer = null;
const RETRY_INTERVAL_MS = 5000;

const startChangeStream = async () => {
  try {
    const pipeline = [
      { $match: { operationType: { $in: ['insert', 'update'] } } },
    ];

    activeChangeStream = Incident.watch(pipeline, { fullDocument: 'updateLookup' });

    activeChangeStream.on('change', (change) => {
      if (change.operationType === 'insert') {
        console.log(`📍 New incident: ${change.fullDocument.category} (severity ${change.fullDocument.severity})`);
        io.emit('new-incident', change.fullDocument);
      } else if (change.operationType === 'update') {
        console.log(`🔄 Incident updated: ${change.documentKey._id}`);
        io.emit('incident-updated', {
          id: change.documentKey._id,
          fullDocument: change.fullDocument,
          updatedFields: change.updateDescription?.updatedFields,
        });
      }
    });

    activeChangeStream.on('error', (err) => {
      console.warn(`⚠️ Change Stream error: ${err.message}. Retrying in ${RETRY_INTERVAL_MS / 1000}s...`);
      if (activeChangeStream) {
        activeChangeStream.close().catch(() => {});
        activeChangeStream = null;
      }
      clearTimeout(changeStreamRetryTimer);
      changeStreamRetryTimer = setTimeout(startChangeStream, RETRY_INTERVAL_MS);
    });

    console.log('👁️  MongoDB Change Stream active — watching incidents collection');
  } catch (err) {
    console.warn(`⚠️ Failed to start Change Stream: ${err.message}. Retrying in ${RETRY_INTERVAL_MS / 1000}s...`);
    clearTimeout(changeStreamRetryTimer);
    changeStreamRetryTimer = setTimeout(startChangeStream, RETRY_INTERVAL_MS);
  }
};

const stopChangeStream = async () => {
  clearTimeout(changeStreamRetryTimer);
  if (activeChangeStream) {
    await activeChangeStream.close().catch(() => {});
    activeChangeStream = null;
  }
};

// ─── Start Server ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  connectDB().then(() => {
    startChangeStream();

    server.listen(PORT, () => {
      console.log(`\n🚀 GeoShield server running at http://localhost:${PORT}`);
      console.log(`   Citizen App      → http://localhost:${PORT}/index.html`);
      console.log(`   Admin Dashboard  → http://localhost:${PORT}/admin.html\n`);
    });
  });
}

module.exports = { app, server, startChangeStream, stopChangeStream };
