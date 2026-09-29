import express from 'express';
import Joi from 'joi';
import crypto from 'node:crypto';
import { Quiz, QuizAttempt, Poll, DiscussionPost } from '../models/index.js';
import { requireAuth, requireRole, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { applyBatch } from '../services/syncEngine.js';
import { cached, keys } from '../services/cache.js';

const router = express.Router();
router.use(requireAuth, loadUser);

const quizSchema = Joi.object({
  courseId: Joi.string().required(),
  lectureId: Joi.string().allow(null, ''),
  title: Joi.string().min(2).max(140).required(),
  timeLimitSec: Joi.number().min(30).max(7200).default(600),
  questions: Joi.array()
    .min(1)
    .max(50)
    .items(
      Joi.object({
        text: Joi.string().min(1).max(600).required(),
        options: Joi.array().min(2).max(6).items(Joi.string().max(200)).required(),
        correctIndex: Joi.number().min(0).required(),
        marks: Joi.number().min(1).max(20).default(1),
      })
    )
    .required(),
});

router.post(
  '/quizzes',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const { error, value } = quizSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const quiz = await Quiz.create({
      course: value.courseId,
      lecture: value.lectureId || null,
      title: value.title,
      timeLimitSec: value.timeLimitSec,
      questions: value.questions.map((q, i) => ({ ...q, qid: `q${i + 1}` })),
    });
    return res.status(201).json({ quiz: quiz.forStudent() });
  })
);

// Downloaded whole and cached on the device, so it is versioned and small.
router.get(
  '/quizzes/:id',
  wrap(async (req, res) => {
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'quiz not found' });

    const payload = await cached(keys.quizPayload(quiz._id.toString(), quiz.version), 600, async () =>
      quiz.forStudent()
    );
    return res.json({ quiz: payload });
  })
);

router.get(
  '/courses/:courseId/quizzes',
  wrap(async (req, res) => {
    const quizzes = await Quiz.find({ course: req.params.courseId, open: true }).limit(100);
    return res.json({ quizzes: quizzes.map((q) => q.forStudent()) });
  })
);

// Online submission. Routed through the same applier as an offline sync so
// there is exactly one grading path, not two that can drift apart.
router.post(
  '/quizzes/:id/submit',
  wrap(async (req, res) => {
    const op = {
      kind: 'quiz_attempt',
      clientOpId: req.body?.clientOpId || crypto.randomUUID(),
      quizId: req.params.id,
      answers: req.body?.answers || {},
      takenAt: req.body?.takenAt || new Date().toISOString(),
      offline: false,
    };
    const outcome = await applyBatch([op], req.user);
    const entry = outcome.results[0];
    if (entry.status === 'failed' || entry.status === 'rejected') {
      return res.status(400).json({ error: entry.error });
    }
    return res.json({ status: entry.status, ...entry.result });
  })
);

router.get(
  '/quizzes/:id/results',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const attempts = await QuizAttempt.find({ quiz: req.params.id })
      .populate('student', 'name phone')
      .sort({ percent: -1 })
      .lean();
    return res.json({
      count: attempts.length,
      averagePercent: attempts.length
        ? Math.round(attempts.reduce((s, a) => s + a.percent, 0) / attempts.length)
        : 0,
      attempts: attempts.map((a) => ({
        student: a.student?.name,
        phone: a.student?.phone,
        percent: a.percent,
        score: a.score,
        total: a.total,
        takenAt: a.takenAt,
        takenOffline: a.takenOffline,
      })),
    });
  })
);

// ---------------------------------------------------------------------------
// Discussion board
// ---------------------------------------------------------------------------

// Cursor paging by sequence number. A student returning after a week asks for
// everything after the last seq they hold, and gets exactly that.
router.get(
  '/courses/:courseId/discussion',
  wrap(async (req, res) => {
    const afterSeq = Number(req.query.afterSeq) || 0;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const posts = await DiscussionPost.find({ course: req.params.courseId, seq: { $gt: afterSeq } })
      .sort({ seq: 1 })
      .limit(limit)
      .populate('author', 'name')
      .lean();

    return res.json({
      nextCursor: posts.length ? posts[posts.length - 1].seq : afterSeq,
      hasMore: posts.length === limit,
      posts: posts.map((p) => ({
        id: p._id.toString(),
        parentId: p.parent ? p.parent.toString() : null,
        author: p.author?.name || 'Unknown',
        body: p.body,
        replyCount: p.replyCount,
        seq: p.seq,
        createdAt: p.createdAt,
        postedOffline: p.createdOffline,
      })),
    });
  })
);

router.post(
  '/courses/:courseId/discussion',
  wrap(async (req, res) => {
    const op = {
      kind: 'discussion_post',
      clientOpId: req.body?.clientOpId || crypto.randomUUID(),
      courseId: req.params.courseId,
      lectureId: req.body?.lectureId || null,
      parentId: req.body?.parentId || null,
      body: req.body?.body || '',
      offline: false,
    };
    const outcome = await applyBatch([op], req.user);
    const entry = outcome.results[0];
    if (entry.status === 'failed' || entry.status === 'rejected') {
      return res.status(400).json({ error: entry.error });
    }
    return res.status(201).json({ status: entry.status, ...entry.result });
  })
);

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

router.post(
  '/sessions/:sessionId/polls',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const { question, options, courseId } = req.body || {};
    if (!question || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: 'question and at least two options are required' });
    }
    const poll = await Poll.create({
      session: req.params.sessionId,
      course: courseId,
      question,
      options,
      tally: new Array(options.length).fill(0),
    });

    // Pushed to the room over the socket by the caller; the HTTP response is
    // only for the teacher who created it.
    req.app.get('io')?.to(`session:${req.params.sessionId}`).emit('poll:new', poll.toWire());
    return res.status(201).json({ poll: poll.toWire() });
  })
);

router.post(
  '/polls/:id/vote',
  wrap(async (req, res) => {
    const op = {
      kind: 'poll_vote',
      clientOpId: req.body?.clientOpId || crypto.randomUUID(),
      pollId: req.params.id,
      optionIndex: req.body?.optionIndex,
      offline: false,
    };
    const outcome = await applyBatch([op], req.user);
    const entry = outcome.results[0];
    if (entry.status === 'failed' || entry.status === 'rejected') {
      return res.status(400).json({ error: entry.error });
    }
    return res.json({ status: entry.status, ...entry.result });
  })
);

router.post(
  '/polls/:id/close',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const poll = await Poll.findByIdAndUpdate(
      req.params.id,
      { open: false, closedAt: new Date() },
      { new: true }
    );
    if (!poll) return res.status(404).json({ error: 'poll not found' });
    req.app.get('io')?.to(`session:${poll.session}`).emit('poll:closed', poll.toWire());
    return res.json({ poll: poll.toWire() });
  })
);

export default router;
