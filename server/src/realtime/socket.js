import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import log from '../utils/logger.js';
import { LiveSession, Poll } from '../models/index.js';

// Realtime layer for live sessions.
//
// The guiding constraint: a live classroom on a 2G link must cost only what
// the audio costs. So this channel never carries media. It carries slide
// indices, poll deltas, chat lines, and hand-raises, all of which are tens of
// bytes. Media flows separately over HLS at a bitrate the client chose.

const SESSION_ROOM = (id) => `session:${id}`;
const COURSE_ROOM = (id) => `course:${id}`;

export function attachRealtime(httpServer, app) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    // Long polling is kept as a fallback: some rural carriers break WebSocket
    // upgrades through their transparent proxies.
    transports: ['websocket', 'polling'],
    // Fewer, larger heartbeats. A 25s ping on a metered plan is real money
    // across a 200-student cohort.
    pingInterval: 30000,
    pingTimeout: 60000,
    // Chat and poll payloads are tiny, but compression still pays on the
    // burst of joins at the start of a lecture.
    perMessageDeflate: { threshold: 256 },
    maxHttpBufferSize: 64 * 1024,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('authentication required'));
    try {
      socket.data.user = jwt.verify(token, env.jwtSecret);
      return next();
    } catch {
      return next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { sub: userId, name, role } = socket.data.user;
    socket.data.joinedAt = Date.now();
    socket.data.bytesEstimate = 0;

    socket.on('session:join', async ({ sessionId, mode }, ack) => {
      try {
        const session = await LiveSession.findById(sessionId).lean();
        if (!session) return ack?.({ error: 'session not found' });

        socket.join(SESSION_ROOM(sessionId));
        socket.join(COURSE_ROOM(session.course));
        socket.data.sessionId = sessionId;
        socket.data.mode = mode || 'audio';
        socket.data.sessionJoinedAt = Date.now();

        // Open polls are replayed on join so a student who reconnected after
        // a dropout is not silently excluded from a vote in progress.
        const openPolls = await Poll.find({ session: sessionId, open: true }).lean();

        ack?.({
          ok: true,
          currentSlide: session.currentSlide,
          broadcastMode: session.broadcastMode,
          slideLectureId: session.slideLecture ? session.slideLecture.toString() : null,
          slideCount: session.slideCount || 0,
          openPolls: openPolls.map((p) => ({ id: p._id.toString(), q: p.question, o: p.options, t: p.tally })),
        });

        socket.to(SESSION_ROOM(sessionId)).emit('presence:joined', { name, mode: socket.data.mode });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    // Slide advance: four bytes of payload doing the job of a video frame.
    socket.on('slide:set', async ({ sessionId, index }) => {
      if (role !== 'teacher' && role !== 'admin') return;
      await LiveSession.updateOne({ _id: sessionId }, { currentSlide: Number(index) || 0 });
      io.to(SESSION_ROOM(sessionId)).emit('slide:set', { i: Number(index) || 0 });
    });

    // Teacher drops the room to audio when the uplink degrades. Clients act on
    // this immediately rather than waiting to discover the stall themselves.
    socket.on('mode:set', async ({ sessionId, mode }) => {
      if (role !== 'teacher' && role !== 'admin') return;
      await LiveSession.updateOne({ _id: sessionId }, { broadcastMode: mode });
      io.to(SESSION_ROOM(sessionId)).emit('mode:set', { mode });
      log.info(`session ${sessionId} switched to ${mode}`);
    });

    socket.on('poll:vote', async ({ pollId, optionIndex }, ack) => {
      try {
        const poll = await Poll.findOneAndUpdate(
          { _id: pollId, open: true, voters: { $ne: userId } },
          { $inc: { [`tally.${Number(optionIndex)}`]: 1 }, $push: { voters: userId } },
          { new: true }
        );
        if (!poll) return ack?.({ counted: false });

        // Broadcast the delta, not the poll. Everyone already has the
        // question text from poll:new.
        io.to(SESSION_ROOM(poll.session)).emit('poll:delta', {
          id: pollId,
          i: Number(optionIndex),
          t: poll.tally,
        });
        ack?.({ counted: true });
      } catch (err) {
        ack?.({ counted: false, error: err.message });
      }
    });

    // Text-only chat. Capped hard, because an unbounded message is an
    // unbounded download for every student in the room.
    socket.on('chat:send', ({ sessionId, text }) => {
      const body = String(text || '').trim().slice(0, 500);
      if (!body) return;
      io.to(SESSION_ROOM(sessionId)).emit('chat:msg', { n: name, b: body, t: Date.now() });
    });

    socket.on('hand:raise', ({ sessionId, up }) => {
      socket.to(SESSION_ROOM(sessionId)).emit('hand:raise', { n: name, up: Boolean(up) });
    });

    // Clients report measured bytes so attendance carries a real data figure.
    socket.on('usage:report', ({ bytes }) => {
      socket.data.bytesEstimate = Number(bytes) || socket.data.bytesEstimate;
    });

    socket.on('disconnect', async () => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) return;

      const seconds = Math.round((Date.now() - (socket.data.sessionJoinedAt || Date.now())) / 1000);
      try {
        // Attendance is written on disconnect rather than on a heartbeat, so a
        // student who loses signal still has their time counted.
        const session = await LiveSession.findById(sessionId);
        if (!session) return;
        const existing = session.attendance.find((a) => a.student?.toString() === userId);
        if (existing) {
          existing.secondsPresent += seconds;
          existing.leftAt = new Date();
          existing.bytesUsed = Math.max(existing.bytesUsed, socket.data.bytesEstimate);
        } else {
          session.attendance.push({
            student: userId,
            joinedAt: new Date(socket.data.sessionJoinedAt),
            leftAt: new Date(),
            secondsPresent: seconds,
            modeUsed: socket.data.mode || 'audio',
            bytesUsed: socket.data.bytesEstimate,
          });
        }
        await session.save();
      } catch (err) {
        log.warn(`attendance write on disconnect failed: ${err.message}`);
      }

      socket.to(SESSION_ROOM(sessionId)).emit('presence:left', { name });
    });
  });

  app.set('io', io);
  log.info('realtime layer attached');
  return io;
}

export default attachRealtime;
