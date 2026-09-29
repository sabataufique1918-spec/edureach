import {
  Quiz,
  QuizAttempt,
  DiscussionPost,
  Poll,
  LiveSession,
  Course,
  SyncReceipt,
} from '../models/index.js';
import { recordUsage } from '../middleware/dataMeter.js';
import log from '../utils/logger.js';

// Applies operations a device queued while it was offline.
//
// Two rules hold for every handler here:
//   1. Idempotent. The same clientOpId applied twice produces one record and
//      the same response, because a flaky link guarantees duplicate sends.
//   2. Honours the client timestamp. A quiz answered at 9pm offline and synced
//      at 7am is recorded as 9pm, not 7am.

async function seenBefore(clientOpId, userId) {
  const receipt = await SyncReceipt.findOne({ clientOpId, user: userId }).lean();
  return receipt ? receipt.result : null;
}

async function remember(clientOpId, userId, kind, result) {
  await SyncReceipt.updateOne(
    { clientOpId, user: userId },
    { $set: { kind, result, appliedAt: new Date() } },
    { upsert: true }
  );
  return result;
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

async function applyQuizAttempt(op, user) {
  const quiz = await Quiz.findById(op.quizId);
  if (!quiz) throw Object.assign(new Error('quiz not found'), { status: 404 });

  const graded = quiz.grade(op.answers || {});
  const attempt = await QuizAttempt.findOneAndUpdate(
    { clientOpId: op.clientOpId, student: user._id },
    {
      $setOnInsert: {
        quiz: quiz._id,
        student: user._id,
        course: quiz.course,
        answers: op.answers || {},
        score: graded.score,
        total: graded.total,
        percent: graded.percent,
        detail: graded.perQuestion,
        takenAt: op.takenAt ? new Date(op.takenAt) : new Date(),
        takenOffline: Boolean(op.offline),
        clientOpId: op.clientOpId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    attemptId: attempt._id.toString(),
    score: attempt.score,
    total: attempt.total,
    percent: attempt.percent,
    detail: attempt.detail,
  };
}

async function applyDiscussionPost(op, user) {
  if (!op.body || !op.body.trim()) {
    throw Object.assign(new Error('post body is empty'), { status: 400 });
  }
  const course = await Course.findById(op.courseId).lean();
  if (!course) throw Object.assign(new Error('course not found'), { status: 404 });

  // Per-course sequence, assigned server-side. Clients use it as a cursor.
  const last = await DiscussionPost.findOne({ course: course._id }).sort({ seq: -1 }).select('seq').lean();
  const seq = (last?.seq || 0) + 1;

  const post = await DiscussionPost.findOneAndUpdate(
    { clientOpId: op.clientOpId, author: user._id },
    {
      $setOnInsert: {
        course: course._id,
        lecture: op.lectureId || null,
        parent: op.parentId || null,
        author: user._id,
        body: op.body.trim().slice(0, 4000),
        createdOffline: Boolean(op.offline),
        clientOpId: op.clientOpId,
        seq,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (op.parentId) {
    await DiscussionPost.updateOne({ _id: op.parentId }, { $inc: { replyCount: 1 } });
  }

  return { postId: post._id.toString(), seq: post.seq, createdAt: post.createdAt };
}

async function applyPollVote(op, user) {
  const poll = await Poll.findById(op.pollId);
  if (!poll) throw Object.assign(new Error('poll not found'), { status: 404 });

  const index = Number(op.optionIndex);
  if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) {
    throw Object.assign(new Error('option index out of range'), { status: 400 });
  }

  // A vote that arrives after the poll closed is recorded but not counted -
  // the student was offline through no fault of their own, so it is not an
  // error, but it must not change a result already announced.
  if (!poll.open) {
    return { counted: false, reason: 'poll had already closed', tally: poll.tally };
  }
  if (poll.voters.some((v) => v.toString() === user._id.toString())) {
    return { counted: false, reason: 'already voted', tally: poll.tally };
  }

  const updated = await Poll.findOneAndUpdate(
    { _id: poll._id, open: true, voters: { $ne: user._id } },
    { $inc: { [`tally.${index}`]: 1 }, $push: { voters: user._id } },
    { new: true }
  );
  if (!updated) return { counted: false, reason: 'vote race lost', tally: poll.tally };

  return { counted: true, optionIndex: index, tally: updated.tally };
}

// Attendance measured on the device: how long the student was actually
// connected and in which mode. Reported in one batch at the end of a session.
async function applyAttendance(op, user) {
  const session = await LiveSession.findById(op.sessionId);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });

  const existing = session.attendance.find((a) => a.student?.toString() === user._id.toString());
  if (existing) {
    existing.secondsPresent = Math.max(existing.secondsPresent, Number(op.secondsPresent) || 0);
    existing.bytesUsed = Math.max(existing.bytesUsed, Number(op.bytesUsed) || 0);
    existing.leftAt = op.leftAt ? new Date(op.leftAt) : new Date();
    existing.modeUsed = op.mode || existing.modeUsed;
  } else {
    session.attendance.push({
      student: user._id,
      joinedAt: op.joinedAt ? new Date(op.joinedAt) : new Date(),
      leftAt: op.leftAt ? new Date(op.leftAt) : new Date(),
      secondsPresent: Number(op.secondsPresent) || 0,
      bytesUsed: Number(op.bytesUsed) || 0,
      modeUsed: op.mode || 'audio',
    });
  }
  await session.save();
  return { recorded: true, sessionId: session._id.toString() };
}

// Bytes the device measured itself, including anything served from the nginx
// cache that the origin never saw.
async function applyUsageReport(op, user) {
  await recordUsage(user._id, Number(op.bytes) || 0, op.mode || 'other');
  return { recorded: true, bytes: Number(op.bytes) || 0 };
}

const HANDLERS = {
  quiz_attempt: applyQuizAttempt,
  discussion_post: applyDiscussionPost,
  poll_vote: applyPollVote,
  attendance: applyAttendance,
  usage_report: applyUsageReport,
};

export const SUPPORTED_OPS = Object.keys(HANDLERS);

// ---------------------------------------------------------------------------
// Batch application
// ---------------------------------------------------------------------------

// Applies a queue of operations. One failure does not abort the batch: the
// client gets a per-operation verdict and only retries the ones that failed.
// A student who posted a reply to a deleted thread should still get their
// quiz result recorded.
export async function applyBatch(ops, user) {
  const results = [];

  for (const op of ops) {
    if (!op || !op.clientOpId || !op.kind) {
      results.push({ clientOpId: op?.clientOpId || null, status: 'rejected', error: 'clientOpId and kind are required' });
      continue;
    }

    const handler = HANDLERS[op.kind];
    if (!handler) {
      results.push({ clientOpId: op.clientOpId, status: 'rejected', error: `unknown operation kind: ${op.kind}` });
      continue;
    }

    try {
      const replay = await seenBefore(op.clientOpId, user._id);
      if (replay) {
        results.push({ clientOpId: op.clientOpId, status: 'duplicate', result: replay });
        continue;
      }

      const result = await handler(op, user);
      await remember(op.clientOpId, user._id, op.kind, result);
      results.push({ clientOpId: op.clientOpId, status: 'applied', result });
    } catch (err) {
      // Unique-index collision means a concurrent sync of the same operation
      // won the race. That is success from the perspective of the client.
      if (err.code === 11000) {
        const replay = await seenBefore(op.clientOpId, user._id);
        results.push({ clientOpId: op.clientOpId, status: 'duplicate', result: replay || {} });
        continue;
      }
      log.warn(`sync op ${op.kind}/${op.clientOpId} failed: ${err.message}`);
      results.push({
        clientOpId: op.clientOpId,
        status: 'failed',
        error: err.message,
        // Tells the client whether retrying is worth the data: a 4xx will
        // never succeed, a 5xx might.
        retryable: !(err.status >= 400 && err.status < 500),
      });
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    applied: results.filter((r) => r.status === 'applied').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    failed: results.filter((r) => r.status === 'failed' || r.status === 'rejected').length,
    results,
  };
}

// The pull half of sync: everything the device missed, addressed by cursor so
// the payload stays proportional to how long it was offline.
export async function pullChanges(user, cursors = {}) {
  const courseIds = (
    await Course.find({ enrolled: user._id }).select('_id').lean()
  ).map((c) => c._id);

  const since = cursors.since ? new Date(cursors.since) : new Date(0);

  const [posts, quizzes, attempts] = await Promise.all([
    DiscussionPost.find({
      course: { $in: courseIds },
      seq: { $gt: Number(cursors.discussionSeq) || 0 },
    })
      .sort({ seq: 1 })
      .limit(200)
      .populate('author', 'name')
      .lean(),

    Quiz.find({ course: { $in: courseIds }, updatedAt: { $gt: since } })
      .limit(50),

    QuizAttempt.find({ student: user._id, updatedAt: { $gt: since } })
      .select('quiz percent score total takenAt')
      .lean(),
  ]);

  return {
    syncedAt: new Date().toISOString(),
    cursors: {
      since: new Date().toISOString(),
      discussionSeq: posts.length ? posts[posts.length - 1].seq : Number(cursors.discussionSeq) || 0,
    },
    discussion: posts.map((p) => ({
      id: p._id.toString(),
      courseId: p.course.toString(),
      parentId: p.parent ? p.parent.toString() : null,
      author: p.author?.name || 'Unknown',
      body: p.body,
      seq: p.seq,
      createdAt: p.createdAt,
    })),
    quizzes: quizzes.map((q) => q.forStudent()),
    attempts: attempts.map((a) => ({
      quizId: a.quiz.toString(),
      percent: a.percent,
      score: a.score,
      total: a.total,
      takenAt: a.takenAt,
    })),
  };
}

export default { applyBatch, pullChanges, SUPPORTED_OPS };
