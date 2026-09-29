import { io } from 'socket.io-client';
import { getToken } from './api.js';

// Realtime client for live sessions. Carries control messages only - slide
// indices, poll deltas, chat text - never media.

let socket = null;

export function connectRealtime() {
  if (socket?.connected) return socket;

  socket = io(import.meta.env.VITE_API_BASE || '/', {
    auth: { token: getToken() },
    transports: ['websocket', 'polling'],
    // Keep trying, with growing gaps. A rural link often returns after a few
    // minutes, and an app that gave up would need a manual restart.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    timeout: 20000,
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}

export default { connectRealtime, getSocket, disconnectRealtime };
