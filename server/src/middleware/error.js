import log from '../utils/logger.js';

export function notFound(req, res) {
  res.status(404).json({ error: `no route for ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error(err);

  // Mongo duplicate key: almost always a replayed offline operation, which is
  // a conflict rather than a server fault.
  if (err.code === 11000) {
    return res.status(409).json({ error: 'duplicate operation', keys: Object.keys(err.keyPattern || {}) });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'validation failed', detail: err.message });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `invalid id: ${err.value}` });
  }

  return res.status(status).json({
    error: status >= 500 ? 'internal server error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && status >= 500 ? { detail: err.message } : {}),
  });
}

// Removes the try/catch boilerplate from every async handler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export default { notFound, errorHandler, wrap };
