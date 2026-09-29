import mongoose from 'mongoose';

const pollSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    // Parallel array of counts. Broadcast as a delta (index + increment),
    // never as the whole object, so a poll update costs a handful of bytes.
    tally: { type: [Number], default: [] },
    voters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    open: { type: Boolean, default: true },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

pollSchema.methods.toWire = function toWire() {
  return {
    id: this._id.toString(),
    q: this.question,
    o: this.options,
    t: this.tally,
    open: this.open,
  };
};

export default mongoose.model('Poll', pollSchema);
