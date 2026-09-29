import env from '../config/env.js';
import log from '../utils/logger.js';
import { connectMongo } from '../config/db.js';
import getRedis from '../config/redis.js';
import { Lecture } from '../models/index.js';
import { claimTranscode, ackTranscode, requeueStale } from '../services/queue.js';
import { processLecture } from '../services/transcode.js';
import { DEFAULT_LADDER } from '../services/mediaProfiles.js';

// Encoding runs in its own process so a long ffmpeg job can never make the API
// unresponsive. It scales by running more containers, not bigger ones.

let running = true;

async function handle(job) {
  const lecture = await Lecture.findById(job.lectureId);
  if (!lecture) {
    log.warn(`job for unknown lecture ${job.lectureId}, dropping`);
    return;
  }

  lecture.status = 'processing';
  lecture.failureReason = '';
  await lecture.save();

  try {
    const { info, renditions } = await processLecture(
      lecture,
      job.ladder || DEFAULT_LADDER,
      // Each rendition is committed as soon as it exists. Students can start
      // downloading the audio version while 240p is still encoding.
      async (rendition) => {
        await Lecture.updateOne(
          { _id: lecture._id },
          {
            $pull: { renditions: { mode: rendition.mode } },
          }
        );
        await Lecture.updateOne(
          { _id: lecture._id },
          {
            $push: { renditions: rendition },
            $set: { status: 'processing' },
            ...(rendition.slideCount ? { $max: { slideCount: rendition.slideCount } } : {}),
          }
        );
      }
    );

    await Lecture.updateOne(
      { _id: lecture._id },
      {
        $set: {
          status: 'ready',
          durationSec: info.durationSec,
          publishedAt: new Date(),
        },
      }
    );
    log.info(`lecture ${lecture._id} ready with ${renditions.length} rendition(s)`);
  } catch (err) {
    await Lecture.updateOne(
      { _id: lecture._id },
      { $set: { status: 'failed', failureReason: err.message.slice(0, 500) } }
    );
    log.error(`lecture ${lecture._id} failed: ${err.message}`);
  }
}

async function loop() {
  while (running) {
    try {
      const claimed = await claimTranscode(10);
      if (!claimed) {
        await requeueStale().catch(() => {});
        continue;
      }
      await handle(claimed.job);
      await ackTranscode(claimed.raw);
    } catch (err) {
      log.error(`worker loop error: ${err.message}`);
      // Back off rather than spin when Redis or Mongo is down.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  await connectMongo();
  getRedis();
  log.info(`transcode worker up (concurrency ${env.media.concurrency})`);

  const workers = Array.from({ length: Math.max(1, env.media.concurrency) }, () => loop());
  await Promise.all(workers);
}

const stop = (signal) => {
  log.info(`${signal} received, finishing current job then exiting`);
  running = false;
  setTimeout(() => process.exit(0), 30000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

main().catch((err) => {
  log.error(`worker startup failed: ${err.message}`);
  process.exit(1);
});
