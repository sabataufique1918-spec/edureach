import express from 'express';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { applyBatch, pullChanges, SUPPORTED_OPS } from '../services/syncEngine.js';

const router = express.Router();

// The connectivity probe is deliberately public and sits above the auth
// middleware. The client polls it to decide whether it is online at all,
// including from the login screen where there is no token yet, and it must
// not cost a database lookup on every poll.
router.get('/ping', (req, res) => res.json({ ok: 1, t: Date.now() }));

router.use(requireAuth, loadUser);

// Push: the device drains its outbox here the moment it sees a connection.
router.post(
  '/push',
  wrap(async (req, res) => {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (ops.length === 0) {
      return res.status(400).json({ error: 'ops array is required', supported: SUPPORTED_OPS });
    }
    // Bounded so a device that was offline for a month cannot open a request
    // that takes longer than the connection will survive.
    if (ops.length > 100) {
      return res.status(413).json({ error: 'send at most 100 operations per batch' });
    }
    return res.json(await applyBatch(ops, req.user));
  })
);

// Pull: cursor-based, so the response size tracks how much was missed rather
// than how much exists.
router.get(
  '/pull',
  wrap(async (req, res) => {
    const payload = await pullChanges(req.user, {
      since: req.query.since,
      discussionSeq: req.query.discussionSeq,
    });
    return res.json(payload);
  })
);

export default router;
