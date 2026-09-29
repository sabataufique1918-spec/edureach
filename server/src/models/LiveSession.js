import mongoose from 'mongoose';

const liveSessionSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    status: { type: String, enum: ['scheduled', 'live', 'ended'], default: 'scheduled', index: true },
    scheduledAt: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    // The mode the teacher is broadcasting. Clients may subscribe at or below it.
    broadcastMode: { type: String, enum: ['audio', 'slides', 'low', 'medium'], default: 'audio' },
    // Current slide index, pushed as a 4-byte delta instead of a video frame.
    currentSlide: { type: Number, default: 0 },
    // The lecture whose compressed slide deck this session presents. Slides
    // are stored under the lecture that produced them, so the session has to
    // point at one rather than invent a key of its own.
    slideLecture: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture', default: null },
    slideCount: { type: Number, default: 0 },
    recordLecture: { type: Boolean, default: true },
    attendance: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        joinedAt: Date,
        leftAt: Date,
        secondsPresent: { type: Number, default: 0 },
        modeUsed: { type: String, default: 'audio' },
        bytesUsed: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model('LiveSession', liveSessionSchema);
