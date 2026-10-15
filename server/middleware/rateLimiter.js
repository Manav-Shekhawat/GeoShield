const rateLimit = require('express-rate-limit');

/**
 * Limit incident submission to 10 reports per IP per 15 minutes.
 * Prevents spam flooding the dashboard during a real incident.
 * In test environment (NODE_ENV === 'test'), rate limiting is skipped.
 */
const incidentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skip: () => process.env.NODE_ENV === 'test',
  message: {
    success: false,
    error: 'Too many reports submitted. Please wait 15 minutes before submitting again.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * More generous limit for read-only endpoints (admin dashboard queries).
 */
const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
  skip: () => process.env.NODE_ENV === 'test',
  message: {
    success: false,
    error: 'Too many requests. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { incidentLimiter, readLimiter };
