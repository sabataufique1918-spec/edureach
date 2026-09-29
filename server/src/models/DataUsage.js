import mongoose from 'mongoose';

// Per-student, per-day byte ledger. Powers the in-app data meter and the
// warning shown before a download starts.
const dataUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    day: { type: String, required: true, index: true },
    bytes: { type: Number, default: 0 },
    byMode: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

dataUsageSchema.index({ user: 1, day: 1 }, { unique: true });

export default mongoose.model('DataUsage', dataUsageSchema);
