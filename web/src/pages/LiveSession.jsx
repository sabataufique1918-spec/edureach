import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, mediaUrl } from '../lib/api.js';
import { connectRealtime } from '../lib/socket.js';
import { enqueue } from '../lib/outbox.js';
import { MODE_LABEL } from '../lib/format.js';
import Spinner from '../components/Spinner.jsx';

// Live classroom.
//
// The socket carries control only: slide index, poll deltas, chat. Media is a
// separate stream the student opts into. That separation is what lets someone
// on 40 kbps stay in the room and follow the slides when video is impossible.
export default function LiveSession({ user, net }) {
  const { sessionId } = useParams();
  const [session, setSession] = useState(null);
  const [mode, setMode] = useState('audio');
  const [slideIndex, setSlideIndex] = useState(0);
  const [deck, setDeck] = useState({ lectureId: null, count: 0 });
  const [polls, setPolls] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatText, setChatText] = useState('');
  const [handUp, setHandUp] = useState(false);
  const [connected, setConnected] = useState(false);
  const joinedAt = useRef(Date.now());

  useEffect(() => {
    let socket;
    (async () => {
      const data = await api.session(sessionId, net.kbps);
      setSession(data.session);
      setMode(data.recommendedMode || 'audio');

      socket = connectRealtime();
      socket.on('connect', () => {
        setConnected(true);
        socket.emit('session:join', { sessionId, mode }, (ack) => {
          if (ack?.error) return;
          setSlideIndex(ack.currentSlide || 0);
          setPolls(ack.openPolls || []);
          setDeck({ lectureId: ack.slideLectureId || null, count: ack.slideCount || 0 });
        });
      });
      socket.on('disconnect', () => setConnected(false));
      socket.on('slide:set', ({ i }) => setSlideIndex(i));
      socket.on('slides:attached', ({ slideLectureId, slideCount }) =>
        setDeck({ lectureId: slideLectureId, count: slideCount })
      );
      socket.on('mode:set', ({ mode: next }) =>
        setSession((s) => ({ ...s, broadcastMode: next }))
      );
      socket.on('poll:new', (poll) => setPolls((list) => [...list, poll]));
      socket.on('poll:delta', ({ id, t }) =>
        setPolls((list) => list.map((p) => (p.id === id ? { ...p, t } : p)))
      );
      socket.on('poll:closed', ({ id }) =>
        setPolls((list) => list.map((p) => (p.id === id ? { ...p, open: false } : p)))
      );
      // Bounded: an unbounded chat log is unbounded memory on a 1 GB phone.
      socket.on('chat:msg', (msg) => setMessages((list) => [...list.slice(-80), msg]));
      socket.on('session:ended', () => setSession((s) => ({ ...s, status: 'ended' })));
    })();

    return () => {
      // Attendance is queued rather than sent, so it survives the student
      // closing the app with no signal.
      const seconds = Math.round((Date.now() - joinedAt.current) / 1000);
      enqueue('attendance', {
        sessionId,
        secondsPresent: seconds,
        joinedAt: new Date(joinedAt.current).toISOString(),
        leftAt: new Date().toISOString(),
        mode,
      }).catch(() => {});
      socket?.off();
    };
  }, [sessionId]);

  function vote(poll, index) {
    const socket = connectRealtime();
    if (connected) {
      socket.emit('poll:vote', { pollId: poll.id, optionIndex: index }, () => {});
    } else {
      // Offline vote. It is recorded and delivered later; the server decides
      // whether it still counts.
      enqueue('poll_vote', { pollId: poll.id, optionIndex: index });
    }
    setPolls((list) => list.map((p) => (p.id === poll.id ? { ...p, voted: index } : p)));
  }

  function sendChat(e) {
    e.preventDefault();
    if (!chatText.trim() || !connected) return;
    connectRealtime().emit('chat:send', { sessionId, text: chatText });
    setChatText('');
  }

  function toggleHand() {
    const next = !handUp;
    setHandUp(next);
    connectRealtime().emit('hand:raise', { sessionId, up: next });
  }

  if (!session) return <Spinner label="Joining the session…" />;

  const isTeacher = user.role === 'teacher' || user.role === 'admin';
  const hourlyCost = { audio: '~10 MB/hr', slides: '~22 MB/hr', low: '~90 MB/hr', medium: '~180 MB/hr' };

  return (
    <>
      <h1>{session.title}</h1>
      <p className="muted">
        {connected ? 'Connected' : 'Reconnecting…'} · broadcasting in{' '}
        {MODE_LABEL[session.broadcastMode] || session.broadcastMode}
      </p>

      {session.status === 'ended' && (
        <div className="banner info">
          This session has ended. A recording will appear in the course once it
          has been compressed.
        </div>
      )}

      {net.quality === 'weak' && mode !== 'audio' && (
        <div className="banner warn">
          Your signal is weak. Switch to audio only to stay in the class without
          stalling.
        </div>
      )}

      <div className="card">
        {mode === 'audio' && (
          <div className="banner info">
            Audio only, about 10 MB per hour. The slide below still follows the
            teacher automatically.
          </div>
        )}

        <div className="slide-stage">
          {deck.lectureId ? (
            <img
              src={mediaUrl(
                `/media/slide/${deck.lectureId}/slide-${String(slideIndex + 1).padStart(4, '0')}.webp`
              )}
              alt={`Slide ${slideIndex + 1}`}
              loading="lazy"
            />
          ) : (
            <span className="muted" style={{ padding: 16, textAlign: 'center' }}>
              No slides attached to this session. Audio is unaffected.
            </span>
          )}
        </div>

        <div className="row between" style={{ marginTop: 10 }}>
          <span className="muted">
            {deck.count ? `Slide ${slideIndex + 1} of ${deck.count}` : 'Audio only'}
          </span>
          {isTeacher && (
            <div className="row">
              <button
                className="sm"
                onClick={() =>
                  connectRealtime().emit('slide:set', {
                    sessionId,
                    index: Math.max(0, slideIndex - 1),
                  })
                }
              >
                Back
              </button>
              <button
                className="sm primary"
                onClick={() =>
                  connectRealtime().emit('slide:set', {
                    sessionId,
                    index: deck.count ? Math.min(deck.count - 1, slideIndex + 1) : slideIndex + 1,
                  })
                }
              >
                Next slide
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>How you are receiving this class</h3>
        <div className="modes">
          {['audio', 'slides', 'low', 'medium'].map((m) => (
            <button
              key={m}
              className={`mode ${mode === m ? 'selected' : ''}`}
              onClick={() => setMode(m)}
            >
              <span>{MODE_LABEL[m]}</span>
              <span className="cost">{hourlyCost[m]}</span>
            </button>
          ))}
        </div>

        {isTeacher && (
          <button
            className="ghost"
            style={{ marginTop: 10, width: '100%' }}
            onClick={() => connectRealtime().emit('mode:set', { sessionId, mode: 'audio' })}
          >
            Drop the whole room to audio only
          </button>
        )}
      </div>

      {polls
        .filter((p) => p.open !== false)
        .map((poll) => {
          const total = (poll.t || []).reduce((a, b) => a + b, 0) || 1;
          return (
            <div className="card" key={poll.id}>
              <h3>{poll.q}</h3>
              {poll.o.map((option, i) => (
                <button
                  key={i}
                  className="poll-option"
                  onClick={() => vote(poll, i)}
                  disabled={poll.voted !== undefined}
                >
                  <span
                    className="bar"
                    style={{ width: `${((poll.t?.[i] || 0) / total) * 100}%` }}
                  />
                  <span className="label">
                    {option} — {poll.t?.[i] || 0}
                  </span>
                </button>
              ))}
              {!connected && (
                <p className="muted">Your vote will be sent when you reconnect.</p>
              )}
            </div>
          );
        })}

      <div className="card">
        <div className="row between">
          <h3>Class chat</h3>
          <button className={`sm ${handUp ? 'primary' : ''}`} onClick={toggleHand}>
            {handUp ? 'Hand raised' : 'Raise hand'}
          </button>
        </div>

        <div className="chat">
          {messages.length === 0 && <p className="muted">No messages yet.</p>}
          {messages.map((msg, i) => (
            <div className="msg" key={i}>
              <span className="who">{msg.n}</span> {msg.b}
            </div>
          ))}
        </div>

        <form className="row" style={{ marginTop: 8 }} onSubmit={sendChat}>
          <input
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder={connected ? 'Ask a question' : 'Chat needs a connection'}
            disabled={!connected}
            maxLength={500}
          />
          <button className="primary sm" type="submit" disabled={!connected}>
            Send
          </button>
        </form>
      </div>
    </>
  );
}
