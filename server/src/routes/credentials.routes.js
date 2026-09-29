import express from 'express';
import Joi from 'joi';
import { Credential, Course, QuizAttempt } from '../models/index.js';
import { requireAuth, requireRole, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import {
  issueCredential,
  revokeCredential,
  verify,
  exportCredential,
  retryPending,
} from '../services/credentials.js';
import { ledger, ledgerBackend } from '../services/ledger/index.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Public verification. Deliberately unauthenticated: the point of anchoring a
// credential is that an employer or another college can check it without an
// account on this platform.
// ---------------------------------------------------------------------------

router.get(
  '/verify',
  wrap(async (req, res) => {
    const { credentialId, hash } = req.query;
    if (!credentialId && !hash) {
      return res.status(400).json({ error: 'supply credentialId or hash' });
    }
    return res.json(await verify({ credentialId, payloadHash: hash }));
  })
);

// Verification from a payload the holder presents, with no lookup by id. The
// server recomputes the hash and asks the ledger. This is the mode that
// detects a forged certificate: any altered field changes the digest.
router.post(
  '/verify',
  wrap(async (req, res) => {
    const { payload } = req.body || {};
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload object is required' });
    }
    return res.json(await verify({ payload }));
  })
);

router.get(
  '/ledger/status',
  wrap(async (req, res) => {
    const health = await ledger().verifyChain();
    return res.json({ backend: ledgerBackend(), ...health });
  })
);

// ---------------------------------------------------------------------------
// Authenticated routes
// ---------------------------------------------------------------------------

router.use(requireAuth, loadUser);

const issueSchema = Joi.object({
  type: Joi.string().valid('course_completion', 'quiz_result', 'attendance_record').required(),
  studentId: Joi.string().required(),
  courseId: Joi.string().required(),
  data: Joi.object().default({}),
});

router.post(
  '/issue',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const { error, value } = issueSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const credential = await issueCredential({
      ...value,
      issuerId: req.user._id,
      institute: req.user.institute,
    });
    return res.status(201).json({ credential: await exportCredential(credential.credentialId) });
  })
);

// Bulk issuance at the end of a course. Grades come from recorded attempts, so
// a teacher cannot accidentally certify a student who never sat the quizzes.
router.post(
  '/issue-course-completions',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const course = await Course.findById(req.body?.courseId);
    if (!course) return res.status(404).json({ error: 'course not found' });
    if (course.teacher.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'you do not teach this course' });
    }

    const attempts = await QuizAttempt.aggregate([
      { $match: { course: course._id } },
      { $group: { _id: '$student', avg: { $avg: '$percent' }, taken: { $sum: 1 } } },
    ]);

    const issued = [];
    const skipped = [];
    for (const row of attempts) {
      const average = Math.round(row.avg);
      if (average < course.passMarkPercent) {
        skipped.push({ studentId: row._id.toString(), average, reason: 'below pass mark' });
        continue;
      }
      const already = await Credential.findOne({
        student: row._id,
        course: course._id,
        type: 'course_completion',
        status: { $in: ['pending', 'anchored'] },
      }).lean();
      if (already) {
        skipped.push({ studentId: row._id.toString(), reason: 'already issued' });
        continue;
      }

      const credential = await issueCredential({
        type: 'course_completion',
        studentId: row._id,
        courseId: course._id,
        issuerId: req.user._id,
        institute: req.user.institute,
        data: { averagePercent: average, quizzesTaken: row.taken, passMark: course.passMarkPercent },
      });
      issued.push({ credentialId: credential.credentialId, studentId: row._id.toString(), average });
    }

    return res.json({ issued: issued.length, skipped: skipped.length, details: { issued, skipped } });
  })
);

// A student sees their own; a teacher can look up any student in their course.
router.get(
  '/mine',
  wrap(async (req, res) => {
    const credentials = await Credential.find({ student: req.user._id })
      .populate('course', 'title code')
      .sort({ issuedAt: -1 })
      .lean();

    return res.json({
      backend: ledgerBackend(),
      credentials: credentials.map((c) => ({
        credentialId: c.credentialId,
        type: c.type,
        course: c.course?.title,
        courseCode: c.course?.code,
        status: c.status,
        issuedAt: c.issuedAt,
        payloadHash: c.payloadHash,
        txId: c.ledger?.txId || null,
        blockNumber: c.ledger?.blockNumber ?? null,
      })),
    });
  })
);

// Full export, including the canonical bytes and the anchoring receipt, so the
// holder can carry proof around independently of this server.
router.get(
  '/:credentialId',
  wrap(async (req, res) => {
    const payload = await exportCredential(req.params.credentialId);
    if (!payload) return res.status(404).json({ error: 'credential not found' });

    const isOwner =
      (await Credential.exists({
        credentialId: req.params.credentialId,
        student: req.user._id,
      })) !== null;
    if (!isOwner && !['teacher', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'not your credential' });
    }
    return res.json(payload);
  })
);

router.post(
  '/:credentialId/revoke',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const credential = await revokeCredential(req.params.credentialId, req.body?.reason);
    return res.json({ revoked: true, credentialId: credential.credentialId });
  })
);

// Manual trigger for the anchoring retry sweep, for use after an outage.
router.post(
  '/retry-pending',
  requireRole('admin', 'teacher'),
  wrap(async (req, res) => res.json(await retryPending(50)))
);

export default router;
