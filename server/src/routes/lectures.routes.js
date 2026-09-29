import express from 'express';
import multer from 'multer';
import { Lecture, Course } from '../models/index.js';
import { requireAuth, requireRole, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { putObject } from '../services/storage.js';
import { enqueueTranscode, queueDepth } from '../services/queue.js';
import { DEFAULT_LADDER, MODE_ORDER, PROFILES, recommendMode } from '../services/mediaProfiles.js';
import { invalidate, keys } from '../services/cache.js';
import log from '../utils/logger.js';

const router = express.Router();

// Uploads are buffered in memory then pushed straight to object storage.
// 600 MB ceiling: a teacher recording a one-hour lecture on a phone.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 600 * 1024 * 1024 },
});

router.use(requireAuth, loadUser);

// Teacher upload. Returns immediately once the source is stored - encoding
// happens on the worker, so a teacher on a weak uplink is not left waiting.
router.post(
  '/',
  requireRole('teacher', 'admin'),
  upload.single('file'),
  wrap(async (req, res) => {
    const { courseId, title, description, ladder } = req.body || {};
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    if (!courseId || !title) return res.status(400).json({ error: 'courseId and title are required' });

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'course not found' });
    if (course.teacher.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'you do not teach this course' });
    }

    const lecture = await Lecture.create({
      course: course._id,
      teacher: req.user._id,
      title,
      description: description || '',
      status: 'uploaded',
    });

    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const sourceKey = `lectures/${lecture._id}/source/original.${ext}`;
    await putObject(sourceKey, req.file.buffer, req.file.mimetype || 'application/octet-stream');

    lecture.sourceKey = sourceKey;
    lecture.status = 'queued';
    await lecture.save();

    const requested = (ladder ? String(ladder).split(',') : DEFAULT_LADDER)
      .map((m) => m.trim())
      .filter((m) => MODE_ORDER.includes(m));

    // The source file is already safely in object storage, so a queue failure
    // must not lose the upload or report it as an error. The lecture is parked
    // as "uploaded" instead of "queued" and can be picked up with /rebuild
    // once the queue is back.
    let queued = true;
    try {
      await enqueueTranscode({
        lectureId: lecture._id.toString(),
        ladder: requested.length ? requested : DEFAULT_LADDER,
      });
    } catch (err) {
      queued = false;
      lecture.status = 'uploaded';
      lecture.failureReason = `could not reach the encoding queue: ${err.message}`;
      await lecture.save();
      log.warn(`lecture ${lecture._id} stored but not queued: ${err.message}`);
    }

    await invalidate(keys.courseList(req.user._id.toString()));

    return res.status(202).json({
      lecture: lecture.toManifest(),
      queued,
      message: queued
        ? 'upload stored, encoding queued'
        : 'upload stored safely, but the encoding queue is unreachable - retry with /rebuild',
      queue: await queueDepth().catch(() => ({ pending: null, working: null })),
    });
  })
);

// The manifest a student reads before spending any data: every available mode
// with its exact byte cost and integrity hash.
router.get(
  '/:id/manifest',
  wrap(async (req, res) => {
    const lecture = await Lecture.findById(req.params.id);
    if (!lecture) return res.status(404).json({ error: 'lecture not found' });

    const measuredKbps = Number(req.query.kbps || 0);
    return res.json({
      ...lecture.toManifest(),
      recommendedMode: measuredKbps ? recommendMode(measuredKbps) : req.user.preferredMode,
      profiles: Object.fromEntries(
        Object.entries(PROFILES).map(([mode, p]) => [
          mode,
          { label: p.label, bitrateKbps: p.bitrateKbps, estMbPerHour: p.estMbPerHour },
        ])
      ),
    });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const lecture = await Lecture.findById(req.params.id).populate('teacher', 'name');
    if (!lecture) return res.status(404).json({ error: 'lecture not found' });
    return res.json({
      ...lecture.toManifest(),
      teacher: lecture.teacher?.name || '',
      failureReason: lecture.failureReason || undefined,
    });
  })
);

// Delta sync for the offline library: only lectures that changed since the
// last successful sync are returned.
router.get(
  '/',
  wrap(async (req, res) => {
    const { courseId, since } = req.query;
    const filter = { status: 'ready' };
    if (courseId) filter.course = courseId;
    if (since) filter.updatedAt = { $gt: new Date(since) };

    const lectures = await Lecture.find(filter).sort({ updatedAt: -1 }).limit(200);
    return res.json({
      syncedAt: new Date().toISOString(),
      lectures: lectures.map((l) => l.toManifest()),
    });
  })
);

// Re-run encoding, for example to add the opt-in 480p rendition later.
router.post(
  '/:id/rebuild',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const lecture = await Lecture.findById(req.params.id);
    if (!lecture) return res.status(404).json({ error: 'lecture not found' });
    if (!lecture.sourceKey) return res.status(409).json({ error: 'no source file retained' });

    const ladder = (req.body?.ladder || DEFAULT_LADDER).filter((m) => MODE_ORDER.includes(m));
    try {
      await enqueueTranscode({ lectureId: lecture._id.toString(), ladder });
    } catch (err) {
      return res.status(503).json({
        error: `the encoding queue is unreachable: ${err.message}`,
        retry: true,
      });
    }

    // Only marked queued once the job is actually on the queue, so a failure
    // cannot leave the lecture stuck in a state no worker will ever pick up.
    lecture.status = 'queued';
    lecture.failureReason = '';
    await lecture.save();

    return res.status(202).json({ queued: true, ladder });
  })
);

export default router;
