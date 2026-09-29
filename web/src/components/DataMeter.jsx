import { mb } from '../lib/format.js';

// Green to red, exactly as specified in the design document. Shown wherever a
// student is about to spend data, not hidden in a settings screen.
export default function DataMeter({ usedMb, budgetMb, compact }) {
  if (!budgetMb) return null;
  const fraction = Math.min(1, usedMb / budgetMb);
  const level = fraction > 0.85 ? 'high' : fraction > 0.6 ? 'mid' : '';

  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className={`meter ${level}`}>
        <span style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      {!compact && (
        <div className="muted">
          {usedMb.toFixed(1)} MB of {budgetMb} MB used this month
          {fraction > 0.85 && ' — switch to audio only to stay within budget'}
        </div>
      )}
    </div>
  );
}

export function Bytes({ value }) {
  return <span className="cost">{mb(value)}</span>;
}
