import crypto from 'node:crypto';
import { Credential, Course, User } from '../models/index.js';
import { ledger, ledgerBackend } from './ledger/index.js';
import { hashPayload, canonicalize } from '../utils/canonical.js';
import env from '../config/env.js';
import log from '../utils/logger.js';

// Issuing a credential is a two-phase operation:
//   1. Persist the full record off-chain (PII stays in the institute database).
//   2. Anchor only its hash on the ledger.
//
// Phase 2 can fail on a bad link. The credential is then left in "pending" and
// retried, rather than lost, which is why the write order is this way round.

function newCredentialId(type) {
  const prefix =
    { course_completion: 'CC', quiz_result: 'QR', attendance_record: 'AR' }[type] || 'XX';
  const stamp = Date.now().toString(36).toUpperCase();
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// Refs on the ledger are keyed hashes of the internal ids, not the ids
// themselves. A verifier can still confirm that a credential belongs to the
// holder presenting it, without the ledger leaking the student roster.
function ref(kind, id) {
  return crypto
    .createHmac('sha256', env.jwtSecret)
    .update(`${kind}:${id}`)
    .digest('hex')
    .slice(0, 32);
}

export function buildPayload({ type, student, course, issuer, institute, data, issuedAt }) {
  return {
    v: 1,
    type,
    student: { id: student._id.toString(), name: student.name, phone: student.phone },
    course: { id: course._id.toString(), code: course.code, title: course.title },
    issuer: { id: issuer._id.toString(), name: issuer.name },
    institute: institute || '',
    data: data || {},
    issuedAt: new Date(issuedAt || Date.now()).toISOString(),
  };
}

export async function issueCredential({ type, studentId, courseId, issuerId, data, institute }) {
  const [student, course, issuer] = await Promise.all([
    User.findById(studentId),
    Course.findById(courseId),
    User.findById(issuerId),
  ]);
  if (!student) throw Object.assign(new Error('student not found'), { status: 404 });
  if (!course) throw Object.assign(new Error('course not found'), { status: 404 });
  if (!issuer) throw Object.assign(new Error('issuer not found'), { status: 404 });

  const credentialId = newCredentialId(type);
  const issuedAt = new Date();
  const payload = buildPayload({ type, student, course, issuer, institute, data, issuedAt });
  const payloadHash = hashPayload(payload);

  const credential = await Credential.create({
    credentialId,
    type,
    student: student._id,
    course: course._id,
    issuer: issuer._id,
    institute: payload.institute,
    payload,
    payloadHash,
    status: 'pending',
    issuedAt,
  });

  await anchor(credential);
  return credential;
}

// Pushes the hash of a pending credential onto the ledger. Safe to call
// repeatedly: ALREADY_EXISTS is treated as success, because it means an
// earlier attempt committed and only the local status update was lost.
export async function anchor(credential) {
  const record = {
    credentialId: credential.credentialId,
    type: credential.type,
    payloadHash: credential.payloadHash,
    studentRef: ref('student', credential.student),
    courseRef: ref('course', credential.course),
    issuerRef: ref('issuer', credential.issuer),
    institute: credential.institute,
    issuedAt: credential.issuedAt.toISOString(),
  };

  try {
    const receipt = await ledger().issueCredential(record);
    credential.ledger = {
      backend: ledgerBackend(),
      txId: receipt.txId,
      blockNumber: receipt.blockNumber ?? null,
      channel: env.fabric.channel,
      chaincode: env.fabric.chaincode,
      anchoredAt: receipt.timestamp || new Date(),
    };
    credential.status = 'anchored';
    await credential.save();
    log.info(`credential ${credential.credentialId} anchored tx=${receipt.txId}`);
    return credential;
  } catch (err) {
    if (err.code === 'ALREADY_EXISTS') {
      const onChain = await ledger().getCredential(credential.credentialId);
      if (onChain && onChain.payloadHash === credential.payloadHash) {
        credential.status = 'anchored';
        await credential.save();
        return credential;
      }
    }
    credential.status = 'failed';
    await credential.save();
    log.error(`anchor failed for ${credential.credentialId}: ${err.message}`);
    throw err;
  }
}

// Background sweep for credentials whose anchoring failed while the uplink was
// down. Called on an interval by the API process.
export async function retryPending(limit = 20) {
  const stuck = await Credential.find({ status: { $in: ['pending', 'failed'] } }).limit(limit);
  let ok = 0;
  for (const credential of stuck) {
    try {
      await anchor(credential);
      ok += 1;
    } catch {
      // Already logged in anchor(); leave it for the next sweep.
    }
  }
  return { attempted: stuck.length, anchored: ok };
}

export async function revokeCredential(credentialId, reason) {
  const credential = await Credential.findOne({ credentialId });
  if (!credential) throw Object.assign(new Error('credential not found'), { status: 404 });

  await ledger().revokeCredential(credentialId, reason);
  credential.status = 'revoked';
  credential.revokedAt = new Date();
  credential.revokeReason = reason || '';
  await credential.save();
  return credential;
}

// Independent verification. Takes a credential id, a hash, or a full payload,
// and answers from the ledger rather than from the application database, which
// is the entire point of anchoring.
export async function verify({ credentialId, payload, payloadHash }) {
  let hash = payloadHash;
  let recomputed = null;

  if (payload) {
    recomputed = hashPayload(payload);
    hash = recomputed;
  } else if (credentialId && !hash) {
    const credential = await Credential.findOne({ credentialId }).lean();
    if (!credential) return { verified: false, reason: 'unknown credential' };
    hash = credential.payloadHash;
  }
  if (!hash) return { verified: false, reason: 'no credential id, hash, or payload supplied' };

  const onChain = await ledger().verifyByHash(hash);
  if (!onChain.found) {
    return {
      verified: false,
      reason: 'hash is not present on the ledger',
      payloadHash: hash,
      backend: ledgerBackend(),
    };
  }

  return {
    verified: Boolean(onChain.valid),
    reason: onChain.revoked
      ? `revoked: ${onChain.revokeReason || 'no reason given'}`
      : 'anchored on ledger',
    payloadHash: hash,
    recomputedFromPayload: Boolean(recomputed),
    credentialId: onChain.credentialId,
    type: onChain.type,
    institute: onChain.institute,
    issuedAt: onChain.issuedAt,
    ledger: {
      backend: ledgerBackend(),
      txId: onChain.txId,
      blockNumber: onChain.blockNumber ?? null,
    },
  };
}

// What a student downloads and a third party can check offline: the payload,
// its canonical form, and the anchoring receipt.
export async function exportCredential(credentialId) {
  const credential = await Credential.findOne({ credentialId }).lean();
  if (!credential) return null;
  const history = await ledger().getHistory(credentialId);
  return {
    credentialId: credential.credentialId,
    type: credential.type,
    status: credential.status,
    payload: credential.payload,
    canonicalPayload: canonicalize(credential.payload),
    payloadHash: credential.payloadHash,
    ledger: credential.ledger,
    history,
    verifyUrl: `${env.publicBaseUrl}/api/credentials/verify?credentialId=${credential.credentialId}`,
    howToVerify:
      'SHA-256 of canonicalPayload must equal payloadHash, and payloadHash must resolve on the ledger.',
  };
}

export default {
  issueCredential,
  anchor,
  retryPending,
  revokeCredential,
  verify,
  exportCredential,
};
