// Verifies the hash-chain ledger against an in-memory store.
//
// The real localChain module is exercised unmodified; only the Mongoose model
// it talks to is replaced. That keeps the test honest: the chaining, hashing,
// and tamper detection under test are exactly the code that ships.

import assert from 'node:assert/strict';
import LedgerBlock from '../src/models/LedgerBlock.js';
import { canonicalize, hashPayload } from '../src/utils/canonical.js';

// --- in-memory stand-in for the collection -------------------------------

let rows = [];

const matches = (row, filter) =>
  Object.entries(filter).every(([path, expected]) => {
    const actual = path.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return expected.$in.includes(actual);
    }
    return actual === expected;
  });

function query(filter, single) {
  let found = rows.filter((r) => matches(r, filter));
  const builder = {
    sort(spec) {
      const [[key, dir]] = Object.entries(spec);
      found = [...found].sort((a, b) => (a[key] - b[key]) * dir);
      return builder;
    },
    lean() {
      return Promise.resolve(single ? found[0] || null : found);
    },
    then(resolve, reject) {
      return builder.lean().then(resolve, reject);
    },
  };
  return builder;
}

LedgerBlock.findOne = (filter = {}) => query(filter, true);
LedgerBlock.find = (filter = {}) => query(filter, false);
LedgerBlock.create = async (doc) => {
  rows.push(JSON.parse(JSON.stringify(doc)));
  return doc;
};

const { default: localChain } = await import('../src/services/ledger/localChain.js');

// --- helpers --------------------------------------------------------------

const record = (id, hash) => ({
  credentialId: id,
  type: 'course_completion',
  payloadHash: hash,
  studentRef: 'ref-student',
  courseRef: 'ref-course',
  issuerRef: 'ref-issuer',
  institute: 'Govt. Polytechnic, Latur',
  issuedAt: new Date('2026-03-14T09:00:00Z').toISOString(),
});

let passed = 0;
async function test(name, fn) {
  rows = [];
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// --- tests ----------------------------------------------------------------

console.log('\nschema');

// The tests below stub the model, which means they cannot catch a bad schema.
// This one exercises the real one: a document Mongoose rejects would otherwise
// only surface at runtime, on the first credential ever issued.
await test('a real ledger block passes Mongoose validation', () => {
  const doc = new LedgerBlock({
    index: 0,
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    txId: 'tx-1',
    action: 'IssueCredential',
    record: record('CC-1', 'hash-1'),
    timestamp: new Date(),
  });

  const err = doc.validateSync();
  assert.equal(err, undefined, 'schema rejected a valid block');
  // The record must survive as a subdocument, not be coerced to a string.
  assert.equal(doc.record.type, 'course_completion');
  assert.equal(doc.record.payloadHash, 'hash-1');
  assert.equal(doc.record.revoked, false);
});

await test('a block missing its credential id is rejected', () => {
  const doc = new LedgerBlock({
    index: 0,
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    txId: 'tx-1',
    action: 'IssueCredential',
    record: { type: 'course_completion', payloadHash: 'hash-1' },
  });
  assert.notEqual(doc.validateSync(), undefined);
});

console.log('\ncanonical hashing');

await test('key order does not change the digest', () => {
  const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
  const b = { a: 1, nested: { x: 1, y: 2 }, b: 2 };
  assert.equal(hashPayload(a), hashPayload(b));
  assert.equal(canonicalize(a), '{"a":1,"b":2,"nested":{"x":1,"y":2}}');
});

await test('any altered field changes the digest', () => {
  const genuine = { student: { name: 'Rahul Kamble' }, grade: 78 };
  const forged = { student: { name: 'Rahul Kamble' }, grade: 92 };
  assert.notEqual(hashPayload(genuine), hashPayload(forged));
});

console.log('\nledger: issue and verify');

await test('issuing anchors the hash and returns a receipt', async () => {
  const receipt = await localChain.issueCredential(record('CC-1', 'hash-1'));
  assert.equal(receipt.blockNumber, 0);
  assert.equal(typeof receipt.txId, 'string');
  assert.equal(receipt.hash.length, 64);
});

await test('genesis block links to the zero hash', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  assert.equal(rows[0].prevHash, '0'.repeat(64));
});

await test('each block commits to its predecessor', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.issueCredential(record('CC-2', 'hash-2'));
  await localChain.issueCredential(record('CC-3', 'hash-3'));
  assert.equal(rows[1].prevHash, rows[0].hash);
  assert.equal(rows[2].prevHash, rows[1].hash);
});

