import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

// Phone plus password. No email, no OTP: an SMS gateway is a recurring cost
// and an extra failure mode on a weak network.
export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ phone: '', password: '', name: '', institute: '', role: 'student' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [demo, setDemo] = useState(null);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  // The server decides whether demo accounts exist at all. On a real
  // deployment this returns nothing and the panel below never renders.
  useEffect(() => {
    api
      .demoAccounts()
      .then((data) => setDemo(data.demo ? data : null))
      .catch(() => setDemo(null));
  }, []);

  async function signInAs(account) {
    setBusy(true);
    setError('');
    try {
      onLogin(await api.login(account.phone, account.password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session =
        mode === 'login'
          ? await api.login(form.phone, form.password)
          : await api.register(form);
      onLogin(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content">
      <h1>EduReach</h1>
      <p className="muted">Expert lectures for rural campuses, built for slow connections.</p>

      <form className="card" onSubmit={submit}>
        {error && <div className="banner error">{error}</div>}

        {mode === 'register' && (
          <>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input id="name" value={form.name} onChange={set('name')} required />
            </div>
            <div className="field">
              <label htmlFor="institute">Institute</label>
              <input id="institute" value={form.institute} onChange={set('institute')} />
            </div>
            <div className="field">
              <label htmlFor="role">I am a</label>
              <select id="role" value={form.role} onChange={set('role')}>
                <option value="student">Student</option>
                <option value="teacher">Teacher</option>
              </select>
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="phone">Phone number</label>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={form.phone}
            onChange={set('phone')}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={form.password}
            onChange={set('password')}
            required
          />
        </div>

        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          className="ghost"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Create a new account' : 'I already have an account'}
        </button>
      </form>

      {demo && (
        <div className="card">
          <h3 style={{ marginBottom: 2 }}>Try it without an account</h3>
          <p className="muted" style={{ marginBottom: 10 }}>
            Demo logins for {demo.institute || 'this deployment'}. One tap signs
            you straight in.
          </p>

          <div className="stack">
            {demo.accounts.map((account) => (
              <button
                key={account.phone}
                className="mode"
                onClick={() => signInAs(account)}
                disabled={busy}
              >
                <span>
                  <strong>{account.name}</strong>
                  <br />
                  <span className="muted">{account.label}</span>
                </span>
                <span className="cost mono">
                  {account.phone}
                  <br />
                  {account.password}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="banner info">
        This app works offline. Lectures you download and quizzes you answer
        without signal are saved on your phone and sent when a connection returns.
      </div>

      <p className="muted" style={{ textAlign: 'center' }}>
        <Link to="/verify" style={{ color: 'var(--accent)' }}>
          Verify a certificate
        </Link>{' '}
        without signing in
      </p>
    </main>
  );
}
