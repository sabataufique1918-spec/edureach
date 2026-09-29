import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, OfflineError } from '../lib/api.js';
import { getAll, putAll } from '../lib/db.js';
import { isOffPeak } from '../lib/net.js';
import WeekStrip from '../components/WeekStrip.jsx';
import DataMeter from '../components/DataMeter.jsx';
import Spinner, { ErrorNote } from '../components/Spinner.jsx';

// Tile colours cycle so a course keeps the same colour between visits, which
// makes the grid scannable without reading the titles.
const TINTS = ['amber', 'sky', 'lilac', 'mint'];

export default function Dashboard({ user, net }) {
  const [courses, setCourses] = useState(null);
  const [live, setLive] = useState([]);
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  async function load() {
    setError(null);
    // Local first, so the screen paints immediately even on a dead link.
    const cached = await getAll('courses');
    if (cached.length) setCourses(cached);

    try {
      const data = await api.courses();
      setCourses(data.courses);
      await putAll('courses', data.courses);
    } catch (err) {
      if (!(err instanceof OfflineError) || !cached.length) setError(err);
      if (!cached.length) setCourses([]);
    }

    try {
      const [liveData, usageData] = await Promise.all([api.liveSessions(), api.usage(30)]);
      setLive(liveData.sessions);
      setUsage(usageData);
    } catch {
      // Both are enhancements; the dashboard is useful without them.
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (courses === null) return <Spinner />;

  const liveNow = live[0];
  const offPeak = isOffPeak();

  // The hero answers one question: what is worth doing right now? A live class
  // outranks everything; otherwise off-peak is the moment to pull lectures
  // down cheaply, and failing both, the meter is the useful thing to show.
  const hero = liveNow
    ? {
        title: 'Class is live',
        body: `${liveNow.title} — joining in audio costs about 10 MB an hour.`,
        cta: 'Join now',
        onClick: () => navigate(`/live/${liveNow.id}`),
      }
    : offPeak
      ? {
          title: 'Off-peak now',
          body: 'The cheapest, fastest time to download this week of lectures.',
          cta: 'Browse lectures',
          onClick: () => courses[0] && navigate(`/course/${courses[0].id}`),
        }
      : {
          title: 'Keep learning',
          body: 'Downloaded lessons play with no signal at all. Quizzes too.',
          cta: 'Open offline library',
          onClick: () => navigate('/library'),
        };

  return (
    <>
      <section className="hero">
        <span className="blob a" />
        <span className="blob b" />
        <span className="blob c" />
        <h2>{hero.title}</h2>
        <p>{hero.body}</p>
        <button className="hero-cta" onClick={hero.onClick}>
          {hero.cta}
        </button>
      </section>

      <WeekStrip />

      <ErrorNote error={error} onRetry={load} />

      {net.quality === 'weak' && (
        <div className="banner warn">
          Your signal is slow right now. Audio lessons will still play normally;
          video may stall.
        </div>
      )}

      {live.length > 0 && (
        <>
          <h2>Live now</h2>
          {live.map((session) => (
            <div className="card tight row between" key={session.id}>
              <div>
                <strong>{session.title}</strong>
                <div className="muted">
                  {session.broadcastMode} · {session.attendeeCount} joined
                </div>
              </div>
              <Link className="btn primary sm" to={`/live/${session.id}`}>
                Join
              </Link>
            </div>
          ))}
        </>
      )}

      <h2>Your courses</h2>

      {courses.length === 0 && (
        <div className="empty">
          You are not enrolled in any course yet. Ask your institute to add you.
        </div>
      )}

      <div className="grid2">
        {courses.map((course, i) => (
          <button
            key={course.id}
            className={`tile ${TINTS[i % TINTS.length]}`}
            onClick={() => navigate(`/course/${course.id}`)}
          >
            <span className="chip">{course.code}</span>
            <span className="tile-title">{course.title}</span>
            <span className="tile-meta">
              {course.lectureCount} lecture{course.lectureCount === 1 ? '' : 's'}
              <br />
              Pass mark {course.passMarkPercent}%
            </span>
            <span className="who">
              <span className="pip">
                {(course.teacher || '?')
                  .split(' ')
                  .filter(Boolean)
                  .slice(-1)[0][0]}
              </span>
              {course.teacher}
            </span>
          </button>
        ))}
      </div>

      {usage && usage.budgetMb > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>Data this month</h3>
            <span className="muted">
              {usage.totalMb.toFixed(1)} / {usage.budgetMb} MB
            </span>
          </div>
          <div style={{ marginTop: 10 }}>
            <DataMeter usedMb={usage.totalMb} budgetMb={usage.budgetMb} compact />
          </div>
        </div>
      )}
    </>
  );
}
