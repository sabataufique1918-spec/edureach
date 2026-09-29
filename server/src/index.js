import http from 'node:http';
import env from './config/env.js';
import log from './utils/logger.js';
import { connectMongo } from './config/db.js';
import getRedis from './config/redis.js';
import { createApp } from './app.js';
import { attachRealtime } from './realtime/socket.js';
import { initLedger } from './services/ledger/index.js';
import { ensureBucketReachable } from './services/storage.js';
import { retryPending } from './services/credentials.js';

async function main() {
  await connectMongo();
  getRedis();
  await initLedger();
  await ensureBucketReachable();

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server, app);

  // Sweep for credentials that could not be anchored while the uplink was
  // down. Ten minutes is frequent enough to clear a short outage and rare
  // enough to be invisible in load.
  const sweep = setInterval(() => {
    retryPending(20).catch((err) => log.warn(`anchor sweep failed: ${err.message}`));
  }, 10 * 60 * 1000);
  sweep.unref();

  server.listen(env.port, () => {
    log.info(`EduReach API listening on :${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not let a hung connection hold the process open forever.
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error(`startup failed: ${err.message}`);
  process.exit(1);
});
