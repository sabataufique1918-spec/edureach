import { MODE_LABEL, mb } from '../lib/format.js';

// The single most important control in the app: it is where a student decides
// what a lecture will cost them. Options are always ordered cheapest first,
// and the recommended one is chosen from measured bandwidth, not from quality.
export default function ModePicker({ options, value, recommended, onChange }) {
  if (!options?.length) {
    return <p className="muted">No playback options are ready for this lecture yet.</p>;
  }

  const ordered = ['audio', 'slides', 'low', 'medium', 'high']
    .map((mode) => options.find((o) => o.mode === mode))
    .filter(Boolean);

  return (
    <div className="modes">
      {ordered.map((option) => {
        const expensive = option.bytes > 80 * 1048576;
        return (
          <button
            key={option.mode}
            className={`mode ${value === option.mode ? 'selected' : ''} ${expensive ? 'expensive' : ''}`}
            onClick={() => onChange(option.mode)}
          >
            <span>
              {MODE_LABEL[option.mode] || option.mode}
              {recommended === option.mode && (
                <span className="pill" style={{ marginLeft: 8 }}>recommended</span>
              )}
            </span>
            <span className="cost">{mb(option.bytes)}</span>
          </button>
        );
      })}
    </div>
  );
}
