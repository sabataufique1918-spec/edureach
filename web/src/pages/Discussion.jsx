import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { getAll, put, putAll } from '../lib/db.js';
import { enqueue } from '../lib/outbox.js';
import { ago } from '../lib/format.js';
import Spinner from '../components/Spinner.jsx';

// Text-only board. Reading works offline from the local copy; posting offline
// queues and appears immediately with a "waiting to send" marker.
export default function Discussion({ user }) {
  const [posts, setPosts] = useState(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const { courseId } = useParams();

  async function load() {
    const cached = await getAll('discussion', 'courseId', courseId);
    if (cached.length) setPosts(sortPosts(cached));

    try {
      // Only posts the server has actually numbered can advance the cursor.
      // An unsent placeholder has no sequence number, and treating one as the
      // high-water mark would ask the server for everything after it and get
      // back nothing, permanently.
      const confirmed = cached.filter((p) => Number.isFinite(p.seq));
      const afterSeq = confirmed.length ? Math.max(...confirmed.map((p) => p.seq)) : 0;
      const data = await api.discussion(courseId, afterSeq);
      if (data.posts.length) {
        const merged = [...cached, ...data.posts.map((p) => ({ ...p, courseId }))];
        await putAll('discussion', data.posts.map((p) => ({ ...p, courseId })));
        setPosts(sortPosts(merged));
      } else if (!cached.length) {
        setPosts([]);
      }
    } catch {
      if (!cached.length) setPosts([]);
    }
  }

  useEffect(() => {
    load();
  }, [courseId]);

  // Unsent posts have no sequence number yet, so they sort to the end, which
  // is where the student expects to see what they just wrote.
  function sortPosts(list) {
    return [...list].sort((a, b) => {
      const as = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
      const bs = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
      return as - bs;
    });
  }

  async function post(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;

    const op = await enqueue('discussion_post', {
      courseId,
      parentId: replyTo,
      body: text,
    });

    // Optimistic insert, keyed by the operation id so the outbox can remove it
    // once the server confirms. Persisted, not just held in state: the student
    // may close the app before a connection returns.
    const placeholder = {
      id: op.clientOpId,
      courseId,
      parentId: replyTo,
      author: user.name,
      body: text,
      seq: null,
      createdAt: new Date().toISOString(),
      unsent: true,
    };
    await put('discussion', placeholder);
    setPosts((list) => [...(list || []), placeholder]);
    setBody('');
    setReplyTo(null);
  }

  if (posts === null) return <Spinner />;

  const roots = posts.filter((p) => !p.parentId);
  const repliesOf = (id) => posts.filter((p) => p.parentId === id);

  return (
    <>
      <h1>Discussion</h1>

      <form className="card" onSubmit={post}>
        {replyTo && (
          <div className="banner info">
            Replying to a post.{' '}
            <button type="button" className="sm ghost" onClick={() => setReplyTo(null)}>
              Cancel
            </button>
          </div>
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Ask a question or answer one"
          maxLength={4000}
        />
        <button className="primary" type="submit" disabled={!body.trim()} style={{ width: '100%' }}>
          Post
        </button>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Posts written offline are saved and sent automatically later.
        </p>
      </form>

      {roots.length === 0 && <div className="empty">No posts yet. Ask the first question.</div>}

      {roots.map((p) => (
        <div className="card" key={p.id}>
          <div className="row between">
            <strong>{p.author}</strong>
            <span className="muted">
              {p.unsent ? 'waiting to send' : ago(p.createdAt)}
            </span>
          </div>
          <p style={{ marginBottom: 6 }}>{p.body}</p>

          {repliesOf(p.id).map((r) => (
            <div className="card tight" key={r.id} style={{ marginLeft: 12, marginBottom: 6 }}>
              <div className="row between">
                <strong>{r.author}</strong>
                <span className="muted">{r.unsent ? 'waiting to send' : ago(r.createdAt)}</span>
              </div>
              <p style={{ margin: 0 }}>{r.body}</p>
            </div>
          ))}

          <button className="sm ghost" onClick={() => setReplyTo(p.id)}>
            Reply
          </button>
        </div>
      ))}
    </>
  );
}
