import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { getMeta, setMeta } from '../lib/db.js';
import { shortHash } from '../lib/format.js';
import Spinner, { ErrorNote } from '../components/Spinner.jsx';

const TYPE_LABEL = {
  course_completion: 'Course completion',
  quiz_result: 'Quiz result',
  attendance_record: 'Attendance record',
};

// A student's certificates, each anchored on the ledger. The value to the
// student is portability: the proof travels with them and can be checked by
// anyone, without this college having to vouch for it by email.
export default function Credentials() {
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      // Certificates are cached so a student can show one with no signal.
      const cached = await getMeta('credentials', null);
      if (cached) setList(cached);
      try {
        const data = await api.myCredentials();
        setList(data);
        await setMeta('credentials', data);
      } catch (err) {
        if (!cached) setError(err);
      }
    })();
  }, []);

  async function open(credentialId) {
    setDetail({ loading: true, credentialId });
    try {
      const data = await api.credential(credentialId);
      setDetail(data);
    } catch (err) {
      setDetail(null);
      setError(err);
    }
  }

  function share(data) {
    // The whole export, so a verifier can recompute the hash offline and check
    // it against the ledger themselves.
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${data.credentialId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!list) return error ? <ErrorNote error={error} /> : <Spinner />;

  if (detail && !detail.loading) {
    return (
      <>
        <button className="sm ghost" onClick={() => setDetail(null)}>
          Back to my certificates
        </button>

        <h1>{TYPE_LABEL[detail.type] || detail.type}</h1>
        <span className={`badge ${detail.status === 'anchored' ? 'ok' : 'pending'}`}>
          {detail.status}
        </span>

        <div className="card" style={{ marginTop: 12 }}>
          <h3>{detail.payload.course.title}</h3>
          <p className="muted">
            {detail.payload.student.name} · {detail.payload.institute}
          </p>
          <p className="muted">
            Issued {new Date(detail.payload.issuedAt).toLocaleDateString()} by{' '}
            {detail.payload.issuer.name}
          </p>
          {Object.entries(detail.payload.data || {}).map(([k, v]) => (
            <div className="row between" key={k}>
              <span className="muted">{k}</span>
              <span>{String(v)}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>Proof on the ledger</h3>
          <p className="muted" style={{ marginBottom: 6 }}>
            The certificate itself is never stored on the ledger, only this
            fingerprint of it. Changing any detail above changes the
            fingerprint, which is what makes forgery detectable.
          </p>
          <div className="mono">{detail.payloadHash}</div>
          <div className="row between" style={{ marginTop: 10 }}>
            <span className="muted">Ledger</span>
            <span>{detail.ledger?.backend}</span>
          </div>
          {detail.ledger?.txId && (
            <div className="row between">
              <span className="muted">Transaction</span>
              <span className="mono">{shortHash(detail.ledger.txId)}</span>
            </div>
          )}
          {detail.ledger?.blockNumber != null && (
            <div className="row between">
              <span className="muted">Block</span>
              <span>#{detail.ledger.blockNumber}</span>
            </div>
          )}
        </div>

        {detail.history?.length > 0 && (
          <div className="card">
            <h3>History</h3>
            {detail.history.map((h) => (
              <div className="row between" key={h.txId}>
                <span>{h.action}</span>
                <span className="muted">{new Date(h.timestamp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        <button className="primary" style={{ width: '100%' }} onClick={() => share(detail)}>
          Save proof file to share
        </button>
      </>
    );
  }

  return (
    <>
      <h1>My certificates</h1>
      <p className="muted">Anchored on {list.backend}</p>

      {list.credentials.length === 0 && (
        <div className="empty">
          No certificates yet. They are issued when you complete a course or
          attend a full live session.
        </div>
      )}

      {list.credentials.map((c) => (
        <button
          key={c.credentialId}
          className="card"
          style={{ width: '100%', textAlign: 'left', minHeight: 0 }}
          onClick={() => open(c.credentialId)}
        >
          <div className="row between">
            <strong>{c.course || TYPE_LABEL[c.type]}</strong>
            <span className={`badge ${c.status === 'anchored' ? 'ok' : 'pending'}`}>
              {c.status}
            </span>
          </div>
          <div className="muted">
            {TYPE_LABEL[c.type]} · {new Date(c.issuedAt).toLocaleDateString()}
          </div>
          <div className="mono">{shortHash(c.payloadHash)}</div>
        </button>
      ))}
    </>
  );
}
