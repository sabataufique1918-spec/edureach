import mongoose from 'mongoose';

// Backing store for the local hash-chain adapter: the drop-in that exposes the
// same contract surface as the Fabric chaincode when no Fabric network is
// available (demos, pilots, single-institute deployments).
//
// Each block commits to its predecessor, so an edit to any historical row
// invalidates every hash after it and verifyChain reports the break.
// Declared as its own schema rather than inline. The record has a field
// literally named "type" (the credential type), and an inline object with a
// "type" key is read by Mongoose as a type declaration - which would silently
// turn the whole record into a String path and reject every write.
const ledgerRecordSchema = new mongoose.Schema(
  {
    credentialId: { type: String, required: true, index: true },
    type: { type: String },
    payloadHash: { type: String, index: true },
    studentRef: { type: String, default: '' },
    courseRef: { type: String, default: '' },
    issuerRef: { type: String, default: '' },
    institute: { type: String, default: '' },
    issuedAt: { type: String, default: '' },
    revoked: { type: Boolean, default: false },
    revokeReason: { type: String, default: '' },
  },
  { _id: false }
);

const ledgerBlockSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true, unique: true, index: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true, index: true },
    txId: { type: String, required: true, unique: true, index: true },
    action: { type: String, enum: ['IssueCredential', 'RevokeCredential'], required: true },
    // Exactly what a Fabric ledger would hold too: ids, hash, refs. No PII.
    record: { type: ledgerRecordSchema, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

export default mongoose.model('LedgerBlock', ledgerBlockSchema);
