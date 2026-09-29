import getRedis from '../config/redis.js';
import log from '../utils/logger.js';

// A Redis list is enough of a queue here. Transcode jobs are minutes long and
// arrive a few times an hour, so a dedicated broker would be cost without
// benefit for a resource-constrained institute.
const PENDING = 'edureach:transcode:pending';
const WORKING = 'edureach:transcode:working';

export async function enqueueTranscode(job) {
  const redis = getRedis();
  await redis.lpush(PENDING, JSON.stringify({ ...job, enqueuedAt: Date.now() }));
  log.info(`queued transcode for lecture ${job.lectureId}`);
}

// Reliable pop: the job moves to a working list, and is only removed once the
// worker acknowledges it. A worker that dies mid-job leaves the entry behind
// for requeueStale to recover.
export async function claimTranscode(timeoutSec = 10) {
  const redis = getRedis();
  const raw = await redis.brpoplpush(PENDING, WORKING, timeoutSec);
  if (!raw) return null;
  return { raw, job: JSON.parse(raw) };
}

export async function ackTranscode(raw) {
  await getRedis().lrem(WORKING, 1, raw);
}

export async function requeueStale(maxAgeMs = 60 * 60 * 1000) {
  const redis = getRedis();
  const working = await redis.lrange(WORKING, 0, -1);
  let moved = 0;
  for (const raw of working) {
    try {
      const job = JSON.parse(raw);
      if (Date.now() - (job.enqueuedAt || 0) > maxAgeMs) {
        await redis.lrem(WORKING, 1, raw);
        await redis.lpush(PENDING, raw);
        moved += 1;
      }
    } catch {
      await redis.lrem(WORKING, 1, raw);
    }
  }
  if (moved) log.warn(`requeued ${moved} stale transcode job(s)`);
  return moved;
}

export async function queueDepth() {
  const redis = getRedis();
  const [pending, working] = await Promise.all([redis.llen(PENDING), redis.llen(WORKING)]);
  return { pending, working };
}

export default { enqueueTranscode, claimTranscode, ackTranscode, requeueStale, queueDepth };
