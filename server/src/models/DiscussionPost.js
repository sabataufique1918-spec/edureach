import mongoose from 'mongoose';

// Threaded board, one level deep. Text only by design, since attachments are
// the fastest way to blow a data plan.
const discussionPostSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    lecture: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture', default: null },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscussionPost', default: null, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 4000 },
    replyCount: { type: Number, default: 0 },
    createdOffline: { type: Boolean, default: false },
    clientOpId: { type: String, required: true },
    // Monotonic per-course counter. Clients sync with "give me everything
    // after seq N" instead of refetching the whole thread.
    seq: { type: Number, required: true, index: true },
  },
  { timestamps: true }
);

discussionPostSchema.index({ clientOpId: 1, author: 1 }, { unique: true });
discussionPostSchema.index({ course: 1, seq: 1 });

export default mongoose.model('DiscussionPost', discussionPostSchema);
