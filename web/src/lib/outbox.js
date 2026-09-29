import { getAll, put, remove, getMeta, setMeta } from './db.js';
import { api, loadCursors, saveCursors, OfflineError } from './api.js';
import { putAll } from './db.js';

// The offline outbox.
//
// Every write the student makes goes here first and is applied to the local UI
// immediately. Nothing in the app ever waits for a network round-trip to show
// a result. The queue drains whenever a connection appears.

const listeners = new Set();

export function onOutboxChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify() {
  const pending = await getAll('outbox');
  listeners.forEach((fn) => fn({ pending: pending.length }));
}

function newOpId() {
  return crypto.randomUUID ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Queues one operation. The clientOpId is generated here and never changes, so
// a retry after a timeout cannot create a duplicate on the server.
export async function enqueue(kind, payload) {
  const op = {
    clientOpId: newOpId(),
    kind,
    ...payload,
    offline: true,
    createdAt: Date.now(),
    attempts: 0,
  };
  await put('outbox', op);
  await notify();
  // Opportunistic: if there is a connection right now, this returns in a
  // moment; if not, it fails silently and the op stays queued.
  flush().catch(() => {});
  return op;
}

let flushing = false;

export async function flush() {
  if (flushing) return { skipped: true };
  const queued = await getAll('outbox');
  if (queued.length === 0) return { pending: 0 };

  flushing = true;
  try {
    // Oldest first, so a quiz taken before a discussion post is recorded in
    // that order.
    const batch = queued.sort((a, b) => a.createdAt - b.createdAt).slice(0, 50);
    const ops = batch.map(({ attempts, createdAt, ...op }) => op);

    const outcome = await api.syncPush(ops);

    for (const result of outcome.results) {
      if (result.status === 'applied' || result.status === 'duplicate') {
        await remove('outbox', result.clientOpId);
        // Drop the local placeholder now that the server holds the real row.
        // Leaving it would show the post twice once the next pull arrives.
        await dropPlaceholder(batch, result.clientOpId);
        continue;
      }
      // A 4xx will never succeed on retry, so drop it rather than looping
      // forever and burning data on a request that cannot work.
      if (result.retryable === false) {
        await remove('outbox', result.clientOpId);
        await dropPlaceholder(batch, result.clientOpId);
        await recordRejection(result);
        continue;
      }
      const op = batch.find((o) => o.clientOpId === result.clientOpId);
      if (op) await put('outbox', { ...op, attempts: (op.attempts || 0) + 1 });
    }

    await notify();
    return outcome;
  } catch (err) {
    if (!(err instanceof OfflineError)) throw err;
    return { offline: true };
  } finally {
    flushing = false;
  }
}

// Optimistic UI rows are stored under the clientOpId of the operation that
// created them, so they can be found and removed once that operation lands.
async function dropPlaceholder(batch, clientOpId) {
  const op = batch.find((o) => o.clientOpId === clientOpId);
  if (op?.kind === 'discussion_post') await remove('discussion', clientOpId);
}

// Rejections are surfaced to the student rather than swallowed: work that was
// discarded must not disappear without explanation.
async function recordRejection(result) {
  const existing = await getMeta('rejections', []);
  await setMeta('rejections', [
    ...existing.slice(-20),
    { clientOpId: result.clientOpId, error: result.error, at: Date.now() },
  ]);
}

export async function pendingCount() {
  return (await getAll('outbox')).length;
}

// Pull half of the sync. Writes straight into the local stores so every screen
// reads from IndexedDB and works identically online and offline.
export async function pullAndStore() {
  const cursors = await loadCursors();
  const data = await api.syncPull(cursors);

  if (data.discussion?.length) {
    await putAll(
      'discussion',
      data.discussion.map((p) => ({ ...p, courseId: p.courseId }))
    );
  }
  if (data.quizzes?.length) {
    await putAll('quizzes', data.quizzes);
  }
  if (data.attempts?.length) {
    await putAll('attempts', data.attempts.map((a) => ({ ...a, quizId: a.quizId })));
  }

  await saveCursors(data.cursors);
  return data;
}

// Full sync cycle: push first so local work is never overwritten by a pull
// that does not know about it yet.
export async function syncNow() {
  const pushed = await flush();
  let pulled = null;
  try {
    pulled = await pullAndStore();
  } catch (err) {
    if (!(err instanceof OfflineError)) throw err;
  }
  return { pushed, pulled };
}

export default { enqueue, flush, syncNow, pullAndStore, pendingCount, onOutboxChange };
