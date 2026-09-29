'use strict';

const { Contract } = require('fabric-contract-api');

// EduReach credential chaincode.
//
// Scope discipline: this contract stores hashes and references, never student
// names, phone numbers, or marks. A ledger is append-only and replicated to
// every peer organisation, which makes it the wrong place for personal data.
// The institute keeps the real record; the chain only makes it impossible to
// alter one silently.

const PREFIX = 'credential';
const HASH_INDEX = 'hash~credentialId';

class CredentialContract extends Contract {
  constructor() {
    super('CredentialContract');
  }

  async InitLedger(ctx) {
    return JSON.stringify({ initialised: true, at: this._txTime(ctx) });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async IssueCredential(ctx, recordJson) {
    const record = this._parse(recordJson);
    this._requireFields(record, ['credentialId', 'type', 'payloadHash', 'issuedAt']);

    const key = ctx.stub.createCompositeKey(PREFIX, [record.credentialId]);
    const existing = await ctx.stub.getState(key);
    if (existing && existing.length > 0) {
      throw new Error(`credential ${record.credentialId} already exists`);
    }

    // A payload hash must map to exactly one credential, otherwise
    // verification by hash is ambiguous.
    const hashKey = ctx.stub.createCompositeKey(HASH_INDEX, [record.payloadHash]);
    const clash = await ctx.stub.getState(hashKey);
    if (clash && clash.length > 0) {
      throw new Error(`payload hash ${record.payloadHash} is already anchored`);
    }

    const stored = {
      docType: 'credential',
      credentialId: record.credentialId,
      type: record.type,
      payloadHash: record.payloadHash,
      studentRef: record.studentRef || '',
      courseRef: record.courseRef || '',
      issuerRef: record.issuerRef || '',
      institute: record.institute || '',
      issuedAt: record.issuedAt,
      anchoredAt: this._txTime(ctx),
      // The MSP that submitted the transaction. This is what makes
      // "which college issued this" answerable from the chain alone.
      issuerMsp: ctx.clientIdentity.getMSPID(),
      revoked: false,
      revokeReason: '',
    };

    await ctx.stub.putState(key, Buffer.from(JSON.stringify(stored)));
    await ctx.stub.putState(hashKey, Buffer.from(record.credentialId));

    ctx.stub.setEvent(
      'CredentialIssued',
      Buffer.from(
        JSON.stringify({
          credentialId: stored.credentialId,
          type: stored.type,
          payloadHash: stored.payloadHash,
        })
      )
    );

    return JSON.stringify(stored);
  }

  async RevokeCredential(ctx, credentialId, reason) {
    const stored = await this._get(ctx, credentialId);

    // Only the issuing organisation may revoke. Without this check any peer on
    // the channel could invalidate another certificates.
    if (stored.issuerMsp && stored.issuerMsp !== ctx.clientIdentity.getMSPID()) {
      throw new Error(`only ${stored.issuerMsp} may revoke credential ${credentialId}`);
    }
    if (stored.revoked) {
      throw new Error(`credential ${credentialId} is already revoked`);
    }

    stored.revoked = true;
    stored.revokeReason = reason || '';
    stored.revokedAt = this._txTime(ctx);

    const key = ctx.stub.createCompositeKey(PREFIX, [credentialId]);
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(stored)));

    ctx.stub.setEvent(
      'CredentialRevoked',
      Buffer.from(JSON.stringify({ credentialId, reason: stored.revokeReason }))
    );

    return JSON.stringify(stored);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async GetCredential(ctx, credentialId) {
    return JSON.stringify(await this._get(ctx, credentialId));
  }

  // The verification path an employer hits. Answers from chain state only.
  async VerifyByHash(ctx, payloadHash) {
    const hashKey = ctx.stub.createCompositeKey(HASH_INDEX, [payloadHash]);
    const pointer = await ctx.stub.getState(hashKey);
    if (!pointer || pointer.length === 0) {
      return JSON.stringify({ found: false });
    }

    const stored = await this._get(ctx, pointer.toString());
    return JSON.stringify({
      found: true,
      valid: !stored.revoked,
      credentialId: stored.credentialId,
      type: stored.type,
      institute: stored.institute,
      issuerMsp: stored.issuerMsp,
      issuedAt: stored.issuedAt,
      anchoredAt: stored.anchoredAt,
      revoked: stored.revoked,
      revokeReason: stored.revokeReason,
    });
  }

  // Full transaction history for one credential, read from the ledger rather
  // than from world state, so a revocation carries its own timestamp.
  async GetHistory(ctx, credentialId) {
    const key = ctx.stub.createCompositeKey(PREFIX, [credentialId]);
    const iterator = await ctx.stub.getHistoryForKey(key);
    const history = [];

    let result = await iterator.next();
    while (!result.done) {
      const entry = result.value;
      let value = null;
      try {
        value = JSON.parse(entry.value.toString());
      } catch {
        value = null;
      }
      history.push({
        txId: entry.txId,
        timestamp: new Date(entry.timestamp.seconds.low * 1000).toISOString(),
        action: entry.isDelete
          ? 'Delete'
          : value && value.revoked
            ? 'RevokeCredential'
            : 'IssueCredential',
        revoked: Boolean(value && value.revoked),
        payloadHash: (value && value.payloadHash) || '',
      });
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(history);
  }

  async QueryByStudent(ctx, studentRef) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(PREFIX, []);
    const matches = [];

    let result = await iterator.next();
    while (!result.done) {
      try {
        const value = JSON.parse(result.value.value.toString());
        if (value.studentRef === studentRef) matches.push(value);
      } catch {
        // Skip anything that is not a credential document.
      }
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(matches);
  }

  async LedgerStats(ctx) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(PREFIX, []);
    let total = 0;
    let revoked = 0;

    let result = await iterator.next();
    while (!result.done) {
      try {
        const value = JSON.parse(result.value.value.toString());
        if (value.docType === 'credential') {
          total += 1;
          if (value.revoked) revoked += 1;
        }
      } catch {
        // Ignore non-credential keys such as the hash index.
      }
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify({ total, revoked, active: total - revoked });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async _get(ctx, credentialId) {
    const key = ctx.stub.createCompositeKey(PREFIX, [credentialId]);
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) {
      throw new Error(`credential ${credentialId} does not exist`);
    }
    return JSON.parse(data.toString());
  }

  _parse(json) {
    try {
      return JSON.parse(json);
    } catch {
      throw new Error('record argument is not valid JSON');
    }
  }

  _requireFields(record, fields) {
    const missing = fields.filter((f) => !record[f]);
    if (missing.length) throw new Error(`missing required field(s): ${missing.join(', ')}`);
  }

  // Deterministic timestamp taken from the transaction proposal. Date.now()
  // inside chaincode would differ between endorsing peers and the read-write
  // sets would never match.
  _txTime(ctx) {
    const ts = ctx && ctx.stub && ctx.stub.getTxTimestamp ? ctx.stub.getTxTimestamp() : null;
    if (!ts) return new Date(0).toISOString();
    return new Date(ts.seconds.low * 1000 + Math.round(ts.nanos / 1e6)).toISOString();
  }
}

module.exports = CredentialContract;
