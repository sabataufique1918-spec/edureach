import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, request, getToken } from '../lib/api.js';
import Spinner, { ErrorNote } from '../components/Spinner.jsx';

// Teacher side. The design goal from the brief was a minimal learning curve,
// so this is three actions on one screen: upload, go live, see who is falling
// behind. No configuration, no encoding settings.
export default function TeacherConsole({ user }) {
  const [courses, setCourses] = useState(null);
  const [courseId, setCourseId] = useState('');
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [atRisk, setAtRisk] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .courses()
      .then((data) => {
        setCourses(data.courses);
        if (data.courses[0]) setCourseId(data.courses[0].id);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    if (!courseId) return;
    setAtRisk(null);
    api.atRisk(courseId).then(setAtRisk).catch(() => setAtRisk({ students: [], unavailable: true }));
  }, [courseId]);

  async function upload(e) {
    e.preventDefault();
    if (!file || !courseId || !title.trim()) return;

    setStatus('Uploading…');
    setError(null);
    const form = new FormData();
    form.append('file', file);
    form.append('courseId', courseId);
    form.append('title', title);

    try {
      // Multipart, so this bypasses the JSON helper.
      const response = await fetch('/api/lectures', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'upload failed');

      setStatus(
        'Uploaded. It is being compressed into audio, slides, and low-data video now. ' +
          'Students will see the audio version first.'
      );
      setFile(null);
      setTitle('');
    } catch (err) {
      setError(err);
      setStatus('');
    }
  }

  async function goLive() {
    try {
      const data = await api.startSession({ courseId, title: `${title || 'Live class'}` });
      navigate(`/live/${data.session.id}`);
    } catch (err) {
      setError(err);
    }
  }

  async function issueCompletions() {
    setStatus('Issuing certificates…');
    try {
      const data = await request('/api/credentials/issue-course-completions', {
        method: 'POST',
        body: { courseId },
      });
      setStatus(
        `${data.issued} certificate(s) issued and anchored, ${data.skipped} skipped.`
      );
    } catch (err) {
      setError(err);
      setStatus('');
    }
  }

  if (!courses) return error ? <ErrorNote error={error} /> : <Spinner />;

  return (
    <>
      <h1>Teaching</h1>
      <p className="muted">{user.institute}</p>

      <ErrorNote error={error} />
      {status && <div className="banner info">{status}</div>}

      <div className="card">
        <div className="field">
          <label htmlFor="course">Course</label>
          <select id="course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <h3>Start a live class</h3>
        <p className="muted">
          Starts in audio only, which works on almost any connection. You can
          raise it later if the room can take it.
        </p>
        <button className="primary" style={{ width: '100%' }} onClick={goLive} disabled={!courseId}>
          Go live now
        </button>
      </div>

      <form className="card" onSubmit={upload}>
        <h3>Upload a recorded lecture</h3>
        <div className="field">
          <label htmlFor="title">Lecture title</label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="file">Video or audio file</label>
          <input
            id="file"
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>
        <p className="muted">
          Compression is automatic. One upload becomes an audio version, a
          slides version, and two low-data video versions.
        </p>
        <button className="primary" type="submit" disabled={!file || !title.trim()}>
          Upload
        </button>
      </form>

      <div className="card">
        <h3>Students needing attention</h3>
        {!atRisk && <p className="muted">Loading…</p>}
        {atRisk?.unavailable && (
          <p className="muted">The analytics service is not reachable right now.</p>
        )}
        {atRisk?.note && <p className="muted">{atRisk.note}</p>}

        {atRisk?.students
          ?.filter((s) => s.band !== 'low')
          .map((s) => (
            <div className="card tight" key={s.studentId}>
              <div className="row between">
                <strong>{s.name}</strong>
                <span className={`badge ${s.band === 'high' ? 'bad' : 'pending'}`}>
                  {s.band} risk
                </span>
              </div>
              <ul className="muted" style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {s.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ))}

        {atRisk?.students?.every((s) => s.band === 'low') && (
          <p className="muted">No student is currently flagged.</p>
        )}
      </div>

      <div className="card">
        <h3>End of course</h3>
        <p className="muted">
          Issues a tamper-evident certificate to every student above the pass
          mark and records its fingerprint on the ledger.
        </p>
        <button style={{ width: '100%' }} onClick={issueCompletions} disabled={!courseId}>
          Issue completion certificates
        </button>
      </div>
    </>
  );
}
