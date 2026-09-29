import express from 'express';
import { requireAuth, requireRole, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { usageSummary } from '../middleware/dataMeter.js';
import env from '../config/env.js';
import log from '../utils/logger.js';

const router = express.Router();
router.use(requireAuth, loadUser);

// The data meter the student sees. Served from this API because it is a
// per-user read that must work even when the analytics service is down.
router.get(
  '/usage',
  wrap(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const summary = await usageSummary(req.user._id, days);
    const budgetMb = req.user.dataBudgetMb || 0;
    return res.json({
      ...summary,
      budgetMb,
      remainingMb: budgetMb ? Number((budgetMb - summary.totalMb).toFixed(2)) : null,
      // Drives the green-to-red meter in the app.
      usedFraction: budgetMb ? Math.min(1, summary.totalMb / budgetMb) : null,
    });
  })
);

// Everything below proxies the Python service. It is kept behind this gateway
// so the analytics container never needs to be exposed publicly and never
// needs its own auth stack.
async function callAnalytics(path, params = {}) {
  const url = new URL(path, env.analytics.url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: { 'x-analytics-token': env.analytics.token },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`analytics returned ${response.status}`), { status: 502 });
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

router.get(
  '/course/:courseId/engagement',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    try {
      return res.json(await callAnalytics('/engagement', { course_id: req.params.courseId }));
    } catch (err) {
      log.warn(`analytics unavailable: ${err.message}`);
      return res.status(503).json({ error: 'analytics service is unavailable', retry: true });
    }
  })
);

// The model that matters pedagogically: who is quietly falling behind on a bad
// connection and needs a nudge before they drop out entirely.
router.get(
  '/course/:courseId/at-risk',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    try {
      return res.json(await callAnalytics('/at-risk', { course_id: req.params.courseId }));
    } catch (err) {
      log.warn(`analytics unavailable: ${err.message}`);
      return res.status(503).json({ error: 'analytics service is unavailable', retry: true });
    }
  })
);

router.get(
  '/course/:courseId/bandwidth',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    try {
      return res.json(await callAnalytics('/bandwidth', { course_id: req.params.courseId }));
    } catch (err) {
      return res.status(503).json({ error: 'analytics service is unavailable', retry: true });
    }
  })
);

export default router;
