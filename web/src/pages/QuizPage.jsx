import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, request } from '../lib/api.js';
import { get, put } from '../lib/db.js';
import { enqueue } from '../lib/outbox.js';
import Spinner, { ErrorNote } from '../components/Spinner.jsx';

// Quizzes are graded on the server, but taken entirely on the device. The
// student never waits for the network to answer a question, and a lost
// connection mid-quiz loses nothing.
export default function QuizPage() {
  const { quizId } = useParams();
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);

  useEffect(() => {
    (async () => {
      const cached = await get('quizzes', quizId);
      if (cached) {
        setQuiz(cached);
        setSecondsLeft(cached.timeLimitSec);
      }
      try {
        const data = await api.quiz(quizId);
        setQuiz(data.quiz);
        setSecondsLeft(data.quiz.timeLimitSec);
        await put('quizzes', data.quiz);
      } catch (err) {
        if (!cached) setError(err);
      }

      const previous = await get('attempts', quizId);
      if (previous) setSubmitted(previous);
    })();
  }, [quizId]);

  useEffect(() => {
    if (secondsLeft === null || submitted) return undefined;
    if (secondsLeft <= 0) {
      submit();
      return undefined;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, submitted]);

  async function submit() {
    if (submitted) return;
    const takenAt = new Date().toISOString();

    try {
      // Prefer the direct endpoint when there is a connection: the student
      // sees their score immediately.
      const data = await request(`/api/interactions/quizzes/${quizId}/submit`, {
        method: 'POST',
        body: { answers, takenAt },
      });
      setSubmitted(data);
      await put('attempts', { quizId, ...data, takenAt });
    } catch {
      // No connection: queue it, and tell the student plainly that their work
      // is safe rather than showing a failure.
      await enqueue('quiz_attempt', { quizId, answers, takenAt });
      const pending = { quizId, pending: true, takenAt };
      setSubmitted(pending);
      await put('attempts', pending);
    }
  }

  if (!quiz) return error ? <ErrorNote error={error} /> : <Spinner />;

  if (submitted) {
    return (
      <>
        <h1>{quiz.title}</h1>
        {submitted.pending ? (
          <div className="banner warn">
            Your answers are saved on this phone and will be sent automatically
            when you next have a connection. Your score will appear then.
          </div>
        ) : (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>
              {submitted.score} out of {submitted.total} ({submitted.percent}%)
            </h2>
            {submitted.detail?.map((d) => (
              <div className="row between card tight" key={d.qid}>
                <span>{quiz.questions.find((q) => q.qid === d.qid)?.text}</span>
                <span className={`badge ${d.correct ? 'ok' : 'bad'}`}>
                  {d.correct ? 'Correct' : 'Wrong'}
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  const answeredCount = Object.keys(answers).length;

  return (
    <>
      <h1>{quiz.title}</h1>
      <p className="muted">
        {quiz.questions.length} questions
        {secondsLeft !== null && ` · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left`}
      </p>

      <div className="banner info">
        You can answer this quiz without a connection. Nothing is sent until you
        submit, and it will be delivered later if you are offline then.
      </div>

      {quiz.questions.map((question, index) => (
        <div className="card" key={question.qid}>
          <h3>
            {index + 1}. {question.text}
          </h3>
          <div className="stack">
            {question.options.map((option, i) => (
              <button
                key={i}
                className={`mode ${answers[question.qid] === i ? 'selected' : ''}`}
                onClick={() => setAnswers({ ...answers, [question.qid]: i })}
              >
                <span>{option}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      <button
        className="primary"
        style={{ width: '100%' }}
        onClick={submit}
        disabled={answeredCount === 0}
      >
        Submit {answeredCount} of {quiz.questions.length} answered
      </button>
    </>
  );
}
