import express from 'express';
import Joi from 'joi';
import { Course, Lecture, User } from '../models/index.js';
import { requireAuth, requireRole, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { cached, invalidate, keys } from '../services/cache.js';

const router = express.Router();
router.use(requireAuth, loadUser);

const courseSchema = Joi.object({
  title: Joi.string().min(3).max(140).required(),
  code: Joi.string().min(2).max(20).required(),
  subject: Joi.string().max(80).allow('').default(''),
  description: Joi.string().max(2000).allow('').default(''),
  passMarkPercent: Joi.number().min(0).max(100).default(40),
});

// The dashboard list. Kept deliberately thin: titles, codes, and a lecture
// count, because it is the first request a student makes on a cold link.
router.get(
  '/',
  wrap(async (req, res) => {
    const userId = req.user._id.toString();
    const payload = await cached(keys.courseList(userId), 60, async () => {
      const filter =
        req.user.role === 'teacher'
          ? { teacher: req.user._id }
          : { enrolled: req.user._id, published: true };

      const courses = await Course.find(filter)
        .select('title code subject description teacher passMarkPercent')
        .populate('teacher', 'name')
        .lean();

      const counts = await Lecture.aggregate([
        { $match: { course: { $in: courses.map((c) => c._id) }, status: 'ready' } },
        { $group: { _id: '$course', n: { $sum: 1 } } },
      ]);
      const countMap = Object.fromEntries(counts.map((c) => [c._id.toString(), c.n]));

      return courses.map((c) => ({
        id: c._id.toString(),
        title: c.title,
        code: c.code,
        subject: c.subject,
        teacher: c.teacher?.name || '',
        lectureCount: countMap[c._id.toString()] || 0,
        passMarkPercent: c.passMarkPercent,
      }));
    });

    return res.json({ courses: payload });
  })
);

router.post(
  '/',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const { error, value } = courseSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    if (await Course.exists({ code: value.code.toUpperCase() })) {
      return res.status(409).json({ error: 'a course with this code already exists' });
    }
    const course = await Course.create({ ...value, teacher: req.user._id });
    return res.status(201).json({ course });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const course = await Course.findById(req.params.id).populate('teacher', 'name').lean();
    if (!course) return res.status(404).json({ error: 'course not found' });

    const lectures = await Lecture.find({ course: course._id, status: 'ready' })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      course: {
        id: course._id.toString(),
        title: course.title,
        code: course.code,
        subject: course.subject,
        description: course.description,
        teacher: course.teacher?.name || '',
        passMarkPercent: course.passMarkPercent,
        enrolledCount: course.enrolled?.length || 0,
      },
      lectures: lectures.map((l) => Lecture.hydrate(l).toManifest()),
    });
  })
);

router.post(
  '/:id/enroll',
  wrap(async (req, res) => {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'course not found' });

    await Course.updateOne({ _id: course._id }, { $addToSet: { enrolled: req.user._id } });
    await invalidate(keys.courseList(req.user._id.toString()));
    return res.json({ enrolled: true, courseId: course._id.toString() });
  })
);

// Roster, for teachers issuing credentials or chasing non-attendance.
router.get(
  '/:id/students',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const course = await Course.findById(req.params.id).lean();
    if (!course) return res.status(404).json({ error: 'course not found' });

    const students = await User.find({ _id: { $in: course.enrolled || [] } })
      .select('name phone preferredMode')
      .lean();

    return res.json({
      students: students.map((s) => ({
        id: s._id.toString(),
        name: s.name,
        phone: s.phone,
        preferredMode: s.preferredMode,
      })),
    });
  })
);

export default router;
