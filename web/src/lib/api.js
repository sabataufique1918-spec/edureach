import { getMeta, setMeta } from './db.js';

const BASE = import.meta.env.VITE_API_BASE || '';

let token = localStorage.getItem('edureach.token') || '';
let currentUser = JSON.parse(localStorage.getItem('edureach.user') || 'null');

export function getToken() {
  return token;
}

export function getUser() {
  return currentUser;
}

export function setSession(nextToken, user) {
  token = nextToken || '';
  currentUser = user || null;
  if (token) localStorage.setItem('edureach.token', token);
  else localStorage.removeItem('edureach.token');
  if (user) localStorage.setItem('edureach.user', JSON.stringify(user));
  else localStorage.removeItem('edureach.user');
}

// URL for a media tag. An <img> or <video> cannot set an Authorization
// header, so the token rides in the query string; the server accepts either.
// Use this for anything the browser fetches by itself, and the plain path with
// a header for anything fetched by our own code.
export function mediaUrl(path) {
  if (!token) return path;
  return `${BASE}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

export class OfflineError extends Error {
  constructor(message = 'no connection') {
    super(message);
    this.name = 'OfflineError';
    this.offline = true;
  }
}

export async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    });
  } catch {
    // A fetch rejection here means the request never left the device.
    throw new OfflineError(`cannot reach the server for ${path}`);
  }

  if (response.status === 401) {
    setSession('', null);
    throw new Error('session expired, please sign in again');
  }

  const fromCache = response.headers.get('X-From-Cache') === '1';
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    if (data.offline) throw new OfflineError(data.error);
    throw new Error(data.error || `request failed with ${response.status}`);
  }

  // Lets callers show "showing saved copy from earlier" rather than pretending
  // the data is live.
  if (fromCache) Object.defineProperty(data, '__fromCache', { value: true, enumerable: false });
  return data;
}

export const api = {
  login: (phone, password) =>
    request('/api/auth/login', { method: 'POST', body: { phone, password } }),
  register: (body) => request('/api/auth/register', { method: 'POST', body }),
  me: () => request('/api/auth/me'),
  demoAccounts: () => request('/api/auth/demo-accounts'),
  updateMe: (body) => request('/api/auth/me', { method: 'PATCH', body }),

  courses: () => request('/api/courses'),
  course: (id) => request(`/api/courses/${id}`),
  enroll: (id) => request(`/api/courses/${id}/enroll`, { method: 'POST' }),

  lectureManifest: (id, kbps) =>
    request(`/api/lectures/${id}/manifest${kbps ? `?kbps=${kbps}` : ''}`),
  lectures: (courseId, since) => {
    const params = new URLSearchParams();
    if (courseId) params.set('courseId', courseId);
    if (since) params.set('since', since);
    return request(`/api/lectures?${params}`);
  },

  quizzes: (courseId) => request(`/api/interactions/courses/${courseId}/quizzes`),
  quiz: (id) => request(`/api/interactions/quizzes/${id}`),

  discussion: (courseId, afterSeq = 0) =>
    request(`/api/interactions/courses/${courseId}/discussion?afterSeq=${afterSeq}`),

  liveSessions: (courseId) =>
    request(`/api/sessions/live${courseId ? `?courseId=${courseId}` : ''}`),
  session: (id, kbps) => request(`/api/sessions/${id}${kbps ? `?kbps=${kbps}` : ''}`),
  startSession: (body) => request('/api/sessions', { method: 'POST', body }),
  endSession: (id) => request(`/api/sessions/${id}/end`, { method: 'POST' }),

  myCredentials: () => request('/api/credentials/mine'),
  credential: (id) => request(`/api/credentials/${id}`),
  verifyCredential: (credentialId) =>
    request(`/api/credentials/verify?credentialId=${encodeURIComponent(credentialId)}`),
  verifyPayload: (payload) =>
    request('/api/credentials/verify', { method: 'POST', body: { payload } }),
  ledgerStatus: () => request('/api/credentials/ledger/status'),

  usage: (days = 30) => request(`/api/analytics/usage?days=${days}`),
  atRisk: (courseId) => request(`/api/analytics/course/${courseId}/at-risk`),
  engagement: (courseId) => request(`/api/analytics/course/${courseId}/engagement`),

  syncPush: (ops) => request('/api/sync/push', { method: 'POST', body: { ops } }),
  syncPull: (cursors) => {
    const params = new URLSearchParams();
    if (cursors.since) params.set('since', cursors.since);
    if (cursors.discussionSeq) params.set('discussionSeq', String(cursors.discussionSeq));
    return request(`/api/sync/pull?${params}`);
  },
};

export async function saveCursors(cursors) {
  await setMeta('cursors', cursors);
}

export async function loadCursors() {
  return getMeta('cursors', { since: null, discussionSeq: 0 });
}

export default api;
