import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, OfflineError } from '../lib/api.js';
import { getAll, putAll } from '../lib/db.js';
import { duration, mb } from '../lib/format.js';
import Spinner, { ErrorNote } from '../components/Spinner.jsx';

export default function CourseView() {
  const { courseId } = useParams();
  const [data, setData] = useState(null);
  const [quizzes, setQuizzes] = useState([]);
  const [error, setError] = useState(null);

  async function load() {
    setError(null);
    const cachedLectures = await getAll('lectures', 'courseId', courseId);
    if (cachedLectures.length) setData({ course: null, lectures: cachedLectures });

    try {
      const result = await api.course(courseId);
      setData(result);
      await putAll(
        'lectures',
        result.lectures.map((l) => ({ ...l, courseId }))
      );
    } catch (err) {
      if (!cachedLectures.length) setError(err);
      else if (!(err instanceof OfflineError)) setError(err);
    }

    try {
      const quizData = await api.quizzes(courseId);
      setQuizzes(quizData.quizzes);
      await putAll('quizzes', quizData.quizzes);
    } catch {
      setQuizzes(await getAll('quizzes', 'courseId', courseId));
    }
  }

  useEffect(() => {
    load();
  }, [courseId]);

  if (!data) return <Spinner />;

  return (
    <>
      <h1>{data.course?.title || 'Course'}</h1>
      {data.course && (
        <p className="muted">
          {data.course.teacher} · pass mark {data.course.passMarkPercent}%
        </p>
      )}

      <ErrorNote error={error} onRetry={load} />

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Link className="btn" to={`/course/${courseId}/discussion`}>Discussion board</Link>
      </div>

      {quizzes.length > 0 && (
        <>
          <h2>Quizzes</h2>
          {quizzes.map((quiz) => (
            <Link key={quiz.id} to={`/quiz/${quiz.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card tight row between">
                <span>{quiz.title}</span>
                <span className="muted">{quiz.questions.length} questions</span>
              </div>
            </Link>
          ))}
        </>
      )}

      <h2>Lectures</h2>
      {data.lectures.length === 0 && <div className="empty">No lectures published yet.</div>}

      {data.lectures.map((lecture) => {
        // Always advertise the cheapest option on the list screen. The full
        // choice is on the lecture page, where the decision is actually made.
        const cheapest = lecture.options?.[0];
        return (
          <Link key={lecture.id} to={`/lecture/${lecture.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card">
              <strong>{lecture.title}</strong>
              <div className="muted">
                {duration(lecture.durationSec)}
                {cheapest && ` · from ${mb(cheapest.bytes)}`}
                {lecture.slideCount > 0 && ` · ${lecture.slideCount} slides`}
              </div>
            </div>
          </Link>
        );
      })}
    </>
  );
}
