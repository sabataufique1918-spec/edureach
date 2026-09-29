import { useState } from 'react';
import { api } from '../lib/api.js';

// Public verifier. No account needed, because the people who most need to
// check a certificate - employers, other colleges - will never have one here.
export default function VerifyCredential() {
  const [credentialId, setCredentialId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function checkById(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api.verifyCredential(credentialId.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // The stronger check: the verifier supplies the certificate file the holder
  // gave them, and the server recomputes the hash from its contents. A single
  // altered character fails.
  async function checkFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const parsed = JSON.parse(await file.text());
      const payload = parsed.payload || parsed;
      setResult(await api.verifyPayload(payload));
    } catch (err) {
      setError(`could not read that file: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content">
      <h1>Verify a certificate</h1>
      <p className="muted">
        Check any EduReach certificate against the ledger it was recorded on.
      </p>

      <form className="card" onSubmit={checkById}>
        <div className="field">
          <label htmlFor="cid">Certificate ID</label>
          <input
            id="cid"
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            placeholder="CC-XXXXXXX-XXXXXXXX"
          />
        </div>
        <button className="primary" type="submit" disabled={busy || !credentialId.trim()}>
          {busy ? 'Checking…' : 'Check this ID'}
        </button>
      </form>

      <div className="card">
        <h3>Or check a certificate file</h3>
        <p className="muted">
          This is the stronger check: the contents are re-hashed and compared
          with the ledger, so any alteration is caught.
        </p>
        <input type="file" accept="application/json" onChange={checkFile} />
      </div>

      {error && <div className="banner error">{error}</div>}

      {result && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            <span className={`badge ${result.verified ? 'ok' : 'bad'}`}>
              {result.verified ? 'Valid' : 'Not valid'}
            </span>
          </h2>
          <p>{result.reason}</p>

          {result.verified && (
            <>
              <div className="row between">
                <span className="muted">Certificate</span>
                <span>{result.credentialId}</span>
              </div>
              <div className="row between">
                <span className="muted">Type</span>
                <span>{result.type}</span>
              </div>
              <div className="row between">
                <span className="muted">Issued by</span>
                <span>{result.institute || 'unspecified'}</span>
              </div>
              <div className="row between">
                <span className="muted">Issued on</span>
                <span>{new Date(result.issuedAt).toLocaleDateString()}</span>
              </div>
              {result.recomputedFromPayload && (
                <div className="banner info" style={{ marginTop: 10 }}>
                  The hash was recomputed from the file you supplied and matches
                  the ledger. The contents have not been altered.
                </div>
              )}
            </>
          )}

          <div className="mono" style={{ marginTop: 10 }}>{result.payloadHash}</div>
          {result.ledger && (
            <p className="muted">
              Recorded on {result.ledger.backend}
              {result.ledger.blockNumber != null && `, block #${result.ledger.blockNumber}`}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
