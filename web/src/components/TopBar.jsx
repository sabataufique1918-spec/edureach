import { syncNow } from '../lib/outbox.js';
import { useState } from 'react';

// Honorifics are part of how teachers are addressed here, but they are not a
// name: "Dr. Anita Rao" should greet as Anita and initial as AR, not DA.
const TITLES = /^(dr|mr|mrs|ms|miss|prof|shri|smt)\.?$/i;

const nameParts = (name = '') => name.split(' ').filter(Boolean).filter((w) => !TITLES.test(w));

const firstName = (name) => nameParts(name)[0] || 'there';

const initials = (name) =>
  nameParts(name)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || 'ER';

const LABEL = { good: 'Online', weak: 'Weak', offline: 'Offline' };

// Avatar, greeting, and connection state in one row.
//
// Connection is a chip here rather than a bar across the top: on a link that
// flickers all day, a full-width banner becomes noise the student learns to
// ignore, but they still need to know at a glance whether their work has been
// delivered.
export default function TopBar({ user, net, pending }) {
  const [syncing, setSyncing] = useState(false);

  const today = new Date().toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });

  async function handleSync() {
    if (net.quality === 'offline') return;
    setSyncing(true);
    try {
      await syncNow();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <header className="topbar">
      <div className="avatar" aria-hidden="true">{initials(user?.name)}</div>

      <div className="greeting">
        <strong>{user ? `Hello, ${firstName(user.name)}` : 'EduReach'}</strong>
        <span>Today {today}</span>
      </div>

      <button
        className={`netchip ${pending > 0 ? 'pending' : ''}`}
        onClick={handleSync}
        disabled={syncing || net.quality === 'offline'}
        title={
          pending > 0
            ? `${pending} item(s) saved on this phone, waiting to be sent`
            : 'Everything you have done has been sent'
        }
      >
        <span className={`dot ${net.quality}`} />
        {pending > 0 ? (syncing ? 'Sending' : `${pending} to send`) : LABEL[net.quality]}
      </button>
    </header>
  );
}
