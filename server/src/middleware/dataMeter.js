import DataUsage from '../models/DataUsage.js';
import log from '../utils/logger.js';

const today = () => new Date().toISOString().slice(0, 10);

// Byte accounting. Every response that carries media goes through here so the
// app can show an honest data meter instead of a guess.
export async function recordUsage(userId, bytes, mode = 'other') {
  if (!userId || !bytes || bytes <= 0) return;
  try {
    await DataUsage.updateOne(
      { user: userId, day: today() },
      { $inc: { bytes, [`byMode.${mode}`]: bytes } },
      { upsert: true }
    );
  } catch (err) {
    // Metering must never break a download in progress.
    log.warn(`usage accounting failed: ${err.message}`);
  }
}

export async function usageSummary(userId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = await DataUsage.find({ user: userId, day: { $gte: since } }).sort({ day: 1 }).lean();
  const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
  const byMode = {};
  for (const row of rows) {
    for (const [mode, bytes] of Object.entries(row.byMode || {})) {
      byMode[mode] = (byMode[mode] || 0) + bytes;
    }
  }
  return {
    days,
    totalBytes,
    totalMb: Number((totalBytes / 1048576).toFixed(2)),
    byMode,
    daily: rows.map((r) => ({ day: r.day, mb: Number((r.bytes / 1048576).toFixed(2)) })),
  };
}

// Attaches a counter to the response so handlers can meter streamed bodies
// without buffering them.
export function meterResponse(req, res, next) {
  res.meter = (bytes, mode) => recordUsage(req.auth?.sub, bytes, mode);
  next();
}

export default { recordUsage, usageSummary, meterResponse };
