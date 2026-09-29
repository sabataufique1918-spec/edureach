import mongoose from 'mongoose';
import { connectMongo } from '../config/db.js';
import { initLedger } from '../services/ledger/index.js';
import { issueCredential } from '../services/credentials.js';
import { User, Course, Quiz, QuizAttempt, DiscussionPost } from '../models/index.js';
import log from '../utils/logger.js';

// Demo data: one teacher, four students, two courses, a quiz with recorded
// attempts, and credentials anchored on the ledger. Enough to open the app and
// see every feature working without uploading a video first.

// Exported so the development sandbox can seed an ephemeral database in the
// same process, rather than shelling out to a second one that would not see it.
export async function seedInto({ connect = true, disconnect = true } = {}) {
  if (connect) {
    await connectMongo();
    await initLedger();
  }

  log.info('clearing existing demo data');
  await Promise.all([
    User.deleteMany({}),
    Course.deleteMany({}),
    Quiz.deleteMany({}),
    QuizAttempt.deleteMany({}),
    DiscussionPost.deleteMany({}),
  ]);

  const teacher = new User({
    phone: '9000000001',
    name: 'Dr. Anita Rao',
    role: 'teacher',
    institute: 'Govt. Polytechnic, Latur',
  });
  await teacher.setPassword('teach1234');
  await teacher.save();

  const studentSpecs = [
    { phone: '9000000011', name: 'Rahul Kamble', preferredMode: 'audio' },
    { phone: '9000000012', name: 'Sneha Patil', preferredMode: 'slides' },
    { phone: '9000000013', name: 'Imran Shaikh', preferredMode: 'audio' },
    { phone: '9000000014', name: 'Pooja Jadhav', preferredMode: 'low' },
  ];
  const students = [];
  for (const spec of studentSpecs) {
    const student = new User({ ...spec, role: 'student', institute: 'Govt. Polytechnic, Latur' });
    await student.setPassword('learn1234');
    await student.save();
    students.push(student);
  }

  const aiCourse = await Course.create({
    title: 'Introduction to Artificial Intelligence',
    code: 'AI101',
    subject: 'Artificial Intelligence',
    description: 'Search, knowledge representation, and an applied introduction to machine learning.',
    teacher: teacher._id,
    enrolled: students.map((s) => s._id),
    passMarkPercent: 40,
  });

  const vlsiCourse = await Course.create({
    title: 'VLSI Design Fundamentals',
    code: 'VLSI201',
    subject: 'VLSI',
    description: 'CMOS logic, layout, and an introduction to hardware description languages.',
    teacher: teacher._id,
    enrolled: students.slice(0, 3).map((s) => s._id),
    passMarkPercent: 40,
  });

  const quiz = await Quiz.create({
    course: aiCourse._id,
    title: 'Week 1: Search and Agents',
    timeLimitSec: 600,
    questions: [
      {
        qid: 'q1',
        text: 'Which search strategy always finds the shallowest goal node?',
        options: ['Depth-first search', 'Breadth-first search', 'Hill climbing', 'Random walk'],
        correctIndex: 1,
        marks: 2,
      },
      {
        qid: 'q2',
        text: 'An agent that selects actions using only the current percept is called:',
        options: ['Model-based', 'Goal-based', 'Simple reflex', 'Utility-based'],
        correctIndex: 2,
        marks: 2,
      },
      {
        qid: 'q3',
        text: 'A heuristic is admissible when it:',
        options: [
          'Never overestimates the true cost',
          'Always overestimates the true cost',
          'Is constant everywhere',
          'Ignores the goal state',
        ],
        correctIndex: 0,
        marks: 2,
      },
    ],
  });

  // Attempts with a deliberate spread, so the at-risk model has something to
  // find and the pass mark actually excludes someone.
  // Actual graded outcomes for the answer sets below, used to decide who
  // qualifies for a completion certificate.
  const scores = [100, 67, 33, 67];
  const answerSets = [
    { q1: 1, q2: 2, q3: 0 },
    { q1: 1, q2: 2, q3: 2 },
    { q1: 0, q2: 2, q3: 3 },
    { q1: 1, q2: 0, q3: 0 },
  ];

  for (let i = 0; i < students.length; i += 1) {
    const graded = quiz.grade(answerSets[i]);
    await QuizAttempt.create({
      quiz: quiz._id,
      student: students[i]._id,
      course: aiCourse._id,
      answers: answerSets[i],
      score: graded.score,
      total: graded.total,
      percent: graded.percent,
      detail: graded.perQuestion,
      takenAt: new Date(Date.now() - (i + 1) * 3600_000),
      takenOffline: i % 2 === 0,
      clientOpId: `seed-attempt-${i}`,
    });
    log.info(`attempt seeded for ${students[i].name}: ${graded.percent}%`);
  }

  await DiscussionPost.create({
    course: aiCourse._id,
    author: students[0]._id,
    body: 'Could you explain again why breadth-first search is complete but depth-first is not?',
    clientOpId: 'seed-post-1',
    seq: 1,
  });
  await DiscussionPost.create({
    course: aiCourse._id,
    author: teacher._id,
    body: 'Depth-first can walk down an infinite branch and never come back. Breadth-first expands by depth, so it reaches any finite-depth goal.',
    clientOpId: 'seed-post-2',
    seq: 2,
  });

  // Anchor two credentials so the verification screen has real data.
  const passing = students.filter((_, i) => scores[i] >= 40);
  for (const student of passing.slice(0, 2)) {
    const credential = await issueCredential({
      type: 'course_completion',
      studentId: student._id,
      courseId: aiCourse._id,
      issuerId: teacher._id,
      institute: teacher.institute,
      data: { averagePercent: 78, quizzesTaken: 1, passMark: 40 },
    });
    log.info(`credential ${credential.credentialId} anchored for ${student.name}`);
  }

  log.info('---');
  log.info('seed complete');
  log.info(`teacher login: 9000000001 / teach1234`);
  log.info(`student login: 9000000011 / learn1234`);
  log.info(`courses: ${aiCourse.code}, ${vlsiCourse.code}`);

  if (disconnect) await mongoose.disconnect();
  return { teacher, students, courses: [aiCourse, vlsiCourse] };
}

// Only self-execute when run directly (npm run seed), not when imported.
const runDirectly = process.argv[1] && process.argv[1].endsWith('seed.js');
if (runDirectly) {
  seedInto().catch((err) => {
    log.error(err);
    process.exit(1);
  });
}

export default seedInto;