await test('verifyByHash finds an anchored credential', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  const result = await localChain.verifyByHash('hash-1');
  assert.equal(result.found, true);
  assert.equal(result.valid, true);
  assert.equal(result.credentialId, 'CC-1');
  assert.equal(result.institute, 'Govt. Polytechnic, Latur');
});

await test('an unknown hash does not verify', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  assert.deepEqual(await localChain.verifyByHash('forged-hash'), { found: false });
});

await test('duplicate credential ids are rejected', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await assert.rejects(
    () => localChain.issueCredential(record('CC-1', 'hash-other')),
    (err) => err.code === 'ALREADY_EXISTS'
  );
});

console.log('\nledger: revocation');

await test('revoking marks the credential invalid', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.revokeCredential('CC-1', 'issued in error');

  const result = await localChain.verifyByHash('hash-1');
  assert.equal(result.found, true);
  assert.equal(result.valid, false);
  assert.equal(result.revoked, true);
  assert.equal(result.revokeReason, 'issued in error');
});

await test('revocation appends rather than rewrites', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.revokeCredential('CC-1', 'issued in error');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'IssueCredential');
  assert.equal(rows[0].record.revoked, false);
  assert.equal(rows[1].action, 'RevokeCredential');
});

await test('history shows both events in order', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.revokeCredential('CC-1', 'issued in error');

  const history = await localChain.getHistory('CC-1');
  assert.equal(history.length, 2);
  assert.equal(history[0].action, 'IssueCredential');
  assert.equal(history[1].action, 'RevokeCredential');
  assert.equal(history[1].revoked, true);
});

await test('revoking an unknown credential fails', async () => {
  await assert.rejects(
    () => localChain.revokeCredential('CC-missing', 'x'),
    (err) => err.code === 'NOT_FOUND'
  );
});

console.log('\nledger: tamper detection');

await test('an untouched chain verifies intact', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.issueCredential(record('CC-2', 'hash-2'));

  const health = await localChain.verifyChain();
  assert.equal(health.intact, true);
  assert.equal(health.length, 2);
});

await test('editing a stored record breaks the chain', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.issueCredential(record('CC-2', 'hash-2'));
  await localChain.issueCredential(record('CC-3', 'hash-3'));

  // Exactly the attack the ledger exists to catch: someone with database
  // access swaps the anchored fingerprint for a forged certificate.
  rows[1].record.payloadHash = 'forged-hash';

  const health = await localChain.verifyChain();
  assert.equal(health.intact, false);
  assert.equal(health.brokenAt, 1);
  assert.equal(health.reason, 'block hash mismatch');
});

await test('recomputing a block hash to hide an edit still breaks the link', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.issueCredential(record('CC-2', 'hash-2'));
  await localChain.issueCredential(record('CC-3', 'hash-3'));

  // A more careful attacker edits the record and fixes that block hash, but
  // cannot fix every later block without rewriting the whole chain.
  rows[1].record.payloadHash = 'forged-hash';
  const { sha256Hex } = await import('../src/utils/canonical.js');
  rows[1].hash = sha256Hex(
    canonicalize({
      index: rows[1].index,
      prevHash: rows[1].prevHash,
      txId: rows[1].txId,
      action: rows[1].action,
      record: rows[1].record,
      timestamp: new Date(rows[1].timestamp).toISOString(),
    })
  );

  const health = await localChain.verifyChain();
  assert.equal(health.intact, false);
  assert.equal(health.brokenAt, 2);
  assert.equal(health.reason, 'prevHash mismatch');
});

await test('deleting a block breaks the chain', async () => {
  await localChain.issueCredential(record('CC-1', 'hash-1'));
  await localChain.issueCredential(record('CC-2', 'hash-2'));
  await localChain.issueCredential(record('CC-3', 'hash-3'));

  rows.splice(1, 1);

  const health = await localChain.verifyChain();
  assert.equal(health.intact, false);
});

console.log('\nledger: concurrency');

await test('concurrent issuance produces no duplicate block index', async () => {
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      localChain.issueCredential(record(`CC-${i}`, `hash-${i}`))
    )
  );

  const indices = rows.map((r) => r.index).sort((a, b) => a - b);
  assert.deepEqual(indices, Array.from({ length: 25 }, (_, i) => i));

  const health = await localChain.verifyChain();
  assert.equal(health.intact, true, 'chain must stay linked under concurrent writes');
});

console.log(`\n${passed} tests passed\n`);
