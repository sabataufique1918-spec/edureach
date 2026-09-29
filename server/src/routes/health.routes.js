import express from 'express';
import mongoose from 'mongoose';
import { redisHealthy } from '../config/redis.js';
import { ledgerBackend } from '../services/ledger/index.js';
import { queueDepth } from '../services/queue.js';
import { headObject } from '../services/storage.js';
import { wrap } from '../middleware/error.js';

const router = express.Router();

// Liveness: is the process up. Kept free of dependency checks so a Redis blip
// never causes an orchestrator to restart a working API.
router.get('/live', (req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));

// Readiness: the full picture, for operators rather than for load balancers.
router.get(
  '/ready',
  wrap(async (req, res) => {
    const mongoState = mongoose.connection.readyState === 1;
    const storage = await headObject('__healthcheck__').then(() => true).catch(() => false);
    const queue = await queueDepth().catch(() => null);

    const checks = {
      mongo: mongoState,
      redis: redisHealthy(),
      objectStorage: storage,
      ledger: ledgerBackend(),
      transcodeQueue: queue,
    };

    // Mongo is the only hard dependency. The rest degrade rather than fail.
    return res.status(mongoState ? 200 : 503).json({ ok: mongoState, checks });
  })
);

export default router;
