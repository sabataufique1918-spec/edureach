export const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

export function duration(seconds) {
  if (!seconds) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

export function ago(timestamp) {
  if (!timestamp) return '';
  const secs = Math.round((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

export const MODE_LABEL = {
  audio: 'Audio only',
  slides: 'Slides + audio',
  low: 'Video 144p',
  medium: 'Video 240p',
  high: 'Video 480p',
};

// Short hash for display. The full digest is always available on the
// credential screen; this is for the places where it has to fit on a phone.
export const shortHash = (hash) => (hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : '');

export default { mb, duration, ago, MODE_LABEL, shortHash };
