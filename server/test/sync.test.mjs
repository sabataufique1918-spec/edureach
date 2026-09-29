// Verifies the offline sync engine against in-memory models.
//
// The claim under test is the one the whole offline-first design rests on:
// a device may resend its queue as many times as it likes over a flaky link
// without duplicating a student's work or losing any of it.

import assert from 'node:assert/strict';
import { Quiz, QuizAttempt, DiscussionPost, Course, SyncReceipt } from '../src/models/index.js';

const USER = { _id: 'student-1', name: 'Rahul Kamble' };

const QUIZ = new Quiz({
  title: 'Week 1: Search and Agents',
  course: '507f1f77bcf86cd799439011',
  questions: [
    { qid: 'q1', text: 'Shallowest goal node?', options: ['DFS', 'BFS'], correctIndex: 1, marks: 2 },
    { qid: 'q2', text: 'Admissible heuristic?', options: ['Never over', 'Always over'], correctIndex: 0, marks: 2 },
  ],
});

let receipts = [];
let attempts = [];
let posts = [];

function reset() {
  receipts = [];
  attempts = [];
  posts = [];
}

SyncReceipt.findOne = (f) => ({
  lean: async () => receipts.find((r) => r.clientOpId === f.clientOpId && r.user === f.user) || null,
});
SyncReceipt.updateOne = async (f, u) => {
  receipts.push({ clientOpId: f.clientOpId, user: f.user, ...u.$set });
};

Quiz.findById = async (id) => (id === 'quiz-1' ? QUIZ : null);

QuizAttempt.findOneAndUpdate = async (filter, update) => {
  const existing = attempts.find(
    (a) => a.clientOpId === filter.clientOpId && a.student === filter.student
  );
  if (existing) return existing;
  const created = { _id: `attempt-${attempts.length}`, ...update.$setOnInsert };
  attempts.push(created);
  return created;
};

Course.findById = (id) => ({
  lean: async () => (id === 'course-1' ? { _id: 'course-1' } : null),
});

DiscussionPost.findOne = () => ({
  sort: () => ({ select: () => ({ lean: async () => posts.at(-1) || null }) }),
});
DiscussionPost.findOneAndUpdate = async (filter, update) => {
  const existing = posts.find(
    (p) => p.clientOpId === filter.clientOpId && p.author === filter.author
  );
  if (existing) return existing;
  const created = { _id: `post-${posts.length}`, createdAt: new Date(), ...update.$setOnInsert };
  posts.push(created);
  return created;
};
DiscussionPost.updateOne = async () => ({});

const { applyBatch } = await import('../src/services/syncEngine.js');

let passed = 0;
async function test(name, fn) {
  reset();
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const attemptOp = (id, answers, takenAt) => ({
  kind: 'quiz_attempt',
  clientOpId: id,
  quizId: 'quiz-1',
  answers,
  takenAt,
  offline: true,
});

console.log('\nsync: grading');

await test('a correct attempt is graded on the server', async () => {
  const out = await applyBatch([attemptOp('op-1', { q1: 1, q2: 0 })], USER);
  assert.equal(out.applied, 1);
  assert.equal(out.results[0].result.percent, 100);
  assert.equal(out.results[0].result.score, 4);
});

await test('a partly correct attempt scores proportionally', async () => {
  const out = await applyBatch([attemptOp('op-1', { q1: 1, q2: 1 })], USER);
  assert.equal(out.results[0].result.percent, 50);
});

await test('an unanswered question scores zero without erroring', async () => {
  const out = await applyBatch([attemptOp('op-1', { q1: 1 })], USER);
  assert.equal(out.results[0].result.percent, 50);
});

console.log('\nsync: idempotency');

await test('resending the same operation does not duplicate it', async () => {
  const op = attemptOp('op-1', { q1: 1, q2: 0 });

  const first = await applyBatch([op], USER);
  const second = await applyBatch([op], USER);
  const third = await applyBatch([op], USER);

  assert.equal(first.results[0].status, 'applied');
  assert.equal(second.results[0].status, 'duplicate');
  assert.equal(third.results[0].status, 'duplicate');
  assert.equal(attempts.length, 1, 'exactly one attempt must be recorded');
});

await test('a replayed operation returns the original result', async () => {
  const op = attemptOp('op-1', { q1: 1, q2: 0 });
  const first = await applyBatch([op], USER);
  const replay = await applyBatch([op], USER);
  assert.deepEqual(replay.results[0].result, first.results[0].result);
});

await test('distinct operations are all applied', async () => {
  const out = await applyBatch(
    [attemptOp('op-1', { q1: 1, q2: 0 }), attemptOp('op-2', { q1: 0, q2: 0 })],
    USER
  );
  assert.equal(out.applied, 2);
  assert.equal(attempts.length, 2);
});

console.log('\nsync: offline timestamps');

await test('the time the student answered is preserved, not the sync time', async () => {
  const answeredAt = '2026-03-14T21:30:00.000Z';
  await applyBatch([attemptOp('op-1', { q1: 1, q2: 0 }, answeredAt)], USER);
  assert.equal(attempts[0].takenAt.toISOString(), answeredAt);
  assert.equal(attempts[0].takenOffline, true);
});

console.log('\nsync: partial failure');

await test('one bad operation does not discard the rest of the batch', async () => {
  const out = await applyBatch(
    [
      attemptOp('op-1', { q1: 1, q2: 0 }),
      { kind: 'quiz_attempt', clientOpId: 'op-2', quizId: 'quiz-missing', answers: {} },
      {
        kind: 'discussion_post',
        clientOpId: 'op-3',
        courseId: 'course-1',
        body: 'Why is BFS complete?',
      },
    ],
    USER
  );

  assert.equal(out.applied, 2, 'the two valid operations must still apply');
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].status, 'applied');
  assert.equal(out.results[1].status, 'failed');
  assert.equal(out.results[2].status, 'applied');
});

await test('a 404 is reported as not worth retrying', async () => {
  const out = await applyBatch(
    [{ kind: 'quiz_attempt', clientOpId: 'op-1', quizId: 'quiz-missing', answers: {} }],
    USER
  );
  assert.equal(out.results[0].retryable, false, 'the client must not burn data retrying this');
});

await test('an unknown operation kind is rejected, not crashed on', async () => {
  const out = await applyBatch([{ kind: 'nonsense', clientOpId: 'op-1' }], USER);
  assert.equal(out.results[0].status, 'rejected');
});

await test('an operation without a clientOpId is rejected', async () => {
  const out = await applyBatch([{ kind: 'quiz_attempt', quizId: 'quiz-1' }], USER);
  assert.equal(out.results[0].status, 'rejected');
});

console.log('\nsync: discussion posts');

await test('a queued post is assigned a server sequence number', async () => {
  const out = await applyBatch(
    [{ kind: 'discussion_post', clientOpId: 'op-1', courseId: 'course-1', body: 'First question' }],
    USER
  );
  assert.equal(out.results[0].result.seq, 1);
});

await test('an empty post is rejected', async () => {
  const out = await applyBatch(
    [{ kind: 'discussion_post', clientOpId: 'op-1', courseId: 'course-1', body: '   ' }],
    USER
  );
  assert.equal(out.results[0].status, 'failed');
});

console.log(`\n${passed} tests passed\n`);
