import crypto from 'node:crypto';

// Deterministic JSON: keys sorted at every depth, no insertion-order surprises.
// Both the server and an independent verifier must be able to reproduce the
// exact byte string that was hashed, otherwise verification is meaningless.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashPayload(payload) {
  return sha256Hex(canonicalize(payload));
}

export default { canonicalize, sha256Hex, hashPayload };
