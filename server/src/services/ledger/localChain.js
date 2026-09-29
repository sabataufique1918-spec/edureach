import crypto from 'node:crypto';
import LedgerBlock from '../../models/LedgerBlock.js';
import { canonicalize, sha256Hex } from '../../utils/canonical.js';

// Append-only hash chain backed by MongoDB.
//
// This exists so the credential feature works on day one, on a single cheap
// VPS, without asking a rural institute to stand up and operate a Fabric
// network. It implements the same contract methods as the chaincode in
// /chaincode, so switching to Fabric is a config flag, not a rewrite.
//
// What it gives up versus Fabric: no multi-organisation consensus, no
// endorsement policy. What it keeps: tamper evidence. Any edit to a stored
// block breaks every hash after it, and verifyChain finds the break.

const GENESIS = '0'.repeat(64);

function blockHash({ index, prevHash, txId, action, record, timestamp }) {
  return sha256Hex(
    canonicalize({
      index,
      prevHash,
      txId,
      action,
      record,
      timestamp: new Date(timestamp).toISOString(),
    })
  );
}

// Appends are serialised through a promise chain. Two concurrent issuances
// must not read the same tip and produce two blocks at the same index.
let appendLock = Promise.resolve();
function serialize(fn) {
  const run = appendLock.then(fn, fn);
  appendLock = run.catch(() => {});
  return run;
}

async function append(action, record) {
  return serialize(async () => {
    const tip = await LedgerBlock.findOne().sort({ index: -1 }).lean();
    const index = tip ? tip.index + 1 : 0;
    const prevHash = tip ? tip.hash : GENESIS;
    const txId = crypto.randomBytes(24).toString('hex');
    const timestamp = new Date();
    const hash = blockHash({ index, prevHash, txId, action, record, timestamp });

    await LedgerBlock.create({ index, prevHash, hash, txId, action, record, timestamp });
    return { txId, blockNumber: index, hash, timestamp };
  });
}

export const localChain = {
  backend: 'local-hashchain',

  async init() {
    // Nothing to connect to. The chain lives in the application database.
    return true;
  },

  async issueCredential(record) {
    const existing = await LedgerBlock.findOne({
      'record.credentialId': record.credentialId,
      action: 'IssueCredential',
    }).lean();
    if (existing) {
      const err = new Error(`credential ${record.credentialId} already exists on ledger`);
      err.code = 'ALREADY_EXISTS';
      throw err;
    }
    return append('IssueCredential', { ...record, revoked: false, revokeReason: '' });
  },

  async revokeCredential(credentialId, reason) {
    const current = await this.getCredential(credentialId);
    if (!current) {
      const err = new Error(`credential ${credentialId} not found on ledger`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return append('RevokeCredential', { ...current, revoked: true, revokeReason: reason || '' });
  },

  // Latest state for a credential id, which is the last block that touched it.
  async getCredential(credentialId) {
    const block = await LedgerBlock.findOne({ 'record.credentialId': credentialId })
      .sort({ index: -1 })
      .lean();
    return block ? block.record : null;
  },

  async getHistory(credentialId) {
    const blocks = await LedgerBlock.find({ 'record.credentialId': credentialId })
      .sort({ index: 1 })
      .lean();
    return blocks.map((b) => ({
      txId: b.txId,
      blockNumber: b.index,
      action: b.action,
      timestamp: b.timestamp,
      revoked: b.record.revoked,
      payloadHash: b.record.payloadHash,
    }));
  },

  // The public verification entry point: does this hash exist on the ledger,
  // and is the credential still valid?
  async verifyByHash(payloadHash) {
    const block = await LedgerBlock.findOne({ 'record.payloadHash': payloadHash })
      .sort({ index: -1 })
      .lean();
    if (!block) return { found: false };
    const latest = await this.getCredential(block.record.credentialId);
    return {
      found: true,
      valid: !latest.revoked,
      credentialId: block.record.credentialId,
      type: block.record.type,
      issuedAt: block.record.issuedAt,
      institute: block.record.institute,
      revoked: Boolean(latest.revoked),
      revokeReason: latest.revokeReason || '',
      txId: block.txId,
      blockNumber: block.index,
    };
  },

  // Walks the entire chain and recomputes every hash. O(n) over blocks, so it
  // is exposed as an admin endpoint rather than run on each request.
  async verifyChain() {
    const blocks = await LedgerBlock.find().sort({ index: 1 }).lean();
    let prevHash = GENESIS;
    for (const b of blocks) {
      if (b.prevHash !== prevHash) {
        return {
          intact: false,
          brokenAt: b.index,
          reason: 'prevHash mismatch',
          length: blocks.length,
        };
      }
      const recomputed = blockHash({
        index: b.index,
        prevHash: b.prevHash,
        txId: b.txId,
        action: b.action,
        record: b.record,
        timestamp: b.timestamp,
      });
      if (recomputed !== b.hash) {
        return {
          intact: false,
          brokenAt: b.index,
          reason: 'block hash mismatch',
          length: blocks.length,
        };
      }
      prevHash = b.hash;
    }
    return { intact: true, length: blocks.length, headHash: prevHash };
  },
};

export default localChain;
