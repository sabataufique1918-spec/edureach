const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The current week, Sunday to Saturday, with today picked out. A dot marks a
// day that has something scheduled, so the strip carries information rather
// than just being a calendar decoration.
export default function WeekStrip({ marked = [], selected, onSelect }) {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay());

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return date;
  });

  const key = (d) => d.toISOString().slice(0, 10);
  const selectedKey = selected ? key(selected) : key(today);

  return (
    <div className="week" role="group" aria-label="This week">
      {days.map((date, i) => {
        const isSelected = key(date) === selectedKey;
        return (
          <button
            key={key(date)}
            className={`day ${isSelected ? 'today' : ''}`}
            onClick={() => onSelect?.(date)}
            aria-current={isSelected ? 'date' : undefined}
          >
            <span className="dow">{DOW[i]}</span>
            <span className="dom">{date.getDate()}</span>
            {marked.includes(key(date)) && <span className="mark" />}
          </button>
        );
      })}
    </div>
  );
}
