import mongoose from 'mongoose';

// The off-chain record. The ledger only ever stores the hash plus minimal
// metadata; personal data stays here in the institute database.
const credentialSchema = new mongoose.Schema(
  {
    credentialId: { type: String, required: true, unique: true, index: true },
    type: {
      type: String,
      enum: ['course_completion', 'quiz_result', 'attendance_record'],
      required: true,
      index: true,
    },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    issuer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    institute: { type: String, default: '' },
    // Exact payload that was hashed, in canonical JSON, so any verifier can
    // recompute the digest and compare it with what the ledger holds.
    payload: { type: Object, required: true },
    payloadHash: { type: String, required: true, index: true },
    ledger: {
      backend: { type: String, enum: ['fabric', 'local-hashchain'], default: 'local-hashchain' },
      txId: { type: String, default: '' },
      blockNumber: { type: Number, default: null },
      channel: { type: String, default: '' },
      chaincode: { type: String, default: '' },
      anchoredAt: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: ['pending', 'anchored', 'revoked', 'failed'],
      default: 'pending',
      index: true,
    },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: '' },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model('Credential', credentialSchema);
