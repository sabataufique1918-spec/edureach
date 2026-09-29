// Connectivity and bandwidth sensing.
//
// navigator.onLine is unreliable: a phone attached to a tower with no working
// backhaul reports online. So the app measures instead of trusting the flag.

const listeners = new Set();

export const state = {
  online: navigator.onLine,
  kbps: 0,
  measuredAt: 0,
  // "good" | "weak" | "offline" - what the UI actually branches on.
  quality: navigator.onLine ? 'good' : 'offline',
};

function notify() {
  listeners.forEach((fn) => fn({ ...state }));
}

export function onNetworkChange(fn) {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}

function classify(kbps, reachable) {
  if (!reachable) return 'offline';
  if (kbps > 0 && kbps < 120) return 'weak';
  return 'good';
}

// Cheapest possible reachability check: a few bytes, and it doubles as a
// latency sample.
export async function probe(timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(`/api/sync/ping?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const elapsed = performance.now() - started;
    if (!response.ok) throw new Error('ping failed');
    await response.json();

    state.online = true;
    // Round-trip time is a far better proxy for usable bandwidth on a mobile
    // link than a throughput test, and costs almost nothing to collect.
    state.kbps = elapsed < 150 ? 1200 : elapsed < 400 ? 500 : elapsed < 900 ? 200 : 60;
    state.measuredAt = Date.now();
    state.quality = classify(state.kbps, true);
  } catch {
    state.online = false;
    state.quality = 'offline';
  } finally {
    clearTimeout(timer);
    notify();
  }
  return { ...state };
}

// Optional refinement using the Network Information API where the browser
// exposes it. Treated as a hint, never as the source of truth.
function readConnectionHint() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;
  if (conn.downlink) state.kbps = Math.round(conn.downlink * 1000);
  if (conn.saveData) state.quality = 'weak';
  notify();
}

export function startNetworkWatch() {
  window.addEventListener('online', () => probe());
  window.addEventListener('offline', () => {
    state.online = false;
    state.quality = 'offline';
    notify();
  });

  const conn = navigator.connection;
  conn?.addEventListener?.('change', readConnectionHint);

  readConnectionHint();
  probe();

  // Periodic re-probe. Sixty seconds is a compromise: often enough to notice a
  // link coming back, rare enough that the probe itself is free.
  const timer = setInterval(() => probe(), 60000);
  return () => clearInterval(timer);
}

// Is it currently an off-peak window? Used to decide whether a large download
// should start now or wait.
export function isOffPeak(date = new Date()) {
  const hour = date.getHours();
  return hour >= 1 && hour < 6;
}

export default { state, probe, onNetworkChange, startNetworkWatch, isOffPeak };
