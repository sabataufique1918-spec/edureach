import getRedis, { redisHealthy } from '../config/redis.js';

// Read-through cache with a hard rule: a cache miss or a Redis outage must
// never turn into a failed request. Every helper falls through to the loader.
export async function cached(key, ttlSec, loader) {
  if (!redisHealthy()) return loader();
  const redis = getRedis();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch {
    return loader();
  }
  const value = await loader();
  try {
    await redis.setex(key, ttlSec, JSON.stringify(value));
  } catch {
    // Cache write failures are not request failures.
  }
  return value;
}

export async function invalidate(...keys) {
  if (!redisHealthy() || keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch {
    // Stale entries expire on their own TTL.
  }
}

export const keys = {
  courseList: (userId) => `c:courses:${userId}`,
  lectureManifest: (lectureId) => `c:manifest:${lectureId}`,
  quizPayload: (quizId, version) => `c:quiz:${quizId}:${version}`,
  discussionPage: (courseId, sinceSeq) => `c:disc:${courseId}:${sinceSeq}`,
};

export default { cached, invalidate, keys };
