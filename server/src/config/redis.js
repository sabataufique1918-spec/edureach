import Redis from 'ioredis';
import env from './env.js';
import log from '../utils/logger.js';

// Redis is a cache and a queue here, never a source of truth. If it is
// unavailable the API keeps serving - it just gets slower and the
// transcode queue stalls, which is preferable to a hard outage.
let client = null;
let degraded = false;

export function getRedis() {
  if (client) return client;
  client = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    lazyConnect: false,
  });
  client.on('error', (err) => {
    if (!degraded) {
      degraded = true;
      log.warn(`redis degraded: ${err.message}`);
    }
  });
  client.on('ready', () => {
    degraded = false;
    log.info('redis ready');
  });
  return client;
}

export function redisHealthy() {
  return Boolean(client) && client.status === 'ready';
}

export default getRedis;
