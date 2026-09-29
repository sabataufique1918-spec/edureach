// Tests for the media auth path.
//
// This carries a credential in a URL, which is a deliberate trade-off made so
// that <img> and <video> tags work at all. Because of that, it deserves
// tighter tests than the header path: the failure mode of getting it wrong is
// an open media endpoint.

import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import env from '../src/config/env.js';
import { requireMediaAuth, requireAuth, signToken } from '../src/middleware/auth.js';

function call(middleware, req) {
  let status = null;
  let body = null;
  let passed = false;
  const res = {
    status(code) { status = code; return res; },
    json(payload) { body = payload; return res; },
  };
  middleware(req, res, () => { passed = true; });
  return { passed, status, body };
}

const validToken = signToken({ _id: 'user-1', role: 'student', name: 'Rahul Kamble' });

let count = 0;
function test(name, fn) {
  fn();
  count += 1;
  console.log(`  ok  ${name}`);
}

console.log('\nmedia auth');

test('a valid token in the query string is accepted', () => {
  const req = { headers: {}, query: { t: validToken } };
  const out = call(requireMediaAuth, req);
  assert.equal(out.passed, true);
  assert.equal(req.auth.role, 'student');
});

test('a valid token in the header is still accepted', () => {
  const out = call(requireMediaAuth, {
    headers: { authorization: `Bearer ${validToken}` },
    query: {},
  });
  assert.equal(out.passed, true);
});

test('no token is rejected', () => {
  const out = call(requireMediaAuth, { headers: {}, query: {} });
  assert.equal(out.passed, false);
  assert.equal(out.status, 401);
});

test('a garbage token is rejected', () => {
  const out = call(requireMediaAuth, { headers: {}, query: { t: 'not-a-jwt' } });
  assert.equal(out.passed, false);
  assert.equal(out.status, 401);
});

test('a token signed with the wrong secret is rejected', () => {
  const forged = jwt.sign({ sub: 'user-1', role: 'admin' }, 'some-other-secret');
  const out = call(requireMediaAuth, { headers: {}, query: { t: forged } });
  assert.equal(out.passed, false);
  assert.equal(out.status, 401);
});

test('an expired token is rejected and says so', () => {
  const expired = jwt.sign({ sub: 'user-1', role: 'student' }, env.jwtSecret, { expiresIn: -60 });
  const out = call(requireMediaAuth, { headers: {}, query: { t: expired } });
  assert.equal(out.passed, false);
  assert.equal(out.status, 401);
  assert.equal(out.body.error, 'token expired');
});

test('an array of tokens does not bypass verification', () => {
  // Express parses ?t=a&t=b into an array; String() of it must not verify.
  const out = call(requireMediaAuth, { headers: {}, query: { t: [validToken, 'x'] } });
  assert.equal(out.passed, false);
  assert.equal(out.status, 401);
});

console.log('\nheader auth is unchanged');

test('the normal API guard still ignores a query token', () => {
  const out = call(requireAuth, { headers: {}, query: { t: validToken } });
  assert.equal(out.passed, false, 'only /media may accept a token from the URL');
  assert.equal(out.status, 401);
});

console.log(`\n${count} tests passed\n`);
