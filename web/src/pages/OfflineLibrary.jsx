import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import downloads from '../lib/downloads.js';
import { storageEstimate } from '../lib/db.js';
import { MODE_LABEL, ago } from '../lib/format.js';
import { isOffPeak } from '../lib/net.js';

// Everything saved on this device, with honest numbers: what it cost, what it
// still needs, and how much room is left.
export default function OfflineLibrary() {
  const [items, setItems] = useState(null);
  const [storage, setStorage] = useState(null);
  const [sortBy, setSortBy] = useState('recent');

  async function load() {
    setItems(await downloads.listDownloads());
    setStorage(await storageEstimate());
  }

  useEffect(() => {
    load();
    return downloads.onDownloadProgress(() => load());
  }, []);

  if (items === null) return null;

  const sorted = [...items].sort((a, b) =>
    sortBy === 'size' ? b.mb - a.mb : (b.savedAt || 0) - (a.savedAt || 0)
  );
  const totalMb = items.reduce((sum, i) => sum + i.mb, 0);
  const incomplete = items.filter((i) => !i.complete);

  return (
    <>
      <h1>Offline library</h1>
      <p className="muted">
        {items.length} item{items.length === 1 ? '' : 's'} · {totalMb.toFixed(1)} MB saved
        {storage && ` · ${storage.usedMb} MB of ${storage.quotaMb} MB used on this device`}
      </p>

      {incomplete.length > 0 && (
        <div className="banner warn">
          {incomplete.length} download{incomplete.length === 1 ? '' : 's'} stopped part-way.
          {isOffPeak()
            ? ' It is off-peak now, a good time to finish them.'
            : ' They will resume from where they stopped, not from the beginning.'}
        </div>
      )}

      {items.length === 0 && (
        <div className="empty">
          Nothing saved yet. Open a lecture and choose a download size to keep it
          on this phone.
        </div>
      )}

      {items.length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          <button
            className={`sm ${sortBy === 'recent' ? 'primary' : ''}`}
            onClick={() => setSortBy('recent')}
          >
            Newest first
          </button>
          <button
            className={`sm ${sortBy === 'size' ? 'primary' : ''}`}
            onClick={() => setSortBy('size')}
          >
            Largest first
          </button>
        </div>
      )}

      {sorted.map((item) => (
        <div className="card" key={item.key}>
          <div className="row between">
            <strong>{item.title}</strong>
            <span className="pill">{MODE_LABEL[item.mode] || item.mode}</span>
          </div>

          <div className="muted">
            {item.mb} MB
            {item.complete
              ? ` · saved ${ago(item.savedAt)}`
              : ` of ${(item.totalBytes / 1048576).toFixed(1)} MB`}
          </div>

          {!item.complete && (
            <div className="progress" style={{ marginTop: 8 }}>
              <span
                style={{
                  width: `${Math.round((item.receivedBytes / (item.totalBytes || 1)) * 100)}%`,
                }}
              />
            </div>
          )}

          <div className="row" style={{ marginTop: 10 }}>
            <Link className="btn sm" to={`/lecture/${item.lectureId}`}>
              {item.complete ? 'Open' : 'Resume'}
            </Link>
            <button
              className="sm danger"
              onClick={async () => {
                await downloads.deleteDownload(item.lectureId, item.mode);
                load();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
