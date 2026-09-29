// No animation on purpose: a spinning element repaints continuously and is a
// measurable battery and CPU cost on the devices this app targets.
export default function Spinner({ label = 'Loading…' }) {
  return <div className="empty">{label}</div>;
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className={`banner ${error.offline ? 'warn' : 'error'}`}>
      {error.offline
        ? 'You are offline. Showing what is saved on this device.'
        : error.message || String(error)}
      {onRetry && (
        <button className="sm ghost" style={{ marginLeft: 8 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
