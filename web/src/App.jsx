import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { getUser, setSession } from './lib/api.js';
import { onNetworkChange } from './lib/net.js';
import { onOutboxChange, pendingCount, syncNow } from './lib/outbox.js';
import { clearUserData } from './lib/db.js';

import TopBar from './components/TopBar.jsx';
import NavBar from './components/NavBar.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CourseView from './pages/CourseView.jsx';
import LecturePlayer from './pages/LecturePlayer.jsx';
import LiveSession from './pages/LiveSession.jsx';
import OfflineLibrary from './pages/OfflineLibrary.jsx';
import QuizPage from './pages/QuizPage.jsx';
import Discussion from './pages/Discussion.jsx';
import Credentials from './pages/Credentials.jsx';
import VerifyCredential from './pages/VerifyCredential.jsx';
import TeacherConsole from './pages/TeacherConsole.jsx';

export default function App() {
  const [user, setUser] = useState(getUser());
  const [net, setNet] = useState({ online: true, quality: 'good', kbps: 0 });
  const [pending, setPending] = useState(0);

  useEffect(() => onNetworkChange(setNet), []);

  useEffect(() => {
    pendingCount().then(setPending);
    return onOutboxChange(({ pending: n }) => setPending(n));
  }, []);

  // Sync whenever the link comes back. This is the moment a student who worked
  // offline all evening gets their quiz results and posts delivered.
  useEffect(() => {
    if (!user || net.quality === 'offline') return undefined;
    syncNow().catch(() => {});
    const timer = setInterval(() => syncNow().catch(() => {}), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [user, net.quality]);

  function handleLogin(session) {
    setSession(session.token, session.user);
    setUser(session.user);
  }

  // Signing out wipes the device. Before it does, try once more to deliver
  // anything the student has queued, and if that fails, say plainly what will
  // be lost rather than discarding it silently.
  async function handleLogout() {
    let remaining = await pendingCount();
    if (remaining > 0 && net.quality !== 'offline') {
      try {
        await syncNow();
        remaining = await pendingCount();
      } catch {
        // Fall through to the confirmation below.
      }
    }

    if (remaining > 0) {
      const message =
        `${remaining} quiz answer${remaining === 1 ? '' : 's'} or post${remaining === 1 ? '' : 's'} ` +
        'still cannot be sent. Signing out now will delete them permanently. ' +
        'Stay signed in and they will be sent automatically when you have signal.';
      if (!window.confirm(message)) return;
    }

    await clearUserData();
    setSession('', null);
    setUser(null);
  }

  if (!user) {
    return (
      <div className="app">
        <Routes>
          <Route path="/verify" element={<VerifyCredential />} />
          <Route path="*" element={<Login onLogin={handleLogin} net={net} />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="content">
        <TopBar user={user} net={net} pending={pending} />
        <Routes>
          <Route path="/" element={<Dashboard user={user} net={net} />} />
          <Route path="/course/:courseId" element={<CourseView net={net} />} />
          <Route path="/lecture/:lectureId" element={<LecturePlayer net={net} user={user} />} />
          <Route path="/live/:sessionId" element={<LiveSession user={user} net={net} />} />
          <Route path="/library" element={<OfflineLibrary />} />
          <Route path="/quiz/:quizId" element={<QuizPage />} />
          <Route path="/course/:courseId/discussion" element={<Discussion user={user} />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/verify" element={<VerifyCredential />} />
          <Route
            path="/teach"
            element={
              user.role === 'teacher' || user.role === 'admin'
                ? <TeacherConsole user={user} onLogout={handleLogout} />
                : <Navigate to="/" replace />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <NavBar user={user} onLogout={handleLogout} />
    </div>
  );
}
