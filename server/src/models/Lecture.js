import mongoose from 'mongoose';

// One rendition = one downloadable/streamable variant of the same lecture.
// Students pick a rendition by data cost, not by quality.
const renditionSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ['audio', 'slides', 'low', 'medium', 'high'], required: true },
    kind: { type: String, enum: ['audio', 'video', 'slides'], required: true },
    key: { type: String, required: true },          // object-storage key
    playlistKey: { type: String, default: '' },     // HLS .m3u8 when streamed
    bytes: { type: Number, default: 0 },
    bitrateKbps: { type: Number, default: 0 },
    durationSec: { type: Number, default: 0 },
    sha256: { type: String, default: '' },          // client-side integrity check
    ready: { type: Boolean, default: false },
  },
  { _id: false }
);

const lectureSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sourceKey: { type: String, default: '' },
    durationSec: { type: Number, default: 0 },
    renditions: { type: [renditionSchema], default: [] },
    slideCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['uploaded', 'queued', 'processing', 'ready', 'failed'],
      default: 'uploaded',
      index: true,
    },
    failureReason: { type: String, default: '' },
    // Recordings of a live session are linked back to it.
    liveSession: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession', default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

lectureSchema.methods.rendition = function rendition(mode) {
  return this.renditions.find((r) => r.mode === mode && r.ready) || null;
};

// The download manifest the client shows before spending any data.
lectureSchema.methods.toManifest = function toManifest() {
  return {
    id: this._id.toString(),
    courseId: this.course?._id?.toString?.() || this.course?.toString(),
    title: this.title,
    description: this.description,
    durationSec: this.durationSec,
    slideCount: this.slideCount,
    status: this.status,
    updatedAt: this.updatedAt,
    options: this.renditions
      .filter((r) => r.ready)
      .map((r) => ({
        mode: r.mode,
        kind: r.kind,
        bytes: r.bytes,
        mb: Number((r.bytes / (1024 * 1024)).toFixed(2)),
        bitrateKbps: r.bitrateKbps,
        sha256: r.sha256,
        streamUrl: r.playlistKey ? `/media/hls/${this._id}/${r.mode}/index.m3u8` : null,
        downloadUrl: `/media/file/${this._id}/${r.mode}`,
      })),
  };
};

export default mongoose.model('Lecture', lectureSchema);
