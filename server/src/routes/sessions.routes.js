import express from 'express';
import { LiveSession, Course, Lecture } from '../models/index.js';
import { requireAuth, requireRole, loadUser } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { recommendMode, PROFILES } from '../services/mediaProfiles.js';
import { issueCredential } from '../services/credentials.js';
import log from '../utils/logger.js';

const router = express.Router();
router.use(requireAuth, loadUser);

// One-click start. The teacher picks nothing: the session opens in audio mode
// and only climbs if the room measures enough headroom.
router.post(
  '/',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const { courseId, title, broadcastMode, recordLecture } = req.body || {};
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'course not found' });

    const session = await LiveSession.create({
      course: course._id,
      teacher: req.user._id,
      title: title || `${course.code} live session`,
      status: 'live',
      startedAt: new Date(),
      broadcastMode: broadcastMode || 'audio',
      recordLecture: recordLecture !== false,
    });

    req.app.get('io')?.to(`course:${course._id}`).emit('session:started', {
      id: session._id.toString(),
      title: session.title,
      mode: session.broadcastMode,
    });

    return res.status(201).json({ session: publicSession(session) });
  })
);

function publicSession(s) {
  return {
    id: s._id.toString(),
    courseId: s.course.toString(),
    title: s.title,
    status: s.status,
    broadcastMode: s.broadcastMode,
    currentSlide: s.currentSlide,
    // Null until a teacher attaches a deck. The client must render a
    // placeholder rather than a broken image when there is none.
    slideLectureId: s.slideLecture ? s.slideLecture.toString() : null,
    slideCount: s.slideCount || 0,
    startedAt: s.startedAt,
    attendeeCount: s.attendance?.length || 0,
  };
}

// Attaches an already-compressed slide deck to a live session. The deck comes
// from a lecture that has been through the encoder, so the images are already
// WebP and already cached at the edge.
router.post(
  '/:id/slides',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const session = await LiveSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const lecture = await Lecture.findById(req.body?.lectureId);
    if (!lecture) return res.status(404).json({ error: 'lecture not found' });
    if (!lecture.slideCount) {
      return res.status(409).json({
        error: 'that lecture has no slide deck; it may still be encoding',
        lectureStatus: lecture.status,
      });
    }

    session.slideLecture = lecture._id;
    session.slideCount = lecture.slideCount;
    session.currentSlide = 0;
    await session.save();

    req.app.get('io')?.to(`session:${session._id}`).emit('slides:attached', {
      slideLectureId: lecture._id.toString(),
      slideCount: lecture.slideCount,
    });

    return res.json({ session: publicSession(session) });
  })
);

router.get(
  '/live',
  wrap(async (req, res) => {
    const filter = { status: 'live' };
    if (req.query.courseId) filter.course = req.query.courseId;
    const sessions = await LiveSession.find(filter).limit(20);
    return res.json({ sessions: sessions.map(publicSession) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const session = await LiveSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });

    // The client reports what it measured; the server answers with the mode
    // that fits, so the decision logic lives in one place.
    const measured = Number(req.query.kbps || 0);
    return res.json({
      session: publicSession(session),
      recommendedMode: measured ? recommendMode(measured) : 'audio',
      modes: Object.entries(PROFILES).map(([mode, p]) => ({
        mode,
        label: p.label,
        bitrateKbps: p.bitrateKbps,
        estMbPerHour: p.estMbPerHour,
      })),
    });
  })
);

router.post(
  '/:id/end',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const session = await LiveSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });

    session.status = 'ended';
    session.endedAt = new Date();
    await session.save();

    req.app.get('io')?.to(`session:${session._id}`).emit('session:ended', {
      id: session._id.toString(),
    });

    // Attendance becomes a signed academic record. Only students who were
    // present for a meaningful share of the session get one.
    const durationSec = Math.max(
      1,
      Math.round((session.endedAt - (session.startedAt || session.endedAt)) / 1000)
    );
    let issued = 0;
    for (const entry of session.attendance) {
      if (entry.secondsPresent / durationSec < 0.6) continue;
      try {
        await issueCredential({
          type: 'attendance_record',
          studentId: entry.student,
          courseId: session.course,
          issuerId: session.teacher,
          institute: req.user.institute,
          data: {
            sessionId: session._id.toString(),
            sessionTitle: session.title,
            secondsPresent: entry.secondsPresent,
            sessionDurationSec: durationSec,
            modeUsed: entry.modeUsed,
          },
        });
        issued += 1;
      } catch (err) {
        log.warn(`attendance credential failed: ${err.message}`);
      }
    }

    return res.json({
      session: publicSession(session),
      attendanceCredentialsIssued: issued,
    });
  })
);

router.get(
  '/:id/attendance',
  requireRole('teacher', 'admin'),
  wrap(async (req, res) => {
    const session = await LiveSession.findById(req.params.id)
      .populate('attendance.student', 'name phone')
      .lean();
    if (!session) return res.status(404).json({ error: 'session not found' });

    return res.json({
      attendance: (session.attendance || []).map((a) => ({
        name: a.student?.name,
        phone: a.student?.phone,
        minutes: Math.round(a.secondsPresent / 60),
        mode: a.modeUsed,
        mb: Number((a.bytesUsed / 1048576).toFixed(2)),
      })),
    });
  })
);

export default router;
