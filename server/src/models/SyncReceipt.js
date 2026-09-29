import mongoose from 'mongoose';

// Records every client operation the server has already applied. This is what
// makes the offline queue safe to retry blindly over a flaky link.
const syncReceiptSchema = new mongoose.Schema(
  {
    clientOpId: { type: String, required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, required: true },
    result: { type: Object, default: {} },
    appliedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
  },
  { versionKey: false }
);

syncReceiptSchema.index({ clientOpId: 1, user: 1 }, { unique: true });

export default mongoose.model('SyncReceipt', syncReceiptSchema);
